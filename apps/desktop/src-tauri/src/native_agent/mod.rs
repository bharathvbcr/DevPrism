//! Native, claude-CLI-free agent runtime.
//!
//! Talks DIRECTLY to a local Ollama server (`/api/chat` with native tool
//! calling) — no `claude` CLI and no Anthropic translation proxy. The tool loop,
//! tools, and project context are all implemented in Rust here.
//!
//! It emits the SAME Tauri events as the Claude CLI path (`claude-output` lines
//! in stream-json shape, then `claude-complete`), so the existing chat UI renders
//! its output and detects file changes without modification.

pub mod delta_coalesce;
pub mod manvi_sidecar;
pub(crate) mod ollama;
pub mod openai_compat;
mod tools;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, WebviewWindow};
use tokio::sync::Notify;

const MAX_ITERATIONS: usize = 16;
/// How many times to (re)issue a single chat request before giving up. A
/// transient failure (server unreachable during a VRAM swap, a dropped stream,
/// a 5xx) otherwise discards all in-turn progress.
const MAX_CHAT_ATTEMPTS: u32 = 3;
/// Keep the frontend idle watchdog from tripping during long tool runs or AskUser waits.
const TOOL_HEARTBEAT_SECS: u64 = 30;

/// Whether a chat error is worth retrying: transient transport / server issues,
/// but NOT a permanent capability/config error (no tools, no model) which would
/// just fail again identically.
fn is_retryable_chat_error(err: &str) -> bool {
    if err.contains("E_NO_TOOLS") || err.contains("E_NO_MODEL") {
        return false;
    }
    err.contains("E_OLLAMA_UNREACHABLE")
        || err.contains("E_OLLAMA_STALLED")
        || err.contains("E_OPENAI_UNREACHABLE")
        || err.contains("E_OPENAI_STALLED")
        || err.contains("E_RATE_LIMIT")
        // A truncated tool-call argument buffer means the stream was cut, which
        // is transient in exactly the way a stalled stream is.
        || err.contains("E_BAD_TOOL_ARGS")
        || err.contains("E_OPENAI_EMPTY")
        || err.contains("Ollama stream error")
        || err.contains("OpenAI stream error")
        || err.contains("Ollama returned HTTP 5")
        || err.contains("OpenAI API returned HTTP 5")
}

/// Unified chat backend for the native agent tool loop (Ollama or OpenAI-compat).
enum NativeChatClient {
    Ollama(ollama::OllamaClient),
    OpenAi(openai_compat::OpenAiCompatClient),
}

impl NativeChatClient {
    fn num_ctx(&self) -> u32 {
        match self {
            Self::Ollama(c) => c.num_ctx(),
            Self::OpenAi(c) => c.num_ctx(),
        }
    }

    async fn supports_tools(&self) -> Option<bool> {
        match self {
            Self::Ollama(c) => c.supports_tools().await,
            Self::OpenAi(c) => c.supports_tools().await,
        }
    }

    async fn supports_vision(&self) -> Option<bool> {
        match self {
            Self::Ollama(c) => c.supports_vision().await,
            Self::OpenAi(c) => c.supports_vision().await,
        }
    }

    async fn chat<F: FnMut(ollama::StreamDeltaKind, &str)>(
        &self,
        messages: &Value,
        tools: &Value,
        on_delta: F,
    ) -> Result<ollama::ChatTurn, String> {
        match self {
            Self::Ollama(c) => c.chat(messages, tools, on_delta).await,
            Self::OpenAi(c) => c.chat(messages, tools, on_delta).await,
        }
    }
}

/// Synthetic prompt used to nudge a model that returned nothing; never persisted.
const CONTINUE_NUDGE: &str =
    "Continue. If the task is complete, give a short final summary; otherwise use a tool.";

fn is_continue_nudge(m: &Value) -> bool {
    m.get("role").and_then(|r| r.as_str()) == Some("user")
        && m.get("content").and_then(|c| c.as_str()) == Some(CONTINUE_NUDGE)
}

const SYSTEM_RULES: &str = concat!(
    "You are DevPrism's writing assistant, working INSIDE the user's project on their machine. ",
    "You have tools: Read, Write, Edit, MultiEdit, LS, Grep, Glob, Bash, Compile, AskUser. To get oriented, run LS with depth 2-3 for a ",
    "directory tree, Glob to find files by name (e.g. *.tex), and Grep to find text inside files. Pass Grep a ",
    "context value (e.g. 3) to see the lines around each match, then Read that file with offset/limit to pull ",
    "just that region before editing. Do not ask the user for file contents you can read yourself.\n",
    "Rules:\n",
    "1. PLAN, then act in small steps. Read a file (the relevant slice is enough) before editing it.\n",
    "2. Prefer Edit (a unique old_string -> new_string) over rewriting whole files with Write. For several ",
    "edits to ONE file, use MultiEdit (a list of edits applied atomically) instead of repeated Edit calls.\n",
    "3. For LaTeX: keep the preamble/structure intact; use Compile after substantive edits — it returns ",
    "structured errors (file, line, message). DevPrism also auto-compiles on save.\n",
    "4. Python: a project .venv is auto-activated; use Bash with `uv run python ...`.\n",
    "5. PROJECT CONTEXT & AUTONOMY: first read any instruction/master/profile files listed below ",
    "and consult the project map and installed skills; do not ask for details that are already there. ",
    "If a DevCouncil repo map (`.devcouncil/repo_map.json`) is listed, open it before broad exploration ",
    "and prefer its subsystems/entry points over guessing file locations. ",
    "Keep going until the task is complete, then give a short summary.\n",
    "6. AskUser: only when you are genuinely blocked on a decision you cannot resolve from the ",
    "project files or the conversation (the request is ambiguous between materially different ",
    "outcomes), call AskUser with ONE short question and up to 4 answer options, then continue ",
    "using the reply. Never ask for anything you can look up with the other tools, and prefer ",
    "a sensible default over asking."
);

/// Longest selection echoed into the prompt verbatim; beyond this it's truncated
/// and the model is told to re-read the region for the exact text.
const SELECTION_MAX: usize = 1500;
/// Lines of context loaded above/below the selection, and the bounds on the
/// pre-loaded slice so it can't dominate the prompt.
const CTX_MARGIN: u32 = 8;
const CTX_MAX_LINES: u32 = 50;
const CTX_MAX_BYTES: usize = 3000;
/// A selection-less active file at/under these bounds is inlined whole, so even
/// "tighten this intro" on a short file skips the orientation Read.
const WHOLE_FILE_MAX_LINES: usize = 60;
const WHOLE_FILE_MAX_BYTES: u64 = 4000;

/// Normalize the editor's open-file path to a safe project-relative path, or
/// None when it's unusable. Rejects blank, `..` traversal, an absolute path, and
/// a Windows drive prefix — important because we both point the model at it AND
/// read it directly from disk below (bypassing the tool layer's own checks).
fn normalize_rel(active_file: Option<&str>) -> Option<String> {
    let raw = active_file?.trim().replace('\\', "/");
    let rel = raw.trim_start_matches("./").to_string();
    if rel.is_empty()
        || rel.starts_with('/')
        || rel.split('/').any(|seg| seg == "..")
        || rel.chars().nth(1) == Some(':')
    {
        return None;
    }
    Some(rel)
}

/// Read the lines around a selection (±CTX_MARGIN) from `rel`, line-numbered,
/// with a `>` marker on the selected lines, so the model can edit in context
/// without a separate Read. Bounded by line count and bytes; None on any read
/// failure or an out-of-range start (e.g. the file changed since selection).
fn read_surrounding_lines(project_dir: &Path, rel: &str, start: u32, end: u32) -> Option<String> {
    let path = project_dir.join(rel);
    // Don't slurp a pathologically large file just to slice a few lines — fall
    // back to the "Read with offset" pointer (which uses the tool's bounded read).
    if std::fs::metadata(&path)
        .map(|m| m.len())
        .unwrap_or(u64::MAX)
        > 2 * 1024 * 1024
    {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len() as u32;
    if total == 0 || start > total {
        return None;
    }
    let from = start.saturating_sub(CTX_MARGIN).max(1);
    let to = end
        .saturating_add(CTX_MARGIN)
        .min(total)
        .min(from + CTX_MAX_LINES - 1);
    let mut out = String::new();
    for ln in from..=to {
        let text = lines[(ln - 1) as usize].trim_end();
        let marker = if ln >= start && ln <= end { '>' } else { ' ' };
        out.push_str(&format!("{marker}{ln:>5}  {text}\n"));
        if out.len() >= CTX_MAX_BYTES {
            out.push_str("  …(more)\n");
            break;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Read a selection-less active file whole when it's small, as raw content
/// (directly usable as Edit's old_string), so a deictic prompt with no selection
/// ("tighten this intro") doesn't need a first Read. None when absent, empty,
/// binary/non-UTF-8, or over the line/byte bounds.
fn read_small_file(project_dir: &Path, rel: &str) -> Option<String> {
    let path = project_dir.join(rel);
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > WHOLE_FILE_MAX_BYTES {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    if content.lines().count() > WHOLE_FILE_MAX_LINES {
        return None;
    }
    let trimmed = content.trim_end();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Build the "## ACTIVE FILE" system-prompt block from the editor's open file
/// (already-normalized `rel`), current selection, its line range, and an
/// optional pre-loaded context slice — so deictic requests ("fix this
/// paragraph", "the selection") resolve without the user naming a path, and the
/// model can edit in context without an extra Read.
fn active_file_hint(
    rel: &str,
    selection: Option<&str>,
    sel_lines: Option<(u32, u32)>,
    context_slice: Option<&str>,
    whole_file: Option<&str>,
) -> String {
    let mut out = format!(
        "\n\n## ACTIVE FILE\nThe user currently has `{rel}` open in the editor. \
         When they say \"this\", \"here\", \"this paragraph\", \"this file\", \"the selection\", \
         or otherwise refer to their work without naming a file, they mean `{rel}`: Read it (or just \
         the relevant slice) and edit it directly — do not ask which file they mean.\n"
    );

    let has_selection = selection.map(|s| !s.trim().is_empty()).unwrap_or(false);

    // No selection but a short file: inline the whole thing so even "tighten this
    // intro" can be edited without a first Read.
    if !has_selection {
        if let Some(wf) = whole_file {
            out.push_str(&format!(
                "\n`{rel}` is short, so here is its full current content — edit it directly with Edit \
                 (copy exact text from here as old_string), no need to Read it first:\n---\n{wf}\n---\n"
            ));
        }
    }

    // If there's a non-empty selection, echo it so "this paragraph" targets the
    // precise span. A short selection is verbatim (usable as Edit's old_string);
    // a long one is truncated and the model is told to re-read for exact text.
    if let Some(sel) = selection {
        let sel = sel.trim();
        if !sel.is_empty() {
            if sel.len() > SELECTION_MAX {
                let mut cut = SELECTION_MAX;
                while cut > 0 && !sel.is_char_boundary(cut) {
                    cut -= 1;
                }
                out.push_str(&format!(
                    "\nThe user has a block of text selected in `{rel}` (\"this\" / \"this paragraph\" / \
                     \"the selection\" refers to it). It is long, so it is shown truncated below — Read \
                     that region of the file to get the exact text before editing:\n---\n{}\n…(truncated)\n---\n",
                    &sel[..cut]
                ));
            } else {
                out.push_str(&format!(
                    "\nThe user has this exact text selected in `{rel}` (\"this\" / \"this paragraph\" / \
                     \"the selection\" refers to it). It is a verbatim substring of the file, so you can \
                     pass it as Edit's old_string to change exactly that span:\n---\n{sel}\n---\n"
                ));
            }
            // Prefer the pre-loaded surrounding lines (no extra Read needed); fall
            // back to a "Read with offset" pointer when the slice couldn't be read.
            if let Some(slice) = context_slice {
                out.push_str(&format!(
                    "Here are the lines around the selection ('>' marks the selected lines), so you can \
                     edit it in context without reading the file again:\n```\n{slice}```\n"
                ));
            } else if let Some((start, end)) = sel_lines {
                if start >= 1 {
                    let ctx_start = start.saturating_sub(10).max(1);
                    out.push_str(&format!(
                        "The selection spans lines {start}-{end} of `{rel}`. To edit it with its \
                         surrounding context in view, Read `{rel}` with offset {ctx_start} first.\n"
                    ));
                }
            }
        }
    }
    out
}

// ─── Cancellation registry (per tab) ───
//
// The flag is checked at sync points; the Notify aborts an in-flight HTTP/Bash
// await (via tokio::select!) so "stop" is responsive mid-generation.

struct CancelHandle {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Clone for CancelHandle {
    fn clone(&self) -> Self {
        Self {
            flag: Arc::clone(&self.flag),
            notify: Arc::clone(&self.notify),
        }
    }
}

fn cancels() -> &'static Mutex<HashMap<String, CancelHandle>> {
    static C: OnceLock<Mutex<HashMap<String, CancelHandle>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Separate cancel registry for one-shot `ai_complete` / `ai_complete_stream` /
/// `ai_embed` requests (keyed by frontend-generated request id).
fn ai_request_cancels() -> &'static Mutex<HashMap<String, CancelHandle>> {
    static A: OnceLock<Mutex<HashMap<String, CancelHandle>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

const CLAUDE_CODE_PROVIDER_ID: &str = "__claude-code__";
const CURSOR_CLI_PROVIDER_ID: &str = "__cursor-cli__";

fn register_ai_request_cancel(request_id: &str) -> CancelHandle {
    let handle = CancelHandle {
        flag: Arc::new(AtomicBool::new(false)),
        notify: Arc::new(Notify::new()),
    };
    if let Ok(mut guard) = ai_request_cancels().lock() {
        guard.insert(request_id.to_string(), handle.clone());
    }
    handle
}

fn take_ai_request_cancel(request_id: &str) {
    if let Ok(mut guard) = ai_request_cancels().lock() {
        guard.remove(request_id);
    }
}

fn clone_cancel_parts(
    handle: &CancelHandle,
) -> (Arc<AtomicBool>, Arc<Notify>) {
    (Arc::clone(&handle.flag), Arc::clone(&handle.notify))
}

// ─── Pending AskUser answers (per question) ───
//
// Mirrors the cancel registry above: an AskUser tool call parks the agent loop
// on a Notify until `answer_native_agent_question` fills the slot (or the turn
// is cancelled / the wait times out). Keys are the tool_use ids already shown
// to the UI (`native_{tab}_{iter}_{idx}`), so the chat widget's reply resolves
// exactly the question that was asked.

/// How long an AskUser call waits for the user before giving up gracefully.
const ASK_USER_TIMEOUT_SECS: u64 = 10 * 60;

struct PendingAnswer {
    slot: Arc<Mutex<Option<String>>>,
    notify: Arc<Notify>,
}

fn pending_answers() -> &'static Mutex<HashMap<String, PendingAnswer>> {
    static P: OnceLock<Mutex<HashMap<String, PendingAnswer>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_pending_answer(request_id: &str) {
    if let Ok(mut g) = pending_answers().lock() {
        g.insert(
            request_id.to_string(),
            PendingAnswer {
                slot: Arc::new(Mutex::new(None)),
                notify: Arc::new(Notify::new()),
            },
        );
    }
}

fn remove_pending_answer(request_id: &str) {
    if let Ok(mut g) = pending_answers().lock() {
        g.remove(request_id);
    }
}

/// Drop any pending-answer entries left over from a tab's turn: cancel and
/// error paths can exit the tool round before an AskUser wait consumes its
/// entry, and a leaked entry would let a stale widget "answer" a dead turn.
fn sweep_pending_answers(tab_id: &str) {
    let prefix = format!("native_{tab_id}_");
    if let Ok(mut g) = pending_answers().lock() {
        g.retain(|k, _| !k.starts_with(&prefix));
    }
}

/// Wait for the user's reply to a pending AskUser question. Resolves to
/// Some(answer) when answered, None on timeout (or a missing entry).
/// Cancellation is raced by the caller's tokio::select!.
async fn wait_for_answer(request_id: &str) -> Option<String> {
    let (slot, notify) = {
        let guard = pending_answers().lock().ok()?;
        let p = guard.get(request_id)?;
        (p.slot.clone(), p.notify.clone())
    };
    let answered = async move {
        loop {
            if let Some(a) = slot.lock().ok().and_then(|mut s| s.take()) {
                return a;
            }
            // `notify_one` in the answer command stores a permit, so an answer
            // that lands between the check above and this await is not lost.
            notify.notified().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(ASK_USER_TIMEOUT_SECS), answered)
        .await
        .ok()
}

/// Deliver the user's reply to a pending AskUser question (called by the chat
/// widget). Errors when the question is no longer pending — already answered,
/// timed out, or the run was stopped.
#[tauri::command]
pub fn answer_native_agent_question(request_id: String, answer: String) -> Result<(), String> {
    let handle = pending_answers().lock().ok().and_then(|g| {
        g.get(&request_id)
            .map(|p| (p.slot.clone(), p.notify.clone()))
    });
    match handle {
        Some((slot, notify)) => {
            if let Ok(mut s) = slot.lock() {
                *s = Some(answer);
            }
            notify.notify_one();
            Ok(())
        }
        None => Err(
            "No pending question with this id — it may have been answered already, timed out, or the run was stopped."
                .into(),
        ),
    }
}

/// Drop any trailing, incomplete turn so the persisted history always ends at a
/// clean boundary (a user message or an assistant reply with no pending tools).
/// A no-op on normal completion; matters when a turn is cancelled mid tool-loop.
fn repair_tail(messages: &mut Vec<Value>) {
    while let Some(last) = messages.last() {
        let role = last.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let assistant_no_tools = role == "assistant"
            && !last
                .get("tool_calls")
                .and_then(|t| t.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
        if role == "user" || assistant_no_tools {
            break;
        }
        messages.pop();
    }
}

// ─── Per-tab conversation memory (multi-turn) ───
//
// Stored history is everything EXCEPT the system message (which is rebuilt fresh
// each turn so the project context stays current). Bounded by total bytes.

const HISTORY_BYTE_CAP: usize = 24 * 1024;

fn sessions() -> &'static Mutex<HashMap<String, Vec<Value>>> {
    static S: OnceLock<Mutex<HashMap<String, Vec<Value>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load_history(tab_id: &str) -> Vec<Value> {
    sessions()
        .lock()
        .ok()
        .and_then(|g| g.get(tab_id).cloned())
        .unwrap_or_default()
}

fn save_history(tab_id: &str, mut history: Vec<Value>) {
    fn is_user(m: &Value) -> bool {
        m.get("role").and_then(|r| r.as_str()) == Some("user")
    }
    fn fits(h: &[Value]) -> bool {
        let size: usize = h.iter().map(|m| m.to_string().len()).sum();
        size <= HISTORY_BYTE_CAP
    }
    // Trim oldest *whole exchanges* (user boundary -> next user boundary) until
    // the serialized history fits the byte cap. Trimming single messages can
    // leave an orphaned assistant/tool head whose subsequent repair then drops a
    // complete exchange that actually fit — this removes that exchange explicitly.
    while !fits(&history) {
        // Index of the second user message = start of the second exchange.
        let next = history
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, m)| is_user(m))
            .map(|(i, _)| i);
        match next {
            Some(n) => {
                history.drain(0..n);
            }
            // Only one exchange left: keep it even if it exceeds the cap so we
            // never empty the history (in-turn compaction bounds the live prompt).
            None => break,
        }
    }
    // Defensive: ensure we still start at a user boundary (a dangling
    // assistant-tool_calls or tool message at the head breaks Ollama).
    while history.first().map(|m| !is_user(m)).unwrap_or(false) {
        history.remove(0);
    }
    if let Ok(mut g) = sessions().lock() {
        g.insert(tab_id.to_string(), history);
    }
}

struct CompactionResult {
    total_bytes: usize,
    dropped: Vec<String>,
}

/// Keep the in-turn prompt from blowing past the budget by stubbing out the
/// OLDEST large tool results. Preserves `messages[0]` (the system rules) and the
/// most recent messages (the tool output the model is currently reasoning about)
/// so only stale, bulky results are shed. Mutates in place and returns what was
/// shed so the UI can surface it.
fn compact_tool_results(messages: &mut Value, budget_bytes: usize) -> CompactionResult {
    let arr = match messages.as_array_mut() {
        Some(a) => a,
        None => {
            return CompactionResult {
                total_bytes: 0,
                dropped: Vec::new(),
            }
        }
    };
    let mut dropped: Vec<String> = Vec::new();
    let mut total: usize = arr.iter().map(|m| m.to_string().len()).sum();
    if total <= budget_bytes {
        return CompactionResult {
            total_bytes: total,
            dropped,
        };
    }
    let mut over = total - budget_bytes;
    // Walk oldest -> newest, skipping the system message (index 0) and stopping
    // two short of the end so the latest tool result stays intact.
    let last = arr.len().saturating_sub(2);
    for i in 1..last {
        if over == 0 {
            break;
        }
        // Shed a stale base64 image first: it's usually the single largest
        // contributor and re-uploading it each round buys nothing (local vision
        // models don't retain prior-turn images anyway). Measure the message
        // before/after so the accounting matches the real serialized reduction
        // (which also drops the `"images":` key bytes).
        if arr[i].get("role").and_then(|r| r.as_str()) == Some("user")
            && arr[i].get("images").is_some()
        {
            let before_len = arr[i].to_string().len();
            if let Some(obj) = arr[i].as_object_mut() {
                obj.remove("images");
            }
            let saved = before_len.saturating_sub(arr[i].to_string().len());
            if saved > 0 {
                dropped.push("image attachment".to_string());
            }
            over = over.saturating_sub(saved);
            total -= saved.min(total);
            continue;
        }
        if arr[i].get("role").and_then(|r| r.as_str()) == Some("tool") {
            let name = arr[i]
                .get("tool_name")
                .and_then(|n| n.as_str())
                .unwrap_or("tool")
                .to_string();
            let old = arr[i]
                .get("content")
                .and_then(|c| c.as_str())
                .map(|s| s.len())
                .unwrap_or(0);
            let stub = format!("[earlier {name} result elided to fit the context window]");
            if stub.len() < old {
                arr[i]["content"] = json!(stub);
                let saved = old - stub.len();
                dropped.push(format!("{name} result"));
                over = over.saturating_sub(saved);
                total -= saved;
            }
        }
    }
    CompactionResult {
        total_bytes: total,
        dropped,
    }
}

fn emit_context_truncation(window: &WebviewWindow, tab_id: &str, dropped: &[String], source: &str) {
    if dropped.is_empty() {
        return;
    }
    let unique: Vec<String> = dropped
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let list = unique.join(", ");
    emit_msg(
        window,
        tab_id,
        &json!({
            "type": "assistant",
            "subtype": "context_truncation",
            "contextDropped": unique,
            "message": { "content": [{
                "type": "text",
                "text": format!(
                    "_Context trimmed ({source}): {list}. Older details may need to be re-read._"
                ),
            }]}
        }),
    );
}

/// Drop base64 image payloads from user messages in place. The model already
/// saw any image during the turn it was sent on; re-sending the (often large)
/// base64 blob on every subsequent turn only bloats the prompt, and a single
/// image can exceed the whole history byte cap and evict useful text history.
fn strip_persisted_images(arr: &mut [Value]) {
    for m in arr.iter_mut() {
        if m.get("role").and_then(|r| r.as_str()) == Some("user") {
            if let Some(obj) = m.as_object_mut() {
                obj.remove("images");
            }
        }
    }
}

/// Clear a tab's native conversation memory (e.g. on "new chat").
#[tauri::command]
pub fn clear_native_session(tab_id: String) {
    if let Ok(mut g) = sessions().lock() {
        g.remove(&tab_id);
    }
    // The sidecar holds this conversation's compaction ledger and calibrator.
    // Left behind, they would shorten a fresh conversation's first tool result
    // to text it never produced, and a desktop app that opens tabs all day
    // would accumulate one ledger per closed tab.
    //
    // Spawned rather than awaited: this is called from a synchronous command
    // whose caller is clearing the UI, and a missing sidecar must not make
    // "new chat" fail.
    //
    // `tokio::spawn` panics outside a runtime, and this function is reachable
    // from plain synchronous contexts as well as from Tauri commands. Asking
    // for the handle instead means the no-runtime case skips the notification
    // rather than taking the caller down — and skipping it is survivable: the
    // ledger is bounded by the number of tabs and costs only memory in the
    // sidecar, whereas panicking loses the user's "new chat".
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let id = tab_id.clone();
        handle.spawn(async move { manvi_sidecar::forget_session(&id).await });
    }
}

#[derive(Serialize, Clone)]
struct OutputEvent {
    tab_id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct CompleteEvent {
    tab_id: String,
    success: bool,
}

/// Emit one stream-json message line to the chat UI (same shape as the CLI path).
fn emit_msg(window: &WebviewWindow, tab_id: &str, msg: &Value) {
    let _ = window.emit(
        "claude-output",
        OutputEvent {
            tab_id: tab_id.to_string(),
            data: msg.to_string(),
        },
    );
}

/// Lightweight keepalive so the chat UI knows a long-running tool or AskUser wait
/// is still active (resets the frontend stream watchdog without appending to chat).
fn stream_heartbeat_message(phase: &str, detail: Option<&str>) -> Value {
    let mut payload = json!({
        "type": "system",
        "subtype": "heartbeat",
        "phase": phase,
    });
    if let Some(detail) = detail {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("detail".to_string(), json!(detail));
        }
    }
    payload
}

fn emit_stream_heartbeat(window: &WebviewWindow, tab_id: &str, phase: &str, detail: Option<&str>) {
    emit_msg(window, tab_id, &stream_heartbeat_message(phase, detail));
}

async fn with_stream_heartbeats<F, T>(
    window: WebviewWindow,
    tab_id: String,
    phase: &'static str,
    detail: Option<String>,
    work: F,
) -> T
where
    F: std::future::Future<Output = T>,
{
    use tokio::time::{interval, MissedTickBehavior};

    let mut heartbeat = interval(Duration::from_secs(TOOL_HEARTBEAT_SECS));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
    heartbeat.tick().await;

    tokio::pin!(work);
    loop {
        tokio::select! {
            res = &mut work => return res,
            _ = heartbeat.tick() => {
                emit_stream_heartbeat(&window, &tab_id, phase, detail.as_deref());
            }
        }
    }
}

fn emit_result(window: &WebviewWindow, tab_id: &str, ok: bool, text: &str) {
    emit_msg(
        window,
        tab_id,
        &json!({
            "type": "result",
            "subtype": if ok { "success" } else { "error" },
            "is_error": !ok,
            "result": text,
        }),
    );
}

/// Emit synthetic cancelled tool_results for tool_use blocks that were shown to
/// the UI but won't run (the turn was cancelled mid tool-loop), so the chat
/// doesn't leave those tool calls spinning forever.
fn emit_cancelled_tool_results(window: &WebviewWindow, tab_id: &str, ids: &[String]) {
    for id in ids {
        emit_msg(
            window,
            tab_id,
            &json!({
                "type": "user",
                "message": { "content": [{
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": "(cancelled)",
                    "is_error": true,
                }]}
            }),
        );
    }
}

/// Deliver a semantic-cache hit to the chat UI without invoking the model.
#[tauri::command]
pub async fn deliver_cached_native_reply(
    window: WebviewWindow,
    tab_id: String,
    response: String,
) -> Result<(), String> {
    let text = response.trim();
    if text.is_empty() {
        return Err("Cached response is empty.".into());
    }
    emit_msg(
        &window,
        &tab_id,
        &json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": text }] },
        }),
    );
    emit_result(&window, &tab_id, true, text);
    finish(&window, &tab_id, true);
    Ok(())
}

/// Run one agentic task to completion using a local Ollama model.
#[tauri::command]
pub async fn run_native_agent(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    base_url: Option<String>,
    // Base64 image data (no data: prefix) for vision-capable models.
    images: Option<Vec<String>>,
    // Optional Ollama sampling overrides (default num_ctx=8192, temperature=0.4).
    num_ctx: Option<u32>,
    temperature: Option<f32>,
    // How long Ollama keeps the model resident between turns (default "10m").
    keep_alive: Option<String>,
    // Project-relative path of the file the user currently has open in the editor,
    // so "fix this paragraph" / "edit this file" resolves without them naming it.
    active_file: Option<String>,
    // The exact text the user currently has selected in that file (if any), so
    // "this paragraph" / "the selection" targets the precise span.
    selection: Option<String>,
    // 1-based start/end line numbers of that selection, so the model can Read the
    // surrounding region to edit it in context.
    selection_start_line: Option<u32>,
    selection_end_line: Option<u32>,
    personalization_prompt: Option<String>,
    // Last-compile status block assembled on the frontend (success/failure, target file).
    compile_state_prompt: Option<String>,
    // When true (or auto-detected), run without tools — chat-only completion.
    chat_only: Option<bool>,
    // UI effort level (`low` / `medium` / `high`) — maps to Ollama `think`.
    effort_level: Option<String>,
    // OpenAI-compat API key (required for native-api / native-groq backends).
    api_key: Option<String>,
    // Chat provider: `ollama` (default) or `openai-compat` (Groq/OpenRouter/Gemini/…).
    chat_provider: Option<String>,
    // Stored credential id for resolving the API key when `api_key` is absent.
    provider_credential_id: Option<String>,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(Notify::new());

    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let use_openai = chat_provider.as_deref() == Some("openai-compat");
    // Resolve the model BEFORE registering the cancel handle: the resolution
    // await below is not wrapped in the notify-based select, so registering
    // earlier only risks leaking the registry entry on the early error return.
    let model = match model {
        Some(m) if !m.trim().is_empty() => m,
        _ if use_openai => "llama-3.3-70b-versatile".to_string(),
        _ => match ollama::first_installed_model(&base).await {
            Ok(Some(m)) => m,
            Ok(None) => {
                let msg = format!(
                    "[E_NO_MODEL] No Ollama model is available at {}. Start Ollama and run `ollama pull llama3` (or another model).",
                    ollama::native_base(&base)
                );
                emit_result(&window, &tab_id, false, &msg);
                finish(&window, &tab_id, false);
                return Err(msg);
            }
            Err(msg) => {
                emit_result(&window, &tab_id, false, &msg);
                finish(&window, &tab_id, false);
                return Err(msg);
            }
        },
    };

    // Register the cancel handle, refusing a second concurrent turn for this tab:
    // a new turn would clobber the in-flight one's handle (making it un-stoppable)
    // and the two would race on the persisted history. Check-and-insert atomically.
    //
    // A poisoned lock must not take the "not already running" path: that
    // branch used to proceed *without inserting the handle*, so the turn ran
    // with a `CancelHandle` reachable only from this stack frame —
    // `stop_native_agent` looked the tab up, found nothing, and returned
    // silently. "Registration failed" was indistinguishable from
    // "registration succeeded", leaving an unstoppable turn. Recovering the
    // guard keeps the registry authoritative.
    let already_running = {
        let mut guard = cancels().lock().unwrap_or_else(|e| e.into_inner());
        if guard.contains_key(&tab_id) {
            true
        } else {
            guard.insert(
                tab_id.clone(),
                CancelHandle {
                    flag: cancel.clone(),
                    notify: notify.clone(),
                },
            );
            false
        }
    };
    if already_running {
        let msg = "[E_ALREADY_RUNNING] A task is already running in this tab. Stop it before starting another."
            .to_string();
        emit_result(&window, &tab_id, false, &msg);
        finish(&window, &tab_id, false);
        return Err(msg);
    }

    // Release the registry slot unconditionally.
    //
    // Removal used to happen only on the normal fall-through at the end of this
    // function. Anything that unwound past it — a panic in a tool, or this
    // command's future being dropped on window teardown — left the entry behind
    // forever. `StreamFinishGuard` still emitted `claude-complete` on drop, so
    // the UI looked idle while every later turn in that tab failed with
    // `[E_ALREADY_RUNNING]`, with no command able to clear it short of an app
    // restart. The completion event already used RAII for exactly this reason;
    // the registry now does too.
    let _registration = TurnRegistration::new(tab_id.clone());

    let finish_guard = StreamFinishGuard::new(window.clone(), tab_id.clone());

    // Suppress macOS App Nap for the lifetime of this turn so a backgrounded
    // window doesn't throttle the Ollama stream or a Bash tool mid-run. Dropped
    // when this command returns (success, error, or cancel), like the CLI path.
    #[cfg(target_os = "macos")]
    let _nap = crate::app_nap::NapActivity::begin("Native agent session");

    let project = std::path::Path::new(&project_path);
    let client = if use_openai {
        let key = api_key
            .filter(|k| !k.trim().is_empty())
            .or_else(|| {
                crate::claude::openai_credential_api_key(provider_credential_id.as_deref(), "")
            })
            .or_else(|| std::env::var("GROQ_API_KEY").ok())
            .unwrap_or_default();
        // Vertex OpenAI-compat credentials intentionally store an empty API key;
        // the request path mints a gcloud OAuth token via resolve_vertex_bearer_token.
        if key.trim().is_empty()
            && !crate::google_auth::is_vertex_openai_compat_base_url(&base)
        {
            let msg =
                "[E_AUTH] API key is required. Add a provider credential in Settings → Provider."
                    .to_string();
            emit_result(&window, &tab_id, false, &msg);
            if let Ok(mut guard) = cancels().lock() {
                guard.remove(&tab_id);
            }
            finish_guard.complete(false);
            return Err(msg);
        }
        // The same discovery the Ollama branch gets: a local OpenAI-compatible
        // server (vLLM, llama.cpp, LM Studio) publishes its real window where
        // the probe can read it, and 8192 under-drives it exactly as it would
        // the native path. Cloud hosts are skipped by `host_is_probe_worthy`
        // before any network traffic happens.
        let effective_ctx = match num_ctx {
            Some(explicit) => Some(explicit),
            None => resolve_context_window(&openai_compat::probe_base(&base), &model).await,
        };
        NativeChatClient::OpenAi(openai_compat::OpenAiCompatClient::new(
            &base,
            &model,
            &key,
            effective_ctx,
            temperature,
        ))
    } else {
        // Ask the server what this model's window actually is before settling
        // for a default. `num_ctx` here is whatever the user set in Settings,
        // or `None` — and `None` becomes 8192, which is a floor chosen so the
        // system prompt and tool schemas fit, not a description of the model.
        // On a 262k-token model that is 3% of its capacity, and every token
        // below the real window is history compacted away for no reason.
        //
        // Only an explicit user setting outranks the server: someone who typed
        // a number meant it, and a probe that overruled them would be arguing
        // with an operator about their own machine.
        let effective_ctx = match num_ctx {
            Some(explicit) => Some(explicit),
            None => {
                let probe_base = format!("{}/v1", ollama::native_base(&base));
                resolve_context_window(&probe_base, &model).await
            }
        };
        let mut ollama_client =
            ollama::OllamaClient::new(&base, &model, effective_ctx, temperature)
                .with_keep_alive(keep_alive.as_deref());
        if ollama_client.supports_thinking().await.unwrap_or(false) {
            ollama_client = ollama_client.with_think(effort_level.as_deref());
        }
        NativeChatClient::Ollama(ollama_client)
    };

    // Preflight: when the model definitively lacks tool-calling, fall back to
    // chat-only mode instead of failing mid-turn. `None` (unknown) keeps tools
    // enabled and lets the request decide.
    let mut chat_only = chat_only.unwrap_or(false);
    if !chat_only && client.supports_tools().await == Some(false) {
        chat_only = true;
        emit_msg(
            &window,
            &tab_id,
            &json!({
                "type": "assistant",
                "message": { "content": [{
                    "type": "text",
                    "text": format!(
                        "_Chat-only mode: the model '{}' does not support tool calling, so file edits are unavailable in this tab. Pick a tools-capable model (e.g. llama3.2, qwen2.5, mistral-nemo) for agent edits._",
                        model
                    ),
                }]}
            }),
        );
    }

    // If images were attached but the model definitively can't see them, drop them
    // and tell the user — otherwise a text-only model silently ignores or chokes on
    // the base64 blob. `None` (unknown) keeps them and lets the model try.
    let mut images = images;
    if images.as_ref().is_some_and(|i| !i.is_empty())
        && client.supports_vision().await == Some(false)
    {
        emit_msg(
            &window,
            &tab_id,
            &json!({
                "type": "assistant",
                "message": { "content": [{
                    "type": "text",
                    "text": format!(
                        "_⚠️ The model '{}' has no vision support, so the attached image(s) were ignored. Pick a vision-capable model (e.g. llama3.2-vision, llava, qwen2.5vl) to use images._",
                        model
                    ),
                }]}
            }),
        );
        images = None;
    }

    let mut system = String::from(SYSTEM_RULES);
    system.push_str(&crate::project_context::build_project_context_prompt(
        project,
    ));
    if system.contains("[context truncated to fit]") {
        emit_context_truncation(
            &window,
            &tab_id,
            &["project context files".to_string()],
            "project context",
        );
    }
    system.push_str(&crate::personalization::build_personalization_prompt());
    if let Some(ref p) = personalization_prompt {
        system.push_str("\n\n");
        system.push_str(p);
    }
    if let Some(ref p) = compile_state_prompt {
        let block = p.trim();
        if !block.is_empty() {
            system.push_str("\n\n");
            system.push_str(block);
        }
    }
    if let Some(rel) = normalize_rel(active_file.as_deref()) {
        let sel_lines = selection_start_line.zip(selection_end_line);
        let has_selection = selection
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        // With a selection: pre-load the lines around it. Without one: inline the
        // whole file if it's small. Either way the model can edit in one turn with
        // no Read (the frontend flushed dirty files to disk before this call, so
        // what's on disk is current).
        let ctx_slice = if has_selection {
            sel_lines.and_then(|(s, e)| read_surrounding_lines(project, &rel, s, e))
        } else {
            None
        };
        let whole_file = if has_selection {
            None
        } else {
            read_small_file(project, &rel)
        };
        system.push_str(&active_file_hint(
            &rel,
            selection.as_deref(),
            sel_lines,
            ctx_slice.as_deref(),
            whole_file.as_deref(),
        ));
    }

    // Rebuild the message list each turn: a fresh system message (current project
    // context) + the persisted conversation history + this turn's user prompt.
    let history = load_history(&tab_id);
    let mut messages = json!([{ "role": "system", "content": system }]);
    if let Some(arr) = messages.as_array_mut() {
        for m in &history {
            arr.push(m.clone());
        }
        let mut user_msg = json!({ "role": "user", "content": prompt });
        if let Some(imgs) = &images {
            if !imgs.is_empty() {
                // Ollama vision models read base64 images on the user message.
                user_msg["images"] = json!(imgs);
            }
        }
        arr.push(user_msg);
    }
    let tools = if chat_only {
        json!([])
    } else {
        tools::tool_schemas()
    };

    // Tell the UI a stream started (session id == tab id).
    emit_msg(
        &window,
        &tab_id,
        &json!({ "type": "system", "subtype": "init", "session_id": tab_id, "model": model }),
    );

    let mut success = true;
    let mut final_text = String::new();
    let mut last_prompt_tokens = 0u64;
    let mut consecutive_empty = 0u32;
    let mut seen_calls: HashSet<String> = HashSet::new();
    let mut warned_ctx = false;

    // Automatic context compaction targets keeping the live prompt at/under 80%
    // of the model's context window. We start from a ~3 bytes/token estimate,
    // then refine the byte budget each turn from Ollama's real prompt_eval_count
    // so compaction kicks in automatically as the prompt nears the 80% line.
    let ctx_80_tokens = (client.num_ctx() as f64 * 0.8) as usize;
    // The tool schemas ride in the same request but live outside `messages`, so
    // reserve their bytes up front; the initial estimate otherwise over-budgets
    // the message list by the schema size until the token-based refinement below
    // takes over. Keep a floor so a large schema set can't starve the budget.
    let tools_bytes = tools.to_string().len();
    let mut ctx_budget = ctx_80_tokens
        .saturating_mul(3)
        .saturating_sub(tools_bytes)
        .max(2048);

    let mut iter: usize = 0;
    'outer: loop {
        if iter >= MAX_ITERATIONS {
            emit_result(
                &window,
                &tab_id,
                true,
                "Reached the step limit for this turn. Ask me to continue if more is needed.",
            );
            break;
        }
        if cancel.load(Ordering::Relaxed) {
            success = false;
            break;
        }

        // Shed the oldest bulky tool results so a couple of large Reads can't push
        // the prompt past the model's window (which would crowd out the system rules).
        //
        // manvi plans this when it can, and the difference is not cosmetic. It
        // counts tokens rather than bytes, corrects that count against what the
        // server actually reported, and — the part that matters most on a local
        // server — never re-shortens a result it has already shortened. The KV
        // cache is keyed on an unchanged token prefix, so a result rewritten to
        // a different string on a later step invalidates everything after it and
        // costs a full re-prefill. The byte-budget compactor below re-derives
        // its plan from scratch every step and aims *at* the budget rather than
        // past it, so it re-triggers on the very next tool result.
        //
        // It stays as the fallback because the sidecar is optional: a build with
        // no manvi binary must still bound its prompt.
        let system_text = messages
            .get(0)
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let plan = manvi_sidecar::prepare_context(
            &tab_id,
            &system_text,
            &tools,
            &to_wire_messages(&messages),
            client.num_ctx(),
            last_prompt_tokens,
        )
        .await;

        let compaction = match plan {
            manvi_sidecar::Verdict::Answered(plan) => {
                if plan.insufficient {
                    eprintln!(
                        "[manvi] every tool result is compacted as far as it goes and the \
                         request is still {} tokens against a {} threshold — the server will \
                         truncate",
                        plan.after_tokens, plan.threshold_tokens
                    );
                }
                if !plan.steps.is_empty() {
                    eprintln!(
                        "[manvi] compaction {} → {} tokens ({} result(s), calibration {:.2} from \
                         {} sample(s))",
                        plan.before_tokens,
                        plan.after_tokens,
                        plan.steps.len(),
                        plan.calibration_ratio,
                        plan.calibration_samples
                    );
                }
                apply_prepare_plan(&mut messages, &plan)
            }
            other => {
                if let manvi_sidecar::Verdict::Unavailable(reason) = &other {
                    if iter == 0 {
                        eprintln!(
                            "[manvi] context planning unavailable ({reason}); \
                             using the byte-budget compactor"
                        );
                    }
                }
                compact_tool_results(&mut messages, ctx_budget)
            }
        };
        let sent_bytes = compaction.total_bytes;
        if !compaction.dropped.is_empty() {
            emit_context_truncation(&window, &tab_id, &compaction.dropped, "tool results");
        }

        // Run the request, but abort it immediately if the user hits stop.
        // Text fragments stream straight to the UI as `streaming_delta` blocks
        // (the same protocol the direct-provider path uses); the finalized turn
        // is reconciled into a `streaming_final` message below.
        //
        // Fragments are coalesced before emission: one IPC event per fragment
        // cost a webview store commit each, and local models emit hundreds of
        // tiny fragments per second. The forwarder is flushed on every exit
        // path so no tail text is lost.
        let window_for_deltas = window.clone();
        let tab_for_deltas = tab_id.clone();
        let mut deltas = delta_coalesce::DeltaForwarder::new(move |kind, text| {
            emit_msg(
                &window_for_deltas,
                &tab_for_deltas,
                &delta_coalesce::streaming_delta_event(kind, &text),
            );
        });
        let mut turn = {
            let mut attempt = 0u32;
            'chat: loop {
                let r = tokio::select! {
                    r = with_stream_heartbeats(
                        window.clone(),
                        tab_id.clone(),
                        "chat",
                        None,
                        client.chat(&messages, &tools, |kind: ollama::StreamDeltaKind, frag: &str| {
                            deltas.push(kind, frag);
                        }),
                    ) => r,
                    _ = notify.notified() => { success = false; break 'outer; }
                };
                match r {
                    Ok(t) => break 'chat t,
                    Err(e) => {
                        attempt += 1;
                        if attempt < MAX_CHAT_ATTEMPTS && is_retryable_chat_error(&e) {
                            // Transient — back off and retry rather than throwing away
                            // the turn's progress, staying responsive to Stop.
                            let backoff = std::time::Duration::from_millis(400u64 << (attempt - 1));
                            eprintln!(
                                "[native-agent] chat attempt {attempt} failed (retryable): {e}"
                            );
                            tokio::select! {
                                _ = with_stream_heartbeats(
                                    window.clone(),
                                    tab_id.clone(),
                                    "retry",
                                    Some(format!("attempt {attempt}")),
                                    tokio::time::sleep(backoff),
                                ) => {}
                                _ = notify.notified() => { success = false; break 'outer; }
                            }
                            continue 'chat;
                        }
                        // Flush any buffered stream text BEFORE the terminal
                        // result event so the webview sees deltas first.
                        deltas.finish();
                        emit_result(&window, &tab_id, false, &e);
                        success = false;
                        break 'outer;
                    }
                }
            }
        };

        // Convergent tail flush: normal completion and the Stop path both
        // land here; finish() is a no-op when the error branch already ran.
        deltas.finish();

        // Read the reply with manvi before deciding what it contained.
        //
        // Two things a local server routinely gets wrong land here. It may not
        // have a tool parser for the model it serves, in which case the call
        // arrives as prose and — without this — is rendered as an answer while
        // the turn silently does nothing. And a model whose chat template
        // prefills an opening <think> emits only the closing tag, so the whole
        // chain of thought reads as the answer and is replayed on every later
        // step.
        //
        // Recovery is skipped when the server did parse calls: text that merely
        // looks like a call, in a reply whose real calls came back structured,
        // is the model talking about a tool rather than asking for one.
        if let manvi_sidecar::Verdict::Answered(settled) = manvi_sidecar::settle_reply(
            &turn.content,
            &tools,
            !turn.tool_calls.is_empty(),
            &turn.done_reason,
        )
        .await
        {
            if !settled.format.is_empty() {
                // Never silent. Recovery works, but the same missing parser
                // costs correctness elsewhere, and a compensation nobody sees
                // is one nobody fixes.
                eprintln!(
                    "[manvi] recovered {} tool call(s) from unparsed text ({}) — the server has \
                     no tool parser for this model",
                    settled.calls.len(),
                    settled.format
                );
            }
            if settled.reclassified {
                eprintln!("[manvi] reclassified a prefilled thinking block out of the answer");
            }
            if settled.truncated && !settled.truncated_mid_call {
                // The answer itself was cut off at the output cap. Not fatal —
                // the text so far is real — but the user must not read a
                // sentence that stops mid-word as the model's whole answer.
                emit_msg(
                    &window,
                    &tab_id,
                    &json!({
                        "type": "assistant",
                        "subtype": "output_truncated",
                        "message": { "content": [{
                            "type": "text",
                            "text": "_The reply hit the output limit and was cut off. \
                                     Ask me to continue for the rest._",
                        }]}
                    }),
                );
            }

            if settled.truncated_mid_call {
                // The cap landed inside a call's arguments. Half an argument
                // object is a different request, not a smaller one, so nothing
                // is dispatched — but the completed steps of this turn are not
                // thrown away either. The model is told to reissue.
                eprintln!("[manvi] output cap landed mid tool call; asking the model to reissue");
                if let Some(arr) = messages.as_array_mut() {
                    arr.push(json!({ "role": "user", "content": settled.retry_message }));
                }
                continue;
            }

            turn.content = settled.text;
            if turn.thinking.trim().is_empty() && !settled.reasoning.is_empty() {
                turn.thinking = settled.reasoning;
            }
            for call in settled.calls {
                let args: Value = serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
                turn.tool_calls.push(ollama::ToolCall {
                    name: ollama::canonicalize_tool_name(&call.name),
                    args,
                    ..Default::default()
                });
            }
        }

        // A model that returns neither text nor a tool call: nudge it a couple of
        // times before giving up, so a transient blank turn doesn't end the chat.
        if turn.content.trim().is_empty() && turn.tool_calls.is_empty() {
            consecutive_empty += 1;
            if consecutive_empty <= 2 {
                if let Some(arr) = messages.as_array_mut() {
                    arr.push(json!({ "role": "user", "content": CONTINUE_NUDGE }));
                }
                continue;
            }
            emit_result(
                &window,
                &tab_id,
                true,
                "(the model returned no further output)",
            );
            break;
        }
        consecutive_empty = 0;

        // Build the assistant content blocks for the UI and stable tool ids.
        let mut content_blocks: Vec<Value> = Vec::new();
        if !turn.thinking.trim().is_empty() {
            content_blocks.push(json!({ "type": "thinking", "thinking": turn.thinking.clone() }));
        }
        if !turn.content.trim().is_empty() {
            final_text = turn.content.clone();
            content_blocks.push(json!({ "type": "text", "text": turn.content.clone() }));
        }
        let mut call_ids: Vec<String> = Vec::with_capacity(turn.tool_calls.len());
        for (idx, tc) in turn.tool_calls.iter().enumerate() {
            let id = format!("native_{}_{}_{}", tab_id, iter, idx);
            call_ids.push(id.clone());
            content_blocks.push(json!({
                "type": "tool_use",
                "id": id,
                "name": tc.name,
                "input": tc.args,
            }));
        }
        // Ids used on the wire, which are NOT the ids used in the UI. When an
        // OpenAI-compatible provider issued its own tool-call id we must hand that
        // exact id back — Gemini 3 binds per-call reasoning state (its thought
        // signature) to it, and substituting a locally minted `native_…` id makes
        // the next request fail. Providers that issue no id (Ollama) keep the
        // internal id, so their wire format is unchanged. The assistant message
        // and its matching `tool` results must agree, so both read this vector.
        let wire_ids: Vec<String> = turn
            .tool_calls
            .iter()
            .enumerate()
            .map(|(idx, tc)| openai_compat::wire_tool_call_id(tc, &call_ids[idx]))
            .collect();
        // Pre-register the answer slot for any AskUser call BEFORE its tool_use
        // block reaches the UI, so an answer submitted while an earlier tool in
        // the same round is still running can never miss the registry.
        for (idx, tc) in turn.tool_calls.iter().enumerate() {
            if tc.name == "AskUser" {
                register_pending_answer(&call_ids[idx]);
            }
        }
        // Carry the last good prompt-token count; some Ollama versions report 0 on
        // a fully-cached prompt, which would otherwise zero the usage display.
        if turn.prompt_tokens > 0 {
            last_prompt_tokens = turn.prompt_tokens;
        }
        // Refine the compaction budget from Ollama's real token count. prompt_tokens
        // covers messages + tool schemas, so divide the TOTAL request bytes by tokens
        // for an accurate bytes-per-token ratio, then reserve the schema bytes — so
        // the next round is compacted automatically as the conversation approaches
        // the 80% line (consistent with the initial estimate).
        if turn.prompt_tokens > 0 && ctx_80_tokens > 0 {
            let total_bytes = (sent_bytes + tools_bytes) as f64;
            let bytes_per_tok = (total_bytes / turn.prompt_tokens as f64).max(1.0);
            ctx_budget = ((ctx_80_tokens as f64 * bytes_per_tok) as usize)
                .saturating_sub(tools_bytes)
                .max(2048);
        }
        if !content_blocks.is_empty() {
            let mut assistant_msg = json!({
                "type": "assistant",
                "message": {
                    "content": content_blocks,
                    "usage": { "input_tokens": turn.prompt_tokens, "output_tokens": turn.eval_tokens },
                }
            });
            // When text was streamed, finalize as `streaming_final` so the store
            // replaces the live delta bubble with this turn (text + tool_use)
            // instead of leaving a duplicate. A tool-only turn streamed no text,
            // so there is no delta bubble to replace — emit a plain assistant
            // message exactly as before.
            if !turn.content.trim().is_empty() || !turn.thinking.trim().is_empty() {
                assistant_msg["subtype"] = json!("streaming_final");
            }
            emit_msg(&window, &tab_id, &assistant_msg);
        }

        // Warn once when the prompt first crosses the 80% line, so the user knows
        // why older tool results are being compacted out of the model's memory.
        // Emitted AFTER the assistant message above so it can't sit between the
        // streamed deltas and their `streaming_final` reconciliation.
        if !warned_ctx
            && client.num_ctx() > 0
            && turn.prompt_tokens as f64 >= 0.8 * client.num_ctx() as f64
        {
            warned_ctx = true;
            emit_msg(
                &window,
                &tab_id,
                &json!({
                    "type": "assistant",
                    // Structured marker so the UI can detect compaction without
                    // pattern-matching the human-readable text below.
                    "subtype": "context_compaction",
                    "message": { "content": [{
                        "type": "text",
                        "text": format!(
                            "_⚠️ This conversation has reached ~80% of the model's context limit ({} of {} tokens); older tool results are being compacted out automatically. Start a new chat for an unrelated task._",
                            turn.prompt_tokens, client.num_ctx()
                        ),
                    }]}
                }),
            );
        }

        // Record the assistant turn in the model's message history (omit the
        // tool_calls field entirely when there are none).
        let assistant_tool_calls: Vec<Value> = turn
            .tool_calls
            .iter()
            .enumerate()
            .map(|(idx, tc)| {
                if use_openai {
                    openai_compat::assistant_tool_call_entry(tc, &call_ids[idx])
                } else {
                    json!({
                        "type": "function",
                        "function": { "name": tc.name, "arguments": tc.args }
                    })
                }
            })
            .collect();
        if let Some(arr) = messages.as_array_mut() {
            let mut assistant_msg = json!({ "role": "assistant", "content": turn.content });
            if !turn.thinking.trim().is_empty() {
                assistant_msg["thinking"] = json!(turn.thinking);
            }
            if !assistant_tool_calls.is_empty() {
                assistant_msg["tool_calls"] = json!(assistant_tool_calls);
            }
            arr.push(assistant_msg);
        }

        // No tool calls -> the model is done.
        if turn.tool_calls.is_empty() {
            emit_msg(
                &window,
                &tab_id,
                &json!({
                    "type": "result",
                    "subtype": "success",
                    "is_error": false,
                    "result": final_text,
                    "usage": { "input_tokens": last_prompt_tokens, "output_tokens": 0 },
                }),
            );
            break;
        }

        // Execute each tool, stream a tool_result, and feed it back to the model.
        // Track whether any call mutated the tree so the dedup cache is cleared
        // once, AFTER the whole round — clearing mid-loop would let a second,
        // identical mutating call in the same round slip past the dedup guard.
        let mut mutated = false;
        for (idx, tc) in turn.tool_calls.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                // Reconcile the tool_use bubbles already shown but not yet run, so
                // the UI doesn't leave them spinning forever.
                emit_cancelled_tool_results(&window, &tab_id, &call_ids[idx..]);
                success = false;
                break 'outer;
            }
            let id = &call_ids[idx];

            // Short-circuit an exact repeat of a previously-SUCCESSFUL idempotent
            // call (no mutation since) so a confused model can't burn iterations
            // re-running it. Failed calls are NOT cached, so a transient failure
            // (e.g. a flaky Bash) can be retried instead of being told to reuse
            // the earlier (failed) result.
            let sig = format!("{}|{}", tc.name.to_lowercase(), tc.args);
            let (result, is_error) = if tc.name == "AskUser" {
                // AskUser executes HERE, not in tools::execute: the question was
                // already shown to the user as this call's tool_use block, and the
                // loop now parks until the chat widget replies through the
                // `answer_native_agent_question` command (or stop / the timeout
                // ends the wait). Never cached in seen_calls — re-asking the same
                // question later is a legitimate call.
                let answer = tokio::select! {
                    a = with_stream_heartbeats(
                        window.clone(),
                        tab_id.clone(),
                        "ask_user",
                        None,
                        wait_for_answer(id),
                    ) => a,
                    _ = notify.notified() => {
                        remove_pending_answer(id);
                        emit_cancelled_tool_results(&window, &tab_id, &call_ids[idx..]);
                        success = false;
                        break 'outer;
                    }
                };
                remove_pending_answer(id);
                match answer {
                    Some(a) => (format!("The user answered: {a}"), false),
                    // Timed out: a graceful non-error result so the model can
                    // proceed with its best judgment instead of failing the turn.
                    None => ("The user did not answer.".to_string(), false),
                }
            } else if seen_calls.contains(&sig) {
                (
                    "(skipped: this exact tool call already succeeded with no changes since — use the earlier result)"
                        .to_string(),
                    false,
                )
            } else {
                // Abort the tool mid-flight if the user hits stop (Bash sets
                // kill_on_drop, so dropping this future reaps the child process).
                let r = tokio::select! {
                    res = with_stream_heartbeats(
                        window.clone(),
                        tab_id.clone(),
                        "tool",
                        Some(tc.name.clone()),
                        tools::execute(project, &tc.name, &tc.args),
                    ) => res,
                    _ = notify.notified() => {
                        emit_cancelled_tool_results(&window, &tab_id, &call_ids[idx..]);
                        success = false;
                        break 'outer;
                    }
                };
                if !r.1 {
                    seen_calls.insert(sig);
                }
                r
            };

            // A successful mutation changes the tree, so we'll allow Read/LS/Grep/
            // Glob to re-run and see fresh state (e.g. Read after Edit, Bash
            // re-build) — but only once the whole round is done (see below).
            if !is_error && matches!(tc.name.as_str(), "Write" | "Edit" | "MultiEdit" | "Bash") {
                mutated = true;
            }

            emit_msg(
                &window,
                &tab_id,
                &json!({
                    "type": "user",
                    "message": { "content": [{
                        "type": "tool_result",
                        "tool_use_id": id,
                        "content": result,
                        "is_error": is_error,
                    }]}
                }),
            );

            if let Some(arr) = messages.as_array_mut() {
                if use_openai {
                    // Must match the id on the assistant `tool_calls` entry above,
                    // which is the provider's own id when it issued one.
                    arr.push(json!({
                        "role": "tool",
                        "tool_call_id": wire_ids[idx],
                        "content": result,
                    }));
                } else {
                    // Ollama's chat Message uses `tool_name` (and `tool_call_id`) — not
                    // `name` — to pair a result with its call across multi-tool rounds.
                    arr.push(json!({
                        "role": "tool",
                        "tool_name": tc.name,
                        "tool_call_id": id,
                        "content": result,
                    }));
                }
            }
        }

        // A mutation happened this round: drop the dedup cache so the next round's
        // Read/LS/Grep/Glob can observe the fresh tree.
        if mutated {
            seen_calls.clear();
        }

        // Count only a completed tool-using round toward the step budget. The
        // empty-turn nudges above `continue` without reaching here, so a transient
        // blank turn never burns a step.
        iter += 1;
    }

    // Persist the conversation (everything except the rebuilt system message) so
    // the next turn in this tab has memory of what happened. Repair any trailing
    // incomplete turn (e.g. from a mid-loop cancel) so history stays balanced.
    if let Some(arr) = messages.as_array_mut() {
        arr.remove(0); // drop the system message
        arr.retain(|m| !is_continue_nudge(m)); // don't persist synthetic nudges
        repair_tail(arr);
        strip_persisted_images(arr); // don't re-send base64 images every turn
        save_history(&tab_id, arr.clone());
    }

    // Drop any answer slots this turn registered but never consumed (cancel or
    // error paths can exit mid-round), so a stale widget can't answer a dead turn.
    sweep_pending_answers(&tab_id);
    // The registry slot and any leftover answer slots are released by
    // `TurnRegistration::drop` when this frame unwinds, on every path.
    finish_guard.complete(success);
    Ok(())
}

/// Owns a tab's entry in the cancel registry for the duration of one turn.
///
/// Exists so the entry is released on panic and on future-drop, not only on the
/// happy path — see the comment at its construction site.
/// Translate the live Ollama-shaped message array into the shape
/// `chat.prepare` reads.
///
/// Only what the planner needs crosses: a role, the visible text, and the id
/// that pairs a tool result with its call. Images are deliberately dropped —
/// they are counted in bytes by the fallback compactor, and sending base64
/// payloads through the sidecar to have their length measured would be the
/// single largest thing on the wire for no gain.
fn to_wire_messages(messages: &Value) -> Value {
    let arr = match messages.as_array() {
        Some(a) => a,
        None => return json!([]),
    };
    let mut out = Vec::with_capacity(arr.len());
    // messages[0] is the system prompt, which travels as its own field.
    for m in arr.iter().skip(1) {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        let text = m.get("content").and_then(Value::as_str).unwrap_or("");
        let mut entry = json!({ "role": role, "text": text });
        if role == "tool" {
            if let Some(id) = m.get("tool_call_id").and_then(Value::as_str) {
                entry["tool_call_id"] = json!(id);
            }
        }
        if let Some(calls) = m.get("tool_calls").and_then(Value::as_array) {
            let wire: Vec<Value> = calls
                .iter()
                .filter_map(|c| {
                    let func = c.get("function")?;
                    Some(json!({
                        "id": c.get("id").and_then(Value::as_str).unwrap_or(""),
                        "name": func.get("name").and_then(Value::as_str).unwrap_or(""),
                        "arguments": match func.get("arguments") {
                            Some(Value::String(s)) => s.clone(),
                            Some(other) => other.to_string(),
                            None => String::new(),
                        },
                    }))
                })
                .collect();
            if !wire.is_empty() {
                entry["tool_calls"] = json!(wire);
            }
        }
        out.push(entry);
    }
    json!(out)
}

/// Apply a compaction plan to the live message array, by tool_call_id.
///
/// Returns the same shape the byte-budget compactor does, so the caller's
/// reporting path is identical whichever planner ran.
fn apply_prepare_plan(
    messages: &mut Value,
    plan: &manvi_sidecar::PrepareResult,
) -> CompactionResult {
    let mut dropped = Vec::new();
    if let Some(arr) = messages.as_array_mut() {
        for step in &plan.steps {
            for m in arr.iter_mut() {
                if m.get("role").and_then(Value::as_str) != Some("tool") {
                    continue;
                }
                if m.get("tool_call_id").and_then(Value::as_str) != Some(step.tool_call_id.as_str())
                {
                    continue;
                }
                let name = m
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                m["content"] = json!(step.text);
                dropped.push(format!("{name} result"));
                break;
            }
        }
    }
    let total_bytes: usize = messages
        .as_array()
        .map(|a| a.iter().map(|m| m.to_string().len()).sum())
        .unwrap_or(0);
    CompactionResult {
        total_bytes,
        dropped,
    }
}

/// Ceiling on a discovered context window, in tokens.
///
/// A window is a request for KV-cache allocation, and Ollama honours it: asking
/// for the full 262144 of a large model reserves memory proportional to it and
/// can push the runner into swap or an out-of-memory kill on a laptop. This is
/// well above the 8192 default — the point is to stop wasting a large model's
/// capacity, not to consume all of it — while staying inside what a machine
/// running the model locally can hold. A user who wants more sets num_ctx
/// explicitly, which bypasses this path entirely.
const DISCOVERED_CTX_CEILING: u32 = 65536;

/// Ask manvi what context window the server reports for this model.
///
/// Returns `None` when the answer could not be obtained, which leaves the
/// caller on its existing default. A failure here is never fatal: the sidecar
/// is an optimisation, and a missing binary or a server that publishes nothing
/// must cost the old behaviour rather than the turn.
/// Whether this base URL points at a machine the probe can meaningfully ask.
///
/// Discovery exists for servers on the operator's own machine or LAN, which
/// publish their model catalogue unauthenticated. A cloud provider refuses the
/// listing (no API key crosses the probe), so probing one costs a network
/// round-trip — up to the probe timeout on an offline machine, which for an
/// offline-first app is the common case — to learn nothing. Those keep the
/// configured default; a user who wants discovery against a public endpoint
/// sets num_ctx explicitly anyway.
fn host_is_probe_worthy(base_url: &str) -> bool {
    let rest = match base_url.split_once("://") {
        Some((_, r)) => r,
        None => return false,
    };
    let host_port = rest.split('/').next().unwrap_or("");
    let host = host_port
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host_port)
        .trim_start_matches('[')
        .trim_end_matches(']');
    let l = host.to_ascii_lowercase();
    l == "localhost"
        || l == "::1"
        || l.starts_with("127.")
        || l.starts_with("10.")
        || l.starts_with("192.168.")
        || l.starts_with("169.254.")
        // 172.16.0.0/12: 172.16.x through 172.31.x only.
        || (l.starts_with("172.") && l.split('.').nth(1).and_then(|o| o.parse::<u8>().ok()).is_some_and(|o| (16..=31).contains(&o)))
}

/// Ask manvi what context window the server reports for this model.
///
/// `probe_base` is the *final* OpenAI-compatible API root the probe should
/// hit — each caller derives it from its own URL dialect (the Ollama branch
/// normalises away `/v1` and re-appends it; the OpenAI-compat branch keeps a
/// chat-API root as-is and appends `/v1` only when missing). This function
/// deliberately does no URL surgery of its own.
///
/// Returns `None` when the answer could not be obtained, which leaves the
/// caller on its existing default. A failure here is never fatal: the sidecar
/// is an optimisation, and a missing binary or a server that publishes nothing
/// must cost the old behaviour rather than the turn.
async fn resolve_context_window(probe_base: &str, model: &str) -> Option<u32> {
    use manvi_sidecar::Verdict;

    if !host_is_probe_worthy(probe_base) {
        return None;
    }

    match manvi_sidecar::probe_model(probe_base, model, ollama::DEFAULT_CONTEXT_WINDOW).await {
        Verdict::Answered(result) => {
            if result.embedding {
                // An embedding model answers the listing beside every chat
                // model and then fails at /api/chat. Leave the window alone —
                // the chat-capability preflight below is what should refuse
                // it, with a message about the model rather than about memory.
                eprintln!("[manvi] {model} is an embedding-only model; not adjusting context");
                return None;
            }
            if !result.discovered {
                // The server published nothing, so this is our own declared
                // value handed back. Adopting it would change nothing and log
                // a discovery that did not happen.
                return None;
            }
            if result.capabilities_known && !result.supports_tools {
                // Not fatal here — the chat-capability preflight below still
                // decides — but worth recording next to the window, because a
                // tool-less model is the commonest reason an agent turn does
                // nothing and reports no error.
                eprintln!("[manvi] {model} does not advertise tool calling");
            }
            let capped = result.context_window.min(DISCOVERED_CTX_CEILING);
            eprintln!(
                "[manvi] {model}: context {} from {} (capped to {capped}) — {}",
                result.context_window, result.source, result.describe
            );
            Some(capped)
        }
        Verdict::Refused(err) => {
            eprintln!(
                "[manvi] context probe refused for {model}: {} {} (retryable={})",
                err.code, err.message, err.retryable
            );
            None
        }
        Verdict::Unavailable(reason) => {
            eprintln!("[manvi] context probe unavailable ({reason}); using the configured default");
            None
        }
    }
}

struct TurnRegistration {
    tab_id: String,
}

impl TurnRegistration {
    fn new(tab_id: String) -> Self {
        Self { tab_id }
    }
}

impl Drop for TurnRegistration {
    fn drop(&mut self) {
        sweep_pending_answers(&self.tab_id);
        cancels()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.tab_id);
    }
}

fn finish(window: &WebviewWindow, tab_id: &str, success: bool) {
    let _ = window.emit(
        "claude-complete",
        CompleteEvent {
            tab_id: tab_id.to_string(),
            success,
        },
    );
}

/// Ensures `claude-complete` is emitted even if the agent task panics or returns early.
struct StreamFinishGuard {
    window: WebviewWindow,
    tab_id: String,
    emitted: bool,
}

impl StreamFinishGuard {
    fn new(window: WebviewWindow, tab_id: String) -> Self {
        Self {
            window,
            tab_id,
            emitted: false,
        }
    }

    fn complete(mut self, success: bool) {
        if !self.emitted {
            finish(&self.window, &self.tab_id, success);
            self.emitted = true;
        }
    }
}

impl Drop for StreamFinishGuard {
    fn drop(&mut self) {
        if !self.emitted {
            finish(&self.window, &self.tab_id, false);
        }
    }
}

const INLINE_TRANSFORM_SYSTEM: &str = concat!(
    "You rewrite LaTeX or plain document text for the user. ",
    "Preserve all LaTeX commands, environments, citations, labels, and math unless ",
    "the instruction explicitly asks to change them. ",
    "Return ONLY the rewritten text — no markdown fences, no explanation, no quotes."
);

fn inline_transform_instruction(action: &str, custom: Option<&str>) -> String {
    match action.trim().to_ascii_lowercase().as_str() {
        "rephrase" => {
            "Rephrase this text to improve clarity and flow while preserving meaning.".into()
        }
        "expand" => {
            "Expand this text with more detail and specificity while preserving meaning and structure."
                .into()
        }
        "proofread" | "grammar" => {
            "Proofread and fix grammar, spelling, and punctuation while preserving meaning and LaTeX."
                .into()
        }
        "shorten" => {
            "Shorten this text while preserving the key meaning and all LaTeX commands.".into()
        }
        "formalize" => {
            "Rewrite this text in a more formal, professional tone while preserving meaning and LaTeX."
                .into()
        }
        "simplify" => {
            "Simplify this text for clarity; use plain language while preserving meaning and LaTeX."
                .into()
        }
        _ => custom
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Improve this text.")
            .to_string(),
    }
}

/// Shared one-shot chat completion for inline transforms and lightweight AI assist.
async fn complete_chat_messages(
    messages: Vec<Value>,
    model: Option<String>,
    base_url: Option<String>,
    num_ctx: Option<u32>,
    temperature: Option<f32>,
    provider_credential_id: Option<String>,
    json_format: bool,
) -> Result<String, String> {
    if let Some(cred_id) = provider_credential_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return crate::claude::complete_openai_compatible_chat_with_format(
            Some(cred_id),
            messages,
            model.as_deref(),
            temperature,
            json_format,
        )
        .await;
    }

    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let model = match model {
        Some(m) if !m.trim().is_empty() => m,
        _ => match ollama::first_installed_model(&base).await {
            Ok(Some(m)) => m,
            Ok(None) => {
                return Err(format!(
                    "[E_NO_MODEL] No Ollama model is available at {}. Start Ollama and pull a chat model.",
                    ollama::native_base(&base)
                ));
            }
            Err(e) => return Err(e),
        },
    };
    let mut client = ollama::OllamaClient::new(&base, &model, num_ctx, temperature);
    if json_format {
        client = client.with_json_format();
    }
    let turn = client
        .chat(&json!(messages), &json!([]), |_, _| {})
        .await
        .map_err(|e| e.to_string())?;

    if !turn.tool_calls.is_empty() {
        return Err("Expected text only, but the model returned tool calls.".into());
    }
    Ok(turn.content)
}

/// Strip optional markdown code fences from a model reply.
fn strip_inline_fences(s: &str) -> String {
    let trimmed = s.trim();
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }
    let mut lines = trimmed.lines();
    let _ = lines.next();
    let body: Vec<&str> = lines.collect();
    if body.is_empty() {
        return String::new();
    }
    if body.last().map(|l| l.trim()) == Some("```") {
        body[..body.len() - 1].join("\n").trim().to_string()
    } else {
        body.join("\n").trim().to_string()
    }
}

/// One-shot selection rewrite (no tools) for inline Rephrase/Expand/Edit actions.
#[tauri::command]
pub async fn inline_transform_text(
    text: String,
    action: String,
    custom_instruction: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    num_ctx: Option<u32>,
    temperature: Option<f32>,
    provider_credential_id: Option<String>,
) -> Result<String, String> {
    let selection = text.trim();
    if selection.is_empty() {
        return Err("Nothing selected to transform.".to_string());
    }

    let instruction = inline_transform_instruction(&action, custom_instruction.as_deref());
    let user = format!("{instruction}\n\n---\n\n{selection}");
    let system =
        crate::personalization::augment_system_prompt(Some(INLINE_TRANSFORM_SYSTEM.to_string()));
    let messages = vec![
        json!({ "role": "system", "content": system.unwrap_or_else(|| INLINE_TRANSFORM_SYSTEM.to_string()) }),
        json!({ "role": "user", "content": user }),
    ];

    let content = complete_chat_messages(
        messages,
        model,
        base_url,
        num_ctx,
        temperature,
        provider_credential_id,
        false,
    )
    .await?;

    let out = strip_inline_fences(&content);
    if out.is_empty() {
        return Err("The model returned an empty rewrite.".into());
    }
    Ok(out)
}

/// Lightweight one-shot completion for predictive text, grammar hints, and suggestions.
#[tauri::command]
pub async fn ai_complete(
    prompt: String,
    system: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    num_ctx: Option<u32>,
    temperature: Option<f32>,
    provider_credential_id: Option<String>,
    format: Option<String>,
    request_id: Option<String>,
) -> Result<String, String> {
    let user = prompt.trim();
    if user.is_empty() {
        return Err("Prompt is empty.".to_string());
    }

    let cancel = request_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(register_ai_request_cancel);
    let cancel_parts = cancel.as_ref().map(clone_cancel_parts);

    let result = ai_complete_inner(
        user.to_string(),
        system,
        model,
        base_url,
        num_ctx,
        temperature,
        provider_credential_id,
        format,
        cancel_parts,
    )
    .await;

    if let Some(id) = request_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        take_ai_request_cancel(id);
    }
    result
}

async fn ai_complete_inner(
    user: String,
    system: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    num_ctx: Option<u32>,
    temperature: Option<f32>,
    provider_credential_id: Option<String>,
    format: Option<String>,
    cancel_parts: Option<(Arc<AtomicBool>, Arc<Notify>)>,
) -> Result<String, String> {
    if cancel_parts
        .as_ref()
        .is_some_and(|(f, _)| f.load(Ordering::Relaxed))
    {
        return Err("cancelled".into());
    }

    let cred_id = provider_credential_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());

    // Claude Code / Cursor CLI print-mode backends (synthesis + assist).
    if cred_id == Some(CLAUDE_CODE_PROVIDER_ID) {
        let (flag, notify) = match cancel_parts {
            Some((f, n)) => (Some(f), Some(n)),
            None => (None, None),
        };
        let system = crate::personalization::augment_system_prompt(system);
        let out = crate::claude::complete_claude_print(
            &user,
            system.as_deref(),
            flag,
            notify,
        )
        .await?;
        let out = strip_inline_fences(&out);
        if out.is_empty() {
            return Err("The model returned an empty response.".into());
        }
        return Ok(out);
    }
    if cred_id == Some(CURSOR_CLI_PROVIDER_ID) {
        let (flag, notify) = match cancel_parts {
            Some((f, n)) => (Some(f), Some(n)),
            None => (None, None),
        };
        let system = crate::personalization::augment_system_prompt(system);
        let out = crate::cursor_agent::stream_spawn::complete_cursor_print(
            &user,
            system.as_deref(),
            flag,
            notify,
        )
        .await?;
        let out = strip_inline_fences(&out);
        if out.is_empty() {
            return Err("The model returned an empty response.".into());
        }
        return Ok(out);
    }

    // `format: "json"` asks the local model for a strict JSON object, hardening
    // the callers (grammar, suggestions, follow-ups, bib, etc.) that parse JSON.
    let json_format = format
        .as_deref()
        .map(|f| f.trim().eq_ignore_ascii_case("json"))
        .unwrap_or(false);

    let system = crate::personalization::augment_system_prompt(system);
    let mut messages = Vec::new();
    if let Some(sys) = system.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        messages.push(json!({ "role": "system", "content": sys }));
    }
    messages.push(json!({ "role": "user", "content": user }));

    let work = complete_chat_messages(
        messages,
        model,
        base_url,
        num_ctx,
        temperature,
        provider_credential_id,
        json_format,
    );

    let content = if let Some((_, notify)) = cancel_parts.as_ref() {
        tokio::select! {
            _ = notify.notified() => return Err("cancelled".into()),
            result = work => result?,
        }
    } else {
        work.await?
    };

    if cancel_parts
        .as_ref()
        .is_some_and(|(f, _)| f.load(Ordering::Relaxed))
    {
        return Err("cancelled".into());
    }

    let out = strip_inline_fences(&content);
    if out.is_empty() {
        return Err("The model returned an empty response.".into());
    }
    Ok(out)
}

/// Cooperatively cancel an in-flight `ai_complete` / `ai_complete_stream` /
/// `ai_embed`.
#[tauri::command]
pub fn ai_cancel_request(request_id: String) {
    let id = request_id.trim();
    if id.is_empty() {
        return;
    }
    if let Ok(guard) = ai_request_cancels().lock() {
        if let Some(handle) = guard.get(id) {
            handle.flag.store(true, Ordering::Relaxed);
            handle.notify.notify_waiters();
        }
    }
}

/// Embed one or more texts. Prefers an OpenAI-compat credential that exposes
/// `/embeddings` (Gemini, OpenAI) when `provider_credential_id` is set;
/// otherwise uses a local Ollama embedding model (e.g. `nomic-embed-text`).
/// When `request_id` is set, `ai_cancel_request` aborts the in-flight HTTP call
/// via the shared cancel registry (same pattern as `ai_complete`).
#[tauri::command]
pub async fn ai_embed(
    texts: Vec<String>,
    model: Option<String>,
    base_url: Option<String>,
    provider_credential_id: Option<String>,
    request_id: Option<String>,
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }

    let cancel = request_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(register_ai_request_cancel);
    let cancel_parts = cancel.as_ref().map(clone_cancel_parts);

    let result = ai_embed_inner(
        texts,
        model,
        base_url,
        provider_credential_id,
        cancel_parts,
    )
    .await;

    if let Some(id) = request_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        take_ai_request_cancel(id);
    }
    result
}

async fn ai_embed_inner(
    texts: Vec<String>,
    model: Option<String>,
    base_url: Option<String>,
    provider_credential_id: Option<String>,
    cancel_parts: Option<(Arc<AtomicBool>, Arc<Notify>)>,
) -> Result<Vec<Vec<f32>>, String> {
    if cancel_parts
        .as_ref()
        .is_some_and(|(f, _)| f.load(Ordering::Relaxed))
    {
        return Err("cancelled".into());
    }

    let work = async {
        if let Some(cred_id) = provider_credential_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            if let Ok(Some(cred)) =
                crate::claude::stored_openai_compatible_credential(Some(cred_id))
            {
                if let Some(client) = openai_compat::embedding_client_for_credential(
                    &cred.base_url,
                    &cred.api_key,
                    model.as_deref(),
                ) {
                    return client.embeddings(&texts).await;
                }
            }
        }

        let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
        let model = match model {
            Some(m) if !m.trim().is_empty() => m,
            _ => match ollama::first_embedding_model(&base).await {
                Ok(Some(m)) => m,
                Ok(None) => {
                    return Err(format!(
                        "[E_NO_MODEL] No embedding model is installed at {}. Pull one, e.g. \
                         `ollama pull nomic-embed-text`.",
                        ollama::native_base(&base)
                    ));
                }
                Err(e) => return Err(e),
            },
        };

        let client = ollama::OllamaClient::new(&base, &model, None, None);
        client.embed(&texts).await
    };

    let vectors = if let Some((_, notify)) = cancel_parts.as_ref() {
        tokio::select! {
            _ = notify.notified() => return Err("cancelled".into()),
            result = work => result?,
        }
    } else {
        work.await?
    };

    if cancel_parts
        .as_ref()
        .is_some_and(|(f, _)| f.load(Ordering::Relaxed))
    {
        return Err("cancelled".into());
    }

    Ok(vectors)
}

/// Streaming variant of `ai_complete`: text fragments are forwarded over the
/// `on_chunk` channel as they arrive. The OpenAI-compatible credential path and
/// CLI backends are non-streaming, so they send the whole reply as a single
/// chunk. Returns the fully-accumulated (fence-stripped) text.
#[tauri::command]
pub async fn ai_complete_stream(
    prompt: String,
    system: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    num_ctx: Option<u32>,
    temperature: Option<f32>,
    provider_credential_id: Option<String>,
    on_chunk: tauri::ipc::Channel<String>,
    request_id: Option<String>,
) -> Result<String, String> {
    let user = prompt.trim();
    if user.is_empty() {
        return Err("Prompt is empty.".to_string());
    }

    let cancel = request_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(register_ai_request_cancel);
    let cancel_parts = cancel.as_ref().map(clone_cancel_parts);

    let result = ai_complete_stream_inner(
        user.to_string(),
        system,
        model,
        base_url,
        num_ctx,
        temperature,
        provider_credential_id,
        on_chunk,
        cancel_parts,
    )
    .await;

    if let Some(id) = request_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        take_ai_request_cancel(id);
    }
    result
}

async fn ai_complete_stream_inner(
    user: String,
    system: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    num_ctx: Option<u32>,
    temperature: Option<f32>,
    provider_credential_id: Option<String>,
    on_chunk: tauri::ipc::Channel<String>,
    cancel_parts: Option<(Arc<AtomicBool>, Arc<Notify>)>,
) -> Result<String, String> {
    if cancel_parts
        .as_ref()
        .is_some_and(|(f, _)| f.load(Ordering::Relaxed))
    {
        return Err("cancelled".into());
    }

    let cred_id = provider_credential_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());

    // CLI backends: one-shot then emit a single chunk (compatible with stream callers).
    if cred_id == Some(CLAUDE_CODE_PROVIDER_ID) || cred_id == Some(CURSOR_CLI_PROVIDER_ID) {
        let out = ai_complete_inner(
            user,
            system,
            model,
            base_url,
            num_ctx,
            temperature,
            provider_credential_id,
            None,
            cancel_parts,
        )
        .await?;
        let _ = on_chunk.send(out.clone());
        return Ok(out);
    }

    let system = crate::personalization::augment_system_prompt(system);
    let mut messages = Vec::new();
    if let Some(sys) = system.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        messages.push(json!({ "role": "system", "content": sys }));
    }
    messages.push(json!({ "role": "user", "content": user }));

    if let Some(cred_id) = cred_id {
        let mut credential = crate::claude::stored_openai_compatible_credential(Some(cred_id))?
            .ok_or_else(|| "No provider credential configured.".to_string())?;
        if let Some(m) = model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            credential.model = m.to_string();
        }

        // Anthropic-native roots (DeepSeek / Qwen / Moonshot) must stay on the
        // one-shot Anthropic Messages path — OpenAiCompatClient hits the wrong URL.
        if crate::claude::uses_native_anthropic_route(&credential) {
            let work = crate::claude::complete_openai_compatible_chat(
                Some(cred_id),
                messages,
                model.as_deref(),
                temperature,
            );
            let content = if let Some((_, notify)) = cancel_parts.as_ref() {
                tokio::select! {
                    _ = notify.notified() => return Err("cancelled".into()),
                    result = work => result?,
                }
            } else {
                work.await?
            };
            let out = strip_inline_fences(&content);
            if out.is_empty() {
                return Err("The model returned an empty response.".into());
            }
            let _ = on_chunk.send(out.clone());
            return Ok(out);
        }

        let client = openai_compat::OpenAiCompatClient::new(
            &credential.base_url,
            &credential.model,
            &credential.api_key,
            num_ctx,
            temperature,
        );
        let cancel_flag = cancel_parts.as_ref().map(|(f, _)| Arc::clone(f));
        let messages_json = json!(messages);
        let empty_tools = json!([]);
        let work = client.chat(&messages_json, &empty_tools, |_, frag| {
            if cancel_flag
                .as_ref()
                .is_some_and(|f| f.load(Ordering::Relaxed))
            {
                return;
            }
            let _ = on_chunk.send(frag.to_string());
        });

        let turn = if let Some((_, notify)) = cancel_parts.as_ref() {
            tokio::select! {
                _ = notify.notified() => return Err("cancelled".into()),
                result = work => result?,
            }
        } else {
            work.await?
        };

        if cancel_parts
            .as_ref()
            .is_some_and(|(f, _)| f.load(Ordering::Relaxed))
        {
            return Err("cancelled".into());
        }

        if !turn.tool_calls.is_empty() {
            return Err("Expected text only, but the model returned tool calls.".into());
        }

        // Match complete_openai_compatible_chat: prefer content, fall back to
        // reasoning/thinking when the model returns an empty content field.
        let content = if turn.content.trim().is_empty() {
            turn.thinking
        } else {
            turn.content
        };
        let out = strip_inline_fences(&content);
        if out.is_empty() {
            return Err("The model returned an empty response.".into());
        }
        return Ok(out);
    }

    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let model = match model {
        Some(m) if !m.trim().is_empty() => m,
        _ => match ollama::first_installed_model(&base).await {
            Ok(Some(m)) => m,
            Ok(None) => {
                return Err(format!(
                    "[E_NO_MODEL] No Ollama model is available at {}. Start Ollama and pull a chat model.",
                    ollama::native_base(&base)
                ));
            }
            Err(e) => return Err(e),
        },
    };

    let client = ollama::OllamaClient::new(&base, &model, num_ctx, temperature);
    let cancel_flag = cancel_parts.as_ref().map(|(f, _)| Arc::clone(f));
    let messages_json = json!(messages);
    let empty_tools = json!([]);
    let work = client.chat(&messages_json, &empty_tools, |_, frag| {
        if cancel_flag
            .as_ref()
            .is_some_and(|f| f.load(Ordering::Relaxed))
        {
            return;
        }
        let _ = on_chunk.send(frag.to_string());
    });

    let turn = if let Some((_, notify)) = cancel_parts.as_ref() {
        tokio::select! {
            _ = notify.notified() => return Err("cancelled".into()),
            result = work => result.map_err(|e| e.to_string())?,
        }
    } else {
        work.await.map_err(|e| e.to_string())?
    };

    if cancel_parts
        .as_ref()
        .is_some_and(|(f, _)| f.load(Ordering::Relaxed))
    {
        return Err("cancelled".into());
    }

    if !turn.tool_calls.is_empty() {
        return Err("Expected text only, but the model returned tool calls.".into());
    }

    let out = strip_inline_fences(&turn.content);
    if out.is_empty() {
        return Err("The model returned an empty response.".into());
    }
    Ok(out)
}

/// Generate a short caption / alt-text for an image using a local vision model
/// (Ollama only — the provider-credential path uses a different image format).
/// `image_base64` may be a bare base64 string or a `data:` URL.
#[tauri::command]
pub async fn ai_caption(
    image_base64: String,
    prompt: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    num_ctx: Option<u32>,
    temperature: Option<f32>,
) -> Result<String, String> {
    let raw = image_base64.trim();
    if raw.is_empty() {
        return Err("No image provided.".into());
    }
    // Accept either a bare base64 string or a data: URL (keep the part after the comma).
    let b64 = raw.rsplit(',').next().unwrap_or(raw).trim().to_string();
    // Captioning wants determinism, so default low; but honor an explicit user
    // temperature when provided rather than ignoring their setting.
    let caption_temp = temperature
        .filter(|&t| (0.0..=2.0).contains(&t))
        .unwrap_or(0.3);

    let base = base_url
        .clone()
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    let mut resolved_model = match model.clone() {
        Some(m) if !m.trim().is_empty() => m,
        _ => match ollama::first_installed_model(&base).await {
            Ok(Some(m)) => m,
            Ok(None) => {
                return Err(format!(
                    "[E_NO_MODEL] No Ollama model is available at {}.",
                    ollama::native_base(&base)
                ));
            }
            Err(e) => return Err(e),
        },
    };

    // If the configured/default model definitely can't see images, try to fall
    // back to an installed vision-capable model rather than failing outright —
    // the chat model (used everywhere else) is often text-only. `None` (unknown
    // capability) proceeds and lets the request decide.
    let client = ollama::OllamaClient::new(&base, &resolved_model, num_ctx, Some(caption_temp));
    if client.supports_vision().await == Some(false) {
        match ollama::first_vision_model(&base).await {
            Ok(Some(vm)) => resolved_model = vm,
            Ok(None) => {
                return Err(format!(
                    "The model '{}' has no vision support and no vision-capable model is \
                     installed. Pull one, e.g. `ollama pull llava` (or llama3.2-vision, qwen2.5vl).",
                    resolved_model
                ));
            }
            Err(e) => return Err(e),
        }
    }

    let instruction = prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(
            "Describe this image concisely for a figure caption: one sentence, no preamble.",
        );

    let messages = vec![json!({
        "role": "user",
        "content": instruction,
        "images": [b64],
    })];

    let content = complete_chat_messages(
        messages,
        Some(resolved_model),
        Some(base),
        num_ctx,
        Some(caption_temp),
        None,
        false,
    )
    .await?;

    let out = strip_inline_fences(&content);
    if out.trim().is_empty() {
        return Err("The model returned an empty caption.".into());
    }
    Ok(out.trim().to_string())
}

/// Cooperatively cancel a running native-agent turn for a tab.
#[tauri::command]
pub fn stop_native_agent(tab_id: String) {
    if let Ok(guard) = cancels().lock() {
        if let Some(handle) = guard.get(&tab_id) {
            handle.flag.store(true, Ordering::Relaxed);
            handle.notify.notify_waiters();
        }
    }
}

/// List chat/embedding models installed in a local Ollama instance.
#[tauri::command]
pub async fn list_ollama_models(
    base_url: Option<String>,
) -> Result<Vec<ollama::OllamaModelInfo>, String> {
    ollama::list_models(base_url).await
}

/// Health check for a local Ollama instance.
#[tauri::command]
pub async fn ollama_status(base_url: Option<String>) -> ollama::OllamaStatus {
    ollama::server_status(base_url).await
}

/// List models currently resident in memory on the Ollama server (`/api/ps`).
#[tauri::command]
pub async fn ollama_ps(
    base_url: Option<String>,
) -> Result<Vec<ollama::OllamaRunningModel>, String> {
    ollama::running_models(base_url).await
}

/// Delete an installed Ollama model (`/api/delete`).
#[tauri::command]
pub async fn delete_ollama_model(base_url: Option<String>, model: String) -> Result<(), String> {
    ollama::delete_model(base_url, model).await
}

/// Copy an installed Ollama model to a new name (`/api/copy`).
#[tauri::command]
pub async fn copy_ollama_model(
    base_url: Option<String>,
    source: String,
    destination: String,
) -> Result<(), String> {
    ollama::copy_model(base_url, source, destination).await
}

/// Tool/vision capabilities for one installed Ollama model.
#[tauri::command]
pub async fn ollama_model_capabilities(
    base_url: Option<String>,
    model: String,
) -> Result<ollama::OllamaModelCapabilities, String> {
    ollama::model_capabilities(base_url, model).await
}

/// Download a model from the Ollama library (`/api/pull`), emitting progress events.
#[tauri::command]
pub async fn pull_ollama_model(
    window: WebviewWindow,
    base_url: Option<String>,
    model: String,
) -> Result<(), String> {
    ollama::pull_model(base_url, model, |progress| {
        let _ = window.emit("ollama-pull-progress", progress);
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_worthiness_covers_local_shapes_and_rejects_cloud() {
        // Loopback spellings.
        assert!(host_is_probe_worthy("http://localhost:11434"));
        assert!(host_is_probe_worthy("http://127.0.0.1:11434"));
        assert!(host_is_probe_worthy("http://127.0.0.1:8000/v1"));
        assert!(host_is_probe_worthy("http://[::1]:8080/v1"));
        // Private/LAN ranges.
        assert!(host_is_probe_worthy("http://10.0.0.5:8000/v1"));
        assert!(host_is_probe_worthy("http://192.168.1.20:8000"));
        assert!(host_is_probe_worthy("http://172.16.5.4:8000/v1"));
        assert!(host_is_probe_worthy("http://172.31.255.9:8000/v1"));
        assert!(host_is_probe_worthy("http://169.254.1.2:8000/v1"));
        // Public hosts: cloud providers refuse the unauthenticated listing, so
        // probing them is a network round-trip that can only fail.
        assert!(!host_is_probe_worthy("https://api.groq.com/openai/v1"));
        assert!(!host_is_probe_worthy("https://openrouter.ai/api/v1"));
        assert!(!host_is_probe_worthy("https://api.deepseek.com/v1"));
        // 172.32+ is public; only 172.16/12 is private.
        assert!(!host_is_probe_worthy("http://172.32.0.1:8000/v1"));
        assert!(!host_is_probe_worthy("http://172.15.0.1:8000/v1"));
        // Not a URL we understand.
        assert!(!host_is_probe_worthy("unix:///tmp/ollama.sock"));
        assert!(!host_is_probe_worthy(""));
    }

    #[test]
    fn openai_probe_base_matches_the_chat_url_root_logic() {
        use super::openai_compat::probe_base;
        // Already chat-rooted: used as-is.
        assert_eq!(probe_base("https://api.groq.com/openai/v1"), "https://api.groq.com/openai/v1");
        assert_eq!(
            probe_base("https://generativelanguage.googleapis.com/v1beta/openai"),
            "https://generativelanguage.googleapis.com/v1beta/openai"
        );
        // Bare host: /v1 appended, exactly as the chat URL builder would.
        assert_eq!(probe_base("http://127.0.0.1:8000"), "http://127.0.0.1:8000/v1");
        assert_eq!(probe_base("http://localhost:1234/"), "http://localhost:1234/v1");
    }

    #[test]
    fn retryable_chat_errors_are_transient_only() {
        assert!(is_retryable_chat_error(
            "[E_OLLAMA_UNREACHABLE] Could not reach Ollama at http://localhost:11434"
        ));
        assert!(is_retryable_chat_error(
            "[E_OLLAMA_STALLED] Ollama stopped emitting tokens for 90s"
        ));
        assert!(is_retryable_chat_error(
            "Ollama stream error: connection reset"
        ));
        assert!(is_retryable_chat_error(
            "Ollama returned HTTP 503: unavailable"
        ));
        // Permanent capability/config errors must NOT retry.
        assert!(!is_retryable_chat_error(
            "[E_NO_TOOLS] The model 'gemma:2b' does not support tool-calling."
        ));
        assert!(!is_retryable_chat_error(
            "[E_NO_MODEL] No Ollama model installed"
        ));
        assert!(!is_retryable_chat_error(
            "Ollama returned HTTP 400: bad request"
        ));
    }

    fn role(m: &Value) -> &str {
        m.get("role").and_then(|r| r.as_str()).unwrap_or("")
    }
    fn content(m: &Value) -> Option<&str> {
        m.get("content").and_then(|c| c.as_str())
    }

    /// Context compaction sheds bulky tool OUTPUT. It must never touch the
    /// provider metadata on an assistant tool call: stripping a thought signature
    /// out of retained history is exactly what makes the next request fail with
    /// HTTP 400, and compaction runs on nearly every long conversation.
    #[test]
    fn compaction_sheds_tool_output_but_preserves_tool_call_signatures() {
        let signature = "CvcQAdHN2OekY10ClPFkYA==";
        let big = "x".repeat(9000);
        let mut messages = json!([
            { "role": "system", "content": "rules" },
            { "role": "user", "content": "read both files" },
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "function-call-compaction",
                    "type": "function",
                    "extra_content": { "google": { "thought_signature": signature } },
                    "function": { "name": "Read", "arguments": "{\"file_path\":\"a.tex\"}" }
                }]
            },
            { "role": "tool", "tool_name": "Read", "tool_call_id": "function-call-compaction", "content": big },
            { "role": "user", "content": "and now?" },
            { "role": "assistant", "content": "done" }
        ]);

        let result = compact_tool_results(&mut messages, 2048);

        // The bulky result was shed…
        assert!(!result.dropped.is_empty());
        assert!(messages[3]["content"]
            .as_str()
            .unwrap()
            .contains("elided to fit the context window"));
        // …while the signature and the provider's call id survived untouched.
        assert_eq!(
            messages[2]["tool_calls"][0]["extra_content"]["google"]["thought_signature"],
            signature
        );
        assert_eq!(
            messages[2]["tool_calls"][0]["id"],
            "function-call-compaction"
        );
    }

    /// History trimming works on whole messages, so an assistant turn is kept with
    /// its signatures or dropped entirely — never kept with them stripped.
    #[test]
    fn persisted_history_keeps_tool_call_signatures_intact() {
        let tab = "signature-persistence-tab";
        let signature = "SIG_PERSISTED";
        let history = vec![
            json!({ "role": "user", "content": "go" }),
            json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "function-call-persist",
                    "type": "function",
                    "extra_content": { "google": { "thought_signature": signature } },
                    "function": { "name": "LS", "arguments": "{}" }
                }]
            }),
            json!({ "role": "tool", "tool_call_id": "function-call-persist", "content": "a.tex" }),
            json!({ "role": "assistant", "content": "found it" }),
        ];

        save_history(tab, history);
        let loaded = load_history(tab);

        let assistant = loaded
            .iter()
            .find(|message| message.get("tool_calls").is_some())
            .expect("the tool-calling assistant turn should survive");
        assert_eq!(
            assistant["tool_calls"][0]["extra_content"]["google"]["thought_signature"],
            signature
        );
        assert_eq!(assistant["tool_calls"][0]["id"], "function-call-persist");
    }

    #[test]
    fn save_history_trims_whole_exchanges() {
        // Four ~8KB exchanges (>24KB cap) so trimming must occur.
        let big = "x".repeat(8 * 1024);
        let mut hist = Vec::new();
        for i in 0..4 {
            hist.push(json!({ "role": "user", "content": format!("U{i}") }));
            hist.push(json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{ "type": "function", "function": { "name": "Read", "arguments": {} } }]
            }));
            hist.push(json!({ "role": "tool", "tool_name": "Read", "content": big }));
            hist.push(json!({ "role": "assistant", "content": format!("done{i}") }));
        }

        let tab = "native-agent-test-trim";
        save_history(tab, hist);
        let loaded = load_history(tab);
        clear_native_session(tab.to_string());

        // Head is a user boundary — no orphaned assistant/tool message (the bug).
        assert_eq!(role(loaded.first().unwrap()), "user");
        // The oldest exchange was dropped; the newest survived intact.
        assert!(!loaded.iter().any(|m| content(m) == Some("U0")));
        assert!(loaded.iter().any(|m| content(m) == Some("done3")));
        // Fits the cap, or is a single surviving exchange (only one user left).
        let size: usize = loaded.iter().map(|m| m.to_string().len()).sum();
        let users = loaded.iter().filter(|m| role(m) == "user").count();
        assert!(size <= HISTORY_BYTE_CAP || users == 1);
    }

    #[test]
    fn compact_elides_oldest_tool_results() {
        let big = "y".repeat(20 * 1024);
        let mut msgs = json!([
            { "role": "system", "content": "system rules" },
            { "role": "user", "content": "do it" },
            { "role": "assistant", "content": "", "tool_calls": [{ "type": "function", "function": { "name": "Read", "arguments": {} } }] },
            { "role": "tool", "tool_name": "Read", "content": big },
            { "role": "assistant", "content": "thinking" },
            { "role": "tool", "tool_name": "Read", "content": "recent small result" },
            { "role": "assistant", "content": "final" }
        ]);
        let before: usize = msgs
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m.to_string().len())
            .sum();

        let result = compact_tool_results(&mut msgs, 4 * 1024);
        let arr = msgs.as_array().unwrap();

        // System rules preserved, oldest bulky tool result elided, recent one kept.
        assert_eq!(arr[0]["content"], json!("system rules"));
        assert!(arr[3]["content"].as_str().unwrap().contains("elided"));
        assert_eq!(arr[5]["content"], json!("recent small result"));
        let after: usize = arr.iter().map(|m| m.to_string().len()).sum();
        assert!(after < before);
        assert!(result.dropped.contains(&"Read result".to_string()));
    }

    #[test]
    fn strip_persisted_images_drops_only_user_images() {
        let mut arr = vec![
            json!({ "role": "user", "content": "look at this", "images": ["AAAA"] }),
            json!({ "role": "assistant", "content": "ok" }),
            json!({ "role": "user", "content": "no image here" }),
        ];
        strip_persisted_images(&mut arr);
        // The base64 payload is gone, but the text prompt is preserved.
        assert!(arr[0].get("images").is_none());
        assert_eq!(arr[0]["content"], json!("look at this"));
        // Other roles and image-less users are untouched.
        assert_eq!(arr[1]["content"], json!("ok"));
        assert_eq!(arr[2]["content"], json!("no image here"));
    }

    #[test]
    fn compact_sheds_stale_image() {
        let big_img = "Z".repeat(40 * 1024);
        let mut msgs = json!([
            { "role": "system", "content": "system rules" },
            { "role": "user", "content": "describe", "images": [big_img] },
            { "role": "assistant", "content": "", "tool_calls": [{ "type": "function", "function": { "name": "Read", "arguments": {} } }] },
            { "role": "tool", "tool_name": "Read", "content": "small" },
            { "role": "assistant", "content": "done" }
        ]);
        let before: usize = msgs
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m.to_string().len())
            .sum();

        let result = compact_tool_results(&mut msgs, 4 * 1024);
        let arr = msgs.as_array().unwrap();

        // System rules preserved; the oversized base64 image was shed.
        assert_eq!(arr[0]["content"], json!("system rules"));
        assert!(arr[1].get("images").is_none());
        assert_eq!(arr[1]["content"], json!("describe"));
        let after: usize = arr.iter().map(|m| m.to_string().len()).sum();
        assert!(after < before);
        assert_eq!(after, result.total_bytes); // returned size matches the real size
        assert!(result.dropped.contains(&"image attachment".to_string()));
    }

    #[test]
    fn compact_is_noop_under_budget() {
        let mut msgs = json!([
            { "role": "system", "content": "rules" },
            { "role": "user", "content": "hi" }
        ]);
        let before = msgs.clone();
        compact_tool_results(&mut msgs, 1024 * 1024);
        assert_eq!(msgs, before);
    }

    #[test]
    fn system_rules_teach_navigation_capabilities() {
        // Weak local models lean on the system prompt (not just tool schemas), so
        // the navigate-then-act params must keep being advertised here. Guards
        // against a future trim silently hiding offset/limit, Grep context, or
        // LS depth from the model.
        assert!(SYSTEM_RULES.contains("offset"));
        assert!(SYSTEM_RULES.contains("context"));
        assert!(SYSTEM_RULES.contains("depth"));
        // The atomic multi-edit tool must keep being advertised in the prompt
        // (weak local models lean on the prompt, not just the tool schemas).
        assert!(SYSTEM_RULES.contains("MultiEdit"));
        // AskUser must keep being advertised too, with its "only when blocked"
        // guardrail (the schema description alone is not enough for weak models).
        assert!(SYSTEM_RULES.contains("AskUser"));
        assert!(SYSTEM_RULES.contains("genuinely blocked"));
    }

    #[test]
    fn answer_registry_roundtrip_and_sweep() {
        let id = "native_ask-reg-tab_0_0";
        register_pending_answer(id);

        // The command resolves a registered question by filling its slot...
        answer_native_agent_question(id.to_string(), "Option B".to_string()).unwrap();
        let slot = pending_answers()
            .lock()
            .unwrap()
            .get(id)
            .map(|p| p.slot.clone())
            .unwrap();
        assert_eq!(slot.lock().unwrap().as_deref(), Some("Option B"));

        // ...and rejects an id that is not pending.
        assert!(answer_native_agent_question("nope".to_string(), "x".to_string()).is_err());

        // The sweep removes only the given tab's entries.
        register_pending_answer("native_ask-other-tab_0_0");
        sweep_pending_answers("ask-reg-tab");
        {
            let g = pending_answers().lock().unwrap();
            assert!(!g.contains_key(id));
            assert!(g.contains_key("native_ask-other-tab_0_0"));
        }
        sweep_pending_answers("ask-other-tab");
        assert!(answer_native_agent_question(id.to_string(), "late".to_string()).is_err());
    }

    #[tokio::test]
    async fn wait_for_answer_resolves_answer_sent_before_await() {
        // notify_one stores a permit / the slot is pre-filled, so an answer that
        // arrives before the loop starts awaiting is not lost.
        let id = "native_ask-wait-tab_0_0";
        register_pending_answer(id);
        answer_native_agent_question(id.to_string(), "yes".to_string()).unwrap();
        assert_eq!(wait_for_answer(id).await.as_deref(), Some("yes"));
        remove_pending_answer(id);
    }

    #[tokio::test]
    async fn wait_for_answer_missing_entry_is_none() {
        // A missing entry resolves immediately to None (graceful "no answer"),
        // never hangs the agent loop.
        assert!(wait_for_answer("native_ask-missing-tab_0_0")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn ai_embed_cancel_registry_aborts_before_http() {
        // Pre-cancelled requestId must short-circuit without hitting the network.
        let id = "embed-cancel-precheck";
        let handle = register_ai_request_cancel(id);
        ai_cancel_request(id.to_string());
        assert!(handle.flag.load(Ordering::Relaxed));

        let err = ai_embed_inner(
            vec!["hello".into()],
            None,
            Some("http://127.0.0.1:9".into()),
            None,
            Some(clone_cancel_parts(&handle)),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "cancelled");
        take_ai_request_cancel(id);
    }

    #[tokio::test]
    async fn ai_embed_cancel_notify_aborts_in_flight() {
        // Mid-call cancel via Notify must win over a hanging future.
        let id = "embed-cancel-inflight";
        let handle = register_ai_request_cancel(id);
        let parts = clone_cancel_parts(&handle);
        let notify = Arc::clone(&handle.notify);
        let flag = Arc::clone(&handle.flag);

        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            flag.store(true, Ordering::Relaxed);
            notify.notify_waiters();
        });

        let hang = async {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            Ok::<Vec<Vec<f32>>, String>(vec![])
        };

        let result = tokio::select! {
            _ = parts.1.notified() => Err("cancelled".to_string()),
            r = hang => r,
        };
        let _ = cancel_task.await;
        assert_eq!(result.unwrap_err(), "cancelled");
        take_ai_request_cancel(id);
    }

    #[test]
    fn normalize_rel_resolves_and_guards() {
        assert_eq!(
            normalize_rel(Some("chapters/intro.tex")).as_deref(),
            Some("chapters/intro.tex")
        );
        // Backslashes normalized to '/', a leading './' stripped.
        assert_eq!(
            normalize_rel(Some(".\\a\\b.tex")).as_deref(),
            Some("a/b.tex")
        );
        // Absent / blank / traversal / absolute / drive yield None.
        assert!(normalize_rel(None).is_none());
        assert!(normalize_rel(Some("   ")).is_none());
        assert!(normalize_rel(Some("../secrets.txt")).is_none());
        assert!(normalize_rel(Some("/etc/passwd")).is_none());
        assert!(normalize_rel(Some("C:/Windows/system32")).is_none());
    }

    #[test]
    fn active_file_hint_embeds_selection() {
        // A short selection is echoed verbatim and flagged as Edit-usable.
        let h = active_file_hint("a.tex", Some("  the chosen sentence.  "), None, None, None);
        assert!(h.contains("ACTIVE FILE"));
        assert!(h.contains("the chosen sentence.")); // trimmed, verbatim
        assert!(h.contains("old_string"));
        assert!(!h.contains("truncated"));

        // A blank/whitespace selection adds nothing beyond the file hint.
        let h2 = active_file_hint("a.tex", Some("   "), None, None, None);
        assert!(!h2.contains("selected"));

        // An over-long selection is truncated and flagged for re-reading.
        let big = "x".repeat(SELECTION_MAX + 50);
        let h3 = active_file_hint("a.tex", Some(&big), None, None, None);
        assert!(h3.contains("truncated"));
        assert!(!h3.contains("old_string")); // not advertised as verbatim
    }

    #[test]
    fn active_file_hint_prefers_preloaded_slice_else_points() {
        // With a pre-loaded slice, embed it and don't ask for a Read.
        let h = active_file_hint(
            "a.tex",
            Some("sel"),
            Some((40, 42)),
            Some(">   40  hi\n"),
            None,
        );
        assert!(h.contains("without reading the file again"));
        assert!(h.contains(">   40  hi"));
        assert!(!h.contains("Read `a.tex` with offset"));

        // Without a slice, fall back to a "Read with offset" pointer (10-line margin).
        let h2 = active_file_hint("a.tex", Some("sel"), Some((40, 42)), None, None);
        assert!(h2.contains("lines 40-42"));
        assert!(h2.contains("offset 30"));
        // Near the top the offset clamps to 1.
        let h3 = active_file_hint("a.tex", Some("sel"), Some((3, 5)), None, None);
        assert!(h3.contains("offset 1"));
        // No selection -> no line pointer at all.
        let h4 = active_file_hint("a.tex", None, Some((40, 42)), None, None);
        assert!(!h4.contains("spans lines"));
    }

    #[test]
    fn active_file_hint_inlines_whole_small_file_only_without_selection() {
        // No selection + a short file: inline its content for direct editing.
        let h = active_file_hint(
            "a.tex",
            None,
            None,
            None,
            Some("Intro paragraph.\nSecond line."),
        );
        assert!(h.contains("full current content"));
        assert!(h.contains("Intro paragraph."));
        assert!(h.contains("Second line."));

        // A selection takes precedence — the whole-file inline is suppressed so the
        // two contexts don't both balloon the prompt.
        let h2 = active_file_hint(
            "a.tex",
            Some("the selected bit"),
            Some((2, 2)),
            None,
            Some("WHOLE FILE BODY"),
        );
        assert!(!h2.contains("WHOLE FILE BODY"));
        assert!(h2.contains("the selected bit"));
    }

    #[test]
    fn read_small_file_inlines_under_bounds_only() {
        let dir = std::env::temp_dir().join(format!("devprism_small_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);

        // A short file is inlined verbatim (trailing newline trimmed).
        std::fs::write(dir.join("short.tex"), "alpha\nbeta\n").unwrap();
        let s = read_small_file(&dir, "short.tex").unwrap();
        assert_eq!(s, "alpha\nbeta");

        // An empty file yields nothing to inline.
        std::fs::write(dir.join("empty.tex"), "").unwrap();
        assert!(read_small_file(&dir, "empty.tex").is_none());

        // A file over the line bound is not inlined (model should Read instead).
        let big: String = (0..WHOLE_FILE_MAX_LINES + 5)
            .map(|i| format!("l{i}\n"))
            .collect();
        std::fs::write(dir.join("big.tex"), &big).unwrap();
        assert!(read_small_file(&dir, "big.tex").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_surrounding_lines_windows_with_markers() {
        let dir = std::env::temp_dir().join(format!("devprism_ctx_slice_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let body: String = (1..=30).map(|i| format!("line{i}\n")).collect();
        std::fs::write(dir.join("f.txt"), &body).unwrap();

        // Selection lines 10..=11 with an 8-line margin -> shows lines 2..=19.
        let slice = read_surrounding_lines(&dir, "f.txt", 10, 11).unwrap();
        assert!(slice.contains(">   10  line10")); // selected line, marked
        assert!(slice.contains(">   11  line11"));
        assert!(slice.contains("    2  line2")); // context line, unmarked
        assert!(slice.contains("   19  line19"));
        assert!(!slice.contains("line20")); // outside the window
        assert!(!slice.contains("line1\n")); // line 1 is below the margin start

        // A start line past the end of the file yields nothing (file changed).
        assert!(read_surrounding_lines(&dir, "f.txt", 999, 1000).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn strip_inline_fences_removes_wrappers() {
        assert_eq!(strip_inline_fences("hello"), "hello");
        assert_eq!(
            strip_inline_fences("```latex\n\\textbf{hi}\n```"),
            "\\textbf{hi}"
        );
    }

    #[test]
    fn inline_transform_instruction_maps_actions() {
        assert!(inline_transform_instruction("rephrase", None).contains("Rephrase"));
        assert!(inline_transform_instruction("expand", None).contains("Expand"));
        assert!(inline_transform_instruction("proofread", None).contains("Proofread"));
        assert_eq!(
            inline_transform_instruction("edit", Some("Make it shorter")),
            "Make it shorter"
        );
    }

    #[test]
    fn stream_heartbeat_message_shape() {
        let base = super::stream_heartbeat_message("tool", None);
        assert_eq!(base["type"], "system");
        assert_eq!(base["subtype"], "heartbeat");
        assert_eq!(base["phase"], "tool");
        assert!(base.get("detail").is_none());

        let with_detail = super::stream_heartbeat_message("tool", Some("Bash"));
        assert_eq!(with_detail["detail"], "Bash");
    }
}
