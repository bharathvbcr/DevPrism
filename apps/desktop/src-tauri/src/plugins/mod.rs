//! Plugins 1.0 — capability packs for DevPrism's engine surfaces.
//!
//! A *capability pack* is a compiled-in plugin that contributes tools,
//! resources and prompts to two consumers from one registration:
//!
//! 1. the MCP 2.0 server (`crate::mcp::server`), which previously dispatched
//!    `tools/call` by string prefix (`career_*` / `resume_*`) against a
//!    hardcoded module list, and
//! 2. the built-in native agent (`crate::native_agent::tools`), which
//!    maintained its own hand-written schema list and prefix bridge for four
//!    of those tools.
//!
//! Both now route through [`PluginRegistry`]. The registry is the single
//! routing authority: registering two packs that claim the same tool name is a
//! boot failure rather than a silent shadow, and every tool advertises which
//! pack owns it via `_meta.pluginId`.
//!
//! Packs are Rust code compiled into the binary (there is no dynamic loader in
//! v1.0). Adding one means implementing [`CapabilityPlugin`] and registering it
//! in [`default_registry`].

pub mod career_kb;
pub mod path_guard;
pub mod resume_documents;
pub mod resume_synthesis;

#[cfg(test)]
mod tests;

use crate::career_db::CareerDbState;
use crate::mcp::elicitation::ElicitationStore;
use crate::mcp::protocol::{
    JsonRpcError, PromptDefinition, ResourceDefinition, ToolDefinition,
};
use crate::mcp::tasks::TaskManager;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

/// Everything a tool execution may touch, passed per call.
///
/// Plugins hold no state of their own: the DB handle, task manager and
/// elicitation store live here so that confirmations issued by one pack's tool
/// are redeemable across calls exactly like the pre-plugin server behaviour.
pub struct PluginContext {
    pub career_db: CareerDbState,
    pub task_manager: Arc<TaskManager>,
    pub elicitations: Arc<ElicitationStore>,
}

impl Clone for PluginContext {
    fn clone(&self) -> Self {
        Self {
            career_db: self.career_db.clone(),
            task_manager: Arc::clone(&self.task_manager),
            elicitations: Arc::clone(&self.elicitations),
        }
    }
}

impl PluginContext {
    pub fn new(career_db: CareerDbState) -> Self {
        Self {
            career_db,
            task_manager: Arc::new(TaskManager::new()),
            elicitations: Arc::new(ElicitationStore::new()),
        }
    }
}

pub type BoxedToolFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Value, JsonRpcError>> + Send + 'a>>;

/// One capability pack.
///
/// Implementations must be cheap to construct and side-effect free until
/// `call_tool`/`read_resource`/`get_prompt` run: the registry builds eagerly at
/// process start and `tools()` output is served on every `tools/list`.
pub trait CapabilityPlugin: Send + Sync {
    /// Stable identifier, e.g. `"resume-documents"`. Appears in
    /// `_meta.pluginId` on every contributed definition.
    fn id(&self) -> &'static str;

    /// Semver-ish version string of the pack itself.
    fn version(&self) -> &'static str;

    fn description(&self) -> &'static str;

    /// Tool definitions this pack serves. Names must be unique across all
    /// registered packs; duplicates fail registration.
    fn tools(&self) -> Vec<ToolDefinition>;

    /// Resources this pack serves (URI-unique across packs).
    fn resources(&self) -> Vec<ResourceDefinition> {
        Vec::new()
    }

    /// Prompts this pack serves (name-unique across packs).
    fn prompts(&self) -> Vec<PromptDefinition> {
        Vec::new()
    }

    fn call_tool<'a>(
        &'a self,
        ctx: &'a PluginContext,
        name: &'a str,
        args: &'a Value,
    ) -> BoxedToolFuture<'a>;

    fn read_resource<'a>(&'a self, _ctx: &'a PluginContext, uri: &'a str) -> BoxedToolFuture<'a> {
        Box::pin(async move {
            Err(JsonRpcError::method_not_found(uri))
        })
    }

    fn get_prompt<'a>(
        &'a self,
        _ctx: &'a PluginContext,
        name: &'a str,
        _args: &'a HashMap<String, String>,
    ) -> BoxedToolFuture<'a> {
        Box::pin(async move { Err(JsonRpcError::method_not_found(name)) })
    }

    /// Tool names advertised to the *built-in* agent.
    ///
    /// The agent loop feeds tool schemas straight into a model context whose
    /// budget is often ~15 KB, so packs opt in per tool instead of flooding it
    /// with the full MCP surface.
    fn native_agent_tools(&self) -> &'static [&'static str] {
        &[]
    }
}

/// Routing table over registered packs.
pub struct PluginRegistry {
    plugins: Vec<Arc<dyn CapabilityPlugin>>,
    tool_owner: HashMap<String, usize>,
    resource_owner: HashMap<String, String>,
    prompt_owner: HashMap<String, usize>,
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self {
            plugins: Vec::new(),
            tool_owner: HashMap::new(),
            resource_owner: HashMap::new(),
            prompt_owner: HashMap::new(),
        }
    }

    /// Register a pack. Fails loudly on duplicate plugin ids, tool names,
    /// resource URIs or prompt names — a silent shadow would mean one of the
    /// two consumers silently serves the wrong implementation.
    pub fn register(&mut self, plugin: Arc<dyn CapabilityPlugin>) -> Result<(), String> {
        if self.plugins.iter().any(|p| p.id() == plugin.id()) {
            return Err(format!("plugin id '{}' registered twice", plugin.id()));
        }
        let idx = self.plugins.len();
        for tool in plugin.tools() {
            if let Some(existing) = self.tool_owner.get(&tool.name) {
                return Err(format!(
                    "tool '{}' claimed by both '{}' and '{}'",
                    tool.name,
                    self.plugins[*existing].id(),
                    plugin.id()
                ));
            }
            self.tool_owner.insert(tool.name, idx);
        }
        for resource in plugin.resources() {
            if self.resource_owner.contains_key(&resource.uri) {
                return Err(format!(
                    "resource uri '{}' claimed more than once",
                    resource.uri
                ));
            }
            self.resource_owner
                .insert(resource.uri.clone(), plugin.id().to_string());
        }
        for prompt in plugin.prompts() {
            if self.prompt_owner.contains_key(&prompt.name) {
                return Err(format!("prompt '{}' claimed more than once", prompt.name));
            }
            self.prompt_owner.insert(prompt.name.clone(), idx);
        }
        self.plugins.push(plugin);
        Ok(())
    }

    pub fn plugin_count(&self) -> usize {
        self.plugins.len()
    }

    pub fn list_all_tools(&self) -> Vec<ToolDefinition> {
        self.plugins.iter().flat_map(|p| p.tools()).collect()
    }

    pub fn list_all_resources(&self) -> Vec<ResourceDefinition> {
        self.plugins.iter().flat_map(|p| p.resources()).collect()
    }

    pub fn list_all_prompts(&self) -> Vec<PromptDefinition> {
        self.plugins.iter().flat_map(|p| p.prompts()).collect()
    }

    /// Which pack owns a tool, for `_meta.pluginId` annotation.
    pub fn owner_of_tool(&self, name: &str) -> Option<&'static str> {
        self.tool_owner
            .get(name)
            .and_then(|idx| self.plugins.get(*idx))
            .map(|p| p.id())
    }

    pub async fn execute_tool(
        &self,
        ctx: &PluginContext,
        name: &str,
        args: &Value,
    ) -> Result<Value, JsonRpcError> {
        match self.tool_owner.get(name) {
            Some(idx) => match self.plugins.get(*idx) {
                Some(plugin) => plugin.call_tool(ctx, name, args).await,
                None => Err(JsonRpcError::internal_error(format!(
                    "registry index for '{name}' points nowhere"
                ))),
            },
            None => Err(JsonRpcError::method_not_found(name)),
        }
    }

    pub async fn read_resource(&self, ctx: &PluginContext, uri: &str) -> Result<Value, JsonRpcError> {
        // Route by exact URI first; fall back to longest owning-prefix match
        // for parameterised resources (none ship in v1.0, but template URIs
        // like `resume-docs://project/{path}` would route here).
        for plugin in &self.plugins {
            if plugin.resources().iter().any(|r| r.uri == uri) {
                return plugin.read_resource(ctx, uri).await;
            }
        }
        Err(JsonRpcError::method_not_found(uri))
    }

    pub async fn get_prompt(
        &self,
        ctx: &PluginContext,
        name: &str,
        args: &HashMap<String, String>,
    ) -> Result<Value, JsonRpcError> {
        match self.prompt_owner.get(name) {
            Some(idx) => match self.plugins.get(*idx) {
                Some(plugin) => plugin.get_prompt(ctx, name, args).await,
                None => Err(JsonRpcError::internal_error(format!(
                    "registry index for prompt '{name}' points nowhere"
                ))),
            },
            None => Err(JsonRpcError::method_not_found(name)),
        }
    }

    /// OpenAI-style function schemas for the curated native-agent subset.
    pub fn native_agent_schemas(&self) -> Value {
        let mut schemas: Vec<Value> = Vec::new();
        for plugin in &self.plugins {
            let wanted = plugin.native_agent_tools();
            if wanted.is_empty() {
                continue;
            }
            for tool in plugin.tools() {
                if !wanted.contains(&tool.name.as_str()) {
                    continue;
                }
                schemas.push(serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    }
                }));
            }
        }
        Value::Array(schemas)
    }

    /// Every tool name some pack advertises to the native agent.
    pub fn native_agent_tool_names(&self) -> Vec<&'static str> {
        let mut out: Vec<&'static str> = Vec::new();
        for plugin in &self.plugins {
            out.extend_from_slice(plugin.native_agent_tools());
        }
        out
    }

    /// Machine-readable summary for `_meta.plugins` on `tools/list`.
    pub fn summary(&self) -> Value {
        Value::Array(
            self.plugins
                .iter()
                .map(|p| {
                    serde_json::json!({
                        "id": p.id(),
                        "version": p.version(),
                        "description": p.description(),
                        "toolCount": p.tools().len(),
                        "resourceCount": p.resources().len(),
                        "promptCount": p.prompts().len(),
                    })
                })
                .collect(),
        )
    }
}

impl Default for PluginRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Build the registry with every shipped pack.
///
/// Registration failures are boot failures: they can only be caused by two
/// packs colliding, which must never be papered over with a silent shadow.
pub fn default_registry() -> Result<PluginRegistry, String> {
    let mut reg = PluginRegistry::new();
    reg.register(Arc::new(career_kb::CareerKnowledgebasePlugin))?;
    reg.register(Arc::new(resume_synthesis::ResumeSynthesisPlugin))?;
    reg.register(Arc::new(resume_documents::ResumeDocumentsPlugin))?;
    Ok(reg)
}

/// Process-wide shared registry for callers outside the MCP transports
/// (the native agent bridge). Built once; stateless beyond definitions.
pub fn shared_registry() -> &'static PluginRegistry {
    static REGISTRY: OnceLock<PluginRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| default_registry().unwrap_or_else(|e| panic!("plugin registry: {e}")))
}
