//! Rust-native agent tools (no external CLI). Tool names mirror the Claude tool
//! names (Read/Write/Edit/LS/Bash/Grep) so the existing chat UI's file-change /
//! proposed-change detection works unchanged. All file access is confined to the
//! project directory.

use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

const MAX_READ_BYTES: usize = 60 * 1024;
const MAX_OUTPUT_BYTES: usize = 16 * 1024;
const GREP_MAX_HITS: usize = 80;
const GREP_MAX_FILES: usize = 2000;
const BASH_TIMEOUT_SECS: u64 = 90;

const EXCLUDE_DIRS: &[&str] = &[
    ".git", ".prism", ".claudeprism", ".venv", ".gitnexus", "node_modules",
    "target", "dist", "build",
];

/// OpenAI-style function schemas advertised to the model.
pub fn tool_schemas() -> Value {
    json!([
        schema("Read", "Read a UTF-8 text file from the project and return its contents.",
            json!({"file_path": {"type": "string", "description": "Path relative to the project root"}}),
            &["file_path"]),
        schema("Write", "Create or overwrite a project file with the given contents.",
            json!({
                "file_path": {"type": "string", "description": "Path relative to the project root"},
                "content": {"type": "string", "description": "Full file contents"}
            }),
            &["file_path", "content"]),
        schema("Edit", "Replace an exact substring in a project file. old_string must occur exactly once.",
            json!({
                "file_path": {"type": "string"},
                "old_string": {"type": "string", "description": "Exact text to replace (must be unique)"},
                "new_string": {"type": "string", "description": "Replacement text"}
            }),
            &["file_path", "old_string", "new_string"]),
        schema("LS", "List the entries of a directory in the project.",
            json!({"path": {"type": "string", "description": "Directory path relative to the project root (default: root)"}}),
            &[]),
        schema("Grep", "Search project files for a case-insensitive substring and return matching lines.",
            json!({
                "pattern": {"type": "string", "description": "Substring to search for"},
                "path": {"type": "string", "description": "Optional sub-directory to limit the search"}
            }),
            &["pattern"]),
        schema("Bash", "Run a shell command in the project directory (e.g. `uv run python script.py`). Returns combined stdout+stderr.",
            json!({"command": {"type": "string", "description": "The shell command to run"}}),
            &["command"]),
    ])
}

fn schema(name: &str, desc: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": desc,
            "parameters": {
                "type": "object",
                "properties": props,
                "required": required,
            }
        }
    })
}

/// Resolve a user-supplied relative path to an absolute path confined to
/// `project_dir`. Rejects absolute paths and any `..` traversal.
fn resolve(project_dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let raw = rel.trim();
    if raw.is_empty() {
        return Ok(project_dir.to_path_buf());
    }
    // Reject absolute paths (unix `/x`, windows `\x`, `C:\x`, UNC).
    if raw.starts_with('/') || raw.starts_with('\\') || Path::new(raw).is_absolute() {
        return Err("Path must be relative to the project (no absolute paths).".into());
    }
    let candidate = Path::new(raw);
    if candidate
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
    {
        return Err("Path must stay inside the project (no '..').".into());
    }
    Ok(project_dir.join(candidate))
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

fn cap(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut cut = max;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n…[output truncated]");
    }
    s
}

/// Execute one tool call. Returns (result_text, is_error).
pub async fn execute(project_dir: &Path, name: &str, args: &Value) -> (String, bool) {
    match name {
        "Read" => match arg(args, "file_path") {
            Some(fp) => match resolve(project_dir, fp) {
                Ok(path) => match std::fs::read_to_string(&path) {
                    Ok(content) => (cap(content, MAX_READ_BYTES), false),
                    Err(e) => (format!("Could not read {}: {}", fp, e), true),
                },
                Err(e) => (e, true),
            },
            None => ("Read requires 'file_path'.".into(), true),
        },
        "Write" => match (arg(args, "file_path"), args.get("content").and_then(|c| c.as_str())) {
            (Some(fp), Some(content)) => match resolve(project_dir, fp) {
                Ok(path) => {
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    match std::fs::write(&path, content) {
                        Ok(_) => (format!("Wrote {} ({} bytes).", fp, content.len()), false),
                        Err(e) => (format!("Could not write {}: {}", fp, e), true),
                    }
                }
                Err(e) => (e, true),
            },
            _ => ("Write requires 'file_path' and 'content'.".into(), true),
        },
        "Edit" => {
            let fp = arg(args, "file_path");
            let old = args.get("old_string").and_then(|c| c.as_str());
            let new = args.get("new_string").and_then(|c| c.as_str());
            match (fp, old, new) {
                (Some(fp), Some(old), Some(new)) => match resolve(project_dir, fp) {
                    Ok(path) => match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            let count = content.matches(old).count();
                            if count == 0 {
                                ("Edit failed: old_string was not found.".into(), true)
                            } else if count > 1 {
                                (format!("Edit failed: old_string occurs {} times; make it unique.", count), true)
                            } else {
                                let updated = content.replacen(old, new, 1);
                                match std::fs::write(&path, updated) {
                                    Ok(_) => (format!("Edited {}.", fp), false),
                                    Err(e) => (format!("Could not write {}: {}", fp, e), true),
                                }
                            }
                        }
                        Err(e) => (format!("Could not read {}: {}", fp, e), true),
                    },
                    Err(e) => (e, true),
                },
                _ => ("Edit requires 'file_path', 'old_string', 'new_string'.".into(), true),
            }
        }
        "LS" => {
            let sub = arg(args, "path").unwrap_or("");
            match resolve(project_dir, sub) {
                Ok(dir) => match std::fs::read_dir(&dir) {
                    Ok(rd) => {
                        let mut names: Vec<String> = rd
                            .flatten()
                            .map(|e| {
                                let n = e.file_name().to_string_lossy().to_string();
                                if e.file_type().map(|f| f.is_dir()).unwrap_or(false) {
                                    format!("{}/", n)
                                } else {
                                    n
                                }
                            })
                            .collect();
                        names.sort();
                        (cap(names.join("\n"), MAX_OUTPUT_BYTES), false)
                    }
                    Err(e) => (format!("Could not list {}: {}", sub, e), true),
                },
                Err(e) => (e, true),
            }
        }
        "Grep" => match arg(args, "pattern") {
            Some(pattern) => {
                let sub = arg(args, "path").unwrap_or("");
                match resolve(project_dir, sub) {
                    Ok(root) => (grep(&root, project_dir, pattern), false),
                    Err(e) => (e, true),
                }
            }
            None => ("Grep requires 'pattern'.".into(), true),
        },
        "Bash" => match arg(args, "command") {
            Some(command) => run_bash(project_dir, command).await,
            None => ("Bash requires 'command'.".into(), true),
        },
        other => (format!("Unknown tool: {}", other), true),
    }
}

fn grep(root: &Path, project_dir: &Path, pattern: &str) -> String {
    let needle = pattern.to_lowercase();
    let mut hits: Vec<String> = Vec::new();
    let mut files_scanned = 0usize;
    grep_walk(root, project_dir, &needle, &mut hits, &mut files_scanned);
    if hits.is_empty() {
        format!("No matches for \"{}\".", pattern)
    } else {
        cap(hits.join("\n"), MAX_OUTPUT_BYTES)
    }
}

fn grep_walk(
    dir: &Path,
    project_dir: &Path,
    needle: &str,
    hits: &mut Vec<String>,
    files_scanned: &mut usize,
) {
    if hits.len() >= GREP_MAX_HITS || *files_scanned >= GREP_MAX_FILES {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        if hits.len() >= GREP_MAX_HITS || *files_scanned >= GREP_MAX_FILES {
            return;
        }
        let ft = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if ft.is_dir() {
            if EXCLUDE_DIRS.contains(&name.to_lowercase().as_str()) {
                continue;
            }
            grep_walk(&path, project_dir, needle, hits, files_scanned);
        } else if ft.is_file() {
            // Only search reasonably-sized text files.
            if entry.metadata().map(|m| m.len()).unwrap_or(0) > 512 * 1024 {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(&path) {
                *files_scanned += 1;
                let rel = path
                    .strip_prefix(project_dir)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                for (i, line) in content.lines().enumerate() {
                    if line.to_lowercase().contains(needle) {
                        let trimmed: String = line.trim().chars().take(160).collect();
                        hits.push(format!("{}:{}: {}", rel, i + 1, trimmed));
                        if hits.len() >= GREP_MAX_HITS {
                            return;
                        }
                    }
                }
            }
        }
    }
}

async fn run_bash(project_dir: &Path, command: &str) -> (String, bool) {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    cmd.current_dir(project_dir);

    let fut = cmd.output();
    let output = match tokio::time::timeout(Duration::from_secs(BASH_TIMEOUT_SECS), fut).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return (format!("Command failed to start: {}", e), true),
        Err(_) => {
            return (
                format!("Command timed out after {}s.", BASH_TIMEOUT_SECS),
                true,
            )
        }
    };

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    if combined.trim().is_empty() {
        combined = "(no output)".into();
    }
    let is_error = !output.status.success();
    (cap(combined, MAX_OUTPUT_BYTES), is_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_blocks_traversal() {
        let root = Path::new("/proj");
        assert!(resolve(root, "../etc/passwd").is_err());
        assert!(resolve(root, "/etc/passwd").is_err());
        assert!(resolve(root, "sub/file.tex").is_ok());
    }

    #[test]
    fn schemas_are_well_formed() {
        let s = tool_schemas();
        let arr = s.as_array().unwrap();
        assert_eq!(arr.len(), 6);
        for t in arr {
            assert_eq!(t["type"], "function");
            assert!(t["function"]["name"].is_string());
        }
    }
}
