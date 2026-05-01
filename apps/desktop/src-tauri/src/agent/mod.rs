pub mod cli;
pub mod knowledge;
pub mod providers;
pub mod redactor;
pub mod skills;
pub mod tools;

use crate::agent::providers::Provider;
use crate::agent::tools::ToolRegistry;
use colored::*;
use futures::StreamExt;
use indicatif::{ProgressBar, ProgressStyle};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};

pub struct ApprovalState {
    pub pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

impl Default for ApprovalState {
    fn default() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Message {
    pub role: String,
    pub content: Vec<Content>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum Content {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        tool_name: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Response {
    pub content: Vec<Content>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

pub struct Orchestrator {
    provider: Arc<dyn Provider>,
    tool_registry: ToolRegistry,
    history: Arc<Mutex<Vec<Message>>>,
    pub redact_secrets: bool,
    pub safe_mode: bool,
}

#[derive(Clone, Serialize)]
pub struct AgentOutputEvent {
    pub tab_id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
pub struct AgentCompleteEvent {
    pub tab_id: String,
    pub success: bool,
}

#[async_trait::async_trait]
pub trait AgentReporter: Send + Sync {
    fn report_output(&self, data: serde_json::Value);
    fn report_delta(&self, delta: String);
    fn report_complete(&self, success: bool);
    async fn request_approval(&self, action: &str) -> bool;
}

pub struct TauriReporter {
    pub app_handle: AppHandle,
    pub tab_id: String,
}

#[async_trait::async_trait]
impl AgentReporter for TauriReporter {
    fn report_output(&self, data: serde_json::Value) {
        let msg_type = if data.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
            "user"
        } else {
            "assistant"
        };

        let wrapped = serde_json::json!({
            "type": msg_type,
            "message": {
                "content": [data]
            }
        });
        let _ = self.app_handle.emit(
            "agent-output",
            AgentOutputEvent {
                tab_id: self.tab_id.clone(),
                data: wrapped.to_string(),
            },
        );
    }

    fn report_delta(&self, delta: String) {
        let _ = self.app_handle.emit(
            "agent-delta",
            serde_json::json!({
                "tab_id": self.tab_id,
                "delta": delta,
            }),
        );
    }

    fn report_complete(&self, success: bool) {
        let _ = self.app_handle.emit(
            "agent-complete",
            AgentCompleteEvent {
                tab_id: self.tab_id.clone(),
                success,
            },
        );
    }

    async fn request_approval(&self, action: &str) -> bool {
        let action_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        use tauri::Manager;
        let state = self.app_handle.state::<ApprovalState>();
        state.pending.lock().await.insert(action_id.clone(), tx);

        let _ = self.app_handle.emit(
            "agent-request-approval",
            serde_json::json!({
                "tab_id": self.tab_id,
                "action_id": action_id,
                "action": action
            }),
        );

        match timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(approved)) => approved,
            _ => {
                let state = self.app_handle.state::<ApprovalState>();
                state.pending.lock().await.remove(&action_id);
                false
            }
        }
    }
}

pub struct CliReporter {
    spinner: Arc<std::sync::Mutex<Option<ProgressBar>>>,
}

impl CliReporter {
    pub fn new() -> Self {
        Self {
            spinner: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    fn ensure_spinner(&self, msg: &str) {
        let mut spinner = self.spinner.lock().unwrap();
        if spinner.is_none() {
            let pb = ProgressBar::new_spinner();
            pb.set_style(
                ProgressStyle::default_spinner()
                    .tick_strings(&["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"])
                    .template("{spinner:.green} {msg}")
                    .unwrap(),
            );
            pb.set_message(msg.to_string());
            pb.enable_steady_tick(std::time::Duration::from_millis(100));
            *spinner = Some(pb);
        } else if let Some(pb) = spinner.as_ref() {
            pb.set_message(msg.to_string());
        }
    }

    fn clear_spinner(&self) {
        let mut spinner = self.spinner.lock().unwrap();
        if let Some(pb) = spinner.take() {
            pb.finish_and_clear();
        }
    }
}

#[async_trait::async_trait]
impl AgentReporter for CliReporter {
    fn report_output(&self, data: serde_json::Value) {
        self.clear_spinner();
        let output_type = data.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match output_type {
            "tool_use" => {
                let name = data
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown");
                println!(
                    "\n{}",
                    format!(" [Tool Use: {}] ", name).on_blue().white().bold()
                );
                self.ensure_spinner(&format!("Running {}...", name));
            }
            "tool_result" => {
                let name = data
                    .get("tool_name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown");
                let is_error = data
                    .get("is_error")
                    .and_then(|e| e.as_bool())
                    .unwrap_or(false);
                if is_error {
                    println!(
                        "{}",
                        format!(" [Tool Error: {}] ", name).on_red().white().bold()
                    );
                } else {
                    println!(
                        "{}",
                        format!(" [Tool Success: {}] ", name)
                            .on_green()
                            .white()
                            .bold()
                    );

                    // Highlight diff if present in edit_file result
                    if name == "edit_file" {
                        if let Some(diff) =
                            data.get("content").and_then(|c| c.as_str()).and_then(|s| {
                                // Extract diff from the tool result string if it was JSON-ified
                                let v: serde_json::Value =
                                    serde_json::from_str(s).unwrap_or(serde_json::Value::Null);
                                v.get("diff")
                                    .and_then(|d| d.as_str())
                                    .map(|d| d.to_string())
                            })
                        {
                            println!("\n{}", "--- Diff ---".bright_black());
                            for line in diff.lines() {
                                if line.starts_with('+') {
                                    println!("{}", line.green());
                                } else if line.starts_with('-') {
                                    println!("{}", line.red());
                                } else {
                                    println!("{}", line.bright_black());
                                }
                            }
                            println!("{}", "------------".bright_black());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn report_delta(&self, delta: String) {
        self.clear_spinner();
        print!("{}", delta);
        use std::io::Write;
        std::io::stdout().flush().unwrap_or(());
    }

    fn report_complete(&self, _success: bool) {
        self.clear_spinner();
        println!("\n{}", " [Task Complete] ".on_bright_black().white().bold());
    }

    async fn request_approval(&self, action: &str) -> bool {
        self.clear_spinner();
        println!("\n[Safe Mode] Requesting approval for: {}", action.yellow());

        let res = tokio::task::spawn_blocking(|| {
            let mut rl = rustyline::DefaultEditor::new().unwrap();
            let readline = rl.readline("Approve? [y/N]: ");
            match readline {
                Ok(line) => line.trim().to_lowercase() == "y",
                _ => false,
            }
        })
        .await
        .unwrap_or(false);

        if !res {
            println!("{} Execution denied.", "✗".red());
        }
        res
    }
}

pub struct AgentState {
    pub orchestrators: Arc<Mutex<HashMap<String, Arc<Orchestrator>>>>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            orchestrators: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Orchestrator {
    pub fn new(
        provider: Arc<dyn Provider>,
        project_state: crate::agent::knowledge::ProjectState,
    ) -> Self {
        let mut tool_registry = ToolRegistry::new(project_state.clone());
        tool_registry.add_tool(Box::new(
            crate::agent::skills::resume::CrossReferenceProjectTool::new(project_state.clone()),
        ));
        tool_registry.add_tool(Box::new(
            crate::agent::skills::resume::ListLinkedProjectsTool::new(project_state),
        ));
        tool_registry.add_tool(Box::new(crate::agent::skills::resume::GetPersonalBioTool));
        tool_registry.add_tool(Box::new(crate::agent::skills::resume::GetResumeProfileTool));
        tool_registry.add_tool(Box::new(
            crate::agent::skills::resume::GetManualExperienceTool,
        ));
        tool_registry.add_tool(Box::new(
            crate::agent::skills::resume::GenerateResumeBulletsTool::new(
                tool_registry.project_state.clone(),
            ),
        ));

        // Git tools
        tool_registry.add_tool(Box::new(crate::agent::skills::git::GitStatusTool));
        tool_registry.add_tool(Box::new(crate::agent::skills::git::GitBranchTool));
        tool_registry.add_tool(Box::new(crate::agent::skills::git::GitCommitTool));
        tool_registry.add_tool(Box::new(crate::agent::skills::git::GitPRTool));

        Self {
            provider,
            tool_registry,
            history: Arc::new(Mutex::new(Vec::new())),
            redact_secrets: true,
            safe_mode: true, // Default to true
        }
    }

    pub async fn run_task(
        &self,
        app_handle: tauri::AppHandle,
        tab_id: String,
        prompt: String,
    ) -> Result<(), String> {
        self.run_task_with_reporter(Arc::new(TauriReporter { app_handle, tab_id }), prompt)
            .await
    }

    pub async fn continue_task(
        &self,
        app_handle: tauri::AppHandle,
        tab_id: String,
        prompt: String,
    ) -> Result<(), String> {
        self.continue_task_with_reporter(Arc::new(TauriReporter { app_handle, tab_id }), prompt)
            .await
    }

    pub async fn run_task_with_reporter(
        &self,
        reporter: Arc<dyn AgentReporter>,
        prompt: String,
    ) -> Result<(), String> {
        {
            let mut history = self.history.lock().await;
            history.clear();

            history.push(Message {
                role: "user".to_string(),
                content: vec![Content::Text { text: prompt }],
            });
        }

        self.run_loop(reporter).await
    }

    pub async fn continue_task_with_reporter(
        &self,
        reporter: Arc<dyn AgentReporter>,
        prompt: String,
    ) -> Result<(), String> {
        {
            let mut history = self.history.lock().await;
            history.push(Message {
                role: "user".to_string(),
                content: vec![Content::Text { text: prompt }],
            });
        }

        self.run_loop(reporter).await
    }

    async fn run_loop(&self, reporter: Arc<dyn AgentReporter>) -> Result<(), String> {
        let mut turn = 0;
        let max_turns = 10;

        while turn < max_turns {
            turn += 1;

            let mut history = {
                let h = self.history.lock().await;
                h.clone()
            };

            // Apply redaction if enabled
            if self.redact_secrets {
                for msg in history.iter_mut() {
                    for content in msg.content.iter_mut() {
                        if let Content::Text { text } = content {
                            *text = redactor::Redactor::redact(text);
                        }
                    }
                }
            }

            let tool_defs = self.tool_registry.get_definitions();
            let mut stream = self.provider.chat_stream(history, Some(tool_defs));

            let mut tool_results = Vec::new();
            let mut assistant_content = Vec::new();

            while let Some(update) = stream.next().await {
                match update? {
                    crate::agent::providers::StreamUpdate::Delta(delta) => {
                        reporter.report_delta(delta);
                    }
                    crate::agent::providers::StreamUpdate::ToolUse(id, name, input) => {
                        reporter.report_output(serde_json::json!({
                            "type": "tool_use",
                            "id": id.clone(),
                            "name": name.clone(),
                            "input": input.clone()
                        }));

                        if self.safe_mode && (name == "run_command" || name == "edit_file") {
                            let action_str = format!(
                                "{} {}",
                                name,
                                serde_json::to_string(&input).unwrap_or_default()
                            );
                            if !reporter.request_approval(&action_str).await {
                                let msg = "User denied execution in Safe Mode.".to_string();
                                tool_results.push(Content::ToolResult {
                                    tool_use_id: id.clone(),
                                    tool_name: name.clone(),
                                    content: msg.clone(),
                                    is_error: true,
                                });

                                reporter.report_output(serde_json::json!({
                                    "type": "tool_result",
                                    "tool_use_id": id,
                                    "tool_name": name,
                                    "content": msg,
                                    "is_error": true
                                }));
                                continue;
                            }
                        }

                        match self.tool_registry.call(&name, input).await {
                            Ok(result) => {
                                let result_str = result.to_string();
                                tool_results.push(Content::ToolResult {
                                    tool_use_id: id.clone(),
                                    tool_name: name.clone(),
                                    content: result_str.clone(),
                                    is_error: false,
                                });

                                reporter.report_output(serde_json::json!({
                                    "type": "tool_result",
                                    "tool_use_id": id,
                                    "tool_name": name,
                                    "content": result_str,
                                    "is_error": false
                                }));
                            }
                            Err(e) => {
                                tool_results.push(Content::ToolResult {
                                    tool_use_id: id.clone(),
                                    tool_name: name.clone(),
                                    content: e.clone(),
                                    is_error: true,
                                });

                                reporter.report_output(serde_json::json!({
                                    "type": "tool_result",
                                    "tool_use_id": id,
                                    "tool_name": name,
                                    "content": e,
                                    "is_error": true
                                }));
                            }
                        }
                    }
                    crate::agent::providers::StreamUpdate::Complete(response) => {
                        assistant_content = response.content;
                    }
                }
            }

            {
                let mut h = self.history.lock().await;
                h.push(Message {
                    role: "assistant".to_string(),
                    content: assistant_content,
                });
            }

            if tool_results.is_empty() {
                break;
            }

            {
                let mut h = self.history.lock().await;
                h.push(Message {
                    role: "user".to_string(),
                    content: tool_results,
                });
            }
        }

        reporter.report_complete(true);

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::providers::StreamUpdate;
    use futures::stream;
    use std::pin::Pin;

    struct DummyProvider;

    #[async_trait::async_trait]
    impl Provider for DummyProvider {
        async fn chat(
            &self,
            _messages: Vec<Message>,
            _tools: Option<Vec<serde_json::Value>>,
        ) -> Result<Response, String> {
            Ok(Response {
                content: vec![Content::Text {
                    text: "ok".to_string(),
                }],
                usage: None,
            })
        }

        fn chat_stream(
            &self,
            _messages: Vec<Message>,
            _tools: Option<Vec<serde_json::Value>>,
        ) -> Pin<Box<dyn futures::Stream<Item = Result<StreamUpdate, String>> + Send>> {
            Box::pin(stream::empty())
        }

        fn name(&self) -> &str {
            "dummy"
        }
    }

    #[test]
    fn orchestrator_new_keeps_project_state_tools() {
        let project_state = crate::agent::knowledge::ProjectState::new();
        let orchestrator = Orchestrator::new(Arc::new(DummyProvider), project_state);

        assert!(orchestrator.tool_registry.tools.contains_key("read_file"));
        assert!(orchestrator
            .tool_registry
            .tools
            .contains_key("list_linked_projects"));
        assert!(orchestrator
            .tool_registry
            .tools
            .contains_key("compare_linked_projects"));
        assert!(orchestrator
            .tool_registry
            .tools
            .contains_key("generate_resume_bullets"));
    }
}
