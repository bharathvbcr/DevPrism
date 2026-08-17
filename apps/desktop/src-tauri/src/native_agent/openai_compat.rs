//! OpenAI-compatible `/v1/chat/completions` client with streaming tool calling.
//! Used by the native OpenAI-compat backends (Groq, OpenRouter, Gemini, …).

use serde_json::{json, Value};

use super::ollama::{canonicalize_tool_name, ChatTurn, StreamDeltaKind, ToolCall};

const CONTEXT_WINDOW: u32 = 8192;
const DEFAULT_MAX_COMPLETION_TOKENS: u32 = 4096;
const REQUEST_TIMEOUT_SECS: u64 = 600;
const STREAM_IDLE_TIMEOUT_SECS: u64 = 90;
const CONNECT_TIMEOUT_SECS: u64 = 15;

/// Upper bound on distinct tool calls assembled from one streamed turn.
///
/// `index` arrives verbatim from the provider and is used as a `Vec` grow
/// target. Unbounded, a single chunk claiming `"index": 18446744073709551615`
/// pushes elements until the allocator gives up — and Rust *aborts* on
/// allocation failure, so the whole app dies rather than raising a catchable
/// error. Well above any real tool count.
const MAX_TOOL_CALLS_PER_TURN: usize = 64;

/// Largest partial line held while waiting for a newline.
///
/// The framing loop only drains `buf` when it finds `\n`, so a server that
/// streams without newlines grows it without limit. The idle timeout does not
/// help — data *is* arriving — and the 600s deadline is a time bound, not a size
/// one, which on loopback is a very large number of bytes.
const MAX_PENDING_LINE_BYTES: usize = 1024 * 1024;

/// Largest accumulated assistant text (content + reasoning) per turn.
const MAX_STREAM_ACCUMULATION_BYTES: usize = 8 * 1024 * 1024;

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
    // A bare top-level `message` only means "error envelope" when this is *not*
    // a chunk. Gateways and aggregators legitimately attach informational
    // top-level `message` strings (status notes, queue position) alongside
    // `choices`; treating those as fatal aborted a healthy stream mid-generation.
    let has_choices = v.get("choices").and_then(|c| c.as_array()).is_some();
    if let Some(err) = v
        .pointer("/error/message")
        .or_else(|| if has_choices { None } else { v.get("message") })
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
                // Bound before growing: see MAX_TOOL_CALLS_PER_TURN. Skipping the
                // delta is right rather than erroring — a provider that emits a
                // wild index has already produced garbage for that slot, and the
                // rest of the turn may still be usable.
                if idx >= MAX_TOOL_CALLS_PER_TURN {
                    continue;
                }
                while tool_calls.len() <= idx {
                    tool_calls.push(ToolCall {
                        name: String::new(),
                        args: json!({}),
                    });
                }
                while tool_arg_buffers.len() <= idx {
                    tool_arg_buffers.push(String::new());
                }
                if let Some(id_name) = call.pointer("/function/name").and_then(|n| n.as_str()) {
                    tool_calls[idx].name = canonicalize_tool_name(id_name);
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
            let text = super::ollama::read_error_body(resp).await;
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
            if buf.len() > MAX_PENDING_LINE_BYTES {
                return Err(format!(
                    "OpenAI stream error: {} bytes arrived without a line terminator, exceeding the {MAX_PENDING_LINE_BYTES}-byte limit",
                    buf.len()
                ));
            }
            if content.len() + thinking.len() > MAX_STREAM_ACCUMULATION_BYTES {
                return Err(format!(
                    "OpenAI stream error: response exceeded the {MAX_STREAM_ACCUMULATION_BYTES}-byte accumulation limit"
                ));
            }
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
                if line.is_empty() {
                    continue;
                }

                // Server-Sent Events carries more than `data:` lines. Comment
                // heartbeats (`: ping`), `event:`, `id:` and `retry:` fields are
                // all legal and are emitted by common reverse proxies and
                // gateways. The previous code fed every non-empty line to
                // `serde_json` and propagated the failure with `?`, so one
                // keep-alive comment aborted an otherwise healthy turn — and the
                // resulting message matched nothing in `is_retryable_chat_error`,
                // so the outer loop did not even retry it.
                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.trim();

                // Some providers send `data:[DONE]` with no space, which the
                // previous `line == "data: [DONE]"` equality test missed — so the
                // terminator itself was parsed as JSON and failed, discarding a
                // fully generated response at the very last line.
                if payload.is_empty() || payload == "[DONE]" {
                    continue;
                }

                // A malformed payload skips the line rather than killing the
                // turn, matching what the Ollama adapter already does with the
                // same hazard.
                let Ok(v) = serde_json::from_str::<Value>(payload) else {
                    continue;
                };
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

        // Flush a trailing event that arrived without a terminating newline.
        // Without this the last `data:` line of a stream is silently dropped —
        // which is exactly how a tool call's final argument fragment goes
        // missing. The Ollama adapter already does this; this one did not.
        if let Some(payload) = String::from_utf8_lossy(&buf)
            .trim()
            .strip_prefix("data:")
            .map(str::trim)
            .map(str::to_string)
        {
            if !payload.is_empty() && payload != "[DONE]" {
                if let Ok(v) = serde_json::from_str::<Value>(&payload) {
                    let _ = accumulate_openai_stream_line(
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
        }

        // Argument fragments that do not reassemble into valid JSON mean the
        // stream was cut mid-call. Substituting `{"raw": "<partial text>"}` — as
        // this did — hands the dispatcher a fabricated argument object: an
        // `Edit` whose `file_path` simply vanished, reported to the user as the
        // model misbehaving rather than as a truncated response.
        let mut truncated: Vec<String> = Vec::new();
        for (idx, tc) in tool_calls.iter_mut().enumerate() {
            if let Some(buf) = tool_arg_buffers.get(idx).filter(|b| !b.is_empty()) {
                match serde_json::from_str(buf) {
                    Ok(parsed) => tc.args = parsed,
                    Err(_) => truncated.push(if tc.name.is_empty() {
                        format!("#{idx}")
                    } else {
                        tc.name.clone()
                    }),
                }
            }
        }
        if !truncated.is_empty() {
            // Marked retryable: a cut stream is transient, and the outer loop's
            // bounded retry is the right response.
            return Err(format!(
                "OpenAI stream error: [E_BAD_TOOL_ARGS] arguments for {} were truncated and did not parse as JSON",
                truncated.join(", ")
            ));
        }

        tool_calls.retain(|tc| !tc.name.is_empty());

        // A stream that yielded nothing usable is an error, not an empty reply.
        // Returning `Ok` with empty content made a quota-exhausted or
        // 200-then-EOF response look like the model choosing to say nothing, so
        // the loop neither retried nor reported anything. Mirrors the Ollama
        // adapter's `[E_OLLAMA_EMPTY]`.
        if content.is_empty() && thinking.is_empty() && tool_calls.is_empty() {
            return Err(
                "[E_OPENAI_EMPTY] The model returned no content and no tool calls. Check the provider's quota and that the model name is correct."
                    .to_string(),
            );
        }

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
