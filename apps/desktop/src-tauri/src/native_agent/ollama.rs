//! Minimal direct Ollama `/api/chat` client (native tool-calling), with no
//! external CLI and no Anthropic proxy. Uses manual serde_json because the
//! project's `reqwest` is built without the `json` feature.

use serde_json::{json, Value};

/// Context window requested from Ollama (overrides the model's small default so
/// the full system prompt + project context + history + tools are not truncated).
const CONTEXT_WINDOW: u32 = 8192;

pub struct ToolCall {
    pub name: String,
    pub args: Value,
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

/// Query the Ollama server for the first installed model name.
pub async fn first_installed_model(base_url: &str) -> Option<String> {
    let url = format!("{}/api/tags", native_base(base_url));
    let client = reqwest::Client::new();
    let res = client.get(&url).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let text = res.text().await.ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("models")
        .and_then(|m| m.as_array())
        .and_then(|items| {
            items.iter().find_map(|it| {
                it.get("name")
                    .and_then(|n| n.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.to_string())
            })
        })
}

impl OllamaClient {
    pub fn new(base_url: &str, model: &str) -> Self {
        Self {
            base: native_base(base_url),
            model: model.to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// One non-streaming chat round. `messages` is a JSON array; `tools` is a
    /// JSON array of OpenAI-style function schemas (sent only if non-empty).
    pub async fn chat(&self, messages: &Value, tools: &Value) -> Result<ChatTurn, String> {
        let url = format!("{}/api/chat", self.base);
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": false,
            // Ollama defaults /api/chat to a small context window (often 2048),
            // which would silently truncate our system prompt + project context +
            // history + tool schemas. Request a larger window and a low
            // temperature for more deterministic tool use / editing.
            "options": {
                "num_ctx": CONTEXT_WINDOW,
                "temperature": 0.4,
            },
        });
        if tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            body["tools"] = tools.clone();
        }

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
            return Err(format!("Ollama returned HTTP {}: {}", status, snippet));
        }

        let v: Value =
            serde_json::from_str(&text).map_err(|e| format!("Bad Ollama response: {}", e))?;
        let msg = v.get("message").cloned().unwrap_or_else(|| json!({}));
        let content = msg
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();

        let mut tool_calls = Vec::new();
        if let Some(arr) = msg.get("tool_calls").and_then(|t| t.as_array()) {
            for call in arr {
                if let Some(func) = call.get("function") {
                    let name = func
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
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

        let prompt_tokens = v.get("prompt_eval_count").and_then(|n| n.as_u64()).unwrap_or(0);
        let eval_tokens = v.get("eval_count").and_then(|n| n.as_u64()).unwrap_or(0);

        Ok(ChatTurn {
            content,
            tool_calls,
            prompt_tokens,
            eval_tokens,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_url() {
        assert_eq!(native_base("http://localhost:11434/v1"), "http://localhost:11434");
        assert_eq!(native_base("http://localhost:11434/v1/"), "http://localhost:11434");
        assert_eq!(native_base("http://localhost:11434/"), "http://localhost:11434");
        assert_eq!(native_base(""), "http://localhost:11434");
        assert_eq!(native_base("http://host:1/v1"), "http://host:1");
    }
}
