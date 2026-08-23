//! Central Stateless MCP 2.0 Server Dispatcher.
//!
//! Features:
//! - Full 2026-07-28 stateless core (no session handshake or pinning).
//! - SEP-2243 standard HTTP header validation (`-32020` code on mismatch).
//! - SEP-2549 caching metadata injection (`ttlMs` and `cacheScope`).
//! - SEP-2322 MRTR stateless elicitation handling.
//! - SEP-2663 Tasks Extension (`tasks/get`, `tasks/cancel`, `tasks/list`).
//! - Plugins 1.0: tools/resources/prompts are served by capability packs from
//!   [`crate::plugins`]; dispatch is exact-name through the plugin registry
//!   rather than string-prefix matching against a hardcoded module list.

use crate::career_db::CareerDbState;
use crate::mcp::protocol::{
    HttpHeaders, JsonRpcError, JsonRpcRequest, JsonRpcResponse, MCP_PROTOCOL_VERSION,
};
use crate::plugins::{PluginContext, PluginRegistry};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct StatelessMcpServer {
    career_db: CareerDbState,
    pub task_manager: Arc<crate::mcp::tasks::TaskManager>,
    pub elicitations: Arc<crate::mcp::elicitation::ElicitationStore>,
    registry: Arc<PluginRegistry>,
}

impl StatelessMcpServer {
    pub fn new(career_db: CareerDbState) -> Self {
        let registry = crate::plugins::default_registry()
            .unwrap_or_else(|e| panic!("plugin registry failed to build: {e}"));
        Self {
            career_db,
            task_manager: Arc::new(crate::mcp::tasks::TaskManager::new()),
            elicitations: Arc::new(crate::mcp::elicitation::ElicitationStore::new()),
            registry: Arc::new(registry),
        }
    }

    fn context(&self) -> PluginContext {
        PluginContext {
            career_db: self.career_db.clone(),
            task_manager: Arc::clone(&self.task_manager),
            elicitations: Arc::clone(&self.elicitations),
        }
    }

    /// All tools across every registered pack.
    pub fn list_all_tools(&self) -> Vec<crate::mcp::protocol::ToolDefinition> {
        self.registry.list_all_tools()
    }

    /// All resources across every registered pack.
    pub fn list_all_resources(&self) -> Vec<crate::mcp::protocol::ResourceDefinition> {
        self.registry.list_all_resources()
    }

    /// Test/introspection access to the shared DB handle.
    #[cfg(test)]
    pub fn context_db(&self) -> &CareerDbState {
        &self.career_db
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
                let tools = self.registry.list_all_tools();
                Ok(json!({
                    "tools": tools,
                    "_meta": {
                        "ttlMs": 300000,
                        "cacheScope": "public",
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "plugins": self.registry.summary(),
                    }
                }))
            }

            "tools/call" => {
                let tool_name = params
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'name' parameter"))?;
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                self.registry
                    .execute_tool(&self.context(), tool_name, &arguments)
                    .await
            }

            // Resources
            "resources/list" => {
                let resources = self.registry.list_all_resources();
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
                self.registry.read_resource(&self.context(), uri).await
            }

            // Prompts
            "prompts/list" => {
                let prompts = self.registry.list_all_prompts();
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
                self.registry.get_prompt(&self.context(), prompt_name, &args_map).await
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

            // Notifications (JSON-RPC 2.0 §4.1). These carry no `id` and take no
            // reply; transports drop the result. Accepting them explicitly keeps
            // a client's `notifications/initialized` from being answered with
            // "method not found", which strict clients treat as fatal.
            m if m.starts_with("notifications/") => Ok(Value::Null),

            // Fallback for unrecognized method
            _ => Err(JsonRpcError::method_not_found(method)),
        }
    }
}
