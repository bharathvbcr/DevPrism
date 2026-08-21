//! Client for the `manvi serve` sidecar.
//!
//! manvi is a separate, statically-linked Go binary that carries two things
//! this crate would otherwise have to reimplement: a policy gate whose rules
//! are pinned against DevCouncil's own engine by a 938-case parity fixture,
//! and a local-model capability prober that reads a model's real context
//! window off Ollama, vLLM or llama.cpp instead of guessing one.
//!
//! It is a process rather than a library because the two planes are Go and
//! this one is Rust. Linking them would mean cgo on manvi's side, which would
//! cost it `CGO_ENABLED=0` and the single static binary it is built to be. The
//! wire is NDJSON over stdio — one JSON object per line, correlated by a
//! caller-chosen id — which is the same shape manvi already uses to reach its
//! own Rust helpers.
//!
//! # Availability is not a verdict
//!
//! Every call here can fail because the sidecar is missing, not because the
//! question was answered. Those two must never collapse into one another: a
//! policy check that could not run must not return the same value as a policy
//! check that ran and allowed. So the outcome type has a third arm —
//! [`Verdict::Unavailable`] — and callers are forced to handle it. What a
//! caller *does* with it is a policy decision that belongs at the call site,
//! not here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

/// Wire protocol version this client speaks. Must match manvi's
/// `serve.ProtocolVersion`; the handshake refuses a mismatch rather than
/// letting a field that changed meaning be mis-decoded into a policy verdict.
const PROTOCOL_VERSION: u32 = 1;

/// Bound on one request. A sidecar call is either pure computation or one
/// bounded HTTP round-trip against loopback, so anything past this is a wedged
/// process rather than a slow answer — and a wedged sidecar must not hold a
/// tool call open, because the user is watching a spinner.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// Bound on the handshake. Deliberately shorter than `CALL_TIMEOUT`: spawn
/// happens on the path to the first write of a turn, and a missing binary
/// should degrade in well under a second rather than stall the edit.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Largest single response line accepted, matching the server's own cap.
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Environment variable naming the sidecar binary explicitly. Checked first so
/// a developer running from a source tree can point at their own build.
const BIN_ENV: &str = "DEVPRISM_MANVI_BIN";

// ─── Wire types ───

#[derive(Serialize)]
struct WireRequest<'a> {
    id: &'a str,
    op: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<&'a Value>,
}

#[derive(Deserialize)]
struct WireResponse {
    #[serde(default)]
    id: String,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<WireError>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct WireError {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

/// A decision from manvi's policy gate.
///
/// The field set is manvi's `policy.Decision` verbatim. `demoted` is the one
/// worth reading closely: an allow carrying it was produced by the host
/// posture — "no DevCouncil task model here" — rather than by the rules
/// passing, and it must never be summarised as a clean pass.
#[derive(Deserialize, Debug, Clone)]
pub struct Decision {
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub rule: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub demoted: String,
    #[serde(default)]
    pub degraded: Vec<String>,
}

impl Decision {
    pub fn blocked(&self) -> bool {
        self.action == "deny"
    }
    /// True when a denial protects the repository or its credentials — the
    /// class no task scope could ever authorise.
    pub fn hard(&self) -> bool {
        self.severity == "hard"
    }
}

/// What a model's server says it can do.
/// This is a subset of what `capability.probe` returns, not the whole of it:
/// the protocol ignores unknown fields in both directions, so a field is added
/// here when a caller needs it rather than kept in step with the wire for its
/// own sake. `supports_vision` and `supports_reasoning` are deliberately
/// absent — DevPrism establishes both by its own `/api/show` round-trip, and a
/// second unread copy would be one more thing to keep true.
#[derive(Deserialize, Debug, Clone)]
pub struct ProbeResult {
    #[serde(default)]
    pub context_window: u32,
    /// Where `context_window` came from: `declared`, `ollama:/api/show`,
    /// `vllm:/v1/models`, or `llama.cpp:/props`.
    pub source: String,
    /// Whether `source` is a server rather than our own declared fallback.
    #[serde(default)]
    pub discovered: bool,
    /// The provenance rendered for a human.
    #[serde(default)]
    pub describe: String,
    /// Whether the three capability answers below mean anything. False is "the
    /// server published none", not "no capabilities".
    #[serde(default)]
    pub capabilities_known: bool,
    #[serde(default)]
    pub supports_tools: bool,
    /// A model the server described as embedding-only: it answers the model
    /// listing beside every chat model and then fails at `/api/chat`.
    #[serde(default)]
    pub embedding: bool,
}

/// The result of asking the sidecar something.
///
/// Three arms, not two. `Unavailable` is the case where the question was never
/// put — no binary, a dead process, a timeout — and it is kept distinct from
/// `Answered` precisely so a caller cannot accidentally treat "we could not
/// check" as "we checked and it was fine".
#[derive(Debug, Clone)]
pub enum Verdict<T> {
    /// The sidecar answered.
    Answered(T),
    /// The sidecar answered, and the answer was a refusal of the request
    /// itself (bad params, unknown model, unreachable server).
    Refused(WireError),
    /// The question could not be put. Carries why, for logging.
    Unavailable(String),
}

/// Why a call did not produce an answer.
///
/// A refusal from the sidecar (`Refused`) and a transport failure
/// (`Transport`) have different remedies — the first names the request's own
/// problem, the second means the process or its pipe is gone — so they are
/// distinct types rather than one string callers must re-parse.
#[derive(Debug, Clone)]
pub enum RequestFailure {
    Refused(WireError),
    Transport(String),
}

impl RequestFailure {
    /// The log-friendly form.
    pub fn describe(&self) -> String {
        match self {
            Self::Refused(e) => format!("{}: {}", e.code, e.message),
            Self::Transport(m) => m.clone(),
        }
    }
}

// ─── Binary resolution ───

/// Resolve the sidecar binary.
///
/// The order is an explicit override, then the directory holding this
/// executable, then the PATH. The middle step is where a Tauri `externalBin`
/// sidecar lands, so a bundled build finds its own copy without needing an
/// `AppHandle` — which matters because the first caller is a tool dispatch
/// deep in a turn, nowhere near app setup.
fn resolve_binary() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var(BIN_ENV) {
        let p = PathBuf::from(raw.trim());
        if p.is_file() {
            return Ok(p);
        }
        // An override that does not resolve is an error, never a silent
        // fallthrough: someone set it on purpose and needs to know it missed.
        return Err(format!(
            "{BIN_ENV} points at {}, which is not a file",
            p.display()
        ));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Tauri names sidecars `<name>-<target-triple>` on disk but installs
            // them beside the app executable under the plain name, which is what
            // its own `relative_command_path` resolves against. Match that.
            //
            // The `deps` step mirrors the same function: under `cargo test` the
            // executable lives in `target/debug/deps`, one level below where a
            // locally-placed sidecar would sit.
            let mut roots = vec![dir];
            if dir.ends_with("deps") {
                if let Some(parent) = dir.parent() {
                    roots.push(parent);
                }
            }
            for root in roots {
                for candidate in ["manvi", "manvi.exe"] {
                    let p = root.join(candidate);
                    if p.is_file() {
                        return Ok(p);
                    }
                }
            }
        }
    }

    which::which("manvi").map_err(|_| {
        format!("no manvi binary found (set {BIN_ENV}, bundle one, or put `manvi` on PATH)")
    })
}

// ─── The sidecar ───

/// One line from the sidecar, routed to whichever call owns its id.
///
/// Returns true when the line completed a waiting call. Everything else a
/// stream can carry is ignored: events (which share the id namespace but are
/// non-terminal — completing a call on one would hand the caller a bogus
/// answer), future protocol additions, and garbage. The protocol's
/// forward-compatibility rule puts the burden of skipping unknown lines on the
/// host, and the call still has its own timeout.
fn route_line(
    line: &str,
    pending: &std::sync::Mutex<HashMap<String, oneshot::Sender<WireResponse>>>,
) -> bool {
    if line.len() > MAX_LINE_BYTES {
        return false;
    }
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return false,
    };
    if value.get("event").is_some() {
        return false;
    }
    let parsed: WireResponse = match serde_json::from_value(value) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let waiter = pending
        .lock()
        .ok()
        .and_then(|mut g| g.remove(&parsed.id));
    match waiter {
        Some(tx) => tx.send(parsed).is_ok(),
        None => false,
    }
}

/// Encode one request line, refusing one the server could never accept.
///
/// The wire caps a line at [`MAX_LINE_BYTES`] on both sides. A `chat.prepare`
/// carrying a long conversation can exceed it — and before this guard the
/// failure mode was the worst available: the write succeeded, the server
/// refused the line, and (before the harness grew per-request refusals) the
/// session died under every other in-flight call. Failing here instead hands
/// the caller a normal [`RequestFailure::Transport`], which maps to
/// [`Verdict::Unavailable`] and drops the caller onto its fallback path.
fn encode_request(id: &str, op: &str, params: Option<&Value>) -> Result<String, RequestFailure> {
    let encoded = serde_json::to_string(&WireRequest { id, op, params })
        .map_err(|e| RequestFailure::Transport(format!("encoding {op}: {e}")))?;
    // +1 for the newline that terminates the line.
    if encoded.len() + 1 > MAX_LINE_BYTES {
        return Err(RequestFailure::Transport(format!(
            "{op} request is {} bytes, past the {}-byte wire cap; \
             compact the conversation first",
            encoded.len(),
            MAX_LINE_BYTES
        )));
    }
    Ok(encoded)
}

struct Inner {
    stdin: Mutex<ChildStdin>,
    pending: Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<WireResponse>>>>,
    next_id: AtomicU64,
    child: Mutex<Child>,
}

pub struct ManviSidecar {
    inner: Arc<Inner>,
}

impl ManviSidecar {
    /// Spawn the sidecar and complete the handshake.
    async fn spawn() -> Result<Self, String> {
        let bin = resolve_binary()?;

        let mut cmd = Command::new(&bin);
        cmd.arg("serve")
            .arg("--posture")
            .arg("host")
            // Every manvi command otherwise prepares the repository it stands
            // in — creating .devcouncil/ and adding managed .gitignore rules.
            // That is right for a command an operator ran and wrong for a
            // sidecar spawned inside a user's LaTeX project, which would find
            // its working tree quietly modified by a feature it never invoked.
            .env("MANVI_HARNESS_INIT_ENABLED", "false")
            // Run from a directory DevPrism controls, not from whatever the app
            // was launched in.
            //
            // manvi reads `.devcouncil/config.yaml` relative to its working
            // directory, and it accepts only a flat mapping of dotted keys —
            // nesting is refused by name rather than misread, deliberately, so
            // that it needs no YAML dependency. But `.devcouncil/config.yaml` is
            // also DevCouncil's own file, and DevCouncil writes a *nested* one.
            // Inheriting the cwd therefore means that opening a project which
            // happens to contain one stops the sidecar from starting at all, and
            // every policy check silently degrades to unavailable.
            //
            // Nothing is lost by moving: every path, root and command this
            // client sends is an explicit parameter, so the sidecar needs no
            // project context of its own.
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherited, not piped. manvi writes diagnostics here (including
            // the WEAKENED banner when hard rules are off); piping it without
            // draining would fill the pipe buffer and wedge the process.
            .stderr(Stdio::inherit())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", bin.display()))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar stdin was not piped".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar stdout was not piped".to_string())?;

        let pending: Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<WireResponse>>>> =
            Arc::new(std::sync::Mutex::new(HashMap::new()));

        // Reader task: owns stdout for the life of the process, completing
        // whichever call each line belongs to.
        let reader_pending = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            // The loop ends on EOF or a read error, both of which mean the
            // sidecar is gone.
            while let Ok(Some(line)) = lines.next_line().await {
                route_line(&line, &reader_pending);
            }
            // Drop every waiter so in-flight calls fail now with a real reason
            // instead of each waiting out its own timeout.
            if let Ok(mut g) = reader_pending.lock() {
                g.clear();
            }
        });

        let sidecar = ManviSidecar {
            inner: Arc::new(Inner {
                stdin: Mutex::new(stdin),
                pending,
                next_id: AtomicU64::new(1),
                child: Mutex::new(child),
            }),
        };

        // Handshake before the sidecar is handed to any caller, so a version
        // mismatch surfaces here rather than as a mis-decoded verdict later.
        let hello = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            sidecar.request(
                "hello",
                Some(serde_json::json!({
                    "protocol": PROTOCOL_VERSION,
                    "host": "devprism",
                })),
            ),
        )
        .await
        .map_err(|_| "sidecar did not answer the handshake".to_string())?
        .map_err(|e| format!("sidecar refused the handshake: {}", e.describe()))?;

        let their_protocol = hello.get("protocol").and_then(Value::as_u64).unwrap_or(0);
        if their_protocol != u64::from(PROTOCOL_VERSION) {
            return Err(format!(
                "manvi speaks protocol {their_protocol}, this build speaks {PROTOCOL_VERSION}"
            ));
        }
        Ok(sidecar)
    }

    /// Send one request and await its response.
    ///
    /// Errors are the wire's own [`WireError`] when the sidecar refused the
    /// request (`ok:false`), and a plain message when the transport itself
    /// failed. Keeping the two apart here means callers never re-parse a
    /// formatted string to recover the error code.
    async fn request(&self, op: &str, params: Option<Value>) -> Result<Value, RequestFailure> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed).to_string();

        // Encoded before the waiter is registered, so a request that cannot be
        // sent at all never occupies the routing table.
        let encoded = encode_request(&id, op, params.as_ref())?;

        let (tx, rx) = oneshot::channel();
        match self.inner.pending.lock() {
            Ok(mut g) => {
                g.insert(id.clone(), tx);
            }
            Err(_) => {
                return Err(RequestFailure::Transport(
                    "sidecar routing table is poisoned".to_string(),
                ))
            }
        }

        // Registered before the write, so a response that arrives between the
        // write completing and the waiter being inserted cannot be dropped.
        let write = async {
            let mut stdin = self.inner.stdin.lock().await;
            stdin.write_all(encoded.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        };
        if let Err(e) = write.await {
            if let Ok(mut g) = self.inner.pending.lock() {
                g.remove(&id);
            }
            return Err(RequestFailure::Transport(format!(
                "writing {op} to the sidecar: {e}"
            )));
        }

        let resp = match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(resp)) => resp,
            // The reader task cleared the table: the sidecar exited.
            Ok(Err(_)) => {
                return Err(RequestFailure::Transport(
                    "the sidecar exited while a call was in flight".to_string(),
                ))
            }
            Err(_) => {
                if let Ok(mut g) = self.inner.pending.lock() {
                    g.remove(&id);
                }
                return Err(RequestFailure::Transport(format!(
                    "{op} timed out after {}s",
                    CALL_TIMEOUT.as_secs()
                )));
            }
        };

        if !resp.ok {
            let err = resp.error.unwrap_or(WireError {
                code: "E_INTERNAL".into(),
                message: format!("{op} failed without naming a reason"),
                retryable: false,
            });
            return Err(RequestFailure::Refused(err));
        }
        Ok(resp.result.unwrap_or(Value::Null))
    }

    /// Whether the child is still running.
    async fn alive(&self) -> bool {
        matches!(self.inner.child.lock().await.try_wait(), Ok(None))
    }
}

// ─── Process-wide handle ───

/// The live sidecar, if one has been started successfully.
///
/// A `tokio::Mutex<Option<..>>` rather than a `OnceLock`, because the process
/// can die — Ollama restarts, a user kills it, the binary is replaced by an
/// update — and a handle that could never be replaced would turn one death
/// into a permanently degraded session.
fn handle() -> &'static Mutex<Option<Arc<ManviSidecar>>> {
    static H: OnceLock<Mutex<Option<Arc<ManviSidecar>>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(None))
}

/// Remember a spawn failure so a missing binary costs one failed spawn rather
/// than one per tool call, which on a 16-step turn would be 16 process spawns
/// and 16 identical log lines.
fn spawn_failure() -> &'static std::sync::Mutex<Option<String>> {
    static F: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();
    F.get_or_init(|| std::sync::Mutex::new(None))
}

/// Get the sidecar, starting or restarting it if needed.
async fn get() -> Result<Arc<ManviSidecar>, String> {
    if let Ok(g) = spawn_failure().lock() {
        if let Some(reason) = g.as_ref() {
            return Err(reason.clone());
        }
    }

    let mut slot = handle().lock().await;
    if let Some(existing) = slot.as_ref() {
        if existing.alive().await {
            return Ok(Arc::clone(existing));
        }
        // Dead: drop it and fall through to a fresh spawn.
        *slot = None;
    }

    match ManviSidecar::spawn().await {
        Ok(sidecar) => {
            let shared = Arc::new(sidecar);
            EVER_SPAWNED.store(true, Ordering::Relaxed);
            *slot = Some(Arc::clone(&shared));
            Ok(shared)
        }
        Err(e) => {
            if let Ok(mut g) = spawn_failure().lock() {
                *g = Some(e.clone());
            }
            Err(e)
        }
    }
}

/// Whether a sidecar has ever started successfully in this process.
///
/// `chat.forget` consults this before doing anything: the sidecar spawns
/// lazily on first use, so a host that clears a tab before any gated tool call
/// or planned turn would otherwise start a whole process — spawn, handshake,
/// reader task — purely to delete a session ledger that was never created.
static EVER_SPAWNED: AtomicBool = AtomicBool::new(false);

/// Discard the live sidecar so the next call spawns a fresh one.
///
/// Liveness is not the same as usability, and `alive()` only answers the first
/// question. The stored handle owns a `ChildStdin` and a reader task bound to
/// whichever tokio runtime spawned them; if that runtime goes away — or the
/// pipe breaks, or the child is killed between our check and our write — the
/// child can still be running while every write to it fails forever. Without
/// this, one such failure degrades the sidecar for the rest of the process.
async fn invalidate() {
    let mut slot = handle().lock().await;
    *slot = None;
    // Also clear any cached spawn failure, or the retry would be answered from
    // the cache without ever attempting a respawn.
    if let Ok(mut g) = spawn_failure().lock() {
        *g = None;
    }
}

/// Run one op, mapping every failure mode onto a [`Verdict`].
///
/// A transport failure is retried exactly once against a freshly spawned
/// sidecar. The failure it covers is ordinary: the child was killed, the pipe
/// broke, or the runtime that owned its I/O handles went away between one call
/// and the next — none of which is a reason to report a policy check as
/// unanswerable when asking again would work. Once, not in a loop: if the
/// second attempt also fails the sidecar is genuinely unusable, and retrying
/// further would just add latency to every tool call in a broken session.
async fn call<T: for<'de> Deserialize<'de>>(op: &str, params: Value) -> Verdict<T> {
    match call_once(op, params.clone()).await {
        Verdict::Unavailable(first) => {
            invalidate().await;
            match call_once(op, params).await {
                // Report the *first* failure: it is the one that describes what
                // actually went wrong, where the second only says the respawn
                // did not rescue it.
                Verdict::Unavailable(second) => {
                    Verdict::Unavailable(format!("{first} (retry also failed: {second})"))
                }
                recovered => recovered,
            }
        }
        settled => settled,
    }
}

async fn call_once<T: for<'de> Deserialize<'de>>(op: &str, params: Value) -> Verdict<T> {
    let sidecar = match get().await {
        Ok(s) => s,
        Err(e) => return Verdict::Unavailable(e),
    };
    match sidecar.request(op, Some(params)).await {
        Ok(value) => match serde_json::from_value::<T>(value) {
            Ok(parsed) => Verdict::Answered(parsed),
            Err(e) => Verdict::Unavailable(format!("{op} returned an undecodable result: {e}")),
        },
        // A refusal of the request and a dead sidecar are different conditions
        // with different remedies, so the transport/refusal split decided by
        // `request` is carried structurally rather than recovered from text.
        Err(RequestFailure::Refused(err)) => Verdict::Refused(err),
        Err(RequestFailure::Transport(message)) => Verdict::Unavailable(message),
    }
}

// ─── Operations ───

/// Evaluate one file write against manvi's write gate.
pub async fn check_file(project_dir: &std::path::Path, rel_path: &str) -> Verdict<Decision> {
    call(
        "policy.check.file",
        serde_json::json!({
            "root": project_dir.to_string_lossy(),
            "path": rel_path,
            "op": "write",
        }),
    )
    .await
}

/// Evaluate one shell command against manvi's command gate.
pub async fn check_command(command: &str) -> Verdict<Decision> {
    call(
        "policy.check.command",
        serde_json::json!({ "command": command }),
    )
    .await
}

/// One tool result to shorten, and the text to shorten it to.
#[derive(Deserialize, Debug, Clone)]
pub struct PrepareStep {
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub text: String,
}

/// The compaction plan for one step of a turn.
#[derive(Deserialize, Debug, Clone, Default)]
pub struct PrepareResult {
    #[serde(default)]
    pub steps: Vec<PrepareStep>,
    #[serde(default)]
    pub before_tokens: u32,
    #[serde(default)]
    pub after_tokens: u32,
    #[serde(default)]
    pub threshold_tokens: u32,
    /// Every eligible result was shortened as far as it goes and the request
    /// still exceeds the window. Surfaced rather than swallowed: the model is
    /// about to lose the head of its prompt.
    #[serde(default)]
    pub insufficient: bool,
    #[serde(default)]
    pub calibration_ratio: f64,
    /// How many real server token counts back the ratio. Zero means the
    /// budget is estimated, not measured.
    #[serde(default)]
    pub calibration_samples: u32,
}

/// A tool call read out of text the server did not parse.
#[derive(Deserialize, Debug, Clone)]
pub struct RecoveredCall {
    #[serde(default)]
    pub name: String,
    /// A JSON object, with argument types taken from the declared schema
    /// rather than guessed from the text.
    #[serde(default)]
    pub arguments: String,
}

/// What a finished reply actually contained.
#[derive(Deserialize, Debug, Clone, Default)]
pub struct SettleResult {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub reasoning: String,
    #[serde(default)]
    pub calls: Vec<RecoveredCall>,
    /// The spelling recovery recognised, empty when none was needed. A
    /// non-empty value means the server is running without a tool parser for
    /// the model it serves.
    #[serde(default)]
    pub format: String,
    /// Text already streamed to the user turned out to be reasoning.
    #[serde(default)]
    pub reclassified: bool,
    #[serde(default)]
    pub truncated: bool,
    /// The output cap landed inside a tool call's arguments. Such a call must
    /// never be dispatched, but the turn must not fail over it either.
    #[serde(default)]
    pub truncated_mid_call: bool,
    #[serde(default)]
    pub retry_message: String,
}

/// Plan what to shorten before a request goes out.
///
/// `observed_prompt_tokens` is what the server counted for the *previous*
/// request in this session; it is how the estimator corrects itself. Pass 0 on
/// the first step.
pub async fn prepare_context(
    session_id: &str,
    system: &str,
    tools: &Value,
    messages: &Value,
    context_window: u32,
    observed_prompt_tokens: u64,
) -> Verdict<PrepareResult> {
    call(
        "chat.prepare",
        serde_json::json!({
            "session_id": session_id,
            "system": system,
            "tools": tools,
            "messages": messages,
            "context_window": context_window,
            "observed_prompt_tokens": observed_prompt_tokens,
        }),
    )
    .await
}

/// Read a finished reply: reasoning, tool calls the server did not parse, and
/// truncation.
pub async fn settle_reply(
    content: &str,
    tools: &Value,
    server_parsed_calls: bool,
    finish_reason: &str,
) -> Verdict<SettleResult> {
    call(
        "chat.settle",
        serde_json::json!({
            "content": content,
            "tools": tools,
            "server_parsed_calls": server_parsed_calls,
            "finish_reason": finish_reason,
        }),
    )
    .await
}

/// Drop a conversation's compaction ledger and calibrator.
///
/// A no-op when no sidecar has ever started: the ledger lives in the sidecar,
/// so with no sidecar there is nothing to forget — and spawning one to learn
/// that would put a process start on the "new chat" path.
pub async fn forget_session(session_id: &str) {
    if !EVER_SPAWNED.load(Ordering::Relaxed) {
        return;
    }
    let _: Verdict<Value> = call(
        "chat.forget",
        serde_json::json!({ "session_id": session_id }),
    )
    .await;
}

/// Ask what a model's server says it can do.
///
/// `declared_context_window` is a floor, never a ceiling: a server publishing a
/// larger window wins. Passing DevPrism's conservative default here is how a
/// 262k-token model stops being driven at 8k.
pub async fn probe_model(
    base_url: &str,
    model: &str,
    declared_context_window: u32,
) -> Verdict<ProbeResult> {
    call(
        "capability.probe",
        serde_json::json!({
            "base_url": base_url,
            "model": model,
            "declared_context_window": declared_context_window,
            "timeout_ms": 4000,
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hard_denial_is_recognisable() {
        let d = Decision {
            action: "deny".into(),
            rule: "path.secret".into(),
            severity: "hard".into(),
            reason: "Secret and credential paths are never writable.".into(),
            target: "server.key".into(),
            demoted: String::new(),
            degraded: Vec::new(),
        };
        assert!(d.blocked());
        assert!(d.hard());
    }

    #[test]
    fn a_demoted_allow_is_not_a_denial_but_records_why() {
        let d = Decision {
            action: "allow".into(),
            rule: "task.absent".into(),
            severity: "soft".into(),
            reason: "No running DevCouncil task authorizes this file write.".into(),
            target: "src/main.tex".into(),
            demoted: "serve.posture=host: no task model in the embedding host".into(),
            degraded: Vec::new(),
        };
        assert!(!d.blocked());
        assert!(!d.demoted.is_empty());
    }

    #[test]
    fn decisions_decode_from_the_wire_shape_manvi_emits() {
        // Captured verbatim from `manvi serve`, so a field rename on either
        // side fails here rather than silently decoding to a default.
        let raw = r#"{"action":"deny","rule":"command.force_push","severity":"hard",
            "reason":"Force pushes are not allowed.","target":"git push --force origin main",
            "task_id":"host-scope"}"#;
        let d: Decision = match serde_json::from_str(raw) {
            Ok(d) => d,
            Err(e) => panic!("decoding a real manvi decision failed: {e}"),
        };
        assert!(d.blocked());
        assert!(d.hard());
        assert_eq!(d.rule, "command.force_push");
    }

    #[test]
    fn a_probe_result_decodes_and_keeps_its_provenance() {
        let raw = r#"{"model":"qwen3.8:27b-mlx","context_window":262144,
            "source":"ollama:/api/show","discovered":true,
            "describe":"262144 tokens (from ollama:/api/show)","max_output_tokens":16384,
            "capabilities_known":true,"supports_tools":true,"supports_vision":true,
            "supports_reasoning":true,"embedding":false}"#;
        let p: ProbeResult = match serde_json::from_str(raw) {
            Ok(p) => p,
            Err(e) => panic!("decoding a real probe result failed: {e}"),
        };
        assert_eq!(p.context_window, 262144);
        assert!(p.discovered);
        assert!(!p.embedding);
        assert!(p.supports_tools);
    }

    #[test]
    fn an_unknown_result_field_does_not_break_decoding() {
        // The sidecar and the app ship separately, so a newer manvi adding a
        // field must not take an older DevPrism down.
        let raw = r#"{"action":"allow","rule":"","severity":"none","reason":"ok",
            "target":"a.tex","some_future_field":{"nested":true}}"#;
        assert!(serde_json::from_str::<Decision>(raw).is_ok());
    }

    #[test]
    fn an_override_that_does_not_resolve_is_an_error_not_a_fallthrough() {
        // Guards the branch that would otherwise silently use PATH when a
        // developer's explicit override has a typo in it.
        temp_env_var(BIN_ENV, "/definitely/not/a/real/manvi", || {
            match resolve_binary() {
                Err(e) => assert!(e.contains(BIN_ENV), "error should name the variable: {e}"),
                Ok(p) => panic!("a bogus override resolved to {}", p.display()),
            }
        });
    }

    /// Drive the real sidecar binary end to end: spawn, handshake, and three
    /// calls whose answers exercise both gates and the prober.
    ///
    /// `#[ignore]` because it needs a manvi build, which not every checkout or
    /// CI runner has. Run it with:
    ///
    ///   DEVPRISM_MANVI_BIN=/path/to/manvi cargo test --lib \
    ///       drives_the_real_sidecar -- --ignored --nocapture
    ///
    /// It fails rather than skips when the variable is set and the binary is
    /// missing: a test that quietly passes because it did not run is the exact
    /// failure this module's doc comment is about.
    #[tokio::test]
    #[ignore]
    async fn drives_the_real_sidecar() {
        if std::env::var(BIN_ENV).is_err() {
            panic!("set {BIN_ENV} to a manvi build to run this test");
        }

        let project = std::path::Path::new("/tmp/devprism-policy-probe");

        // A root-level deploy key: refused by a rung that runs before any task
        // is consulted, so no task model is needed for it to fire.
        match check_file(project, "server.key").await {
            Verdict::Answered(d) => {
                assert!(d.blocked(), "a deploy key was writable: {d:?}");
                assert!(d.hard(), "the denial was not hard: {d:?}");
                assert_eq!(d.rule, "path.secret");
            }
            other => panic!("policy.check.file did not answer: {other:?}"),
        }

        // An ordinary source file: allowed, but demoted rather than clean,
        // because the allow comes from the host posture and not from a rule.
        match check_file(project, "src/main.tex").await {
            Verdict::Answered(d) => {
                assert!(!d.blocked(), "an ordinary edit was blocked: {d:?}");
                assert!(!d.demoted.is_empty(), "a posture allow left no record: {d:?}");
            }
            other => panic!("policy.check.file did not answer: {other:?}"),
        }

        // Git safety survives the host posture.
        match check_command("git push --force origin main").await {
            Verdict::Answered(d) => {
                assert!(d.blocked() && d.hard(), "force push was allowed: {d:?}");
            }
            other => panic!("policy.check.command did not answer: {other:?}"),
        }

        // And an unreachable server is reported as unreachable rather than as
        // a model that does not exist.
        match probe_model("http://127.0.0.1:1/v1", "whatever", 8192).await {
            Verdict::Refused(err) => assert_eq!(err.code, "E_UNREACHABLE"),
            other => panic!("expected E_UNREACHABLE, got {other:?}"),
        }

        // A tool call the server did not parse must be recovered, or the turn
        // renders it as prose and silently does nothing.
        let tools = serde_json::json!([{
            "name": "Read",
            "input_schema": {"type":"object","properties":{"file_path":{"type":"string"}}},
        }]);
        match settle_reply(
            r#"Let me look. <tool_call>{"name":"Read","arguments":{"file_path":"main.tex"}}</tool_call>"#,
            &tools,
            false,
            "stop",
        )
        .await
        {
            Verdict::Answered(settled) => {
                assert_eq!(settled.calls.len(), 1, "no call recovered: {settled:?}");
                assert_eq!(settled.calls[0].name, "Read");
                assert_eq!(settled.format, "hermes-json");
                assert!(
                    !settled.text.contains("<tool_call>"),
                    "call markup leaked into the answer: {:?}",
                    settled.text
                );
            }
            other => panic!("chat.settle did not answer: {other:?}"),
        }

        // Compaction must be one-way: a result shortened on one step keeps that
        // text, or the prompt prefix moves and the server re-prefills.
        let big: String = (0..400)
            .map(|i| format!("src/file.go:{i}: a matching line of source\n"))
            .collect();
        //
        // Long enough that results fall outside the protected tail: manvi
        // shields the last six messages, so a shorter turn has nothing
        // eligible and correctly plans no steps.
        let mut history = vec![serde_json::json!({"role":"user","text":"fix the build"})];
        for i in 0..8 {
            let id = format!("c{i}");
            history.push(serde_json::json!({
                "role":"assistant",
                "tool_calls":[{"id":id,"name":"Grep","arguments":"{}"}],
            }));
            history.push(serde_json::json!({
                "role":"tool", "tool_call_id":id, "text":big,
            }));
        }
        let messages = Value::Array(history);
        let first = match prepare_context("e2e", "system", &tools, &messages, 4096, 0).await {
            Verdict::Answered(p) => p,
            other => panic!("chat.prepare did not answer: {other:?}"),
        };
        assert!(!first.steps.is_empty(), "nothing compacted: {first:?}");

        // Replay with the shortening applied, exactly as the turn loop does.
        let mut applied = messages.clone();
        if let Some(arr) = applied.as_array_mut() {
            for step in &first.steps {
                for m in arr.iter_mut() {
                    if m.get("tool_call_id").and_then(Value::as_str)
                        == Some(step.tool_call_id.as_str())
                    {
                        m["text"] = serde_json::json!(step.text);
                    }
                }
            }
        }
        let second = match prepare_context("e2e", "system", &tools, &applied, 4096, 0).await {
            Verdict::Answered(p) => p,
            other => panic!("chat.prepare did not answer: {other:?}"),
        };
        for step in &second.steps {
            assert!(
                !first.steps.iter().any(|s| s.tool_call_id == step.tool_call_id),
                "{} was compacted twice; the prefix moved",
                step.tool_call_id
            );
        }

        forget_session("e2e").await;
    }

    /// The sidecar must start even when the app was launched from a directory
    /// holding a nested `.devcouncil/config.yaml`.
    ///
    /// manvi reads that path relative to its working directory and accepts only
    /// a flat mapping, so inheriting the cwd made opening such a project stop
    /// the sidecar dead — and every policy check silently degraded to
    /// unavailable. This drives the real binary from exactly that directory.
    #[tokio::test]
    #[ignore]
    async fn starts_from_a_directory_holding_a_nested_devcouncil_config() {
        if std::env::var(BIN_ENV).is_err() {
            panic!("set {BIN_ENV} to a manvi build to run this test");
        }

        let dir = std::env::temp_dir().join("devprism-nested-devcouncil");
        let state = dir.join(".devcouncil");
        if std::fs::create_dir_all(&state).is_err() {
            panic!("could not create {}", state.display());
        }
        // DevCouncil's own shape: a nested mapping, which manvi refuses by name.
        if std::fs::write(
            state.join("config.yaml"),
            "commands:\n  lint:\n  - eslint\nexecution:\n  checkpoint: true\n",
        )
        .is_err()
        {
            panic!("could not write the config fixture");
        }
        if std::env::set_current_dir(&dir).is_err() {
            panic!("could not chdir to {}", dir.display());
        }

        match check_file(std::path::Path::new("/tmp/proj"), "server.key").await {
            Verdict::Answered(d) => assert!(d.blocked() && d.hard()),
            other => panic!(
                "the sidecar did not answer from a directory with a nested \
                 .devcouncil/config.yaml: {other:?}"
            ),
        }
    }

    /// Set an env var for the duration of `f`. Tests in one binary share a
    /// process, so it is restored rather than left set.
    fn temp_env_var(key: &str, value: &str, f: impl FnOnce()) {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        f();
        match previous {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }

    /// Load the real sidecar the way a busy desktop app does: several
    /// conversations planning at once over one process, payloads in the
    /// hundreds of kilobytes, sessions opened and forgotten continuously.
    ///
    /// Every `Verdict` must be `Answered` — an `Unavailable` here means the
    /// shared pipe dropped or misrouted a call under load, which is exactly
    /// what this exists to catch.
    #[tokio::test]
    #[ignore]
    async fn stresses_the_real_sidecar_with_concurrent_and_bulky_calls() {
        if std::env::var(BIN_ENV).is_err() {
            panic!("set {BIN_ENV} to a manvi build to run this test");
        }

        let tools = serde_json::json!([{
            "name": "Read",
            "input_schema": {"type":"object","properties":{"file_path":{"type":"string"}}},
        }]);
        let big_line = "src/pkg/file.go:1: a matching line of source\n".repeat(400);

        // Eight conversations planning concurrently over the one sidecar.
        let mut handles = Vec::new();
        for s in 0..8 {
            let tools_clone = tools.clone();
            let line = big_line.clone();
            handles.push(tokio::spawn(async move {
                let session = format!("stress-{s}");
                for step in 0..6 {
                    let mut history =
                        vec![serde_json::json!({"role":"user","text":"fix the build"})];
                    for i in 0..10 {
                        let id = format!("c{s}-{step}-{i}");
                        history.push(serde_json::json!({
                            "role":"assistant",
                            "tool_calls":[{"id":id,"name":"Grep","arguments":"{}"}],
                        }));
                        history.push(
                            serde_json::json!({"role":"tool","tool_call_id":id,"text":line}),
                        );
                    }
                    let messages = Value::Array(history);
                    match prepare_context(&session, "system", &tools_clone, &messages, 4096, 0)
                        .await
                    {
                        Verdict::Answered(_) => {}
                        other => panic!("prepare {session}/{step} failed under load: {other:?}"),
                    }
                }
                forget_session(&session).await;
            }));
        }
        for h in handles {
            h.await.expect("stress task panicked");
        }

        // A single bulky request, well past what any real turn carries.
        let huge: String = "x".repeat(2_000_000);
        let mut history = vec![serde_json::json!({"role":"user","text":"fix the build"})];
        for i in 0..4 {
            let id = format!("huge-{i}");
            history.push(serde_json::json!({
                "role":"assistant",
                "tool_calls":[{"id":id,"name":"Grep","arguments":"{}"}],
            }));
            history.push(serde_json::json!({"role":"tool","tool_call_id":id,"text":huge}));
        }
        let messages = Value::Array(history);
        match prepare_context("bulky", "system", &tools, &messages, 8192, 0).await {
            Verdict::Answered(p) => assert!(
                !p.steps.is_empty(),
                "nothing planned for a 2 MB turn: plan={p:?}"
            ),
            other => panic!("a bulky but legal request failed: {other:?}"),
        }
        forget_session("bulky").await;

        // And the gates still answer after all of that.
        match check_command("git push --force origin main").await {
            Verdict::Answered(d) => assert!(d.blocked() && d.hard()),
            other => panic!("policy gate failed after load: {other:?}"),
        }
    }

    // ─── Wire-layer stress ───
    //
    // The reader task and the request encoder are where a hostile or merely
    // buggy sidecar meets this process. These drive both with generated
    // traffic and assert the properties the protocol depends on: every waiter
    // gets exactly its own response exactly once, nothing else on the wire can
    // disturb that, and an oversized request fails locally instead of being
    // written to the pipe.

    fn table() -> Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<WireResponse>>>> {
        Arc::new(std::sync::Mutex::new(HashMap::new()))
    }

    async fn waiter(table: &Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<WireResponse>>>>, id: &str) -> oneshot::Receiver<WireResponse> {
        let (tx, rx) = oneshot::channel();
        table.lock().unwrap().insert(id.to_string(), tx);
        rx
    }

    /// Whatever the stream throws at it — events interleaved between
    /// responses, responses out of order, ids nobody is waiting on, the same
    /// id twice, lines that are not JSON at all — each waiter still receives
    /// exactly its own response, exactly once.
    #[tokio::test]
    async fn routing_survives_hostile_and_interleaved_traffic() {
        let pending = table();

        const N: usize = 64;
        let mut rxs = Vec::new();
        for i in 0..N {
            rxs.push(waiter(&pending, &format!("id-{i}")).await);
        }

        // A deterministic LCG shuffles delivery order without pulling in rand.
        let mut state = 0x9E3779B97F4A7C15u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };

        // Schedule: every id's genuine response exactly once, in shuffled
        // order, with hostile noise interleaved between them.
        let mut order: Vec<usize> = (0..N).collect();
        for i in (1..order.len()).rev() {
            order.swap(i, (next() % (i + 1) as u64) as usize);
        }
        let mut delivered = 0usize;
        for i in order {
            let noise = match next() % 4 {
                // An event line for an arbitrary id must not complete anything.
                0 => format!(r#"{{"id":"id-{}","event":"delta","data":{{"t":"x"}}}}"#, (next() % N as u64) as usize),
                // An id nobody waits on.
                1 => r#"{"id":"ghost","ok":true,"result":{}}"#.to_string(),
                // Not JSON, not even close.
                2 => "this is not json".to_string(),
                _ => format!(r#"{{"id":"{}","ok":true,"result":{{}}}}"#, format!("done-{i}")),
            };
            if route_line(&noise, &pending) {
                panic!("noise line {noise} completed a call");
            }
            let genuine =
                format!(r#"{{"id":"id-{i}","ok":true,"result":{{"n":{i}}}}}"#);
            assert!(route_line(&genuine, &pending), "genuine response for id-{i} did not route");
            delivered += 1;
        }

        assert_eq!(
            delivered, N,
            "each call completes exactly once regardless of arrival order"
        );
        for (i, rx) in rxs.into_iter().enumerate() {
            let resp = rx.await.expect("waiter dropped without a response");
            assert_eq!(resp.id, format!("id-{i}"));
            assert_eq!(resp.result.unwrap()["n"], i);
        }
        assert!(
            pending.lock().unwrap().is_empty(),
            "every waiter was removed from the table"
        );
    }

    /// An oversized response line is skipped, not parsed; the calls around it
    /// are unaffected.
    #[tokio::test]
    async fn an_oversized_response_line_is_dropped_not_parsed() {
        let pending = table();
        let rx = waiter(&pending, "real").await;

        let huge = format!("\"{}\"", "x".repeat(MAX_LINE_BYTES + 1));
        assert!(!route_line(&huge, &pending), "an oversized line routed");
        assert!(
            route_line(r#"{"id":"real","ok":true,"result":{"ok":1}}"#, &pending),
            "the legitimate response after it did not route"
        );
        drop(pending);
        let resp = rx.await.expect("waiter dropped");
        assert_eq!(resp.result.unwrap()["ok"], 1);
    }

    /// A request past the wire cap fails locally — before any waiter is
    /// registered and before anything reaches the pipe.
    #[test]
    fn an_oversized_request_is_refused_before_the_pipe() {
        let big = Value::String("x".repeat(MAX_LINE_BYTES));
        match encode_request("1", "chat.prepare", Some(&big)) {
            Err(RequestFailure::Transport(m)) => {
                assert!(m.contains("wire cap"), "error should name the cap: {m}");
            }
            other => panic!("an oversized request encoded instead of refusing: {other:?}"),
        }
        // And an ordinary request still encodes.
        assert!(encode_request("1", "hello", None).is_ok());
    }

    /// Every op's params survive encoding byte for byte, so no caller can be
    /// surprised by re-encoding.
    #[test]
    fn encoding_preserves_params_exactly() {
        let params = serde_json::json!({
            "session_id": "tab-🙂",
            "messages": [{"role": "tool", "tool_call_id": "c\u{1}x", "text": "line\nbreak"}],
            "context_window": 65536,
        });
        let encoded = encode_request("42", "chat.prepare", Some(&params)).expect("encode");
        let v: Value = serde_json::from_str(&encoded).expect("valid json");
        assert_eq!(v["params"], params);
        assert_eq!(v["op"], "chat.prepare");
        assert_eq!(v["id"], "42");
    }
}
