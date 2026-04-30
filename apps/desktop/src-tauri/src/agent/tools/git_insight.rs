use super::Tool;
use async_trait::async_trait;
use chrono::{NaiveDate, TimeZone, Utc};
use git2::Repository;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

pub struct GitInsightTool;

#[async_trait]
impl Tool for GitInsightTool {
    fn name(&self) -> &str {
        "git_insight"
    }

    fn description(&self) -> &str {
        "Analyzes a Git repository to provide insights into work history, impact, and tech stack."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The absolute path to the Git repository."
                },
                "start_date": {
                    "type": "string",
                    "description": "Optional: Start date for analysis (YYYY-MM-DD)."
                },
                "end_date": {
                    "type": "string",
                    "description": "Optional: End date for analysis (YYYY-MM-DD)."
                }
            },
            "required": ["path"]
        })
    }

    async fn call(&self, input: Value) -> Result<Value, String> {
        let repo_path = input["path"]
            .as_str()
            .ok_or("Parameter 'path' is required")?;
        let start_date = input["start_date"].as_str();
        let end_date = input["end_date"].as_str();

        let repo = Repository::open(repo_path)
            .map_err(|e| format!("Failed to open repository at {}: {}", repo_path, e))?;

        // Parse dates
        let start_ts = start_date
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|dt| dt.and_utc())
            .map(|dt| dt.timestamp());
        let end_ts = end_date
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
            .and_then(|d| d.and_hms_opt(23, 59, 59))
            .map(|dt| dt.and_utc())
            .map(|dt| dt.timestamp());

        let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
        revwalk.push_head().map_err(|e| e.to_string())?;

        let mut commits_summary = Vec::new();
        let mut commit_types = HashMap::new();
        let mut total_insertions = 0;
        let mut total_deletions = 0;
        let mut file_impact = HashMap::new();

        for oid in revwalk {
            let oid = oid.map_err(|e| e.to_string())?;
            let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
            let time = commit.time().seconds();

            if let Some(start) = start_ts {
                if time < start {
                    continue;
                }
            }
            if let Some(end) = end_ts {
                if time > end {
                    continue;
                }
            }

            let message = commit.message().unwrap_or("");
            let first_line = message.lines().next().unwrap_or("");

            // Simple type discovery
            let category = if first_line.starts_with("feat") {
                "Features"
            } else if first_line.starts_with("fix") {
                "Fixes"
            } else if first_line.starts_with("refactor") {
                "Refactors"
            } else if first_line.starts_with("docs") {
                "Documentation"
            } else if first_line.starts_with("test") {
                "Tests"
            } else if first_line.starts_with("chore") {
                "Chore"
            } else {
                "Other"
            };

            *commit_types.entry(category.to_string()).or_insert(0) += 1;

            commits_summary.push(json!({
                "hash": oid.to_string()[..8].to_string(),
                "message": first_line,
                "date": Utc.timestamp_opt(time, 0).single().map(|dt| dt.to_rfc3339()).unwrap_or_default(),
                "category": category
            }));

            // Impact analysis (limit to prevent excessive processing)
            if commits_summary.len() <= 50 {
                if let Ok(parent) = commit.parent(0) {
                    let tree = commit.tree().map_err(|e| e.to_string())?;
                    let parent_tree = parent.tree().map_err(|e| e.to_string())?;
                    let diff = repo
                        .diff_tree_to_tree(Some(&parent_tree), Some(&tree), None)
                        .map_err(|e| e.to_string())?;
                    let stats = diff.stats().map_err(|e| e.to_string())?;

                    total_insertions += stats.insertions();
                    total_deletions += stats.deletions();

                    // Track file impact
                    diff.foreach(
                        &mut |delta, _| {
                            if let Some(path) = delta.new_file().path().and_then(|p| p.to_str()) {
                                *file_impact.entry(path.to_string()).or_insert(0) += 1;
                            }
                            true
                        },
                        None,
                        None,
                        None,
                    )
                    .ok();
                }
            }
        }

        // Tech Stack Discovery
        let mut tech_stack = Vec::new();
        let root = Path::new(repo_path);
        if root.join("package.json").exists() {
            tech_stack.push("Node.js/TypeScript");
        }
        if root.join("Cargo.toml").exists() {
            tech_stack.push("Rust");
        }
        if root.join("requirements.txt").exists() || root.join("pyproject.toml").exists() {
            tech_stack.push("Python");
        }
        if root.join("go.mod").exists() {
            tech_stack.push("Go");
        }
        if root.join("pom.xml").exists() || root.join("build.gradle").exists() {
            tech_stack.push("Java/Kotlin");
        }
        if root.join("CMakeLists.txt").exists() {
            tech_stack.push("C/C++");
        }

        // Sort file impact and take top 10
        let mut sorted_impact: Vec<_> = file_impact.into_iter().collect();
        sorted_impact.sort_by(|a, b| b.1.cmp(&a.1));
        let top_files: Vec<_> = sorted_impact
            .into_iter()
            .take(10)
            .map(|(path, count)| json!({ "path": path, "changes": count }))
            .collect();

        Ok(json!({
            "commits": commits_summary,
            "stats": {
                "categories": commit_types,
                "total_commits": commits_summary.len(),
                "insertions": total_insertions,
                "deletions": total_deletions,
                "top_files": top_files
            },
            "tech_stack": tech_stack
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use std::fs::File;
    use std::io::Write;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_git_insight_tool() {
        let dir = tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();

        // Create a file
        let file_path = dir.path().join("main.rs");
        let mut file = File::create(&file_path).unwrap();
        file.write_all(b"fn main() { println!(\"hello\"); }")
            .unwrap();

        // Commit it
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("main.rs")).unwrap();
        index.write().unwrap();

        let oid = index.write_tree().unwrap();
        let tree = repo.find_tree(oid).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "feat: initial commit", &tree, &[])
            .unwrap();

        // Create Cargo.toml for tech stack discovery
        File::create(dir.path().join("Cargo.toml")).unwrap();

        let tool = GitInsightTool;
        let input = json!({ "path": dir.path().to_str().unwrap() });
        let result = tool.call(input).await.unwrap();

        assert_eq!(result["stats"]["total_commits"], 1);
        assert_eq!(result["commits"][0]["category"], "Features");
        assert!(result["tech_stack"]
            .as_array()
            .unwrap()
            .contains(&json!("Rust")));
    }
}
