//! Autonomous project-context loader.
//!
//! Builds ONE compact, byte-bounded markdown block that is appended to the
//! agent's `--append-system-prompt` so that even small local (Ollama) models
//! discover, at the start of every task:
//!   - the project's instruction/master/profile files (a user's "master file"
//!     with elaborate resume/manuscript details, an "agent file", etc.),
//!   - a compact project map (file tree + key files),
//!   - the installed skills (name + one-line description).
//!
//! It is fully offline (pure `std::fs`, no new crates), byte-bounded, and
//! cached per project (invalidated when watched files/dirs change) so it does
//! not re-walk the tree on every message.
//!
//! Note on CLAUDE.md / AGENTS.md: the Claude Code CLI already auto-loads those
//! from the project cwd (and its parents), so we NEVER inline them (that would
//! double-load and waste the small-model token budget) — we only LIST them as
//! pointers. We inline only the genuinely non-standard master/profile files the
//! CLI does not auto-read.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use crate::skills::{collect_skill_dirs, parse_skill_md, skills_dir};

// ── Budgets (bytes; roughly 4 bytes per token, no tokenizer in the host) ──
const BLOCK_BYTE_CEILING: usize = 3072; // whole dynamic block hard cap (~750 tok)
const INLINE_FILE_MAX: usize = 1000; // a master file is inlined only if <= this
const MAX_INLINE_FILES: usize = 1; // inline at most the single best master file
const MAX_LISTED_FILES: usize = 8;
const MAX_DATA_FILES: usize = 6;
const MAX_SKILLS: usize = 8;
const SKILL_DESC_MAX: usize = 80;
const MAP_MAX_ENTRIES: usize = 20;
const MAP_MAX_DEPTH: usize = 2;
const MAP_COLLAPSE_CHILDREN: usize = 12;
const LINE_MAX: usize = 100;
const DETECT_MAX_DEPTH: usize = 3;
const DETECT_MAX_MATCHES: usize = 24;

/// Directories never walked or listed (managed state or noise).
const EXCLUDE_DIRS: &[&str] = &[
    ".git",
    ".prism",
    ".claudeprism",
    ".venv",
    ".gitnexus",
    ".claude",
    "node_modules",
    "target",
    "dist",
    "build",
    ".devcouncil",
];

/// LaTeX/build artifact extensions hidden from the project map.
const ARTIFACT_EXTS: &[&str] = &[
    "aux", "log", "toc", "lof", "lot", "out", "nav", "snm", "vrb", "bbl", "blg",
    "fls", "fdb_latexmk", "synctex", "idx", "ind", "ilg", "glo", "gls", "glg",
    "fmt", "xdv", "bcf", "pdf",
];

// ─── Caching ───

struct CacheEntry {
    /// (path, mtime-millis) pairs whose change invalidates the cached block.
    watch: Vec<(PathBuf, u128)>,
    block: String,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static C: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mtime_ms(p: &Path) -> u128 {
    fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Build (or return cached) the project-context block for `project_dir`.
/// Returns an empty string when there is nothing useful to add (the agent's
/// static prompt is then left unchanged).
pub fn build_project_context_prompt(project_dir: &Path) -> String {
    let key = project_dir.to_string_lossy().to_string();

    // Warm path: only a few stat() calls, no tree walk.
    if let Ok(map) = cache().lock() {
        if let Some(entry) = map.get(&key) {
            if entry.watch.iter().all(|(p, ms)| mtime_ms(p) == *ms) {
                return entry.block.clone();
            }
        }
    }

    let (block, watch) = build_uncached(project_dir);
    if let Ok(mut map) = cache().lock() {
        map.insert(
            key,
            CacheEntry {
                watch,
                block: block.clone(),
            },
        );
    }
    block
}

fn build_uncached(project_dir: &Path) -> (String, Vec<(PathBuf, u128)>) {
    // Always watch the project root and the skills dir so adding/removing a
    // context file or a skill invalidates the cache.
    let cwd_str = project_dir.to_string_lossy();
    let skills_root = skills_dir(Some(cwd_str.as_ref()));
    let mut watch: Vec<(PathBuf, u128)> = vec![
        (project_dir.to_path_buf(), mtime_ms(project_dir)),
        (skills_root.clone(), mtime_ms(&skills_root)),
    ];

    let detected = detect_context_files(project_dir);
    let data_files = detect_data_files(project_dir);
    let skills = enumerate_skills(project_dir);
    let map = build_project_map(project_dir);

    if detected.is_empty()
        && data_files.is_empty()
        && skills.is_empty()
        && map.trim().is_empty()
    {
        return (String::new(), watch);
    }

    let mut out = String::new();
    out.push_str("\n\n## PROJECT CONTEXT (auto-discovered; open files with the Read tool)\n");

    // ── Instruction & context files ──
    if !detected.is_empty() {
        out.push_str("\n### Instruction & context files\n");
        let mut inlined = 0usize;
        let mut listed: Vec<String> = Vec::new();
        for d in &detected {
            // Never inline CLAUDE.md/AGENTS.md/AGENT.md — the CLI auto-loads
            // them from the project dir (and parents); inlining double-loads.
            let inline_ok = d.kind == FileKind::Master
                && inlined < MAX_INLINE_FILES
                && d.size as usize <= INLINE_FILE_MAX;
            if inline_ok {
                if let Some(body) = read_inline(&d.abs) {
                    watch.push((d.abs.clone(), mtime_ms(&d.abs)));
                    out.push_str(&format!("--- {} ---\n{}\n\n", d.rel, body));
                    inlined += 1;
                    continue;
                }
            }
            let note = if d.kind == FileKind::AgentDoc {
                " — agent instructions (auto-loaded)"
            } else {
                " — master/profile file"
            };
            listed.push(format!("- {} ({}){}", d.rel, human_size(d.size), note));
        }
        if !listed.is_empty() {
            out.push_str("Also available (open with Read when relevant):\n");
            for l in listed.iter().take(MAX_LISTED_FILES) {
                out.push_str(l);
                out.push('\n');
            }
        }
    }

    // ── Key data files (list only) ──
    if !data_files.is_empty() {
        out.push_str("\n### Key data files (open as needed)\n");
        for f in data_files.iter().take(MAX_DATA_FILES) {
            out.push_str(&format!("- {}\n", f));
        }
    }

    // ── Project map ──
    if !map.trim().is_empty() {
        out.push_str("\n### Project map (managed dirs hidden)\n");
        out.push_str(map.trim_end());
        out.push('\n');
    }

    // ── Installed skills ──
    if !skills.is_empty() {
        out.push_str("\n### Installed skills (.claude/skills/ — use when the task matches)\n");
        for (name, desc) in skills.iter().take(MAX_SKILLS) {
            if desc.is_empty() {
                out.push_str(&format!("- {}\n", name));
            } else {
                out.push_str(&format!("- {} — {}\n", name, desc));
            }
        }
        if skills.len() > MAX_SKILLS {
            out.push_str(&format!(
                "(+{} more in .claude/skills/)\n",
                skills.len() - MAX_SKILLS
            ));
        }
    }

    (enforce_ceiling(out), watch)
}

// ─── Instruction / master-file detection ───

#[derive(PartialEq, Clone, Copy)]
enum FileKind {
    /// CLAUDE.md / AGENTS.md / AGENT.md — auto-loaded by the CLI; we only list.
    AgentDoc,
    /// MASTER/RESUME/PROFILE/etc. — inline-eligible (the CLI never auto-reads).
    Master,
}

struct Detected {
    rel: String,
    abs: PathBuf,
    size: u64,
    kind: FileKind,
}

fn detect_context_files(root: &Path) -> Vec<Detected> {
    let mut out: Vec<Detected> = Vec::new();
    walk_detect(root, root, 0, &mut out);
    // Master files first (smaller first, so the best one inlines within budget),
    // then agent docs (list-only).
    out.sort_by(|a, b| {
        let ka = if a.kind == FileKind::Master { 0 } else { 1 };
        let kb = if b.kind == FileKind::Master { 0 } else { 1 };
        ka.cmp(&kb).then(a.size.cmp(&b.size))
    });
    out
}

fn walk_detect(root: &Path, dir: &Path, depth: usize, out: &mut Vec<Detected>) {
    if depth > DETECT_MAX_DEPTH || out.len() >= DETECT_MAX_MATCHES {
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let ft = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue; // never follow symlinks (no escaping the project)
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if ft.is_dir() {
            if EXCLUDE_DIRS.contains(&name.to_lowercase().as_str()) {
                continue;
            }
            walk_detect(root, &entry.path(), depth + 1, out);
        } else if ft.is_file() {
            let path = entry.path();
            if let Some(kind) = classify(root, &path) {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push(Detected {
                    rel,
                    abs: path,
                    size,
                    kind,
                });
            }
        }
    }
}

fn classify(root: &Path, path: &Path) -> Option<FileKind> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    let rel = path
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .to_lowercase()
        .replace('\\', "/");

    if name == "claude.md" || name == "agents.md" || name == "agent.md" {
        return Some(FileKind::AgentDoc);
    }
    let is_text = name.ends_with(".md") || name.ends_with(".txt");
    if !is_text {
        return None;
    }
    let master_stems = [
        "master.md",
        "master.txt",
        "resume.md",
        "resume.txt",
        "cv.md",
        "profile.md",
        "author.md",
        "bio.md",
    ];
    if master_stems.contains(&name.as_str())
        || name.ends_with(".master.md")
        || name.starts_with("resume")
        || rel.starts_with(".devprism/")
        || rel.starts_with("context/")
    {
        return Some(FileKind::Master);
    }
    None
}

/// Read a small text file for inlining: bounded, control-chars stripped, lines
/// capped (so arbitrary user content can't break the CLI argv on Windows).
fn read_inline(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() as usize > INLINE_FILE_MAX.saturating_mul(2) {
        return None; // too big to inline; caller falls back to listing
    }
    let raw = fs::read_to_string(path).ok()?;
    let mut s = sanitize(&raw);
    if s.len() > INLINE_FILE_MAX {
        let mut cut = INLINE_FILE_MAX;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push('…');
    }
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn sanitize(s: &str) -> String {
    let mut out = String::new();
    for line in s.lines() {
        let mut clean: String = line
            .chars()
            .filter_map(|c| {
                if c == '\t' {
                    Some(' ')
                } else if c.is_control() {
                    None
                } else {
                    Some(c)
                }
            })
            .collect();
        if clean.len() > LINE_MAX {
            let mut cut = LINE_MAX;
            while cut > 0 && !clean.is_char_boundary(cut) {
                cut -= 1;
            }
            clean.truncate(cut);
        }
        out.push_str(clean.trim_end());
        out.push('\n');
    }
    out
}

// ─── Key data files (list only) ───

fn detect_data_files(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let rd = match fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return out,
    };
    let names: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().map(|f| f.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();

    let priority = [
        "main.tex",
        "master.tex",
        "references.bib",
        "master.bib",
        "master.json",
    ];
    for p in priority {
        if let Some(n) = names.iter().find(|n| n.eq_ignore_ascii_case(p)) {
            out.push(n.clone());
        }
    }
    for n in &names {
        if out.len() >= MAX_DATA_FILES {
            break;
        }
        let l = n.to_lowercase();
        if (l.ends_with(".master.bib") || l.ends_with(".master.json")) && !out.contains(n) {
            out.push(n.clone());
        }
    }
    out.truncate(MAX_DATA_FILES);
    out
}

// ─── Installed-skills enumeration (reuses skills.rs) ───

fn enumerate_skills(project: &Path) -> Vec<(String, String)> {
    let cwd_str = project.to_string_lossy();
    let root = skills_dir(Some(cwd_str.as_ref()));
    let mut dirs: Vec<PathBuf> = Vec::new();
    collect_skill_dirs(&root, &mut dirs);
    dirs.sort();
    dirs.iter()
        .filter_map(|d| parse_skill_md(d))
        .map(|s| (s.name, trunc(&s.description, SKILL_DESC_MAX)))
        .collect()
}

// ─── Compact project map ───

fn build_project_map(root: &Path) -> String {
    let mut lines: Vec<String> = vec![".".to_string()];
    let mut count = 0usize;
    map_walk(root, 0, "", &mut lines, &mut count);
    if count >= MAP_MAX_ENTRIES {
        lines.push("… (more files omitted)".to_string());
    }
    if lines.len() <= 1 {
        return String::new();
    }
    lines.join("\n")
}

fn map_walk(dir: &Path, depth: usize, prefix: &str, lines: &mut Vec<String>, count: &mut usize) {
    if *count >= MAP_MAX_ENTRIES {
        return;
    }
    let mut dirs: Vec<(String, PathBuf)> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let ft = match e.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if ft.is_dir() {
            if EXCLUDE_DIRS.contains(&name.to_lowercase().as_str()) {
                continue;
            }
            dirs.push((name, e.path()));
        } else if ft.is_file() {
            if name.starts_with('.') {
                continue;
            }
            let ext = Path::new(&name)
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.to_lowercase())
                .unwrap_or_default();
            if ARTIFACT_EXTS.contains(&ext.as_str()) {
                continue;
            }
            files.push(name);
        }
    }
    dirs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    files.sort_by_key(|f| f.to_lowercase());

    let total = dirs.len() + files.len();
    let mut idx = 0usize;
    for (name, path) in &dirs {
        if *count >= MAP_MAX_ENTRIES {
            return;
        }
        let last = idx + 1 == total;
        let conn = if last { "└── " } else { "├── " };
        let children = count_children(path);
        if depth + 1 >= MAP_MAX_DEPTH || children > MAP_COLLAPSE_CHILDREN {
            lines.push(cap_line(format!(
                "{}{}{}/ ({} files)",
                prefix, conn, name, children
            )));
            *count += 1;
        } else {
            lines.push(cap_line(format!("{}{}{}/", prefix, conn, name)));
            *count += 1;
            let child_prefix = format!("{}{}", prefix, if last { "    " } else { "│   " });
            map_walk(path, depth + 1, &child_prefix, lines, count);
        }
        idx += 1;
    }
    for name in &files {
        if *count >= MAP_MAX_ENTRIES {
            return;
        }
        let last = idx + 1 == total;
        let conn = if last { "└── " } else { "├── " };
        lines.push(cap_line(format!("{}{}{}", prefix, conn, name)));
        *count += 1;
        idx += 1;
    }
}

fn count_children(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .count()
        })
        .unwrap_or(0)
}

// ─── Helpers ───

fn cap_line(s: String) -> String {
    if s.len() <= LINE_MAX {
        return s;
    }
    let mut cut = LINE_MAX;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut t = s[..cut].to_string();
    t.push('…');
    t
}

fn trunc(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.len() <= max {
        return s.to_string();
    }
    let mut cut = max;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &s[..cut])
}

fn human_size(b: u64) -> String {
    if b < 1024 {
        format!("{} B", b)
    } else {
        format!("{:.0} KB", b as f64 / 1024.0)
    }
}

fn enforce_ceiling(s: String) -> String {
    if s.len() <= BLOCK_BYTE_CEILING {
        return s;
    }
    let mut cut = BLOCK_BYTE_CEILING;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut t = s[..cut].to_string();
    t.push_str("\n[context truncated to fit]\n");
    t
}

/// Lightweight count of detected context/master + key data files, for an
/// optional "N context files detected" badge in the UI. Cheap and offline.
#[tauri::command]
pub fn count_project_context(project_path: String) -> usize {
    let p = Path::new(&project_path);
    detect_context_files(p).len() + detect_data_files(p).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "devprism_ctx_{}_{}",
            std::process::id(),
            tag
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn inlines_master_lists_claude_and_bounds_size() {
        let dir = temp_project("master");
        fs::write(dir.join("CLAUDE.md"), "# agent doc\nrules").unwrap();
        fs::write(
            dir.join("MASTER.md"),
            "Target: 1-page CV. Use moderncv. Pull history from here.",
        )
        .unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "x").unwrap();
        fs::create_dir_all(dir.join(".claude/skills/resume-cv")).unwrap();
        fs::write(
            dir.join(".claude/skills/resume-cv/SKILL.md"),
            "---\nname: resume-cv\ndescription: \"Tailor LaTeX resumes\"\n---\n# Resume\n",
        )
        .unwrap();

        let block = build_project_context_prompt(&dir);
        assert!(block.contains("moderncv"), "master file inlined");
        assert!(block.contains("CLAUDE.md"), "claude.md listed");
        assert!(
            !block.contains("# agent doc"),
            "claude.md must NOT be inlined (CLI auto-loads it)"
        );
        assert!(block.contains("resume-cv"), "skill enumerated");
        assert!(
            !block.contains("node_modules"),
            "managed dir excluded from map"
        );
        assert!(block.len() <= BLOCK_BYTE_CEILING + 64, "byte-bounded");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_project_yields_empty_block() {
        let dir = temp_project("empty");
        let block = build_project_context_prompt(&dir);
        assert!(block.trim().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
