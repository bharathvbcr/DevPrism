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
use super::setup::find_agent_binary;
use super::stream_adapter;

fn cursor_system_prompt(project_path: &str) -> String {
    let mut system_prompt = String::from(
        "You are an AI assistant integrated into a LaTeX document editor (Prism). \
         Follow planning-first, incremental edit rules. Preserve existing LaTeX structure.",
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

    let mut cmd = Command::new(&agent_path);
    cmd.args(args);
    cmd.current_dir(&cwd_str);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
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
