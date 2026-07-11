//! Groq Code CLI onboarding — detect/install the `groq` binary and verify API keys.
//! The groq-code-cli TUI is NOT spawned for in-app chat; chat uses the Groq API.

use std::process::Command as SyncCommand;

use tauri::{Emitter, WebviewWindow};

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GroqCliStatus {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub api_key_configured: bool,
}

fn find_groq_binary() -> Result<String, String> {
    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "windows")]
        let native = home.join(".local").join("bin").join("groq.exe");
        #[cfg(not(target_os = "windows"))]
        let native = home.join(".local").join("bin").join("groq");
        if native.exists() {
            return Ok(native.to_string_lossy().into_owned());
        }
    }

    if let Ok(path) = which::which("groq") {
        return Ok(path.to_string_lossy().into_owned());
    }

    #[cfg(not(target_os = "windows"))]
    if let Some(home) = dirs::home_dir() {
        for candidate in [
            home.join(".npm-global").join("bin").join("groq"),
            home.join(".npm").join("bin").join("groq"),
        ] {
            if candidate.exists() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }

    Err("groq CLI not found".into())
}

fn groq_api_key_configured() -> bool {
    if std::env::var("GROQ_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    crate::claude::openai_credential_api_key(None, "groq.com")
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn check_groq_cli_status() -> Result<GroqCliStatus, String> {
    let api_key_configured = groq_api_key_configured();
    match find_groq_binary() {
        Ok(binary_path) => {
            let version = SyncCommand::new(&binary_path)
                .arg("--version")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
            Ok(GroqCliStatus {
                installed: version.is_some(),
                binary_path: Some(binary_path),
                version,
                api_key_configured,
            })
        }
        Err(_) => Ok(GroqCliStatus {
            installed: false,
            binary_path: None,
            version: None,
            api_key_configured,
        }),
    }
}

#[tauri::command]
pub async fn install_groq_cli(window: WebviewWindow) -> Result<bool, String> {
    let _ = window.emit("install-output", "Installing groq-code-cli globally…");

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", "npm install -g groq-code-cli@latest"]);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell");
        c.args([
            "-NoProfile",
            "-Command",
            "npm install -g groq-code-cli@latest",
        ]);
        c
    };

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start npm install: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let win = window.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = win.emit("install-output", line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let win = window.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = win.emit("install-output", line);
            }
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Install failed: {e}"))?;
    if !status.success() {
        return Err("groq-code-cli install failed. Ensure npm is installed.".into());
    }

    find_groq_binary().map_err(|e| format!("Installed but not found: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn save_groq_api_key(api_key: String) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("API key is required".into());
    }
    crate::claude::verify_openai_compatible_api_key(
        trimmed.to_string(),
        "https://api.groq.com/openai/v1".to_string(),
        "llama-3.3-70b-versatile".to_string(),
    )
    .await?;
    crate::claude::persist_groq_api_key(trimmed.to_string()).await
}

#[tauri::command]
pub async fn verify_groq_api_key(
    api_key: String,
    base_url: Option<String>,
) -> Result<bool, String> {
    let base = base_url.unwrap_or_else(|| "https://api.groq.com/openai/v1".to_string());
    crate::claude::verify_openai_compatible_api_key(
        api_key,
        base,
        "llama-3.3-70b-versatile".to_string(),
    )
    .await
    .map(|_| true)
}

#[tauri::command]
pub async fn list_groq_models(api_key: String) -> Result<Vec<String>, String> {
    crate::native_agent::openai_compat::list_models("https://api.groq.com/openai/v1", &api_key)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groq_status_serializes_camel_case() {
        let s = GroqCliStatus {
            installed: true,
            binary_path: Some("/usr/bin/groq".into()),
            version: Some("1.0".into()),
            api_key_configured: true,
        };
        let json = serde_json::to_value(&s).unwrap();
        assert!(json.get("apiKeyConfigured").is_some());
    }
}
