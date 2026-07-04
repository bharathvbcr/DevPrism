//! Native, claude-CLI-free agent runtime.
//!
//! Talks DIRECTLY to a local Ollama server (`/api/chat` with native tool
//! calling) — no `claude` CLI and no Anthropic translation proxy. The tool loop,
//! tools, and project context are all implemented in Rust here.
//!
//! It emits the SAME Tauri events as the Claude CLI path (`claude-output` lines
//! in stream-json shape, then `claude-complete`), so the existing chat UI renders
//! its output and detects file changes without modification.

mod ollama;
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

/// Whether a chat error is worth retrying: transient transport / server issues,
/// but NOT a permanent capability/config error (no tools, no model) which would
/// just fail again identically.
fn is_retryable_chat_error(err: &str) -> bool {
    if err.contains("E_NO_TOOLS") || err.contains("E_NO_MODEL") {
        return false;
    }
    err.contains("E_OLLAMA_UNREACHABLE")
        || err.contains("E_OLLAMA_STALLED")
        || err.contains("Ollama stream error")
        || err.contains("Ollama returned HTTP 5")
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
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(u64::MAX) > 2 * 1024 * 1024 {
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

fn cancels() -> &'static Mutex<HashMap<String, CancelHandle>> {
    static C: OnceLock<Mutex<HashMap<String, CancelHandle>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
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
    let handle = pending_answers()
        .lock()
        .ok()
        .and_then(|g| g.get(&request_id).map(|p| (p.slot.clone(), p.notify.clone())));
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
        None => return CompactionResult {
            total_bytes: 0,
            dropped: Vec::new(),
        },
    };
    let mut dropped: Vec<String> = Vec::new();
    let mut total: usize = arr.iter().map(|m| m.to_string().len()).sum();
    if total <= budget_bytes {
        return CompactionResult { total_bytes: total, dropped };
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

fn emit_context_truncation(
    window: &WebviewWindow,
    tab_id: &str,
    dropped: &[String],
    source: &str,
) {
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
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(Notify::new());

    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    // Resolve the model BEFORE registering the cancel handle: the resolution
    // await below is not wrapped in the notify-based select, so registering
    // earlier only risks leaking the registry entry on the early error return.
    let model = match model {
        Some(m) if !m.trim().is_empty() => m,
        _ => match ollama::first_installed_model(&base).await {
            Some(m) => m,
            None => {
                let msg = format!(
                    "[E_NO_MODEL] No Ollama model is available at {}. Start Ollama and run `ollama pull llama3` (or another model).",
                    ollama::native_base(&base)
                );
                emit_result(&window, &tab_id, false, &msg);
                finish(&window, &tab_id, false);
                return Err(msg);
            }
        },
    };

    // Register the cancel handle, refusing a second concurrent turn for this tab:
    // a new turn would clobber the in-flight one's handle (making it un-stoppable)
    // and the two would race on the persisted history. Check-and-insert atomically.
    let already_running = match cancels().lock() {
        Ok(mut guard) => {
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
        }
        Err(_) => false,
    };
    if already_running {
        let msg = "[E_ALREADY_RUNNING] A task is already running in this tab. Stop it before starting another."
            .to_string();
        emit_result(&window, &tab_id, false, &msg);
        finish(&window, &tab_id, false);
        return Err(msg);
    }

    // Suppress macOS App Nap for the lifetime of this turn so a backgrounded
    // window doesn't throttle the Ollama stream or a Bash tool mid-run. Dropped
    // when this command returns (success, error, or cancel), like the CLI path.
    #[cfg(target_os = "macos")]
    let _nap = crate::app_nap::NapActivity::begin("Native agent session");

    let project = std::path::Path::new(&project_path);
    let client = ollama::OllamaClient::new(&base, &model, num_ctx, temperature)
        .with_keep_alive(keep_alive.as_deref());

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
    system.push_str(&crate::project_context::build_project_context_prompt(project));
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
        let has_selection = selection.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
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
        // the prompt past 80% of num_ctx (which would crowd out the system rules).
        // The returned byte size is the actual prompt we send this round.
        let compaction = compact_tool_results(&mut messages, ctx_budget);
        let sent_bytes = compaction.total_bytes;
        if !compaction.dropped.is_empty() {
            emit_context_truncation(
                &window,
                &tab_id,
                &compaction.dropped,
                "tool results",
            );
        }

        // Run the request, but abort it immediately if the user hits stop.
        // Text fragments stream straight to the UI as `streaming_delta` blocks
        // (the same protocol the direct-provider path uses); the finalized turn
        // is reconciled into a `streaming_final` message below.
        let turn = {
            let mut attempt = 0u32;
            'chat: loop {
                let r = tokio::select! {
                    r = client.chat(&messages, &tools, |frag: &str| {
                        emit_msg(
                            &window,
                            &tab_id,
                            &json!({
                                "type": "assistant",
                                "subtype": "streaming_delta",
                                "message": { "content": [{ "type": "text", "text": frag }] },
                            }),
                        );
                    }) => r,
                    _ = notify.notified() => { success = false; break 'outer; }
                };
                match r {
                    Ok(t) => break 'chat t,
                    Err(e) => {
                        attempt += 1;
                        if attempt < MAX_CHAT_ATTEMPTS && is_retryable_chat_error(&e) {
                            // Transient — back off and retry rather than throwing away
                            // the turn's progress, staying responsive to Stop.
                            let backoff =
                                std::time::Duration::from_millis(400u64 << (attempt - 1));
                            eprintln!(
                                "[native-agent] chat attempt {attempt} failed (retryable): {e}"
                            );
                            tokio::select! {
                                _ = tokio::time::sleep(backoff) => {}
                                _ = notify.notified() => { success = false; break 'outer; }
                            }
                            continue 'chat;
                        }
                        emit_result(&window, &tab_id, false, &e);
                        success = false;
                        break 'outer;
                    }
                }
            }
        };

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
            emit_result(&window, &tab_id, true, "(the model returned no further output)");
            break;
        }
        consecutive_empty = 0;

        // Build the assistant content blocks for the UI and stable tool ids.
        let mut content_blocks: Vec<Value> = Vec::new();
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
            if !turn.content.trim().is_empty() {
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
            .map(|tc| json!({ "type": "function", "function": { "name": tc.name, "arguments": tc.args } }))
            .collect();
        if let Some(arr) = messages.as_array_mut() {
            let mut assistant_msg = json!({ "role": "assistant", "content": turn.content });
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
                    a = wait_for_answer(id) => a,
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
                    res = tools::execute(project, &tc.name, &tc.args) => res,
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
    if let Ok(mut guard) = cancels().lock() {
        guard.remove(&tab_id);
    }
    finish(&window, &tab_id, success);
    Ok(())
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
        // OpenAI-compatible providers vary in JSON-mode support; the caller's
        // prompt already requests JSON and the frontend salvages it, so we do
        // not force a response format on this path.
        return crate::claude::complete_openai_compatible_chat(
            Some(cred_id),
            messages,
            model.as_deref(),
            temperature,
        )
        .await;
    }

    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let model = match model {
        Some(m) if !m.trim().is_empty() => m,
        _ => match ollama::first_installed_model(&base).await {
            Some(m) => m,
            None => {
                return Err(format!(
                    "[E_NO_MODEL] No Ollama model is available at {}. Start Ollama and pull a chat model.",
                    ollama::native_base(&base)
                ));
            }
        },
    };
    let mut client = ollama::OllamaClient::new(&base, &model, num_ctx, temperature);
    if json_format {
        client = client.with_json_format();
    }
    let turn = client
        .chat(&json!(messages), &json!([]), |_| {})
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
    let system = crate::personalization::augment_system_prompt(Some(INLINE_TRANSFORM_SYSTEM.to_string()));
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
) -> Result<String, String> {
    let user = prompt.trim();
    if user.is_empty() {
        return Err("Prompt is empty.".to_string());
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

    let content = complete_chat_messages(
        messages,
        model,
        base_url,
        num_ctx,
        temperature,
        provider_credential_id,
        json_format,
    )
    .await?;

    let out = strip_inline_fences(&content);
    if out.is_empty() {
        return Err("The model returned an empty response.".into());
    }
    Ok(out)
}

/// Embed one or more texts with a local Ollama embedding model (e.g.
/// `nomic-embed-text`). Returns one float vector per input, enabling local
/// semantic search/ranking. Ollama-only — provider credentials are not used.
#[tauri::command]
pub async fn ai_embed(
    texts: Vec<String>,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }

    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let model = match model {
        Some(m) if !m.trim().is_empty() => m,
        _ => match ollama::first_embedding_model(&base).await {
            Some(m) => m,
            None => {
                return Err(format!(
                    "No embedding model is installed at {}. Pull one, e.g. \
                     `ollama pull nomic-embed-text`.",
                    ollama::native_base(&base)
                ));
            }
        },
    };

    let client = ollama::OllamaClient::new(&base, &model, None, None);
    client.embed(&texts).await
}

/// Streaming variant of `ai_complete`: text fragments are forwarded over the
/// `on_chunk` channel as they arrive. The OpenAI-compatible credential path is
/// non-streaming, so it sends the whole reply as a single chunk. Returns the
/// fully-accumulated (fence-stripped) text.
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
) -> Result<String, String> {
    let user = prompt.trim();
    if user.is_empty() {
        return Err("Prompt is empty.".to_string());
    }

    let system = crate::personalization::augment_system_prompt(system);
    let mut messages = Vec::new();
    if let Some(sys) = system.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        messages.push(json!({ "role": "system", "content": sys }));
    }
    messages.push(json!({ "role": "user", "content": user }));

    if let Some(cred_id) = provider_credential_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        let content = crate::claude::complete_openai_compatible_chat(
            Some(cred_id),
            messages,
            model.as_deref(),
            temperature,
        )
        .await?;
        let out = strip_inline_fences(&content);
        if out.is_empty() {
            return Err("The model returned an empty response.".into());
        }
        let _ = on_chunk.send(out.clone());
        return Ok(out);
    }

    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let model = match model {
        Some(m) if !m.trim().is_empty() => m,
        _ => match ollama::first_installed_model(&base).await {
            Some(m) => m,
            None => {
                return Err(format!(
                    "[E_NO_MODEL] No Ollama model is available at {}. Start Ollama and pull a chat model.",
                    ollama::native_base(&base)
                ));
            }
        },
    };

    let client = ollama::OllamaClient::new(&base, &model, num_ctx, temperature);
    let turn = client
        .chat(&json!(messages), &json!([]), |frag| {
            let _ = on_chunk.send(frag.to_string());
        })
        .await
        .map_err(|e| e.to_string())?;

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
    let caption_temp = temperature.filter(|&t| (0.0..=2.0).contains(&t)).unwrap_or(0.3);

    let base = base_url
        .clone()
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    let mut resolved_model = match model.clone() {
        Some(m) if !m.trim().is_empty() => m,
        _ => match ollama::first_installed_model(&base).await {
            Some(m) => m,
            None => {
                return Err(format!(
                    "No Ollama model is available at {}.",
                    ollama::native_base(&base)
                ));
            }
        },
    };

    // If the configured/default model definitely can't see images, try to fall
    // back to an installed vision-capable model rather than failing outright —
    // the chat model (used everywhere else) is often text-only. `None` (unknown
    // capability) proceeds and lets the request decide.
    let client = ollama::OllamaClient::new(&base, &resolved_model, num_ctx, Some(caption_temp));
    if client.supports_vision().await == Some(false) {
        match ollama::first_vision_model(&base).await {
            Some(vm) => resolved_model = vm,
            None => {
                return Err(format!(
                    "The model '{}' has no vision support and no vision-capable model is \
                     installed. Pull one, e.g. `ollama pull llava` (or llama3.2-vision, qwen2.5vl).",
                    resolved_model
                ));
            }
        }
    }

    let instruction = prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Describe this image concisely for a figure caption: one sentence, no preamble.");

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
    fn retryable_chat_errors_are_transient_only() {
        assert!(is_retryable_chat_error(
            "[E_OLLAMA_UNREACHABLE] Could not reach Ollama at http://localhost:11434"
        ));
        assert!(is_retryable_chat_error(
            "[E_OLLAMA_STALLED] Ollama stopped emitting tokens for 90s"
        ));
        assert!(is_retryable_chat_error("Ollama stream error: connection reset"));
        assert!(is_retryable_chat_error("Ollama returned HTTP 503: unavailable"));
        // Permanent capability/config errors must NOT retry.
        assert!(!is_retryable_chat_error(
            "[E_NO_TOOLS] The model 'gemma:2b' does not support tool-calling."
        ));
        assert!(!is_retryable_chat_error("[E_NO_MODEL] No Ollama model installed"));
        assert!(!is_retryable_chat_error("Ollama returned HTTP 400: bad request"));
    }

    fn role(m: &Value) -> &str {
        m.get("role").and_then(|r| r.as_str()).unwrap_or("")
    }
    fn content(m: &Value) -> Option<&str> {
        m.get("content").and_then(|c| c.as_str())
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
        let before: usize = msgs.as_array().unwrap().iter().map(|m| m.to_string().len()).sum();

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
        let before: usize = msgs.as_array().unwrap().iter().map(|m| m.to_string().len()).sum();

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
        assert!(wait_for_answer("native_ask-missing-tab_0_0").await.is_none());
    }

    #[test]
    fn normalize_rel_resolves_and_guards() {
        assert_eq!(normalize_rel(Some("chapters/intro.tex")).as_deref(), Some("chapters/intro.tex"));
        // Backslashes normalized to '/', a leading './' stripped.
        assert_eq!(normalize_rel(Some(".\\a\\b.tex")).as_deref(), Some("a/b.tex"));
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
        let h = active_file_hint("a.tex", Some("sel"), Some((40, 42)), Some(">   40  hi\n"), None);
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
        let h = active_file_hint("a.tex", None, None, None, Some("Intro paragraph.\nSecond line."));
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
        let big: String = (0..WHOLE_FILE_MAX_LINES + 5).map(|i| format!("l{i}\n")).collect();
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
}
