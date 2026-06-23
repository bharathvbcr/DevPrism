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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, WebviewWindow};
use tokio::sync::Notify;

const MAX_ITERATIONS: usize = 16;

/// Synthetic prompt used to nudge a model that returned nothing; never persisted.
const CONTINUE_NUDGE: &str =
    "Continue. If the task is complete, give a short final summary; otherwise use a tool.";

fn is_continue_nudge(m: &Value) -> bool {
    m.get("role").and_then(|r| r.as_str()) == Some("user")
        && m.get("content").and_then(|c| c.as_str()) == Some(CONTINUE_NUDGE)
}

const SYSTEM_RULES: &str = concat!(
    "You are DevPrism's writing assistant, working INSIDE the user's project on their machine. ",
    "You have tools: Read, Write, Edit, LS, Grep, Glob, Bash. Use Glob to find files by name ",
    "(e.g. *.tex), Grep to find text inside files, LS to list a directory, and Read before editing. ",
    "Do not ask the user for file contents you can read yourself.\n",
    "Rules:\n",
    "1. PLAN, then act in small steps. Read a file before editing it.\n",
    "2. Prefer Edit (a unique old_string -> new_string) over rewriting whole files with Write.\n",
    "3. For LaTeX: keep the preamble/structure intact; DevPrism auto-compiles on save.\n",
    "4. Python: a project .venv is auto-activated; use Bash with `uv run python ...`.\n",
    "5. PROJECT CONTEXT & AUTONOMY: first read any instruction/master/profile files listed below ",
    "and consult the project map and installed skills; do not ask for details that are already there. ",
    "Keep going until the task is complete, then give a short summary."
);

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
    // Trim oldest messages until the serialized history fits the byte cap.
    while history.len() > 2 {
        let size: usize = history.iter().map(|m| m.to_string().len()).sum();
        if size <= HISTORY_BYTE_CAP {
            break;
        }
        history.remove(0);
    }
    // After byte-trimming, the front may be an orphaned assistant/tool message;
    // drop leading non-user messages so the next turn starts at a user boundary
    // (a dangling assistant-tool_calls or tool message at the head breaks Ollama).
    while history
        .first()
        .map(|m| m.get("role").and_then(|r| r.as_str()) != Some("user"))
        .unwrap_or(false)
    {
        history.remove(0);
    }
    if let Ok(mut g) = sessions().lock() {
        g.insert(tab_id.to_string(), history);
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
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(Notify::new());
    if let Ok(mut guard) = cancels().lock() {
        guard.insert(
            tab_id.clone(),
            CancelHandle {
                flag: cancel.clone(),
                notify: notify.clone(),
            },
        );
    }

    let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let model = match model {
        Some(m) if !m.trim().is_empty() => m,
        _ => match ollama::first_installed_model(&base).await {
            Some(m) => m,
            None => {
                let msg = format!(
                    "No Ollama model is available at {}. Start Ollama and run `ollama pull llama3` (or another model).",
                    ollama::native_base(&base)
                );
                emit_result(&window, &tab_id, false, &msg);
                finish(&window, &tab_id, false);
                return Err(msg);
            }
        },
    };

    let project = std::path::Path::new(&project_path);
    let client = ollama::OllamaClient::new(&base, &model);

    let mut system = String::from(SYSTEM_RULES);
    system.push_str(&crate::project_context::build_project_context_prompt(project));

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
    let tools = tools::tool_schemas();

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

    'outer: for iter in 0..MAX_ITERATIONS {
        if cancel.load(Ordering::Relaxed) {
            success = false;
            break;
        }

        // Run the request, but abort it immediately if the user hits stop.
        let turn = tokio::select! {
            r = client.chat(&messages, &tools) => match r {
                Ok(t) => t,
                Err(e) => {
                    emit_result(&window, &tab_id, false, &e);
                    success = false;
                    break;
                }
            },
            _ = notify.notified() => { success = false; break; }
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
        last_prompt_tokens = turn.prompt_tokens;
        if !content_blocks.is_empty() {
            emit_msg(
                &window,
                &tab_id,
                &json!({
                    "type": "assistant",
                    "message": {
                        "content": content_blocks,
                        "usage": { "input_tokens": 0, "output_tokens": turn.eval_tokens },
                    }
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
        for (idx, tc) in turn.tool_calls.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                success = false;
                break 'outer;
            }
            let id = &call_ids[idx];

            // Short-circuit an exact repeat of an idempotent call (no mutation in
            // between) so a confused model can't burn iterations re-running it.
            let sig = format!("{}|{}", tc.name.to_lowercase(), tc.args);
            let (result, is_error) = if !seen_calls.insert(sig) {
                (
                    "(skipped: this exact tool call was just run with no changes since — use the earlier result)"
                        .to_string(),
                    false,
                )
            } else {
                // Abort the tool mid-flight if the user hits stop (Bash sets
                // kill_on_drop, so dropping this future reaps the child process).
                tokio::select! {
                    res = tools::execute(project, &tc.name, &tc.args) => res,
                    _ = notify.notified() => { success = false; break 'outer; }
                }
            };

            // A successful mutation changes the tree, so allow Read/LS/Grep/Glob to
            // re-run and see fresh state (e.g. Read after Edit, Bash re-build).
            if !is_error && matches!(tc.name.as_str(), "Write" | "Edit" | "Bash") {
                seen_calls.clear();
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

        if iter == MAX_ITERATIONS - 1 {
            emit_result(
                &window,
                &tab_id,
                true,
                "Reached the step limit for this turn. Ask me to continue if more is needed.",
            );
        }
    }

    // Persist the conversation (everything except the rebuilt system message) so
    // the next turn in this tab has memory of what happened. Repair any trailing
    // incomplete turn (e.g. from a mid-loop cancel) so history stays balanced.
    if let Some(arr) = messages.as_array_mut() {
        arr.remove(0); // drop the system message
        arr.retain(|m| !is_continue_nudge(m)); // don't persist synthetic nudges
        repair_tail(arr);
        save_history(&tab_id, arr.clone());
    }

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
