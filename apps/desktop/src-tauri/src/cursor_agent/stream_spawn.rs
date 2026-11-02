//! Cursor CLI stream-json spawn path (fallback when ACP is unavailable).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::WebviewWindow;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::agent_process::{
    spawn_agent_process, stop_agent_process, AgentStopMode, SpawnProviderMetadata,
};

use super::acp_client;
use super::setup::{find_agent_binary, stored_cursor_api_key};
use super::stream_adapter;

/// Puts the stored Cursor key on this child only. Does not touch the process env.
fn attach_cursor_api_key(cmd: &mut Command, key: Option<&str>) {
    if let Some(key) = key.map(str::trim).filter(|key| !key.is_empty()) {
        cmd.env("CURSOR_API_KEY", key);
    }
}

fn cursor_print_command(
    agent_path: &str,
    cwd: &str,
    args: Vec<String>,
    api_key: Option<&str>,
) -> Command {
    let mut cmd = Command::new(agent_path);
    cmd.args(args);
    cmd.current_dir(cwd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    attach_cursor_api_key(&mut cmd, api_key);
    cmd
}

fn cursor_system_prompt(project_path: &str) -> String {
    let mut system_prompt = String::from(
        "You are an AI assistant integrated into a LaTeX document editor (Prism). \
         Follow planning-first, incremental edit rules. Preserve existing LaTeX structure. \
         If PROJECT CONTEXT lists a DevCouncil repo map (`.devcouncil/repo_map.json`), \
         open it before broad exploration and prefer its subsystems/entry points.",
    );
    system_prompt.push_str(&crate::project_context::build_project_context_prompt(
        std::path::Path::new(project_path),
    ));
    system_prompt.push_str(&crate::personalization::build_personalization_prompt());
    system_prompt
}

fn build_stream_command(
    agent_path: &str,
    project_path: &str,
    prompt: &str,
    resume_session_id: Option<&str>,
) -> Command {
    // Same source as ACP: the auth file (or an already-present env var), not set_var.
    build_stream_command_with_key(
        agent_path,
        project_path,
        prompt,
        resume_session_id,
        stored_cursor_api_key().as_deref(),
    )
}

fn build_stream_command_with_key(
    agent_path: &str,
    project_path: &str,
    prompt: &str,
    resume_session_id: Option<&str>,
    api_key: Option<&str>,
) -> Command {
    let system = cursor_system_prompt(project_path);
    let full_prompt = format!("{system}\n\n---\n\n{prompt}");
    let mut args = vec![
        "-p".to_string(),
        "--force".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--stream-partial-output".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];
    if let Some(sid) = resume_session_id {
        args.push("--resume".to_string());
        args.push(sid.to_string());
    }
    args.push(full_prompt);

    let mut cmd = Command::new(agent_path);
    cmd.args(args);
    cmd.current_dir(project_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    attach_cursor_api_key(&mut cmd, api_key);
    cmd
}

async fn run_cursor_agent(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    resume_session_id: Option<String>,
    use_acp: bool,
) -> Result<(), String> {
    if use_acp {
        match acp_client::run_acp_session(
            window.clone(),
            &project_path,
            &prompt,
            &tab_id,
            resume_session_id.as_deref(),
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(e) => {
                eprintln!("[cursor-agent] ACP failed ({e}), falling back to stream-json");
            }
        }
    }

    let agent_path = find_agent_binary()?;
    let cmd = build_stream_command(
        &agent_path,
        &project_path,
        &prompt,
        resume_session_id.as_deref(),
    );

    let adapter: Arc<dyn Fn(&str) -> Option<String> + Send + Sync> =
        Arc::new(|line| stream_adapter::adapt_cursor_line(line));

    spawn_agent_process(
        window,
        cmd,
        tab_id,
        None,
        Some(SpawnProviderMetadata {
            provider: "cursor",
            provider_credential_id: "__cursor-cli__".to_string(),
            model: "cursor-agent".to_string(),
        }),
        Some(adapter),
        "Cursor CLI session",
    )
    .await
}

#[tauri::command]
pub async fn execute_cursor_agent(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    use_acp: Option<bool>,
) -> Result<(), String> {
    run_cursor_agent(
        window,
        project_path,
        prompt,
        tab_id,
        None,
        use_acp.unwrap_or(true),
    )
    .await
}

#[tauri::command]
pub async fn resume_cursor_agent(
    window: WebviewWindow,
    project_path: String,
    session_id: String,
    prompt: String,
    tab_id: String,
    use_acp: Option<bool>,
) -> Result<(), String> {
    run_cursor_agent(
        window,
        project_path,
        prompt,
        tab_id,
        Some(session_id),
        use_acp.unwrap_or(true),
    )
    .await
}

#[tauri::command]
pub async fn cancel_cursor_agent(window: WebviewWindow, tab_id: String) -> Result<bool, String> {
    let _ = acp_client::cancel_acp_session(&tab_id).await;
    stop_agent_process(window, tab_id, AgentStopMode::Terminate).await
}

/// One-shot Cursor CLI print-mode completion (`agent -p --output-format text`).
pub async fn complete_cursor_print(
    prompt: &str,
    system: Option<&str>,
    cancel_flag: Option<Arc<AtomicBool>>,
    cancel_notify: Option<Arc<Notify>>,
) -> Result<String, String> {
    /// Hard ceiling for Cursor CLI `-p` (print) completions used by synthesis/assist.
    const PRINT_TIMEOUT_SECS: u64 = 300;

    let user = prompt.trim();
    if user.is_empty() {
        return Err("Prompt is empty.".into());
    }
    if cancel_flag
        .as_ref()
        .is_some_and(|f| f.load(Ordering::Relaxed))
    {
        return Err("cancelled".into());
    }

    let agent_path = find_agent_binary()?;
    let cwd = std::env::temp_dir();
    let cwd_str = cwd.to_string_lossy().to_string();

    let mut full_prompt = String::new();
    if let Some(sys) = system.map(str::trim).filter(|s| !s.is_empty()) {
        full_prompt.push_str(sys);
        full_prompt.push_str("\n\n---\n\n");
    }
    full_prompt.push_str(user);

    let args = vec![
        "-p".to_string(),
        "--force".to_string(),
        "--output-format".to_string(),
        "text".to_string(),
        "--dangerously-skip-permissions".to_string(),
        full_prompt,
    ];

    let mut cmd = cursor_print_command(
        &agent_path,
        &cwd_str,
        args,
        stored_cursor_api_key().as_deref(),
    );
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Cursor CLI: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Cursor CLI stdout missing".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();

    let read_stdout = async {
        reader
            .read_to_end(&mut buf)
            .await
            .map_err(|e| format!("Failed to read Cursor CLI output: {e}"))
    };

    let deadline = tokio::time::sleep(std::time::Duration::from_secs(PRINT_TIMEOUT_SECS));
    tokio::pin!(deadline);

    let outcome = if let Some(notify) = cancel_notify {
        tokio::select! {
            _ = notify.notified() => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err("cancelled".into())
            }
            _ = &mut deadline => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err(format!(
                    "[E_CLI_TIMEOUT] Cursor CLI print mode timed out after {PRINT_TIMEOUT_SECS}s."
                ))
            }
            read = read_stdout => {
                read?;
                let status = child
                    .wait()
                    .await
                    .map_err(|e| format!("Cursor CLI wait failed: {e}"))?;
                if !status.success() {
                    let preview = String::from_utf8_lossy(&buf);
                    return Err(format!(
                        "Cursor CLI exited with status {status}. Output: {}",
                        preview.chars().take(400).collect::<String>()
                    ));
                }
                let text = String::from_utf8_lossy(&buf).trim().to_string();
                if text.is_empty() {
                    Err("Cursor CLI returned an empty response.".into())
                } else {
                    Ok(text)
                }
            }
        }
    } else {
        tokio::select! {
            _ = &mut deadline => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err(format!(
                    "[E_CLI_TIMEOUT] Cursor CLI print mode timed out after {PRINT_TIMEOUT_SECS}s."
                ))
            }
            read = read_stdout => {
                read?;
                let status = child
                    .wait()
                    .await
                    .map_err(|e| format!("Cursor CLI wait failed: {e}"))?;
                if !status.success() {
                    let preview = String::from_utf8_lossy(&buf);
                    return Err(format!(
                        "Cursor CLI exited with status {status}. Output: {}",
                        preview.chars().take(400).collect::<String>()
                    ));
                }
                let text = String::from_utf8_lossy(&buf).trim().to_string();
                if text.is_empty() {
                    Err("Cursor CLI returned an empty response.".into())
                } else {
                    Ok(text)
                }
            }
        }
    };

    if cancel_flag
        .as_ref()
        .is_some_and(|f| f.load(Ordering::Relaxed))
    {
        return Err("cancelled".into());
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cursor_key_override(cmd: &Command) -> Option<String> {
        cmd.as_std().get_envs().find_map(|(name, value)| {
            (name == "CURSOR_API_KEY").then(|| {
                value
                    .map(|v| v.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
        })
    }

    #[test]
    fn adv_cred_stream_json_command_receives_saved_cursor_key() {
        let parent = std::env::var_os("CURSOR_API_KEY");
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path().to_str().expect("utf8 cwd");
        let key = "test-key-not-a-secret";

        let stream =
            build_stream_command_with_key("/usr/bin/true", cwd, "prompt", None, Some(key));
        assert_eq!(cursor_key_override(&stream).as_deref(), Some(key));

        let print = cursor_print_command("/usr/bin/true", cwd, vec!["-p".to_string()], Some(key));
        assert_eq!(cursor_key_override(&print).as_deref(), Some(key));

        let blank =
            cursor_print_command("/usr/bin/true", cwd, vec!["-p".to_string()], Some(" \t"));
        assert!(
            cursor_key_override(&blank).is_none(),
            "a blank key must not be placed on the child"
        );
        assert_eq!(
            std::env::var_os("CURSOR_API_KEY"),
            parent,
            "building the command must not change the process environment"
        );

        let src = include_str!("stream_spawn.rs");
        let prod = src.split("\n#[cfg(test)]").next().expect("production source");
        let stream_fn = prod
            .split("fn build_stream_command(")
            .nth(1)
            .expect("build_stream_command");
        let stream_fn = stream_fn
            .split("fn build_stream_command_with_key(")
            .next()
            .expect("stream wrapper");
        assert!(
            stream_fn.contains("stored_cursor_api_key().as_deref()"),
            "stream-json must pass the stored key into the command that sets CURSOR_API_KEY"
        );
        let print_fn = prod
            .split("pub async fn complete_cursor_print(")
            .nth(1)
            .expect("complete_cursor_print");
        assert!(
            print_fn.contains("stored_cursor_api_key().as_deref()"),
            "print mode must pass the stored key into the command that sets CURSOR_API_KEY"
        );
        assert!(
            !prod.contains("set_var("),
            "stream spawn must not set the process environment"
        );
    }
}
