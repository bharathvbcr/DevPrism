//! Rust-native agent tools (no external CLI). Tool names mirror the Claude tool
//! names (Read/Write/Edit/LS/Bash/Grep) so the existing chat UI's file-change /
//! proposed-change detection works unchanged. All file access is confined to the
//! project directory.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

const MAX_READ_BYTES: usize = 60 * 1024;
/// Upper bound on how far into a file a ranged (offset/limit) Read will scan, so
/// paging through a large file stays bounded but high offsets remain reachable.
const MAX_RANGE_SCAN_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 16 * 1024;
const GREP_MAX_HITS: usize = 80;
const GREP_MAX_FILES: usize = 2000;
const GREP_MAX_FILE_BYTES: usize = 512 * 1024;
/// Upper bound on Grep's before/after context lines, so a large `context=` can't
/// explode the output (MAX_OUTPUT_BYTES still applies on top of this).
const GREP_MAX_CONTEXT: usize = 10;
/// Bound recursion so a pathologically deep tree can't blow the stack or hang.
const MAX_WALK_DEPTH: usize = 32;
/// Caps for the recursive `LS` tree view, so a deep/wide tree can't flood output.
const LS_MAX_DEPTH: usize = 5;
const LS_MAX_ENTRIES: usize = 400;
const BASH_TIMEOUT_SECS: u64 = 90;

const EXCLUDE_DIRS: &[&str] = &[
    ".git", ".prism", ".claudeprism", ".venv", ".gitnexus", "node_modules",
    "target", "dist", "build",
];

/// OpenAI-style function schemas advertised to the model.
pub fn tool_schemas() -> Value {
    json!([
        schema("Read", "Read a UTF-8 text file from the project. Optionally pass offset/limit (1-based line numbers) to read just a slice of a large file.",
            json!({
                "file_path": {"type": "string", "description": "Path relative to the project root"},
                "offset": {"type": "integer", "description": "1-based line number to start at (optional; reads from the top by default)"},
                "limit": {"type": "integer", "description": "Maximum number of lines to return (optional)"}
            }),
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
        schema("LS", "List the entries of a directory in the project. Pass depth>1 for an indented recursive tree (good for getting oriented).",
            json!({
                "path": {"type": "string", "description": "Directory path relative to the project root (default: root)"},
                "depth": {"type": "integer", "description": "How many directory levels to list (default 1; up to 5 for a tree view)"}
            }),
            &[]),
        schema("Grep", "Search project files for a substring (case-insensitive by default). Returns matches as `path:line: text`; pass context to also show surrounding lines so you can then Read that region with offset/limit.",
            json!({
                "pattern": {"type": "string", "description": "Substring to search for"},
                "path": {"type": "string", "description": "Optional sub-directory to limit the search"},
                "glob": {"type": "string", "description": "Optional filename filter, e.g. *.tex (only search matching files)"},
                "case_sensitive": {"type": "boolean", "description": "Match case exactly (default false)"},
                "context": {"type": "integer", "description": "Lines of context to show before and after each match, like grep -C (default 0)"}
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

/// Resolve a user-supplied path to an absolute path confined to `project_dir`.
/// Relative paths are joined; an absolute path is accepted only when it actually
/// lives inside the project (small models routinely echo back an absolute path
/// we handed them). Any `..` traversal or out-of-project absolute path is rejected.
fn resolve(project_dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let raw = rel.trim();
    if raw.is_empty() {
        return Ok(project_dir.to_path_buf());
    }
    let candidate = Path::new(raw);
    let is_abs = raw.starts_with('/') || raw.starts_with('\\') || candidate.is_absolute();

    // For an absolute path, recover the in-project remainder lexically (no fs
    // canonicalize: the target may not exist yet, e.g. a Write to a new file).
    let rel_path: PathBuf = if is_abs {
        match strip_project_prefix(project_dir, candidate) {
            Some(stripped) => stripped,
            None => {
                return Err(
                    "Path must stay inside the project (absolute path is outside the project root)."
                        .into(),
                )
            }
        }
    } else {
        candidate.to_path_buf()
    };

    if rel_path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
    {
        return Err("Path must stay inside the project (no '..').".into());
    }
    if rel_path.as_os_str().is_empty() {
        return Ok(project_dir.to_path_buf());
    }
    let joined = project_dir.join(rel_path);
    // Defense-in-depth: resolve symlinks of the existing ancestors and require the
    // real path to stay inside the canonicalized project root, so an in-project
    // symlink can't be used to read/write outside the project. Fail-open when the
    // project root can't be canonicalized (don't break legitimate use).
    if let Some(real_root) = canonicalize_existing(project_dir) {
        let real_target = canonicalize_existing(&joined).unwrap_or_else(|| joined.clone());
        if !real_target.starts_with(&real_root) {
            return Err(
                "Path escapes the project (it resolves through a symlink to outside the project root)."
                    .into(),
            );
        }
    }
    Ok(joined)
}

/// Canonicalize the longest existing ancestor of `p` and re-append the
/// not-yet-existing tail, so a path to a new file (Write) can still be checked
/// for symlink escapes without requiring the target to exist.
fn canonicalize_existing(p: &Path) -> Option<PathBuf> {
    let mut ancestor = p.to_path_buf();
    let mut tail = PathBuf::new();
    loop {
        if let Ok(c) = std::fs::canonicalize(&ancestor) {
            return Some(if tail.as_os_str().is_empty() {
                c
            } else {
                c.join(&tail)
            });
        }
        let name = ancestor.file_name()?.to_owned();
        if !ancestor.pop() {
            return None;
        }
        tail = Path::new(&name).join(&tail);
    }
}

/// Lexically strip `project_dir` from `candidate` when candidate is inside it,
/// returning the in-project remainder. Tolerates separator/case drift on Windows.
/// Returns None when candidate is not under project_dir.
fn strip_project_prefix(project_dir: &Path, candidate: &Path) -> Option<PathBuf> {
    if let Ok(rest) = candidate.strip_prefix(project_dir) {
        return Some(rest.to_path_buf());
    }
    #[cfg(target_os = "windows")]
    {
        let norm = |p: &Path| {
            p.to_string_lossy()
                .replace('\\', "/")
                .trim_end_matches('/')
                .to_lowercase()
        };
        let proj = norm(project_dir);
        let cand = norm(candidate);
        if cand == proj {
            return Some(PathBuf::new());
        }
        if let Some(rest) = cand.strip_prefix(&format!("{}/", proj)) {
            return Some(PathBuf::from(rest));
        }
    }
    None
}

/// Fetch a string argument, treating a missing key or a blank/whitespace-only
/// value as absent. Flaky local models frequently emit empty arguments (e.g.
/// `{"file_path": ""}`); returning None lets each tool surface a clear
/// "requires X" message instead of a cryptic OS error or a whole-tree dump.
fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
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
    // An empty old_string matches at every character boundary: with replace_all
    // it would splice new_string between every char (total corruption), and
    // without it reports a misleading "occurs N times". Forbid it outright.
    if old.is_empty() {
        return (
            "Edit failed: old_string must not be empty. Use Write to create or overwrite a file."
                .into(),
            true,
        );
    }
    // A no-op edit wastes a disk write and (because it would report success)
    // wrongly clears the caller's duplicate-call cache. Reject it as an error.
    if old == new {
        return (
            "Edit made no change: old_string and new_string are identical. \
             Provide different replacement text or pick a different target."
                .into(),
            true,
        );
    }
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
    // No exact match — retry tolerantly on LF-normalized buffers so a trivial
    // CRLF/LF mismatch in old_string doesn't fail the edit.
    let norm_content = content.replace("\r\n", "\n");
    let norm_old = old.replace("\r\n", "\n");
    let ncount = norm_content.matches(&norm_old).count();
    if ncount == 0 {
        return (
            format!(
                "Edit failed: old_string was not found (even after normalizing line endings). \
                 Read the file and copy the exact text to replace.{}",
                edit_not_found_hint(content, old)
            ),
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
    // The mismatch was only line endings. Reconstruct old/new with the file's
    // own convention and splice into the ORIGINAL content, so untouched lines
    // keep their endings (never rewrite a mixed-ending file entirely to CRLF).
    if content.contains("\r\n") {
        let old_crlf = norm_old.replace('\n', "\r\n");
        let new_crlf = new.replace("\r\n", "\n").replace('\n', "\r\n");
        if content.matches(&old_crlf).count() >= 1 {
            let updated = if replace_all {
                content.replace(&old_crlf, &new_crlf)
            } else {
                content.replacen(&old_crlf, &new_crlf, 1)
            };
            return write_edit(path, rel, &updated, "");
        }
        // The matched region's endings are mixed; fail clearly rather than
        // rewrite every line ending in the file.
        return (
            format!(
                "Edit failed: old_string was not found with consistent line endings.{}",
                edit_not_found_hint(content, old)
            ),
            true,
        );
    }
    // File is LF-only: the normalized replacement is already correct.
    let updated = if replace_all {
        norm_content.replace(&norm_old, new)
    } else {
        norm_content.replacen(&norm_old, new, 1)
    };
    write_edit(path, rel, &updated, "")
}

/// Best-effort hint when an Edit's old_string isn't found: list up to three
/// file lines that contain the start of old_string, so a weak model can see the
/// real text (whitespace/wording drift) and correct its next Edit.
fn edit_not_found_hint(content: &str, old: &str) -> String {
    let first = old.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let probe: String = first.chars().take(24).collect();
    if probe.chars().count() < 4 {
        return String::new();
    }
    let mut hints = Vec::new();
    for (i, line) in content.lines().enumerate() {
        if line.contains(&probe) {
            let shown: String = line.trim().chars().take(120).collect();
            hints.push(format!("  {}: {}", i + 1, shown));
            if hints.len() >= 3 {
                break;
            }
        }
    }
    if hints.is_empty() {
        String::new()
    } else {
        format!("\nClosest lines containing \"{}\":\n{}", probe, hints.join("\n"))
    }
}

fn write_edit(path: &Path, rel: &str, updated: &str, note: &str) -> (String, bool) {
    match std::fs::write(path, updated) {
        Ok(_) => (format!("Edited {}{}.", rel, note), false),
        Err(e) => (format!("Could not write {}: {}", rel, e), true),
    }
}

/// Decode a file as searchable text: handles a UTF-16 BOM (like Read) and
/// returns None for binary, so Grep skips binaries instead of silently missing
/// matches in UTF-16 files (which `read_to_string` cannot open at all).
fn read_searchable(path: &Path, max_bytes: usize) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    f.by_ref().take(max_bytes as u64).read_to_end(&mut buf).ok()?;
    if buf.len() >= 2 && ((buf[0] == 0xFF && buf[1] == 0xFE) || (buf[0] == 0xFE && buf[1] == 0xFF)) {
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
        return Some(String::from_utf16_lossy(&units));
    }
    if buf.iter().take(8000).any(|&b| b == 0) {
        return None;
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Read up to `cap` bytes of a file and decode it to text, handling UTF-16 (BOM)
/// and rejecting binary files with a clear message instead of mojibake. Returns
/// (text, truncated) where `truncated` means the file was larger than `cap`.
fn decode_capped(path: &Path, rel: &str, cap_bytes: usize) -> Result<(String, bool), String> {
    let mut f =
        std::fs::File::open(path).map_err(|e| format!("Could not read {}: {}", rel, e))?;
    let mut buf = Vec::new();
    // Read one byte past the cap so we can tell whether truncation happened.
    if f.by_ref()
        .take((cap_bytes + 1) as u64)
        .read_to_end(&mut buf)
        .is_err()
    {
        return Err(format!("Could not read {}.", rel));
    }
    let truncated = buf.len() > cap_bytes;
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
        return Ok((String::from_utf16_lossy(&units), truncated));
    }
    if buf.iter().take(8000).any(|&b| b == 0) {
        return Err(format!(
            "{} looks like a binary file and was not shown. Use Bash if you need to inspect it.",
            rel
        ));
    }
    if truncated {
        buf.truncate(cap_bytes);
    }
    Ok((String::from_utf8_lossy(&buf).into_owned(), truncated))
}

/// Read a project file. With no range, returns up to MAX_READ_BYTES from the
/// start (a too-large file is truncated with a note). With `offset`/`limit`
/// (1-based line numbers) it returns just that slice, so the model can page
/// through a large file instead of being stuck at the byte cap.
fn read_file(
    path: &Path,
    rel: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> (String, bool) {
    if offset.is_none() && limit.is_none() {
        return match decode_capped(path, rel, MAX_READ_BYTES) {
            Ok((mut content, truncated)) => {
                if truncated {
                    content.push_str(
                        "\n…[file truncated; read a specific section with offset/limit, Grep, or Bash if needed]",
                    );
                }
                (content, false)
            }
            Err(msg) => (msg, true),
        };
    }
    // Ranged read. Stream the file line-by-line so ANY offset is reachable at
    // constant memory (no whole-file buffer) — paging deep into a huge file works.
    let start = offset.unwrap_or(1).max(1);
    let take = limit.unwrap_or(usize::MAX);
    let f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return (format!("Could not read {}: {}", rel, e), true),
    };
    let mut reader = BufReader::with_capacity(64 * 1024, f);
    // Peek the head to classify before streaming bytes as UTF-8 lines.
    let (is_utf16, is_binary) = {
        let head = match reader.fill_buf() {
            Ok(b) => b,
            Err(e) => return (format!("Could not read {}: {}", rel, e), true),
        };
        let utf16 = head.len() >= 2
            && ((head[0] == 0xFF && head[1] == 0xFE) || (head[0] == 0xFE && head[1] == 0xFF));
        let binary = !utf16 && head.iter().take(8000).any(|&b| b == 0);
        (utf16, binary)
    };
    if is_utf16 {
        // Line-by-line byte streaming doesn't apply to UTF-16; decode a bounded
        // window and slice (UTF-16 files are rare and usually small).
        return match decode_capped(path, rel, MAX_RANGE_SCAN_BYTES) {
            Ok((text, scan_truncated)) => slice_lines(
                &text,
                rel,
                Some(start),
                limit,
                scan_truncated,
            ),
            Err(msg) => (msg, true),
        };
    }
    if is_binary {
        return (
            format!(
                "{} looks like a binary file and was not shown. Use Bash if you need to inspect it.",
                rel
            ),
            true,
        );
    }
    read_range_utf8(reader, rel, start, take)
}

/// Advance past one line (through the next '\n') without buffering it, so a high
/// offset can be reached at constant memory. Returns false at EOF.
fn skip_line<R: BufRead>(reader: &mut R) -> std::io::Result<bool> {
    let mut got = false;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(got);
        }
        got = true;
        if let Some(pos) = chunk.iter().position(|&b| b == b'\n') {
            reader.consume(pos + 1);
            return Ok(true);
        }
        let n = chunk.len();
        reader.consume(n);
    }
}

/// Read one line into `buf` (excluding the trailing '\n'), buffering at most `max`
/// bytes; if the line is longer, drain the remainder so the next read starts at the
/// following line. Bounds memory even for a pathologically long (e.g. minified)
/// line. Returns (got_line, truncated); got_line=false=EOF.
fn read_line_capped<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
) -> std::io::Result<(bool, bool)> {
    let mut got = false;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok((got, false));
        }
        got = true;
        if let Some(pos) = chunk.iter().position(|&b| b == b'\n') {
            let room = max.saturating_sub(buf.len());
            let n = room.min(pos);
            buf.extend_from_slice(&chunk[..n]);
            reader.consume(pos + 1);
            return Ok((true, n < pos));
        }
        let len = chunk.len();
        let room = max.saturating_sub(buf.len());
        let n = room.min(len);
        buf.extend_from_slice(&chunk[..n]);
        reader.consume(len);
        if n < len {
            // Buffer full but the line continues: drain the rest without buffering.
            loop {
                let c = reader.fill_buf()?;
                if c.is_empty() {
                    return Ok((true, true));
                }
                if let Some(p) = c.iter().position(|&b| b == b'\n') {
                    reader.consume(p + 1);
                    return Ok((true, true));
                }
                let m = c.len();
                reader.consume(m);
            }
        }
    }
}

/// Stream a UTF-8 text file to return the 1-based [start, start+take) line slice.
/// Skipped lines use constant memory and each emitted line is capped, so total
/// memory stays ~MAX_READ_BYTES while ANY offset is reachable regardless of file
/// size. Footer reports the visible range and the next offset to continue from.
fn read_range_utf8<R: BufRead>(mut reader: R, rel: &str, start: usize, take: usize) -> (String, bool) {
    let mut idx = 0usize; // 1-based number of the most recent line consumed
    // Skip lines before the window without buffering them.
    while idx + 1 < start {
        match skip_line(&mut reader) {
            Ok(true) => idx += 1,
            Ok(false) => {
                // EOF before the window: `idx` is the file's true line count.
                return (
                    format!(
                        "{}: nothing to show from line {} (the file has {} lines).",
                        rel, start, idx
                    ),
                    false,
                );
            }
            Err(e) => return (format!("Could not read {}: {}", rel, e), true),
        }
    }
    let mut out = String::new();
    let mut count = 0usize; // lines emitted into `out`
    let mut byte_capped = false;
    let mut more = false; // a line exists past the emitted window
    let mut raw: Vec<u8> = Vec::new();
    loop {
        if count >= take {
            // Is there at least one more line beyond the requested window?
            more = matches!(reader.fill_buf(), Ok(b) if !b.is_empty());
            break;
        }
        raw.clear();
        let (got, line_truncated) = match read_line_capped(&mut reader, &mut raw, MAX_READ_BYTES) {
            Ok(v) => v,
            Err(e) => return (format!("Could not read {}: {}", rel, e), true),
        };
        if !got {
            break; // EOF
        }
        idx += 1;
        // read_line_capped excluded the '\n'; trim a trailing '\r' for CRLF files.
        let mut end = raw.len();
        if end > 0 && raw[end - 1] == b'\r' {
            end -= 1;
        }
        let line = String::from_utf8_lossy(&raw[..end]);
        if line_truncated || out.len() + line.len() + 1 > MAX_READ_BYTES {
            // A single line larger than the cap would otherwise be blank; show a
            // truncated prefix so the read isn't empty.
            if out.is_empty() {
                let s: &str = &line;
                let room = MAX_READ_BYTES.saturating_sub(64);
                let mut cut = room.min(s.len());
                while cut > 0 && !s.is_char_boundary(cut) {
                    cut -= 1;
                }
                out.push_str(&s[..cut]);
                out.push('\n');
                count = 1;
            }
            byte_capped = true;
            break;
        }
        out.push_str(&line);
        out.push('\n');
        count += 1;
    }
    if count == 0 {
        return (
            format!(
                "{}: nothing to show from line {} (the file has {} lines).",
                rel, start, idx
            ),
            false,
        );
    }
    if byte_capped {
        out.push_str(
            "\n…[range truncated at the byte cap; lower limit or raise offset to continue]",
        );
    } else if more {
        out.push_str(&format!(
            "\n…[showing lines {}–{}; the file continues — read from offset {} for more]",
            start,
            start + count - 1,
            start + count
        ));
    }
    (out, false)
}

/// Return the 1-based [offset, offset+limit) line slice of `text`, capped at
/// MAX_READ_BYTES, with a footer noting the visible range (or why it was cut).
fn slice_lines(
    text: &str,
    rel: &str,
    offset: Option<usize>,
    limit: Option<usize>,
    scan_truncated: bool,
) -> (String, bool) {
    let start = offset.unwrap_or(1).max(1);
    let take = limit.unwrap_or(usize::MAX);
    let total_lines = text.lines().count();
    let mut out = String::new();
    let mut count = 0usize;
    let mut byte_capped = false;
    for line in text.lines().skip(start - 1) {
        if count >= take {
            break;
        }
        if out.len() + line.len() + 1 > MAX_READ_BYTES {
            // A single first line larger than the whole cap would otherwise yield
            // an empty result; show a truncated prefix so the read isn't blank.
            if count == 0 {
                let room = MAX_READ_BYTES.saturating_sub(64);
                let mut cut = room.min(line.len());
                while cut > 0 && !line.is_char_boundary(cut) {
                    cut -= 1;
                }
                out.push_str(&line[..cut]);
                out.push('\n');
                count = 1;
            }
            byte_capped = true;
            break;
        }
        out.push_str(line);
        out.push('\n');
        count += 1;
    }
    if count == 0 {
        return (
            format!(
                "{}: nothing to show from line {} (the read window has {} lines{}).",
                rel,
                start,
                total_lines,
                if scan_truncated { "+" } else { "" }
            ),
            false,
        );
    }
    if byte_capped {
        out.push_str("\n…[range truncated at the byte cap; lower limit or raise offset to continue]");
    } else if scan_truncated && start - 1 + count >= total_lines {
        out.push_str("\n…[end of the scanned window; the file continues beyond it — use a higher offset]");
    } else if start - 1 + count < total_lines {
        // `+` when the scan window was truncated: total_lines counts only the
        // scanned prefix, so the real file has at least that many lines.
        out.push_str(&format!(
            "\n…[showing lines {}–{} of {}{}]",
            start,
            start + count - 1,
            total_lines,
            if scan_truncated { "+" } else { "" }
        ));
    }
    (out, false)
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
                Ok(path) => {
                    // Treat 0 (and any non-positive) as "unset" — weak models often
                    // emit offset/limit 0 to mean "from the start" / "no limit".
                    let offset = args.get("offset").and_then(|v| v.as_u64()).map(|n| n as usize).filter(|&n| n > 0);
                    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize).filter(|&n| n > 0);
                    read_file(&path, fp, offset, limit)
                }
                Err(e) => (e, true),
            },
            None => ("Read requires 'file_path'.".into(), true),
        },
        "Write" => match (arg(args, "file_path"), args.get("content").and_then(|c| c.as_str())) {
            (Some(fp), Some(content)) => match resolve(project_dir, fp) {
                Ok(path) => {
                    // Refuse to truncate an existing non-empty file to nothing: a
                    // flaky model emitting empty content would otherwise silently
                    // wipe it. Creating a new (or already-empty) file is still fine.
                    if content.is_empty() {
                        if let Ok(meta) = std::fs::metadata(&path) {
                            if meta.is_file() && meta.len() > 0 {
                                return (
                                    format!(
                                        "Refusing to overwrite {} with empty content (it is {} bytes). \
                                         Use Edit to change part of it, or pass the full new contents.",
                                        fp, meta.len()
                                    ),
                                    true,
                                );
                            }
                        }
                    }
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
            let depth = args
                .get("depth")
                .and_then(|v| v.as_u64())
                .unwrap_or(1)
                .clamp(1, LS_MAX_DEPTH as u64) as usize;
            match resolve(project_dir, sub) {
                // Probe readability first so a missing dir / a file path returns a
                // clear error instead of an empty listing.
                Ok(dir) => match std::fs::read_dir(&dir) {
                    Ok(_) => (ls_tree(&dir, depth), false),
                    Err(e) => (format!("Could not list {}: {}", sub, e), true),
                },
                Err(e) => (e, true),
            }
        }
        "Grep" => match arg(args, "pattern") {
            Some(pattern) => {
                let sub = arg(args, "path").unwrap_or("");
                let glob = arg(args, "glob");
                let case_sensitive = args
                    .get("case_sensitive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                // Clamp context so a huge value can't blow up the output (the byte
                // cap still applies on top of this).
                let context = args
                    .get("context")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0)
                    .min(GREP_MAX_CONTEXT as u64) as usize;
                match resolve(project_dir, sub) {
                    Ok(root) => (
                        grep(&root, project_dir, pattern, glob, case_sensitive, context),
                        false,
                    ),
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
        other => (
            format!(
                "Unknown tool \"{}\". Available tools: Read, Write, Edit, LS, Grep, Bash, Glob. \
                 Call one of these instead.",
                other
            ),
            true,
        ),
    }
}

/// List `root` as an indented tree up to `max_depth` levels deep. Directories
/// get a trailing `/`; entries are sorted for deterministic output; recursion
/// skips hidden and EXCLUDE_DIRS directories (they are still listed, just not
/// descended into) and stops at LS_MAX_ENTRIES.
fn ls_tree(root: &Path, max_depth: usize) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut count = 0usize;
    let mut truncated = false;
    ls_walk(root, 0, max_depth, &mut out, &mut count, &mut truncated);
    if out.is_empty() {
        return "(empty directory)".to_string();
    }
    let mut s = cap(out.join("\n"), MAX_OUTPUT_BYTES);
    if truncated {
        s.push_str(&format!(
            "\n…[listing stopped at {} entries; use a sub-path or a smaller depth]",
            LS_MAX_ENTRIES
        ));
    }
    s
}

fn ls_walk(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<String>,
    count: &mut usize,
    truncated: &mut bool,
) {
    if *count >= LS_MAX_ENTRIES {
        *truncated = true;
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    // Collect and sort so the tree is deterministic regardless of FS order.
    let mut entries: Vec<std::fs::DirEntry> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    let indent = "  ".repeat(depth);
    for e in entries {
        if *count >= LS_MAX_ENTRIES {
            *truncated = true;
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|f| f.is_dir()).unwrap_or(false);
        if is_dir {
            out.push(format!("{}{}/", indent, name));
            *count += 1;
            let skip = name.starts_with('.')
                || EXCLUDE_DIRS.contains(&name.to_lowercase().as_str());
            if depth + 1 < max_depth && !skip {
                ls_walk(&e.path(), depth + 1, max_depth, out, count, truncated);
            }
        } else {
            out.push(format!("{}{}", indent, name));
            *count += 1;
        }
    }
}

fn grep(
    root: &Path,
    project_dir: &Path,
    pattern: &str,
    glob: Option<&str>,
    case_sensitive: bool,
    context: usize,
) -> String {
    let needle = if case_sensitive {
        pattern.to_string()
    } else {
        pattern.to_lowercase()
    };
    let mut out: Vec<String> = Vec::new();
    let mut matches = 0usize;
    let mut files_scanned = 0usize;
    grep_walk(
        root,
        project_dir,
        &needle,
        glob,
        case_sensitive,
        context,
        0,
        &mut out,
        &mut matches,
        &mut files_scanned,
    );
    if matches == 0 {
        format!("No matches for \"{}\".", pattern)
    } else {
        let hit_cap = matches >= GREP_MAX_HITS;
        let file_cap = files_scanned >= GREP_MAX_FILES;
        let mut s = cap(out.join("\n"), MAX_OUTPUT_BYTES);
        if hit_cap {
            s.push_str(&format!(
                "\n…[showing first {} matches; more may exist — narrow with path= or glob=]",
                GREP_MAX_HITS
            ));
        } else if file_cap {
            s.push_str(&format!(
                "\n…[scan stopped after {} files; results may be incomplete — pass path= to focus]",
                GREP_MAX_FILES
            ));
        }
        s
    }
}

/// Append one file's matches to `out`. With `context` > 0 each match is shown
/// with surrounding lines (match lines use a `:` separator, context lines a `-`,
/// like grep -C); overlapping windows merge and non-contiguous regions are split
/// by a `--` marker. With `context` == 0 this prints one `path:line: text` per
/// match. Returns the number of match lines emitted.
fn append_file_matches(
    out: &mut Vec<String>,
    rel: &str,
    lines: &[&str],
    match_idxs: &[usize],
    context: usize,
) {
    if match_idxs.is_empty() {
        return;
    }
    let n = lines.len();
    // Merge each match's [i-context, i+context] window into non-overlapping ranges.
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for &i in match_idxs {
        let start = i.saturating_sub(context);
        let end = (i + context).min(n.saturating_sub(1));
        match ranges.last_mut() {
            // Adjacent or overlapping windows merge into one contiguous region.
            Some(last) if start <= last.1 + 1 => {
                if end > last.1 {
                    last.1 = end;
                }
            }
            _ => ranges.push((start, end)),
        }
    }
    let is_match: std::collections::HashSet<usize> = match_idxs.iter().copied().collect();
    for (ri, &(start, end)) in ranges.iter().enumerate() {
        // Separate non-contiguous context regions, but only when context is shown —
        // at context=0 the output is one `path:line: text` per match (grep -C0), no
        // spurious `--` markers between non-adjacent matches.
        if ri > 0 && context > 0 {
            out.push("--".to_string());
        }
        for ln in start..=end {
            // Keep leading indentation (it conveys structure) but bound the width.
            let text: String = lines[ln].trim_end().chars().take(200).collect();
            let sep = if is_match.contains(&ln) { ':' } else { '-' };
            out.push(format!("{}{}{}{} {}", rel, sep, ln + 1, sep, text));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn grep_walk(
    dir: &Path,
    project_dir: &Path,
    needle: &str,
    glob: Option<&str>,
    case_sensitive: bool,
    context: usize,
    depth: usize,
    out: &mut Vec<String>,
    matches: &mut usize,
    files_scanned: &mut usize,
) {
    if depth > MAX_WALK_DEPTH || *matches >= GREP_MAX_HITS || *files_scanned >= GREP_MAX_FILES {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    // Sort entries so a given query produces the same output across runs (FS
    // iteration order is otherwise platform/inode dependent).
    let mut entries: Vec<std::fs::DirEntry> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if *matches >= GREP_MAX_HITS || *files_scanned >= GREP_MAX_FILES {
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
            // Skip hidden dirs (.git, .cache, .idea, …) and the explicit list.
            if name.starts_with('.') || EXCLUDE_DIRS.contains(&name.to_lowercase().as_str()) {
                continue;
            }
            grep_walk(
                &path,
                project_dir,
                needle,
                glob,
                case_sensitive,
                context,
                depth + 1,
                out,
                matches,
                files_scanned,
            );
        } else if ft.is_file() {
            // Optionally restrict to files whose name matches a glob (e.g. *.tex).
            if let Some(g) = glob {
                if !wildcard_match(&name, g) {
                    continue;
                }
            }
            // Only search reasonably-sized files.
            if entry.metadata().map(|m| m.len()).unwrap_or(0) > GREP_MAX_FILE_BYTES as u64 {
                continue;
            }
            // Decode like Read (handles UTF-16 BOM, skips binary) so Grep doesn't
            // silently miss matches in files it could otherwise open.
            if let Some(content) = read_searchable(&path, GREP_MAX_FILE_BYTES) {
                *files_scanned += 1;
                let rel = path
                    .strip_prefix(project_dir)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let lines: Vec<&str> = content.lines().collect();
                // Collect match line indices, bounded by the remaining hit budget.
                let remaining = GREP_MAX_HITS.saturating_sub(*matches);
                let mut match_idxs: Vec<usize> = Vec::new();
                for (i, line) in lines.iter().enumerate() {
                    let matched = if case_sensitive {
                        line.contains(needle)
                    } else {
                        line.to_lowercase().contains(needle)
                    };
                    if matched {
                        match_idxs.push(i);
                        if match_idxs.len() >= remaining {
                            break;
                        }
                    }
                }
                if !match_idxs.is_empty() {
                    append_file_matches(out, &rel, &lines, &match_idxs, context);
                    *matches += match_idxs.len();
                    if *matches >= GREP_MAX_HITS {
                        return;
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

/// Normalize a glob pattern: unify separators, collapse `**` to `*` (our `*`
/// already crosses `/`), and strip a leading `./`. Returns the normalized
/// pattern and whether it contains a path separator (so a path-bearing pattern
/// like `chapters/*.tex` is matched against the project-relative path, while a
/// bare `*.tex` keeps matching against the file name).
fn normalize_glob(pattern: &str) -> (String, bool) {
    let norm = pattern.replace('\\', "/");
    let norm = norm.trim_start_matches("./").to_string();
    let norm = norm.replace("**/", "*/").replace("**", "*");
    let has_sep = norm.contains('/');
    (norm, has_sep)
}

fn glob_find(root: &Path, project_dir: &Path, pattern: &str) -> String {
    let (norm, has_sep) = normalize_glob(pattern);
    let mut hits: Vec<String> = Vec::new();
    glob_walk(root, project_dir, &norm, has_sep, 0, &mut hits);
    if hits.is_empty() {
        format!("No files match \"{}\".", pattern)
    } else {
        let hit_cap = hits.len() >= GREP_MAX_HITS;
        hits.sort();
        let mut out = cap(hits.join("\n"), MAX_OUTPUT_BYTES);
        if hit_cap {
            out.push_str(&format!(
                "\n…[showing first {} files; more may exist — narrow the pattern or pass path=]",
                GREP_MAX_HITS
            ));
        }
        out
    }
}

fn glob_walk(
    dir: &Path,
    project_dir: &Path,
    pattern: &str,
    has_sep: bool,
    depth: usize,
    hits: &mut Vec<String>,
) {
    if depth > MAX_WALK_DEPTH || hits.len() >= GREP_MAX_HITS {
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
            // Skip hidden dirs (.git, .cache, .idea, …) and the explicit list.
            if name.starts_with('.') || EXCLUDE_DIRS.contains(&name.to_lowercase().as_str()) {
                continue;
            }
            glob_walk(&path, project_dir, pattern, has_sep, depth + 1, hits);
        } else if ft.is_file() {
            let rel = path
                .strip_prefix(project_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            // Path-bearing patterns match the project-relative path; bare-name
            // patterns match just the file name (preserving prior behavior).
            let target = if has_sep { rel.as_str() } else { name.as_str() };
            if wildcard_match(target, pattern) {
                hits.push(rel);
            }
        }
    }
}

/// Backstop check for a few unambiguously system-destructive commands. Kept tight
/// on purpose to avoid false positives on legitimate project commands — this is a
/// safety net for a confused model, NOT a sandbox (Bash is intentionally general).
fn is_catastrophic(command: &str) -> bool {
    let collapsed: String = command
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    // Fork bomb (any spacing).
    if collapsed.replace(' ', "").contains(":(){:|:&};:") {
        return true;
    }
    // Filesystem creation / raw write to a block device.
    if collapsed.starts_with("mkfs") || collapsed.contains(" mkfs") || collapsed.contains("of=/dev/")
    {
        return true;
    }
    // Recursive force-delete targeting a system root or home, regardless of the
    // order of flags vs. target (so `rm -rf --no-preserve-root /` is caught too).
    // Scoped to the rm invocation's own args (stop at a shell separator) to avoid
    // flagging an unrelated later command on the same line.
    let tokens: Vec<&str> = collapsed.split(' ').collect();
    let mut head = tokens.iter().copied();
    let mut cmd0 = head.next();
    while matches!(cmd0, Some("sudo") | Some("doas") | Some("env")) {
        cmd0 = head.next();
    }
    if cmd0 == Some("rm") {
        let rm_args: Vec<&str> = tokens
            .iter()
            .copied()
            .skip_while(|t| *t != "rm")
            .skip(1)
            .take_while(|t| !matches!(*t, "&&" | "||" | ";" | "|" | "&"))
            .collect();
        let short_flag = |t: &str, ch: char| {
            t.starts_with('-') && !t.starts_with("--") && t.contains(ch)
        };
        let has_r = rm_args
            .iter()
            .any(|t| *t == "--recursive" || short_flag(t, 'r'));
        let has_f = rm_args.iter().any(|t| *t == "--force" || short_flag(t, 'f'));
        let dangerous = rm_args.iter().any(|t| {
            matches!(
                *t,
                "/" | "/*" | "/." | "~" | "~/" | "$home" | "${home}" | "/home" | "/root"
                    | "/etc" | "/usr" | "/bin" | "/var" | "/lib" | "/boot" | "/sys"
            )
        });
        if has_r && has_f && dangerous {
            return true;
        }
    }
    false
}

/// Read from `reader` up to `cap` bytes; returns the bytes and whether the cap was
/// hit (more output was available). Bounds memory for a runaway command.
async fn read_capped<R>(reader: &mut R, cap: usize) -> (Vec<u8>, bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        match reader.read(&mut tmp).await {
            Ok(0) => return (buf, false),
            Ok(n) => {
                let remaining = cap.saturating_sub(buf.len());
                if remaining == 0 {
                    return (buf, true);
                }
                let take = remaining.min(n);
                buf.extend_from_slice(&tmp[..take]);
                if take < n {
                    return (buf, true);
                }
            }
            Err(_) => return (buf, false),
        }
    }
}

async fn run_bash(project_dir: &Path, command: &str) -> (String, bool) {
    // Defense-in-depth: refuse a few unambiguously catastrophic commands.
    if is_catastrophic(command) {
        return (
            "Refused: this command looks destructive to the whole system (recursive delete of \
             root/home, disk format, or fork bomb). Scope it to project files instead."
                .into(),
            true,
        );
    }

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = tokio::process::Command::new("cmd");
        // Force the console output code page to UTF-8 for THIS child so modern
        // tools (tectonic, python, git, cargo) emit UTF-8 that decodes cleanly
        // instead of OEM/ANSI mojibake. `&` (not `&&`) keeps the user command
        // running if `chcp` fails (e.g. no console attached); `>nul` hides it.
        c.arg("/C").arg(format!("chcp 65001 >nul & {}", command));
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    cmd.current_dir(project_dir);
    // Reap the child if this future is dropped (e.g. the turn is cancelled).
    cmd.kill_on_drop(true);
    // Capture streams so we can read them with a hard byte cap (see below).
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

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

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (format!("Command failed to start: {}", e), true),
    };
    let so = child.stdout.take();
    let se = child.stderr.take();

    // Read stdout+stderr concurrently, each with a hard byte cap, so a runaway
    // command can't exhaust memory. Spawn the reads so we can kill the child the
    // moment EITHER stream hits its cap — otherwise a command that floods one pipe
    // blocks the child on the full pipe and the other read would stall until the
    // timeout instead of returning promptly at the cap.
    let mut out_task = tokio::spawn(async move {
        match so {
            Some(mut r) => read_capped(&mut r, MAX_OUTPUT_BYTES).await,
            None => (Vec::new(), false),
        }
    });
    let mut err_task = tokio::spawn(async move {
        match se {
            Some(mut r) => read_capped(&mut r, MAX_OUTPUT_BYTES).await,
            None => (Vec::new(), false),
        }
    });
    let collect = async {
        let mut out = (Vec::new(), false);
        let mut err = (Vec::new(), false);
        let mut out_done = false;
        let mut err_done = false;
        while !(out_done && err_done) {
            tokio::select! {
                r = &mut out_task, if !out_done => {
                    out = r.unwrap_or((Vec::new(), false));
                    out_done = true;
                    if out.1 && !err_done {
                        let _ = child.start_kill();
                    }
                }
                r = &mut err_task, if !err_done => {
                    err = r.unwrap_or((Vec::new(), false));
                    err_done = true;
                    if err.1 && !out_done {
                        let _ = child.start_kill();
                    }
                }
            }
        }
        (out, err)
    };

    let timed = tokio::time::timeout(Duration::from_secs(BASH_TIMEOUT_SECS), collect).await;
    let ((out_bytes, out_trunc), (err_bytes, err_trunc)) = match timed {
        Ok(v) => v,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return (format!("Command timed out after {}s.", BASH_TIMEOUT_SECS), true);
        }
    };

    // If we hit the cap, stop the child so it doesn't keep running while blocked
    // on a full pipe; otherwise just reap its exit status.
    let truncated = out_trunc || err_trunc;
    if truncated {
        let _ = child.start_kill();
    }
    let status = child.wait().await.ok();

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&out_bytes));
    let stderr = String::from_utf8_lossy(&err_bytes);
    if !stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    if combined.trim().is_empty() {
        combined = "(no output)".into();
    }
    // A capped command isn't a failure of the user's intent, so don't flag
    // truncation as an error; otherwise report the child's exit status.
    let is_error = if truncated {
        false
    } else {
        status.map(|s| !s.success()).unwrap_or(true)
    };
    let mut result = cap(combined, MAX_OUTPUT_BYTES);
    if truncated {
        result.push_str(&format!(
            "\n…[output truncated at {} KB; redirect to a file and inspect a slice]",
            MAX_OUTPUT_BYTES / 1024
        ));
    }
    (result, is_error)
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
        // `*` crosses `/`, so path-bearing patterns match relative paths.
        assert!(wildcard_match("chapters/intro.tex", "*/*.tex"));
        assert!(wildcard_match("a/b/c.tex", "*/*.tex"));
        assert!(!wildcard_match("intro.tex", "chapters/*.tex"));
    }

    #[test]
    fn normalizes_globs() {
        assert_eq!(normalize_glob("*.tex"), ("*.tex".to_string(), false));
        assert_eq!(normalize_glob("**/*.tex"), ("*/*.tex".to_string(), true));
        assert_eq!(normalize_glob("./chapters/*.tex"), ("chapters/*.tex".to_string(), true));
        assert_eq!(normalize_glob("src\\*.rs"), ("src/*.rs".to_string(), true));
    }

    #[test]
    fn arg_treats_blank_as_absent() {
        let args = json!({ "a": "x", "b": "", "c": "   ", "d": 5 });
        assert_eq!(arg(&args, "a"), Some("x"));
        assert_eq!(arg(&args, "b"), None);
        assert_eq!(arg(&args, "c"), None);
        assert_eq!(arg(&args, "d"), None);
        assert_eq!(arg(&args, "missing"), None);
    }

    #[test]
    fn edit_rejects_empty_and_noop() {
        // Empty old_string is rejected (would otherwise corrupt the file).
        let (msg, err) = apply_edit(Path::new("/nope"), "f.txt", "abc", "", "X", true);
        assert!(err);
        assert!(msg.contains("must not be empty"));
        // old == new is a no-op and reported as an error so the dedup cache holds.
        let (msg, err) = apply_edit(Path::new("/nope"), "f.txt", "abc", "a", "a", false);
        assert!(err);
        assert!(msg.contains("no change"));
    }

    #[tokio::test]
    async fn write_refuses_to_empty_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("keep.tex"), "important").unwrap();

        // Empty content over a non-empty file is refused; the file is untouched.
        let (msg, err) =
            execute(root, "Write", &json!({ "file_path": "keep.tex", "content": "" })).await;
        assert!(err);
        assert!(msg.contains("Refusing to overwrite"));
        assert_eq!(
            std::fs::read_to_string(root.join("keep.tex")).unwrap(),
            "important"
        );

        // Writing real content still works.
        let (_m, err) =
            execute(root, "Write", &json!({ "file_path": "keep.tex", "content": "new" })).await;
        assert!(!err);
        assert_eq!(std::fs::read_to_string(root.join("keep.tex")).unwrap(), "new");

        // Creating a brand-new empty file is still allowed.
        let (_m, err) =
            execute(root, "Write", &json!({ "file_path": "fresh.txt", "content": "" })).await;
        assert!(!err);
        assert!(root.join("fresh.txt").exists());
    }

    #[test]
    fn catastrophic_commands_are_refused() {
        assert!(is_catastrophic("rm -rf /"));
        assert!(is_catastrophic("rm -rf / --no-preserve-root"));
        // Flag BEFORE the target must still be caught.
        assert!(is_catastrophic("rm -rf --no-preserve-root /"));
        assert!(is_catastrophic("rm --recursive --force /"));
        assert!(is_catastrophic("sudo rm -rf /"));
        assert!(is_catastrophic("rm -rf ~"));
        assert!(is_catastrophic("rm -rf /usr"));
        assert!(is_catastrophic(":(){ :|:& };:"));
        assert!(is_catastrophic("sudo mkfs.ext4 /dev/sda1"));
        assert!(is_catastrophic("dd if=/dev/zero of=/dev/sda"));
        // Legitimate project commands are NOT flagged.
        assert!(!is_catastrophic("rm -rf build"));
        assert!(!is_catastrophic("rm -rf ./dist"));
        assert!(!is_catastrophic("rm -rf ~/.cache/devprism"));
        assert!(!is_catastrophic("uv run python main.py"));
        // A dangerous-looking later command must not taint an innocent rm.
        assert!(!is_catastrophic("rm file && echo -rf /"));
    }

    #[test]
    fn edit_hint_points_at_near_matches() {
        let content = "function greet(name) {\n  return 'hi ' + name;\n}\n";
        // old_string differs on line 2 (quotes), so it isn't found; the hint should
        // surface the real first line so the model can copy the exact text.
        let hint = edit_not_found_hint(content, "function greet(name) {\n  return \"hi \" + name;\n}");
        assert!(hint.contains("function greet(name)"));
        // A too-short probe yields no hint (avoids noise).
        assert_eq!(edit_not_found_hint(content, "fn"), "");
    }

    #[test]
    fn edit_crlf_fallback_preserves_lone_lf() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("mixed.txt");
        let content = "alpha\r\nbeta\ngamma\r\n"; // the beta line ends in a lone LF
        std::fs::write(&p, content).unwrap();
        // old_string uses LF; the file's first boundary is CRLF (exact match fails).
        let (_m, err) = apply_edit(&p, "mixed.txt", content, "alpha\nbeta", "alpha\nBETA", false);
        assert!(!err);
        let after = std::fs::read_to_string(&p).unwrap();
        // The untouched lone LF after BETA is preserved (old code forced CRLF).
        assert!(after.contains("BETA\ngamma"), "got: {:?}", after);
        assert!(after.contains("gamma\r\n"));
    }

    #[test]
    fn slice_lines_returns_requested_range() {
        let text = "l1\nl2\nl3\nl4\nl5\n";
        // Middle slice: lines 2..=3 only.
        let (out, err) = slice_lines(text, "f.txt", Some(2), Some(2), false);
        assert!(!err);
        assert!(out.contains("l2") && out.contains("l3"));
        assert!(!out.contains("l1"));
        // Assert around the dash to stay independent of the exact dash glyph.
        assert!(out.contains("showing lines 2") && out.contains("of 5"));

        // Offset past the end reports nothing to show (not an error).
        let (out2, err2) = slice_lines(text, "f.txt", Some(99), None, false);
        assert!(!err2);
        assert!(out2.contains("nothing to show"));

        // Offset alone reads to the end with no truncation footer.
        let (out3, _) = slice_lines(text, "f.txt", Some(4), None, false);
        assert!(out3.contains("l4") && out3.contains("l5"));
        assert!(!out3.contains("showing lines"));
    }

    #[tokio::test]
    async fn read_supports_offset_and_limit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let body: String = (1..=200).map(|i| format!("line{i}\n")).collect();
        std::fs::write(root.join("big.txt"), &body).unwrap();

        let (out, err) = execute(
            root,
            "Read",
            &json!({ "file_path": "big.txt", "offset": 100, "limit": 3 }),
        )
        .await;
        assert!(!err);
        assert!(out.contains("line100") && out.contains("line102"));
        assert!(!out.contains("line99"));
        assert!(!out.contains("line103"));

        // offset 0 is treated as "from the start" rather than an empty range.
        let (out2, _) = execute(
            root,
            "Read",
            &json!({ "file_path": "big.txt", "offset": 0, "limit": 1 }),
        )
        .await;
        assert!(out2.contains("line1\n"));
    }

    #[tokio::test]
    async fn read_reaches_offset_past_the_scan_window() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // >1 MB of text, so the target line sits well past the old fixed-byte scan
        // window; line streaming must still reach it (the whole point of the fix).
        let body: String = (1..=200_000).map(|i| format!("line{i}\n")).collect();
        assert!(
            body.len() > MAX_RANGE_SCAN_BYTES,
            "fixture must exceed the scan window"
        );
        std::fs::write(root.join("huge.txt"), &body).unwrap();

        let (out, err) = execute(
            root,
            "Read",
            &json!({ "file_path": "huge.txt", "offset": 150_000, "limit": 2 }),
        )
        .await;
        assert!(!err);
        assert!(out.contains("line150000\n"), "high offset should be reachable");
        assert!(out.contains("line150001\n"));
        assert!(!out.contains("line149999\n"));
    }

    #[tokio::test]
    async fn read_bounds_a_huge_single_line() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // A 5 MB line with no newline, then a normal line.
        let mut data = vec![b'x'; 5 * 1024 * 1024];
        data.push(b'\n');
        data.extend_from_slice(b"next line\n");
        std::fs::write(root.join("oneline.txt"), &data).unwrap();

        // Reading the giant line returns a bounded, truncated result (not 5 MB).
        let (out, err) = execute(
            root,
            "Read",
            &json!({ "file_path": "oneline.txt", "offset": 1, "limit": 1 }),
        )
        .await;
        assert!(!err);
        assert!(out.len() <= MAX_READ_BYTES + 128, "output not bounded: {}", out.len());
        assert!(out.contains("range truncated at the byte cap"));

        // The following line is still reachable past the giant line.
        let (out2, _) = execute(
            root,
            "Read",
            &json!({ "file_path": "oneline.txt", "offset": 2, "limit": 1 }),
        )
        .await;
        assert!(out2.starts_with("next line\n"), "got: {:?}", out2);
    }

    #[tokio::test]
    async fn grep_context_windows_and_separator() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // One file with two matches far enough apart that their ±1 windows don't
        // merge, so a `--` separator must appear between the two regions.
        std::fs::write(root.join("a.txt"), "FOO\nx\nx\nx\nx\nx\nFOO\n").unwrap();

        let (out, err) =
            execute(root, "Grep", &json!({ "pattern": "FOO", "context": 1 })).await;
        assert!(!err);
        assert!(out.contains("a.txt:1: FOO")); // match line uses ':'
        assert!(out.contains("a.txt:7: FOO"));
        assert!(out.contains("a.txt-2- x")); // context line uses '-'
        assert!(out.contains("a.txt-6- x"));
        assert!(out.contains("--")); // distinct regions separated

        // No context: just the match lines — no separator, no context lines.
        let (out2, _) = execute(root, "Grep", &json!({ "pattern": "FOO" })).await;
        assert!(out2.contains("a.txt:1: FOO") && out2.contains("a.txt:7: FOO"));
        assert!(!out2.contains("--"));
        assert!(!out2.contains("- x"));

        // No matches still reports cleanly.
        let (out3, err3) = execute(root, "Grep", &json!({ "pattern": "zzz" })).await;
        assert!(!err3);
        assert!(out3.contains("No matches"));
    }

    #[tokio::test]
    async fn ls_lists_recursively_with_depth() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src/sub")).unwrap();
        std::fs::write(root.join("top.txt"), "x").unwrap();
        std::fs::write(root.join("src/a.rs"), "x").unwrap();
        std::fs::write(root.join("src/sub/b.rs"), "x").unwrap();

        // Depth 1 (default): top level only; directories marked with '/'.
        let (out1, err1) = execute(root, "LS", &json!({})).await;
        assert!(!err1);
        assert!(out1.contains("top.txt"));
        assert!(out1.contains("src/"));
        assert!(!out1.contains("a.rs")); // did not recurse

        // Depth 3: recurses with two-space-per-level indentation.
        let (out3, _) = execute(root, "LS", &json!({ "depth": 3 })).await;
        assert!(out3.contains("src/"));
        assert!(out3.contains("  a.rs")); // one level deep
        assert!(out3.contains("    b.rs")); // two levels deep

        // A missing directory reports an error (not an empty listing).
        let (_m, err) = execute(root, "LS", &json!({ "path": "nope" })).await;
        assert!(err);
    }
}
