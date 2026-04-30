use crate::agent::providers::{Provider, StreamUpdate};
use crate::agent::{Content, Message, Response, Usage};
use async_trait::async_trait;
use futures::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

pub struct OllamaProvider {
    client: reqwest::Client,
    base_url: String,
    model: String,
}

impl OllamaProvider {
    pub fn new(model: Option<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: "http://localhost:11434".to_string(),
            model: model.unwrap_or_else(|| "llama3".to_string()),
        }
    }

    pub fn with_base_url(mut self, base_url: String) -> Self {
        self.base_url = base_url;
        self
    }
}

pub(crate) fn ollama_chat_url(base_url: &str) -> String {
    format!("{}/api/chat", base_url.trim_end_matches('/'))
}

pub(crate) fn model_likely_supports_tools(model: &str) -> bool {
    let lower = model.to_ascii_lowercase();
    [
        "llama3.1",
        "llama3.2",
        "llama3.3",
        "qwen2.5",
        "qwen3",
        "mistral-nemo",
        "firefunction",
        "command-r",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

pub(crate) fn ollama_tool_capability_message(model: &str) -> Option<String> {
    if model_likely_supports_tools(model) {
        None
    } else {
        Some(format!(
            "Model '{}' may not support Ollama tool calls. Chat will still work, but file/project tools may be ignored unless you select a tool-capable model such as llama3.1, qwen2.5, or command-r.",
            model
        ))
    }
}

#[derive(Serialize)]
struct OllamaRequest {
    model: String,
    messages: Vec<OllamaMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<serde_json::Value>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct OllamaMessage {
    role: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<OllamaToolCall>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct OllamaToolCall {
    function: OllamaFunctionCall,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct OllamaFunctionCall {
    name: String,
    arguments: serde_json::Value,
}

#[derive(Deserialize)]
struct OllamaResponse {
    message: OllamaMessage,
    #[serde(default)]
    prompt_eval_count: u32,
    #[serde(default)]
    eval_count: u32,
}

#[async_trait]
impl Provider for OllamaProvider {
    fn name(&self) -> &str {
        "ollama"
    }

    fn chat_stream(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<serde_json::Value>>,
    ) -> Pin<Box<dyn Stream<Item = Result<StreamUpdate, String>> + Send>> {
        let provider = Self {
            client: self.client.clone(),
            base_url: self.base_url.clone(),
            model: self.model.clone(),
        };

        Box::pin(async_stream::try_stream! {
            let response = provider.chat(messages, tools).await?;
            for block in &response.content {
                match block {
                    Content::Text { text } => yield StreamUpdate::Delta(text.clone()),
                    Content::ToolUse { id, name, input } => {
                        yield StreamUpdate::ToolUse(id.clone(), name.clone(), input.clone());
                    }
                    Content::ToolResult { .. } => {}
                }
            }
            yield StreamUpdate::Complete(response);
        })
    }

    async fn chat(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<serde_json::Value>>,
    ) -> Result<Response, String> {
        let mut ollama_messages = Vec::new();

        for m in messages {
            match m.role.as_str() {
                "assistant" => {
                    let mut text_parts = Vec::new();
                    let mut tool_calls = Vec::new();
                    for c in m.content {
                        match c {
                            Content::Text { text } => text_parts.push(text),
                            Content::ToolUse { name, input, .. } => {
                                tool_calls.push(OllamaToolCall {
                                    function: OllamaFunctionCall {
                                        name,
                                        arguments: input,
                                    },
                                });
                            }
                            _ => {}
                        }
                    }
                    ollama_messages.push(OllamaMessage {
                        role: "assistant".to_string(),
                        content: text_parts.join("\n"),
                        tool_calls: if tool_calls.is_empty() {
                            None
                        } else {
                            Some(tool_calls)
                        },
                    });
                }
                _ => {
                    // Handle user or tool roles
                    let mut text_parts = Vec::new();
                    let mut has_tool_results = false;

                    for c in m.content {
                        match c {
                            Content::Text { text } => text_parts.push(text),
                            Content::ToolResult { content, .. } => {
                                // For Ollama, each tool result should ideally be its own message with role "tool"
                                // But if we are grouped in a Message, we emit it now
                                ollama_messages.push(OllamaMessage {
                                    role: "tool".to_string(),
                                    content,
                                    tool_calls: None,
                                });
                                has_tool_results = true;
                            }
                            _ => {}
                        }
                    }

                    if !text_parts.is_empty() || !has_tool_results {
                        ollama_messages.push(OllamaMessage {
                            role: "user".to_string(),
                            content: text_parts.join("\n"),
                            tool_calls: None,
                        });
                    }
                }
            }
        }

        let ollama_tools = tools.map(|t| {
            t.into_iter()
                .map(|tool_def| {
                    serde_json::json!({
                        "type": "function",
                        "function": tool_def
                    })
                })
                .collect()
        });

        let request = OllamaRequest {
            model: self.model.clone(),
            messages: ollama_messages,
            stream: false,
            tools: ollama_tools,
        };

        let url = ollama_chat_url(&self.base_url);

        let res = self
            .client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        if !res.status().is_success() {
            let status = res.status();
            let err_body = res.text().await.unwrap_or_default();
            return Err(format!("Ollama API error ({}): {}", status, err_body));
        }

        let ollama_res: OllamaResponse = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        let mut content = Vec::new();
        if !ollama_res.message.content.is_empty() {
            content.push(Content::Text {
                text: ollama_res.message.content,
            });
        }

        if let Some(tcs) = ollama_res.message.tool_calls {
            for tc in tcs {
                content.push(Content::ToolUse {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: tc.function.name,
                    input: tc.function.arguments,
                });
            }
        }

        let usage = Some(Usage {
            input_tokens: ollama_res.prompt_eval_count,
            output_tokens: ollama_res.eval_count,
        });

        Ok(Response { content, usage })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_ollama_request_serialization() {
        let message = OllamaMessage {
            role: "assistant".to_string(),
            content: "Thinking...".to_string(),
            tool_calls: Some(vec![OllamaToolCall {
                function: OllamaFunctionCall {
                    name: "test_tool".to_string(),
                    arguments: json!({"arg": "val"}),
                },
            }]),
        };

        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["role"], "assistant");
        assert_eq!(json["content"], "Thinking...");
        assert_eq!(json["tool_calls"][0]["function"]["name"], "test_tool");
        assert_eq!(json["tool_calls"][0]["function"]["arguments"]["arg"], "val");
    }

    #[test]
    fn test_ollama_url_and_tool_capability_mapping() {
        assert_eq!(
            ollama_chat_url("http://localhost:11434/"),
            "http://localhost:11434/api/chat"
        );
        assert!(model_likely_supports_tools("llama3.1:8b"));
        assert!(model_likely_supports_tools("qwen2.5-coder:7b"));
        assert!(ollama_tool_capability_message("llama3").is_some());
    }
}
