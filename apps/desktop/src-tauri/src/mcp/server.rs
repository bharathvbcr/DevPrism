//! Central Stateless MCP 2.0 Server Dispatcher.
//!
//! Features:
//! - Full 2026-07-28 stateless core (no session handshake or pinning).
//! - SEP-2243 standard HTTP header validation (`-32020` code on mismatch).
//! - SEP-2549 caching metadata injection (`ttlMs` and `cacheScope`).
//! - SEP-2322 MRTR stateless elicitation handling.
//! - SEP-2663 Tasks Extension (`tasks/get`, `tasks/cancel`, `tasks/list`).

use crate::career_db::CareerDbState;
use crate::mcp::protocol::{
    HttpHeaders, JsonRpcError, JsonRpcRequest, JsonRpcResponse, PromptDefinition,
    ResourceDefinition, ToolDefinition, MCP_PROTOCOL_VERSION,
};
use crate::mcp::tasks::TaskManager;
use crate::mcp::tools_career::{
    execute_career_tool, list_career_resources, list_career_tools, read_career_resource,
};
use crate::mcp::tools_resume::{
    execute_resume_tool, get_resume_prompt, list_resume_prompts, list_resume_tools,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct StatelessMcpServer {
    pub career_db: CareerDbState,
    pub task_manager: Arc<TaskManager>,
}

impl StatelessMcpServer {
    pub fn new(career_db: CareerDbState) -> Self {
        Self {
            career_db,
            task_manager: Arc::new(TaskManager::new()),
        }
    }

    pub fn list_all_tools(&self) -> Vec<ToolDefinition> {
        let mut tools = list_career_tools();
        tools.extend(list_resume_tools());
        tools
    }

    pub fn list_all_resources(&self) -> Vec<ResourceDefinition> {
        list_career_resources()
    }

    pub fn list_all_prompts(&self) -> Vec<PromptDefinition> {
        list_resume_prompts()
    }

    /// Process a Stateless MCP 2.0 JSON-RPC request with optional HTTP headers.
    pub async fn handle_request(
        &self,
        headers: Option<&HttpHeaders>,
        request: JsonRpcRequest,
    ) -> JsonRpcResponse {
        let req_id = request.id.clone();
        match self.dispatch(headers, &request).await {
            Ok(val) => JsonRpcResponse::success(req_id, val),
            Err(err) => JsonRpcResponse::error(req_id, err),
        }
    }

    async fn dispatch(
        &self,
        headers: Option<&HttpHeaders>,
        request: &JsonRpcRequest,
    ) -> Result<Value, JsonRpcError> {
        // 1. Verify JSON-RPC version
        if request.jsonrpc != "2.0" {
            return Err(JsonRpcError::new(
                -32600,
                "Invalid JSON-RPC version; expected '2.0'",
            ));
        }

        // 2. Validate HTTP headers (SEP-2243)
        if let Some(h) = headers {
            h.validate_against_request(request)?;
        }

        // 3. Dispatch method
        let method = request.method.as_str();
        let params = request.params.clone().unwrap_or(Value::Null);

        match method {
            // Tools
            "tools/list" => {
                let tools = self.list_all_tools();
                Ok(json!({
                    "tools": tools,
                    "_meta": {
                        "ttlMs": 300000,
                        "cacheScope": "public",
                        "protocolVersion": MCP_PROTOCOL_VERSION
                    }
                }))
            }

            "tools/call" => {
                let tool_name = params
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'name' parameter"))?;
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

                if tool_name.starts_with("career_") {
                    execute_career_tool(&self.career_db, tool_name, &arguments).await
                } else if tool_name.starts_with("resume_") {
                    execute_resume_tool(&self.career_db, &self.task_manager, tool_name, &arguments).await
                } else {
                    Err(JsonRpcError::method_not_found(tool_name))
                }
            }

            // Resources
            "resources/list" => {
                let resources = self.list_all_resources();
                Ok(json!({
                    "resources": resources,
                    "_meta": {
                        "ttlMs": 60000,
                        "cacheScope": "user"
                    }
                }))
            }

            "resources/read" => {
                let uri = params
                    .get("uri")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'uri' parameter"))?;
                read_career_resource(&self.career_db, uri).await
            }

            // Prompts
            "prompts/list" => {
                let prompts = self.list_all_prompts();
                Ok(json!({
                    "prompts": prompts,
                    "_meta": {
                        "ttlMs": 300000,
                        "cacheScope": "public"
                    }
                }))
            }

            "prompts/get" => {
                let prompt_name = params
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'name' parameter"))?;
                let args_map = params
                    .get("arguments")
                    .and_then(|v| v.as_object())
                    .map(|obj| {
                        obj.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                            .collect::<HashMap<_, _>>()
                    })
                    .unwrap_or_default();
                get_resume_prompt(prompt_name, &args_map)
            }

            // Tasks Extension (SEP-2663)
            "tasks/get" => {
                let task_id = params
                    .get("taskId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'taskId' parameter"))?;

                let task = self
                    .task_manager
                    .get_task(task_id)
                    .ok_or_else(|| JsonRpcError::new(crate::mcp::protocol::ERR_TASK_FAILED, format!("Task '{task_id}' not found")))?;

                Ok(json!({
                    "task": task
                }))
            }

            "tasks/cancel" => {
                let task_id = params
                    .get("taskId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'taskId' parameter"))?;

                let cancelled = self.task_manager.cancel_task(task_id);
                Ok(json!({
                    "taskId": task_id,
                    "cancelled": cancelled
                }))
            }

            "tasks/list" => {
                let tasks = self.task_manager.list_tasks();
                Ok(json!({
                    "tasks": tasks,
                    "count": tasks.len()
                }))
            }

            // Fallback for unrecognized method
            _ => Err(JsonRpcError::method_not_found(method)),
        }
    }
}
