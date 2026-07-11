use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use tokio::sync::Mutex;

const GOOGLE_TOKEN_CACHE_TTL: Duration = Duration::from_secs(45 * 60);
const GOOGLE_TOKEN_EXPIRY_SKEW_SECS: u64 = 5 * 60;
const GCLOUD_LOGIN_HINT: &str = "Run `gcloud auth login` to use Vertex AI.";

struct CachedGoogleAccessToken {
    token: String,
    expires_at: Instant,
}

fn google_token_cache() -> &'static Mutex<Option<CachedGoogleAccessToken>> {
    static CACHE: OnceLock<Mutex<Option<CachedGoogleAccessToken>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

pub(crate) fn is_vertex_openai_compat_base_url(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    lower.contains("aiplatform.googleapis.com") && lower.contains("/endpoints/openapi")
}

fn jwt_is_stale(token: &str) -> bool {
    let mut parts = token.split('.');
    let (Some(_header), Some(payload), Some(_signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let Ok(decoded) = URL_SAFE_NO_PAD.decode(payload) else {
        return false;
    };
    let Ok(claims) = serde_json::from_slice::<serde_json::Value>(&decoded) else {
        return false;
    };
    let Some(expires_at) = claims.get("exp").and_then(|value| value.as_u64()) else {
        return false;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    expires_at <= now.saturating_add(GOOGLE_TOKEN_EXPIRY_SKEW_SECS)
}

pub(crate) fn should_mint_google_access_token(api_key: &str) -> bool {
    let token = api_key.trim();
    token.is_empty()
        || token.starts_with("AIza")
        // Google OAuth access tokens are opaque, so their expiry cannot be
        // inspected. Re-mint them through gcloud and use our own cache lifetime.
        || token.starts_with("ya29.")
        || jwt_is_stale(token)
}

fn find_gcloud_binary() -> Option<PathBuf> {
    if let Ok(path) = which::which("gcloud") {
        return Some(path);
    }
    if let Some(root) = std::env::var_os("CLOUDSDK_ROOT_DIR") {
        let candidate = PathBuf::from(root).join("bin").join("gcloud");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // GUI apps (Dock/Spotlight) inherit a minimal PATH without /opt/homebrew/bin
    // or /usr/local/bin, so check the standard install locations directly —
    // same approach as find_claude_binary() and find_uv_binary().
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/gcloud"),
        PathBuf::from("/usr/local/bin/gcloud"),
        PathBuf::from("/usr/bin/gcloud"),
        PathBuf::from("/opt/homebrew/share/google-cloud-sdk/bin/gcloud"),
        PathBuf::from("/usr/local/share/google-cloud-sdk/bin/gcloud"),
        PathBuf::from("/opt/google-cloud-sdk/bin/gcloud"),
        PathBuf::from("/usr/lib/google-cloud-sdk/bin/gcloud"),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("google-cloud-sdk").join("bin").join("gcloud"));
        candidates.push(
            home.join(".local")
                .join("share")
                .join("google-cloud-sdk")
                .join("bin")
                .join("gcloud"),
        );
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

pub(crate) async fn resolve_google_access_token() -> Result<String, String> {
    let mut cache = google_token_cache().lock().await;
    if let Some(cached) = cache.as_ref() {
        if Instant::now() < cached.expires_at {
            return Ok(cached.token.clone());
        }
    }

    let binary = find_gcloud_binary()
        .ok_or_else(|| format!("Google Cloud CLI was not found. {GCLOUD_LOGIN_HINT}"))?;
    let output = Command::new(binary)
        .args(["auth", "print-access-token"])
        .output()
        .await
        .map_err(|error| format!("Could not run gcloud ({error}). {GCLOUD_LOGIN_HINT}"))?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        return Err(if detail.is_empty() {
            GCLOUD_LOGIN_HINT.to_string()
        } else {
            format!("{GCLOUD_LOGIN_HINT} gcloud reported: {detail}")
        });
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err(format!(
            "gcloud did not return an access token. {GCLOUD_LOGIN_HINT}"
        ));
    }

    *cache = Some(CachedGoogleAccessToken {
        token: token.clone(),
        expires_at: Instant::now() + GOOGLE_TOKEN_CACHE_TTL,
    });
    Ok(token)
}

pub(crate) async fn resolve_vertex_bearer_token(
    base_url: &str,
    api_key: &str,
) -> Result<Option<String>, String> {
    let token = api_key.trim();
    if is_vertex_openai_compat_base_url(base_url) && should_mint_google_access_token(token) {
        return match resolve_google_access_token().await {
            Ok(minted) => Ok(Some(minted)),
            // An API key can never authenticate against Vertex, but a pasted
            // OAuth token that we merely couldn't refresh might still be valid.
            Err(error) => {
                if !token.is_empty() && !token.starts_with("AIza") {
                    Ok(Some(token.to_string()))
                } else {
                    Err(error)
                }
            }
        };
    }

    Ok((!token.is_empty()).then(|| token.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_vertex_openai_compatible_urls() {
        assert!(is_vertex_openai_compat_base_url(
            "https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi"
        ));
        assert!(!is_vertex_openai_compat_base_url(
            "https://generativelanguage.googleapis.com/v1beta/openai"
        ));
    }

    #[test]
    fn identifies_credentials_that_need_gcloud_refresh() {
        assert!(should_mint_google_access_token(""));
        assert!(should_mint_google_access_token("AIza-example"));
        assert!(should_mint_google_access_token("ya29.example"));
        let expired_payload = URL_SAFE_NO_PAD.encode(br#"{"exp":1}"#);
        assert!(should_mint_google_access_token(&format!(
            "header.{expired_payload}.signature"
        )));
        let fresh_payload = URL_SAFE_NO_PAD.encode(br#"{"exp":4102444800}"#);
        assert!(!should_mint_google_access_token(&format!(
            "header.{fresh_payload}.signature"
        )));
        assert!(!should_mint_google_access_token("custom-oauth-token"));
    }
}
