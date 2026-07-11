//! Cursor ACP (Agent Client Protocol) JSON-RPC client over `agent acp` stdio.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{Emitter, WebviewWindow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use super::setup::{find_agent_binary, stored_cursor_api_key};
use super::stream_adapter;

struct AcpSession {
    child: Child,
    session_id: Option<String>,
}

static ACP_SESSIONS: OnceLock<Mutex<HashMap<String, AcpSession>>> = OnceLock::new();
static NEXT_RPC_ID: AtomicU64 = AtomicU64::new(1);

fn acp_sessions() -> &'static Mutex<HashMap<String, AcpSession>> {
    ACP_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn emit_output(window: &WebviewWindow, tab_id: &str, data: String) {
    #[derive(Clone, serde::Serialize)]
    struct AgentOutputEvent {
        tab_id: String,
        data: String,
    }
    let _ = window.emit(
        "claude-output",
        AgentOutputEvent {
            tab_id: tab_id.to_string(),
            data,
        },
    );
}

fn emit_complete(window: &WebviewWindow, tab_id: &str, success: bool) {
    #[derive(Clone, serde::Serialize)]
    struct AgentCompleteEvent {
        tab_id: String,
        success: bool,
    }
    let _ = window.emit(
        "claude-complete",
        AgentCompleteEvent {
            tab_id: tab_id.to_string(),
            success,
        },
    );
}

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct AcpRpc {
    stdin: Arc<AsyncMutex<ChildStdin>>,
    pending: PendingMap,
}

impl AcpRpc {
    fn new(stdin: ChildStdin) -> Self {
        Self {
            stdin: Arc::new(AsyncMutex::new(stdin)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn write_line(&self, line: &str) -> Result<(), String> {
        let mut guard = self.stdin.lock().await;
        guard
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("ACP write failed: {e}"))?;
        guard
            .flush()
            .await
            .map_err(|e| format!("ACP flush failed: {e}"))
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = NEXT_RPC_ID.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "ACP pending lock poisoned".to_string())?
            .insert(id, tx);

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(e) = self.write_line(&format!("{msg}\n")).await {
            self.pending.lock().ok().and_then(|mut p| p.remove(&id));
            return Err(e);
        }

        match rx.await {
            Ok(result) => result,
            Err(_) => Err(format!("ACP request {method} dropped before response")),
        }
    }

    async fn respond(&self, id: &Value, result: Value) -> Result<(), String> {
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        });
        self.write_line(&format!("{msg}\n")).await
    }

    async fn close_stdin(&self) {
        let mut guard = self.stdin.lock().await;
        let _ = guard.shutdown().await;
    }
}

fn resolve_pending(pending: &PendingMap, id: u64, result: Result<Value, String>) {
    if let Ok(mut guard) = pending.lock() {
        if let Some(tx) = guard.remove(&id) {
            let _ = tx.send(result);
        }
    }
}

fn rpc_id_from_value(v: &Value) -> Option<u64> {
    v.get("id").and_then(|id| {
        id.as_u64()
            .or_else(|| id.as_str().and_then(|s| s.parse().ok()))
    })
}

async fn respond_permission(rpc: &AcpRpc, request_id: &Value) -> Result<(), String> {
    rpc.respond(
        request_id,
        json!({
            "outcome": {
                "outcome": "selected",
                "optionId": "allow-once"
            }
        }),
    )
    .await
}

async fn respond_ask_question_skipped(rpc: &AcpRpc, request_id: &Value) -> Result<(), String> {
    rpc.respond(
        request_id,
        json!({
            "outcome": {
                "outcome": "skipped",
                "reason": "Headless client auto-skipped"
            }
        }),
    )
    .await
}

async fn respond_create_plan_rejected(rpc: &AcpRpc, request_id: &Value) -> Result<(), String> {
    rpc.respond(
        request_id,
        json!({
            "outcome": {
                "outcome": "rejected",
                "reason": "Headless client auto-rejected"
            }
        }),
    )
    .await
}

fn map_acp_notification(line: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line).ok()?;
    let method = v.get("method").and_then(|m| m.as_str())?;
    if method != "session/update" {
        return None;
    }

    let update = v.pointer("/params/update")?;
    let session_update = update
        .get("sessionUpdate")
        .or_else(|| update.get("type"))
        .and_then(|t| t.as_str())
        .unwrap_or("");

    if session_update == "agent_message_chunk" {
        let text = update
            .pointer("/content/text")
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if text.is_empty() {
            return None;
        }
        return Some(
            json!({
                "type": "assistant",
                "message": { "content": [{ "type": "text", "text": text }] }
            })
            .to_string(),
        );
    }

    if session_update.contains("tool") {
        return stream_adapter::adapt_cursor_line(
            &json!({
                "type": "tool_call",
                "id": update.get("id").and_then(|i| i.as_str()).unwrap_or("acp_tool"),
                "tool": update.get("tool").and_then(|t| t.as_str()).unwrap_or("Tool"),
                "input": update.get("input").cloned().unwrap_or(json!({})),
            })
            .to_string(),
        );
    }

    None
}

async fn handle_inbound_line(
    line: &str,
    rpc: &AcpRpc,
    window: &WebviewWindow,
    tab_id: &str,
    session_ok: &mut bool,
) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };

    if let Some(id) = rpc_id_from_value(&v) {
        if v.get("error").is_some() {
            let err = v
                .pointer("/error/message")
                .and_then(|m| m.as_str())
                .unwrap_or("ACP RPC error");
            *session_ok = false;
            resolve_pending(&rpc.pending, id, Err(err.to_string()));
            return;
        }
        if v.get("result").is_some() {
            resolve_pending(
                &rpc.pending,
                id,
                Ok(v.get("result").cloned().unwrap_or(Value::Null)),
            );
            return;
        }
    }

    let Some(method) = v.get("method").and_then(|m| m.as_str()) else {
        return;
    };

    match method {
        "session/request_permission" => {
            if let Some(request_id) = v.get("id") {
                let _ = respond_permission(rpc, request_id).await;
            }
        }
        "cursor/ask_question" => {
            if let Some(request_id) = v.get("id") {
                let _ = respond_ask_question_skipped(rpc, request_id).await;
            }
        }
        "cursor/create_plan" => {
            if let Some(request_id) = v.get("id") {
                let _ = respond_create_plan_rejected(rpc, request_id).await;
            }
        }
        "session/update" => {
            if let Some(adapted) = map_acp_notification(line) {
                emit_output(window, tab_id, adapted);
            }
        }
        _ => {
            if let Some(adapted) = stream_adapter::adapt_cursor_line(line) {
                emit_output(window, tab_id, adapted);
            }
        }
    }
}

async fn handshake(
    rpc: &AcpRpc,
    project_path: &str,
    resume_session_id: Option<&str>,
) -> Result<String, String> {
    rpc.request(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "terminal": false
            },
            "clientInfo": { "name": "devprism-acp-client", "version": "1.0.0" }
        }),
    )
    .await?;

    rpc.request("authenticate", json!({ "methodId": "cursor_login" }))
        .await?;

    if let Some(sid) = resume_session_id {
        rpc.request("session/load", json!({ "sessionId": sid }))
            .await?;
        return Ok(sid.to_string());
    }

    let result = rpc
        .request(
            "session/new",
            json!({
                "cwd": project_path,
                "mcpServers": []
            }),
        )
        .await?;
    result
        .get("sessionId")
        .and_then(|s| s.as_str())
        .map(str::to_string)
        .ok_or_else(|| "ACP session/new did not return sessionId".to_string())
}

pub async fn run_acp_session(
    window: WebviewWindow,
    project_path: &str,
    prompt: &str,
    tab_id: &str,
    resume_session_id: Option<&str>,
) -> Result<(), String> {
    let agent_path = find_agent_binary()?;
    let mut cmd = Command::new(&agent_path);
    cmd.arg("acp");
    cmd.current_dir(project_path);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if let Some(key) = stored_cursor_api_key() {
        cmd.env("CURSOR_API_KEY", key);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn agent acp: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open ACP stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open ACP stdout".to_string())?;
    let stderr = child.stderr.take();

    let rpc = Arc::new(AcpRpc::new(stdin));

    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    eprintln!("[cursor-acp stderr] {line}");
                }
            }
        });
    }

    let win = window.clone();
    let tab = tab_id.to_string();
    let rpc_reader = Arc::clone(&rpc);
    let reader_session_ok = Arc::new(Mutex::new(true));
    let reader_session_ok_clone = Arc::clone(&reader_session_ok);

    let reader_task = {
        let rpc = Arc::clone(&rpc_reader);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut ok = reader_session_ok_clone.lock().map(|g| *g).unwrap_or(false);
                handle_inbound_line(&line, &rpc, &win, &tab, &mut ok).await;
                if let Ok(mut guard) = reader_session_ok_clone.lock() {
                    *guard = ok;
                }
            }
        })
    };

    let session_id = match handshake(&rpc, project_path, resume_session_id).await {
        Ok(id) => id,
        Err(e) => {
            rpc.close_stdin().await;
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), reader_task).await;
            let _ = child.kill().await;
            return Err(e);
        }
    };

    emit_output(
        &window,
        tab_id,
        json!({
            "type": "system",
            "subtype": "init",
            "session_id": session_id,
            "provider": "cursor",
        })
        .to_string(),
    );

    {
        let mut sessions = acp_sessions().lock().map_err(|_| "ACP lock poisoned")?;
        sessions.insert(
            tab_id.to_string(),
            AcpSession {
                child,
                session_id: Some(session_id.clone()),
            },
        );
    }

    let prompt_result = rpc
        .request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": prompt }]
            }),
        )
        .await;

    rpc.close_stdin().await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), reader_task).await;

    let exit_status = {
        let mut child = acp_sessions()
            .lock()
            .ok()
            .and_then(|mut s| s.remove(tab_id).map(|sess| sess.child));
        match child.as_mut() {
            Some(c) => c.wait().await.ok(),
            None => None,
        }
    };

    let mut session_ok =
        reader_session_ok.lock().map(|g| *g).unwrap_or(false) && prompt_result.is_ok();

    if let Err(e) = &prompt_result {
        emit_output(
            &window,
            tab_id,
            json!({
                "type": "result",
                "subtype": "error",
                "is_error": true,
                "result": format!("ACP prompt failed: {e}"),
            })
            .to_string(),
        );
        session_ok = false;
    }

    if let Some(status) = exit_status {
        if !status.success() {
            session_ok = false;
        }
    }

    emit_complete(&window, tab_id, session_ok);

    prompt_result.map(|_| ())
}

pub async fn cancel_acp_session(tab_id: &str) -> Result<bool, String> {
    let mut child = {
        let mut sessions = acp_sessions().lock().map_err(|_| "ACP lock poisoned")?;
        sessions.remove(tab_id).map(|s| s.child)
    };
    if let Some(ref mut c) = child {
        let _ = c.kill().await;
        return Ok(true);
    }
    Ok(false)
}

/// Kill all tracked ACP child processes (e.g. on window destroy).
pub async fn cleanup_all_acp_sessions() {
    let children: Vec<Child> = acp_sessions()
        .lock()
        .ok()
        .map(|mut s| s.drain().map(|(_, sess)| sess.child).collect())
        .unwrap_or_default();
    for mut child in children {
        let _ = child.kill().await;
    }
}
