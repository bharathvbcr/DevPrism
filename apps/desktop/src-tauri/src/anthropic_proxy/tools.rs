use serde_json::{json, Value};

pub(super) fn repaired_tool_arguments_value(arguments: &str) -> Value {
    serde_json::from_str::<Value>(&repair_tool_arguments(arguments)).unwrap_or_else(|_| json!({}))
}

pub(super) fn normalized_tool_call_id(id: Option<&str>) -> String {
    let id = id.unwrap_or_default().trim();
    if id.is_empty() || id.chars().all(|ch| ch.is_ascii_digit()) {
        format!("call_{}", uuid::Uuid::new_v4().simple())
    } else {
        id.to_string()
    }
}

pub(super) fn repair_tool_arguments(arguments: &str) -> String {
    let trimmed = trim_code_fence(arguments.trim());
    if trimmed.is_empty() || trimmed == "{}" {
        return "{}".to_string();
    }
    if serde_json::from_str::<Value>(trimmed).is_ok() {
        return trimmed.to_string();
    }

    for candidate in [
        extract_json_like(trimmed),
        repair_balanced_json(trimmed.to_string()),
        repair_single_quoted_json(trimmed),
    ]
    .into_iter()
    .flatten()
    {
        let candidate = remove_trailing_commas(&candidate);
        if let Ok(value) = serde_json::from_str::<Value>(&candidate) {
            return value.to_string();
        }
    }

    "{}".to_string()
}

fn trim_code_fence(value: &str) -> &str {
    let value = value.trim();
    if !value.starts_with("```") {
        return value;
    }
    let Some(first_newline) = value.find('\n') else {
        return value;
    };
    let value = &value[first_newline + 1..];
    value
        .strip_suffix("```")
        .map(str::trim)
        .unwrap_or(value.trim())
}

fn extract_json_like(value: &str) -> Option<String> {
    let object_start = value.find('{');
    let array_start = value.find('[');
    let start = match (object_start, array_start) {
        (Some(object), Some(array)) => object.min(array),
        (Some(object), None) => object,
        (None, Some(array)) => array,
        (None, None) => return None,
    };
    let end = value.rfind('}').or_else(|| value.rfind(']'))?;
    if end <= start {
        return None;
    }
    Some(value[start..=end].to_string())
}

fn repair_balanced_json(value: String) -> Option<String> {
    let mut output = String::with_capacity(value.len() + 8);
    let mut stack = Vec::new();
    let mut in_string = false;
    let mut escaped = false;

    for ch in value.chars() {
        output.push(ch);
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' => {
                if stack.last().copied() == Some(ch) {
                    stack.pop();
                }
            }
            _ => {}
        }
    }

    if in_string {
        output.push('"');
    }
    while let Some(ch) = stack.pop() {
        output.push(ch);
    }
    Some(output)
}

fn repair_single_quoted_json(value: &str) -> Option<String> {
    if value.contains('"') || !value.contains('\'') {
        return None;
    }
    Some(value.replace('\'', "\""))
}

fn remove_trailing_commas(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_string {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            output.push(ch);
            continue;
        }

        if ch == ',' {
            let mut lookahead = chars.clone();
            while matches!(lookahead.peek(), Some(next) if next.is_whitespace()) {
                lookahead.next();
            }
            if matches!(lookahead.peek(), Some('}' | ']')) {
                continue;
            }
        }
        output.push(ch);
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_partial_tool_arguments() {
        assert_eq!(
            repair_tool_arguments("{\"file_path\":\"main.tex\""),
            "{\"file_path\":\"main.tex\"}"
        );
    }

    #[test]
    fn repairs_fenced_tool_arguments() {
        assert_eq!(
            repair_tool_arguments("```json\n{\"pattern\":\"FastVID\",}\n```"),
            "{\"pattern\":\"FastVID\"}"
        );
    }

    #[test]
    fn falls_back_to_empty_object_for_unrepairable_arguments() {
        assert_eq!(repair_tool_arguments("not json at all"), "{}");
    }

    #[test]
    fn normalizes_numeric_tool_call_ids() {
        let id = normalized_tool_call_id(Some("123"));

        assert!(id.starts_with("call_"));
        assert_ne!(id, "123");
    }

    #[test]
    fn preserves_provider_tool_call_ids() {
        assert_eq!(normalized_tool_call_id(Some("call_abc")), "call_abc");
    }
}
