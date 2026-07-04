//! WisDev ARC (Agent Research Core) integration.
//!
//! Bridges the ScholarLM / WisDev ARC research runtime into DevPrism. The runtime
//! ships as a Go CLI (`wisdev`) living in the ScholarLM repo under `wisdev-arc`.
//! We drive it three ways:
//!   * `wisdev_research` -> `wisdev yolo --json` : autonomous evidence-grounded research
//!   * `wisdev_docgen`   -> `wisdev docgen -f …`  : manuscript generation (markdown/latex/json)
//!   * `wisdev_check` / `wisdev_build`            : detect / compile the runtime
//!
//! Runner resolution order (first that works wins):
//!   1. An explicit binary path passed from the frontend (a settings field).
//!   2. `<repo>/dist/wisdev` (built via `wisdev_build`).
//!   3. `go run ./cmd/wisdev` from `<repo>/orchestrator` (needs the Go toolchain).
//!
//! `--offline` keeps the loop fully local (no cloud/search providers), so the
//! feature works with zero configuration for smoke tests and demos.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

/// Tauri event channel carrying live research-loop stage updates.
pub const STAGE_EVENT: &str = "wisdev-stage";

// ─── Serialized results ───

#[derive(serde::Serialize)]
pub struct WisdevStatus {
    /// True when a runnable path (binary or `go run`) was resolved.
    pub available: bool,
    /// "binary" | "go" | "unavailable"
    pub mode: String,
    /// Resolved binary path, when mode == "binary".
    pub binary: Option<String>,
    /// Whether a prebuilt `<repo>/dist/wisdev` exists.
    pub dist_binary: bool,
    /// Whether the Go toolchain is available (enables build / `go run`).
    pub go_available: bool,
    pub repo_path: Option<String>,
    pub detail: String,
}

#[derive(serde::Serialize, Default)]
pub struct ResearchReport {
    pub final_answer: String,
    pub original_query: String,
    pub requested_iterations: u32,
    pub iterations: u32,
    pub converged: bool,
    pub stop_reason: String,
    pub synthesis_mode: String,
    pub papers_found: u32,
    pub executed_queries: Vec<String>,
    pub hypotheses: Vec<Hypothesis>,
    pub gaps: CoverageGaps,
}

#[derive(serde::Serialize, Default)]
pub struct Hypothesis {
    pub id: String,
    pub claim: String,
    pub confidence_score: f64,
    pub status: String,
}

#[derive(serde::Serialize, Default)]
pub struct CoverageGaps {
    pub sufficient: bool,
    pub reasoning: String,
    pub missing_aspects: Vec<String>,
}

/// A single research-loop progress event, parsed from a `--stages` stderr line.
#[derive(Clone, serde::Serialize)]
struct StageEvent {
    stage: String,
    message: String,
    degraded: bool,
}

/// Parse a `--stages` stderr line of the form
/// `  ✓ [stage_id] message — key=value …` (or `! ⚠ degraded: [stage_id] …`).
/// Returns None for lines without a `[stage]` token.
fn parse_stage(line: &str) -> Option<StageEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let open = trimmed.find('[')?;
    let close_rel = trimmed[open..].find(']')?;
    let close = open + close_rel;
    let stage = trimmed[open + 1..close].trim().to_string();
    if stage.is_empty() {
        return None;
    }
    let rest = trimmed[close + 1..].trim();
    // The em-dash (U+2014) separates the human message from the key=value tail.
    let message = rest
        .split(" \u{2014} ")
        .next()
        .unwrap_or(rest)
        .trim()
        .to_string();
    let degraded = trimmed.starts_with('!') || trimmed.contains("degraded");
    Some(StageEvent {
        stage,
        message,
        degraded,
    })
}

/// Raw shape emitted by `wisdev yolo --json`. Only the fields we surface are
/// captured; everything else in the payload is ignored.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawResearch {
    final_answer: String,
    original_query: String,
    requested_iterations: u32,
    iterations: u32,
    converged: bool,
    stop_reason: String,
    synthesis_mode: String,
    papers_found: u32,
    executed_queries: Vec<String>,
    hypotheses: Vec<RawHypothesis>,
    gaps: RawGaps,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawHypothesis {
    id: String,
    claim: String,
    confidence_score: f64,
    status: String,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawGaps {
    sufficient: bool,
    reasoning: String,
    missing_aspects: Vec<String>,
}

// ─── Runner resolution ───

enum Runner {
    /// A directly-executable binary.
    Binary(PathBuf),
    /// `go run ./cmd/wisdev` invoked from the orchestrator directory.
    GoRun { orchestrator: PathBuf },
}

fn clean(s: &str) -> String {
    s.replace('\u{0}', "").trim().to_string()
}

fn normalized_repo(repo_path: &str) -> Result<PathBuf, String> {
    let repo = clean(repo_path);
    if repo.is_empty() {
        return Err(
            "WisDev ARC repository path is not configured. Set it in Settings → ScholarLM."
                .to_string(),
        );
    }
    let path = PathBuf::from(&repo);
    if !path.is_dir() {
        return Err(format!("WisDev ARC path is not a directory: {repo}"));
    }
    Ok(path)
}

/// Resolve how to invoke the runtime, preferring an explicit binary, then a
/// prebuilt dist binary, then `go run`.
fn resolve_runner(repo: &Path, binary: &Option<String>) -> Result<Runner, String> {
    if let Some(bin) = binary {
        let bin = clean(bin);
        if !bin.is_empty() {
            let p = PathBuf::from(&bin);
            if p.is_file() {
                return Ok(Runner::Binary(p));
            }
        }
    }

    let dist = repo.join("dist").join(dist_binary_name());
    if dist.is_file() {
        return Ok(Runner::Binary(dist));
    }

    let orchestrator = repo.join("orchestrator");
    if orchestrator.join("cmd").join("wisdev").is_dir() {
        return Ok(Runner::GoRun { orchestrator });
    }

    Err(format!(
        "Could not find a WisDev runner under {}. Build it (Settings → ScholarLM → Build runtime) \
         or install the Go toolchain.",
        repo.display()
    ))
}

fn runner_mode(runner: &Runner) -> &'static str {
    match runner {
        Runner::Binary(_) => "binary",
        Runner::GoRun { .. } => "go",
    }
}

fn dist_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "wisdev.exe"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "wisdev"
    }
}

/// Build a tokio Command for `program` running in `cwd`, with a PATH augmented so
/// GUI-launched apps (which inherit a minimal PATH) can still find `go` and
/// common tool directories.
fn build_command(program: &str, cwd: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.current_dir(cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.env("PATH", augmented_path());
    cmd
}

fn augmented_path() -> String {
    #[cfg(target_os = "windows")]
    let sep = ";";
    #[cfg(not(target_os = "windows"))]
    let sep = ":";

    let mut current = std::env::var("PATH").unwrap_or_default().replace('\u{0}', "");

    #[cfg(not(target_os = "windows"))]
    {
        let mut extra: Vec<PathBuf> = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/go/bin"),
            PathBuf::from("/opt/homebrew/opt/go/bin"),
        ];
        if let Some(home) = dirs::home_dir() {
            extra.push(home.join("go").join("bin"));
            extra.push(home.join(".local").join("bin"));
        }
        if let Ok(goroot) = std::env::var("GOROOT") {
            extra.push(PathBuf::from(goroot).join("bin"));
        }
        for dir in extra {
            let s = dir.to_string_lossy().to_string();
            if dir.exists() && !current.contains(&s) {
                current = format!("{s}{sep}{current}");
            }
        }
    }

    current
}

/// Extract the trailing pretty-printed JSON object from CLI stdout. The runtime
/// emits single-line structured logs (`{"time":…}`) before the report, which is
/// pretty-printed and therefore opens with a bare `{` on its own line.
fn extract_json_object(stdout: &str) -> Option<&str> {
    if let Some(pos) = stdout.find("\n{\n") {
        return Some(&stdout[pos + 1..]);
    }
    let trimmed = stdout.trim_start();
    if trimmed.starts_with('{') {
        return Some(trimmed);
    }
    None
}

/// Strip the leading structured-log lines the runtime writes to stdout, leaving
/// only the manuscript body (used for docgen, whose output is not JSON).
fn strip_log_prefix(stdout: &str) -> String {
    let mut lines: Vec<&str> = stdout.lines().collect();
    while let Some(first) = lines.first() {
        let t = first.trim_start();
        if t.starts_with("{\"time\":") || t.starts_with("{\"level\":") {
            lines.remove(0);
        } else {
            break;
        }
    }
    lines.join("\n").trim().to_string()
}

async fn run_capture(mut cmd: Command, timeout: Duration) -> Result<(String, String, i32), String> {
    cmd.kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch WisDev runtime: {e}"))?;
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            format!(
                "WisDev runtime timed out after {}s.",
                timeout.as_secs()
            )
        })?
        .map_err(|e| format!("WisDev runtime failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Ok((stdout, stderr, out.status.code().unwrap_or(-1)))
}

/// Run a research command, streaming `--stages` stderr lines to the frontend as
/// they arrive while collecting stdout (the final JSON report) to completion.
async fn run_streaming(
    mut cmd: Command,
    window: &tauri::Window,
    timeout: Duration,
) -> Result<(String, i32), String> {
    cmd.kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch WisDev runtime: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "WisDev runtime produced no stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "WisDev runtime produced no stderr handle".to_string())?;

    // Stream stage events off stderr without blocking stdout collection.
    let win = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(event) = parse_stage(&line) {
                let _ = win.emit(STAGE_EVENT, event);
            }
            // Keep the last few raw lines so we can surface a useful error.
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > 4096 {
                tail = tail.split_off(tail.len() - 4096);
            }
        }
        tail
    });

    let collect = async {
        let mut buf = Vec::new();
        BufReader::new(stdout)
            .read_to_end(&mut buf)
            .await
            .map_err(|e| format!("Failed to read WisDev stdout: {e}"))?;
        let status = child
            .wait()
            .await
            .map_err(|e| format!("Failed to wait for WisDev runtime: {e}"))?;
        Ok::<_, String>((String::from_utf8_lossy(&buf).to_string(), status))
    };

    let (stdout_str, status) = tokio::time::timeout(timeout, collect)
        .await
        .map_err(|_| format!("WisDev runtime timed out after {}s.", timeout.as_secs()))??;

    let stderr_tail = stderr_task.await.unwrap_or_default();
    if status.code().unwrap_or(-1) != 0 && stdout_str.trim().is_empty() {
        return Err(format!(
            "WisDev research failed:\n{}",
            stderr_tail.trim()
        ));
    }
    Ok((stdout_str, status.code().unwrap_or(-1)))
}

/// Apply the resolved runner to a subcommand + args, returning a ready Command.
fn command_for(runner: &Runner, sub_and_args: &[String]) -> Command {
    match runner {
        Runner::Binary(bin) => {
            let dir = bin.parent().map(Path::to_path_buf).unwrap_or_default();
            let mut cmd = build_command(&bin.to_string_lossy(), &dir);
            cmd.args(sub_and_args);
            cmd
        }
        Runner::GoRun { orchestrator } => {
            let mut cmd = build_command("go", orchestrator);
            cmd.arg("run").arg("./cmd/wisdev").args(sub_and_args);
            cmd
        }
    }
}

// ─── Commands ───

#[tauri::command]
pub async fn wisdev_check(
    repo_path: String,
    binary: Option<String>,
) -> Result<WisdevStatus, String> {
    let repo = match normalized_repo(&repo_path) {
        Ok(r) => r,
        Err(detail) => {
            return Ok(WisdevStatus {
                available: false,
                mode: "unavailable".into(),
                binary: None,
                dist_binary: false,
                go_available: go_available().await,
                repo_path: None,
                detail,
            });
        }
    };

    let dist = repo.join("dist").join(dist_binary_name());
    let dist_exists = dist.is_file();
    let go = go_available().await;

    match resolve_runner(&repo, &binary) {
        Ok(Runner::Binary(bin)) => Ok(WisdevStatus {
            available: true,
            mode: "binary".into(),
            binary: Some(bin.to_string_lossy().to_string()),
            dist_binary: dist_exists,
            go_available: go,
            repo_path: Some(repo.to_string_lossy().to_string()),
            detail: "WisDev runtime ready (prebuilt binary).".into(),
        }),
        Ok(Runner::GoRun { .. }) => Ok(WisdevStatus {
            available: go,
            mode: if go { "go".into() } else { "unavailable".into() },
            binary: None,
            dist_binary: dist_exists,
            go_available: go,
            repo_path: Some(repo.to_string_lossy().to_string()),
            detail: if go {
                "WisDev runtime will run via `go run` (build for faster startup).".into()
            } else {
                "Found the WisDev source but no binary and no Go toolchain. Build the runtime or install Go.".into()
            },
        }),
        Err(detail) => Ok(WisdevStatus {
            available: false,
            mode: "unavailable".into(),
            binary: None,
            dist_binary: dist_exists,
            go_available: go,
            repo_path: Some(repo.to_string_lossy().to_string()),
            detail,
        }),
    }
}

async fn go_available() -> bool {
    let mut cmd = Command::new("go");
    cmd.arg("version");
    cmd.env("PATH", augmented_path());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    match tokio::time::timeout(Duration::from_secs(10), cmd.status()).await {
        Ok(Ok(status)) => status.success(),
        _ => false,
    }
}

#[tauri::command]
pub async fn wisdev_build(repo_path: String) -> Result<String, String> {
    let repo = normalized_repo(&repo_path)?;
    let orchestrator = repo.join("orchestrator");
    if !orchestrator.join("cmd").join("wisdev").is_dir() {
        return Err(format!(
            "WisDev orchestrator source not found under {}.",
            orchestrator.display()
        ));
    }
    if !go_available().await {
        return Err("The Go toolchain is required to build the WisDev runtime, but `go` was not found on PATH.".to_string());
    }

    let dist_dir = repo.join("dist");
    std::fs::create_dir_all(&dist_dir)
        .map_err(|e| format!("Failed to create dist directory: {e}"))?;
    let out_path = dist_dir.join(dist_binary_name());

    let mut cmd = build_command("go", &orchestrator);
    cmd.arg("build")
        .arg("-o")
        .arg(&out_path)
        .arg("./cmd/wisdev");

    // Building the ~50MB binary from a cold cache can take a while.
    let (_stdout, stderr, code) = run_capture(cmd, Duration::from_secs(600)).await?;
    if code != 0 {
        return Err(format!("WisDev build failed:\n{}", stderr.trim()));
    }
    if !out_path.is_file() {
        return Err("WisDev build reported success but the binary is missing.".to_string());
    }
    Ok(out_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn wisdev_research(
    window: tauri::Window,
    repo_path: String,
    binary: Option<String>,
    query: String,
    offline: bool,
    iterations: Option<u32>,
) -> Result<ResearchReport, String> {
    let query = clean(&query);
    if query.is_empty() {
        return Err("Enter a research question.".to_string());
    }
    let repo = normalized_repo(&repo_path)?;
    let runner = resolve_runner(&repo, &binary)?;
    eprintln!(
        "[wisdev] research start: mode={} offline={} iterations={:?}",
        runner_mode(&runner),
        offline,
        iterations
    );

    // `--stages` streams loop progress to stderr; `--json` keeps the report on stdout.
    let mut args = vec![
        "yolo".to_string(),
        "--json".to_string(),
        "--stages".to_string(),
    ];
    if offline {
        args.push("--offline".to_string());
    }
    if let Some(n) = iterations {
        if n > 0 {
            args.push("--max-iterations".to_string());
            args.push(n.to_string());
        }
    }
    // `--` terminates flag parsing so a query starting with `-` (e.g. `--offline`)
    // is treated as the positional argument, not a flag that could override the
    // offline guarantee.
    args.push("--".to_string());
    args.push(query);

    let cmd = command_for(&runner, &args);
    // Offline runs are quick; online runs (with providers/LLM) can be slow.
    let timeout = if offline {
        Duration::from_secs(180)
    } else {
        Duration::from_secs(420)
    };
    let (stdout, code) = run_streaming(cmd, &window, timeout).await?;

    let json = extract_json_object(&stdout).ok_or_else(|| {
        eprintln!(
            "[wisdev] research: no JSON report (exit {code}); stdout head: {:?}",
            stdout.chars().take(200).collect::<String>()
        );
        if code != 0 {
            format!("WisDev research failed (exit {code}).")
        } else {
            "WisDev research produced no JSON report.".to_string()
        }
    })?;

    let raw: RawResearch = serde_json::from_str(json)
        .map_err(|e| format!("Failed to parse WisDev research report: {e}"))?;

    Ok(ResearchReport {
        final_answer: raw.final_answer,
        original_query: raw.original_query,
        requested_iterations: raw.requested_iterations,
        iterations: raw.iterations,
        converged: raw.converged,
        stop_reason: raw.stop_reason,
        synthesis_mode: raw.synthesis_mode,
        papers_found: raw.papers_found,
        executed_queries: raw.executed_queries,
        hypotheses: raw
            .hypotheses
            .into_iter()
            .map(|h| Hypothesis {
                id: h.id,
                claim: h.claim,
                confidence_score: h.confidence_score,
                status: h.status,
            })
            .collect(),
        gaps: CoverageGaps {
            sufficient: raw.gaps.sufficient,
            reasoning: raw.gaps.reasoning,
            missing_aspects: raw.gaps.missing_aspects,
        },
    })
}

#[tauri::command]
pub async fn wisdev_docgen(
    repo_path: String,
    binary: Option<String>,
    topic: String,
    format: String,
    offline: bool,
) -> Result<String, String> {
    let topic = clean(&topic);
    if topic.is_empty() {
        return Err("Enter a manuscript topic.".to_string());
    }
    let format = clean(&format);
    let format = match format.as_str() {
        "latex" | "markdown" | "json" => format,
        _ => "latex".to_string(),
    };
    let repo = normalized_repo(&repo_path)?;
    let runner = resolve_runner(&repo, &binary)?;
    eprintln!(
        "[wisdev] docgen start: mode={} offline={} format={}",
        runner_mode(&runner),
        offline,
        format
    );

    let mut args = vec!["docgen".to_string(), "-f".to_string(), format];
    if offline {
        args.push("--offline".to_string());
    }
    // `--` terminates flag parsing so a topic starting with `-` is treated as the
    // positional argument, not a flag.
    args.push("--".to_string());
    args.push(topic);

    let cmd = command_for(&runner, &args);
    let timeout = if offline {
        Duration::from_secs(180)
    } else {
        Duration::from_secs(420)
    };
    let (stdout, stderr, code) = run_capture(cmd, timeout).await?;
    if code != 0 {
        return Err(format!("WisDev docgen failed (exit {code}):\n{}", stderr.trim()));
    }
    let body = strip_log_prefix(&stdout);
    if body.is_empty() {
        return Err(format!(
            "WisDev docgen produced no output.\n{}",
            stderr.trim()
        ));
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_strips_nul_and_trims() {
        assert_eq!(clean("  hi\u{0}there \n"), "hithere");
        assert_eq!(clean("\u{0}\u{0}"), "");
        assert_eq!(clean("  spaced  "), "spaced");
    }

    #[test]
    fn parse_stage_extracts_stage_and_message() {
        let e = parse_stage("  ✓ [search] Found 12 papers \u{2014} count=12").unwrap();
        assert_eq!(e.stage, "search");
        assert_eq!(e.message, "Found 12 papers");
        assert!(!e.degraded);
    }

    #[test]
    fn parse_stage_flags_degraded_and_ignores_unbracketed() {
        let e = parse_stage("! ⚠ degraded: [synthesis] partial \u{2014} x=1").unwrap();
        assert_eq!(e.stage, "synthesis");
        assert!(e.degraded);
        assert!(parse_stage("just a log line").is_none());
        assert!(parse_stage("   ").is_none());
        assert!(parse_stage("[] empty stage").is_none());
    }

    #[test]
    fn extract_json_object_finds_pretty_report_after_logs() {
        let out = "{\"time\":\"t\"}\n{\n  \"finalAnswer\": \"x\"\n}\n";
        let json = extract_json_object(out).unwrap();
        assert!(json.starts_with("{\n"));
        assert!(json.contains("finalAnswer"));
        assert_eq!(extract_json_object("{\"a\":1}").unwrap(), "{\"a\":1}");
        assert!(extract_json_object("no json here").is_none());
    }

    #[test]
    fn strip_log_prefix_removes_leading_structured_logs() {
        let out = "{\"time\":\"t\",\"msg\":\"a\"}\n{\"level\":\"info\"}\n# Title\n\nBody\n";
        assert_eq!(strip_log_prefix(out), "# Title\n\nBody");
        assert_eq!(strip_log_prefix("\nhello\n"), "hello");
    }

    #[test]
    fn normalized_repo_rejects_empty_path() {
        assert!(normalized_repo("   ").is_err());
        assert!(normalized_repo("\u{0}").is_err());
    }
}
