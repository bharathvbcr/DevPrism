use crate::agent::knowledge::ProjectState;
use crate::agent::tools::Tool;
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct CrossReferenceProjectTool {
    pub project_state: ProjectState,
}

impl CrossReferenceProjectTool {
    pub fn new(project_state: ProjectState) -> Self {
        Self { project_state }
    }
}

#[async_trait]
impl Tool for CrossReferenceProjectTool {
    fn name(&self) -> &str {
        "cross_reference_project"
    }

    fn description(&self) -> &str {
        "Pulls context from a linked project by its name to use as evidence for resume generation or cross-project reuse."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_name": {
                    "type": "string",
                    "description": "The name of the linked project."
                }
            },
            "required": ["project_name"]
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let project_name = input["project_name"]
            .as_str()
            .ok_or("Parameter 'project_name' is required")?;

        let projects = self.project_state.list_projects().await;
        let project = projects
            .into_iter()
            .find(|p| p.name == project_name)
            .ok_or_else(|| format!("Project '{}' not found", project_name))?;

        Ok(json!({
            "id": project.id.to_string(),
            "name": project.name,
            "path": project.path,
            "tech_stack": project.tech_stack,
            "tags": project.tags,
            "role": project.role,
            "start_date": project.start_date,
            "end_date": project.end_date,
            "description": project.description,
            "notes": project.notes,
        }))
    }
}

pub struct ListLinkedProjectsTool {
    pub project_state: ProjectState,
}

impl ListLinkedProjectsTool {
    pub fn new(project_state: ProjectState) -> Self {
        Self { project_state }
    }
}

#[async_trait]
impl Tool for ListLinkedProjectsTool {
    fn name(&self) -> &str {
        "list_linked_projects"
    }

    fn description(&self) -> &str {
        "Lists all projects linked to DevCouncil, including their names and tech stacks."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {}
        })
    }

    async fn call(&self, _input: Value) -> Result<Value, String> {
        let projects = self.project_state.list_projects().await;
        Ok(json!({
            "projects": projects.into_iter().map(|p| json!({
                "name": p.name,
                "tech_stack": p.tech_stack,
                "tags": p.tags,
                "role": p.role,
                "description": p.description,
                "notes": p.notes,
            })).collect::<Vec<_>>()
        }))
    }
}

pub struct GetPersonalBioTool;

#[async_trait]
impl Tool for GetPersonalBioTool {
    fn name(&self) -> &str {
        "get_personal_bio"
    }

    fn description(&self) -> &str {
        "Retrieves the user's personal bio (Education, Experience, Skills) from settings."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {}
        })
    }

    async fn call(&self, _input: Value) -> Result<Value, String> {
        let settings = read_resume_knowledge()?;
        let bio = settings
            .get("personalBio")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        Ok(json!({ "bio": bio }))
    }
}

pub struct GetResumeProfileTool;

#[async_trait]
impl Tool for GetResumeProfileTool {
    fn name(&self) -> &str {
        "get_resume_profile"
    }

    fn description(&self) -> &str {
        "Retrieves structured resume target profile settings, including role target, keywords, tone, contact, and education."
    }

    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    async fn call(&self, _input: Value) -> Result<Value, String> {
        let settings = read_resume_knowledge()?;
        Ok(json!({
            "resumeProfile": settings.get("resumeProfile").cloned().unwrap_or_else(|| json!({})),
            "personalBio": settings.get("personalBio").cloned().unwrap_or_else(|| json!("")),
        }))
    }
}

pub struct GetManualExperienceTool;

#[async_trait]
impl Tool for GetManualExperienceTool {
    fn name(&self) -> &str {
        "get_manual_experience"
    }

    fn description(&self) -> &str {
        "Retrieves manually entered resume experience and evidence entries from the user's local knowledgebase settings."
    }

    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    async fn call(&self, _input: Value) -> Result<Value, String> {
        let settings = read_resume_knowledge()?;
        Ok(json!({
            "manualExperience": settings.get("manualExperience").cloned().unwrap_or_else(|| json!("")),
            "evidenceEntries": settings.get("evidenceEntries").cloned().unwrap_or_else(|| json!("")),
        }))
    }
}

pub struct GenerateResumeBulletsTool {
    pub project_state: ProjectState,
}

impl GenerateResumeBulletsTool {
    pub fn new(project_state: ProjectState) -> Self {
        Self { project_state }
    }
}

#[async_trait]
impl Tool for GenerateResumeBulletsTool {
    fn name(&self) -> &str {
        "generate_resume_bullets"
    }

    fn description(&self) -> &str {
        "Generates draft resume bullets from manual experience, evidence entries, and linked project metadata with explicit evidence citations."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_name": {
                    "type": "string",
                    "description": "Optional linked project name to focus bullets on."
                },
                "max_bullets": {
                    "type": "number",
                    "description": "Maximum number of bullets to return. Defaults to 8."
                }
            }
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let requested_project = input.get("project_name").and_then(|v| v.as_str());
        let max_bullets = input
            .get("max_bullets")
            .and_then(|v| v.as_u64())
            .unwrap_or(8)
            .clamp(1, 20) as usize;

        let knowledge = read_resume_knowledge()?;
        let mut bullets = Vec::new();

        for (idx, line) in split_evidence_lines(
            knowledge
                .get("manualExperience")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        )
        .into_iter()
        .enumerate()
        {
            bullets.push(json!({
                "bullet": format_resume_bullet(&line),
                "citations": [format!("manual_experience:{}", idx + 1)],
                "source": "manual_experience"
            }));
            if bullets.len() >= max_bullets {
                return Ok(json!({ "bullets": bullets }));
            }
        }

        for (idx, line) in split_evidence_lines(
            knowledge
                .get("evidenceEntries")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        )
        .into_iter()
        .enumerate()
        {
            bullets.push(json!({
                "bullet": format_resume_bullet(&line),
                "citations": [format!("evidence_entry:{}", idx + 1)],
                "source": "evidence_entry"
            }));
            if bullets.len() >= max_bullets {
                return Ok(json!({ "bullets": bullets }));
            }
        }

        let mut projects = self.project_state.list_projects().await;
        if let Some(project_name) = requested_project {
            projects.retain(|p| p.name == project_name);
        }
        for project in projects {
            let stack = if project.tech_stack.is_empty() {
                "the project's stack".to_string()
            } else {
                project.tech_stack.join(", ")
            };
            let evidence = first_non_empty([
                project.notes.as_deref(),
                project.description.as_deref(),
                project.role.as_deref(),
            ])
            .unwrap_or("Delivered project work with traceable implementation evidence.");
            bullets.push(json!({
                "bullet": format!("Delivered {} using {}, with evidence: {}", project.name, stack, evidence),
                "citations": [format!("linked_project:{}", project.name)],
                "source": "linked_project",
                "project": project.name,
            }));
            if bullets.len() >= max_bullets {
                break;
            }
        }

        Ok(json!({ "bullets": bullets }))
    }
}

fn read_resume_knowledge() -> Result<Value, String> {
    let mut settings = read_devcouncil_settings()?;
    let db_value =
        crate::agent::knowledge::cache::get_resume_knowledge().unwrap_or_else(|_| json!({}));

    if !settings.is_object() {
        settings = json!({});
    }
    if let Some(obj) = settings.as_object_mut() {
        for key in [
            "personalBio",
            "resumeProfile",
            "manualExperience",
            "evidenceEntries",
        ] {
            let settings_empty = obj
                .get(key)
                .and_then(|v| v.as_str())
                .map(|value| value.trim().is_empty())
                .unwrap_or(true);
            if settings_empty {
                if let Some(value) = db_value.get(key) {
                    obj.insert(key.to_string(), value.clone());
                }
            }
        }
    }
    Ok(settings)
}

fn read_devcouncil_settings() -> Result<Value, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let path = home.join(".devcouncil").join("settings.json");
    if !path.exists() {
        return Ok(json!({}));
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))?;
    Ok(serde_json::from_str(&content).unwrap_or_else(|_| json!({})))
}

fn split_evidence_lines(value: &str) -> Vec<String> {
    value
        .lines()
        .map(|line| line.trim().trim_start_matches(['-', '*', ' ']))
        .filter(|line| !line.is_empty())
        .take(20)
        .map(|line| line.chars().take(320).collect::<String>())
        .collect()
}

fn format_resume_bullet(evidence: &str) -> String {
    let trimmed = evidence.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        return String::new();
    }
    let starts_with_action = trimmed
        .split_whitespace()
        .next()
        .map(|word| {
            matches!(
                word.to_ascii_lowercase().as_str(),
                "built"
                    | "created"
                    | "designed"
                    | "implemented"
                    | "led"
                    | "launched"
                    | "optimized"
                    | "reduced"
                    | "improved"
                    | "delivered"
                    | "migrated"
                    | "secured"
                    | "automated"
            )
        })
        .unwrap_or(false);
    if starts_with_action {
        format!("{}.", trimmed)
    } else {
        format!("Delivered impact by {}.", trimmed)
    }
}

fn first_non_empty<'a>(values: [Option<&'a str>; 3]) -> Option<&'a str> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
}

#[allow(dead_code)]
pub fn get_resume_prompt(_personal_bio: &str) -> String {
    "You are an expert Resume Writer and Career Coach.\n\
    Your goal is to draft an evidence-based resume.\n\n\
    Steps:\n\
    1. Call 'get_personal_bio' to understand the user's background.\n\
    2. Call 'get_resume_profile' and 'get_manual_experience' to load target role and manual evidence.\n\
    3. Call 'list_linked_projects' (via the available tools) to see what projects are linked.\n\
    3. Use 'cross_reference_project' to get details for relevant projects.\n\
    4. Use 'git_insight', 'search_linked_project', 'compare_linked_projects', 'summarize_project_evidence', or 'generate_resume_bullets' to find concrete 'Proof of Work'.\n\
    5. Draft a high-impact, LaTeX-compatible resume with evidence-backed bullets.".to_string()
}
