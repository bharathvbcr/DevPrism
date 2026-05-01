use crate::agent::tools::Tool;
use async_trait::async_trait;
use git2::{BranchType, IndexAddOption, Repository, Signature};
use serde_json::{json, Value};
use std::path::Path;

pub struct GitStatusTool;

#[async_trait]
impl Tool for GitStatusTool {
    fn name(&self) -> &str {
        "git_status"
    }

    fn description(&self) -> &str {
        "Shows the working tree status (modified, staged, untracked files)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the Git repository."
                }
            },
            "required": ["path"]
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let repo_path = input["path"]
            .as_str()
            .ok_or("Parameter 'path' is required")?;
        let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;

        let mut status_options = git2::StatusOptions::new();
        status_options.include_untracked(true);
        let statuses = repo
            .statuses(Some(&mut status_options))
            .map_err(|e| e.to_string())?;

        let mut modified = Vec::new();
        let mut staged = Vec::new();
        let mut untracked = Vec::new();

        for entry in statuses.iter() {
            let path = entry.path().unwrap_or("").to_string();
            let status = entry.status();

            if status.is_index_new()
                || status.is_index_modified()
                || status.is_index_deleted()
                || status.is_index_renamed()
                || status.is_index_typechange()
            {
                staged.push(path.clone());
            }
            if status.is_wt_modified()
                || status.is_wt_deleted()
                || status.is_wt_typechange()
                || status.is_wt_renamed()
            {
                modified.push(path.clone());
            }
            if status.is_wt_new() {
                untracked.push(path);
            }
        }

        Ok(json!({
            "staged": staged,
            "modified": modified,
            "untracked": untracked
        }))
    }
}

pub struct GitBranchTool;

#[async_trait]
impl Tool for GitBranchTool {
    fn name(&self) -> &str {
        "git_branch"
    }

    fn description(&self) -> &str {
        "Manages branches: list, create, or checkout."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the repo." },
                "action": { "type": "string", "enum": ["list", "create", "checkout"], "description": "Action to perform." },
                "branch_name": { "type": "string", "description": "Name of the branch (required for create/checkout)." }
            },
            "required": ["path", "action"]
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let repo_path = input["path"]
            .as_str()
            .ok_or("Parameter 'path' is required")?;
        let action = input["action"]
            .as_str()
            .ok_or("Parameter 'action' is required")?;
        let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;

        match action {
            "list" => {
                let branches = repo
                    .branches(Some(BranchType::Local))
                    .map_err(|e| e.to_string())?;
                let mut list = Vec::new();
                for branch in branches {
                    let (b, _) = branch.map_err(|e| e.to_string())?;
                    if let Some(name) = b.name().map_err(|e| e.to_string())? {
                        list.push(name.to_string());
                    }
                }
                Ok(json!({ "branches": list }))
            }
            "create" => {
                let name = input["branch_name"]
                    .as_str()
                    .ok_or("branch_name is required for create")?;
                let head = repo.head().map_err(|e| e.to_string())?;
                let commit = repo
                    .find_commit(head.target().unwrap())
                    .map_err(|e| e.to_string())?;
                repo.branch(name, &commit, false)
                    .map_err(|e| e.to_string())?;
                Ok(json!({ "status": "success", "message": format!("Created branch '{}'", name) }))
            }
            "checkout" => {
                let name = input["branch_name"]
                    .as_str()
                    .ok_or("branch_name is required for checkout")?;
                let obj = repo
                    .revparse_single(&format!("refs/heads/{}", name))
                    .map_err(|e| e.to_string())?;
                repo.checkout_tree(&obj, None).map_err(|e| e.to_string())?;
                repo.set_head(&format!("refs/heads/{}", name))
                    .map_err(|e| e.to_string())?;
                Ok(
                    json!({ "status": "success", "message": format!("Checked out branch '{}'", name) }),
                )
            }
            _ => Err("Invalid action".to_string()),
        }
    }
}

pub struct GitCommitTool;

#[async_trait]
impl Tool for GitCommitTool {
    fn name(&self) -> &str {
        "git_commit"
    }

    fn description(&self) -> &str {
        "Stages files and creates a new commit."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the repo." },
                "message": { "type": "string", "description": "Commit message." },
                "files": { "type": "array", "items": { "type": "string" }, "description": "Files to stage. If empty, stages all changes." }
            },
            "required": ["path", "message"]
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let repo_path = input["path"]
            .as_str()
            .ok_or("Parameter 'path' is required")?;
        let message = input["message"]
            .as_str()
            .ok_or("Parameter 'message' is required")?;
        let files = input["files"].as_array();

        let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;
        let mut index = repo.index().map_err(|e| e.to_string())?;

        if let Some(files_list) = files {
            for f in files_list {
                if let Some(f_str) = f.as_str() {
                    index
                        .add_path(Path::new(f_str))
                        .map_err(|e| e.to_string())?;
                }
            }
        } else {
            index
                .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
                .map_err(|e| e.to_string())?;
        }
        index.write().map_err(|e| e.to_string())?;

        let oid = index.write_tree().map_err(|e| e.to_string())?;
        let tree = repo.find_tree(oid).map_err(|e| e.to_string())?;

        let signature = repo
            .signature()
            .unwrap_or_else(|_| Signature::now("DevPrism Agent", "agent@devprism.local").unwrap());

        let parent_commit = match repo.head() {
            Ok(head) => {
                let target = head.target().ok_or("HEAD is not a direct reference")?;
                Some(repo.find_commit(target).map_err(|e| e.to_string())?)
            }
            Err(_) => None, // Initial commit
        };

        let parents = if let Some(ref p) = parent_commit {
            vec![p]
        } else {
            vec![]
        };

        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .map_err(|e| e.to_string())?;

        Ok(json!({ "status": "success", "message": "Commit created successfully" }))
    }
}

pub struct GitPRTool;

#[async_trait]
impl Tool for GitPRTool {
    fn name(&self) -> &str {
        "git_pr_create"
    }

    fn description(&self) -> &str {
        "Placeholder for PR generation. In a real environment, this would call GitHub/GitLab APIs or use 'gh pr create'."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "title": { "type": "string" },
                "body": { "type": "string" }
            },
            "required": ["title"]
        })
    }

    async fn call(&self, _input: Value) -> Result<Value, String> {
        Ok(
            json!({ "status": "info", "message": "PR generation tool is currently a placeholder. Please use 'gh pr create' manually for now." }),
        )
    }
}
