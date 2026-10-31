//! Chat turns are `manvi run`. One-shot completion, embeddings, captions, and
//! Ollama admin stay in this module. The chat UI still receives `claude-output`
//! and `claude-complete`.

pub mod delta_coalesce;
pub mod manvi_sidecar;
pub mod manvi_turn;
pub(crate) mod ollama;
pub mod openai_compat;
mod tools;

// The walk skip-list doubles as the history snapshot's dependency/build-tree
// excludes (history.rs), so both surfaces agree on what is ignorable.
pub(crate) use tools::EXCLUDE_DIRS;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, WebviewWindow};
use tokio::sync::Notify;

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

fn clone_cancel_parts(handle: &CancelHandle) -> (Arc<AtomicBool>, Arc<Notify>) {
    (Arc::clone(&handle.flag), Arc::clone(&handle.notify))
}

/// Deliver the user's reply to a pending AskUser question (called by the chat
/// widget). Errors when the question is no longer pending — already answered,
/// timed out, or the run was stopped.
#[tauri::command]
pub fn answer_native_agent_question(request_id: String, answer: String) -> Result<(), String> {
    manvi_turn::answer(&request_id, &answer)
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
    manvi_turn::forget_tab(&tab_id);
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

/// RAII wrapper over [`delta_coalesce::DeltaForwarder`] that flushes buffered
/// tail text on drop. The chat loop has several exits — normal turn end, a
/// terminal chat error, Stop mid-stream, Stop mid-retry-wait, Stop mid-tool,
/// the step limit — and the explicit `finish()` call sites only covered two of
/// them: both Stop arms jumped straight out of the loop and dropped up to
/// FLUSH_BYTES of coalesced text. Dropping this guard now flushes wherever the
/// scope ends; the early `finish()` calls stay as idempotent flushes before
/// terminal events.
struct DeltaTailGuard<S: FnMut(ollama::StreamDeltaKind, &str)> {
    inner: delta_coalesce::DeltaForwarder<S>,
}

impl<S: FnMut(ollama::StreamDeltaKind, &str)> DeltaTailGuard<S> {
    fn new(inner: delta_coalesce::DeltaForwarder<S>) -> Self {
        Self { inner }
    }

    fn push(&mut self, kind: ollama::StreamDeltaKind, frag: &str) {
        self.inner.push(kind, frag);
    }

    fn finish(&mut self) -> bool {
        self.inner.finish()
    }
}

impl<S: FnMut(ollama::StreamDeltaKind, &str)> Drop for DeltaTailGuard<S> {
    fn drop(&mut self) {
        self.inner.finish();
    }
}

/// Run one chat turn. Manvi owns the tool loop for local and Claude chat.
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
    num_ctx: Option<u32>,
    temperature: Option<f32>,
    // Ollama `keep_alive`. Forwarded only for that provider. Anthropic and
    // other OpenAI-compatible hosts never see it.
    keep_alive: Option<String>,
    active_file: Option<String>,
    selection: Option<String>,
    selection_start_line: Option<u32>,
    selection_end_line: Option<u32>,
    // On-device profile. The host puts it in the user prefix. Manvi keeps
    // its own system prompt.
    personalization_prompt: Option<String>,
    compile_state_prompt: Option<String>,
    // When true, `manvi run --chat-only` offers no tools. Ollama also forces
    // this when the model reports that it has no tool capability.
    chat_only: Option<bool>,
    effort_level: Option<String>,
    api_key: Option<String>,
    chat_provider: Option<String>,
    provider_credential_id: Option<String>,
    session_id: Option<String>,
) -> Result<(), String> {
    manvi_turn::run(manvi_turn::RunRequest {
        window,
        project_path,
        prompt,
        tab_id,
        model,
        base_url,
        images,
        num_ctx,
        temperature,
        keep_alive,
        active_file,
        selection,
        selection_start_line,
        selection_end_line,
        personalization_prompt,
        compile_state_prompt,
        chat_only,
        effort_level,
        api_key,
        chat_provider,
        provider_credential_id,
        session_id,
    })
    .await
}

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

    if let Some(id) = request_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
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
        let out =
            crate::claude::complete_claude_print(&user, system.as_deref(), flag, notify).await?;
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

    let result = ai_embed_inner(texts, model, base_url, provider_credential_id, cancel_parts).await;

    if let Some(id) = request_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
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

    if let Some(id) = request_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
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
pub async fn stop_native_agent(window: WebviewWindow, tab_id: String) {
    manvi_turn::stop(window, tab_id).await;
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
        assert_eq!(
            probe_base("https://api.groq.com/openai/v1"),
            "https://api.groq.com/openai/v1"
        );
        assert_eq!(
            probe_base("https://generativelanguage.googleapis.com/v1beta/openai"),
            "https://generativelanguage.googleapis.com/v1beta/openai"
        );
        // Bare host: /v1 appended, exactly as the chat URL builder would.
        assert_eq!(
            probe_base("http://127.0.0.1:8000"),
            "http://127.0.0.1:8000/v1"
        );
        assert_eq!(
            probe_base("http://localhost:1234/"),
            "http://localhost:1234/v1"
        );
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

    /// The Stop arms of the chat loop break out of the scope without running
    /// the explicit finish() calls; the guard's Drop must flush the tail so
    /// coalesced text is never lost on that path.
    #[test]
    fn delta_tail_guard_flushes_buffered_text_on_drop() {
        type Recording = Vec<(ollama::StreamDeltaKind, String)>;
        let captured: std::rc::Rc<std::cell::RefCell<Recording>> = Default::default();

        {
            let sink = captured.clone();
            let mut guard =
                DeltaTailGuard::new(delta_coalesce::DeltaForwarder::new(move |kind, text| {
                    sink.borrow_mut().push((kind, text.to_string()));
                }));
            guard.push(ollama::StreamDeltaKind::Text, "tail ");
            guard.push(ollama::StreamDeltaKind::Text, "text");
            // No explicit finish(): the drop below must flush.
        }

        let out = captured.borrow();
        assert_eq!(out.len(), 1, "drop must emit exactly one tail block");
        assert_eq!(out[0].0, ollama::StreamDeltaKind::Text);
        assert_eq!(out[0].1, "tail text");
    }

    /// An explicit finish() before the drop stays idempotent — no duplicate
    /// emission when both paths run (error branch + convergent post-loop flush).
    #[test]
    fn delta_tail_guard_finish_then_drop_does_not_duplicate() {
        type Recording = Vec<(ollama::StreamDeltaKind, String)>;
        let captured: std::rc::Rc<std::cell::RefCell<Recording>> = Default::default();

        {
            let sink = captured.clone();
            let mut guard =
                DeltaTailGuard::new(delta_coalesce::DeltaForwarder::new(move |kind, text| {
                    sink.borrow_mut().push((kind, text.to_string()));
                }));
            guard.push(ollama::StreamDeltaKind::Thinking, "hmm");
            assert!(guard.finish());
            assert!(!guard.finish(), "second finish must be a no-op");
        }

        let out = captured.borrow();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], (ollama::StreamDeltaKind::Thinking, "hmm".into()));
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
