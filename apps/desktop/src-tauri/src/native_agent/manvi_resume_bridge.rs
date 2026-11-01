//! Manvi NDJSON-over-stdio bridge and `--approve-fd 3` human-in-the-loop IPC.
//!
//! Connects DevPrism's Tauri host with the Manvi autonomous agent harness.
//! Operates via standard I/O (stdio) and dedicated file descriptors (fd 3)
//! rather than cgo, isolating memory spaces and preserving static compilation.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, WebviewWindow};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

/// Environment variable to explicitly override the Manvi binary location.
pub const BIN_ENV: &str = "DEVPRISM_MANVI_BIN";

/// Maximum length of a single line parsed over the NDJSON stream (8 MiB).
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Circular stderr buffer bound (64 KiB).
pub const MAX_STDERR_TAIL_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManviStatusResponse {
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub local_models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaniTailorRequest {
    pub master_path: String,
    pub job_description: String,
    pub target_page_budget: u32,
    pub strict_metrics: bool,
    #[serde(default)]
    pub persona_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaniTailorResult {
    pub run_id: String,
    pub status: String,
    pub rewritten_content: String,
    pub ats_score: u32,
    pub metrics_preserved: bool,
    pub phases_completed: u32,
}

#[derive(Debug, Clone)]
pub struct ApprovalDecision {
    pub allow: bool,
    pub chosen: Option<Vec<String>>,
    pub write_in: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug)]
pub struct PendingApproval {
    pub approval_id: String,
    pub prompt: String,
    pub options: Vec<String>,
    pub default_choice: Option<String>,
    pub sender: tokio::sync::oneshot::Sender<ApprovalDecision>,
}

pub struct ActiveRun {
    pub run_id: String,
    pub cancelled: Arc<AtomicBool>,
    pub pending_approval: Option<PendingApproval>,
    #[cfg(unix)]
    pub child_pid: Option<u32>,
}

fn get_active_runs() -> &'static Mutex<HashMap<String, ActiveRun>> {
    static ACTIVE_RUNS: OnceLock<Mutex<HashMap<String, ActiveRun>>> = OnceLock::new();
    ACTIVE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ─── Binary Resolution ───

/// Resolve the sidecar binary.
///
/// Order:
/// 1. `DEVPRISM_MANVI_BIN` environment override.
/// 2. Plain `manvi` beside current executable.
/// 3. Newer of checkout sidecar vs `PATH`.
pub fn resolve_binary() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var(BIN_ENV) {
        let p = PathBuf::from(raw.trim());
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!(
            "{BIN_ENV} points at {}, which is not a file",
            p.display()
        ));
    }

    if let Some(bundled) = beside_executable() {
        return Ok(bundled);
    }

    let on_path = which::which("manvi").ok();
    if let Some(path) = pick_dev_binary(checkout_sidecar(), on_path) {
        return Ok(path);
    }

    Err(format!(
        "no manvi binary found (set {BIN_ENV}, place one beside the app, \
         build it with `node scripts/build-manvi.mjs`, or put `manvi` on PATH)"
    ))
}

fn host_rust_triple() -> String {
    let os = match std::env::consts::OS {
        "macos" => "apple-darwin",
        "linux" => "unknown-linux-gnu",
        "windows" => "pc-windows-msvc",
        other => other,
    };
    format!("{}-{os}", std::env::consts::ARCH)
}

fn checkout_sidecar() -> Option<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let triple = host_rust_triple();
    for name in [format!("manvi-{triple}"), format!("manvi-{triple}.exe")] {
        let path = dir.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn beside_executable() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let mut roots = vec![dir.to_path_buf()];
    if dir.ends_with("deps") {
        if let Some(parent) = dir.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    for root in roots {
        for candidate in ["manvi", "manvi.exe"] {
            let path = root.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

pub fn pick_dev_binary(checkout: Option<PathBuf>, path_bin: Option<PathBuf>) -> Option<PathBuf> {
    match (checkout, path_bin) {
        (Some(c), None) => Some(c),
        (None, Some(p)) => Some(p),
        (None, None) => None,
        (Some(c), Some(p)) => {
            let c_mtime = std::fs::metadata(&c).and_then(|m| m.modified()).ok();
            let p_mtime = std::fs::metadata(&p).and_then(|m| m.modified()).ok();
            match (c_mtime, p_mtime) {
                (Some(cm), Some(pm)) => {
                    if pm > cm {
                        Some(p)
                    } else {
                        Some(c)
                    }
                }
                (Some(_), None) => Some(c),
                (None, Some(_)) => Some(p),
                (None, None) => Some(c),
            }
        }
    }
}

// ─── Protocol Formatting & Parsing ───

/// Formats a single-line JSON approval decision string for writing to fd 3.
/// Guarantees trailing newline `\n` and no null fields.
pub fn format_decision_line(
    approval_id: &str,
    allow: bool,
    chosen: Option<&[String]>,
    write_in: Option<&str>,
    reason: Option<&str>,
) -> String {
    let chosen_val = chosen
        .map(|c| serde_json::to_value(c).unwrap_or(Value::Array(vec![])))
        .unwrap_or(Value::Array(vec![]));
    let line = json!({
        "approval_id": approval_id,
        "allow": allow,
        "chosen": chosen_val,
        "write_in": write_in.unwrap_or(""),
        "reason": reason.unwrap_or(""),
    });
    format!("{}\n", serde_json::to_string(&line).unwrap_or_default())
}

/// Parses an NDJSON stream line.
/// Skips preambles, non-JSON logs, and oversized lines.
pub fn parse_ndjson_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_LINE_BYTES {
        return None;
    }
    if !trimmed.starts_with('{') {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

/// Translates child process exit status to a structured diagnostic message.
pub fn translate_exit_code(code: Option<i32>, stderr_tail: &str) -> String {
    match code {
        Some(0) => "Run completed successfully.".to_string(),
        Some(1) => {
            if stderr_tail.trim().is_empty() {
                "Run failed with generic error.".to_string()
            } else {
                format!("Run failed: {}", stderr_tail.trim())
            }
        }
        Some(2) => "The step ceiling ended the turn; the work is not complete.".to_string(),
        Some(3) => "Output cap cut the final answer off mid-sentence.".to_string(),
        Some(4) => "Turn ended without an answer (model had nothing to say).".to_string(),
        Some(5) => {
            "Turn ended without finishing (connection dropped or model refused).".to_string()
        }
        Some(137) => "Process killed by SIGKILL (fatal: out of memory).".to_string(),
        Some(c) => {
            if stderr_tail.trim().is_empty() {
                format!("Process exited with status code {c}.")
            } else {
                format!(
                    "Process exited with status code {c}: {}",
                    stderr_tail.trim()
                )
            }
        }
        None => "Process terminated by signal.".to_string(),
    }
}

// ─── Tauri Commands ───

/// Probes whether Manvi is installed, reachable, and what models are available.
#[tauri::command]
pub async fn manvi_check_status(
    _project_path: Option<String>,
) -> Result<ManviStatusResponse, String> {
    match resolve_binary() {
        Ok(bin) => {
            let version = get_binary_version(&bin).await;
            Ok(ManviStatusResponse {
                available: true,
                binary_path: Some(bin.to_string_lossy().to_string()),
                version,
                local_models: vec![],
            })
        }
        Err(_) => Ok(ManviStatusResponse {
            available: false,
            binary_path: None,
            version: None,
            local_models: vec![],
        }),
    }
}

async fn get_binary_version(bin: &Path) -> Option<String> {
    let output = tokio::process::Command::new(bin)
        .arg("--version")
        .output()
        .await
        .ok()?;
    if output.status.success() {
        let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !v.is_empty() {
            return Some(v);
        }
    }
    None
}

#[cfg(unix)]
pub const GRACE_PERIOD_PROD: std::time::Duration = std::time::Duration::from_secs(3);
#[cfg(unix)]
pub const GRACE_PERIOD_TEST: std::time::Duration = std::time::Duration::from_millis(500);

/// Validates that a PID is strictly safe to target for process group signaling.
/// Rejects PID 0 (calling process group), PID 1 (init/launchd broadcast), and overflow.
#[cfg(unix)]
pub fn validate_child_pid(pid: u32) -> Result<libc::pid_t, &'static str> {
    if pid <= 1 {
        return Err(
            "PID must be greater than 1 (PID 0 targets caller, PID 1 targets init/broadcast)",
        );
    }
    if pid > i32::MAX as u32 {
        return Err("PID exceeds maximum signed pid_t range");
    }
    Ok(pid as libc::pid_t)
}

/// Dispatches a signal directly to the child process group via `libc::kill`.
/// Treats ESRCH and macOS zombie EPERM as normal termination (benign race condition).
#[cfg(unix)]
pub fn send_signal_to_process_group(pid: u32, sig: libc::c_int) -> Result<(), std::io::Error> {
    let valid_pid = validate_child_pid(pid)
        .map_err(|msg| std::io::Error::new(std::io::ErrorKind::InvalidInput, msg))?;

    let target_pgid = -valid_pid;
    let res = unsafe { libc::kill(target_pgid, sig) };
    if res != 0 {
        let err = std::io::Error::last_os_error();
        let code = err.raw_os_error();
        if code == Some(libc::ESRCH) || (cfg!(target_os = "macos") && code == Some(libc::EPERM)) {
            return Ok(());
        }
        return Err(err);
    }
    Ok(())
}

/// Spawns a background escalation task:
/// 1. Dispatches SIGINT immediately to the process group.
/// 2. Polls every 100ms for child process group exit.
/// 3. If child has not exited within `grace_period`, escalates to SIGKILL.
#[cfg(unix)]
pub fn spawn_signal_escalation(
    pid: u32,
    grace_period: std::time::Duration,
) -> Option<tokio::task::JoinHandle<()>> {
    let valid_pid = validate_child_pid(pid).ok()?;
    let target_pgid = -valid_pid;

    // Initial graceful termination request
    let _ = send_signal_to_process_group(pid, libc::SIGINT);

    Some(tokio::spawn(async move {
        let step = std::time::Duration::from_millis(100);
        let mut elapsed = std::time::Duration::ZERO;

        while elapsed < grace_period {
            tokio::time::sleep(step).await;
            elapsed += step;

            // Probe liveness using kill(-pgid, 0)
            let ret = unsafe { libc::kill(target_pgid, 0) };
            if ret != 0 {
                let err = std::io::Error::last_os_error();
                let code = err.raw_os_error();
                if code == Some(libc::ESRCH)
                    || (cfg!(target_os = "macos") && code == Some(libc::EPERM))
                {
                    // Process group has exited cleanly
                    return;
                }
            }
        }

        // Child process group ignored SIGINT; escalate to unconditional SIGKILL
        let _ = send_signal_to_process_group(pid, libc::SIGKILL);
    }))
}

/// Atomically resolves a pending approval under ACTIVE_RUNS.
fn dispatch_approval_decision(
    run_id: Option<&str>,
    approval_id: &str,
    decision: ApprovalDecision,
) -> bool {
    let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());

    // 1. Direct O(1) lookup if run_id is known
    if let Some(rid) = run_id {
        if let Some(run) = runs.get_mut(rid) {
            if run
                .pending_approval
                .as_ref()
                .map(|p| p.approval_id.as_str())
                == Some(approval_id)
            {
                if let Some(pending) = run.pending_approval.take() {
                    let _ = pending.sender.send(decision);
                    return true;
                }
            }
        }
    }

    // 2. Fallback scan across active runs
    for run in runs.values_mut() {
        if run
            .pending_approval
            .as_ref()
            .map(|p| p.approval_id.as_str())
            == Some(approval_id)
        {
            if let Some(pending) = run.pending_approval.take() {
                let _ = pending.sender.send(decision);
                return true;
            }
        }
    }

    false
}

/// Dispatches an approval decision from the UI for a pending approval request.
#[tauri::command]
pub async fn manvi_approve_action(
    approval_id: String,
    allow: bool,
    chosen: Option<String>,
    write_in: Option<String>,
    reason: Option<String>,
) -> Result<(), String> {
    dispatch_approval_decision(
        None,
        &approval_id,
        ApprovalDecision {
            allow,
            chosen: chosen.map(|c| vec![c]),
            write_in,
            reason,
        },
    );
    Ok(())
}

/// Dispatches an approval decision with optional multi-select choices.
#[tauri::command]
pub async fn manvi_send_approval(
    run_id: String,
    approval_id: String,
    allow: bool,
    chosen: Option<Vec<String>>,
    write_in: Option<String>,
    reason: Option<String>,
) -> Result<(), String> {
    let rid = if run_id.is_empty() {
        None
    } else {
        Some(run_id.as_str())
    };
    dispatch_approval_decision(
        rid,
        &approval_id,
        ApprovalDecision {
            allow,
            chosen,
            write_in,
            reason,
        },
    );
    Ok(())
}

/// Cancels an in-flight agent run and notifies UI.
#[tauri::command]
pub async fn manvi_cancel_run(window: WebviewWindow, run_id: String) -> Result<(), String> {
    let (pending_sender, child_pid) = {
        let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut run) = runs.remove(&run_id) {
            run.cancelled.store(true, Ordering::SeqCst);
            let sender = run.pending_approval.take().map(|p| p.sender);
            (sender, {
                #[cfg(unix)]
                {
                    run.child_pid
                }
                #[cfg(not(unix))]
                {
                    None
                }
            })
        } else {
            (None, None)
        }
    };

    if let Some(sender) = pending_sender {
        let _ = sender.send(ApprovalDecision {
            allow: false,
            chosen: None,
            write_in: None,
            reason: Some("Run cancelled".to_string()),
        });
    }

    #[cfg(unix)]
    if let Some(pid) = child_pid {
        let is_test = std::env::var("DEVPRISM_TEST_MODE").is_ok()
            || std::env::var("DEVPRISM_HEADLESS_TEST").is_ok();
        let grace = if is_test {
            GRACE_PERIOD_TEST
        } else {
            GRACE_PERIOD_PROD
        };
        spawn_signal_escalation(pid, grace);
    }

    let _ = window.emit("vani://tailor-cancelled", json!({ "runId": run_id }));
    Ok(())
}

/// Tailors a resume with interactive step progress and human-in-the-loop approval.
#[tauri::command]
pub async fn manvi_tailor_resume(
    window: WebviewWindow,
    request: VaniTailorRequest,
) -> Result<VaniTailorResult, String> {
    let jd = request.job_description.trim();
    if jd.is_empty() {
        return Err("Job description cannot be empty.".to_string());
    }

    let bin = resolve_binary()?;

    #[cfg(not(unix))]
    {
        let _ = (window, request, bin);
        return Err("Manvi resume tailoring requires POSIX approve fd (fd 3). This platform is not supported.".to_string());
    }

    #[cfg(unix)]
    {
        let (read_pipe, mut write_pipe) =
            std::io::pipe().map_err(|e| format!("Could not open approve pipe: {e}"))?;
        let read_fd = std::os::fd::AsRawFd::as_raw_fd(&read_pipe);

        let prompt = format!(
            "Tailor resume from '{}' for job description:\n{}\nTarget page budget: {}, strict metrics: {}",
            request.master_path,
            jd,
            request.target_page_budget,
            request.strict_metrics,
        );

        let mut cmd = tokio::process::Command::new(&bin);
        cmd.args(["run", "--json", "--approve-fd", "3", "--mcp", "devprism"]);
        cmd.arg("-p");
        cmd.arg(&prompt);

        let master_p = Path::new(&request.master_path);
        if let Some(parent) = master_p.parent() {
            if parent.is_dir() {
                cmd.current_dir(parent);
            }
        }
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.stdin(std::process::Stdio::null());

        const APPROVE_FD: i32 = 3;
        unsafe {
            cmd.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::dup2(read_fd, APPROVE_FD) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(APPROVE_FD, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if read_fd != APPROVE_FD && libc::close(read_fd) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn manvi: {e}"))?;
        drop(read_pipe);

        let child_pid = child.id();
        let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
        let cancelled = Arc::new(AtomicBool::new(false));

        {
            let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
            runs.insert(
                run_id.clone(),
                ActiveRun {
                    run_id: run_id.clone(),
                    cancelled: cancelled.clone(),
                    pending_approval: None,
                    child_pid,
                },
            );
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture manvi stdout".to_string())?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture manvi stderr".to_string())?;

        let stderr_tail = Arc::new(Mutex::new(Vec::<u8>::new()));
        let stderr_tail_clone = stderr_tail.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut tail = stderr_tail_clone.lock().unwrap();
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > MAX_STDERR_TAIL_BYTES {
                    let excess = tail.len() - MAX_STDERR_TAIL_BYTES;
                    tail.drain(0..excess);
                }
            }
        });

        let mut lines_reader = BufReader::new(stdout).lines();
        let mut rewritten_content = String::new();
        let mut ats_score: u32 = 0;
        let mut metrics_preserved = true;
        let mut phases_completed: u32 = 0;

        let is_test_mode = std::env::var("DEVPRISM_TEST_MODE").is_ok()
            || std::env::var("DEVPRISM_HEADLESS_TEST").is_ok();

        while let Ok(Some(line)) = lines_reader.next_line().await {
            if cancelled.load(Ordering::SeqCst) {
                break;
            }
            let Some(ev) = parse_ndjson_line(&line) else {
                continue;
            };

            let kind = ev
                .get("kind")
                .or_else(|| ev.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if kind == "progress" || kind == "tailor-progress" || ev.get("phase").is_some() {
                if let Some(p) = ev.get("phase").and_then(|v| v.as_u64()) {
                    if (p as u32) > phases_completed {
                        phases_completed = p as u32;
                    }
                }
                let _ = window.emit("vani://tailor-progress", &ev);
            } else if kind == "approval.request" || ev.get("approval_id").is_some() {
                let appr_id = ev
                    .get("approval_id")
                    .or_else(|| ev.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let appr_id = if appr_id.is_empty() {
                    format!("appr_{}", uuid::Uuid::new_v4().simple())
                } else {
                    appr_id
                };

                let prompt_text = ev
                    .get("prompt")
                    .or_else(|| ev.get("message"))
                    .or_else(|| ev.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Approval required");

                let options_val = ev
                    .get("options")
                    .or_else(|| ev.get("choices"))
                    .cloned()
                    .unwrap_or(Value::Array(vec![]));

                let default_choice = ev
                    .get("default_choice")
                    .or_else(|| ev.get("defaultChoice"))
                    .and_then(|v| v.as_str());

                let (tx, rx) = tokio::sync::oneshot::channel();

                let options_vec: Vec<String> = options_val
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();

                // Atomic registration directly under ACTIVE_RUNS
                let registered = {
                    let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(run) = runs.get_mut(&run_id) {
                        if run.cancelled.load(Ordering::SeqCst) {
                            false
                        } else {
                            run.pending_approval = Some(PendingApproval {
                                approval_id: appr_id.clone(),
                                prompt: prompt_text.to_string(),
                                options: options_vec,
                                default_choice: default_choice.map(String::from),
                                sender: tx,
                            });
                            true
                        }
                    } else {
                        false
                    }
                };

                if !registered {
                    // Run was cancelled or removed before approval was registered; abort
                    break;
                }

                let _ = window.emit(
                    "vani://approval-required",
                    json!({
                        "approvalId": &appr_id,
                        "runId": &run_id,
                        "prompt": prompt_text,
                        "options": options_val,
                        "defaultChoice": default_choice,
                    }),
                );

                let decision = if is_test_mode {
                    tokio::select! {
                        res = rx => {
                            res.unwrap_or(ApprovalDecision {
                                allow: true,
                                chosen: None,
                                write_in: None,
                                reason: None,
                            })
                        }
                        _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                            {
                                let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
                                if let Some(run) = runs.get_mut(&run_id) {
                                    run.pending_approval = None;
                                }
                            }
                            ApprovalDecision {
                                allow: true,
                                chosen: None,
                                write_in: None,
                                reason: Some("Auto-approved in test mode".to_string()),
                            }
                        }
                    }
                } else {
                    match rx.await {
                        Ok(d) => d,
                        Err(_) => ApprovalDecision {
                            allow: false,
                            chosen: None,
                            write_in: None,
                            reason: Some("Approval channel closed".to_string()),
                        },
                    }
                };

                let decision_line = format_decision_line(
                    &appr_id,
                    decision.allow,
                    decision.chosen.as_deref(),
                    decision.write_in.as_deref(),
                    decision.reason.as_deref(),
                );
                let _ = write_pipe.write_all(decision_line.as_bytes());
                let _ = write_pipe.flush();

                {
                    let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(run) = runs.get_mut(&run_id) {
                        run.pending_approval = None;
                    }
                }

                if !decision.allow {
                    if let Some(pid) = child_pid {
                        let grace = if is_test_mode {
                            GRACE_PERIOD_TEST
                        } else {
                            GRACE_PERIOD_PROD
                        };
                        spawn_signal_escalation(pid, grace);
                    }
                }
            } else if kind == "content"
                || kind == "message"
                || ev.get("content").is_some()
                || ev.get("text").is_some()
            {
                if let Some(txt) = ev
                    .get("content")
                    .or_else(|| ev.get("text"))
                    .and_then(|v| v.as_str())
                {
                    if !rewritten_content.is_empty() {
                        rewritten_content.push('\n');
                    }
                    rewritten_content.push_str(txt);
                }
                if let Some(score) = ev
                    .get("ats_score")
                    .or_else(|| ev.get("score"))
                    .and_then(|v| v.as_u64())
                {
                    ats_score = score as u32;
                }
                if let Some(preserved) = ev.get("metrics_preserved").and_then(|v| v.as_bool()) {
                    metrics_preserved = preserved;
                }
            }
        }

        #[cfg(unix)]
        let status = {
            if cancelled.load(Ordering::SeqCst) {
                let grace = if is_test_mode {
                    GRACE_PERIOD_TEST
                } else {
                    GRACE_PERIOD_PROD
                };
                match tokio::time::timeout(grace, child.wait()).await {
                    Ok(res) => res.map_err(|e| format!("Failed to wait on child process: {e}"))?,
                    Err(_) => {
                        if let Some(pid) = child_pid {
                            let _ = send_signal_to_process_group(pid, libc::SIGKILL);
                        }
                        child
                            .wait()
                            .await
                            .map_err(|e| format!("Failed to wait on child after SIGKILL: {e}"))?
                    }
                }
            } else {
                child
                    .wait()
                    .await
                    .map_err(|e| format!("Failed to wait on child process: {e}"))?
            }
        };
        #[cfg(not(unix))]
        let status = child
            .wait()
            .await
            .map_err(|e| format!("Failed to wait on child process: {e}"))?;

        let stderr_str = {
            let tail = stderr_tail.lock().unwrap_or_else(|e| e.into_inner());
            String::from_utf8_lossy(&tail).to_string()
        };
        let exit_diag = translate_exit_code(status.code(), &stderr_str);

        {
            let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
            runs.remove(&run_id);
        }

        if cancelled.load(Ordering::SeqCst) {
            return Ok(VaniTailorResult {
                run_id,
                status: "cancelled".to_string(),
                rewritten_content: String::new(),
                ats_score: 0,
                metrics_preserved: false,
                phases_completed,
            });
        }

        if !status.success() {
            return Err(format!(
                "Manvi run failed with exit status {:?}: {}",
                status.code(),
                exit_diag
            ));
        }

        if phases_completed == 0 {
            phases_completed = 4;
        }

        Ok(VaniTailorResult {
            run_id,
            status: "completed".to_string(),
            rewritten_content,
            ats_score,
            metrics_preserved,
            phases_completed,
        })
    }
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn test_binary_resolution_precedence() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempfile::tempdir().unwrap();
        let fake_bin = temp_dir.path().join("fake_manvi");
        std::fs::write(&fake_bin, b"#!/bin/sh\necho manvi").unwrap();

        // 1. Explicit environment variable pointing to file wins
        std::env::set_var(BIN_ENV, fake_bin.to_str().unwrap());
        let res = resolve_binary();
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), fake_bin);

        // 2. Explicit environment variable pointing to non-existent file errors
        let non_existent = temp_dir.path().join("does_not_exist");
        std::env::set_var(BIN_ENV, non_existent.to_str().unwrap());
        let err = resolve_binary().unwrap_err();
        assert!(err.contains("which is not a file"));

        // Clean up env var
        std::env::remove_var(BIN_ENV);
    }

    #[test]
    fn test_format_decision_line_allow() {
        let line = format_decision_line(
            "appr_123",
            true,
            Some(&["Option A".to_string()]),
            None,
            None,
        );
        assert!(line.ends_with('\n'));
        let parsed: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["approval_id"], "appr_123");
        assert_eq!(parsed["allow"], true);
        assert_eq!(parsed["chosen"], json!(["Option A"]));
        assert_eq!(parsed["write_in"], "");
        assert_eq!(parsed["reason"], "");
    }

    #[test]
    fn test_format_decision_line_multi_select() {
        let choices = vec!["Option 1".to_string(), "Option 2".to_string()];
        let line = format_decision_line(
            "appr_456",
            false,
            Some(&choices),
            Some("custom note"),
            Some("user cancelled"),
        );
        assert!(line.ends_with('\n'));
        let parsed: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["approval_id"], "appr_456");
        assert_eq!(parsed["allow"], false);
        assert_eq!(parsed["chosen"], json!(["Option 1", "Option 2"]));
        assert_eq!(parsed["write_in"], "custom note");
        assert_eq!(parsed["reason"], "user cancelled");
    }

    #[test]
    fn test_ndjson_line_parser_skips_preamble() {
        let stream = vec![
            "info: starting manvi engine v0.8.0",
            r#"{"type": "progress", "percent": 0.1}"#,
            "warn: cache miss on embedding lookup",
            r#"{"type": "progress", "percent": 0.2}"#,
        ];

        let parsed: Vec<Value> = stream.into_iter().filter_map(parse_ndjson_line).collect();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["percent"], 0.1);
        assert_eq!(parsed[1]["percent"], 0.2);
    }

    #[test]
    fn test_ndjson_line_cap() {
        // Line exceeding 8 MiB is rejected
        let huge_line = format!(
            "{{\"type\": \"big\", \"data\": \"{}\"}}",
            "x".repeat(MAX_LINE_BYTES + 10)
        );
        assert!(parse_ndjson_line(&huge_line).is_none());

        // Normal line is accepted
        let normal_line = r#"{"type": "ok"}"#;
        assert!(parse_ndjson_line(normal_line).is_some());
    }

    #[test]
    fn test_exit_code_translation() {
        assert_eq!(
            translate_exit_code(Some(0), ""),
            "Run completed successfully."
        );
        assert_eq!(
            translate_exit_code(Some(2), ""),
            "The step ceiling ended the turn; the work is not complete."
        );
        assert_eq!(
            translate_exit_code(Some(3), ""),
            "Output cap cut the final answer off mid-sentence."
        );
        assert_eq!(
            translate_exit_code(Some(4), ""),
            "Turn ended without an answer (model had nothing to say)."
        );
        assert_eq!(
            translate_exit_code(Some(5), ""),
            "Turn ended without finishing (connection dropped or model refused)."
        );
        assert_eq!(
            translate_exit_code(Some(137), ""),
            "Process killed by SIGKILL (fatal: out of memory)."
        );
        assert!(translate_exit_code(Some(1), "syntax error").contains("syntax error"));
    }

    #[test]
    fn test_adversarial_ndjson_malformed_and_edge_cases() {
        let malformed_cases = [
            "",
            "   ",
            "\t\r\n",
            "{",
            "}",
            "{{}}",
            r#"{"unclosed": "string"#,
            r#"{"key": unquoted_val}"#,
            r#"{"trailing": "comma",}"#,
            r#"{"invalid_escape": "\z"}"#,
            "not json at all",
            "[1, 2, 3]",
            "\"a string\"",
            "12345",
            "true",
            "false",
            "null",
            "{\"type\": \"test\"} trailing non-json garbage",
            "{\"type\": \"one\"}{\"type\": \"two\"}",
        ];

        for case in malformed_cases {
            assert!(
                parse_ndjson_line(case).is_none(),
                "Expected malformed case to return None: {case:?}"
            );
        }
    }

    #[test]
    fn test_adversarial_ndjson_line_cap_exact_boundaries() {
        let prefix = r#"{"type": "data", "payload": ""#;
        let suffix = r#""}"#;
        let overhead = prefix.len() + suffix.len();

        // 1. Line exactly MAX_LINE_BYTES
        let exact_payload_len = MAX_LINE_BYTES - overhead;
        let mut exact_line = String::with_capacity(MAX_LINE_BYTES);
        exact_line.push_str(prefix);
        exact_line.extend(std::iter::repeat('a').take(exact_payload_len));
        exact_line.push_str(suffix);
        assert_eq!(exact_line.len(), MAX_LINE_BYTES);

        let parsed_exact = parse_ndjson_line(&exact_line);
        assert!(
            parsed_exact.is_some(),
            "Line of exact MAX_LINE_BYTES should be accepted"
        );
        assert_eq!(parsed_exact.unwrap()["type"], "data");

        // 2. Line exceeding MAX_LINE_BYTES by 1 byte (non-whitespace payload)
        let mut oversized_line = String::with_capacity(MAX_LINE_BYTES + 1);
        oversized_line.push_str(prefix);
        oversized_line.extend(std::iter::repeat('a').take(exact_payload_len + 1));
        oversized_line.push_str(suffix);
        assert_eq!(oversized_line.len(), MAX_LINE_BYTES + 1);
        assert!(
            parse_ndjson_line(&oversized_line).is_none(),
            "Line exceeding MAX_LINE_BYTES by 1 byte must be rejected"
        );

        // 3. 10 MiB line
        let huge_line = format!(
            r#"{{"type": "huge", "content": "{}"}}"#,
            "x".repeat(10 * 1024 * 1024)
        );
        assert!(
            parse_ndjson_line(&huge_line).is_none(),
            "10 MiB line must be rejected"
        );
    }

    #[test]
    fn test_adversarial_ndjson_deep_nesting_and_unicode() {
        // Deeply nested objects (>128 levels)
        let mut deeply_nested = String::new();
        for _ in 0..150 {
            deeply_nested.push_str(r#"{"nested":"#);
        }
        deeply_nested.push_str(r#""bottom""#);
        for _ in 0..150 {
            deeply_nested.push('}');
        }
        assert!(
            parse_ndjson_line(&deeply_nested).is_none(),
            "Deeply nested object exceeding recursion limit must be rejected safely"
        );

        // Unicode, emoji, and special characters
        let unicode_line =
            r#"{"agent": "🚀", "message": "Привет мир \n \t \"quotes\"", "math": "∀x ∈ ℝ"}"#;
        let parsed = parse_ndjson_line(unicode_line);
        assert!(parsed.is_some());
        let val = parsed.unwrap();
        assert_eq!(val["agent"], "🚀");
        assert_eq!(val["math"], "∀x ∈ ℝ");
        assert!(val["message"].as_str().unwrap().contains("Привет мир"));
    }

    #[test]
    fn test_adversarial_format_decision_line_complex_payloads() {
        let multiline_write_in = "First line\nSecond line\r\nThird line \"quoted\" \\ backslash";
        let multiline_reason = "Reason line 1\nReason line 2";
        let choices = vec!["Option 1".to_string(), "Option 2".to_string()];

        let formatted = format_decision_line(
            "appr_test_1",
            true,
            Some(&choices),
            Some(multiline_write_in),
            Some(multiline_reason),
        );

        // Protocol requirement: Single line ending in \n
        assert!(formatted.ends_with('\n'));
        let line_without_trailing_newline = &formatted[..formatted.len() - 1];
        assert!(
            !line_without_trailing_newline.contains('\n'),
            "Decision line must not contain unescaped internal newlines"
        );

        let parsed: Value = serde_json::from_str(line_without_trailing_newline)
            .expect("Formatted line must be valid single-line JSON");
        assert_eq!(parsed["approval_id"], "appr_test_1");
        assert_eq!(parsed["allow"], true);
        assert_eq!(parsed["chosen"], json!(["Option 1", "Option 2"]));
        assert_eq!(parsed["write_in"], multiline_write_in);
        assert_eq!(parsed["reason"], multiline_reason);

        // None fields must serialize to empty string / empty array, NEVER null
        let minimal = format_decision_line("appr_minimal", false, None, None, None);
        let parsed_minimal: Value = serde_json::from_str(minimal.trim()).unwrap();
        assert_eq!(parsed_minimal["allow"], false);
        assert_eq!(parsed_minimal["chosen"], json!([]));
        assert_eq!(parsed_minimal["write_in"], "");
        assert_eq!(parsed_minimal["reason"], "");
        assert!(!parsed_minimal["chosen"].is_null());
        assert!(!parsed_minimal["write_in"].is_null());
        assert!(!parsed_minimal["reason"].is_null());

        // Empty chosen slice Some(&[])
        let empty_chosen = format_decision_line("appr_empty", true, Some(&[]), None, None);
        let parsed_empty: Value = serde_json::from_str(empty_chosen.trim()).unwrap();
        assert_eq!(parsed_empty["chosen"], json!([]));
    }

    #[test]
    fn test_adversarial_exit_code_translation_comprehensive() {
        assert_eq!(
            translate_exit_code(Some(0), "some warning"),
            "Run completed successfully."
        );
        assert_eq!(
            translate_exit_code(Some(1), ""),
            "Run failed with generic error."
        );
        assert_eq!(
            translate_exit_code(Some(1), "   \t\n  "),
            "Run failed with generic error."
        );
        assert_eq!(
            translate_exit_code(Some(1), "fatal: repository not found"),
            "Run failed: fatal: repository not found"
        );
        assert_eq!(
            translate_exit_code(Some(2), ""),
            "The step ceiling ended the turn; the work is not complete."
        );
        assert_eq!(
            translate_exit_code(Some(3), ""),
            "Output cap cut the final answer off mid-sentence."
        );
        assert_eq!(
            translate_exit_code(Some(4), ""),
            "Turn ended without an answer (model had nothing to say)."
        );
        assert_eq!(
            translate_exit_code(Some(5), ""),
            "Turn ended without finishing (connection dropped or model refused)."
        );
        assert_eq!(
            translate_exit_code(Some(137), ""),
            "Process killed by SIGKILL (fatal: out of memory)."
        );
        assert_eq!(
            translate_exit_code(None, ""),
            "Process terminated by signal."
        );

        // Unmapped exit codes
        assert_eq!(
            translate_exit_code(Some(127), ""),
            "Process exited with status code 127."
        );
        assert_eq!(
            translate_exit_code(Some(126), "permission denied"),
            "Process exited with status code 126: permission denied"
        );
        assert_eq!(
            translate_exit_code(Some(-1), ""),
            "Process exited with status code -1."
        );

        // Stderr with MAX_STDERR_TAIL_BYTES
        let huge_stderr = "x".repeat(MAX_STDERR_TAIL_BYTES);
        let msg = translate_exit_code(Some(1), &huge_stderr);
        assert!(msg.starts_with("Run failed: xxx"));
    }

    #[test]
    fn test_adversarial_binary_resolution_directory_fails() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempfile::tempdir().unwrap();
        let sub_dir = temp_dir.path().join("fake_dir");
        std::fs::create_dir_all(&sub_dir).unwrap();

        std::env::set_var(BIN_ENV, sub_dir.to_str().unwrap());
        let res = resolve_binary();
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("which is not a file"));
        std::env::remove_var(BIN_ENV);
    }

    #[test]
    fn test_adversarial_pick_dev_binary_mtime() {
        let temp_dir = tempfile::tempdir().unwrap();
        let file_a = temp_dir.path().join("bin_a");
        let file_b = temp_dir.path().join("bin_b");

        std::fs::write(&file_a, b"a").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(&file_b, b"b").unwrap();

        let picked = pick_dev_binary(Some(file_a.clone()), Some(file_b.clone()));
        assert_eq!(picked, Some(file_b.clone()));
        assert_eq!(pick_dev_binary(Some(file_a.clone()), None), Some(file_a));
        assert_eq!(pick_dev_binary(None, Some(file_b.clone())), Some(file_b));
        assert_eq!(pick_dev_binary(None, None), None);
    }

    #[tokio::test]
    async fn test_adversarial_approval_channels_and_concurrency() {
        // Parallel approval dispatches across 30 concurrent tasks
        let mut handles = Vec::new();
        for i in 0..30 {
            let run_id = format!("run_conc_{i}");
            let appr_id = format!("appr_conc_{i}");
            let (tx, rx) = tokio::sync::oneshot::channel();
            {
                let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
                runs.insert(
                    run_id.clone(),
                    ActiveRun {
                        run_id: run_id.clone(),
                        cancelled: Arc::new(AtomicBool::new(false)),
                        pending_approval: Some(PendingApproval {
                            approval_id: appr_id.clone(),
                            prompt: "Confirm action".into(),
                            options: vec!["Option 1".into(), "Option 2".into()],
                            default_choice: Some("Option 1".into()),
                            sender: tx,
                        }),
                        #[cfg(unix)]
                        child_pid: None,
                    },
                );
            }

            let appr_id_clone = appr_id.clone();
            let handle = tokio::spawn(async move {
                let choice = format!("Choice_{i}");
                let _ = manvi_approve_action(
                    appr_id_clone,
                    true,
                    Some(choice),
                    Some("write_in".into()),
                    Some("reason".into()),
                )
                .await;
            });
            handles.push((rx, handle, i, run_id));
        }

        for (rx, handle, i, run_id) in handles {
            let _ = handle.await;
            let decision = rx.await.expect("Channel must receive decision");
            assert!(decision.allow);
            assert_eq!(decision.chosen, Some(vec![format!("Choice_{i}")]));
            assert_eq!(decision.write_in, Some("write_in".to_string()));
            assert_eq!(decision.reason, Some("reason".to_string()));

            // Clean up run
            let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
            runs.remove(&run_id);
        }

        // Calling approval with non-existent ID returns Ok(())
        let res_nonexistent =
            manvi_approve_action("no_such_appr".into(), true, None, None, None).await;
        assert!(res_nonexistent.is_ok());

        // Calling multi-select approval with non-existent ID returns Ok(())
        let res_send = manvi_send_approval(
            "run1".into(),
            "no_such_appr".into(),
            false,
            None,
            None,
            None,
        )
        .await;
        assert!(res_send.is_ok());
    }

    #[tokio::test]
    async fn test_adversarial_cancellation_and_state_cleanup() {
        let run_id = "test_cancel_run_1".to_string();
        let approval_id = "test_cancel_appr_1".to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();

        {
            let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
            runs.insert(
                run_id.clone(),
                ActiveRun {
                    run_id: run_id.clone(),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    pending_approval: Some(PendingApproval {
                        approval_id: approval_id.clone(),
                        prompt: "Confirm cancellation".into(),
                        options: vec![],
                        default_choice: None,
                        sender: tx,
                    }),
                    #[cfg(unix)]
                    child_pid: None,
                },
            );
        }

        // Verify active run is present
        {
            let runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
            assert!(runs.contains_key(&run_id));
        }

        // Cancel simulated by dropping/cancelling the pending approval like manvi_cancel_run does
        {
            let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut run) = runs.remove(&run_id) {
                run.cancelled.store(true, Ordering::SeqCst);
                if let Some(pending) = run.pending_approval.take() {
                    let _ = pending.sender.send(ApprovalDecision {
                        allow: false,
                        chosen: None,
                        write_in: None,
                        reason: Some("Run cancelled".to_string()),
                    });
                }
            }
        }

        // Verify receiver receives the cancellation decision
        let decision = rx
            .await
            .expect("Pending approval should receive cancellation");
        assert!(!decision.allow);
        assert_eq!(decision.reason, Some("Run cancelled".to_string()));

        // Active run must be removed
        {
            let runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
            assert!(!runs.contains_key(&run_id));
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn test_subprocess_pipe_fd3_protocol() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempfile::tempdir().unwrap();
        let mock_script = temp_dir.path().join("mock_manvi.sh");

        let script_content = r#"#!/bin/sh
printf '%s\n' '{"kind":"progress","phase":1,"percent":0.25,"step":"Extracting skills"}'
printf '%s\n' '{"kind":"approval.request","approval_id":"appr_mock_123","prompt":"Confirm bullet rewrite","options":["Option 1","Option 2"],"default_choice":"Option 1"}'
read -r decision_line <&3
echo "$decision_line" | grep -q '"allow":true' || exit 2
echo "$decision_line" | grep -q 'appr_mock_123' || exit 3
printf '%s\n' '{"kind":"content","content":"Tailored Resume Content","ats_score":94,"metrics_preserved":true}'
exit 0
"#;
        std::fs::write(&mock_script, script_content).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&mock_script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&mock_script, perms).unwrap();

        let (read_pipe, mut write_pipe) = std::io::pipe().unwrap();
        let read_fd = std::os::fd::AsRawFd::as_raw_fd(&read_pipe);

        let mut cmd = tokio::process::Command::new(&mock_script);
        cmd.args(["run", "--json", "--approve-fd", "3", "--mcp", "devprism"]);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.stdin(std::process::Stdio::null());

        const APPROVE_FD: i32 = 3;
        unsafe {
            cmd.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::dup2(read_fd, APPROVE_FD) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(APPROVE_FD, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if read_fd != APPROVE_FD && libc::close(read_fd) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = cmd.spawn().expect("Spawn mock script");
        drop(read_pipe);

        let stdout = child.stdout.take().expect("Take stdout");
        let mut lines = BufReader::new(stdout).lines();

        let line1 = lines.next_line().await.unwrap().expect("Line 1");
        let ev1 = parse_ndjson_line(&line1).expect("Parse line 1");
        assert_eq!(ev1["kind"], "progress");
        assert_eq!(ev1["percent"], 0.25);

        let line2 = lines.next_line().await.unwrap().expect("Line 2");
        let ev2 = parse_ndjson_line(&line2).expect("Parse line 2");
        assert_eq!(ev2["kind"], "approval.request");
        assert_eq!(ev2["approval_id"], "appr_mock_123");

        let decision_line = format_decision_line(
            "appr_mock_123",
            true,
            Some(&["Option 1".to_string()]),
            Some("approved"),
            None,
        );
        write_pipe
            .write_all(decision_line.as_bytes())
            .expect("Write to fd 3");
        write_pipe.flush().expect("Flush fd 3");

        let line3 = lines.next_line().await.unwrap().expect("Line 3");
        let ev3 = parse_ndjson_line(&line3).expect("Parse line 3");
        assert_eq!(ev3["kind"], "content");
        assert_eq!(ev3["ats_score"], 94);
        assert_eq!(ev3["metrics_preserved"], true);

        let status = child.wait().await.expect("Wait on child");
        assert!(
            status.success(),
            "Process exited with code {:?}",
            status.code()
        );
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_child_pid_boundaries() {
        assert!(validate_child_pid(0).is_err());
        assert!(validate_child_pid(1).is_err());
        assert!(validate_child_pid(u32::MAX).is_err());
        assert!(validate_child_pid((i32::MAX as u32) + 1).is_err());
        assert_eq!(validate_child_pid(2).unwrap(), 2);
        assert_eq!(validate_child_pid(100).unwrap(), 100);
        assert_eq!(validate_child_pid(i32::MAX as u32).unwrap(), i32::MAX);
    }

    #[test]
    #[cfg(unix)]
    fn test_send_signal_ignores_esrch_on_dead_pid() {
        // PID 999999 does not exist; ESRCH should be treated as benign success
        let res = send_signal_to_process_group(999999, libc::SIGINT);
        assert!(res.is_ok(), "ESRCH on non-existent PID must return Ok(())");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn test_signal_escalation_kills_unresponsive_child() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempfile::tempdir().unwrap();
        let stubborn_script = temp_dir.path().join("stubborn.sh");

        let script_content = r#"#!/bin/sh
trap '' INT
sleep 30
"#;
        std::fs::write(&stubborn_script, script_content).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&stubborn_script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&stubborn_script, perms).unwrap();

        let mut cmd = tokio::process::Command::new(&stubborn_script);
        unsafe {
            cmd.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                libc::signal(libc::SIGINT, libc::SIG_IGN);
                Ok(())
            });
        }

        let mut child = cmd.spawn().expect("Spawn stubborn script");
        let pid = child.id().expect("Child ID");

        // Spawn escalation with short 300ms grace period
        spawn_signal_escalation(pid, std::time::Duration::from_millis(300));

        let status = child.wait().await.expect("Wait on child");
        // Process must have been terminated by signal (SIGKILL = 9)
        assert!(!status.success());
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(9));
        }
    }

    #[tokio::test]
    async fn test_adversarial_race_cancel_against_approval_registration() {
        for i in 0..100 {
            let run_id = format!("race_run_{i}");
            let appr_id = format!("race_appr_{i}");
            let cancelled = Arc::new(AtomicBool::new(false));

            {
                let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
                runs.insert(
                    run_id.clone(),
                    ActiveRun {
                        run_id: run_id.clone(),
                        cancelled: cancelled.clone(),
                        pending_approval: None,
                        #[cfg(unix)]
                        child_pid: None,
                    },
                );
            }

            let (tx, rx) = tokio::sync::oneshot::channel();
            let run_id_reg = run_id.clone();
            let appr_id_reg = appr_id.clone();

            // Task A: sim manvi_tailor_resume registering approval
            let register_task = tokio::spawn(async move {
                let registered = {
                    let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(run) = runs.get_mut(&run_id_reg) {
                        if run.cancelled.load(Ordering::SeqCst) {
                            false
                        } else {
                            run.pending_approval = Some(PendingApproval {
                                approval_id: appr_id_reg,
                                prompt: "prompt".into(),
                                options: vec![],
                                default_choice: None,
                                sender: tx,
                            });
                            true
                        }
                    } else {
                        false
                    }
                };

                if registered {
                    // If registered, wait on rx with 500ms timeout
                    match tokio::time::timeout(tokio::time::Duration::from_millis(500), rx).await {
                        Ok(res) => {
                            let decision = res.expect("sender should deliver decision");
                            assert!(!decision.allow);
                            "received_cancel"
                        }
                        Err(_) => {
                            panic!("HANG DETECTED: registered approval never received decision!")
                        }
                    }
                } else {
                    "aborted_unregistered"
                }
            });

            // Task B: sim manvi_cancel_run
            let run_id_cancel = run_id.clone();
            let cancel_task = tokio::spawn(async move {
                let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(mut run) = runs.remove(&run_id_cancel) {
                    run.cancelled.store(true, Ordering::SeqCst);
                    if let Some(pending) = run.pending_approval.take() {
                        let _ = pending.sender.send(ApprovalDecision {
                            allow: false,
                            chosen: None,
                            write_in: None,
                            reason: Some("Run cancelled".to_string()),
                        });
                    }
                }
            });

            let (outcome, _) = tokio::join!(register_task, cancel_task);
            let outcome_str = outcome.unwrap();
            assert!(
                outcome_str == "received_cancel" || outcome_str == "aborted_unregistered",
                "Outcome must be either received_cancel or aborted_unregistered, got {outcome_str}"
            );

            // Clean up
            let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
            runs.remove(&run_id);
        }
    }

    #[tokio::test]
    async fn test_adversarial_simultaneous_approvals_and_cancels() {
        for i in 0..50 {
            let run_id = format!("simult_run_{i}");
            let appr_id = format!("simult_appr_{i}");
            let (tx, rx) = tokio::sync::oneshot::channel();

            {
                let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
                runs.insert(
                    run_id.clone(),
                    ActiveRun {
                        run_id: run_id.clone(),
                        cancelled: Arc::new(AtomicBool::new(false)),
                        pending_approval: Some(PendingApproval {
                            approval_id: appr_id.clone(),
                            prompt: "test".into(),
                            options: vec![],
                            default_choice: None,
                            sender: tx,
                        }),
                        #[cfg(unix)]
                        child_pid: None,
                    },
                );
            }

            let mut tasks = Vec::new();

            // 10 concurrent approval tasks
            for j in 0..10 {
                let a_id = appr_id.clone();
                tasks.push(tokio::spawn(async move {
                    manvi_approve_action(a_id, true, Some(format!("Choice_{j}")), None, None).await
                }));
            }

            // 10 concurrent cancel attempts directly on ACTIVE_RUNS
            for _ in 0..10 {
                let r_id = run_id.clone();
                tasks.push(tokio::spawn(async move {
                    let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(mut run) = runs.remove(&r_id) {
                        run.cancelled.store(true, Ordering::SeqCst);
                        if let Some(pending) = run.pending_approval.take() {
                            let _ = pending.sender.send(ApprovalDecision {
                                allow: false,
                                chosen: None,
                                write_in: None,
                                reason: Some("Cancelled".into()),
                            });
                        }
                    }
                    Ok::<(), String>(())
                }));
            }

            for t in tasks {
                let _ = t.await;
            }

            // Exactly ONE decision must have been sent
            let res = rx.await;
            assert!(
                res.is_ok(),
                "Receiver must receive exactly one decision without drop or hang"
            );

            // Clean up
            let mut runs = get_active_runs().lock().unwrap_or_else(|e| e.into_inner());
            runs.remove(&run_id);
        }
    }
}
