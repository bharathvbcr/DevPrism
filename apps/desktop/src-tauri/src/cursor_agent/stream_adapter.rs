//! Map Cursor CLI stream-json events to Claude-shaped NDJSON for the chat UI.

use serde_json::{json, Value};

/// Adapt one Cursor stream-json line to Claude NDJSON, or None to skip.
pub fn adapt_cursor_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(trimmed).ok()?;
    let msg_type = v.get("type").and_then(|t| t.as_str())?;

    match msg_type {
        "system" => Some(trimmed.to_string()),
        "assistant" => adapt_assistant(&v),
        "tool_call" => adapt_tool_call(&v),
        "tool_result" => adapt_tool_result(&v),
        "result" => Some(trimmed.to_string()),
        "error" => Some(
            json!({
                "type": "result",
                "subtype": "error",
                "is_error": true,
                "result": v.get("message").and_then(|m| m.as_str()).unwrap_or("Cursor error"),
            })
            .to_string(),
        ),
        _ => None,
    }
}

fn adapt_assistant(v: &Value) -> Option<String> {
    let text = v
        .pointer("/message/content")
        .and_then(|c| c.as_str())
        .or_else(|| v.get("text").and_then(|t| t.as_str()))
        .or_else(|| v.get("content").and_then(|c| c.as_str()))
        .unwrap_or("");
    if text.is_empty() {
        return None;
    }
    Some(
        json!({
            "type": "assistant",
            "message": {
                "content": [{ "type": "text", "text": text }]
            }
        })
        .to_string(),
    )
}

fn adapt_tool_call(v: &Value) -> Option<String> {
    let tool_name = v
        .get("tool")
        .or_else(|| v.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("Tool");
    let tool_id = v
        .get("id")
        .or_else(|| v.get("call_id"))
        .and_then(|id| id.as_str())
        .unwrap_or("cursor_tool");
    let input = v
        .get("input")
        .or_else(|| v.get("arguments"))
        .cloned()
        .unwrap_or(json!({}));
    Some(
        json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": tool_id,
                    "name": map_cursor_tool_name(tool_name),
                    "input": input,
                }]
            }
        })
        .to_string(),
    )
}

fn adapt_tool_result(v: &Value) -> Option<String> {
    let tool_id = v
        .get("tool_use_id")
        .or_else(|| v.get("call_id"))
        .and_then(|id| id.as_str())
        .unwrap_or("cursor_tool");
    let content = v
        .get("output")
        .or_else(|| v.get("content"))
        .or_else(|| v.get("result"))
        .map(|c| {
            if c.is_string() {
                c.clone()
            } else {
                json!(c.to_string())
            }
        })
        .unwrap_or(json!(""));
    Some(
        json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": content,
                }]
            }
        })
        .to_string(),
    )
}

fn map_cursor_tool_name(raw: &str) -> String {
    match raw.to_lowercase().as_str() {
        "writetoolcall" | "write" => "Write".to_string(),
        "readtoolcall" | "read" => "Read".to_string(),
        "edittoolcall" | "edit" => "Edit".to_string(),
        "bash" | "bashtoolcall" => "Bash".to_string(),
        "grep" | "greptoolcall" => "Grep".to_string(),
        other => {
            if other.is_empty() {
                "Tool".to_string()
            } else {
                other.to_string()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapts_assistant_text_delta() {
        let line = r#"{"type":"assistant","text":"Hello"}"#;
        let out = adapt_cursor_line(line).expect("adapted");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["type"], "assistant");
        assert_eq!(v["message"]["content"][0]["text"], "Hello");
    }

    #[test]
    fn adapts_tool_call_to_tool_use() {
        let line =
            r#"{"type":"tool_call","id":"tc1","tool":"writeToolCall","input":{"path":"main.tex"}}"#;
        let out = adapt_cursor_line(line).expect("adapted");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["message"]["content"][0]["type"], "tool_use");
        assert_eq!(v["message"]["content"][0]["name"], "Write");
    }

    #[test]
    fn adapts_tool_result() {
        let line = r#"{"type":"tool_result","tool_use_id":"tc1","output":"ok"}"#;
        let out = adapt_cursor_line(line).expect("adapted");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["content"][0]["type"], "tool_result");
    }

    #[test]
    fn passes_through_system_init() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc"}"#;
        let out = adapt_cursor_line(line).expect("adapted");
        assert!(out.contains("session_id"));
    }
}
