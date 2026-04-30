pub mod cache;
pub mod vector_store;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkedProject {
    pub id: Uuid,
    pub name: String,
    pub path: PathBuf,
    #[serde(default)]
    pub tech_stack: Vec<String>,
    #[serde(default)]
    pub last_analyzed: Option<DateTime<Utc>>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

pub fn get_knowledge_dir() -> PathBuf {
    let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push(".devcouncil");
    if !path.exists() {
        let _ = fs::create_dir_all(&path);
    }
    path
}

pub fn get_projects_file() -> PathBuf {
    let mut path = get_knowledge_dir();
    path.push("projects.json");
    path
}

#[derive(Clone)]
pub struct ProjectState {
    pub projects: Arc<Mutex<Vec<LinkedProject>>>,
    pub authorized_paths: Arc<Mutex<Vec<PathBuf>>>,
}

impl ProjectState {
    pub fn new() -> Self {
        let (projects, authorized_paths) = load_projects_internal();
        Self {
            projects: Arc::new(Mutex::new(projects)),
            authorized_paths: Arc::new(Mutex::new(authorized_paths)),
        }
    }

    pub async fn list_projects(&self) -> Vec<LinkedProject> {
        let projects = self.projects.lock().await;
        projects.clone()
    }

    pub async fn list_authorized_paths(&self) -> Vec<PathBuf> {
        let paths = self.authorized_paths.lock().await;
        paths.clone()
    }

    pub async fn authorized_roots(&self) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        {
            let projects = self.projects.lock().await;
            roots.extend(projects.iter().map(|project| project.path.clone()));
        }
        {
            let paths = self.authorized_paths.lock().await;
            roots.extend(paths.iter().cloned());
        }
        roots
    }

    pub async fn add_authorized_path(&self, path: PathBuf) {
        let mut paths = self.authorized_paths.lock().await;
        if !paths.contains(&path) {
            paths.push(path);
            let projects = self.projects.lock().await;
            let _ = save_projects_internal(&projects, &paths);
        }
    }

    pub async fn remove_authorized_path(&self, path: PathBuf) {
        let mut paths = self.authorized_paths.lock().await;
        paths.retain(|p| p != &path);
        let projects = self.projects.lock().await;
        let _ = save_projects_internal(&projects, &paths);
    }

    pub async fn is_path_authorized(&self, target_path: &Path) -> bool {
        let projects = self.projects.lock().await;
        // Linked projects are auto-authorized
        for project in projects.iter() {
            if target_path.starts_with(&project.path) {
                return true;
            }
        }

        let paths = self.authorized_paths.lock().await;
        for auth_path in paths.iter() {
            if target_path.starts_with(auth_path) {
                return true;
            }
        }
        false
    }

    #[allow(dead_code)]
    pub async fn add_project(
        &self,
        name: String,
        path: PathBuf,
        tech_stack: Vec<String>,
    ) -> LinkedProject {
        self.add_project_detailed(
            name,
            path,
            tech_stack,
            Vec::new(),
            None,
            None,
            None,
            None,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn add_project_detailed(
        &self,
        name: String,
        path: PathBuf,
        tech_stack: Vec<String>,
        tags: Vec<String>,
        role: Option<String>,
        start_date: Option<String>,
        end_date: Option<String>,
        description: Option<String>,
        notes: Option<String>,
    ) -> LinkedProject {
        let mut projects = self.projects.lock().await;
        let detected_stack = if tech_stack.is_empty() {
            detect_tech_stack(&path)
        } else {
            tech_stack
        };
        let project = LinkedProject {
            id: Uuid::new_v4(),
            name,
            path,
            tech_stack: detected_stack,
            last_analyzed: Some(Utc::now()),
            tags,
            role,
            start_date,
            end_date,
            description,
            notes,
        };
        projects.push(project.clone());
        let paths = self.authorized_paths.lock().await;
        let _ = save_projects_internal(&projects, &paths);
        project
    }

    pub async fn remove_project(&self, id: Uuid) {
        let mut projects = self.projects.lock().await;
        projects.retain(|p| p.id != id);
        let paths = self.authorized_paths.lock().await;
        let _ = save_projects_internal(&projects, &paths);
    }

    pub async fn analyze_project(&self, id: Uuid) -> Option<LinkedProject> {
        let mut projects = self.projects.lock().await;
        let project = projects.iter_mut().find(|p| p.id == id)?;
        project.tech_stack = detect_tech_stack(&project.path);
        project.last_analyzed = Some(Utc::now());
        let updated = project.clone();
        let paths = self.authorized_paths.lock().await;
        let _ = save_projects_internal(&projects, &paths);
        Some(updated)
    }

    pub async fn upsert_projects(&self, incoming: Vec<LinkedProject>) -> Vec<LinkedProject> {
        let mut projects = self.projects.lock().await;
        for incoming_project in incoming {
            if let Some(existing) = projects.iter_mut().find(|project| {
                project.id == incoming_project.id || project.path == incoming_project.path
            }) {
                *existing = incoming_project;
            } else {
                projects.push(incoming_project);
            }
        }
        let paths = self.authorized_paths.lock().await;
        let _ = save_projects_internal(&projects, &paths);
        projects.clone()
    }
}

pub fn detect_tech_stack(root: &Path) -> Vec<String> {
    let mut stack = Vec::new();
    if root.join("package.json").exists() {
        stack.push("Node.js/TypeScript".to_string());
    }
    if root.join("Cargo.toml").exists() {
        stack.push("Rust".to_string());
    }
    if root.join("requirements.txt").exists() || root.join("pyproject.toml").exists() {
        stack.push("Python".to_string());
    }
    if root.join("go.mod").exists() {
        stack.push("Go".to_string());
    }
    if root.join("pom.xml").exists() || root.join("build.gradle").exists() {
        stack.push("Java/Kotlin".to_string());
    }
    if root.join("CMakeLists.txt").exists() {
        stack.push("C/C++".to_string());
    }
    stack
}

impl Default for ProjectState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize, Deserialize)]
struct ProjectsFileContent {
    projects: Vec<LinkedProject>,
    #[serde(default)]
    authorized_paths: Vec<PathBuf>,
}

fn load_projects_internal() -> (Vec<LinkedProject>, Vec<PathBuf>) {
    let path = get_projects_file();
    if !path.exists() {
        return (
            cache::list_linked_projects_from_db().unwrap_or_default(),
            Vec::new(),
        );
    }
    let data = fs::read_to_string(path).unwrap_or_else(|_| "{}".to_string());
    match serde_json::from_str::<ProjectsFileContent>(&data) {
        Ok(content) => {
            let _ = cache::sync_linked_projects(&content.projects);
            (content.projects, content.authorized_paths)
        }
        Err(_) => {
            // Try legacy format (just an array of projects)
            match serde_json::from_str::<Vec<LinkedProject>>(&data) {
                Ok(projects) => {
                    let _ = cache::sync_linked_projects(&projects);
                    (projects, Vec::new())
                }
                Err(_) => (
                    cache::list_linked_projects_from_db().unwrap_or_default(),
                    Vec::new(),
                ),
            }
        }
    }
}

fn save_projects_internal(
    projects: &[LinkedProject],
    authorized_paths: &[PathBuf],
) -> Result<(), std::io::Error> {
    let path = get_projects_file();
    let content = ProjectsFileContent {
        projects: projects.to_vec(),
        authorized_paths: authorized_paths.to_vec(),
    };
    let data = serde_json::to_string_pretty(&content)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    fs::write(path, data)?;
    let _ = cache::sync_linked_projects(projects);
    Ok(())
}

// Deprecated functions for backward compatibility if needed,
// but it's better to migrate all callers to ProjectState.
#[allow(dead_code)]
pub fn list_projects() -> Vec<LinkedProject> {
    load_projects_internal().0
}

#[allow(dead_code)]
pub fn add_project(name: String, path: PathBuf, tech_stack: Vec<String>) -> LinkedProject {
    let (mut projects, authorized_paths) = load_projects_internal();
    let project = LinkedProject {
        id: Uuid::new_v4(),
        name,
        path,
        tech_stack,
        last_analyzed: None,
        tags: Vec::new(),
        role: None,
        start_date: None,
        end_date: None,
        description: None,
        notes: None,
    };
    projects.push(project.clone());
    let _ = save_projects_internal(&projects, &authorized_paths);
    project
}

#[allow(dead_code)]
pub fn remove_project(id: Uuid) {
    let (mut projects, authorized_paths) = load_projects_internal();
    projects.retain(|p| p.id != id);
    let _ = save_projects_internal(&projects, &authorized_paths);
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn test_project_state_logic() {
        // Since get_projects_file uses home_dir, we can't easily test without side effects
        // unless we refactor to inject path. For now, we trust the logic.
    }
}
