//! Lightweight HTTP Transport for Stateless MCP 2.0 (SEP-2243).
//!
//! Serves `POST /mcp` on loopback with full header inspection and validation.
//!
//! # Security posture
//!
//! This listener speaks for the user's entire career knowledgebase — reading it,
//! writing it, and (via `career_delete_block`) destroying parts of it — with no
//! per-call authorization. It binds loopback only, but "loopback" is not a
//! trust boundary against a **browser**: any page the user visits can issue
//! requests to `http://127.0.0.1:<port>`. Three things keep that from being a
//! remote read/write primitive against the knowledgebase:
//!
//! 1. **No permissive CORS.** The previous implementation replied
//!    `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Headers: *` to
//!    every request, which is precisely the configuration that lets a page on
//!    any origin read the response body. Nothing here emits those headers, so
//!    the same-origin policy stops a cross-origin page from reading replies.
//! 2. **Origin rejection.** CORS only governs *reading* the response; a page can
//!    still fire a no-preflight `POST` and cause the side effect. Genuine MCP
//!    clients are CLI/desktop processes and send no `Origin`. Any request that
//!    carries one is refused outright.
//! 3. **Host allow-listing.** A DNS-rebinding attacker resolves their own name
//!    to 127.0.0.1, which makes their origin *same*-origin with this server and
//!    defeats (1) and (2). Requiring `Host` to be a literal loopback name blocks
//!    that.
//!
//! Optional bearer auth is available on top: set `DEVPRISM_MCP_HTTP_TOKEN` and
//! every request must present `Authorization: Bearer <token>`. It is opt-in so
//! that existing local clients keep working unchanged.

use crate::career_db::CareerDbState;
use crate::mcp::protocol::{HttpHeaders, JsonRpcError, JsonRpcRequest, JsonRpcResponse};
use crate::mcp::server::StatelessMcpServer;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

/// Largest request (headers + body) this transport will buffer.
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

/// Largest header block. Bounds the pre-`Content-Length` read, which cannot use
/// the body limit because the body length is not known until headers end.
const MAX_HEADER_BYTES: usize = 64 * 1024;

/// Deadline for *receiving* a request — not for answering it.
///
/// Without this a peer could open a connection, send one byte, and hold a task
/// plus its buffer indefinitely: the classic slowloris shape.
///
/// It deliberately does not cover dispatch. A `resume_synthesize` in `ollama`
/// mode runs JD analysis, a per-block rewrite loop, and a Typst compile, and can
/// legitimately exceed any read deadline; timing that out would drop the future
/// mid-`await` and close the socket with no response, while the `spawn_blocking`
/// work it had already started ran on and still committed its side effects.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Ceiling on answering a request once it has been fully received.
///
/// Matches the longest budget the server itself grants a single operation (the
/// Tasks TTL and the Ollama request budget are both 600s), so a legitimate slow
/// call completes and a genuinely wedged one still releases its connection slot.
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(600);

/// Concurrent connections served at once. Excess connections wait for a permit
/// rather than each getting an unbounded spawned task.
const MAX_CONCURRENT_CONNECTIONS: usize = 64;

/// Env var enabling optional bearer authentication.
const AUTH_TOKEN_ENV: &str = "DEVPRISM_MCP_HTTP_TOKEN";

pub async fn run_http_transport(career_db: CareerDbState, port: u16) -> Result<(), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind MCP HTTP server to {addr}: {e}"))?;

    let auth_token = std::env::var(AUTH_TOKEN_ENV).ok().filter(|t| !t.is_empty());
    eprintln!(
        "[mcp_http] Stateless MCP 2.0 server listening on http://{addr}/mcp (auth: {})",
        if auth_token.is_some() {
            "bearer token required"
        } else {
            "loopback origin checks only"
        }
    );

    let server = StatelessMcpServer::new(career_db);
    let limiter = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));
    let auth_token = Arc::new(auth_token);

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let s = server.clone();
                let token = Arc::clone(&auth_token);
                let limiter = Arc::clone(&limiter);
                // Spawn FIRST, then wait for a permit inside the task.
                //
                // Acquiring in the accept loop meant 64 stalled peers stopped
                // `accept()` being called at all: the OS backlog filled and
                // legitimate local clients were refused connection rather than
                // queued behind a bounded worker pool.
                tokio::spawn(async move {
                    let Ok(_permit) = limiter.acquire_owned().await else {
                        return;
                    };
                    handle_connection(stream, s, token.as_ref().as_deref()).await;
                });
            }
            Err(e) => {
                eprintln!("[mcp_http] Accept error: {e}");
            }
        }
    }
}

/// A parsed HTTP request line plus headers and body.
struct ParsedHttp {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

/// Minimal HTTP response with no CORS headers.
///
/// Deliberately omits `Access-Control-Allow-*`: see the module docs. Adding them
/// back would re-open cross-origin reads of the knowledgebase.
fn http_response(status: &str, content_type: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}",
        len = body.len()
    )
}

/// Is `host` a literal loopback authority?
///
/// Rejecting everything else is the DNS-rebinding defense: an attacker-controlled
/// name that resolves to 127.0.0.1 arrives with *their* name in `Host`.
pub(crate) fn is_loopback_host(host: &str) -> bool {
    let authority = host.trim();
    // Strip the port. IPv6 literals are bracketed, so split on the last ':'
    // only when it is not inside brackets.
    let hostname = if let Some(rest) = authority.strip_prefix('[') {
        match rest.split_once(']') {
            Some((inner, _)) => inner,
            None => return false,
        }
    } else {
        authority.split(':').next().unwrap_or("")
    };

    matches!(
        hostname.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1" | "0:0:0:0:0:0:0:1"
    )
}

/// Is this `Origin` the desktop app's own webview?
///
/// Tauri v2 serves the webview from `tauri://localhost` (macOS/iOS) or
/// `http://tauri.localhost` (Windows/Linux), and the dev server from
/// `http://localhost:1420`. Everything else — including any real website — is a
/// foreign origin.
pub(crate) fn is_app_origin(origin: &str) -> bool {
    let origin = origin.trim().to_ascii_lowercase();

    // A packaged app's webview is always one of these.
    if matches!(
        origin.as_str(),
        "tauri://localhost" | "https://tauri.localhost" | "http://tauri.localhost"
    ) {
        return true;
    }

    // The Vite dev origin is allowed only in a debug build. Port 1420 is Vite's
    // *default*, so allow-listing it in a release binary would mean any other
    // project's dev server — or any page the user opened on that port — could
    // issue writes here. That is exactly the cross-site request this function
    // exists to refuse.
    #[cfg(debug_assertions)]
    if matches!(
        origin.as_str(),
        "http://localhost:1420" | "http://127.0.0.1:1420"
    ) {
        return true;
    }

    false
}

/// Compare two secrets without an early exit on the first differing byte.
///
/// The channel here is loopback, so a timing oracle is not the realistic threat —
/// but a short-circuiting `==` on a credential is the kind of thing that is
/// cheap to get right and awkward to notice later.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    // Length is not secret; comparing unequal lengths would need padding to be
    // fully constant-time and gains nothing here.
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Read a full HTTP request: headers, then exactly `Content-Length` body bytes.
///
/// The original implementation performed a single `read()` into a 64 KiB buffer
/// and treated whatever arrived as the whole request. TCP makes no such promise:
/// a request split across segments (routine — many clients write headers and
/// body separately) was silently truncated and rejected as a parse error, and
/// any request above 64 KiB could never succeed at all.
async fn read_request(stream: &mut TcpStream) -> Result<ParsedHttp, (&'static str, String)> {
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut chunk = [0u8; 8 * 1024];

    // Phase 1: read until the header terminator.
    let header_end = loop {
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err((
                "431 Request Header Fields Too Large",
                "header block too large".to_string(),
            ));
        }
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| ("400 Bad Request", format!("read error: {e}")))?;
        if n == 0 {
            return Err((
                "400 Bad Request",
                "connection closed before headers completed".to_string(),
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let head = parse_head(&buf[..header_end])?;
    let ParsedHead {
        method,
        path,
        headers,
    } = head;

    // Phase 2: read exactly the declared body length.
    let declared = content_length(&headers)?;
    if declared > MAX_REQUEST_BYTES {
        return Err((
            "413 Payload Too Large",
            format!("body of {declared} bytes exceeds the {MAX_REQUEST_BYTES}-byte limit"),
        ));
    }

    let body_start = header_end + 4;
    let mut body = buf.split_off(body_start.min(buf.len()));
    while body.len() < declared {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| ("400 Bad Request", format!("read error: {e}")))?;
        if n == 0 {
            return Err((
                "400 Bad Request",
                format!(
                    "connection closed after {} of {declared} declared body bytes",
                    body.len()
                ),
            ));
        }
        body.extend_from_slice(&chunk[..n]);
        if body.len() > MAX_REQUEST_BYTES {
            return Err((
                "413 Payload Too Large",
                "body exceeded the size limit".to_string(),
            ));
        }
    }
    body.truncate(declared);

    Ok(ParsedHttp {
        method,
        path,
        headers,
        body,
    })
}

pub(crate) fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Request line plus headers, parsed out of the head block.
#[derive(Debug)]
pub(crate) struct ParsedHead {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
}

/// Parse the head block. Pure, so the security-relevant parsing is testable and
/// fuzzable without a socket.
pub(crate) fn parse_head(head_bytes: &[u8]) -> Result<ParsedHead, (&'static str, String)> {
    let head = String::from_utf8_lossy(head_bytes).to_string();
    let mut lines = head.lines();
    let request_line = lines
        .next()
        .ok_or(("400 Bad Request", "empty request line".to_string()))?;

    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("").to_ascii_uppercase();
    // A missing target is malformed. Defaulting it to "/" would have made a
    // garbage request line pass the route check.
    let Some(path) = request_parts.next().map(str::to_string) else {
        return Err((
            "400 Bad Request",
            "malformed request line: no request target".to_string(),
        ));
    };
    if method.is_empty() {
        return Err((
            "400 Bad Request",
            "malformed request line: no method".to_string(),
        ));
    }

    let mut headers = HashMap::new();
    for line in lines {
        // Ignore obs-fold continuation lines rather than treating the folded
        // value as a new header.
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            if key.is_empty() {
                continue;
            }
            // Reject rather than silently keeping one of two conflicting values:
            // disagreeing duplicates of a framing header are the request-
            // smuggling primitive.
            if let Some(existing) = headers.get(&key) {
                if key == "content-length" && existing != v.trim() {
                    return Err((
                        "400 Bad Request",
                        "conflicting Content-Length headers".to_string(),
                    ));
                }
                continue;
            }
            headers.insert(key, v.trim().to_string());
        }
    }

    Ok(ParsedHead {
        method,
        path,
        headers,
    })
}

/// Resolve the body length, refusing framing this transport does not implement.
pub(crate) fn content_length(
    headers: &HashMap<String, String>,
) -> Result<usize, (&'static str, String)> {
    // Chunked bodies were previously read as if the chunk framing were JSON,
    // producing a confusing parse error instead of a clear refusal.
    if let Some(te) = headers.get("transfer-encoding") {
        if !te.eq_ignore_ascii_case("identity") {
            return Err((
                "501 Not Implemented",
                format!("Transfer-Encoding '{te}' is not supported; send Content-Length"),
            ));
        }
    }

    match headers.get("content-length") {
        None => Ok(0),
        Some(raw) => raw.trim().parse::<usize>().map_err(|_| {
            (
                "400 Bad Request",
                format!("malformed Content-Length '{raw}'"),
            )
        }),
    }
}

/// Decide whether a parsed request may reach the JSON-RPC dispatcher.
///
/// Split out from I/O so the policy is directly testable.
pub(crate) fn authorize(
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    auth_token: Option<&str>,
) -> Result<(), (&'static str, String)> {
    // DNS-rebinding defense. A missing Host is a malformed HTTP/1.1 request.
    match headers.get("host") {
        Some(host) if is_loopback_host(host) => {}
        Some(host) => {
            return Err((
                "403 Forbidden",
                format!("Host '{host}' is not a loopback authority"),
            ))
        }
        None => return Err(("400 Bad Request", "missing Host header".to_string())),
    }

    // Browser-originated requests are refused unless they come from this app's
    // own webview. A page cannot suppress or forge `Origin` — the browser sets
    // it — so allow-listing the app's own origins keeps the in-app client
    // working while still refusing every foreign page. CLI and desktop MCP
    // clients send no `Origin` at all.
    let from_app_webview = match headers.get("origin") {
        None => false,
        Some(origin) => {
            if is_app_origin(origin) {
                true
            } else {
                return Err((
                    "403 Forbidden",
                    format!("cross-origin request from '{origin}' is not permitted"),
                ));
            }
        }
    };

    // `Sec-Fetch-Site` is likewise browser-set and unforgeable by page script,
    // and catches a browser request that omits `Origin` (a navigation-initiated
    // same-site POST, for instance).
    if !from_app_webview {
        if let Some(site) = headers.get("sec-fetch-site") {
            if site != "none" {
                return Err((
                    "403 Forbidden",
                    format!("browser-initiated request (sec-fetch-site: {site}) is not permitted"),
                ));
            }
        }
    }

    if let Some(expected) = auth_token {
        // RFC 7235 makes the auth scheme case-insensitive, so `bearer <tok>`
        // must not be reported as a wrong secret. `expected` is trimmed at the
        // comparison too: it comes from an env var, where a trailing newline is
        // easy to introduce and would otherwise make the token never match.
        let presented = headers.get("authorization").and_then(|v| {
            let v = v.trim();
            let (scheme, token) = v.split_once(' ')?;
            scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
        });
        if !presented.is_some_and(|p| constant_time_eq(p, expected.trim())) {
            // Never echo the presented value — it is a credential.
            return Err((
                "401 Unauthorized",
                "missing or invalid bearer token".to_string(),
            ));
        }
    }

    if method != "POST" {
        return Err((
            "405 Method Not Allowed",
            format!("method '{method}' is not supported; use POST"),
        ));
    }

    let route = path.split('?').next().unwrap_or(path).trim_end_matches('/');
    if !route.is_empty() && route != "/mcp" {
        return Err(("404 Not Found", format!("no MCP endpoint at '{path}'")));
    }

    Ok(())
}

async fn handle_connection(
    mut stream: TcpStream,
    server: StatelessMcpServer,
    auth_token: Option<&str>,
) {
    let parsed = match tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await {
        Ok(Ok(p)) => p,
        Err(_elapsed) => {
            write_plain(
                &mut stream,
                "408 Request Timeout",
                "request was not fully received in time",
            )
            .await;
            return;
        }
        Ok(Err((status, detail))) => {
            // Always answer. The original code returned silently on a malformed
            // or non-UTF-8 request, leaving the client to wait out its own
            // timeout with no diagnostic.
            write_plain(&mut stream, status, &detail).await;
            return;
        }
    };

    if let Err((status, detail)) = authorize(
        &parsed.method,
        &parsed.path,
        &parsed.headers,
        auth_token,
    ) {
        write_plain(&mut stream, status, &detail).await;
        return;
    }

    let body = match std::str::from_utf8(&parsed.body) {
        Ok(s) => s,
        Err(_) => {
            write_plain(&mut stream, "400 Bad Request", "body is not valid UTF-8").await;
            return;
        }
    };

    let http_headers = HttpHeaders::from_map(&parsed.headers);
    let response: JsonRpcResponse = match serde_json::from_str::<JsonRpcRequest>(body.trim()) {
        Ok(req) => {
            let id = req.id.clone();
            match tokio::time::timeout(
                DISPATCH_TIMEOUT,
                server.handle_request(Some(&http_headers), req),
            )
            .await
            {
                Ok(resp) => resp,
                // Answer rather than dropping the connection: a client that
                // waited out the budget deserves a diagnostic, not a reset.
                Err(_elapsed) => JsonRpcResponse::error(
                    id,
                    JsonRpcError::new(
                        crate::mcp::protocol::ERR_INTERNAL_ERROR,
                        format!(
                            "Request exceeded the {}s server dispatch budget",
                            DISPATCH_TIMEOUT.as_secs()
                        ),
                    ),
                ),
            }
        }
        Err(e) => JsonRpcResponse::error(
            None,
            JsonRpcError::new(
                crate::mcp::protocol::ERR_PARSE_ERROR,
                format!("Parse error: {e}"),
            ),
        ),
    };

    let res_body = serde_json::to_string(&response).unwrap_or_else(|_| {
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"response serialization failed"}}"#
            .to_string()
    });
    let http_res = http_response("200 OK", "application/json", &res_body);
    let _ = stream.write_all(http_res.as_bytes()).await;
    let _ = stream.flush().await;
}

async fn write_plain(stream: &mut TcpStream, status: &str, detail: &str) {
    let res = http_response(status, "text/plain; charset=utf-8", detail);
    let _ = stream.write_all(res.as_bytes()).await;
    let _ = stream.flush().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn a_plain_local_client_is_allowed() {
        assert!(authorize(
            "POST",
            "/mcp",
            &headers(&[("host", "127.0.0.1:39200")]),
            None
        )
        .is_ok());
    }

    #[test]
    fn a_request_from_a_web_page_is_refused() {
        // The pre-fix server answered this with `Access-Control-Allow-Origin: *`,
        // letting any site the user visited read their entire career database.
        let err = authorize(
            "POST",
            "/mcp",
            &headers(&[("host", "127.0.0.1:39200"), ("origin", "https://evil.example")]),
            None,
        )
        .expect_err("a page-originated request must be refused");
        assert_eq!(err.0, "403 Forbidden");
    }

    #[test]
    fn the_vite_dev_origin_is_debug_only() {
        // 1420 is Vite's *default* port. Allow-listing it in a release binary
        // means any other project's dev server — or any page the user opens on
        // that port — can issue writes here, which is the exact cross-site
        // request this policy exists to refuse.
        assert_eq!(
            is_app_origin("http://localhost:1420"),
            cfg!(debug_assertions),
            "the dev origin must be allowed only in debug builds"
        );
        // The packaged webview origins are unconditional.
        assert!(is_app_origin("tauri://localhost"));
        assert!(is_app_origin("http://tauri.localhost"));
    }

    #[test]
    fn the_apps_own_webview_is_allowed() {
        for origin in ["tauri://localhost", "http://tauri.localhost"] {
            assert!(
                authorize(
                    "POST",
                    "/mcp",
                    &headers(&[("host", "127.0.0.1:39200"), ("origin", origin)]),
                    None
                )
                .is_ok(),
                "{origin} is this app's own webview"
            );
        }
    }

    #[test]
    fn an_origin_that_merely_looks_like_the_app_is_refused() {
        for origin in [
            "https://tauri.localhost.evil.example",
            "http://localhost:1420.evil.example",
            "http://evil.example",
        ] {
            assert!(
                authorize(
                    "POST",
                    "/mcp",
                    &headers(&[("host", "127.0.0.1:39200"), ("origin", origin)]),
                    None
                )
                .is_err(),
                "{origin} must not be mistaken for the app"
            );
        }
    }

    #[test]
    fn a_browser_request_without_an_origin_header_is_still_refused() {
        // A same-site navigation-initiated POST omits Origin but still sets
        // Sec-Fetch-Site.
        let err = authorize(
            "POST",
            "/mcp",
            &headers(&[("host", "localhost:39200"), ("sec-fetch-site", "cross-site")]),
            None,
        )
        .expect_err("browser-initiated requests must be refused");
        assert_eq!(err.0, "403 Forbidden");
    }

    #[test]
    fn a_rebound_dns_name_is_refused() {
        let err = authorize(
            "POST",
            "/mcp",
            &headers(&[("host", "attacker.example:39200")]),
            None,
        )
        .expect_err("non-loopback Host must be refused");
        assert_eq!(err.0, "403 Forbidden");
    }

    #[test]
    fn loopback_authorities_are_recognised_with_and_without_ports() {
        for host in [
            "localhost",
            "localhost:39200",
            "127.0.0.1",
            "127.0.0.1:39200",
            "[::1]:39200",
            "LOCALHOST:39200",
        ] {
            assert!(is_loopback_host(host), "{host} should be loopback");
        }
        for host in [
            "evil.example",
            "127.0.0.1.evil.example",
            "localhost.evil.example",
            "",
        ] {
            assert!(!is_loopback_host(host), "{host} should not be loopback");
        }
    }

    #[test]
    fn non_post_methods_and_unknown_routes_are_refused() {
        let h = headers(&[("host", "127.0.0.1:39200")]);
        assert_eq!(
            authorize("GET", "/mcp", &h, None).expect_err("GET").0,
            "405 Method Not Allowed"
        );
        assert_eq!(
            authorize("OPTIONS", "/mcp", &h, None).expect_err("OPTIONS").0,
            "405 Method Not Allowed"
        );
        assert_eq!(
            authorize("POST", "/admin", &h, None).expect_err("bad route").0,
            "404 Not Found"
        );
    }

    #[test]
    fn the_mcp_route_tolerates_query_strings_and_trailing_slashes() {
        let h = headers(&[("host", "127.0.0.1:39200")]);
        assert!(authorize("POST", "/mcp/", &h, None).is_ok());
        assert!(authorize("POST", "/mcp?v=1", &h, None).is_ok());
        assert!(authorize("POST", "/", &h, None).is_ok());
    }

    #[test]
    fn bearer_auth_is_enforced_when_configured() {
        let base = [("host", "127.0.0.1:39200")];
        assert_eq!(
            authorize("POST", "/mcp", &headers(&base), Some("s3cret"))
                .expect_err("no token")
                .0,
            "401 Unauthorized"
        );
        assert_eq!(
            authorize(
                "POST",
                "/mcp",
                &headers(&[("host", "127.0.0.1:39200"), ("authorization", "Bearer wrong")]),
                Some("s3cret")
            )
            .expect_err("wrong token")
            .0,
            "401 Unauthorized"
        );
        assert!(authorize(
            "POST",
            "/mcp",
            &headers(&[("host", "127.0.0.1:39200"), ("authorization", "Bearer s3cret")]),
            Some("s3cret")
        )
        .is_ok());
    }

    #[test]
    fn the_bearer_scheme_is_case_insensitive_and_tolerates_a_padded_secret() {
        // RFC 7235 makes the scheme case-insensitive; rejecting `bearer` reads
        // as a wrong secret rather than a case bug. And a token read from an env
        // var routinely carries a trailing newline.
        for header in ["Bearer s3cret", "bearer s3cret", "BEARER  s3cret "] {
            assert!(
                authorize(
                    "POST",
                    "/mcp",
                    &headers(&[("host", "127.0.0.1:39200"), ("authorization", header)]),
                    Some("  s3cret\n")
                )
                .is_ok(),
                "'{header}' should authenticate"
            );
        }
    }

    #[test]
    fn a_rejection_never_echoes_the_presented_token() {
        let err = authorize(
            "POST",
            "/mcp",
            &headers(&[
                ("host", "127.0.0.1:39200"),
                ("authorization", "Bearer leaked-credential-value"),
            ]),
            Some("s3cret"),
        )
        .expect_err("wrong token");
        assert!(
            !err.1.contains("leaked-credential-value"),
            "credential must not appear in the error: {}",
            err.1
        );
    }

    #[test]
    fn responses_carry_no_permissive_cors_headers() {
        let res = http_response("200 OK", "application/json", "{}");
        let lower = res.to_ascii_lowercase();
        assert!(
            !lower.contains("access-control-allow-origin"),
            "wildcard CORS is what made this endpoint readable from any website"
        );
        assert!(!lower.contains("access-control-allow-headers"));
    }

    #[test]
    fn chunked_and_malformed_framing_are_refused_rather_than_misread() {
        let chunked = HashMap::from([("transfer-encoding".to_string(), "chunked".to_string())]);
        assert_eq!(
            content_length(&chunked).expect_err("chunked").0,
            "501 Not Implemented",
            "chunk framing must be refused, not parsed as if it were the body"
        );

        let bad = HashMap::from([("content-length".to_string(), "12abc".to_string())]);
        assert_eq!(content_length(&bad).expect_err("malformed").0, "400 Bad Request");

        let negative = HashMap::from([("content-length".to_string(), "-1".to_string())]);
        assert_eq!(content_length(&negative).expect_err("negative").0, "400 Bad Request");

        assert_eq!(content_length(&HashMap::new()).expect("absent is zero"), 0);
    }

    #[test]
    fn conflicting_content_length_headers_are_refused() {
        // Disagreeing duplicates of a framing header are the request-smuggling
        // primitive; keeping either one silently is the bug.
        let head = b"POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Length: 900\r\n";
        let err = parse_head(head).expect_err("conflicting lengths");
        assert_eq!(err.0, "400 Bad Request");
    }

    #[test]
    fn a_malformed_request_line_does_not_default_into_a_valid_route() {
        // Defaulting a missing target to "/" would have let a garbage request
        // line pass the route check.
        assert!(parse_head(b"GARBAGE\r\nHost: x\r\n").is_err());
        assert!(parse_head(b"\r\nHost: x\r\n").is_err());
    }

    #[test]
    fn route_traversal_and_absolute_form_targets_are_refused() {
        let h = headers(&[("host", "127.0.0.1:39200")]);
        for target in [
            "/mcp/../admin",
            "//mcp",
            "/MCP",
            "%2Fmcp",
            "http://evil.example/mcp",
            "/mcp/extra",
        ] {
            assert!(
                authorize("POST", target, &h, None).is_err(),
                "target '{target}' must not reach the dispatcher"
            );
        }
    }

    /// The head parser and the authorization policy must not panic on arbitrary
    /// bytes, and must never *allow* a request they cannot fully understand.
    #[test]
    fn the_http_head_parser_survives_arbitrary_bytes() {
        use crate::mcp::stress::{hostile_string, Lcg};

        let methods = ["POST", "GET", "OPTIONS", "", "post", "P\u{0}ST", "CONNECT"];
        let targets = ["/mcp", "/", "/mcp?x=1", "", "/mcp/../admin", "*"];

        for seed in 0..3_000u64 {
            let mut rng = Lcg::new(seed ^ 0x4854_5450);

            let mut head = format!(
                "{} {} HTTP/1.1\r\n",
                rng.pick(&methods),
                rng.pick(&targets)
            );
            for _ in 0..rng.below(6) {
                let name = match rng.below(6) {
                    0 => "Host".to_string(),
                    1 => "Origin".to_string(),
                    2 => "Content-Length".to_string(),
                    3 => "Transfer-Encoding".to_string(),
                    4 => "Authorization".to_string(),
                    _ => hostile_string(&mut rng),
                };
                head.push_str(&format!("{name}: {}\r\n", hostile_string(&mut rng)));
            }

            // Parsing must return, never panic.
            let parsed = parse_head(head.as_bytes());

            if let Ok(ParsedHead {
                method,
                path,
                headers,
            }) = parsed
            {
                // Whatever came out, an ALLOW decision must imply the request is
                // a POST to the MCP route from a loopback, non-browser client.
                if authorize(&method, &path, &headers, None).is_ok() {
                    assert_eq!(method, "POST", "seed {seed}: allowed non-POST");
                    assert!(
                        headers.get("host").map(|h| is_loopback_host(h)) == Some(true),
                        "seed {seed}: allowed a non-loopback Host: {:?}",
                        headers.get("host")
                    );
                    match headers.get("origin") {
                        None => {}
                        Some(o) => assert!(
                            is_app_origin(o),
                            "seed {seed}: allowed foreign origin '{o}'"
                        ),
                    }
                    let route = path.split('?').next().unwrap_or(&path).trim_end_matches('/');
                    assert!(
                        route.is_empty() || route == "/mcp",
                        "seed {seed}: allowed route '{path}'"
                    );
                }
            }
        }
    }

    /// A configured bearer token must gate every generated request.
    #[test]
    fn a_configured_token_is_never_bypassed_by_a_generated_request() {
        use crate::mcp::stress::{hostile_string, Lcg};

        for seed in 0..2_000u64 {
            let mut rng = Lcg::new(seed ^ 0x0A17_u64);
            let mut h = headers(&[("host", "127.0.0.1:39200")]);
            if rng.bool() {
                h.insert("authorization".to_string(), hostile_string(&mut rng));
            }
            if rng.bool() {
                h.insert(
                    "authorization".to_string(),
                    format!("Bearer {}", hostile_string(&mut rng)),
                );
            }
            let decision = authorize("POST", "/mcp", &h, Some("the-real-token"));
            if decision.is_ok() {
                assert_eq!(
                    h.get("authorization").map(String::as_str),
                    Some("Bearer the-real-token"),
                    "seed {seed}: authorized without the exact token"
                );
            }
        }
    }

    #[test]
    fn the_header_terminator_is_found_across_a_split_read() {
        // Emulates the segmentation that broke the single-read parser.
        let head = b"POST /mcp HTTP/1.1\r\nHost: x\r\n";
        let mut buf = head.to_vec();
        assert!(find_header_end(&buf).is_none());
        buf.extend_from_slice(b"\r\n{\"jsonrpc\":\"2.0\"}");

        let end = find_header_end(&buf).expect("terminator present after the second segment");
        assert_eq!(&buf[end..end + 4], b"\r\n\r\n");
        assert_eq!(&buf[end + 4..], b"{\"jsonrpc\":\"2.0\"}");
    }
}
