//! Stdio transport for external agents (Cursor, Claude Code, Goose, Cline, etc.).
//!
//! Reads newline-delimited JSON-RPC requests from standard input and writes
//! responses to standard output.
//!
//! Three properties this transport has to hold that the original did not:
//!
//! * **A bad line must not end the session.** The loop was
//!   `while let Ok(n) = reader.read_line(&mut line)`, so a single byte of
//!   invalid UTF-8 made `read_line` return `Err`, the `while let` pattern fail,
//!   and the server exit — reporting `Ok(())` and status 0, indistinguishable
//!   from a clean shutdown. Lines are now read as bytes and validated
//!   individually, so one malformed request costs one error response.
//! * **A line must be bounded.** `read_line` grows a `String` until it sees a
//!   newline; a peer that never sends one is an unbounded allocation.
//! * **Notifications must not be answered.** JSON-RPC 2.0 §4.1 forbids replying
//!   to a request with no `id`, and MCP clients routinely send `notifications/*`.
//!   The original answered every one of them, and answered with
//!   "method not found" — which strict clients treat as a fatal handshake error.

use crate::career_db::CareerDbState;
use crate::mcp::protocol::{
    JsonRpcError, JsonRpcRequest, JsonRpcResponse, ERR_INVALID_REQUEST, ERR_PARSE_ERROR,
};
use crate::mcp::server::StatelessMcpServer;
use serde_json::Value;
use std::io::{self, BufRead, BufReader, Read, Write};

/// Largest single request line accepted. Comfortably above a full job
/// description plus knowledgebase arguments, far below an allocation hazard.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// Outcome of pulling one line off the input.
enum Line {
    Payload(Vec<u8>),
    /// Line exceeded `MAX_LINE_BYTES`; the remainder was discarded.
    Oversized(usize),
    Eof,
}

fn read_line_bounded<R: BufRead>(reader: &mut R) -> io::Result<Line> {
    let mut raw = Vec::new();
    let read = reader
        .by_ref()
        .take(MAX_LINE_BYTES as u64 + 1)
        .read_until(b'\n', &mut raw)?;

    if read == 0 {
        return Ok(Line::Eof);
    }

    if raw.len() > MAX_LINE_BYTES {
        let mut discarded = raw.len();

        // Only drain when the take actually cut us off mid-line.
        //
        // A line of exactly `MAX_LINE_BYTES + 1` bytes *ending in a newline* is
        // already fully framed — the read stopped at the terminator, not at the
        // limit. Draining in that case would consume everything up to the
        // FOLLOWING newline, silently eating the client's next, perfectly valid
        // request, which then never receives a response.
        if raw.last() != Some(&b'\n') {
            loop {
                let mut sink = Vec::new();
                let n = reader
                    .by_ref()
                    .take(MAX_LINE_BYTES as u64)
                    .read_until(b'\n', &mut sink)?;
                discarded += n;
                if n == 0 || sink.last() == Some(&b'\n') {
                    break;
                }
            }
        }
        return Ok(Line::Oversized(discarded));
    }

    Ok(Line::Payload(raw))
}

/// Does this request carry an `id`?
///
/// `JsonRpcRequest::id` is `Option<Value>` with `#[serde(default)]`, so an
/// absent key and an explicit `"id": null` both deserialize to `None`. Only the
/// raw JSON distinguishes them, and only the absent case is a notification.
fn is_notification(raw: &Value) -> bool {
    raw.get("id").is_none()
}

pub async fn run_stdio_transport(career_db: CareerDbState) -> Result<(), String> {
    let server = StatelessMcpServer::new(career_db);
    let mut reader = BufReader::new(io::stdin());
    let mut stdout = io::stdout();

    loop {
        let line = match read_line_bounded(&mut reader) {
            Ok(Line::Eof) => break,
            Ok(Line::Payload(raw)) => raw,
            Ok(Line::Oversized(n)) => {
                let response = JsonRpcResponse::error(
                    None,
                    JsonRpcError::new(
                        ERR_INVALID_REQUEST,
                        format!(
                            "Request line of at least {n} bytes exceeds the {MAX_LINE_BYTES}-byte limit"
                        ),
                    ),
                );
                if !write_response(&mut stdout, &response) {
                    break;
                }
                continue;
            }
            Err(e) => {
                // A read error is a transport fault, not a protocol fault:
                // report it on stderr and stop, rather than exiting 0 as if the
                // client had closed cleanly.
                return Err(format!("stdin read error: {e}"));
            }
        };

        let text = match std::str::from_utf8(&line) {
            Ok(s) => s.trim(),
            Err(e) => {
                let response = JsonRpcResponse::error(
                    None,
                    JsonRpcError::new(ERR_PARSE_ERROR, format!("Parse error: invalid UTF-8: {e}")),
                );
                if !write_response(&mut stdout, &response) {
                    break;
                }
                continue;
            }
        };

        if text.is_empty() {
            continue;
        }

        // Parse once as generic JSON so `id` presence survives, then into the
        // typed request.
        let raw_value: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                let response = JsonRpcResponse::error(
                    None,
                    JsonRpcError::new(ERR_PARSE_ERROR, format!("Parse error: {e}")),
                );
                if !write_response(&mut stdout, &response) {
                    break;
                }
                continue;
            }
        };

        let notification = is_notification(&raw_value);
        let request: JsonRpcRequest = match serde_json::from_value(raw_value) {
            Ok(r) => r,
            Err(e) => {
                if notification {
                    continue;
                }
                let response = JsonRpcResponse::error(
                    None,
                    JsonRpcError::new(ERR_INVALID_REQUEST, format!("Invalid request: {e}")),
                );
                if !write_response(&mut stdout, &response) {
                    break;
                }
                continue;
            }
        };

        let response = server.handle_request(None, request).await;

        // Run the notification for its effect, then stay silent.
        if notification {
            continue;
        }
        if !write_response(&mut stdout, &response) {
            break;
        }
    }

    Ok(())
}

/// Returns false when stdout is gone, so the caller can stop instead of
/// spinning against a closed pipe.
fn write_response<W: Write>(out: &mut W, response: &JsonRpcResponse) -> bool {
    let Ok(json) = serde_json::to_string(response) else {
        return true;
    };
    writeln!(out, "{json}").is_ok() && out.flush().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_invalid_utf8_line_yields_an_error_and_leaves_the_stream_usable() {
        // The pre-fix loop exited the process here, reporting success.
        let input: Vec<u8> = [b"{\"a\":\"".as_slice(), &[0xff, 0xfe], b"\"}\n", b"{\"b\":1}\n"]
            .concat();
        let mut reader = BufReader::new(input.as_slice());

        let first = read_line_bounded(&mut reader).expect("first line reads");
        match first {
            Line::Payload(raw) => assert!(
                std::str::from_utf8(&raw).is_err(),
                "line one should be the invalid-UTF-8 payload"
            ),
            _ => panic!("expected a payload line"),
        }

        let second = read_line_bounded(&mut reader).expect("second line reads");
        match second {
            Line::Payload(raw) => assert_eq!(raw, b"{\"b\":1}\n"),
            _ => panic!("the stream must survive the bad line"),
        }
    }

    #[test]
    fn an_unterminated_line_cannot_grow_without_bound() {
        let mut input = vec![b'x'; MAX_LINE_BYTES + 1024];
        input.push(b'\n');
        input.extend_from_slice(b"{\"ok\":1}\n");
        let mut reader = BufReader::new(input.as_slice());

        match read_line_bounded(&mut reader).expect("oversized line handled") {
            Line::Oversized(n) => assert!(n > MAX_LINE_BYTES),
            _ => panic!("expected the line to be rejected as oversized"),
        }

        // and the next real record is still parseable
        match read_line_bounded(&mut reader).expect("resync") {
            Line::Payload(raw) => assert_eq!(raw, b"{\"ok\":1}\n"),
            _ => panic!("parser must resynchronise on the next record boundary"),
        }
    }

    #[test]
    fn a_terminated_line_at_the_limit_does_not_swallow_the_next_request() {
        // Off-by-one: `raw.len() > MAX` is true both when the take cut us off
        // mid-line AND when a newline landed at exactly MAX+1. In the second
        // case the line is already framed, so draining consumed the client's
        // NEXT request, which then never received a response.
        let mut input = vec![b'x'; MAX_LINE_BYTES];
        input.push(b'\n'); // exactly MAX + 1 bytes, fully terminated
        input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":1}\n");
        let mut reader = BufReader::new(input.as_slice());

        match read_line_bounded(&mut reader).expect("oversized-but-framed line") {
            Line::Oversized(n) => assert_eq!(
                n,
                MAX_LINE_BYTES + 1,
                "nothing beyond the framed line may be consumed"
            ),
            other => panic!(
                "expected the over-limit line to be rejected, got {}",
                match other {
                    Line::Payload(_) => "a payload over the cap",
                    Line::Eof => "eof",
                    Line::Oversized(_) => unreachable!(),
                }
            ),
        }

        match read_line_bounded(&mut reader).expect("next request survives") {
            Line::Payload(raw) => assert_eq!(raw, b"{\"jsonrpc\":\"2.0\",\"id\":1}\n"),
            _ => panic!("the following request must not be swallowed"),
        }
    }

    #[test]
    fn a_payload_line_is_never_returned_over_the_cap() {
        let mut input = vec![b'x'; MAX_LINE_BYTES + 1];
        input.push(b'\n');
        let mut reader = BufReader::new(input.as_slice());
        assert!(
            !matches!(
                read_line_bounded(&mut reader).expect("read"),
                Line::Payload(_)
            ),
            "an over-cap line must never be handed on as a payload"
        );
    }

    #[test]
    fn eof_is_distinguished_from_a_blank_line() {
        let mut empty = BufReader::new(b"".as_slice());
        assert!(matches!(
            read_line_bounded(&mut empty).expect("eof"),
            Line::Eof
        ));

        let mut blank = BufReader::new(b"\n".as_slice());
        assert!(matches!(
            read_line_bounded(&mut blank).expect("blank"),
            Line::Payload(_)
        ));
    }

    #[test]
    fn a_request_without_an_id_is_a_notification() {
        assert!(is_notification(
            &json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
        ));
    }

    #[test]
    fn an_explicit_null_id_is_a_request_not_a_notification() {
        // Both deserialize to `id: None`; only the raw JSON tells them apart,
        // which is why notification detection happens before typing.
        assert!(!is_notification(
            &json!({"jsonrpc": "2.0", "id": null, "method": "tools/list"})
        ));
        assert!(!is_notification(
            &json!({"jsonrpc": "2.0", "id": 7, "method": "tools/list"})
        ));
    }

    #[test]
    fn write_response_reports_a_closed_pipe() {
        struct Closed;
        impl Write for Closed {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let response = JsonRpcResponse::success(Some(json!(1)), json!({}));
        assert!(
            !write_response(&mut Closed, &response),
            "a broken pipe must stop the loop rather than spin"
        );
    }
}
