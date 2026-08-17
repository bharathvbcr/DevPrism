//! Model Context Protocol (MCP 2.0) Stateless Specification (2026-07-28).
//!
//! Features:
//! - Stateless Core (SEP-2575): No handshake (`initialize`), no session ID (`Mcp-Session-Id`).
//! - Inline `_meta` parameter containing protocolVersion, clientInfo, clientCapabilities.
//! - HTTP Standardization (SEP-2243): `Mcp-Protocol-Version`, `Mcp-Method`, `Mcp-Name` headers.
//! - Intelligent Caching (SEP-2549): `ttlMs` and `cacheScope` in responses.
//! - Multi Round-Trip Requests (MRTR / SEP-2322): Stateless elicitations via `InputRequiredResult` & `requestState`.
//! - Tasks Extension (SEP-2663): Async execution tracking via `taskId`.
//! - Standard Error Codes: Header Mismatch (`-32020`), Task Error (`-32001`), Elicitation Error (`-32002`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub const MCP_PROTOCOL_VERSION: &str = "2026-07-28";
pub const MCP_HEADER_PROTOCOL_VERSION: &str = "mcp-protocol-version";
pub const MCP_HEADER_METHOD: &str = "mcp-method";
pub const MCP_HEADER_NAME: &str = "mcp-name";

// --- Standard JSON-RPC & MCP Error Codes ---
pub const ERR_HEADER_MISMATCH: i64 = -32020;
pub const ERR_TASK_FAILED: i64 = -32001;
pub const ERR_ELICITATION_FAILED: i64 = -32002;
pub const ERR_PARSE_ERROR: i64 = -32700;
pub const ERR_INVALID_REQUEST: i64 = -32600;
pub const ERR_METHOD_NOT_FOUND: i64 = -32601;
pub const ERR_INVALID_PARAMS: i64 = -32602;
pub const ERR_INTERNAL_ERROR: i64 = -32603;

/// Inline metadata sent on every request under `params._meta`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestMeta {
    #[serde(rename = "io.modelcontextprotocol/protocolVersion", default)]
    pub protocol_version: Option<String>,
    #[serde(rename = "io.modelcontextprotocol/clientCapabilities", default)]
    pub client_capabilities: Option<Value>,
    #[serde(rename = "io.modelcontextprotocol/clientInfo", default)]
    pub client_info: Option<ClientInfo>,
    #[serde(default)]
    pub progress_token: Option<Value>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub version: Option<String>,
}

/// Response metadata containing caching hints and extra context.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_scope: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// A standard JSON-RPC 2.0 Request in Stateless MCP 2.0.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

impl JsonRpcRequest {
    pub fn new(id: Option<Value>, method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.into(),
            params,
        }
    }

    /// Extract `_meta` inline object from params if present.
    pub fn extract_meta(&self) -> Option<RequestMeta> {
        let params = self.params.as_ref()?;
        let meta_val = params.get("_meta")?;
        serde_json::from_value(meta_val.clone()).ok()
    }

    /// Extract the tool/resource/prompt name from params if present.
    pub fn extract_name(&self) -> Option<String> {
        let params = self.params.as_ref()?;
        params
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| {
                params
                    .get("uri")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
    }
}

/// Standard JSON-RPC 2.0 Error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(code: i64, message: impl Into<String>, data: Value) -> Self {
        Self {
            code,
            message: message.into(),
            data: Some(data),
        }
    }

    pub fn header_mismatch(detail: impl Into<String>) -> Self {
        Self::new(ERR_HEADER_MISMATCH, detail)
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(
            ERR_METHOD_NOT_FOUND,
            format!("Method not found: '{method}'"),
        )
    }

    pub fn invalid_params(detail: impl Into<String>) -> Self {
        Self::new(ERR_INVALID_PARAMS, detail)
    }

    pub fn internal_error(detail: impl Into<String>) -> Self {
        Self::new(ERR_INTERNAL_ERROR, detail)
    }
}

/// A standard JSON-RPC 2.0 Response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

impl JsonRpcResponse {
    pub fn success(id: Option<Value>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<Value>, error: JsonRpcError) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(error),
        }
    }
}

// --- SEP-2243 HTTP Header Validation ---

#[derive(Debug, Clone, Default)]
pub struct HttpHeaders {
    pub protocol_version: Option<String>,
    pub method: Option<String>,
    pub name: Option<String>,
}

impl HttpHeaders {
    pub fn from_map(headers: &HashMap<String, String>) -> Self {
        let mut out = Self::default();
        for (k, v) in headers {
            let lower = k.to_ascii_lowercase();
            if lower == MCP_HEADER_PROTOCOL_VERSION {
                out.protocol_version = Some(v.trim().to_string());
            } else if lower == MCP_HEADER_METHOD {
                out.method = Some(v.trim().to_string());
            } else if lower == MCP_HEADER_NAME {
                out.name = Some(v.trim().to_string());
            }
        }
        out
    }

    /// Validates standard HTTP headers against the incoming JSON-RPC request body.
    /// Rejects mismatches with JSON-RPC error `-32020`.
    pub fn validate_against_request(&self, req: &JsonRpcRequest) -> Result<(), JsonRpcError> {
        // 1. Validate Mcp-Method header if supplied
        if let Some(ref header_method) = self.method {
            if header_method != &req.method {
                return Err(JsonRpcError::header_mismatch(format!(
                    "Header '{MCP_HEADER_METHOD}: {header_method}' does not match body method '{body_method}'",
                    body_method = req.method
                )));
            }
        }

        // 2. Validate Mcp-Name header if supplied
        if let Some(ref header_name) = self.name {
            if let Some(body_name) = req.extract_name() {
                if header_name != &body_name {
                    return Err(JsonRpcError::header_mismatch(format!(
                        "Header '{MCP_HEADER_NAME}: {header_name}' does not match body name/uri '{body_name}'"
                    )));
                }
            }
        }

        Ok(())
    }
}

// --- SEP-2322 Multi Round-Trip Requests (MRTR) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRequest {
    #[serde(rename = "type")]
    pub kind: String, // "elicitation" | "confirmation" | "selection"
    pub message: String,
    #[serde(default)]
    pub schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRequiredResult {
    pub result_type: String, // always "inputRequired"
    pub input_requests: HashMap<String, InputRequest>,
    pub request_state: String, // self-contained serialized/base64 state
}

/// Process-lifetime key used to tag `requestState` payloads.
///
/// `requestState` is the ONLY thing standing between a caller and a destructive
/// action that is supposed to require human confirmation. It used to be plain
/// base64 JSON, so a client could mint its own "already confirmed" state and
/// skip elicitation entirely. The tag below makes a forged state detectable.
///
/// This is an integrity tag, not a cryptographic signature for third parties:
/// the key never leaves the process and dies with it, which also means states
/// do not survive a restart. That is the correct lifetime for a confirmation.
fn request_state_key() -> &'static [u8; 32] {
    use std::sync::OnceLock;
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    KEY.get_or_init(|| {
        let mut k = [0u8; 32];
        k[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        k[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        k
    })
}

fn state_tag(payload: &[u8]) -> String {
    use base64::prelude::*;
    use hmac::{Hmac, Mac};
    use sha1::Sha1;
    let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(request_state_key()) else {
        return String::new();
    };
    mac.update(payload);
    BASE64_STANDARD.encode(mac.finalize().into_bytes())
}

/// Constant-time comparison so a caller cannot probe the tag byte by byte.
fn tags_match(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl InputRequiredResult {
    pub fn new(
        input_requests: HashMap<String, InputRequest>,
        state_payload: &Value,
    ) -> Result<Self, String> {
        use base64::prelude::*;
        let serialized = serde_json::to_string(state_payload)
            .map_err(|e| format!("Failed to serialize requestState: {e}"))?;
        let body = BASE64_STANDARD.encode(serialized.as_bytes());
        let tag = state_tag(body.as_bytes());
        if tag.is_empty() {
            return Err("Failed to tag requestState".to_string());
        }
        Ok(Self {
            result_type: "inputRequired".to_string(),
            input_requests,
            // `body.tag`: '.' cannot appear in standard base64, so the split is
            // unambiguous.
            request_state: format!("{body}.{tag}"),
        })
    }

    pub fn decode_state(request_state: &str) -> Result<Value, String> {
        use base64::prelude::*;
        let raw = request_state.trim();
        let (body, tag) = raw.split_once('.').ok_or_else(|| {
            "requestState is not integrity-tagged; re-run the request to obtain a fresh one"
                .to_string()
        })?;
        if !tags_match(tag, &state_tag(body.as_bytes())) {
            return Err(
                "requestState failed its integrity check; it was modified, forged, or issued by a                  previous run of this server. Re-run the request to obtain a fresh confirmation."
                    .to_string(),
            );
        }
        let decoded_bytes = BASE64_STANDARD
            .decode(body)
            .map_err(|e| format!("Invalid base64 in requestState: {e}"))?;
        let val: Value = serde_json::from_slice(&decoded_bytes)
            .map_err(|e| format!("Invalid JSON in requestState: {e}"))?;
        Ok(val)
    }
}

#[cfg(test)]
mod request_state_tests {
    use super::*;
    use serde_json::json;

    fn state(payload: &Value) -> String {
        InputRequiredResult::new(HashMap::new(), payload)
            .map(|r| r.request_state)
            .unwrap_or_default()
    }

    #[test]
    fn a_tagged_state_round_trips() {
        let s = state(&json!({ "blockId": "blk-1" }));
        let back = InputRequiredResult::decode_state(&s).unwrap_or(Value::Null);
        assert_eq!(back["blockId"], "blk-1");
    }

    /// The attack this closes: mint a state that was never issued.
    #[test]
    fn a_forged_state_is_rejected() {
        use base64::prelude::*;
        let forged = BASE64_STANDARD.encode(br#"{"blockId":"blk-victim"}"#);
        assert!(InputRequiredResult::decode_state(&forged).is_err(), "untagged state accepted");
        let forged_with_tag = format!("{forged}.{}", BASE64_STANDARD.encode(b"not-the-tag"));
        assert!(
            InputRequiredResult::decode_state(&forged_with_tag).is_err(),
            "bad tag accepted"
        );
    }

    #[test]
    fn a_tampered_payload_is_rejected() {
        use base64::prelude::*;
        let s = state(&json!({ "blockId": "blk-1" }));
        let (_, tag) = s.split_once('.').unwrap_or(("", ""));
        let swapped = BASE64_STANDARD.encode(br#"{"blockId":"blk-2"}"#);
        assert!(
            InputRequiredResult::decode_state(&format!("{swapped}.{tag}")).is_err(),
            "payload swap under a valid tag accepted"
        );
    }

    #[test]
    fn malformed_states_do_not_panic() {
        for bad in ["", ".", "a.", ".b", "not base64!.tag", "&&&.&&&"] {
            assert!(InputRequiredResult::decode_state(bad).is_err(), "accepted {bad:?}");
        }
    }
}

// --- Tool & Resource Declarations ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _meta: Option<ResponseMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDefinition {
    pub uri: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _meta: Option<ResponseMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptArgument {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDefinition {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub arguments: Vec<PromptArgument>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _meta: Option<ResponseMeta>,
}
