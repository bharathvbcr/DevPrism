//! OpenAI-compatible `/v1/chat/completions` client with streaming tool calling.
//! Used by the native OpenAI-compat backends (Groq, OpenRouter, Gemini, …).

use serde_json::{json, Value};

use super::ollama::{canonicalize_tool_name, ChatTurn, StreamDeltaKind, ToolCall};

const CONTEXT_WINDOW: u32 = 8192;
const DEFAULT_MAX_COMPLETION_TOKENS: u32 = 4096;
const REQUEST_TIMEOUT_SECS: u64 = 600;
const STREAM_IDLE_TIMEOUT_SECS: u64 = 90;
const CONNECT_TIMEOUT_SECS: u64 = 15;

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// True when `base_url` already includes a chat-API root (`/v1`–`/v4`, `/beta`,
/// `/openai`, DeepSeek origin, etc.) so we should append `/chat/completions`
/// rather than `/v1/chat/completions`. Ported from `claude.rs` so Gemini's
/// `/v1beta/openai` root works natively.
fn openai_compatible_base_url_has_chat_root(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    if lower == "https://api.deepseek.com" {
        return true;
    }

    let path = lower
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/').map(|(_, path)| path))
        .unwrap_or("")
        .trim_matches('/');
    if path.is_empty() {
        return false;
    }

    let segments = path.split('/').collect::<Vec<_>>();
    let last = segments.last().copied().unwrap_or_default();
    matches!(last, "v1" | "v2" | "v3" | "v4" | "beta" | "openai")
        || path.ends_with("/openai")
        // Vertex AI OpenAI-compatible root ends with /endpoints/openapi
        || path.ends_with("/endpoints/openapi")
        || path.ends_with("compatible-mode/v1")
}

fn chat_completions_url(base_url: &str) -> String {
    let clean = base_url.trim().trim_end_matches('/');
    if clean.ends_with("/chat/completions") {
        clean.to_string()
    } else if openai_compatible_base_url_has_chat_root(clean) {
        format!("{clean}/chat/completions")
    } else {
        format!("{clean}/v1/chat/completions")
    }
}

fn models_url(base_url: &str) -> String {
    let clean = base_url.trim().trim_end_matches('/');
    if let Some(root) = clean.strip_suffix("/chat/completions") {
        return format!("{}/models", root.trim_end_matches('/'));
    }
    if openai_compatible_base_url_has_chat_root(clean) {
        format!("{clean}/models")
    } else {
        format!("{clean}/v1/models")
    }
}

fn embeddings_url(base_url: &str) -> String {
    let clean = base_url.trim().trim_end_matches('/');
    if clean.ends_with("/embeddings") {
        clean.to_string()
    } else if let Some(root) = clean.strip_suffix("/chat/completions") {
        format!("{}/embeddings", root.trim_end_matches('/'))
    } else if openai_compatible_base_url_has_chat_root(clean) {
        format!("{clean}/embeddings")
    } else {
        format!("{clean}/v1/embeddings")
    }
}

fn is_openrouter_base(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("openrouter.ai")
}

fn provider_label(base_url: &str) -> &'static str {
    let lower = base_url.to_ascii_lowercase();
    if lower.contains("groq.com") {
        "Groq"
    } else if lower.contains("openrouter.ai") {
        "OpenRouter"
    } else if lower.contains("aiplatform.googleapis.com")
        || lower.contains("generativelanguage.googleapis.com")
        || lower.contains("googleapis.com")
    {
        "Gemini"
    } else if lower.contains("api.openai.com") {
        "OpenAI"
    } else {
        "Provider"
    }
}

/// Whether this OpenAI-compat base URL is known to expose `/embeddings`.
pub fn base_url_supports_embeddings(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    lower.contains("generativelanguage.googleapis.com")
        || lower.contains("api.openai.com")
        || (lower.contains("googleapis.com") && lower.contains("openai"))
}

fn default_embedding_model(base_url: &str) -> &'static str {
    let lower = base_url.to_ascii_lowercase();
    if lower.contains("aiplatform.googleapis.com")
        || lower.contains("generativelanguage.googleapis.com")
        || lower.contains("googleapis.com")
    {
        "text-embedding-004"
    } else {
        "text-embedding-3-small"
    }
}

fn apply_provider_headers(
    mut req: reqwest::RequestBuilder,
    base_url: &str,
    bearer_token: Option<&str>,
) -> reqwest::RequestBuilder {
    if let Some(token) = bearer_token {
        req = req.bearer_auth(token);
    }
    if is_openrouter_base(base_url) {
        // OpenRouter ranking / attribution headers (optional but recommended).
        req = req
            .header("HTTP-Referer", "https://github.com/bharathvbcr/DevPrism")
            .header("X-Title", "DevPrism");
    }
    req
}

/// Whether a provider's 400 body is the "you didn't give a function call its
/// thought signature back" rejection. Gemini 3 phrases it as `is missing a
/// `thought_signature`` / `thought_signature` in `functionCall` parts`, so match on
/// the field name rather than the surrounding sentence, which varies by surface.
fn is_missing_thought_signature_error(snippet: &str) -> bool {
    let lower = snippet.to_ascii_lowercase();
    lower.contains("thought_signature") || lower.contains("thoughtsignature")
}

fn provider_auth_error(base_url: &str, api_key: &str, snippet: &str) -> String {
    if crate::google_auth::is_vertex_openai_compat_base_url(base_url)
        && api_key.trim().starts_with("AIza")
    {
        return format!(
            "[E_AUTH] Vertex needs an OAuth access token, not an API key — use the Gemini (AI Studio) preset for API keys, or log in with gcloud. [{snippet}]"
        );
    }
    format!("[E_AUTH] Invalid API key for {base_url}. Check Settings → Provider. [{snippet}]")
}

fn accumulate_openai_stream_line<F: FnMut(StreamDeltaKind, &str)>(
    v: &Value,
    content: &mut String,
    thinking: &mut String,
    tool_calls: &mut Vec<ToolCall>,
    tool_arg_buffers: &mut Vec<String>,
    prompt_tokens: &mut u64,
    eval_tokens: &mut u64,
    on_delta: &mut F,
) -> Result<bool, String> {
    if let Some(err) = v
        .pointer("/error/message")
        .or_else(|| v.get("message"))
        .and_then(|e| e.as_str())
    {
        return Err(format!("OpenAI API error: {err}"));
    }

    if let Some(usage) = v.get("usage") {
        if let Some(n) = usage.get("prompt_tokens").and_then(|n| n.as_u64()) {
            *prompt_tokens = n;
        }
        if let Some(n) = usage.get("completion_tokens").and_then(|n| n.as_u64()) {
            *eval_tokens = n;
        }
    }

    let choices = v.get("choices").and_then(|c| c.as_array());
    let Some(first) = choices.and_then(|c| c.first()) else {
        return Ok(false);
    };

    if let Some(delta) = first.get("delta") {
        if let Some(frag) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("thinking"))
            .and_then(|c| c.as_str())
        {
            if !frag.is_empty() {
                thinking.push_str(frag);
                on_delta(StreamDeltaKind::Thinking, frag);
            }
        }
        if let Some(frag) = delta.get("content").and_then(|c| c.as_str()) {
            if !frag.is_empty() {
                content.push_str(frag);
                on_delta(StreamDeltaKind::Text, frag);
            }
        }
        if let Some(arr) = delta.get("tool_calls").and_then(|t| t.as_array()) {
            for call in arr {
                let idx = call.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                while tool_calls.len() <= idx {
                    tool_calls.push(ToolCall {
                        name: String::new(),
                        args: json!({}),
                        ..Default::default()
                    });
                }
                while tool_arg_buffers.len() <= idx {
                    tool_arg_buffers.push(String::new());
                }
                if let Some(id_name) = call.pointer("/function/name").and_then(|n| n.as_str()) {
                    tool_calls[idx].name = canonicalize_tool_name(id_name);
                }
                // The id and `extra_content` usually arrive on the FIRST delta for
                // this index while the arguments stream in later ones, so latch
                // each the first time it shows up and never clobber it with a
                // later fragment that omits it.
                if let Some(id) = call
                    .get("id")
                    .and_then(|i| i.as_str())
                    .filter(|i| !i.trim().is_empty())
                {
                    tool_calls[idx].provider_id = Some(id.to_string());
                }
                // Gemini 3's thought signature rides here. It MUST be echoed back
                // verbatim on the next request or the provider rejects the whole
                // conversation with HTTP 400.
                if let Some(extra) = call.get("extra_content").filter(|v| !v.is_null()) {
                    tool_calls[idx].extra_content = Some(extra.clone());
                }
                if let Some(args_frag) =
                    call.pointer("/function/arguments").and_then(|a| a.as_str())
                {
                    tool_arg_buffers[idx].push_str(args_frag);
                }
            }
        }
    }

    let finish = first.get("finish_reason").and_then(|f| f.as_str());
    Ok(finish == Some("stop") || finish == Some("tool_calls"))
}

/// The id to use on the wire for `call`.
///
/// A provider that issued its own `tool_calls[].id` gets that exact id back:
/// Gemini 3 binds per-call reasoning state to it, and substituting a locally
/// minted id breaks the follow-up request. `fallback` (our internal id) is used
/// for providers that issue none. The assistant `tool_calls` entry and the `tool`
/// message answering it must both resolve through here or they stop pairing.
pub fn wire_tool_call_id(call: &ToolCall, fallback: &str) -> String {
    call.provider_id
        .clone()
        .unwrap_or_else(|| fallback.to_string())
}

/// One `tool_calls[]` entry for an outbound assistant message.
///
/// Carries the provider's own id plus any per-call metadata it requires back
/// verbatim — Gemini 3's thought signature travels in `extra_content`. The key is
/// omitted entirely for providers that send none, so their request bodies are
/// byte-identical to what we sent before signatures existed.
pub fn assistant_tool_call_entry(call: &ToolCall, fallback_id: &str) -> Value {
    let arguments = if call.args.is_string() {
        call.args.as_str().unwrap_or("{}").to_string()
    } else {
        serde_json::to_string(&call.args).unwrap_or_else(|_| "{}".to_string())
    };
    let mut entry = json!({
        "id": wire_tool_call_id(call, fallback_id),
        "type": "function",
        "function": { "name": call.name, "arguments": arguments },
    });
    if let Some(extra) = call.extra_content.as_ref().filter(|v| !v.is_null()) {
        entry["extra_content"] = extra.clone();
    }
    entry
}

pub struct OpenAiCompatClient {
    base_url: String,
    model: String,
    api_key: String,
    client: reqwest::Client,
    num_ctx: u32,
    temperature: f32,
    json_format: bool,
}

impl OpenAiCompatClient {
    pub fn new(
        base_url: &str,
        model: &str,
        api_key: &str,
        num_ctx: Option<u32>,
        temperature: Option<f32>,
    ) -> Self {
        Self {
            base_url: base_url.trim().trim_end_matches('/').to_string(),
            model: model.to_string(),
            api_key: api_key.trim().to_string(),
            client: build_client(),
            num_ctx: num_ctx
                .filter(|&n| (512..=131072).contains(&n))
                .unwrap_or(CONTEXT_WINDOW),
            temperature: temperature
                .filter(|&t| (0.0..=2.0).contains(&t))
                .unwrap_or(0.4),
            json_format: false,
        }
    }

    /// Request `response_format: { type: "json_object" }` when the provider supports it.
    pub fn with_json_format(mut self) -> Self {
        self.json_format = true;
        self
    }

    pub fn num_ctx(&self) -> u32 {
        self.num_ctx
    }

    /// Most OpenAI-compat tool-use models support tools; vision is model-dependent.
    pub async fn supports_tools(&self) -> Option<bool> {
        Some(true)
    }

    pub async fn supports_vision(&self) -> Option<bool> {
        let l = self.model.to_lowercase();
        Some(l.contains("vision") || l.contains("llava") || l.contains("gemini"))
    }

    pub async fn chat<F: FnMut(StreamDeltaKind, &str)>(
        &self,
        messages: &Value,
        tools: &Value,
        mut on_delta: F,
    ) -> Result<ChatTurn, String> {
        let url = chat_completions_url(&self.base_url);
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
            "temperature": self.temperature,
            "max_tokens": DEFAULT_MAX_COMPLETION_TOKENS,
        });
        if tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            body["tools"] = tools.clone();
            body["tool_choice"] = json!("auto");
        }
        if self.json_format {
            body["response_format"] = json!({ "type": "json_object" });
        }

        let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;
        let url_clone = url.clone();
        let api_key = self.api_key.clone();
        let base_url = self.base_url.clone();
        let client = self.client.clone();
        let bearer_token =
            crate::google_auth::resolve_vertex_bearer_token(&base_url, &api_key).await?;
        let mut resp = crate::retry::send_with_retry(3, || {
            let req = client
                .post(&url_clone)
                .header("content-type", "application/json")
                .body(body_str.clone());
            apply_provider_headers(req, &base_url, bearer_token.as_deref())
        })
        .await
        .map_err(|e| {
            format!(
                "[E_OPENAI_UNREACHABLE] Could not reach {}: {e}",
                self.base_url
            )
        })?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let snippet: String = text.chars().take(300).collect();
            let label = provider_label(&self.base_url);
            if status.as_u16() == 429 {
                return Err(format!(
                    "[E_RATE_LIMIT] {label} rate limit exceeded. Wait and retry. [{snippet}]"
                ));
            }
            if status.as_u16() == 401 {
                return Err(provider_auth_error(&self.base_url, &self.api_key, &snippet));
            }
            // A reasoning model that binds per-call state to its tool calls (Gemini
            // 3) rejects the whole conversation if a signature did not come back.
            // We echo them, so reaching here means one was lost rather than
            // never captured — say so plainly instead of surfacing raw provider
            // JSON, and tell the user the one thing that clears it.
            if status.as_u16() == 400 && is_missing_thought_signature_error(&snippet) {
                return Err(format!(
                    "[E_THOUGHT_SIGNATURE] {label} rejected this conversation: a tool call in the \
                     history is missing its thought signature, so the reasoning chain can't be \
                     validated. Start a new chat to clear the stale history. [{snippet}]"
                ));
            }
            return Err(format!("OpenAI API returned HTTP {status}: {snippet}"));
        }

        let mut content = String::new();
        let mut thinking = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut tool_arg_buffers: Vec<String> = Vec::new();
        let mut prompt_tokens = 0u64;
        let mut eval_tokens = 0u64;
        let mut buf: Vec<u8> = Vec::new();

        loop {
            let chunk = match tokio::time::timeout(
                std::time::Duration::from_secs(STREAM_IDLE_TIMEOUT_SECS),
                resp.chunk(),
            )
            .await
            {
                Ok(Ok(Some(c))) => c,
                Ok(Ok(None)) => break,
                Ok(Err(e)) => return Err(format!("OpenAI stream error: {e}")),
                Err(_) => {
                    return Err(format!(
                        "[E_OPENAI_STALLED] Stream idle for {STREAM_IDLE_TIMEOUT_SECS}s"
                    ));
                }
            };
            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
                if line.is_empty() || line == "data: [DONE]" {
                    continue;
                }
                let json_str = line.strip_prefix("data: ").unwrap_or(&line);
                if json_str.trim().is_empty() {
                    continue;
                }
                let v: Value =
                    serde_json::from_str(json_str).map_err(|e| format!("Bad SSE JSON: {e}"))?;
                let _done = accumulate_openai_stream_line(
                    &v,
                    &mut content,
                    &mut thinking,
                    &mut tool_calls,
                    &mut tool_arg_buffers,
                    &mut prompt_tokens,
                    &mut eval_tokens,
                    &mut on_delta,
                )?;
            }
        }

        for (idx, tc) in tool_calls.iter_mut().enumerate() {
            if let Some(buf) = tool_arg_buffers.get(idx).filter(|b| !b.is_empty()) {
                tc.args =
                    serde_json::from_str(buf).unwrap_or_else(|_| json!({ "raw": buf.clone() }));
            }
        }

        tool_calls.retain(|tc| !tc.name.is_empty());
        Ok(ChatTurn {
            content,
            thinking,
            tool_calls,
            prompt_tokens,
            eval_tokens,
        })
    }

    /// Embed texts via OpenAI-compatible `/embeddings` (Gemini, OpenAI, …).
    pub async fn embeddings(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>, String> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        let url = embeddings_url(&self.base_url);
        let body = json!({
            "model": self.model,
            "input": inputs,
        });
        let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;
        let req = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .body(body_str);
        let bearer_token =
            crate::google_auth::resolve_vertex_bearer_token(&self.base_url, &self.api_key).await?;
        let resp = apply_provider_headers(req, &self.base_url, bearer_token.as_deref())
            .send()
            .await
            .map_err(|e| {
                format!(
                    "[E_OPENAI_UNREACHABLE] Could not reach embeddings at {}: {e}",
                    self.base_url
                )
            })?;

        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let snippet: String = text.chars().take(300).collect();
            return Err(format!("Embeddings returned HTTP {status}: {snippet}"));
        }

        let v: Value =
            serde_json::from_str(&text).map_err(|e| format!("Bad embeddings response: {e}"))?;
        let data = v
            .get("data")
            .and_then(|d| d.as_array())
            .ok_or_else(|| "Embeddings response missing 'data'.".to_string())?;

        let mut out = Vec::with_capacity(data.len());
        for item in data {
            let nums = item
                .get("embedding")
                .and_then(|e| e.as_array())
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

/// List models from an OpenAI-compatible `/models` endpoint.
pub async fn list_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    let url = models_url(base_url);
    let req = build_client().get(&url);
    let bearer_token = crate::google_auth::resolve_vertex_bearer_token(base_url, api_key).await?;
    let res = apply_provider_headers(req, base_url, bearer_token.as_deref())
        .send()
        .await
        .map_err(|e| format!("Could not reach {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} listing models", res.status()));
    }
    let text = res.text().await.map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("data")
        .and_then(|d| d.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|it| it.get("id").and_then(|id| id.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

/// Build a client for embeddings using a stored credential's base URL + key.
pub fn embedding_client_for_credential(
    base_url: &str,
    api_key: &str,
    model: Option<&str>,
) -> Option<OpenAiCompatClient> {
    if !base_url_supports_embeddings(base_url) {
        return None;
    }
    let model = model
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| default_embedding_model(base_url));
    Some(OpenAiCompatClient::new(
        base_url, model, api_key, None, None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_completions_url_normalizes() {
        assert_eq!(
            chat_completions_url("https://api.groq.com/openai/v1"),
            "https://api.groq.com/openai/v1/chat/completions"
        );
        // `/openai` is treated as a chat root (same as claude.rs) — used by Gemini.
        assert_eq!(
            chat_completions_url("https://api.groq.com/openai"),
            "https://api.groq.com/openai/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://generativelanguage.googleapis.com/v1beta/openai/"),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
        assert_eq!(
            chat_completions_url(
                "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi"
            ),
            "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn models_url_matches_chat_root() {
        assert_eq!(
            models_url("https://generativelanguage.googleapis.com/v1beta/openai"),
            "https://generativelanguage.googleapis.com/v1beta/openai/models"
        );
        assert_eq!(
            models_url("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1/models"
        );
    }

    #[test]
    fn embeddings_url_matches_chat_root() {
        assert_eq!(
            embeddings_url("https://generativelanguage.googleapis.com/v1beta/openai"),
            "https://generativelanguage.googleapis.com/v1beta/openai/embeddings"
        );
        assert_eq!(
            embeddings_url("https://api.openai.com"),
            "https://api.openai.com/v1/embeddings"
        );
    }

    #[test]
    fn base_url_supports_embeddings_detects_gemini_and_openai() {
        assert!(base_url_supports_embeddings(
            "https://generativelanguage.googleapis.com/v1beta/openai"
        ));
        assert!(base_url_supports_embeddings("https://api.openai.com/v1"));
        assert!(!base_url_supports_embeddings(
            "https://api.groq.com/openai/v1"
        ));
        assert!(!base_url_supports_embeddings(
            "https://openrouter.ai/api/v1"
        ));
    }

    /// Fold a sequence of parsed SSE chunks exactly the way `chat` does, including
    /// the post-loop argument assembly, and return the accumulated calls.
    fn fold_stream(chunks: &[Value]) -> Vec<ToolCall> {
        let mut content = String::new();
        let mut thinking = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut arg_buffers: Vec<String> = Vec::new();
        let mut prompt_tokens = 0u64;
        let mut eval_tokens = 0u64;
        let mut on_delta = |_: StreamDeltaKind, _: &str| {};
        for chunk in chunks {
            accumulate_openai_stream_line(
                chunk,
                &mut content,
                &mut thinking,
                &mut tool_calls,
                &mut arg_buffers,
                &mut prompt_tokens,
                &mut eval_tokens,
                &mut on_delta,
            )
            .expect("chunk should fold cleanly");
        }
        for (idx, call) in tool_calls.iter_mut().enumerate() {
            if let Some(buf) = arg_buffers.get(idx).filter(|b| !b.is_empty()) {
                call.args =
                    serde_json::from_str(buf).unwrap_or_else(|_| json!({ "raw": buf.clone() }));
            }
        }
        tool_calls
    }

    fn tool_call_chunk(call: Value) -> Value {
        json!({ "choices": [{ "delta": { "tool_calls": [call] } }] })
    }

    /// Gemini 3 attaches a thought signature to each function call it emits; losing
    /// it makes the NEXT request fail with HTTP 400. Before this was captured the
    /// signature never left the SSE parser.
    #[test]
    fn captures_gemini_thought_signature_and_provider_id_from_a_tool_call_delta() {
        let calls = fold_stream(&[tool_call_chunk(json!({
            "index": 0,
            "id": "function-call-8850542188",
            "type": "function",
            "extra_content": { "google": { "thought_signature": "CvcQAdHN2OekY10ClPFkYA==" } },
            "function": { "name": "Read", "arguments": "{\"file_path\":\"main.tex\"}" }
        }))]);

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "Read");
        assert_eq!(
            calls[0].provider_id.as_deref(),
            Some("function-call-8850542188")
        );
        assert_eq!(
            calls[0].extra_content.as_ref().and_then(|extra| extra
                .pointer("/google/thought_signature")
                .and_then(|value| value.as_str())),
            Some("CvcQAdHN2OekY10ClPFkYA==")
        );
    }

    /// The id and signature arrive on the FIRST delta for an index while arguments
    /// stream in over later ones. A later fragment must not blank them out.
    #[test]
    fn latches_signature_across_split_argument_deltas() {
        let calls = fold_stream(&[
            tool_call_chunk(json!({
                "index": 0,
                "id": "function-call-1",
                "extra_content": { "google": { "thought_signature": "SIG_ONE" } },
                "function": { "name": "Bash", "arguments": "{\"comm" }
            })),
            tool_call_chunk(json!({
                "index": 0,
                "function": { "arguments": "and\":\"ls" }
            })),
            tool_call_chunk(json!({
                "index": 0,
                "function": { "arguments": "\"}" }
            })),
        ]);

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].provider_id.as_deref(), Some("function-call-1"));
        assert_eq!(
            calls[0]
                .extra_content
                .as_ref()
                .and_then(|extra| extra.pointer("/google/thought_signature"))
                .and_then(|value| value.as_str()),
            Some("SIG_ONE")
        );
        assert_eq!(calls[0].args["command"], "ls");
    }

    /// Parallel calls each carry their OWN signature; they must not be crossed or
    /// collapsed, including when the provider interleaves the two indices.
    #[test]
    fn keeps_per_call_signatures_separate_for_interleaved_parallel_calls() {
        let calls = fold_stream(&[
            tool_call_chunk(json!({
                "index": 0,
                "id": "call-a",
                "extra_content": { "google": { "thought_signature": "SIG_A" } },
                "function": { "name": "Read", "arguments": "{\"file_path\":" }
            })),
            tool_call_chunk(json!({
                "index": 1,
                "id": "call-b",
                "extra_content": { "google": { "thought_signature": "SIG_B" } },
                "function": { "name": "Grep", "arguments": "{\"pattern\":" }
            })),
            tool_call_chunk(json!({ "index": 1, "function": { "arguments": "\"todo\"}" } })),
            tool_call_chunk(json!({ "index": 0, "function": { "arguments": "\"a.tex\"}" } })),
        ]);

        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].provider_id.as_deref(), Some("call-a"));
        assert_eq!(calls[1].provider_id.as_deref(), Some("call-b"));
        assert_eq!(
            calls[0]
                .extra_content
                .as_ref()
                .and_then(|e| e.pointer("/google/thought_signature"))
                .and_then(|v| v.as_str()),
            Some("SIG_A")
        );
        assert_eq!(
            calls[1]
                .extra_content
                .as_ref()
                .and_then(|e| e.pointer("/google/thought_signature"))
                .and_then(|v| v.as_str()),
            Some("SIG_B")
        );
        assert_eq!(calls[0].args["file_path"], "a.tex");
        assert_eq!(calls[1].args["pattern"], "todo");
    }

    /// Providers that send no metadata (Groq, OpenAI, OpenRouter, …) must be
    /// unaffected: nothing captured, and no `extra_content` key on the way out.
    #[test]
    fn providers_without_metadata_stay_on_the_pre_existing_wire_format() {
        let calls = fold_stream(&[
            tool_call_chunk(json!({
                "index": 0,
                "id": "call_abc",
                "function": { "name": "Read", "arguments": "{}" }
            })),
            // An explicit null must be treated as absent, not stored and echoed.
            tool_call_chunk(json!({ "index": 0, "extra_content": Value::Null })),
        ]);

        assert_eq!(calls.len(), 1);
        assert!(calls[0].extra_content.is_none());

        let entry = assistant_tool_call_entry(&calls[0], "native_fallback_0");
        assert!(entry.get("extra_content").is_none());
        assert_eq!(entry["id"], "call_abc");
        assert_eq!(entry["function"]["name"], "Read");
        assert_eq!(entry["function"]["arguments"], "{}");
    }

    /// An empty or whitespace id is not a usable id — fall back to the internal one
    /// rather than sending `""` and breaking result pairing.
    #[test]
    fn ignores_blank_provider_ids_and_falls_back_to_the_internal_id() {
        let calls = fold_stream(&[tool_call_chunk(json!({
            "index": 0,
            "id": "   ",
            "function": { "name": "LS", "arguments": "{}" }
        }))]);

        assert_eq!(calls.len(), 1);
        assert!(calls[0].provider_id.is_none());
        assert_eq!(
            wire_tool_call_id(&calls[0], "native_tab_0_0"),
            "native_tab_0_0"
        );
    }

    /// The outbound assistant message is what Gemini validates: it must carry the
    /// provider's id AND the signature, unmodified.
    #[test]
    fn outbound_assistant_entry_echoes_provider_id_and_signature_verbatim() {
        let signature = "CvcQAdHN2OekY10ClPFkYA==";
        let call = ToolCall {
            name: "Edit".to_string(),
            args: json!({ "file_path": "main.tex", "old_string": "a", "new_string": "b" }),
            provider_id: Some("function-call-777".to_string()),
            extra_content: Some(json!({ "google": { "thought_signature": signature } })),
        };

        let entry = assistant_tool_call_entry(&call, "native_tab_3_0");

        assert_eq!(entry["id"], "function-call-777");
        assert_eq!(
            entry["extra_content"]["google"]["thought_signature"],
            signature
        );
        // Arguments are re-serialized as the JSON *string* the OpenAI schema wants.
        let arguments = entry["function"]["arguments"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap()["file_path"],
            "main.tex"
        );
    }

    /// Arguments that arrived as a raw string must not be double-encoded.
    #[test]
    fn does_not_double_encode_string_arguments() {
        let call = ToolCall {
            name: "Read".to_string(),
            args: Value::String("{\"file_path\":\"a.tex\"}".to_string()),
            provider_id: None,
            extra_content: None,
        };

        let entry = assistant_tool_call_entry(&call, "native_tab_0_0");

        assert_eq!(entry["function"]["arguments"], "{\"file_path\":\"a.tex\"}");
        assert_eq!(entry["id"], "native_tab_0_0");
    }

    /// Deterministic LCG so a stress failure reproduces exactly. Avoids pulling in
    /// a PRNG dependency for a test.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0 >> 11
        }

        fn below(&mut self, n: usize) -> usize {
            if n == 0 {
                0
            } else {
                (self.next() % n as u64) as usize
            }
        }
    }

    /// Adversarial signature payloads: normal base64, empty, unicode, very long,
    /// JSON-significant characters, and extra sibling keys we must not drop.
    fn stress_signature(seed: usize) -> Value {
        match seed % 6 {
            0 => json!({ "google": { "thought_signature": "CvcQAdHN2OekY10ClPFkYA==" } }),
            1 => json!({ "google": { "thought_signature": "" } }),
            2 => json!({ "google": { "thought_signature": "签名/with\"quotes\"\\and\nnewline" } }),
            3 => json!({ "google": { "thought_signature": "A".repeat(8192) } }),
            4 => json!({
                "google": {
                    "thought_signature": "sig-with-siblings",
                    "unknown_future_field": { "nested": [1, 2, 3] }
                }
            }),
            _ => json!({ "google": { "thought_signature": "Zm9vYmFyCg==" }, "vendor": "x" }),
        }
    }

    /// Fuzz the streaming parser against randomly fragmented, out-of-order,
    /// multi-call SSE and assert the invariants that keep the NEXT request valid:
    ///
    /// 1. every signature survives byte-identically, attached to the right call;
    /// 2. the provider's id is what goes back on the wire;
    /// 3. the assistant `tool_calls` ids and the `tool` result ids pair exactly —
    ///    a mismatch is its own HTTP 400;
    /// 4. calls with no metadata never gain an `extra_content` key.
    #[test]
    fn stress_randomly_fragmented_multi_call_streams_preserve_every_signature() {
        let mut rng = Lcg(0x5EED_1234);

        for round in 0..400 {
            let call_count = 1 + rng.below(6);
            // Truth table for this round: index -> (id, name, args, signature?)
            let mut expected: Vec<(String, String, Value, Option<Value>)> = Vec::new();
            for slot in 0..call_count {
                let has_signature = rng.below(3) != 0;
                expected.push((
                    format!("function-call-{round}-{slot}"),
                    ["Read", "Grep", "Bash", "LS"][rng.below(4)].to_string(),
                    json!({ "file_path": format!("f{slot}.tex"), "n": slot }),
                    has_signature.then(|| stress_signature(round + slot)),
                ));
            }

            // Emit the opening delta for every call (id + metadata + name), then the
            // argument text in random fragments, interleaved across indices.
            let mut chunks: Vec<Value> = Vec::new();
            let mut pending: Vec<(usize, String)> = Vec::new();
            for (idx, (id, name, args, signature)) in expected.iter().enumerate() {
                let mut opening = json!({
                    "index": idx,
                    "id": id,
                    "type": "function",
                    "function": { "name": name, "arguments": "" }
                });
                if let Some(signature) = signature {
                    opening["extra_content"] = signature.clone();
                }
                chunks.push(tool_call_chunk(opening));
                pending.push((idx, serde_json::to_string(args).unwrap()));
            }
            // Drain the argument text a random fragment at a time from a random call.
            while !pending.is_empty() {
                let pick = rng.below(pending.len());
                let (idx, rest) = pending[pick].clone();
                let take = 1 + rng.below(rest.len().max(1));
                let take = take.min(rest.len());
                // Split on a char boundary; the fixtures are ASCII, but be safe.
                let mut split = take;
                while split < rest.len() && !rest.is_char_boundary(split) {
                    split += 1;
                }
                let (fragment, remainder) = rest.split_at(split);
                chunks.push(tool_call_chunk(json!({
                    "index": idx,
                    "function": { "arguments": fragment }
                })));
                if remainder.is_empty() {
                    pending.remove(pick);
                } else {
                    pending[pick] = (idx, remainder.to_string());
                }
            }

            let calls = fold_stream(&chunks);
            assert_eq!(calls.len(), call_count, "round {round}: lost a call");

            // Replay what the agent loop does to build the next request.
            let internal_ids: Vec<String> = (0..call_count)
                .map(|slot| format!("native_tab_{round}_{slot}"))
                .collect();
            let mut assistant_ids: Vec<String> = Vec::new();
            let mut result_ids: Vec<String> = Vec::new();

            for (slot, call) in calls.iter().enumerate() {
                let (want_id, want_name, want_args, want_signature) = &expected[slot];
                assert_eq!(&call.name, want_name, "round {round} slot {slot}: name");
                assert_eq!(&call.args, want_args, "round {round} slot {slot}: args");
                assert_eq!(
                    call.provider_id.as_deref(),
                    Some(want_id.as_str()),
                    "round {round} slot {slot}: provider id"
                );
                assert_eq!(
                    call.extra_content.as_ref(),
                    want_signature.as_ref(),
                    "round {round} slot {slot}: signature must survive byte-identically"
                );

                let entry = assistant_tool_call_entry(call, &internal_ids[slot]);
                assert_eq!(entry["id"], want_id.as_str());
                match want_signature {
                    Some(signature) => assert_eq!(&entry["extra_content"], signature),
                    None => assert!(
                        entry.get("extra_content").is_none(),
                        "round {round} slot {slot}: invented metadata for a call that had none"
                    ),
                }
                assistant_ids.push(entry["id"].as_str().unwrap().to_string());
                result_ids.push(wire_tool_call_id(call, &internal_ids[slot]));
            }

            assert_eq!(
                assistant_ids, result_ids,
                "round {round}: tool results must pair with their calls"
            );
        }
    }

    /// Degenerate and hostile chunk shapes must not panic, lose a signature, or
    /// fabricate one.
    #[test]
    fn stress_degenerate_tool_call_chunk_shapes() {
        // Missing index (defaults to 0), metadata arriving before the name, an
        // explicit null clearing nothing, and a duplicate id re-sent later.
        let calls = fold_stream(&[
            tool_call_chunk(
                json!({ "extra_content": { "google": { "thought_signature": "S0" } } }),
            ),
            tool_call_chunk(json!({ "index": 0, "id": "dup-id" })),
            tool_call_chunk(json!({ "index": 0, "extra_content": Value::Null })),
            tool_call_chunk(json!({ "index": 0, "function": { "name": "read" } })),
            tool_call_chunk(json!({ "index": 0, "id": "dup-id" })),
            tool_call_chunk(json!({ "index": 0, "function": { "arguments": "{}" } })),
        ]);

        assert_eq!(calls.len(), 1);
        // `read` is canonicalized, the signature survived the null, id is stable.
        assert_eq!(calls[0].name, "Read");
        assert_eq!(calls[0].provider_id.as_deref(), Some("dup-id"));
        assert_eq!(
            calls[0]
                .extra_content
                .as_ref()
                .and_then(|e| e.pointer("/google/thought_signature"))
                .and_then(|v| v.as_str()),
            Some("S0")
        );

        // A sparse high index must not panic or drop the low one.
        let sparse = fold_stream(&[
            tool_call_chunk(json!({
                "index": 3,
                "id": "high",
                "extra_content": { "google": { "thought_signature": "HI" } },
                "function": { "name": "LS", "arguments": "{}" }
            })),
            tool_call_chunk(json!({
                "index": 0,
                "id": "low",
                "function": { "name": "Grep", "arguments": "{\"pattern\":\"x\"}" }
            })),
        ]);
        // Indices 1 and 2 were never named, so they are dropped by the same
        // `retain` the client applies; the named ones survive with their own data.
        let named: Vec<_> = sparse.iter().map(|c| c.provider_id.as_deref()).collect();
        assert!(named.contains(&Some("high")));
        assert!(named.contains(&Some("low")));
        let high = sparse
            .iter()
            .find(|c| c.provider_id.as_deref() == Some("high"))
            .unwrap();
        assert_eq!(
            high.extra_content
                .as_ref()
                .and_then(|e| e.pointer("/google/thought_signature"))
                .and_then(|v| v.as_str()),
            Some("HI")
        );
        let low = sparse
            .iter()
            .find(|c| c.provider_id.as_deref() == Some("low"))
            .unwrap();
        assert!(low.extra_content.is_none());
    }

    #[test]
    fn recognizes_missing_thought_signature_rejections_without_over_matching() {
        // Both the snake_case wire field and the camelCase spelling Google uses in
        // some surfaces.
        assert!(is_missing_thought_signature_error(
            "Function call is missing a thought_signature in functionCall parts."
        ));
        assert!(is_missing_thought_signature_error(
            "function call `default_api:Read` in the 4. content block is missing a `thought_signature`."
        ));
        assert!(is_missing_thought_signature_error(
            "invalid thoughtSignature for part 2"
        ));
        // Unrelated 400s must keep their original, generic message.
        assert!(!is_missing_thought_signature_error(
            "Invalid JSON payload received. Unknown name \"max_tokens\"."
        ));
        assert!(!is_missing_thought_signature_error(
            "tool_call_id did not match any tool call"
        ));
    }

    #[test]
    fn vertex_api_key_auth_error_explains_oauth_requirement() {
        let error = provider_auth_error(
            "https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi",
            "AIza-example",
            "ACCESS_TOKEN_TYPE_UNSUPPORTED",
        );
        assert!(error.contains("Vertex needs an OAuth access token"));
        assert!(error.contains("Gemini (AI Studio)"));
        assert!(error.contains("gcloud"));
    }
}
