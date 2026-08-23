//! Pack: resume synthesis (`resume_*` analysis/synthesis tools and prompts).
//!
//! Wraps the pre-plugin implementation in `crate::mcp::tools_resume` without
//! moving any behaviour. The document-editing pack lives in
//! `resume_documents`; this pack stays read-only over the knowledgebase.

use super::{BoxedToolFuture, CapabilityPlugin, PluginContext};
use crate::mcp::protocol::{PromptDefinition, ToolDefinition};
use serde_json::Value;
use std::collections::HashMap;

pub struct ResumeSynthesisPlugin;

impl CapabilityPlugin for ResumeSynthesisPlugin {
    fn id(&self) -> &'static str {
        "resume-synthesis"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "JD analysis, block scoring/selection, verified bullet rewrites, synthesis and Typst compilation."
    }

    fn tools(&self) -> Vec<ToolDefinition> {
        crate::mcp::tools_resume::list_resume_tools()
    }

    fn prompts(&self) -> Vec<PromptDefinition> {
        crate::mcp::tools_resume::list_resume_prompts()
    }

    fn call_tool<'a>(
        &'a self,
        ctx: &'a PluginContext,
        name: &'a str,
        args: &'a Value,
    ) -> BoxedToolFuture<'a> {
        Box::pin(async move {
            crate::mcp::tools_resume::execute_resume_tool(
                &ctx.career_db,
                &ctx.task_manager,
                name,
                args,
            )
            .await
        })
    }

    fn get_prompt<'a>(
        &'a self,
        _ctx: &'a PluginContext,
        name: &'a str,
        args: &'a HashMap<String, String>,
    ) -> BoxedToolFuture<'a> {
        Box::pin(async move { crate::mcp::tools_resume::get_resume_prompt(name, args) })
    }

    fn native_agent_tools(&self) -> &'static [&'static str] {
        // The pre-Plugins set plus `resume_ats_check` (deterministic, cheap,
        // and useful for the agent's document audits).
        &[
            "resume_gap_analysis",
            "resume_synthesize",
            "resume_compile",
            "resume_ats_check",
        ]
    }
}
