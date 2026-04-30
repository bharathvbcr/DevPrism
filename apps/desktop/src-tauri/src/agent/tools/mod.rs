use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::process::Command;

pub mod env_insight;
pub mod git_insight;

use env_insight::EnvInsightTool;
use git_insight::GitInsightTool;

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> Value;
    async fn call(&self, input: Value) -> Result<Value, String>;
}

pub struct ReadFileTool;

#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }

    fn description(&self) -> &str {
        "Reads the full content of a file from the filesystem."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The absolute or relative path to the file."
                }
            },
            "required": ["path"]
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let path = input["path"]
            .as_str()
            .ok_or("Parameter 'path' is required")?;
        let content = fs::read_to_string(path).await.map_err(|e| e.to_string())?;
        Ok(json!({ "content": content }))
    }
}

pub struct EditFileTool;

#[async_trait]
impl Tool for EditFileTool {
    fn name(&self) -> &str {
        "edit_file"
    }

    fn description(&self) -> &str {
        "Replaces a string or matches a regex pattern in a file with new content."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The path to the file."
                },
                "old_string": {
                    "type": "string",
                    "description": "The literal string to replace."
                },
                "regex": {
                    "type": "string",
                    "description": "A regex pattern to match. Use this instead of old_string if you need pattern matching."
                },
                "new_string": {
                    "type": "string",
                    "description": "The replacement string."
                }
            },
            "required": ["path", "new_string"]
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let path = input["path"]
            .as_str()
            .ok_or("Parameter 'path' is required")?;
        let new_string = input["new_string"]
            .as_str()
            .ok_or("Parameter 'new_string' is required")?;

        let content = fs::read_to_string(path).await.map_err(|e| e.to_string())?;

        let new_content = if let Some(old_string) = input["old_string"].as_str() {
            if !content.contains(old_string) {
                return Err(format!("Literal string '{}' not found in file", old_string));
            }
            content.replace(old_string, new_string)
        } else if let Some(regex_pattern) = input["regex"].as_str() {
            let re = Regex::new(regex_pattern).map_err(|e| format!("Invalid regex: {}", e))?;
            if !re.is_match(&content) {
                return Err(format!(
                    "Regex pattern '{}' did not match any content in the file",
                    regex_pattern
                ));
            }
            re.replace_all(&content, new_string).to_string()
        } else {
            return Err("Either 'old_string' or 'regex' must be provided".to_string());
        };

        let diff = {
            use similar::{ChangeTag, TextDiff};
            let mut diff_str = String::new();
            let diff = TextDiff::from_lines(&content, &new_content);
            for change in diff.iter_all_changes() {
                let sign = match change.tag() {
                    ChangeTag::Delete => "-",
                    ChangeTag::Insert => "+",
                    ChangeTag::Equal => " ",
                };
                diff_str.push_str(&format!("{}{}", sign, change));
            }
            diff_str
        };

        fs::write(path, new_content)
            .await
            .map_err(|e| e.to_string())?;
        Ok(json!({ "status": "success", "diff": diff }))
    }
}

pub struct RunCommandTool;

#[async_trait]
impl Tool for RunCommandTool {
    fn name(&self) -> &str {
        "run_command"
    }

    fn description(&self) -> &str {
        "Executes a shell command and returns its output (stdout and stderr)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to run."
                },
                "cwd": {
                    "type": "string",
                    "description": "The directory to run the command in (optional)."
                }
            },
            "required": ["command"]
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let command_str = input["command"]
            .as_str()
            .ok_or("Parameter 'command' is required")?;
        let cwd = input["cwd"].as_str();

        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-Command", command_str]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", command_str]);
            c
        };

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        let output = cmd.output().await.map_err(|e| e.to_string())?;

        Ok(json!({
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr),
            "exit_code": output.status.code()
        }))
    }
}

pub struct ListFilesTool;

#[async_trait]
impl Tool for ListFilesTool {
    fn name(&self) -> &str {
        "list_files"
    }

    fn description(&self) -> &str {
        "Recursively lists all files in a directory, ignoring common build and git folders."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The directory path to list."
                },
                "recursive": {
                    "type": "boolean",
                    "description": "Whether to list files recursively (default: true)."
                }
            },
            "required": ["path"]
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let path = input["path"]
            .as_str()
            .ok_or("Parameter 'path' is required")?;
        let recursive = input["recursive"].as_bool().unwrap_or(true);

        let mut files = Vec::new();
        let mut stack = vec![PathBuf::from(path)];

        while let Some(current_path) = stack.pop() {
            if !current_path.exists() {
                continue;
            }
            let mut entries = fs::read_dir(&current_path)
                .await
                .map_err(|e| format!("Failed to read {}: {}", current_path.display(), e))?;

            while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
                let p = entry.path();
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");

                // Simple ignore list
                if name == ".git"
                    || name == "node_modules"
                    || name == "target"
                    || name == ".next"
                    || name == "dist"
                {
                    continue;
                }

                let file_type = entry.file_type().await.map_err(|e| e.to_string())?;
                if file_type.is_dir() {
                    if recursive {
                        stack.push(p);
                    }
                } else {
                    files.push(p.to_string_lossy().to_string());
                }
            }
        }

        Ok(json!({ "files": files }))
    }
}

pub struct SearchLinkedProjectTool {
    pub project_state: crate::agent::knowledge::ProjectState,
}

impl SearchLinkedProjectTool {
    pub fn new(project_state: crate::agent::knowledge::ProjectState) -> Self {
        Self { project_state }
    }
}

#[async_trait]
impl Tool for SearchLinkedProjectTool {
    fn name(&self) -> &str {
        "search_linked_project"
    }

    fn description(&self) -> &str {
        "Searches authorized linked project files for a text or regex pattern and returns matching file paths and line snippets."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_name": { "type": "string", "description": "Name of the linked project to search." },
                "query": { "type": "string", "description": "Literal text or regex pattern to search for." },
                "regex": { "type": "boolean", "description": "Treat query as regex. Defaults to false." },
                "max_results": { "type": "integer", "description": "Maximum matches to return. Defaults to 25." }
            },
            "required": ["project_name", "query"]
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let project_name = input["project_name"]
            .as_str()
            .ok_or("Parameter 'project_name' is required")?;
        let query = input["query"]
            .as_str()
            .ok_or("Parameter 'query' is required")?;
        let use_regex = input["regex"].as_bool().unwrap_or(false);
        let max_results = input["max_results"].as_u64().unwrap_or(25).min(100) as usize;

        let projects = self.project_state.list_projects().await;
        let project = projects
            .into_iter()
            .find(|p| p.name == project_name)
            .ok_or_else(|| format!("Project '{}' not found", project_name))?;

        let matcher = if use_regex {
            Some(Regex::new(query).map_err(|e| format!("Invalid regex: {}", e))?)
        } else {
            None
        };
        let query_lower = query.to_lowercase();
        let mut matches = Vec::new();
        let mut stack = vec![project.path.clone()];

        while let Some(current) = stack.pop() {
            if matches.len() >= max_results {
                break;
            }
            let mut entries = match fs::read_dir(&current).await {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
                if matches.len() >= max_results {
                    break;
                }
                let path = entry.path();
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if should_skip_path(name) {
                    continue;
                }
                let file_type = entry.file_type().await.map_err(|e| e.to_string())?;
                if file_type.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !looks_text_file(&path) {
                    continue;
                }
                let content = match fs::read_to_string(&path).await {
                    Ok(content) => content,
                    Err(_) => continue,
                };
                for (idx, line) in content.lines().enumerate() {
                    let hit = if let Some(re) = &matcher {
                        re.is_match(line)
                    } else {
                        line.to_lowercase().contains(&query_lower)
                    };
                    if hit {
                        matches.push(json!({
                            "path": path.to_string_lossy(),
                            "line": idx + 1,
                            "snippet": line.trim().chars().take(300).collect::<String>()
                        }));
                        if matches.len() >= max_results {
                            break;
                        }
                    }
                }
            }
        }

        Ok(json!({ "project": project.name, "matches": matches }))
    }
}

pub struct SummarizeProjectEvidenceTool {
    pub project_state: crate::agent::knowledge::ProjectState,
}

impl SummarizeProjectEvidenceTool {
    pub fn new(project_state: crate::agent::knowledge::ProjectState) -> Self {
        Self { project_state }
    }
}

#[async_trait]
impl Tool for SummarizeProjectEvidenceTool {
    fn name(&self) -> &str {
        "summarize_project_evidence"
    }

    fn description(&self) -> &str {
        "Returns resume-oriented metadata for linked projects, including role, tags, notes, and detected stack."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_name": { "type": "string", "description": "Optional linked project name. If omitted, summarize all projects." }
            }
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let requested = input.get("project_name").and_then(|v| v.as_str());
        let mut projects = self.project_state.list_projects().await;
        if let Some(name) = requested {
            projects.retain(|p| p.name == name);
        }
        Ok(json!({
            "projects": projects.into_iter().map(|p| json!({
                "id": p.id.to_string(),
                "name": p.name,
                "path": p.path,
                "tech_stack": p.tech_stack,
                "tags": p.tags,
                "role": p.role,
                "dates": { "start": p.start_date, "end": p.end_date },
                "description": p.description,
                "notes": p.notes,
                "last_analyzed": p.last_analyzed,
            })).collect::<Vec<_>>()
        }))
    }
}

pub struct CompareLinkedProjectsTool {
    pub project_state: crate::agent::knowledge::ProjectState,
}

impl CompareLinkedProjectsTool {
    pub fn new(project_state: crate::agent::knowledge::ProjectState) -> Self {
        Self { project_state }
    }
}

#[async_trait]
impl Tool for CompareLinkedProjectsTool {
    fn name(&self) -> &str {
        "compare_linked_projects"
    }

    fn description(&self) -> &str {
        "Compares linked projects to identify shared technologies, reusable patterns, differentiators, and evidence prompts."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_names": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional list of linked project names to compare. If omitted, compares all linked projects."
                },
                "focus": {
                    "type": "string",
                    "description": "Optional comparison focus such as architecture, testing, providers, resume, or security."
                }
            }
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let requested_names: BTreeSet<String> = input
            .get("project_names")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(|name| name.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let focus = input.get("focus").and_then(|v| v.as_str()).unwrap_or("");

        let mut projects = self.project_state.list_projects().await;
        if !requested_names.is_empty() {
            projects.retain(|project| requested_names.contains(&project.name));
        }
        projects.sort_by(|a, b| a.name.cmp(&b.name));

        if projects.is_empty() {
            return Ok(json!({
                "projects": [],
                "shared_tech_stack": [],
                "shared_tags": [],
                "reusable_patterns": [],
                "differentiators": [],
                "suggested_queries": [],
                "note": "No linked projects matched the comparison request."
            }));
        }

        let mut tech_counts: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut tag_counts: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for project in &projects {
            for tech in &project.tech_stack {
                tech_counts
                    .entry(tech.clone())
                    .or_default()
                    .push(project.name.clone());
            }
            for tag in &project.tags {
                tag_counts
                    .entry(tag.clone())
                    .or_default()
                    .push(project.name.clone());
            }
        }

        let shared_tech_stack = tech_counts
            .iter()
            .filter(|(_, names)| names.len() > 1)
            .map(|(tech, names)| json!({ "technology": tech, "projects": names }))
            .collect::<Vec<_>>();
        let shared_tags = tag_counts
            .iter()
            .filter(|(_, names)| names.len() > 1)
            .map(|(tag, names)| json!({ "tag": tag, "projects": names }))
            .collect::<Vec<_>>();

        let reusable_patterns = tech_counts
            .iter()
            .filter(|(_, names)| names.len() > 1)
            .map(|(tech, names)| {
                json!({
                    "pattern": format!("Reusable {} implementation pattern", tech),
                    "projects": names,
                    "evidence_hint": format!("Use search_linked_project for '{}' in each project to find concrete implementation evidence.", tech)
                })
            })
            .chain(tag_counts.iter().filter(|(_, names)| names.len() > 1).map(
                |(tag, names)| {
                    json!({
                        "pattern": format!("Reusable '{}' project theme", tag),
                        "projects": names,
                        "evidence_hint": format!("Use summarize_project_evidence and search_linked_project for '{}' to compare how this theme appears.", tag)
                    })
                },
            ))
            .collect::<Vec<_>>();

        let differentiators = projects
            .iter()
            .map(|project| {
                let unique_tech_stack = project
                    .tech_stack
                    .iter()
                    .filter(|tech| {
                        tech_counts.get(*tech).map(|names| names.len()).unwrap_or(0) == 1
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                let unique_tags = project
                    .tags
                    .iter()
                    .filter(|tag| tag_counts.get(*tag).map(|names| names.len()).unwrap_or(0) == 1)
                    .cloned()
                    .collect::<Vec<_>>();
                json!({
                    "project": project.name,
                    "path": project.path,
                    "role": project.role,
                    "unique_tech_stack": unique_tech_stack,
                    "unique_tags": unique_tags,
                    "evidence": first_project_note([
                        project.notes.as_deref(),
                        project.description.as_deref(),
                        project.role.as_deref(),
                    ]),
                })
            })
            .collect::<Vec<_>>();

        let suggested_queries = build_comparison_queries(&projects, focus);

        Ok(json!({
            "projects": projects.into_iter().map(|project| json!({
                "name": project.name,
                "path": project.path,
                "tech_stack": project.tech_stack,
                "tags": project.tags,
                "role": project.role,
                "dates": { "start": project.start_date, "end": project.end_date },
                "description": project.description,
                "notes": project.notes,
                "last_analyzed": project.last_analyzed,
            })).collect::<Vec<_>>(),
            "shared_tech_stack": shared_tech_stack,
            "shared_tags": shared_tags,
            "reusable_patterns": reusable_patterns,
            "differentiators": differentiators,
            "suggested_queries": suggested_queries,
        }))
    }
}

fn first_project_note(values: [Option<&str>; 3]) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(|value| value.chars().take(300).collect())
}

fn build_comparison_queries(
    projects: &[crate::agent::knowledge::LinkedProject],
    focus: &str,
) -> Vec<Value> {
    let mut terms = BTreeSet::new();
    let focus = focus.trim();
    if !focus.is_empty() {
        terms.insert(focus.to_string());
    }
    for project in projects {
        for tech in project.tech_stack.iter().take(4) {
            terms.insert(tech.clone());
        }
        for tag in project.tags.iter().take(4) {
            terms.insert(tag.clone());
        }
    }
    if terms.is_empty() {
        terms.insert("architecture".to_string());
        terms.insert("tests".to_string());
        terms.insert("provider".to_string());
    }

    terms
        .into_iter()
        .take(12)
        .map(|query| {
            json!({
                "query": query,
                "tool": "search_linked_project",
                "reason": "Run this query against each relevant linked project to collect concrete comparison evidence."
            })
        })
        .collect()
}

fn should_skip_path(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | ".next" | "dist" | "build" | ".venv"
    )
}

fn looks_text_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "rs" | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "json"
            | "md"
            | "txt"
            | "toml"
            | "yaml"
            | "yml"
            | "py"
            | "go"
            | "java"
            | "kt"
            | "c"
            | "cpp"
            | "h"
            | "hpp"
            | "html"
            | "css"
            | "scss"
            | "tex"
            | "bib"
            | "sty"
            | "sql"
            | "sh"
            | "ps1"
    )
}

pub struct ToolRegistry {
    pub tools: HashMap<String, Box<dyn Tool>>,
    pub project_state: crate::agent::knowledge::ProjectState,
}

impl ToolRegistry {
    pub fn new(project_state: crate::agent::knowledge::ProjectState) -> Self {
        let mut tools: HashMap<String, Box<dyn Tool>> = HashMap::new();
        tools.insert("read_file".to_string(), Box::new(ReadFileTool));
        tools.insert("edit_file".to_string(), Box::new(EditFileTool));
        tools.insert("run_command".to_string(), Box::new(RunCommandTool));
        tools.insert("list_files".to_string(), Box::new(ListFilesTool));
        tools.insert("git_insight".to_string(), Box::new(GitInsightTool));
        tools.insert("env_insight".to_string(), Box::new(EnvInsightTool));
        tools.insert(
            "search_linked_project".to_string(),
            Box::new(SearchLinkedProjectTool::new(project_state.clone())),
        );
        tools.insert(
            "summarize_project_evidence".to_string(),
            Box::new(SummarizeProjectEvidenceTool::new(project_state.clone())),
        );
        tools.insert(
            "compare_linked_projects".to_string(),
            Box::new(CompareLinkedProjectsTool::new(project_state.clone())),
        );
        Self {
            tools,
            project_state,
        }
    }

    pub fn add_tool(&mut self, tool: Box<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub async fn call(&self, name: &str, input: Value) -> Result<Value, String> {
        let mut input = input;
        // Permission check for filesystem tools
        if matches!(
            name,
            "read_file" | "edit_file" | "list_files" | "git_insight"
        ) {
            let path_str = input
                .get("path")
                .or_else(|| input.get("file_path"))
                .or_else(|| input.get("directory_path"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("Tool '{}' requires a path parameter", name))?
                .to_string();

            let target_path = self.resolve_tool_path(&path_str).await?;
            if !self.project_state.is_path_authorized(&target_path).await {
                return Err(format!(
                    "Permission denied: Path '{}' is not authorized. The user must explicitly link this project or grant access in Settings.",
                    path_str
                ));
            }
            if let Some(obj) = input.as_object_mut() {
                let resolved = target_path.to_string_lossy().to_string();
                for key in ["path", "file_path", "directory_path"] {
                    if obj.get(key).and_then(|v| v.as_str()) == Some(path_str.as_str()) {
                        obj.insert(key.to_string(), Value::String(resolved.clone()));
                    }
                }
            }
        }

        let tool = self
            .tools
            .get(name)
            .ok_or_else(|| format!("Tool '{}' not found", name))?;
        tool.call(input).await
    }

    async fn resolve_tool_path(&self, path_str: &str) -> Result<PathBuf, String> {
        let path = PathBuf::from(path_str);
        if path.is_absolute() {
            return Ok(path);
        }

        let roots = self.project_state.authorized_roots().await;
        for root in &roots {
            let candidate = root.join(&path);
            if candidate.exists() {
                return Ok(candidate);
            }
        }

        if roots.len() == 1 {
            return Ok(roots[0].join(path));
        }

        Err(format!(
            "Relative path '{}' is ambiguous. Use an absolute path or link/select a single project root.",
            path_str
        ))
    }

    pub fn get_definitions(&self) -> Vec<Value> {
        let mut defs: Vec<Value> = self
            .tools
            .values()
            .map(|t| {
                json!({
                    "name": t.name(),
                    "description": t.description(),
                    "parameters": t.parameters(),
                })
            })
            .collect();
        // Sort for deterministic output
        defs.sort_by(|a, b| {
            a["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b["name"].as_str().unwrap_or(""))
        });
        defs
    }
}
