use crate::agent::providers::{Provider, StreamUpdate};
use crate::agent::{Content, Message, Response, Usage};
use async_trait::async_trait;
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::env;
use std::pin::Pin;

pub struct GeminiProvider {
    client: reqwest::Client,
    api_key: String,
    model: String,
}

impl GeminiProvider {
    pub fn new(model: Option<String>) -> Result<Self, String> {
        let api_key = env::var("GEMINI_API_KEY")
            .map_err(|_| "GEMINI_API_KEY environment variable not set".to_string())?;
        Self::with_api_key(api_key, model)
    }

    pub fn with_api_key(api_key: String, model: Option<String>) -> Result<Self, String> {
        if api_key.trim().is_empty() {
            return Err(
                "Gemini API key is empty. Add it in Settings or set GEMINI_API_KEY.".to_string(),
            );
        }

        Ok(Self {
            client: reqwest::Client::new(),
            api_key,
            model: model.unwrap_or_else(|| "gemini-1.5-pro".to_string()),
        })
    }
}

pub(crate) fn gemini_role(role: &str) -> &str {
    match role {
        "assistant" => "model",
        _ => "user",
    }
}

pub(crate) fn gemini_generate_url(model: &str, api_key: &str, stream: bool) -> String {
    if stream {
        format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?key={}&alt=sse",
            model, api_key
        )
    } else {
        format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        )
    }
}

#[derive(Serialize)]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<GeminiTool>>,
}

#[derive(Serialize)]
struct GeminiContent {
    role: String,
    parts: Vec<GeminiPart>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum GeminiPart {
    Text(String),
    FunctionCall {
        name: String,
        args: serde_json::Value,
    },
    FunctionResponse {
        name: String,
        response: serde_json::Value,
    },
}

#[derive(Serialize)]
struct GeminiTool {
    function_declarations: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Vec<GeminiCandidate>,
    #[serde(default)]
    usage_metadata: Option<GeminiUsageMetadata>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: GeminiContentResponse,
}

#[derive(Deserialize)]
struct GeminiContentResponse {
    parts: Vec<GeminiPartResponse>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum GeminiPartResponse {
    Text(String),
    FunctionCall {
        name: String,
        args: serde_json::Value,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiUsageMetadata {
    prompt_token_count: u32,
    candidates_token_count: u32,
}

#[async_trait]
impl Provider for GeminiProvider {
    fn name(&self) -> &str {
        "gemini"
    }

    fn chat_stream(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<serde_json::Value>>,
    ) -> Pin<Box<dyn Stream<Item = Result<StreamUpdate, String>> + Send>> {
        let client = self.client.clone();
        let api_key = self.api_key.clone();
        let model = self.model.clone();

        let contents: Vec<GeminiContent> = messages
            .into_iter()
            .map(|m| {
                let role = gemini_role(m.role.as_str());

                let parts = m
                    .content
                    .into_iter()
                    .filter_map(|c| match c {
                        Content::Text { text } => Some(GeminiPart::Text(text)),
                        Content::ToolUse { name, input, .. } => {
                            Some(GeminiPart::FunctionCall { name, args: input })
                        }
                        Content::ToolResult {
                            tool_name, content, ..
                        } => Some(GeminiPart::FunctionResponse {
                            name: tool_name,
                            response: json!({ "result": content }),
                        }),
                    })
                    .collect();

                GeminiContent {
                    role: role.to_string(),
                    parts,
                }
            })
            .collect();

        let gemini_tools = tools.map(|t| {
            vec![GeminiTool {
                function_declarations: t,
            }]
        });

        let request = GeminiRequest {
            contents,
            tools: gemini_tools,
        };

        let url = gemini_generate_url(&model, &api_key, true);

        let stream = async_stream::try_stream! {
            let res = client
                .post(&url)
                .json(&request)
                .send()
                .await
                .map_err(|e| format!("Request failed: {}", e))?;

            if res.status().is_success() {
                let mut body_stream = res.bytes_stream();
                let mut current_response_content = Vec::new();

                while let Some(chunk) = body_stream.next().await {
                    let chunk = chunk.map_err(|e| e.to_string())?;
                    let text = String::from_utf8_lossy(&chunk);

                    for line in text.lines() {
                        if line.starts_with("data: ") {
                            let json_str = &line[6..];
                            let gemini_res: GeminiResponse = serde_json::from_str(json_str)
                                .map_err(|e| format!("Failed to parse stream: {}", e))?;

                            if let Some(candidate) = gemini_res.candidates.first() {
                                for part in &candidate.content.parts {
                                    match part {
                                        GeminiPartResponse::Text(t) => {
                                            current_response_content.push(Content::Text { text: t.clone() });
                                            yield StreamUpdate::Delta(t.clone());
                                        }
                                        GeminiPartResponse::FunctionCall { name, args } => {
                                            let id = uuid::Uuid::new_v4().to_string();
                                            current_response_content.push(Content::ToolUse {
                                                id: id.clone(),
                                                name: name.clone(),
                                                input: args.clone(),
                                            });
                                            yield StreamUpdate::ToolUse(id, name.clone(), args.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                yield StreamUpdate::Complete(Response {
                    content: current_response_content,
                    usage: None,
                });
            } else {
                let status = res.status();
                let err_body = res.text().await.unwrap_or_default();
                Err(format!("Gemini API error ({}): {}", status, err_body))?;
            }
        };

        Box::pin(stream)
    }

    async fn chat(
        &self,
        messages: Vec<Message>,
        tools: Option<Vec<serde_json::Value>>,
    ) -> Result<Response, String> {
        let contents: Vec<GeminiContent> = messages
            .into_iter()
            .map(|m| {
                let role = gemini_role(m.role.as_str());

                let parts = m
                    .content
                    .into_iter()
                    .filter_map(|c| match c {
                        Content::Text { text } => Some(GeminiPart::Text(text)),
                        Content::ToolUse { name, input, .. } => {
                            Some(GeminiPart::FunctionCall { name, args: input })
                        }
                        Content::ToolResult {
                            tool_name, content, ..
                        } => {
                            // Note: Gemini expects FunctionResponse to have a 'name' and 'response' object
                            Some(GeminiPart::FunctionResponse {
                                name: tool_name,
                                response: json!({ "result": content }),
                            })
                        }
                    })
                    .collect();

                GeminiContent {
                    role: role.to_string(),
                    parts,
                }
            })
            .collect();

        let gemini_tools = tools.map(|t| {
            vec![GeminiTool {
                function_declarations: t,
            }]
        });

        let request = GeminiRequest {
            contents,
            tools: gemini_tools,
        };

        let url = gemini_generate_url(&self.model, &self.api_key, false);

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
            return Err(format!("Gemini API error ({}): {}", status, err_body));
        }

        let gemini_res: GeminiResponse = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        let candidate = gemini_res
            .candidates
            .first()
            .ok_or_else(|| "No candidates returned from Gemini".to_string())?;

        let content = candidate
            .content
            .parts
            .iter()
            .map(|p| match p {
                GeminiPartResponse::Text(t) => Content::Text { text: t.clone() },
                GeminiPartResponse::FunctionCall { name, args } => Content::ToolUse {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: name.clone(),
                    input: args.clone(),
                },
            })
            .collect();

        let usage = gemini_res.usage_metadata.map(|u| Usage {
            input_tokens: u.prompt_token_count,
            output_tokens: u.candidates_token_count,
        });

        Ok(Response { content, usage })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gemini_request_serialization() {
        let gemini_content = GeminiContent {
            role: "user".to_string(),
            parts: vec![
                GeminiPart::Text("Hello".to_string()),
                GeminiPart::FunctionCall {
                    name: "test_tool".to_string(),
                    args: json!({"arg": "val"}),
                },
                GeminiPart::FunctionResponse {
                    name: "test_tool".to_string(),
                    response: json!({"result": "result"}),
                },
            ],
        };

        let json = serde_json::to_value(&gemini_content).unwrap();
        assert_eq!(json["role"], "user");
        assert_eq!(json["parts"][0]["text"], "Hello");
        assert_eq!(json["parts"][1]["functionCall"]["name"], "test_tool");
        assert_eq!(json["parts"][2]["functionResponse"]["name"], "test_tool");
    }

    #[test]
    fn test_gemini_role_mapping_and_urls() {
        assert_eq!(gemini_role("assistant"), "model");
        assert_eq!(gemini_role("user"), "user");
        assert!(gemini_generate_url("gemini-1.5-pro", "key", false)
            .contains("models/gemini-1.5-pro:generateContent?key=key"));
        assert!(gemini_generate_url("gemini-1.5-pro", "key", true).ends_with("&alt=sse"));
    }
}
