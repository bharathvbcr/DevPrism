//! Rust-native agent tools (no external CLI). Tool names mirror the Claude tool
//! names (Read/Write/Edit/LS/Bash/Grep) so the existing chat UI's file-change /
//! proposed-change detection works unchanged. All file access is confined to the
//! project directory.

use serde_json::{json, Value};
use std::io::Read;
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
        schema("Edit", "Replace text in a project file. By default old_string must occur exactly once; pass replace_all to change every occurrence.",
            json!({
                "file_path": {"type": "string"},
                "old_string": {"type": "string", "description": "Exact text to replace (must be unique unless replace_all)"},
                "new_string": {"type": "string", "description": "Replacement text"},
                "replace_all": {"type": "boolean", "description": "Replace all occurrences (default false)"}
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
        schema("Glob", "Find files by name pattern (e.g. `*.tex`, `*chapter*`). Returns matching project-relative paths.",
            json!({
                "pattern": {"type": "string", "description": "Filename glob (* matches any run of characters, ? one)"},
                "path": {"type": "string", "description": "Optional sub-directory to search under"}
            }),
            &["pattern"]),
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

/// Apply an Edit: exact unique match (or replace_all), with a fallback that
/// retries after normalizing CRLF -> LF so trivial line-ending mismatches don't
/// fail the edit.
fn apply_edit(
    path: &Path,
    rel: &str,
    content: &str,
    old: &str,
    new: &str,
    replace_all: bool,
) -> (String, bool) {
    let count = content.matches(old).count();
    if count == 1 || (count > 1 && replace_all) {
        let updated = if replace_all {
            content.replace(old, new)
        } else {
            content.replacen(old, new, 1)
        };
        return write_edit(path, rel, &updated, "");
    }
    if count > 1 {
        return (
            format!(
                "Edit failed: old_string occurs {} times; make it unique or pass replace_all=true.",
                count
            ),
            true,
        );
    }
    // No exact match — retry on LF-normalized buffers.
    let norm_content = content.replace("\r\n", "\n");
    let norm_old = old.replace("\r\n", "\n");
    let ncount = norm_content.matches(&norm_old).count();
    if ncount == 0 {
        return (
            "Edit failed: old_string was not found (even after normalizing line endings). \
             Read the file and copy the exact text to replace."
                .into(),
            true,
        );
    }
    if ncount > 1 && !replace_all {
        return (
            format!(
                "Edit failed: old_string occurs {} times; make it unique or pass replace_all=true.",
                ncount
            ),
            true,
        );
    }
    let updated = if replace_all {
        norm_content.replace(&norm_old, new)
    } else {
        norm_content.replacen(&norm_old, new, 1)
    };
    // Preserve the file's original line-ending convention instead of forcing LF.
    if content.contains("\r\n") {
        let crlf = updated.replace("\r\n", "\n").replace('\n', "\r\n");
        write_edit(path, rel, &crlf, "")
    } else {
        write_edit(path, rel, &updated, "")
    }
}

fn write_edit(path: &Path, rel: &str, updated: &str, note: &str) -> (String, bool) {
    match std::fs::write(path, updated) {
        Ok(_) => (format!("Edited {}{}.", rel, note), false),
        Err(e) => (format!("Could not write {}: {}", rel, e), true),
    }
}

/// Read at most MAX_READ_BYTES from a file without loading huge files into RAM,
/// and reject binary files with a clear message instead of mojibake.
fn read_file(path: &Path, rel: &str) -> (String, bool) {
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return (format!("Could not read {}: {}", rel, e), true),
    };
    let mut buf = Vec::new();
    // Read one byte past the cap so we can tell whether truncation happened.
    if f.by_ref()
        .take((MAX_READ_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .is_err()
    {
        return (format!("Could not read {}.", rel), true);
    }
    // UTF-16 text (with BOM) has null bytes but is not binary — decode it.
    if buf.len() >= 2
        && ((buf[0] == 0xFF && buf[1] == 0xFE) || (buf[0] == 0xFE && buf[1] == 0xFF))
    {
        let le = buf[0] == 0xFF;
        let units: Vec<u16> = buf[2..]
            .chunks_exact(2)
            .map(|c| {
                if le {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect();
        return (cap(String::from_utf16_lossy(&units), MAX_READ_BYTES), false);
    }
    if buf.iter().take(8000).any(|&b| b == 0) {
        return (
            format!(
                "{} looks like a binary file and was not shown. Use Bash if you need to inspect it.",
                rel
            ),
            true,
        );
    }
    let truncated = buf.len() > MAX_READ_BYTES;
    if truncated {
        buf.truncate(MAX_READ_BYTES);
    }
    let mut content = String::from_utf8_lossy(&buf).into_owned();
    if truncated {
        content.push_str("\n…[file truncated; read a specific section with Grep/Bash if needed]");
    }
    (content, false)
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
                Ok(path) => read_file(&path, fp),
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
                            let replace_all =
                                args.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
                            apply_edit(&path, fp, &content, old, new, replace_all)
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
        "Glob" => match arg(args, "pattern") {
            Some(pattern) => {
                let sub = arg(args, "path").unwrap_or("");
                match resolve(project_dir, sub) {
                    Ok(root) => (glob_find(&root, project_dir, pattern), false),
                    Err(e) => (e, true),
                }
            }
            None => ("Glob requires 'pattern'.".into(), true),
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

/// Classic iterative glob match supporting `*` (any run) and `?` (one char),
/// case-insensitive, matched against a file name.
fn wildcard_match(text: &str, pat: &str) -> bool {
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let p: Vec<char> = pat.to_lowercase().chars().collect();
    let (mut ti, mut pi) = (0usize, 0usize);
    let mut star_p: Option<usize> = None;
    let mut star_t = 0usize;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            ti += 1;
            pi += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star_p = Some(pi);
            star_t = ti;
            pi += 1;
        } else if let Some(sp) = star_p {
            pi = sp + 1;
            star_t += 1;
            ti = star_t;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn glob_find(root: &Path, project_dir: &Path, pattern: &str) -> String {
    let mut hits: Vec<String> = Vec::new();
    glob_walk(root, project_dir, pattern, &mut hits);
    if hits.is_empty() {
        format!("No files match \"{}\".", pattern)
    } else {
        hits.sort();
        cap(hits.join("\n"), MAX_OUTPUT_BYTES)
    }
}

fn glob_walk(dir: &Path, project_dir: &Path, pattern: &str, hits: &mut Vec<String>) {
    if hits.len() >= GREP_MAX_HITS {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        if hits.len() >= GREP_MAX_HITS {
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
            glob_walk(&path, project_dir, pattern, hits);
        } else if ft.is_file() && wildcard_match(&name, pattern) {
            let rel = path
                .strip_prefix(project_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            hits.push(rel);
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
    // Reap the child if this future is dropped (e.g. the turn is cancelled).
    cmd.kill_on_drop(true);

    // Activate the project's .venv for THIS child only (the system prompt promises
    // it). Set VIRTUAL_ENV and prepend the venv bin dir so bare `python`/`pip`
    // resolve to the project interpreter. We never touch the parent process env.
    let venv = project_dir.join(".venv");
    if venv.is_dir() {
        let bin = if cfg!(target_os = "windows") {
            venv.join("Scripts")
        } else {
            venv.join("bin")
        };
        cmd.env("VIRTUAL_ENV", &venv);
        let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
        let existing = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}{}{}", bin.display(), sep, existing));
    }

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
        assert_eq!(arr.len(), 7);
        for t in arr {
            assert_eq!(t["type"], "function");
            assert!(t["function"]["name"].is_string());
        }
    }

    #[test]
    fn wildcard_matches() {
        assert!(wildcard_match("main.tex", "*.tex"));
        assert!(wildcard_match("chapter1.tex", "*chapter*"));
        assert!(wildcard_match("a.bib", "?.bib"));
        assert!(!wildcard_match("main.tex", "*.bib"));
    }
}
