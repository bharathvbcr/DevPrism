//! Minimal direct Ollama `/api/chat` client (native tool-calling), with no
//! external CLI and no Anthropic proxy. Uses manual serde_json because the
//! project's `reqwest` is built without the `json` feature.

use serde_json::{json, Value};

/// Context window requested from Ollama (overrides the model's small default so
/// the full system prompt + project context + history + tools are not truncated).
const CONTEXT_WINDOW: u32 = 8192;

/// Overall per-request budget. Generous because a cold start can spend minutes
/// loading a large model into VRAM before the first token; user-driven Stop is
/// the responsive escape hatch, so this only guards a truly hung server.
const REQUEST_TIMEOUT_SECS: u64 = 600;
/// Connect must be quick — if Ollama isn't listening we want a fast, clear error
/// rather than waiting out the whole request budget.
const CONNECT_TIMEOUT_SECS: u64 = 15;

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Local models often emit tool names lowercased ("read"), padded, or
/// OpenAI-namespaced ("functions.Read"). Map them back to our canonical
/// PascalCase names so dispatch and the UI's file-change detection still work.
fn canonicalize_tool_name(raw: &str) -> String {
    let base = raw.trim().rsplit('.').next().unwrap_or("").trim();
    match base.to_lowercase().as_str() {
        "read" => "Read".to_string(),
        "write" => "Write".to_string(),
        "edit" => "Edit".to_string(),
        "ls" => "LS".to_string(),
        "grep" => "Grep".to_string(),
        "glob" => "Glob".to_string(),
        "bash" => "Bash".to_string(),
        _ => base.to_string(),
    }
}

pub struct ToolCall {
    pub name: String,
    pub args: Value,
}

/// Fold one parsed streaming line from Ollama's `/api/chat` (stream mode) into
/// the accumulating turn: append any content fragment (forwarding it to
/// `on_delta` for live UI streaming), collect any tool calls, and on the final
/// `done` line record the prompt/eval token counts. Returns Err only for an
/// explicit error envelope embedded in the stream.
fn accumulate_stream_line<F: FnMut(&str)>(
    v: &Value,
    content: &mut String,
    tool_calls: &mut Vec<ToolCall>,
    prompt_tokens: &mut u64,
    eval_tokens: &mut u64,
    on_delta: &mut F,
) -> Result<(), String> {
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(format!("Ollama error: {}", err));
    }
    if let Some(msg) = v.get("message") {
        if let Some(frag) = msg.get("content").and_then(|c| c.as_str()) {
            if !frag.is_empty() {
                content.push_str(frag);
                on_delta(frag);
            }
        }
        if let Some(arr) = msg.get("tool_calls").and_then(|t| t.as_array()) {
            for call in arr {
                if let Some(func) = call.get("function") {
                    let name = canonicalize_tool_name(
                        func.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                    );
                    // Ollama returns an object; OpenAI-compatible returns a JSON string.
                    let args = match func.get("arguments") {
                        Some(Value::String(s)) => {
                            serde_json::from_str(s).unwrap_or_else(|_| json!({}))
                        }
                        Some(other) => other.clone(),
                        None => json!({}),
                    };
                    if !name.is_empty() {
                        tool_calls.push(ToolCall { name, args });
                    }
                }
            }
        }
    }
    if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
        if let Some(n) = v.get("prompt_eval_count").and_then(|n| n.as_u64()) {
            *prompt_tokens = n;
        }
        if let Some(n) = v.get("eval_count").and_then(|n| n.as_u64()) {
            *eval_tokens = n;
        }
    }
    Ok(())
}

pub struct ChatTurn {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    /// Prompt (input) tokens for this request, per Ollama's `prompt_eval_count`.
    pub prompt_tokens: u64,
    /// Generated (output) tokens for this request, per Ollama's `eval_count`.
    pub eval_tokens: u64,
}

pub struct OllamaClient {
    base: String,
    model: String,
    client: reqwest::Client,
    num_ctx: u32,
    temperature: f32,
    /// Optional response format passed through to Ollama (`"json"` to force a
    /// strict JSON object). `None` leaves the request unconstrained.
    format: Option<Value>,
}

/// Normalize a user-entered base URL (which may be the OpenAI-compatible
/// `.../v1`) to the Ollama native root used by `/api/chat` and `/api/tags`.
pub fn native_base(base_url: &str) -> String {
    let mut b = base_url.trim().trim_end_matches('/').to_string();
    if b.to_lowercase().ends_with("/v1") {
        b.truncate(b.len() - 3);
    }
    let b = b.trim_end_matches('/').to_string();
    if b.is_empty() {
        "http://localhost:11434".to_string()
    } else {
        b
    }
}

/// Name fragments of embedding-only models, which reject `/api/chat`.
const EMBED_MARKERS: &[&str] = &[
    "embed", "bge", "nomic-embed", "all-minilm", "mxbai", "snowflake-arctic-embed",
    "paraphrase", "gte-", "e5-",
];

/// True if a model name looks like an embedding-only model (no chat endpoint).
fn looks_like_embedding(name: &str) -> bool {
    let l = name.to_lowercase();
    EMBED_MARKERS.iter().any(|m| l.contains(m))
}

/// Query the Ollama server and pick a likely chat-capable installed model.
/// `/api/tags` exposes no capability metadata, so we use a name heuristic: skip
/// obvious embedding models (they reject `/api/chat`). Returns the first
/// chat-capable model, or None if only embedding models (or none) are installed.
/// Query the Ollama server and return installed model metadata from `/api/tags`.
async fn installed_models(base_url: &str) -> Vec<(String, Option<u64>)> {
    let url = format!("{}/api/tags", native_base(base_url));
    let client = build_client();
    let Ok(res) = client.get(&url).send().await else {
        return Vec::new();
    };
    if !res.status().is_success() {
        return Vec::new();
    }
    let Ok(text) = res.text().await else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    v.get("models")
        .and_then(|m| m.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|it| {
                    let name = it
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?;
                    let size = it.get("size").and_then(|s| s.as_u64());
                    Some((name.to_string(), size))
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn installed_model_names(base_url: &str) -> Vec<String> {
    installed_models(base_url)
        .await
        .into_iter()
        .map(|(name, _)| name)
        .collect()
}

pub async fn first_installed_model(base_url: &str) -> Option<String> {
    let names = installed_model_names(base_url).await;
    // Prefer a non-embedding model; fall back to the first installed model only
    // if every installed model looks like an embedding model (better to try and
    // surface a clear tool/chat error than to silently report "no model").
    names
        .iter()
        .find(|n| !looks_like_embedding(n.as_str()))
        .or_else(|| names.first())
        .cloned()
}

/// Pick an installed embedding-only model (the kind that serves `/api/embed`).
/// Returns None when no embedding model is installed.
pub async fn first_embedding_model(base_url: &str) -> Option<String> {
    installed_model_names(base_url)
        .await
        .into_iter()
        .find(|n| looks_like_embedding(n.as_str()))
}

/// Name fragments of vision-capable models, used to pick a captioning model when
/// the configured chat model can't see images.
const VISION_MARKERS: &[&str] = &[
    "llava",
    "vision",
    "bakllava",
    "moondream",
    "minicpm-v",
    "qwen2-vl",
    "qwen2.5vl",
    "qwen2.5-vl",
];

/// Pick an installed vision-capable model by name heuristic, or None.
pub async fn first_vision_model(base_url: &str) -> Option<String> {
    installed_model_names(base_url).await.into_iter().find(|n| {
        let l = n.to_lowercase();
        VISION_MARKERS.iter().any(|m| l.contains(m))
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelInfo {
    pub name: String,
    pub chat_capable: bool,
    pub size_bytes: Option<u64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub connected: bool,
    pub base_url: String,
    pub version: Option<String>,
    pub total_models: u32,
    pub chat_models: u32,
    pub embedding_models: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelCapabilities {
    pub tools: Option<bool>,
    pub vision: Option<bool>,
}

/// Lightweight health check for a local Ollama instance.
pub async fn server_status(base_url: Option<String>) -> OllamaStatus {
    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let root = native_base(&base);

    let version_url = format!("{root}/api/version");
    let client = build_client();
    let version_resp = client.get(&version_url).send().await;
    let (connected, version) = match version_resp {
        Ok(res) if res.status().is_success() => {
            let version = res.text().await.ok().and_then(|text| {
                serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.get("version")
                            .and_then(|s| s.as_str())
                            .map(str::to_string)
                    })
            });
            (true, version)
        }
        _ => (false, None),
    };

    let models = if connected {
        installed_models(&base).await
    } else {
        Vec::new()
    };
    let chat_models = models
        .iter()
        .filter(|(name, _)| !looks_like_embedding(name))
        .count() as u32;
    let embedding_models = models.len() as u32 - chat_models;

    OllamaStatus {
        connected,
        base_url: root,
        version,
        total_models: models.len() as u32,
        chat_models,
        embedding_models,
    }
}

/// List models reported by a running Ollama server (`/api/tags`).
pub async fn list_models(base_url: Option<String>) -> Result<Vec<OllamaModelInfo>, String> {
    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let root = native_base(&base);
    let models = installed_models(&base).await;
    if models.is_empty() {
        return Err(format!(
            "Could not reach Ollama at {root}. Start Ollama and install a chat model (e.g. `ollama pull llama3`)."
        ));
    }
    Ok(models
        .into_iter()
        .map(|(name, size_bytes)| OllamaModelInfo {
            chat_capable: !looks_like_embedding(&name),
            name,
            size_bytes,
        })
        .collect())
}

/// Query `/api/show` capabilities for a single installed model.
pub async fn model_capabilities(
    base_url: Option<String>,
    model: String,
) -> Result<OllamaModelCapabilities, String> {
    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let client = OllamaClient::new(&base, model.trim(), None, None);
    Ok(OllamaModelCapabilities {
        tools: client.supports_tools().await,
        vision: client.supports_vision().await,
    })
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPullProgress {
    pub model: String,
    pub status: String,
    pub percent: Option<f32>,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub done: bool,
    pub error: Option<String>,
}

/// Pull (download) a model via Ollama `/api/pull`, streaming progress callbacks.
pub async fn pull_model<F: FnMut(OllamaPullProgress)>(
    base_url: Option<String>,
    model: String,
    mut on_progress: F,
) -> Result<(), String> {
    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let root = native_base(&base);
    let name = model.trim();
    if name.is_empty() {
        return Err("Model name is required.".into());
    }

    let url = format!("{root}/api/pull");
    let body = json!({ "name": name, "stream": true });
    let client = build_client();
    let mut resp = client
        .post(&url)
        .header("content-type", "application/json")
        .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| format!("Could not reach Ollama at {root}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        return Err(format!("Ollama returned HTTP {}: {}", status, snippet));
    }

    let mut emit = |status: &str, completed: Option<u64>, total: Option<u64>, done: bool, error: Option<String>| {
        let percent = match (completed, total) {
            (Some(c), Some(t)) if t > 0 => Some((c as f32 / t as f32) * 100.0),
            _ => None,
        };
        on_progress(OllamaPullProgress {
            model: name.to_string(),
            status: status.to_string(),
            percent,
            completed,
            total,
            done,
            error,
        });
    };

    emit("Starting download…", None, None, false, None);

    let mut buf: Vec<u8> = Vec::new();
    let mut last_status = String::new();
    let mut saw_success = false;

    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                let msg = format!("Ollama pull stream error: {e}");
                emit(&last_status, None, None, true, Some(msg.clone()));
                return Err(msg);
            }
        };
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let trimmed = String::from_utf8_lossy(&line).trim().to_string();
            if trimmed.is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(&trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                let msg = format!("Ollama error: {err}");
                emit(&last_status, None, None, true, Some(msg.clone()));
                return Err(msg);
            }
            let status = v
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("downloading");
            last_status = status.to_string();
            let completed = v.get("completed").and_then(|c| c.as_u64());
            let total = v.get("total").and_then(|t| t.as_u64());
            if status == "success" {
                saw_success = true;
                emit(status, completed, total, true, None);
            } else {
                emit(status, completed, total, false, None);
            }
        }
    }

    let tail = String::from_utf8_lossy(&buf).trim().to_string();
    if !tail.is_empty() {
        if let Ok(v) = serde_json::from_str::<Value>(&tail) {
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                let msg = format!("Ollama error: {err}");
                emit(&last_status, None, None, true, Some(msg.clone()));
                return Err(msg);
            }
            let status = v
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("downloading");
            if status == "success" {
                saw_success = true;
                emit(status, None, None, true, None);
            }
        }
    }

    if !saw_success {
        emit("success", None, None, true, None);
    }
    Ok(())
}

impl OllamaClient {
    pub fn new(
        base_url: &str,
        model: &str,
        num_ctx: Option<u32>,
        temperature: Option<f32>,
    ) -> Self {
        Self {
            base: native_base(base_url),
            model: model.to_string(),
            client: build_client(),
            num_ctx: num_ctx
                .filter(|&n| (512..=131072).contains(&n))
                .unwrap_or(CONTEXT_WINDOW),
            temperature: temperature.filter(|&t| (0.0..=2.0).contains(&t)).unwrap_or(0.4),
            format: None,
        }
    }

    /// Force the model to return a strict JSON object (Ollama `format: "json"`).
    /// Used by one-shot calls whose callers parse the reply as JSON.
    pub fn with_json_format(mut self) -> Self {
        self.format = Some(json!("json"));
        self
    }

    /// The effective context window (after clamp/default), so the caller can
    /// budget the in-turn message list against it.
    pub fn num_ctx(&self) -> u32 {
        self.num_ctx
    }

    /// Best-effort check of whether the selected model advertises a capability
    /// (e.g. `tools`, `vision`), via `/api/show`'s `capabilities`. Returns
    /// `Some(false)` only when the server explicitly lists capabilities without
    /// it; `None` when the info is unavailable (older Ollama), so the caller acts
    /// only on a definite `false` and otherwise lets the request decide.
    async fn capability(&self, cap: &str) -> Option<bool> {
        let url = format!("{}/api/show", self.base);
        let body = json!({ "model": self.model });
        let resp = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .body(serde_json::to_string(&body).ok()?)
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let text = resp.text().await.ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        let caps = v.get("capabilities").and_then(|c| c.as_array())?;
        Some(caps.iter().any(|c| c.as_str() == Some(cap)))
    }

    /// Whether the model advertises tool-calling (the agent requires it).
    pub async fn supports_tools(&self) -> Option<bool> {
        self.capability("tools").await
    }

    /// Whether the model advertises image/vision input.
    pub async fn supports_vision(&self) -> Option<bool> {
        self.capability("vision").await
    }

    /// One streaming chat round. `messages` is a JSON array; `tools` is a JSON
    /// array of OpenAI-style function schemas (sent only if non-empty). Text
    /// fragments are forwarded to `on_delta` as they arrive (so the caller can
    /// stream them to the UI); the fully-accumulated turn is returned at the end.
    pub async fn chat<F: FnMut(&str)>(
        &self,
        messages: &Value,
        tools: &Value,
        mut on_delta: F,
    ) -> Result<ChatTurn, String> {
        let url = format!("{}/api/chat", self.base);
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
            // Ollama defaults /api/chat to a small context window (often 2048),
            // which would silently truncate our system prompt + project context +
            // history + tool schemas. Request a larger window and a low
            // temperature for more deterministic tool use / editing.
            "options": {
                "num_ctx": self.num_ctx,
                "temperature": self.temperature,
            },
            // Keep the model resident between rounds so it isn't reloaded each turn.
            "keep_alive": "10m",
        });
        if tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            body["tools"] = tools.clone();
        }
        if let Some(fmt) = &self.format {
            body["format"] = fmt.clone();
        }

        let mut resp = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
            .send()
            .await
            .map_err(|e| format!("Could not reach Ollama at {}: {}", self.base, e))?;

        let status = resp.status();
        if !status.is_success() {
            // On an error status the body is a single JSON object, not a stream.
            let text = resp.text().await.unwrap_or_default();
            let snippet: String = text.chars().take(300).collect();
            // Surface the common "model doesn't support tools" case clearly.
            let lower = snippet.to_lowercase();
            if status.as_u16() == 400
                && (lower.contains("support tools")
                    || lower.contains("tool call")
                    || lower.contains("tool-call")
                    || lower.contains("tools are not supported"))
            {
                return Err(format!(
                    "The model '{}' does not support tool-calling. Pick a tool-capable model \
                     (e.g. llama3.1, qwen2.5, mistral-nemo) in Settings. [{}]",
                    self.model, snippet
                ));
            }
            return Err(format!("Ollama returned HTTP {}: {}", status, snippet));
        }

        let mut content = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut prompt_tokens = 0u64;
        let mut eval_tokens = 0u64;
        let mut buf: Vec<u8> = Vec::new();
        let mut saw_line = false;

        // Ollama streams newline-delimited JSON objects. Buffer raw bytes and
        // parse each complete line as it arrives (splitting on '\n', an ASCII
        // byte, never bisects a multibyte UTF-8 sequence). `chunk()` needs no
        // `StreamExt`/`futures` dependency, so this stays a thin reqwest call.
        loop {
            let chunk = match resp.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(e) => return Err(format!("Ollama stream error: {}", e)),
            };
            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let line_str = String::from_utf8_lossy(&line);
                let trimmed = line_str.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let v: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    // Skip a single malformed line rather than abort the whole turn.
                    Err(_) => continue,
                };
                saw_line = true;
                accumulate_stream_line(
                    &v,
                    &mut content,
                    &mut tool_calls,
                    &mut prompt_tokens,
                    &mut eval_tokens,
                    &mut on_delta,
                )?;
            }
        }

        // Flush a trailing object that arrived without a terminating newline.
        let tail = String::from_utf8_lossy(&buf);
        let tail = tail.trim();
        if !tail.is_empty() {
            if let Ok(v) = serde_json::from_str::<Value>(tail) {
                saw_line = true;
                accumulate_stream_line(
                    &v,
                    &mut content,
                    &mut tool_calls,
                    &mut prompt_tokens,
                    &mut eval_tokens,
                    &mut on_delta,
                )?;
            }
        }

        if !saw_line {
            return Err(
                "Ollama returned an empty response (the model may have failed to load — \
                 check `ollama ps` / the server logs for an out-of-memory or runner error)."
                    .to_string(),
            );
        }

        Ok(ChatTurn {
            content,
            tool_calls,
            prompt_tokens,
            eval_tokens,
        })
    }

    /// Embed one or more texts via Ollama `/api/embed`. Returns one float vector
    /// per input, in order. Non-streaming.
    pub async fn embed(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let url = format!("{}/api/embed", self.base);
        let body = json!({ "model": self.model, "input": inputs });
        let resp = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
            .send()
            .await
            .map_err(|e| format!("Could not reach Ollama at {}: {}", self.base, e))?;

        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let snippet: String = text.chars().take(300).collect();
            return Err(format!("Ollama embed returned HTTP {}: {}", status, snippet));
        }

        let v: Value =
            serde_json::from_str(&text).map_err(|e| format!("Bad embed response: {}", e))?;
        let arr = v
            .get("embeddings")
            .and_then(|e| e.as_array())
            .ok_or_else(|| "Embed response missing 'embeddings'.".to_string())?;

        let mut out = Vec::with_capacity(arr.len());
        for emb in arr {
            let nums = emb
                .as_array()
                .ok_or_else(|| "Malformed embedding vector.".to_string())?;
            out.push(
                nums.iter()
                    .filter_map(|n| n.as_f64().map(|f| f as f32))
                    .collect(),
            );
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_tool_names() {
        assert_eq!(canonicalize_tool_name(" read "), "Read");
        assert_eq!(canonicalize_tool_name("functions.read"), "Read");
        assert_eq!(canonicalize_tool_name("WRITE"), "Write");
        assert_eq!(canonicalize_tool_name("Edit"), "Edit");
        assert_eq!(canonicalize_tool_name("unknown_tool"), "unknown_tool");
    }

    #[test]
    fn detects_embedding_models() {
        assert!(looks_like_embedding("nomic-embed-text:latest"));
        assert!(looks_like_embedding("mxbai-embed-large"));
        assert!(looks_like_embedding("bge-m3"));
        assert!(!looks_like_embedding("llama3.1:8b"));
        assert!(!looks_like_embedding("qwen2.5-coder:7b"));
    }

    #[test]
    fn accumulates_streamed_turn() {
        // A typical Ollama stream: two text fragments, then a final `done` line
        // carrying a tool call and the token counts.
        let lines = [
            json!({ "message": { "role": "assistant", "content": "Hel" }, "done": false }),
            json!({ "message": { "role": "assistant", "content": "lo" }, "done": false }),
            json!({
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{ "function": { "name": "read", "arguments": { "file_path": "a.tex" } } }]
                },
                "done": true,
                "prompt_eval_count": 123,
                "eval_count": 7
            }),
        ];

        let mut content = String::new();
        let mut tool_calls = Vec::new();
        let (mut pt, mut et) = (0u64, 0u64);
        let mut streamed = String::new();
        for v in &lines {
            accumulate_stream_line(
                v,
                &mut content,
                &mut tool_calls,
                &mut pt,
                &mut et,
                &mut |frag: &str| streamed.push_str(frag),
            )
            .unwrap();
        }

        assert_eq!(content, "Hello");
        assert_eq!(streamed, "Hello"); // on_delta saw every fragment, in order
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].name, "Read"); // canonicalized from "read"
        assert_eq!(pt, 123);
        assert_eq!(et, 7);
    }

    #[test]
    fn stream_error_envelope_surfaces() {
        let mut content = String::new();
        let mut tool_calls = Vec::new();
        let (mut pt, mut et) = (0u64, 0u64);
        let err = accumulate_stream_line(
            &json!({ "error": "model runner crashed" }),
            &mut content,
            &mut tool_calls,
            &mut pt,
            &mut et,
            &mut |_: &str| {},
        );
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("model runner crashed"));
    }

    #[test]
    fn normalizes_base_url() {
        assert_eq!(native_base("http://localhost:11434/v1"), "http://localhost:11434");
        assert_eq!(native_base("http://localhost:11434/v1/"), "http://localhost:11434");
        assert_eq!(native_base("http://localhost:11434/"), "http://localhost:11434");
        assert_eq!(native_base(""), "http://localhost:11434");
        assert_eq!(native_base("http://host:1/v1"), "http://host:1");
    }
}
