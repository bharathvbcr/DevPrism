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

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, WebviewWindow};

const MAX_ITERATIONS: usize = 16;

const SYSTEM_RULES: &str = concat!(
    "You are DevPrism's writing assistant, working INSIDE the user's project on their machine. ",
    "You have tools: Read, Write, Edit, LS, Grep, Bash. Use them to inspect and change files — ",
    "do not ask the user for file contents you can read yourself.\n",
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

fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
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
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut guard) = cancels().lock() {
        guard.insert(tab_id.clone(), cancel.clone());
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
        arr.push(json!({ "role": "user", "content": prompt }));
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

    'outer: for iter in 0..MAX_ITERATIONS {
        if cancel.load(Ordering::Relaxed) {
            success = false;
            break;
        }

        let turn = match client.chat(&messages, &tools).await {
            Ok(t) => t,
            Err(e) => {
                emit_result(&window, &tab_id, false, &e);
                success = false;
                break;
            }
        };

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

        // Record the assistant turn in the model's message history.
        let assistant_tool_calls: Vec<Value> = turn
            .tool_calls
            .iter()
            .map(|tc| json!({ "type": "function", "function": { "name": tc.name, "arguments": tc.args } }))
            .collect();
        if let Some(arr) = messages.as_array_mut() {
            arr.push(json!({
                "role": "assistant",
                "content": turn.content,
                "tool_calls": assistant_tool_calls,
            }));
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
            let (result, is_error) = tools::execute(project, &tc.name, &tc.args).await;

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
                arr.push(json!({
                    "role": "tool",
                    "name": tc.name,
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
    // the next turn in this tab has memory of what happened.
    if let Some(arr) = messages.as_array() {
        let new_history: Vec<Value> = arr.iter().skip(1).cloned().collect();
        save_history(&tab_id, new_history);
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
        if let Some(flag) = guard.get(&tab_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}
