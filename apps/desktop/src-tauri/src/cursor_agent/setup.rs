//! Cursor `agent` binary discovery, install, and auth status.

use std::process::Command as SyncCommand;

use tauri::{Emitter, WebviewWindow};

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CursorCliStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
}

pub fn find_agent_binary() -> Result<String, String> {
    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "windows")]
        let native = home.join(".local").join("bin").join("agent.exe");
        #[cfg(not(target_os = "windows"))]
        let native = home.join(".local").join("bin").join("agent");
        if native.exists() {
            return Ok(native.to_string_lossy().into_owned());
        }
    }

    if let Ok(path) = which::which("agent") {
        return Ok(path.to_string_lossy().into_owned());
    }

    Err("Cursor agent CLI not found".into())
}

pub(crate) fn stored_cursor_api_key() -> Option<String> {
    if let Ok(key) = std::env::var("CURSOR_API_KEY") {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    crate::claude::stored_cursor_api_key()
}

fn cursor_authenticated() -> bool {
    if stored_cursor_api_key().is_some() {
        return true;
    }
    if let Ok(home) = std::env::var("HOME") {
        let cred = std::path::Path::new(&home)
            .join(".cursor")
            .join("credentials");
        if cred.exists() {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn check_cursor_cli_status() -> Result<CursorCliStatus, String> {
    match find_agent_binary() {
        Ok(binary_path) => {
            let mut version_cmd = SyncCommand::new(&binary_path);
            version_cmd.arg("--version");
            apply_stored_cursor_api_key(&mut version_cmd);
            let version = version_cmd
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
            let mut whoami = SyncCommand::new(&binary_path);
            whoami.args(["whoami"]);
            apply_stored_cursor_api_key(&mut whoami);
            let authenticated = cursor_authenticated()
                || whoami
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
            Ok(CursorCliStatus {
                installed: version.is_some(),
                authenticated,
                binary_path: Some(binary_path),
                version,
            })
        }
        Err(_) => Ok(CursorCliStatus {
            installed: false,
            authenticated: cursor_authenticated(),
            binary_path: None,
            version: None,
        }),
    }
}

#[tauri::command]
pub async fn install_cursor_cli(window: WebviewWindow) -> Result<bool, String> {
    let _ = window.emit("install-output", "Installing Cursor CLI…");

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", "curl https://cursor.com/install -fsS | bash"]);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell");
        c.args([
            "-NoProfile",
            "-Command",
            "irm https://cursor.com/install.ps1 | iex",
        ]);
        c
    };

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start Cursor install: {e}"))?;

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
        return Err("Cursor CLI install failed.".into());
    }
    find_agent_binary().map_err(|e| format!("Installed but not found: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn login_cursor_cli(window: WebviewWindow) -> Result<bool, String> {
    let binary = find_agent_binary()?;
    let _ = window.emit("install-output", "Opening Cursor login flow…");
    let mut cmd = SyncCommand::new(&binary);
    cmd.arg("login");
    apply_stored_cursor_api_key(&mut cmd);
    let status = cmd
        .status()
        .map_err(|e| format!("Failed to run agent login: {e}"))?;
    Ok(status.success())
}

#[tauri::command]
pub async fn save_cursor_api_key(api_key: String) -> Result<bool, String> {
    if api_key.trim().is_empty() {
        return Err("API key is required".into());
    }
    crate::claude::persist_cursor_api_key(api_key.trim())?;
    // Do not set process-global env. Agent commands receive CURSOR_API_KEY
    // via Command::env. The JSON auth file may still hold the secret (F-13
    // keychain storage was not chosen).
    Ok(true)
}

fn apply_cursor_api_key_env(cmd: &mut SyncCommand, api_key: &str) {
    let key = api_key.trim();
    if !key.is_empty() {
        cmd.env("CURSOR_API_KEY", key);
    }
}

fn apply_stored_cursor_api_key(cmd: &mut SyncCommand) {
    if let Some(key) = stored_cursor_api_key() {
        apply_cursor_api_key_env(cmd, &key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn cursor_api_key_goes_to_the_child_not_the_process() {
        let before = std::env::var("CURSOR_API_KEY").ok();
        let mut cmd = SyncCommand::new("sh");
        cmd.args(["-c", "printf %s \"$CURSOR_API_KEY\""]);
        apply_cursor_api_key_env(&mut cmd, "test-key-not-a-secret");
        let output = cmd.output().expect("sh");
        assert!(output.status.success(), "sh failed");
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "test-key-not-a-secret"
        );
        assert_eq!(std::env::var("CURSOR_API_KEY").ok(), before);
    }

    #[test]
    fn adv_cred_setup_does_not_call_set_var() {
        let src = include_str!("setup.rs");
        let prod = src
            .split("#[cfg(test)]\nmod tests {")
            .next()
            .expect("production source");
        for line in prod.lines() {
            let code = line.split("//").next().unwrap_or(line);
            assert!(
                !code.contains("set_var"),
                "set_var must be gone from cursor setup: {line}"
            );
        }
    }
}
