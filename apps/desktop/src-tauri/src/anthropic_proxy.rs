mod messages;
mod providers;
mod stream;
mod tools;
mod transformers;

use self::messages::{anthropic_to_openai_request, openai_to_anthropic_message};
use self::providers::apply_provider_request_transforms;
use self::stream::{sse_response, stream_openai_sse_to_anthropic};
use self::transformers::ProxyTransformerChain;
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
    pub(crate) transformers: Vec<String>,
    pub(crate) model_transformers: Vec<String>,
    /// Per-session secret the local CLI must present (as `x-api-key` or a Bearer
    /// token). The loopback listener is otherwise open to any local process, so
    /// without this any program could spend the user's credits / read prompts.
    pub(crate) auth_token: String,
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

/// Monotonic per-request id so a "Claude Code randomly errored" report can be
/// correlated with a specific proxy request in the logs.
static PROXY_REQUEST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

async fn handle_connection(
    mut stream: TcpStream,
    credential: Arc<OpenAiProxyCredential>,
) -> Result<(), String> {
    let request_id = PROXY_REQUEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let started = std::time::Instant::now();
    let request = read_http_request(&mut stream).await?;
    let path = request_path_without_query(&request.path);
    if request.method == "POST" && is_messages_path(path) {
        match handle_messages_to_stream(&request, &credential, &mut stream).await {
            Ok(()) => {
                eprintln!(
                    "[anthropic-proxy] req#{request_id} ok: model={} elapsed_ms={}",
                    credential.model,
                    started.elapsed().as_millis()
                );
                let _ = stream.shutdown().await;
                return Ok(());
            }
            Err(err) => {
                eprintln!(
                    "[anthropic-proxy] req#{request_id} failed: model={} elapsed_ms={} err={err}",
                    credential.model,
                    started.elapsed().as_millis()
                );
                let response = json_response(
                    502,
                    &json!({
                        "type": "error",
                        "error": {
                            "type": "api_error",
                            "message": err,
                        },
                    }),
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .map_err(|err| format!("Failed to write proxy error response: {}", err))?;
                let _ = stream.shutdown().await;
                return Ok(());
            }
        }
    }

    let response = route_request(&request).await;
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
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// The token the caller presented: `x-api-key`, or the bearer part of an
/// `Authorization` header (Claude Code sends `ANTHROPIC_API_KEY` as `x-api-key`).
fn presented_proxy_token(request: &HttpRequest) -> Option<String> {
    if let Some(key) = request.header("x-api-key") {
        return Some(key.to_string());
    }
    request.header("authorization").and_then(|value| {
        value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .map(|token| token.to_string())
    })
}

/// Constant-time string comparison so a wrong-token 401 doesn't leak, via timing,
/// how much of the per-session secret was guessed.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
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

    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect();
    let content_length = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);

    // Cap the declared body size so a crafted `Content-Length` can't drive the
    // read loop into unbounded memory. 64 MiB is far above any real Claude Code
    // request (large context + tool schemas are a few MiB at most).
    const MAX_PROXY_BODY_BYTES: usize = 64 * 1024 * 1024;
    if content_length > MAX_PROXY_BODY_BYTES {
        return Err(format!(
            "Proxy request body too large: {content_length} bytes (limit {MAX_PROXY_BODY_BYTES})"
        ));
    }

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

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn route_request(request: &HttpRequest) -> String {
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

async fn handle_messages_to_stream(
    request: &HttpRequest,
    credential: &OpenAiProxyCredential,
    stream: &mut TcpStream,
) -> Result<(), String> {
    // Authenticate the inbound request against the per-session token before doing
    // anything with the real upstream key. The listener is loopback-only, but any
    // local process could otherwise use it to spend the user's credits or read
    // prompts. (Empty token = auth disabled — used only by unit-test fixtures;
    // the real spawn path always sets a fresh UUID.)
    if !credential.auth_token.is_empty() {
        let presented = presented_proxy_token(request).unwrap_or_default();
        if !constant_time_eq(&presented, &credential.auth_token) {
            let resp = provider_error_response(
                401,
                "authentication_error",
                "Local proxy authentication failed.",
                None,
            );
            stream
                .write_all(resp.as_bytes())
                .await
                .map_err(|err| format!("Failed to write proxy auth error: {}", err))?;
            return Ok(());
        }
    }

    let anthropic_request: Value = serde_json::from_slice(&request.body)
        .map_err(|err| format!("Claude Code sent invalid Anthropic JSON: {}", err))?;
    let wants_stream = anthropic_request
        .get("stream")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let transformers = ProxyTransformerChain::for_credential(credential, wants_stream);
    let mut openai_request =
        anthropic_to_openai_request(&anthropic_request, credential, &transformers)?;
    openai_request["stream"] = Value::Bool(wants_stream);
    apply_provider_request_transforms(
        &mut openai_request,
        &anthropic_request,
        credential,
        wants_stream,
        &transformers,
    );
    if request_contains_openai_image_parts(&openai_request)
        && provider_rejects_openai_image_parts(credential)
    {
        return Err(format!(
            "{} does not accept OpenAI-style image_url message parts. Switch to Claude Code or a vision-capable OpenAI-compatible endpoint for image questions.",
            credential.model
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| format!("Failed to create provider client: {}", err))?;
    let url = openai_chat_completions_url(&credential.base_url);
    let body = openai_request.to_string();
    // Retry transient 429/5xx (honoring Retry-After) and connect errors before we
    // begin streaming — safe because the response body isn't consumed until then.
    let response = crate::retry::send_with_retry(3, || {
        with_optional_bearer_auth(
            client
                .post(&url)
                .header("Content-Type", "application/json")
                .body(body.clone()),
            &credential.api_key,
        )
    })
    .await
    .map_err(|err| format!("Provider request failed: {}", err))?;

    let status = response.status();
    if !status.is_success() {
        // Capture Retry-After before consuming the body.
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(|s| s.to_string());
        let response_text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read provider error response: {}", err))?;
        // Map to the real Anthropic status/type (and forward Retry-After) so the
        // client's retry/backoff works, instead of collapsing to a generic 502.
        // The error occurs before any stream headers are written, so a plain JSON
        // error response is correct even for a streaming request.
        let (code, err_type) = map_provider_error_status(status.as_u16());
        let message = format!(
            "Provider returned HTTP {}: {}",
            status,
            compact_error_text(&response_text)
        );
        let resp = provider_error_response(code, err_type, &message, retry_after.as_deref());
        stream
            .write_all(resp.as_bytes())
            .await
            .map_err(|err| format!("Failed to write provider error response: {}", err))?;
        return Ok(());
    }

    if wants_stream {
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if content_type.contains("stream") {
            stream_openai_sse_to_anthropic(stream, response, &anthropic_request, credential).await
        } else {
            let response_text = response
                .text()
                .await
                .map_err(|err| format!("Failed to read provider response: {}", err))?;
            let openai_response: Value = serde_json::from_str(&response_text)
                .map_err(|err| format!("Provider returned invalid JSON: {}", err))?;
            let anthropic_response =
                openai_to_anthropic_message(&anthropic_request, &openai_response, credential)?;
            stream
                .write_all(sse_response(&anthropic_response).as_bytes())
                .await
                .map_err(|err| format!("Failed to write proxy SSE response: {}", err))
        }
    } else {
        let response_text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read provider response: {}", err))?;
        let openai_response: Value = serde_json::from_str(&response_text)
            .map_err(|err| format!("Provider returned invalid JSON: {}", err))?;
        let anthropic_response =
            openai_to_anthropic_message(&anthropic_request, &openai_response, credential)?;
        stream
            .write_all(json_response(200, &anthropic_response).as_bytes())
            .await
            .map_err(|err| format!("Failed to write proxy JSON response: {}", err))
    }
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

fn with_optional_bearer_auth(
    request: reqwest::RequestBuilder,
    api_key: &str,
) -> reqwest::RequestBuilder {
    if api_key.trim().is_empty() {
        request
    } else {
        request.bearer_auth(api_key)
    }
}

fn request_contains_openai_image_parts(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(request_contains_openai_image_parts),
        Value::Object(object) => {
            object.get("type").and_then(Value::as_str) == Some("image_url")
                || object.values().any(request_contains_openai_image_parts)
        }
        _ => false,
    }
}

fn provider_rejects_openai_image_parts(credential: &OpenAiProxyCredential) -> bool {
    let base_url = credential.base_url.to_ascii_lowercase();
    base_url == "https://api.deepseek.com" || base_url.starts_with("https://api.deepseek.com/")
}

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

fn http_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        529 => "Site Overloaded",
        _ => "Internal Server Error",
    }
}

fn http_response(status: u16, content_type: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        http_reason(status),
        content_type,
        body.as_bytes().len(),
        body
    )
}

/// Map an upstream provider HTTP status to the Anthropic status + error `type`
/// Claude Code expects, so its status-driven retry/backoff works (it retries
/// 429/5xx, backs off on 429, and does NOT retry 400/401) instead of every
/// upstream error collapsing to a generic 502.
fn map_provider_error_status(upstream: u16) -> (u16, &'static str) {
    match upstream {
        400 => (400, "invalid_request_error"),
        401 => (401, "authentication_error"),
        403 => (403, "permission_error"),
        404 => (404, "not_found_error"),
        413 => (413, "request_too_large"),
        429 => (429, "rate_limit_error"),
        529 => (529, "overloaded_error"),
        500..=599 => (upstream, "api_error"),
        _ => (502, "api_error"),
    }
}

/// Build an Anthropic-shaped error response with the mapped status and an
/// optional `Retry-After` forwarded from the upstream (so the client backs off
/// for the interval the provider asked for).
fn provider_error_response(
    status: u16,
    err_type: &str,
    message: &str,
    retry_after: Option<&str>,
) -> String {
    let body = json!({
        "type": "error",
        "error": { "type": err_type, "message": message },
    })
    .to_string();
    let retry = retry_after
        .map(|ra| format!("Retry-After: {ra}\r\n"))
        .unwrap_or_default();
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}",
        status,
        http_reason(status),
        body.as_bytes().len(),
        retry,
        body
    )
}

/// Best-effort redaction of credentials a misbehaving upstream might echo back
/// into an error body: `Authorization: Bearer <token>` values and `sk-…`/`sk_…`
/// style API keys. Not a security boundary on its own — defense in depth so a
/// 4xx body can't leak the key into logs, the transcript, or the SSE error frame.
fn redact_secrets(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let is_tok = |c: u8| c.is_ascii_alphanumeric() || c == b'-' || c == b'_';
    let mut i = 0;
    while i < bytes.len() {
        let rest = &text[i..];
        // `sk-…` / `sk_…` keys with a real-looking tail (>= 8 token chars).
        let is_sk = rest
            .get(..3)
            .map(|h| {
                let b = h.as_bytes();
                b[0].eq_ignore_ascii_case(&b's')
                    && b[1].eq_ignore_ascii_case(&b'k')
                    && (b[2] == b'-' || b[2] == b'_')
            })
            .unwrap_or(false);
        if is_sk {
            let mut j = 3;
            while i + j < bytes.len() && is_tok(bytes[i + j]) {
                j += 1;
            }
            if j - 3 >= 8 {
                out.push_str("sk-***");
                i += j;
                continue;
            }
        }
        // `Bearer <token>` (case-insensitive marker, original case preserved).
        if rest
            .get(..7)
            .map(|h| h.eq_ignore_ascii_case("bearer "))
            .unwrap_or(false)
        {
            let start = i + 7;
            let mut k = start;
            while k < bytes.len() && is_tok(bytes[k]) {
                k += 1;
            }
            if k > start {
                out.push_str(&text[i..start]);
                out.push_str("***");
                i = k;
                continue;
            }
        }
        let ch = rest.chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn compact_error_text(text: &str) -> String {
    let redacted = redact_secrets(text);
    let compact = redacted.split_whitespace().collect::<Vec<_>>().join(" ");
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
    use super::transformers::ProxyTransformerChain;
    use super::*;

    #[test]
    fn recognizes_anthropic_messages_paths_with_query_strings() {
        let path = request_path_without_query("/v1/messages?beta=tools");
        assert_eq!(path, "/v1/messages");
        assert!(is_messages_path(path));
        assert!(is_count_tokens_path("/v1/messages/count_tokens"));
    }

    #[test]
    fn redacts_api_keys_from_error_text() {
        // Build fake key shapes at runtime so secret scanners don't flag literals.
        let ant_key = format!("{}-{}-{}", "sk", "ant", "fakeTestKey0001");
        assert_eq!(
            redact_secrets(&format!("bad key {ant_key} rejected")),
            "bad key sk-*** rejected"
        );
        let bearer_msg = format!(
            "sent Authorization: {} {} upstream",
            "Bearer",
            format!("{}-{}", "sk", "fakeProjKey9999"),
        );
        assert_eq!(
            redact_secrets(&bearer_msg),
            "sent Authorization: Bearer *** upstream"
        );
    }

    #[test]
    fn redaction_leaves_ordinary_text_and_short_tokens_intact() {
        // "sk-" with too short a tail is not a key; unicode is preserved.
        assert_eq!(redact_secrets("use sk-1 flag — café ☕"), "use sk-1 flag — café ☕");
        assert_eq!(redact_secrets("no secrets here"), "no secrets here");
    }

    #[test]
    fn compact_error_text_redacts_before_truncating() {
        let msg = format!(
            "upstream said {} {} was invalid",
            "Bearer",
            format!("{}-{}-{}", "sk", "ant", "fakeKey0001"),
        );
        let out = compact_error_text(&msg);
        assert!(!out.contains("fakeKey"));
        assert!(out.contains("***"));
    }

    #[test]
    fn provider_error_status_maps_to_anthropic_types() {
        assert_eq!(map_provider_error_status(400), (400, "invalid_request_error"));
        assert_eq!(map_provider_error_status(401), (401, "authentication_error"));
        assert_eq!(map_provider_error_status(429), (429, "rate_limit_error"));
        assert_eq!(map_provider_error_status(503), (503, "api_error"));
        assert_eq!(map_provider_error_status(529), (529, "overloaded_error"));
        // A non-standard status collapses to 502.
        assert_eq!(map_provider_error_status(418), (502, "api_error"));
    }

    #[test]
    fn provider_error_response_forwards_retry_after() {
        let with = provider_error_response(429, "rate_limit_error", "slow down", Some("30"));
        assert!(with.contains("HTTP/1.1 429 Too Many Requests"));
        assert!(with.contains("Retry-After: 30"));
        assert!(with.contains("rate_limit_error"));
        let without = provider_error_response(400, "invalid_request_error", "bad", None);
        assert!(!without.contains("Retry-After"));
    }

    #[test]
    fn constant_time_eq_matches_only_identical_strings() {
        assert!(constant_time_eq("abc123", "abc123"));
        assert!(!constant_time_eq("abc123", "abc124"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn presented_proxy_token_reads_x_api_key_then_bearer() {
        let with_key = HttpRequest {
            method: "POST".into(),
            path: "/v1/messages".into(),
            headers: vec![("x-api-key".into(), "secret-1".into())],
            body: Vec::new(),
        };
        assert_eq!(presented_proxy_token(&with_key).as_deref(), Some("secret-1"));

        let with_bearer = HttpRequest {
            method: "POST".into(),
            path: "/v1/messages".into(),
            headers: vec![("Authorization".into(), "Bearer secret-2".into())],
            body: Vec::new(),
        };
        assert_eq!(
            presented_proxy_token(&with_bearer).as_deref(),
            Some("secret-2")
        );

        let none = HttpRequest {
            method: "GET".into(),
            path: "/".into(),
            headers: Vec::new(),
            body: Vec::new(),
        };
        assert_eq!(presented_proxy_token(&none), None);
    }

    #[test]
    fn detects_openai_image_parts_for_provider_guard() {
        assert!(request_contains_openai_image_parts(&json!({
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "what is this?" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,abc" } }
                ]
            }]
        })));
        assert!(!request_contains_openai_image_parts(&json!({
            "messages": [{ "role": "user", "content": "text only" }]
        })));
    }

    #[test]
    fn converts_tool_use_and_tool_result_messages() {
        let credential = OpenAiProxyCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "qwen-test".to_string(),
            transformers: Vec::new(),
            model_transformers: Vec::new(),
            auth_token: String::new(),
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

        let converted = anthropic_to_openai_request(
            &request,
            &credential,
            &ProxyTransformerChain::from_names(&[]),
        )
        .unwrap();
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
            transformers: Vec::new(),
            model_transformers: Vec::new(),
            auth_token: String::new(),
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

        let converted = anthropic_to_openai_request(
            &request,
            &credential,
            &ProxyTransformerChain::from_names(&[]),
        )
        .unwrap();
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
            transformers: Vec::new(),
            model_transformers: Vec::new(),
            auth_token: String::new(),
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

        let converted = anthropic_to_openai_request(
            &request,
            &credential,
            &ProxyTransformerChain::from_names(&[]),
        )
        .unwrap();
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
            transformers: Vec::new(),
            model_transformers: Vec::new(),
            auth_token: String::new(),
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
