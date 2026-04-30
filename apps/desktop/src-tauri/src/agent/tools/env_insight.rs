use crate::agent::tools::Tool;
use async_trait::async_trait;
use serde_json::json;
use std::env;

pub struct EnvInsightTool;

#[async_trait]
impl Tool for EnvInsightTool {
    fn name(&self) -> &str {
        "env_insight"
    }

    fn description(&self) -> &str {
        "Collects information about the operating system, shell, and current project environment to provide context to the agent."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {}
        })
    }

    async fn call(&self, _input: serde_json::Value) -> Result<serde_json::Value, String> {
        let os = env::consts::OS;
        let arch = env::consts::ARCH;
        let shell = env::var("SHELL")
            .unwrap_or_else(|_| env::var("COMSPEC").unwrap_or_else(|_| "unknown".to_string()));
        let cwd = env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string());

        Ok(json!({
            "os": os,
            "arch": arch,
            "shell": shell,
            "cwd": cwd,
            "env_vars": {
                "LANG": env::var("LANG").ok(),
                "TERM": env::var("TERM").ok(),
            }
        }))
    }
}
