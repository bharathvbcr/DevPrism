use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Debug)]
pub(crate) struct OpenAiProxyCredential {
    pub(crate) api_key: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
}

pub(crate) async fn start_openai_anthropic_proxy(
    credential: OpenAiProxyCredential,
) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|err| format!("Failed to start local provider proxy: {}", err))?;
    let addr = listener
        .local_addr()
        .map_err(|err| format!("Failed to read local provider proxy address: {}", err))?;
    let credential = Arc::new(credential);

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let credential = Arc::clone(&credential);
            tokio::spawn(async move {
                if let Err(err) = handle_connection(stream, credential).await {
                    eprintln!("[anthropic-proxy] request failed: {}", err);
                }
            });
        }
    });

    Ok(format!("http://{}", addr))
}

async fn handle_connection(
    mut stream: TcpStream,
    credential: Arc<OpenAiProxyCredential>,
) -> Result<(), String> {
    let request = read_http_request(&mut stream).await?;
    let response = route_request(&request, &credential).await;
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|err| format!("Failed to write proxy response: {}", err))?;
    let _ = stream.shutdown().await;
    Ok(())
}

struct HttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

async fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 8192];
    let header_end = loop {
        let n = stream
            .read(&mut temp)
            .await
            .map_err(|err| format!("Failed to read proxy request: {}", err))?;
        if n == 0 {
            return Err("Connection closed before HTTP headers were received".to_string());
        }
        buffer.extend_from_slice(&temp[..n]);
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
        if buffer.len() > 1024 * 1024 {
            return Err("Proxy request headers are too large".to_string());
        }
    };

    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| "Proxy request is missing request line".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "Proxy request is missing method".to_string())?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| "Proxy request is missing path".to_string())?
        .to_string();

    let content_length = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);

    let body_start = header_end + 4;
    let mut body = buffer.get(body_start..).unwrap_or_default().to_vec();
    while body.len() < content_length {
        let n = stream
            .read(&mut temp)
            .await
            .map_err(|err| format!("Failed to read proxy request body: {}", err))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&temp[..n]);
    }
    body.truncate(content_length);

    Ok(HttpRequest { method, path, body })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn route_request(request: &HttpRequest, credential: &OpenAiProxyCredential) -> String {
    let path = request_path_without_query(&request.path);

    if request.method == "GET" && path == "/" {
        return json_response(
            200,
            &json!({ "ok": true, "service": "claude-prism-anthropic-proxy" }),
        );
    }

    if request.method == "POST" && is_count_tokens_path(path) {
        return handle_count_tokens(request);
    }

    if request.method == "POST" && is_messages_path(path) {
        return match handle_messages(request, credential).await {
            Ok(response) => response,
            Err(err) => json_response(
                502,
                &json!({
                    "type": "error",
                    "error": {
                        "type": "api_error",
                        "message": err,
                    },
                }),
            ),
        };
    }

    json_response(
        400,
        &json!({
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": format!("Unsupported Anthropic proxy endpoint: {} {}", request.method, request.path),
            },
        }),
    )
}

fn request_path_without_query(path: &str) -> &str {
    path.split_once('?').map(|(path, _)| path).unwrap_or(path)
}

fn is_count_tokens_path(path: &str) -> bool {
    path.ends_with("/count_tokens")
}

fn is_messages_path(path: &str) -> bool {
    path.ends_with("/messages")
}

fn handle_count_tokens(request: &HttpRequest) -> String {
    let body = serde_json::from_slice::<Value>(&request.body).unwrap_or(Value::Null);
    let approx_chars = body.to_string().chars().count();
    json_response(
        200,
        &json!({
            "input_tokens": (approx_chars / 4).max(1),
        }),
    )
}

async fn handle_messages(
    request: &HttpRequest,
    credential: &OpenAiProxyCredential,
) -> Result<String, String> {
    let anthropic_request: Value = serde_json::from_slice(&request.body)
        .map_err(|err| format!("Claude Code sent invalid Anthropic JSON: {}", err))?;
    let wants_stream = anthropic_request
        .get("stream")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let openai_request = anthropic_to_openai_request(&anthropic_request, credential)?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| format!("Failed to create provider client: {}", err))?;
    let response = client
        .post(openai_chat_completions_url(&credential.base_url))
        .bearer_auth(&credential.api_key)
        .header("Content-Type", "application/json")
        .body(openai_request.to_string())
        .send()
        .await
        .map_err(|err| format!("Provider request failed: {}", err))?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read provider response: {}", err))?;
    if !status.is_success() {
        return Err(format!(
            "Provider returned HTTP {}: {}",
            status,
            compact_error_text(&response_text)
        ));
    }

    let openai_response: Value = serde_json::from_str(&response_text)
        .map_err(|err| format!("Provider returned invalid JSON: {}", err))?;
    let anthropic_response =
        openai_to_anthropic_message(&anthropic_request, &openai_response, credential)?;
    if wants_stream {
        Ok(sse_response(&anthropic_response))
    } else {
        Ok(json_response(200, &anthropic_response))
    }
}

fn anthropic_to_openai_request(
    request: &Value,
    credential: &OpenAiProxyCredential,
) -> Result<Value, String> {
    let mut messages = Vec::new();
    if let Some(system) = request.get("system").and_then(flatten_anthropic_content) {
        if !system.trim().is_empty() {
            messages.push(json!({ "role": "system", "content": system }));
        }
    }

    for message in request
        .get("messages")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Anthropic request is missing messages[]".to_string())?
    {
        append_openai_messages_for_anthropic_message(&mut messages, message);
    }
    let messages = normalize_openai_tool_message_pairs(messages);

    let mut body = json!({
        "model": credential.model,
        "messages": messages,
        "stream": false,
    });
    copy_number_field(request, &mut body, "temperature");
    copy_number_field(request, &mut body, "top_p");
    copy_number_field(request, &mut body, "max_tokens");
    if let Some(stop) = request.get("stop_sequences") {
        body["stop"] = stop.clone();
    }

    if let Some(tools) = request.get("tools").and_then(|value| value.as_array()) {
        let converted = tools
            .iter()
            .filter_map(anthropic_tool_to_openai_tool)
            .collect::<Vec<_>>();
        if !converted.is_empty() {
            body["tools"] = Value::Array(converted);
            body["tool_choice"] = openai_tool_choice(request.get("tool_choice"));
        }
    }

    Ok(body)
}

fn append_openai_messages_for_anthropic_message(messages: &mut Vec<Value>, message: &Value) {
    let role = message
        .get("role")
        .and_then(|value| value.as_str())
        .unwrap_or("user");
    let content = message.get("content").unwrap_or(&Value::Null);

    if role == "assistant" {
        let (text, tool_calls) = assistant_content_to_openai(content);
        let mut openai_message = json!({
            "role": "assistant",
            "content": if text.trim().is_empty() { Value::Null } else { Value::String(text) },
        });
        if !tool_calls.is_empty() {
            openai_message["tool_calls"] = Value::Array(tool_calls);
        }
        messages.push(openai_message);
        return;
    }

    if let Some(blocks) = content.as_array() {
        let text = blocks
            .iter()
            .filter(|block| block.get("type").and_then(|value| value.as_str()) == Some("text"))
            .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
            .collect::<Vec<_>>()
            .join("\n\n");
        if !text.trim().is_empty() {
            messages.push(json!({ "role": role, "content": text }));
        }

        for block in blocks {
            if block.get("type").and_then(|value| value.as_str()) != Some("tool_result") {
                continue;
            }
            let tool_call_id = block
                .get("tool_use_id")
                .and_then(|value| value.as_str())
                .unwrap_or("toolu_unknown");
            let content = flatten_tool_result_content(block.get("content").unwrap_or(&Value::Null));
            messages.push(json!({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": content,
            }));
        }
        return;
    }

    let text = content
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| content.to_string());
    messages.push(json!({ "role": role, "content": text }));
}

fn normalize_openai_tool_message_pairs(messages: Vec<Value>) -> Vec<Value> {
    let mut normalized = Vec::with_capacity(messages.len());
    let mut consumed = vec![false; messages.len()];

    for index in 0..messages.len() {
        if consumed[index] {
            continue;
        }

        let message = &messages[index];
        let tool_call_ids = openai_assistant_tool_call_ids(message);
        if !tool_call_ids.is_empty() {
            consumed[index] = true;
            normalized.push(message.clone());

            for tool_call_id in tool_call_ids {
                if let Some(tool_index) =
                    find_following_tool_message(&messages, &consumed, index + 1, &tool_call_id)
                {
                    consumed[tool_index] = true;
                    normalized.push(messages[tool_index].clone());
                } else {
                    normalized.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": "Tool result unavailable in the prior Claude Code transcript.",
                    }));
                }
            }
            continue;
        }

        consumed[index] = true;
        if openai_message_role(message) == Some("tool") {
            normalized.push(orphan_tool_message_to_user_message(message));
        } else {
            normalized.push(message.clone());
        }
    }

    normalized
}

fn openai_assistant_tool_call_ids(message: &Value) -> Vec<String> {
    if openai_message_role(message) != Some("assistant") {
        return Vec::new();
    }

    message
        .get("tool_calls")
        .and_then(|value| value.as_array())
        .map(|tool_calls| {
            tool_calls
                .iter()
                .filter_map(|tool_call| tool_call.get("id").and_then(|value| value.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn find_following_tool_message(
    messages: &[Value],
    consumed: &[bool],
    start: usize,
    tool_call_id: &str,
) -> Option<usize> {
    for index in start..messages.len() {
        if consumed[index] {
            continue;
        }
        let message = &messages[index];
        if openai_message_role(message) == Some("assistant") {
            break;
        }
        if openai_tool_message_id(message) == Some(tool_call_id) {
            return Some(index);
        }
    }
    None
}

fn orphan_tool_message_to_user_message(message: &Value) -> Value {
    let tool_call_id = openai_tool_message_id(message).unwrap_or("unknown");
    let content = message
        .get("content")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            message
                .get("content")
                .cloned()
                .unwrap_or(Value::Null)
                .to_string()
        });

    json!({
        "role": "user",
        "content": format!("Tool result for {}:\n{}", tool_call_id, content),
    })
}

fn openai_message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(|value| value.as_str())
}

fn openai_tool_message_id(message: &Value) -> Option<&str> {
    if openai_message_role(message) != Some("tool") {
        return None;
    }
    message.get("tool_call_id").and_then(|value| value.as_str())
}

fn flatten_anthropic_content(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }

    value.as_array().map(|blocks| {
        blocks
            .iter()
            .filter_map(|block| {
                block
                    .get("text")
                    .and_then(|value| value.as_str())
                    .or_else(|| block.get("content").and_then(|value| value.as_str()))
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    })
}

fn assistant_content_to_openai(content: &Value) -> (String, Vec<Value>) {
    let Some(blocks) = content.as_array() else {
        return (
            content
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| content.to_string()),
            Vec::new(),
        );
    };

    let mut text = Vec::new();
    let mut tool_calls = Vec::new();
    for block in blocks {
        match block.get("type").and_then(|value| value.as_str()) {
            Some("text") => {
                if let Some(value) = block.get("text").and_then(|value| value.as_str()) {
                    text.push(value);
                }
            }
            Some("tool_use") => {
                let id = block
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("toolu_unknown");
                let name = block
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                tool_calls.push(json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": input.to_string(),
                    },
                }));
            }
            _ => {}
        }
    }

    (text.join("\n\n"), tool_calls)
}

fn flatten_tool_result_content(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(blocks) = content.as_array() {
        return blocks
            .iter()
            .filter_map(|block| {
                block
                    .get("text")
                    .and_then(|value| value.as_str())
                    .or_else(|| block.get("content").and_then(|value| value.as_str()))
            })
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    content.to_string()
}

fn anthropic_tool_to_openai_tool(tool: &Value) -> Option<Value> {
    let name = tool.get("name")?.as_str()?;
    let description = tool
        .get("description")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let parameters = tool
        .get("input_schema")
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));

    Some(json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        },
    }))
}

fn openai_tool_choice(choice: Option<&Value>) -> Value {
    let Some(choice) = choice else {
        return Value::String("auto".to_string());
    };
    match choice.get("type").and_then(|value| value.as_str()) {
        Some("auto") => Value::String("auto".to_string()),
        Some("any") => Value::String("required".to_string()),
        Some("tool") => {
            let name = choice
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            json!({
                "type": "function",
                "function": { "name": name },
            })
        }
        _ => Value::String("auto".to_string()),
    }
}

fn copy_number_field(source: &Value, target: &mut Value, key: &str) {
    if let Some(value) = source.get(key).filter(|value| value.is_number()) {
        target[key] = value.clone();
    }
}

fn openai_to_anthropic_message(
    anthropic_request: &Value,
    openai_response: &Value,
    credential: &OpenAiProxyCredential,
) -> Result<Value, String> {
    let message = openai_response
        .pointer("/choices/0/message")
        .ok_or_else(|| "Provider response is missing choices[0].message".to_string())?;
    let mut content = Vec::new();

    let text = message
        .get("content")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }

    if let Some(reasoning) = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        content.insert(0, json!({ "type": "thinking", "thinking": reasoning }));
    }

    if let Some(tool_calls) = message.get("tool_calls").and_then(|value| value.as_array()) {
        for call in tool_calls {
            let function = call.get("function").unwrap_or(&Value::Null);
            let name = function
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let arguments = function
                .get("arguments")
                .and_then(|value| value.as_str())
                .unwrap_or("{}");
            let input = serde_json::from_str::<Value>(arguments)
                .unwrap_or_else(|_| json!({ "arguments": arguments }));
            let id = call
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("toolu_{}", uuid::Uuid::new_v4().simple()));
            content.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input,
            }));
        }
    }

    if content.is_empty() {
        content.push(json!({ "type": "text", "text": "" }));
    }

    let finish_reason = openai_response
        .pointer("/choices/0/finish_reason")
        .and_then(|value| value.as_str());
    let stop_reason = if content
        .iter()
        .any(|block| block.get("type").and_then(|value| value.as_str()) == Some("tool_use"))
    {
        "tool_use"
    } else {
        match finish_reason {
            Some("length") => "max_tokens",
            Some("tool_calls") => "tool_use",
            _ => "end_turn",
        }
    };

    let usage = openai_response.get("usage").unwrap_or(&Value::Null);
    Ok(json!({
        "id": openai_response
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("msg_{}", uuid::Uuid::new_v4().simple())),
        "type": "message",
        "role": "assistant",
        "model": anthropic_request
            .get("model")
            .and_then(|value| value.as_str())
            .unwrap_or(&credential.model),
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": Value::Null,
        "usage": {
            "input_tokens": usage_token(usage, &["prompt_tokens", "input_tokens", "prompt_token_count"]),
            "output_tokens": usage_token(usage, &["completion_tokens", "output_tokens", "completion_token_count"]),
        },
    }))
}

fn usage_token(usage: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| usage.get(*key).and_then(|value| value.as_u64()))
        .unwrap_or(0)
}

fn sse_response(message: &Value) -> String {
    let content = message
        .get("content")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let input_tokens = message
        .pointer("/usage/input_tokens")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let output_tokens = message
        .pointer("/usage/output_tokens")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);

    let start = json!({
        "type": "message_start",
        "message": {
            "id": message.get("id").cloned().unwrap_or_else(|| json!(format!("msg_{}", uuid::Uuid::new_v4().simple()))),
            "type": "message",
            "role": "assistant",
            "model": message.get("model").cloned().unwrap_or_else(|| json!("claude-prism-proxy")),
            "content": [],
            "stop_reason": Value::Null,
            "stop_sequence": Value::Null,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": 0,
            },
        },
    });

    let mut body = String::new();
    push_sse(&mut body, "message_start", &start);
    for (index, block) in content.iter().enumerate() {
        let block_type = block
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("text");
        match block_type {
            "tool_use" => {
                let content_block = json!({
                    "type": "tool_use",
                    "id": block.get("id").cloned().unwrap_or_else(|| json!(format!("toolu_{}", uuid::Uuid::new_v4().simple()))),
                    "name": block.get("name").cloned().unwrap_or_else(|| json!("unknown")),
                    "input": {},
                });
                push_sse(
                    &mut body,
                    "content_block_start",
                    &json!({
                        "type": "content_block_start",
                        "index": index,
                        "content_block": content_block,
                    }),
                );
                let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                push_sse(
                    &mut body,
                    "content_block_delta",
                    &json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": input.to_string(),
                        },
                    }),
                );
            }
            "thinking" => {
                push_text_like_sse_block(
                    &mut body,
                    index,
                    "thinking",
                    block
                        .get("thinking")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default(),
                );
            }
            _ => {
                push_text_like_sse_block(
                    &mut body,
                    index,
                    "text",
                    block
                        .get("text")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default(),
                );
            }
        }
        push_sse(
            &mut body,
            "content_block_stop",
            &json!({
                "type": "content_block_stop",
                "index": index,
            }),
        );
    }
    push_sse(
        &mut body,
        "message_delta",
        &json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": message.get("stop_reason").cloned().unwrap_or_else(|| json!("end_turn")),
                "stop_sequence": Value::Null,
            },
            "usage": {
                "output_tokens": output_tokens,
            },
        }),
    );
    push_sse(
        &mut body,
        "message_stop",
        &json!({ "type": "message_stop" }),
    );

    http_response(
        200,
        "text/event-stream; charset=utf-8",
        &format!("{}{}", body, "\n"),
    )
}

fn push_text_like_sse_block(body: &mut String, index: usize, block_type: &str, text: &str) {
    push_sse(
        body,
        "content_block_start",
        &json!({
            "type": "content_block_start",
            "index": index,
            "content_block": {
                "type": block_type,
                "text": "",
            },
        }),
    );
    if !text.is_empty() {
        let delta_type = if block_type == "thinking" {
            "thinking_delta"
        } else {
            "text_delta"
        };
        let delta_key = if block_type == "thinking" {
            "thinking"
        } else {
            "text"
        };
        push_sse(
            body,
            "content_block_delta",
            &json!({
                "type": "content_block_delta",
                "index": index,
                "delta": {
                    "type": delta_type,
                    delta_key: text,
                },
            }),
        );
    }
}

fn push_sse(body: &mut String, event: &str, data: &Value) {
    body.push_str("event: ");
    body.push_str(event);
    body.push('\n');
    body.push_str("data: ");
    body.push_str(&data.to_string());
    body.push_str("\n\n");
}

fn openai_chat_completions_url(base_url: &str) -> String {
    let clean = base_url.trim_end_matches('/');
    if clean.ends_with("/chat/completions") {
        clean.to_string()
    } else if openai_compatible_base_url_has_chat_root(clean) {
        format!("{}/chat/completions", clean)
    } else {
        format!("{}/v1/chat/completions", clean)
    }
}

fn openai_compatible_base_url_has_chat_root(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    if lower == "https://api.deepseek.com" || lower == "http://api.deepseek.com" {
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
    matches!(last, "v1" | "v2" | "v3" | "v4" | "beta")
        || path.ends_with("/openai")
        || path.ends_with("compatible-mode/v1")
}

fn json_response(status: u16, value: &Value) -> String {
    http_response(
        status,
        "application/json; charset=utf-8",
        &value.to_string(),
    )
}

fn http_response(status: u16, content_type: &str, body: &str) -> String {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        502 => "Bad Gateway",
        _ => "Internal Server Error",
    };
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        content_type,
        body.as_bytes().len(),
        body
    )
}

fn compact_error_text(text: &str) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= 1000 {
        compact
    } else {
        format!("{}...", compact.chars().take(1000).collect::<String>())
    }
}

#[allow(dead_code)]
fn _assert_local_addr(_: SocketAddr) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_anthropic_messages_paths_with_query_strings() {
        let path = request_path_without_query("/v1/messages?beta=tools");
        assert_eq!(path, "/v1/messages");
        assert!(is_messages_path(path));
        assert!(is_count_tokens_path("/v1/messages/count_tokens"));
    }

    #[test]
    fn converts_tool_use_and_tool_result_messages() {
        let credential = OpenAiProxyCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "qwen-test".to_string(),
        };
        let request = json!({
            "system": "system prompt",
            "messages": [
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Read",
                        "input": { "file_path": "main.tex" }
                    }]
                },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "file text"
                    }]
                }
            ],
            "tools": [{
                "name": "Read",
                "description": "Read a file",
                "input_schema": { "type": "object" }
            }]
        });

        let converted = anthropic_to_openai_request(&request, &credential).unwrap();
        assert_eq!(converted["model"], "qwen-test");
        assert_eq!(converted["messages"][0]["role"], "system");
        assert_eq!(
            converted["messages"][1]["tool_calls"][0]["function"]["name"],
            "Read"
        );
        assert_eq!(converted["messages"][2]["role"], "tool");
        assert_eq!(converted["tools"][0]["function"]["name"], "Read");
    }

    #[test]
    fn keeps_tool_results_immediately_after_tool_calls() {
        let credential = OpenAiProxyCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "qwen-test".to_string(),
        };
        let request = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Read",
                        "input": { "file_path": "main.tex" }
                    }]
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "Now explain it."
                        },
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": "file text"
                        }
                    ]
                }
            ]
        });

        let converted = anthropic_to_openai_request(&request, &credential).unwrap();
        assert_eq!(converted["messages"][0]["role"], "assistant");
        assert_eq!(converted["messages"][1]["role"], "tool");
        assert_eq!(converted["messages"][1]["tool_call_id"], "toolu_1");
        assert_eq!(converted["messages"][2]["role"], "user");
        assert_eq!(converted["messages"][2]["content"], "Now explain it.");
    }

    #[test]
    fn synthesizes_missing_tool_results_before_user_messages() {
        let credential = OpenAiProxyCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "qwen-test".to_string(),
        };
        let request = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_missing",
                        "name": "Read",
                        "input": { "file_path": "main.tex" }
                    }]
                },
                {
                    "role": "user",
                    "content": "continue"
                }
            ]
        });

        let converted = anthropic_to_openai_request(&request, &credential).unwrap();
        assert_eq!(converted["messages"][0]["role"], "assistant");
        assert_eq!(converted["messages"][1]["role"], "tool");
        assert_eq!(converted["messages"][1]["tool_call_id"], "toolu_missing");
        assert_eq!(converted["messages"][2]["role"], "user");
        assert_eq!(converted["messages"][2]["content"], "continue");
    }

    #[test]
    fn converts_openai_tool_call_to_anthropic_message() {
        let credential = OpenAiProxyCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "deepseek-test".to_string(),
        };
        let request = json!({ "model": "claude-sonnet-4" });
        let response = json!({
            "id": "chatcmpl_1",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "Grep",
                            "arguments": "{\"pattern\":\"FastVID\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 3 }
        });

        let converted = openai_to_anthropic_message(&request, &response, &credential).unwrap();
        assert_eq!(converted["stop_reason"], "tool_use");
        assert_eq!(converted["content"][0]["type"], "tool_use");
        assert_eq!(converted["content"][0]["input"]["pattern"], "FastVID");
    }
}
