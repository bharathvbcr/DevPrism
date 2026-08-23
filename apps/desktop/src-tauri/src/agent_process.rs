//! Shared agent process spawning and stdout streaming for CLI backends
//! (Claude Code, Cursor CLI stream-json fallback).

use std::collections::HashMap;
use std::sync::Arc;

use tauri::{Emitter, Manager, WebviewWindow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone)]
pub struct AgentProcessState {
    pub processes: Arc<Mutex<HashMap<String, Child>>>,
}

impl Default for AgentProcessState {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Back-compat alias used by existing Claude integration.
pub type ClaudeProcessState = AgentProcessState;

#[derive(Clone, serde::Serialize)]
struct AgentOutputEvent {
    tab_id: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct AgentCompleteEvent {
    tab_id: String,
    success: bool,
}

#[derive(Clone, serde::Serialize)]
struct AgentErrorEvent {
    tab_id: String,
    data: String,
}

#[derive(Clone)]
pub struct SpawnProviderMetadata {
    pub provider: &'static str,
    pub provider_credential_id: String,
    pub model: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentStopMode {
    /// User pressed Stop; terminate the run immediately.
    Terminate,
    /// User wants to guide the next turn; prefer a graceful interrupt so
    /// the CLI can persist session state before the frontend resumes it.
    Interrupt,
}

/// Back-compat alias.
pub type ClaudeStopMode = AgentStopMode;

fn process_key(window_label: &str, tab_id: &str) -> String {
    format!("{}:{}", window_label, tab_id)
}

/// Put the agent CLI into its own POSIX process group.
///
/// Claude Code / Cursor spawn tool subprocesses of their own (dev servers,
/// builds). Without a dedicated group, Stop only kills the direct child and
/// those grandchildren survive as orphans. With one, `kill -9 -<pid>` reaches
/// the whole tree.
#[cfg(unix)]
fn spawn_in_new_process_group(cmd: &mut Command) {
    // tokio's Command exposes `pre_exec` directly; no trait import needed.
    unsafe {
        cmd.pre_exec(|| {
            extern "C" {
                fn setpgid(pid: i32, pgid: i32) -> i32;
            }
            if setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn spawn_in_new_process_group(_cmd: &mut Command) {}

/// Optional line transformer (e.g. Cursor stream-json → Claude NDJSON).
pub type LineAdapter = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Spawn an agent CLI process and stream output via Tauri events.
/// Events are emitted only to the originating window, tagged with tab_id.
pub async fn spawn_agent_process(
    window: WebviewWindow,
    mut cmd: Command,
    tab_id: String,
    stdin_payload: Option<String>,
    provider_metadata: Option<SpawnProviderMetadata>,
    line_adapter: Option<LineAdapter>,
    activity_label: &str,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    let process_key = process_key(&window_label, &tab_id);

    if stdin_payload.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }

    spawn_in_new_process_group(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        eprintln!(
            "[agent-spawn] Failed to spawn process for tab {}: {}",
            tab_id, e
        );
        format!("Failed to spawn agent process: {}", e)
    })?;

    if let Some(payload) = stdin_payload {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to acquire stdin for agent process".to_string())?;
        stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("Failed to write prompt to agent process stdin: {}", e))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("Failed to close agent process stdin: {}", e))?;
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let process_arc = window
        .state::<AgentProcessState>()
        .inner()
        .processes
        .clone();

    {
        let mut processes = process_arc.lock().await;
        if let Some(mut existing) = processes.remove(&process_key) {
            let _ = existing.kill().await;
        }
        processes.insert(process_key.clone(), child);
    }

    #[cfg(target_os = "macos")]
    let nap = crate::app_nap::NapActivity::begin(activity_label);

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);
    let result_success_holder: Arc<std::sync::Mutex<Option<bool>>> =
        Arc::new(std::sync::Mutex::new(None));

    let start_time = std::time::Instant::now();

    let win_stdout = window.clone();
    let result_success_stdout = result_success_holder.clone();
    let tab_id_stdout = tab_id.clone();
    let provider_metadata_stdout = provider_metadata.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        let mut line_count: u64 = 0;
        while let Ok(Some(mut line)) = lines.next_line().await {
            line_count += 1;
            let elapsed = start_time.elapsed().as_secs_f64();

            if let Some(adapter) = line_adapter.as_ref() {
                if let Some(adapted) = adapter(&line) {
                    line = adapted;
                } else {
                    continue;
                }
            }

            if let Ok(mut msg) = serde_json::from_str::<serde_json::Value>(&line) {
                let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                let msg_sub = msg.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!(
                    "[agent-stdout] [{}] +{:.1}s #{} type={} sub={} len={}",
                    tab_id_stdout,
                    elapsed,
                    line_count,
                    msg_type,
                    msg_sub,
                    line.len()
                );

                if msg.get("type").and_then(|v| v.as_str()) == Some("system")
                    && msg.get("subtype").and_then(|v| v.as_str()) == Some("init")
                {
                    if let Some(metadata) = provider_metadata_stdout.as_ref() {
                        if let Some(object) = msg.as_object_mut() {
                            object.insert(
                                "provider".to_string(),
                                serde_json::Value::String(metadata.provider.to_string()),
                            );
                            object.insert(
                                "provider_credential_id".to_string(),
                                serde_json::Value::String(metadata.provider_credential_id.clone()),
                            );
                            object.insert(
                                "model".to_string(),
                                serde_json::Value::String(metadata.model.clone()),
                            );
                        }
                        line = msg.to_string();
                    }
                }

                if msg.get("type").and_then(|v| v.as_str()) == Some("result") {
                    let is_success = msg.get("subtype").and_then(|v| v.as_str()) == Some("success");
                    if let Ok(mut guard) = result_success_stdout.lock() {
                        *guard = Some(is_success);
                    }
                }
            }

            let _ = win_stdout.emit(
                "claude-output",
                AgentOutputEvent {
                    tab_id: tab_id_stdout.clone(),
                    data: line,
                },
            );
        }
        eprintln!(
            "[agent-stdout] [{}] stream ended after {} lines ({:.1}s)",
            tab_id_stdout,
            line_count,
            start_time.elapsed().as_secs_f64()
        );
    });

    let win_stderr = window.clone();
    let tab_id_stderr = tab_id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!(
                "[agent-stderr] [{}] +{:.1}s {}",
                tab_id_stderr,
                start_time.elapsed().as_secs_f64(),
                &line[..line.len().min(200)]
            );
            let _ = win_stderr.emit(
                "claude-error",
                AgentErrorEvent {
                    tab_id: tab_id_stderr.clone(),
                    data: line,
                },
            );
        }
    });

    let process_arc_wait = process_arc.clone();
    let win_wait = window;
    let process_key_wait = process_key;
    let tab_id_wait = tab_id;
    let result_success_wait = result_success_holder.clone();
    tokio::spawn(async move {
        #[cfg(target_os = "macos")]
        let _nap = nap;

        let _ = stdout_task.await;
        let _ = stderr_task.await;

        // Take the child out under a short critical section, then wait for it
        // outside the lock — holding the map's mutex across `wait()` would
        // block every other tab's spawn/stop while this child lingers.
        let mut child_opt = {
            let mut processes = process_arc_wait.lock().await;
            processes.remove(&process_key_wait)
        };
        let success = if let Some(ref mut child) = child_opt {
            match child.wait().await {
                Ok(status) => {
                    let exit_success = status.success();
                    let result_success = result_success_wait.lock().ok().and_then(|guard| *guard);
                    let success = exit_success || result_success == Some(true);
                    eprintln!(
                        "[agent-process] [{}] exited with status={} result_success={:?} final_success={} ({:.1}s)",
                        tab_id_wait,
                        status,
                        result_success,
                        success,
                        start_time.elapsed().as_secs_f64()
                    );
                    success
                }
                Err(e) => {
                    eprintln!(
                        "[agent-process] [{}] wait error: {} ({:.1}s)",
                        tab_id_wait,
                        e,
                        start_time.elapsed().as_secs_f64()
                    );
                    false
                }
            }
        } else {
            eprintln!(
                "[agent-process] [{}] no child found in map ({:.1}s)",
                tab_id_wait,
                start_time.elapsed().as_secs_f64()
            );
            false
        };

        let _ = win_wait.emit(
            "claude-complete",
            AgentCompleteEvent {
                tab_id: tab_id_wait,
                success,
            },
        );
    });

    Ok(())
}

/// Back-compat wrapper for Claude Code spawn path.
pub async fn spawn_claude_process(
    window: WebviewWindow,
    cmd: Command,
    tab_id: String,
    stdin_payload: Option<String>,
    provider_metadata: Option<SpawnProviderMetadata>,
) -> Result<(), String> {
    spawn_agent_process(
        window,
        cmd,
        tab_id,
        stdin_payload,
        provider_metadata,
        None,
        "Claude Code session",
    )
    .await
}

pub async fn stop_agent_process(
    window: WebviewWindow,
    tab_id: String,
    mode: AgentStopMode,
) -> Result<bool, String> {
    let window_label = window.label().to_string();
    let process_key = process_key(&window_label, &tab_id);
    let agent_state = window.state::<AgentProcessState>();
    let mut processes = agent_state.processes.lock().await;
    if let Some(mut child) = processes.remove(&process_key) {
        drop(processes);
        let stopped = match mode {
            AgentStopMode::Terminate => {
                terminate_process_tree(&mut child).await;
                true
            }
            AgentStopMode::Interrupt => interrupt_or_terminate(&mut child).await,
        };
        return Ok(stopped);
    }
    drop(processes);

    let _ = window.emit(
        "claude-complete",
        AgentCompleteEvent {
            tab_id,
            success: false,
        },
    );
    Ok(false)
}

/// Back-compat alias.
pub async fn stop_claude_process(
    window: WebviewWindow,
    tab_id: String,
    mode: AgentStopMode,
) -> Result<bool, String> {
    stop_agent_process(window, tab_id, mode).await
}

#[cfg(unix)]
async fn interrupt_or_terminate(child: &mut Child) -> bool {
    if let Some(pid) = child.id() {
        // Signal the whole process group (negative pid), not just the CLI.
        let status = tokio::process::Command::new("kill")
            .arg("-INT")
            .arg(format!("-{}", pid))
            .status()
            .await;
        if matches!(status, Ok(status) if status.success()) {
            // Grace period: the CLI should persist session state and exit. If
            // it ignores SIGINT we escalate — otherwise the stdout readers
            // keep emitting into a stopped tab and `claude-complete` never
            // fires.
            const GRACE_POLLS: usize = 10; // 10 × 500ms = 5s
            for _ in 0..GRACE_POLLS {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                match child.try_wait() {
                    Ok(Some(_)) => return true,
                    Ok(None) => continue,
                    Err(_) => break,
                }
            }
            terminate_process_tree(child).await;
            return true;
        }
    }
    terminate_process_tree(child).await;
    true
}

#[cfg(not(unix))]
async fn interrupt_or_terminate(child: &mut Child) -> bool {
    terminate_process_tree(child).await;
    true
}

#[cfg(windows)]
async fn terminate_process_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .await;
    }
    let _ = child.start_kill();
}

#[cfg(not(windows))]
async fn terminate_process_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        // The child runs in its own process group (see
        // `spawn_in_new_process_group`); a negative pid targets the whole
        // group so CLI-spawned tool subprocesses die too. If the group does
        // not exist (child already gone, or setpgid unavailable), the signal
        // fails harmlessly and the direct-kill below still applies.
        let _ = tokio::process::Command::new("kill")
            .arg("-9")
            .arg(format!("-{}", pid))
            .status()
            .await;
    }
    let _ = child.start_kill();
}

/// Kill all agent processes associated with a specific window label.
pub async fn kill_process_for_window(state: &AgentProcessState, window_label: &str) {
    let mut processes = state.processes.lock().await;
    let prefix = format!("{}:", window_label);
    let keys_to_remove: Vec<String> = processes
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();
    for key in keys_to_remove {
        if let Some(mut child) = processes.remove(&key) {
            let _ = child.kill().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_stop_mode_alias_matches() {
        assert_eq!(ClaudeStopMode::Terminate, AgentStopMode::Terminate);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminate_process_tree_kills_the_whole_group() {
        // The agent CLI spawns tool subprocesses of its own. Stop must reach
        // them, not just the direct child.
        let mut cmd = tokio::process::Command::new("sh");
        cmd.args(["-c", "sleep 30 & wait"]);
        spawn_in_new_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let pid = child.id().expect("pid");

        // Give setpgid a moment to take effect.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        // Precondition: the group exists (proves the child leads its own
        // group, so the negative-pid kill below targets it).
        let group_members = |pid: u32| {
            tokio::process::Command::new("pgrep")
                .arg("-g")
                .arg(pid.to_string())
                .output()
        };
        let before = group_members(pid).await.expect("run pgrep");
        assert!(
            !before.status.success() || !before.stdout.is_empty(),
            "expected the child to lead its own process group"
        );

        terminate_process_tree(&mut child).await;
        let _ = child.wait().await;

        // Orphaned grandchildren must be gone too.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let after = group_members(pid).await.expect("run pgrep");
        assert!(
            after.stdout.is_empty(),
            "processes survived the group kill: {:?}",
            String::from_utf8_lossy(&after.stdout)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn interrupt_escales_to_termination_when_sigint_is_ignored() {
        // `sh trap '' INT` ignores SIGINT; the interrupt path must not hang
        // forever waiting for a CLI that never exits.
        let mut cmd = tokio::process::Command::new("sh");
        cmd.args(["-c", "trap '' INT; while :; do :; done"]);
        spawn_in_new_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let started = std::time::Instant::now();
        let stopped = interrupt_or_terminate(&mut child).await;
        assert!(stopped);
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(15),
            "interrupt took {elapsed:?} — escalation missing?"
        );
        let status = child.wait().await.expect("wait");
        assert!(!status.success(), "child should have been killed");
    }
}
