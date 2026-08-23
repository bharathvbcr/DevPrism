//! Pack: career knowledgebase (`career_*` tools, resources).
//!
//! Wraps the pre-plugin implementation in `crate::mcp::tools_career` without
//! moving any behaviour: this file owns *registration and routing*, the tool
//! module remains the canonical owner of semantics.

use super::{BoxedToolFuture, CapabilityPlugin, PluginContext};
use crate::mcp::protocol::{ResourceDefinition, ToolDefinition};
use serde_json::Value;

pub struct CareerKnowledgebasePlugin;

impl CapabilityPlugin for CareerKnowledgebasePlugin {
    fn id(&self) -> &'static str {
        "career-knowledgebase"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "Career knowledgebase: experience blocks, verified facts, personas, KB search and ingest."
    }

    fn tools(&self) -> Vec<ToolDefinition> {
        crate::mcp::tools_career::list_career_tools()
    }

    fn resources(&self) -> Vec<ResourceDefinition> {
        crate::mcp::tools_career::list_career_resources()
    }

    fn call_tool<'a>(
        &'a self,
        ctx: &'a PluginContext,
        name: &'a str,
        args: &'a Value,
    ) -> BoxedToolFuture<'a> {
        Box::pin(async move {
            crate::mcp::tools_career::execute_career_tool(
                &ctx.career_db,
                &ctx.elicitations,
                name,
                args,
            )
            .await
        })
    }

    fn read_resource<'a>(&'a self, ctx: &'a PluginContext, uri: &'a str) -> BoxedToolFuture<'a> {
        Box::pin(async move {
            crate::mcp::tools_career::read_career_resource(&ctx.career_db, uri).await
        })
    }

    fn native_agent_tools(&self) -> &'static [&'static str] {
        // Exactly what the built-in agent advertised before Plugins 1.0.
        &["career_search_kb"]
    }
}
