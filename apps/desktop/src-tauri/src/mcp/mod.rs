//! Model Context Protocol (MCP 2.0) Stateless Implementation.
//!
//! Exposes a full 2026-07-28 stateless core, HTTP standard routing (SEP-2243),
//! MRTR stateless elicitations (SEP-2322), and Tasks extension (SEP-2663)
//! across Career Knowledgebase and Resume Synthesis pipelines.

pub mod protocol;
pub mod server;
pub mod tasks;
pub mod tools_career;
pub mod tools_resume;
pub mod transport_http;
pub mod transport_stdio;

#[cfg(test)]
mod tests;

use crate::career_db::CareerDbState;
use protocol::{HttpHeaders, JsonRpcRequest, JsonRpcResponse, ResourceDefinition, ToolDefinition};
use server::StatelessMcpServer;
use std::collections::HashMap;
use std::sync::Arc;
use tasks::TaskRecord;

#[derive(Clone)]
pub struct McpServerState {
    pub server: Arc<StatelessMcpServer>,
}

impl McpServerState {
    pub fn new(career_db: CareerDbState) -> Self {
        Self {
            server: Arc::new(StatelessMcpServer::new(career_db)),
        }
    }
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn mcp_execute_request(
    state: tauri::State<'_, McpServerState>,
    request: JsonRpcRequest,
    headers: Option<HashMap<String, String>>,
) -> Result<JsonRpcResponse, String> {
    let http_headers = headers.as_ref().map(HttpHeaders::from_map);
    let resp = state
        .server
        .handle_request(http_headers.as_ref(), request)
        .await;
    Ok(resp)
}

#[tauri::command]
pub async fn mcp_list_tools(
    state: tauri::State<'_, McpServerState>,
) -> Result<Vec<ToolDefinition>, String> {
    Ok(state.server.list_all_tools())
}

#[tauri::command]
pub async fn mcp_list_resources(
    state: tauri::State<'_, McpServerState>,
) -> Result<Vec<ResourceDefinition>, String> {
    Ok(state.server.list_all_resources())
}

#[tauri::command]
pub async fn mcp_get_task_status(
    state: tauri::State<'_, McpServerState>,
    task_id: String,
) -> Result<Option<TaskRecord>, String> {
    Ok(state.server.task_manager.get_task(&task_id))
}

#[tauri::command]
pub async fn mcp_cancel_task(
    state: tauri::State<'_, McpServerState>,
    task_id: String,
) -> Result<bool, String> {
    Ok(state.server.task_manager.cancel_task(&task_id))
}
