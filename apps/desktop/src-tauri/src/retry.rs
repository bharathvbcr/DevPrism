//! Small shared retry helper for transient network / provider failures. Used at
//! the HTTP boundaries (provider proxy, model listing, Ollama) so a single
//! ECONNRESET / 429 / 5xx doesn't surface as a hard mid-conversation failure.

use std::time::Duration;

/// Retryable HTTP statuses: rate-limit (429) and transient server errors (5xx),
/// excluding 501 Not Implemented (a permanent "won't ever work" signal).
pub fn is_retryable_status(status: u16) -> bool {
    status == 429 || (status >= 500 && status != 501)
}

/// Parse a `Retry-After` header value in delta-seconds form into a Duration.
/// The HTTP-date form is ignored (returns None → fall back to backoff).
pub fn parse_retry_after(value: &str) -> Option<Duration> {
    value.trim().parse::<u64>().ok().map(Duration::from_secs)
}

/// Exponential backoff (200ms, 400ms, 800ms, …) capped at 8s, overridden by an
/// upstream `Retry-After` (capped at 60s) when present.
pub fn backoff_delay(attempt: u32, retry_after: Option<Duration>) -> Duration {
    if let Some(ra) = retry_after {
        return ra.min(Duration::from_secs(60));
    }
    let shift = attempt.saturating_sub(1).min(6);
    let millis = 200u64.saturating_mul(1u64 << shift);
    Duration::from_millis(millis.min(8_000))
}

/// Send a request — rebuilt each attempt by `build` — retrying transient
/// failures: connect/timeout errors and retryable statuses, honoring
/// `Retry-After`. Returns the final response (which may still be an error
/// status) or the last transport error. Safe only for idempotent requests or
/// ones where retrying before the body is consumed has no side effects.
pub async fn send_with_retry(
    attempts: u32,
    build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match build().send().await {
            Ok(resp) => {
                if attempt < attempts && is_retryable_status(resp.status().as_u16()) {
                    let ra = resp
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .and_then(parse_retry_after);
                    tokio::time::sleep(backoff_delay(attempt, ra)).await;
                    continue;
                }
                return Ok(resp);
            }
            Err(e) => {
                if attempt < attempts && (e.is_connect() || e.is_timeout()) {
                    tokio::time::sleep(backoff_delay(attempt, None)).await;
                    continue;
                }
                return Err(e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_statuses() {
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(500));
        assert!(is_retryable_status(503));
        assert!(!is_retryable_status(501));
        assert!(!is_retryable_status(400));
        assert!(!is_retryable_status(401));
        assert!(!is_retryable_status(200));
    }

    #[test]
    fn backoff_grows_and_caps_and_honors_retry_after() {
        assert_eq!(backoff_delay(1, None), Duration::from_millis(200));
        assert_eq!(backoff_delay(2, None), Duration::from_millis(400));
        assert_eq!(backoff_delay(3, None), Duration::from_millis(800));
        assert!(backoff_delay(20, None) <= Duration::from_secs(8));
        assert_eq!(
            backoff_delay(1, Some(Duration::from_secs(5))),
            Duration::from_secs(5)
        );
        // Absurd Retry-After is clamped.
        assert_eq!(
            backoff_delay(1, Some(Duration::from_secs(9999))),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn parses_retry_after_seconds_only() {
        assert_eq!(parse_retry_after("30"), Some(Duration::from_secs(30)));
        assert_eq!(parse_retry_after("  7 "), Some(Duration::from_secs(7)));
        assert_eq!(parse_retry_after("Wed, 21 Oct 2026 07:28:00 GMT"), None);
    }
}
