//! Project-scoped LaTeX compile for the MCP tool list.
//!
//! The project root comes from `DEVPRISM_PROJECT`, which the desktop host sets
//! on the MCP server process. The model does not choose the directory.
//! `resume_compile` still refuses inline `latex_source`; this tool calls the
//! subprocess compiler (`latex::agent_compile_project`) instead.

use std::path::{Path, PathBuf};

use super::{BoxedToolFuture, CapabilityPlugin, PluginContext};
use crate::mcp::protocol::{JsonRpcError, ToolDefinition};
use serde_json::{json, Value};

pub struct LatexCompilePlugin;

impl CapabilityPlugin for LatexCompilePlugin {
    fn id(&self) -> &'static str {
        "latex-compile"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "Compile the open project's LaTeX root with the desktop subprocess engine."
    }

    fn tools(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: "latex_compile".into(),
            description: "Compile a LaTeX root inside the open project and return structured errors. Defaults to main.tex. Pass use_texlive when the project needs TeX Live. The project directory is the host's open project, not an argument.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "main_file": {
                        "type": "string",
                        "description": "Project-relative TeX root. Defaults to main.tex."
                    },
                    "use_texlive": {
                        "type": "boolean",
                        "description": "Use TeX Live instead of the bundled Tectonic engine."
                    }
                }
            }),
            _meta: None,
        }]
    }

    fn call_tool<'a>(
        &'a self,
        _ctx: &'a PluginContext,
        name: &'a str,
        args: &'a Value,
    ) -> BoxedToolFuture<'a> {
        Box::pin(async move {
            if name != "latex_compile" {
                return Err(JsonRpcError::method_not_found(name));
            }
            let project = std::env::var("DEVPRISM_PROJECT").ok();
            let args = args.clone();
            match tokio::task::spawn_blocking(move || compile_latex_tool(project.as_deref(), &args))
                .await
            {
                Ok(result) => result,
                Err(err) => Err(JsonRpcError::internal_error(format!(
                    "LaTeX compile task failed: {err}"
                ))),
            }
        })
    }
}

pub fn compile_latex_tool(project_env: Option<&str>, args: &Value) -> Result<Value, JsonRpcError> {
    let project = project_root(project_env)?;
    let main_file = args
        .get("main_file")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("main.tex");
    if main_file.contains("..") || Path::new(main_file).is_absolute() {
        return Err(JsonRpcError::invalid_params(
            "main_file must be a project-relative path and must not contain '..'.",
        ));
    }
    let use_texlive = args
        .get("use_texlive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let result = crate::latex::agent_compile_project(&project, main_file, use_texlive);
    let summary = result.summary.clone();
    Ok(json!({
        "content": [{ "type": "text", "text": summary }],
        "isError": !result.success,
        "structuredContent": result,
    }))
}

fn project_root(raw: Option<&str>) -> Result<PathBuf, JsonRpcError> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(JsonRpcError::invalid_params(
            "DEVPRISM_PROJECT is not set, so LaTeX cannot be compiled for a project.",
        ));
    };
    if raw.contains("..") {
        return Err(JsonRpcError::invalid_params(
            "DEVPRISM_PROJECT must not contain '..'.",
        ));
    }
    let path = PathBuf::from(raw);
    if !path.is_dir() {
        return Err(JsonRpcError::invalid_params(format!(
            "DEVPRISM_PROJECT is not a directory: {raw}"
        )));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_project_is_a_refusal() {
        let err = compile_latex_tool(None, &json!({})).expect_err("unset");
        assert!(err.message.contains("DEVPRISM_PROJECT"));
    }

    #[test]
    fn dotdot_main_file_is_a_refusal() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let err = compile_latex_tool(
            Some(dir.path().to_str().unwrap_or("")),
            &json!({"main_file": "../secret.tex"}),
        )
        .expect_err("dotdot");
        assert!(err.message.contains(".."));
    }

    #[test]
    fn dotdot_project_is_a_refusal() {
        let err = compile_latex_tool(Some("/tmp/paper/../other"), &json!({})).expect_err("project");
        assert!(err.message.contains(".."));
    }
}
