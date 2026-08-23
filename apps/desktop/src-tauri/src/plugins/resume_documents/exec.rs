//! Execution for the resume-documents pack. Declarations live in the parent.

use crate::plugins::path_guard::{atomic_write, backup_file, canonicalize_existing, confine, sha1_hex};
use crate::plugins::PluginContext;
use crate::career_db::{self, KnownProject};
use crate::mcp::protocol::{
    InputRequest, InputRequiredResult, JsonRpcError, ERR_ELICITATION_FAILED,
};
use crate::variants;
use base64::prelude::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

// --- Input bounds (arguments are hostile; JSON Schemas are advisory) ---

/// Largest file these tools will read or write.
pub(crate) const MAX_DOC_BYTES: usize = 1024 * 1024;
/// Most entries returned by one file listing.
const MAX_LIST_ENTRIES: usize = 2_000;
/// Maximum walk depth for listings / main-source discovery.
const MAX_WALK_DEPTH: usize = 16;
/// Most edits in one `resume_doc_edit` call.
const MAX_EDITS_PER_CALL: usize = 100;
/// Longest single old_string/new_string accepted.
const MAX_EDIT_FIELD_CHARS: usize = 64 * 1024;
/// A non-trivial prior file shrinking past half needs `allow_major_reduction`.
const MAJOR_REDUCTION_MIN_PRIOR_BYTES: usize = 200;

/// Text file extensions these tools may create or modify. Binary assets
/// (images, fonts) belong to the desktop app, not an agent loop.
const WRITABLE_EXTENSIONS: &[&str] = &[
    "typ", "tex", "md", "txt", "json", "yaml", "yml", "bib", "cls", "sty", "csv",
];

/// Directories never listed or searched for sources.
const EXCLUDED_DIRS: &[&str] = &[
    ".git", ".prism", ".claudeprism", ".gitnexus", ".claude", ".devcouncil",
    "node_modules", "target", "dist", "build", ".venv",
];

// --- Argument helpers ---

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| JsonRpcError::invalid_params(format!("Missing required '{key}'")))
}

fn optional_str(args: &Value, key: &str) -> Result<Option<String>, JsonRpcError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_str()
            .map(|s| Some(s.to_string()))
            .ok_or_else(|| JsonRpcError::invalid_params(format!("'{key}' must be a string"))),
    }
}

fn optional_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn normalise_sha(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

/// Test helper mirroring what `resume_doc_read` reports as `sha1`.
#[cfg(test)]
pub(crate) fn tests_sha_of(content: &str) -> String {
    sha1_hex(content.as_bytes())
}

// --- Known-project gate ---

/// Resolve `project_root` to a canonical path proven to belong to a registered
/// project (or a variant of one). Anything else is refused: these tools may
/// only touch folders DevPrism itself has seen.
fn resolve_known_project_blocking(
    db: &career_db::CareerDbState,
    raw: &str,
) -> Result<PathBuf, JsonRpcError> {
    let known: Vec<KnownProject> = db
        .with_conn(career_db::list_known_projects_blocking)
        .map_err(JsonRpcError::internal_error)?;

    if known.is_empty() {
        return Err(JsonRpcError::invalid_params(
            "No projects are registered with DevPrism yet. Open a project in the desktop app \
             once; it then becomes available to every agent.",
        ));
    }

    let target = canonicalize_existing(Path::new(raw)).ok_or_else(|| {
        JsonRpcError::invalid_params(format!("project_root '{raw}' does not exist on disk"))
    })?;

    for k in &known {
        if let Some(c) = canonicalize_existing(Path::new(&k.path)) {
            if same_path(&target, &c) || starts_with_path(&target, &c) {
                return Ok(target);
            }
        }
    }

    // The passed path may be a variant whose OWNER is registered even when the
    // variant folder itself was never opened as a project.
    let raw_path = Path::new(raw);
    let derived_owner = variants::derive_owner_root(raw);
    if derived_owner != raw_path {
        if let Some(owner_canon) = canonicalize_existing(&derived_owner) {
            for k in &known {
                if let Some(c) = canonicalize_existing(Path::new(&k.path)) {
                    if same_path(&owner_canon, &c) {
                        return Ok(target);
                    }
                }
            }
        }
    }

    Err(JsonRpcError::invalid_params(format!(
        "'{raw}' is not a project DevPrism knows. Call resume_doc_list_projects for the \
         registered roots, or open the project in the desktop app once."
    )))
}

async fn resolve_known_project(
    ctx: &PluginContext,
    args: &Value,
) -> Result<PathBuf, JsonRpcError> {
    let raw = require_str(args, "project_root")?.to_string();
    let db = ctx.career_db.clone();
    tokio::task::spawn_blocking(move || resolve_known_project_blocking(&db, &raw))
        .await
        .map_err(|e| JsonRpcError::internal_error(format!("project resolution task error: {e}")))?
}

fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    #[cfg(not(target_os = "linux"))]
    {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }
    #[cfg(target_os = "linux")]
    false
}

fn starts_with_path(path: &Path, base: &Path) -> bool {
    if path.starts_with(base) {
        return true;
    }
    #[cfg(not(target_os = "linux"))]
    {
        path.to_string_lossy()
            .to_lowercase()
            .starts_with(&base.to_string_lossy().to_lowercase())
    }
    #[cfg(target_os = "linux")]
    false
}

// --- File helpers ---

fn check_writable_ext(path: &Path) -> Result<(), JsonRpcError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext {
        Some(e) if WRITABLE_EXTENSIONS.contains(&e.as_str()) => Ok(()),
        other => Err(JsonRpcError::invalid_params(format!(
            "Only text sources may be written through MCP ({:?}); got '{}'. Binary assets \
             belong in the desktop app.",
            WRITABLE_EXTENSIONS,
            other.unwrap_or_else(|| "(none)".to_string())
        ))),
    }
}

/// Read a bounded UTF-8 document; returns `(content, sha1)`.
fn read_doc(path: &Path) -> Result<(String, String), JsonRpcError> {
    let meta = std::fs::metadata(path)
        .map_err(|e| JsonRpcError::invalid_params(format!("Cannot access file: {e}")))?;
    if !meta.is_file() {
        return Err(JsonRpcError::invalid_params(
            "Path is not a regular file (directories are listed with resume_doc_list_files).",
        ));
    }
    if meta.len() as usize > MAX_DOC_BYTES {
        return Err(JsonRpcError::invalid_params(format!(
            "File is {} bytes; this tool reads/writes at most {MAX_DOC_BYTES} bytes.",
            meta.len()
        )));
    }
    let content = std::fs::read_to_string(path).map_err(|e| {
        JsonRpcError::invalid_params(format!(
            "File could not be read as UTF-8 text ({e}); binary files are out of scope."
        ))
    })?;
    let sha = sha1_hex(content.as_bytes());
    Ok((content, sha))
}

/// Refuse a change that silently deletes most of a non-trivial file unless the
/// caller explicitly acknowledges it.
fn guard_major_reduction(
    prior_len: usize,
    next_len: usize,
    allowed: bool,
) -> Result<(), JsonRpcError> {
    if allowed || prior_len < MAJOR_REDUCTION_MIN_PRIOR_BYTES {
        return Ok(());
    }
    if next_len * 2 < prior_len {
        return Err(JsonRpcError::invalid_params(format!(
            "Refused: this change would shrink the file from {prior_len} to {next_len} bytes \
             (over half). If that is intended, pass allow_major_reduction=true."
        )));
    }
    Ok(())
}

/// One exact-string edit, applied in memory. Returns the new text and how many
/// occurrences were replaced.
fn apply_one_edit(
    content: &str,
    old: &str,
    new: &str,
    replace_all: bool,
) -> Result<(String, usize), String> {
    if old.is_empty() {
        return Err("old_string must not be empty".to_string());
    }
    let mut hits: Vec<usize> = Vec::new();
    let mut search_from = 0usize;
    while let Some(rel) = content[search_from..].find(old) {
        let abs = search_from + rel;
        hits.push(abs);
        search_from = abs + old.len();
    }
    if hits.is_empty() {
        // Show the caller a short tail of what the region looks like now, so a
        // stale context is visible without re-reading the whole file.
        let hint = content
            .lines()
            .next()
            .map(|l| {
                let head: String = l.chars().take(60).collect();
                format!(" File starts with: \"{head}\"")
            })
            .unwrap_or_default();
        return Err(format!("old_string not found{hint}"));
    }
    if hits.len() > 1 && !replace_all {
        return Err(format!(
            "old_string matched {} times; add surrounding context to make it unique, or pass \
             replace_all=true",
            hits.len()
        ));
    }
    let replaced_count = hits.len();

    let mut out = String::with_capacity(content.len());
    let mut last = 0usize;
    for abs in hits {
        out.push_str(&content[last..abs]);
        out.push_str(new);
        last = abs + old.len();
    }
    out.push_str(&content[last..]);
    Ok((out, replaced_count))
}

/// Deterministic main-source discovery, mirroring the frontend's
/// `findMainSource` (main/document/resume preferred, then first alphabetically).
pub(crate) fn find_main_source(root: &Path) -> Option<PathBuf> {
    let mut typ_files: Vec<PathBuf> = Vec::new();
    collect_typ_files(root, 0, &mut typ_files);
    typ_files.sort();
    const STEMS: &[&str] = &["main", "document", "resume"];
    for stem in STEMS {
        let at_root = format!("{stem}.typ");
        if let Some(hit) = typ_files
            .iter()
            .find(|p| p.file_name().is_some_and(|n| n == std::ffi::OsStr::new(&at_root)))
        {
            return Some(hit.clone());
        }
    }
    for stem in STEMS {
        let suffix = format!("/{stem}.typ");
        if let Some(hit) = typ_files
            .iter()
            .find(|p| p.to_string_lossy().ends_with(&suffix))
        {
            return Some(hit.clone());
        }
    }
    typ_files.into_iter().next()
}

fn collect_typ_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_WALK_DEPTH || out.len() >= MAX_LIST_ENTRIES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || EXCLUDED_DIRS.contains(&name.as_ref()) {
                continue;
            }
            collect_typ_files(&path, depth + 1, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("typ") {
            out.push(path);
        }
    }
}

fn list_source_files(root: &Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    list_inner(root, root, 0, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.truncate(MAX_LIST_ENTRIES);
    out
}

fn list_inner(root: &Path, dir: &Path, depth: usize, out: &mut Vec<(String, u64)>) {
    if depth > MAX_WALK_DEPTH || out.len() >= MAX_LIST_ENTRIES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || EXCLUDED_DIRS.contains(&name.as_ref()) {
                continue;
            }
            list_inner(root, &path, depth + 1, out);
        } else if let Ok(rel) = path.strip_prefix(root) {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push((rel.to_string_lossy().replace('\\', "/"), size));
        }
    }
}

// --- Dispatcher ---

pub async fn execute(ctx: &PluginContext, name: &str, args: &Value) -> Result<Value, JsonRpcError> {
    match name {
        "resume_doc_list_projects" => list_projects(ctx).await,
        "resume_doc_list_files" => list_files(ctx, args).await,
        "resume_doc_read" => read(ctx, args).await,
        "resume_doc_write" => write(ctx, args).await,
        "resume_doc_edit" => edit(ctx, args).await,
        "resume_variant_list" => variant_list(ctx, args).await,
        "resume_variant_create" => variant_create(ctx, args).await,
        "resume_variant_update" => variant_update(ctx, args).await,
        "resume_variant_delete" => variant_delete(ctx, args).await,
        "resume_variant_diff" => variant_diff(ctx, args).await,
        "resume_compile_file" => compile_file(ctx, args).await,
        "resume_save_synthesis" => save_synthesis(ctx, args).await,
        _ => Err(JsonRpcError::method_not_found(name)),
    }
}

async fn list_projects(ctx: &PluginContext) -> Result<Value, JsonRpcError> {
    let db = ctx.career_db.clone();
    tokio::task::spawn_blocking(move || db.with_conn(career_db::list_known_projects_blocking))
        .await
        .map_err(|e| JsonRpcError::internal_error(e.to_string()))?
        .map(|projects| json!({ "projects": projects, "count": projects.len() }))
        .map_err(JsonRpcError::internal_error)
}

async fn list_files(ctx: &PluginContext, args: &Value) -> Result<Value, JsonRpcError> {
    let root = resolve_known_project(ctx, args).await?;
    let files = tokio::task::spawn_blocking(move || list_source_files(&root))
        .await
        .map_err(|e| JsonRpcError::internal_error(e.to_string()))?;
    let truncated = files.len() >= MAX_LIST_ENTRIES;
    let count = files.len();
    Ok(json!({
        "files": files.iter().map(|(rel, size)| json!({
            "path": rel, "bytes": size,
        })).collect::<Vec<_>>(),
        "count": count,
        "truncated": truncated,
    }))
}

async fn read(ctx: &PluginContext, args: &Value) -> Result<Value, JsonRpcError> {
    let root = resolve_known_project(ctx, args).await?;
    let rel = require_str(args, "file_path")?.to_string();
    let path = confine(&root, &rel).map_err(JsonRpcError::invalid_params)?;
    let (content, sha) = tokio::task::spawn_blocking(move || read_doc(&path))
        .await
        .map_err(|e| JsonRpcError::internal_error(e.to_string()))??;
    let bytes = content.len();
    let total_lines = content.lines().count();
    Ok(json!({
        "content": content,
        "sha1": sha,
        "bytes": bytes,
        "totalLines": total_lines,
    }))
}

async fn write(ctx: &PluginContext, args: &Value) -> Result<Value, JsonRpcError> {
    let root = resolve_known_project(ctx, args).await?;
    let rel = require_str(args, "file_path")?.to_string();
    let content = require_str(args, "content")?.to_string();
    if content.len() > MAX_DOC_BYTES {
        return Err(JsonRpcError::invalid_params(format!(
            "content is {} bytes; limit is {MAX_DOC_BYTES}",
            content.len()
        )));
    }
    let expected_sha1 = optional_str(args, "expected_sha1")?;
    let allow_major_reduction = optional_bool(args, "allow_major_reduction");

    let path = confine(&root, &rel).map_err(JsonRpcError::invalid_params)?;
    check_writable_ext(&path)?;
    let content_len = content.len();

    struct WriteOutcome {
        created: bool,
        backup: Option<String>,
    }

    let new_sha = sha1_hex(content.as_bytes());

    let outcome = tokio::task::spawn_blocking(move || -> Result<WriteOutcome, JsonRpcError> {
        let existed = match std::fs::metadata(&path) {
            Ok(_) => true,
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(ref e) if e.kind() == std::io::ErrorKind::NotADirectory => {
                return Err(JsonRpcError::invalid_params(
                    "Parent directory does not exist.",
                ));
            }
            Err(e) => return Err(JsonRpcError::internal_error(e.to_string())),
        };

        let mut backup_path = None;
        if existed {
            let (_prior, prior_sha) = read_doc(&path)?;
            let Some(given) = &expected_sha1 else {
                return Err(JsonRpcError::invalid_params(format!(
                    "File already exists; refusing blind overwrite. Pass \
                     expected_sha1=\"{prior_sha}\" from resume_doc_read (re-read if your copy \
                     may be stale)."
                )));
            };
            if normalise_sha(given) != prior_sha {
                return Err(JsonRpcError::invalid_params(format!(
                    "expected_sha1 mismatch: the file changed since your read. Current sha1 is \
                     \"{prior_sha}\"; re-read before writing."
                )));
            }
            let prior_len = std::fs::metadata(&path)
                .map(|m| m.len() as usize)
                .unwrap_or(0);
            guard_major_reduction(prior_len, content.len(), allow_major_reduction)?;
            backup_path = Some(backup_file(&root, &path).map_err(JsonRpcError::internal_error)?);
        }

        atomic_write(&path, content.as_bytes()).map_err(JsonRpcError::internal_error)?;
        Ok(WriteOutcome {
            created: !existed,
            backup: backup_path.map(|p| p.to_string_lossy().to_string()),
        })
    })
    .await
    .map_err(|e| JsonRpcError::internal_error(e.to_string()))??;

    Ok(json!({
        "created": outcome.created,
        "sha1": new_sha,
        "bytes": content_len,
        "backedUpTo": outcome.backup,
        "relativePath": rel,
    }))
}

async fn edit(ctx: &PluginContext, args: &Value) -> Result<Value, JsonRpcError> {
    let root = resolve_known_project(ctx, args).await?;
    let rel = require_str(args, "file_path")?.to_string();
    let expected_sha1 = require_str(args, "expected_sha1")?.to_string();
    let allow_major_reduction = optional_bool(args, "allow_major_reduction");

    let edits_val = args
        .get("edits")
        .and_then(|v| v.as_array())
        .ok_or_else(|| JsonRpcError::invalid_params("Missing 'edits' array"))?;
    if edits_val.is_empty() {
        return Err(JsonRpcError::invalid_params("'edits' is empty"));
    }
    if edits_val.len() > MAX_EDITS_PER_CALL {
        return Err(JsonRpcError::invalid_params(format!(
            "{} edits exceed the {MAX_EDITS_PER_CALL}-per-call limit; batch across calls",
            edits_val.len()
        )));
    }
    struct ParsedEdit {
        old: String,
        new: String,
        replace_all: bool,
    }
    let mut edits: Vec<ParsedEdit> = Vec::with_capacity(edits_val.len());
    for (i, e) in edits_val.iter().enumerate() {
        let old = e
            .get("old_string")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                JsonRpcError::invalid_params(format!("edits[{i}] needs a non-empty 'old_string'"))
            })?;
        let new = e
            .get("new_string")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                JsonRpcError::invalid_params(format!("edits[{i}] needs 'new_string'"))
            })?;
        if old.len() > MAX_EDIT_FIELD_CHARS || new.len() > MAX_EDIT_FIELD_CHARS {
            return Err(JsonRpcError::invalid_params(format!(
                "edits[{i}] exceeds the {MAX_EDIT_FIELD_CHARS}-char field limit"
            )));
        }
        edits.push(ParsedEdit {
            old: old.to_string(),
            new: new.to_string(),
            replace_all: e
                .get("replace_all")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        });
    }

    let path = confine(&root, &rel).map_err(JsonRpcError::invalid_params)?;
    check_writable_ext(&path)?;

    struct EditOutcome {
        original_len: usize,
        final_len: usize,
        final_sha: String,
        applied: Vec<Value>,
        backup: String,
    }

    let outcome = tokio::task::spawn_blocking(move || -> Result<EditOutcome, JsonRpcError> {
        let (original, current_sha) = read_doc(&path)?;
        if normalise_sha(&expected_sha1) != current_sha {
            return Err(JsonRpcError::invalid_params(format!(
                "expected_sha1 mismatch: the file changed since your read. Current sha1 is \
                 \"{current_sha}\"; re-read before editing."
            )));
        }
        let original_len = original.len();

        let mut working = original.clone();
        let mut applied: Vec<Value> = Vec::with_capacity(edits.len());
        for (i, e) in edits.iter().enumerate() {
            match apply_one_edit(&working, &e.old, &e.new, e.replace_all) {
                Ok((next, _)) => {
                    working = next;
                    applied.push(json!({ "index": i, "applied": true }));
                }
                Err(reason) => {
                    return Err(JsonRpcError::invalid_params(format!(
                        "All-or-nothing: edit {i} failed ({reason}); no changes were written."
                    )));
                }
            }
        }

        guard_major_reduction(original_len, working.len(), allow_major_reduction)?;

        let backup =
            backup_file(&root, &path).map_err(JsonRpcError::internal_error)?;
        let final_sha = sha1_hex(working.as_bytes());
        atomic_write(&path, working.as_bytes()).map_err(JsonRpcError::internal_error)?;

        Ok(EditOutcome {
            original_len,
            final_len: working.len(),
            final_sha,
            applied,
            backup: backup.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| JsonRpcError::internal_error(e.to_string()))??;

    Ok(json!({
        "appliedEdits": outcome.applied,
        "totalEdits": outcome.applied.len(),
        "bytesBefore": outcome.original_len,
        "bytesAfter": outcome.final_len,
        "sha1": outcome.final_sha,
        "backedUpTo": outcome.backup,
    }))
}

// --- Variant tools ---

async fn variant_list(ctx: &PluginContext, args: &Value) -> Result<Value, JsonRpcError> {
    let root = resolve_known_project(ctx, args).await?;
    tokio::task::spawn_blocking(move || variants::list_variants_blocking(&root.to_string_lossy()))
        .await
        .map_err(|e| JsonRpcError::internal_error(e.to_string()))?
        .map(|list| json!({ "variants": list, "count": list.len() }))
        .map_err(JsonRpcError::internal_error)
}

async fn variant_create(ctx: &PluginContext, args: &Value) -> Result<Value, JsonRpcError> {
    let root = resolve_known_project(ctx, args).await?;
    let name = require_str(args, "name")?.to_string();
    let jd = optional_str(args, "jd_text")?.unwrap_or_default();
    let status = optional_str(args, "status")?.unwrap_or_default();
    if name.len() > 200 {
        return Err(JsonRpcError::invalid_params(
            "name exceeds 200 characters".to_string(),
        ));
    }
    if jd.len() > MAX_DOC_BYTES {
        return Err(JsonRpcError::invalid_params(format!(
            "jd_text is {} bytes; limit is {MAX_DOC_BYTES}",
            jd.len()
        )));
    }
    tokio::task::spawn_blocking(
        move || variants::create_variant_blocking(&root.to_string_lossy(), &name, &jd, &status),
    )
    .await
    .map_err(|e| JsonRpcError::internal_error(e.to_string()))?
    .map(|v| json!({ "variant": v }))
    .map_err(JsonRpcError::internal_error)
}

async fn variant_update(ctx: &PluginContext, args: &Value) -> Result<Value, JsonRpcError> {
    let root = resolve_known_project(ctx, args).await?;
    let variant_id = require_str(args, "variant_id")?.to_string();
    if variant_id.len() > 128 || !variants_is_safe_id(&variant_id) {
        return Err(JsonRpcError::invalid_params("Invalid 'variant_id'"));
    }
    let name = optional_str(args, "name")?;
    let status = optional_str(args, "status")?;
    let jd = optional_str(args, "jd_text")?;

    // The underlying update treats empty strings as "keep current"; a caller
    // asking for an empty name would silently no-op, so surface that instead.
    for (label, val) in [("name", &name), ("status", &status)] {
        if let Some(v) = val {
            if v.trim().is_empty() {
                return Err(JsonRpcError::invalid_params(format!(
                    "'{label}' must not be blank"
                )));
            }
        }
    }

    tokio::task::spawn_blocking(move || {
        variants::update_variant_blocking(&root.to_string_lossy(), &variant_id, name, status, jd)
    })
    .await
    .map_err(|e| JsonRpcError::internal_error(e.to_string()))?
    .map(|v| json!({ "variant": v }))
    .map_err(JsonRpcError::internal_error)
}

/// Local re-check mirroring `variants::is_safe_id` so hostile ids are refused
/// before they ever reach the filesystem layer.
fn variants_is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains('\0')
}

async fn variant_delete(ctx: &PluginContext, args: &Value) -> Result<Value, JsonRpcError> {
    let root = resolve_known_project(ctx, args).await?;
    let variant_id = require_str(args, "variant_id")?.to_string();
    if !variants_is_safe_id(&variant_id) {
        return Err(JsonRpcError::invalid_params("Invalid 'variant_id'"));
    }

    let owner = variants::derive_owner_root(&root.to_string_lossy());
    // The confirmation subject binds the exact deletion being approved — same
    // discipline as the payload digest on `career_upsert_block`.
    let subject = sha1_hex(format!("{}::{variant_id}", owner.to_string_lossy()).as_bytes());
    const TOOL: &str = "resume_variant_delete";

    match optional_str(args, "request_state")? {
        Some(state_str) => {
            let state_val = InputRequiredResult::decode_state(&state_str)
                .map_err(|e| JsonRpcError::new(ERR_ELICITATION_FAILED, e))?;
            let nonce = InputRequiredResult::nonce_from_state(&state_val).ok_or_else(|| {
                JsonRpcError::new(
                    ERR_ELICITATION_FAILED,
                    "requestState is not bound to a server-issued confirmation",
                )
            })?;
            ctx.elicitations
                .consume(nonce, TOOL, &subject)
                .map_err(|rejection| {
                    JsonRpcError::with_data(
                        ERR_ELICITATION_FAILED,
                        rejection.detail(),
                        json!({ "variantId": variant_id }),
                    )
                })?;

            let confirmed = args
                .get("input_responses")
                .and_then(|r| r.get("confirm"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !confirmed {
                return Ok(json!({
                    "cancelled": true,
                    "message": "Variant deletion was cancelled by the user",
                }));
            }

            let root2 = root.clone();
            let deleted_variant_id = variant_id.clone();
            tokio::task::spawn_blocking(move || {
                variants::delete_variant_blocking(&root2.to_string_lossy(), &variant_id)
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(e.to_string()))?
            .map_err(JsonRpcError::internal_error)?;

            Ok(json!({ "deleted": true, "variantId": deleted_variant_id }))
        }
        None => {
            // Fail loud before spending a confirmation round trip on a
            // variant that does not exist.
            let info = tokio::task::spawn_blocking({
                let root2 = root.clone();
                let id = variant_id.clone();
                move || variants::list_variants_blocking(&root2.to_string_lossy())
                    .map(|all| all.into_iter().find(|v| v.id == id))
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(e.to_string()))?
            .map_err(JsonRpcError::internal_error)?;
            let Some(v) = info else {
                return Err(JsonRpcError::invalid_params(format!(
                    "Variant '{variant_id}' does not exist; call resume_variant_list for ids."
                )));
            };
            let display = format!("'{}' ({})", v.name, v.path);

            let mut requests = std::collections::HashMap::new();
            requests.insert(
                "confirm".to_string(),
                InputRequest {
                    kind: "confirmation".to_string(),
                    message: format!(
                        "Permanently delete tailored version {display}, including every file \
                         inside it? This cannot be undone."
                    ),
                    schema: json!({
                        "type": "boolean",
                        "description": "True to delete the version folder permanently, false to cancel"
                    }),
                },
            );

            let state_payload = json!({
                "tool": TOOL,
                "variantId": variant_id,
                "timestamp": chrono_now_ms(),
            });
            let nonce = ctx.elicitations.issue(TOOL, &subject);
            let mrtr = InputRequiredResult::new_bound(requests, &state_payload, &nonce)
                .map_err(JsonRpcError::internal_error)?;
            serde_json::to_value(mrtr).map_err(|e| JsonRpcError::internal_error(e.to_string()))
        }
    }
}

fn chrono_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn variant_diff(ctx: &PluginContext, args: &Value) -> Result<Value, JsonRpcError> {
    let root = resolve_known_project(ctx, args).await?;
    let variant_id = require_str(args, "variant_id")?.to_string();
    if !variants_is_safe_id(&variant_id) {
        return Err(JsonRpcError::invalid_params("Invalid 'variant_id'"));
    }
    tokio::task::spawn_blocking(move || {
        variants::diff_variant_blocking(&root.to_string_lossy(), &variant_id)
    })
    .await
    .map_err(|e| JsonRpcError::internal_error(e.to_string()))?
    .map(|changes| json!({ "changes": changes, "changedFileCount": changes.len() }))
    .map_err(JsonRpcError::internal_error)
}

// --- Compile + persist ---

async fn compile_file(ctx: &PluginContext, args: &Value) -> Result<Value, JsonRpcError> {
    let root = resolve_known_project(ctx, args).await?;
    let rel_arg = optional_str(args, "file_path")?;
    let include_pdf = optional_bool(args, "include_pdf");
    let persist_pdf = optional_bool(args, "persist_pdf");

    struct CompileOutcome {
        source_rel: Option<String>,
        result: crate::career_typst::engine::TypstCompileResult,
        persisted_to: Option<String>,
    }

    let outcome = tokio::task::spawn_blocking(move || -> Result<CompileOutcome, JsonRpcError> {
        let path = match &rel_arg {
            Some(rel) => {
                let p = confine(&root, rel).map_err(JsonRpcError::invalid_params)?;
                if p.extension().and_then(|e| e.to_str()) != Some("typ") {
                    return Err(JsonRpcError::invalid_params(
                        "The resume engine compiles Typst only; pass a .typ source.",
                    ));
                }
                p
            }
            None => find_main_source(&root).ok_or_else(|| {
                JsonRpcError::invalid_params(
                    "No .typ source found in this project; pass file_path explicitly.",
                )
            })?,
        };
        let (_content, _sha) = read_doc(&path)?;
        let source = std::fs::read_to_string(&path)
            .map_err(|e| JsonRpcError::internal_error(format!("source read failed: {e}")))?;
        let result = crate::career_typst::engine::compile_resume_pdf(&source);

        let mut persisted_to = None;
        if persist_pdf {
            if let Some(bytes) = &result.pdf_bytes {
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "resume".to_string());
                let dest = root.join(".prism").join("build").join(format!("{stem}.pdf"));
                atomic_write(&dest, bytes).map_err(JsonRpcError::internal_error)?;
                persisted_to = Some(dest.to_string_lossy().to_string());
            }
        }

        Ok(CompileOutcome {
            source_rel: path.strip_prefix(&root).ok().map(|p| p.to_string_lossy().to_string()),
            result,
            persisted_to,
        })
    })
    .await
    .map_err(|e| JsonRpcError::internal_error(e.to_string()))??;

    let rendered = outcome.result.pdf_bytes.is_some();
    let mut out = json!({
        "source": outcome.source_rel,
        "compiled": rendered,
        "pageCount": outcome.result.page_count,
        "errors": outcome.result.errors,
        "warnings": outcome.result.warnings,
        "durationMs": outcome.result.duration_ms,
        "pdfBytesLength": outcome.result.pdf_bytes.as_ref().map(|b| b.len()),
        "pdfPersistedTo": outcome.persisted_to,
    });
    if include_pdf {
        if let Some(obj) = out.as_object_mut() {
            obj.insert(
                "pdfBase64".to_string(),
                match &outcome.result.pdf_bytes {
                    Some(bytes) => Value::String(BASE64_STANDARD.encode(bytes)),
                    None => Value::Null,
                },
            );
        }
    }
    Ok(out)
}

async fn save_synthesis(ctx: &PluginContext, args: &Value) -> Result<Value, JsonRpcError> {
    let root = resolve_known_project(ctx, args).await?;
    let version_name = require_str(args, "version_name")?.to_string();
    let typst_source = require_str(args, "typst_source")?.to_string();
    let jd_text = optional_str(args, "jd_text")?.unwrap_or_default();
    let status = optional_str(args, "status")?.unwrap_or_default();

    if typst_source.trim().is_empty() {
        return Err(JsonRpcError::invalid_params("'typst_source' is empty"));
    }
    if typst_source.len() > MAX_DOC_BYTES {
        return Err(JsonRpcError::invalid_params(format!(
            "typst_source is {} bytes; limit is {MAX_DOC_BYTES}",
            typst_source.len()
        )));
    }

    tokio::task::spawn_blocking(move || save_synthesis_blocking(&root, &version_name, &typst_source, &jd_text, &status))
        .await
        .map_err(|e| JsonRpcError::internal_error(e.to_string()))?
}

fn save_synthesis_blocking(
    root: &Path,
    version_name: &str,
    typst_source: &str,
    jd_text: &str,
    status: &str,
) -> Result<Value, JsonRpcError> {
    // Create the variant snapshot from the master. On any failure after this
    // point we roll the variant back rather than leaving half-written state,
    // mirroring the frontend materializer's rollback.
    let info = variants::create_variant_blocking(&root.to_string_lossy(), version_name, jd_text, status)
        .map_err(JsonRpcError::internal_error)?;
    let variant_dir = PathBuf::from(&info.path);

    let rollback = |dir: &Path| {
        let _ = std::fs::remove_dir_all(dir);
    };

    let main = find_main_source(&variant_dir).unwrap_or_else(|| variant_dir.join("resume.typ"));

    if let Err(err) = atomic_write(&main, typst_source.as_bytes()) {
        rollback(&variant_dir);
        return Err(JsonRpcError::internal_error(format!(
            "Failed to write synthesized source; the new version was rolled back: {err}"
        )));
    }

    let compiled = crate::career_typst::engine::compile_resume_pdf(typst_source);

    let mut pdf_path = None;
    if let Some(bytes) = &compiled.pdf_bytes {
        let dest = variant_dir
            .join(".prism")
            .join("build")
            .join("resume.pdf");
        // A failed PDF write does not invalidate the saved source; it is
        // simply reported as absent.
        if atomic_write(&dest, bytes).is_ok() {
            pdf_path = Some(dest.to_string_lossy().to_string());
        }
    }

    Ok(json!({
        "variant": info,
        "mainFile": main.strip_prefix(variant_dir.clone()).ok().map(|p| p.to_string_lossy().to_string()),
        "sha1": sha1_hex(typst_source.as_bytes()),
        "compile": {
            "compiled": compiled.pdf_bytes.is_some(),
            "pageCount": compiled.page_count,
            "errors": compiled.errors,
            "warnings": compiled.warnings,
            "durationMs": compiled.duration_ms,
            "pdfPath": pdf_path,
        },
    }))
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn apply_edit_replaces_unique_match() {
        let (out, n) = apply_one_edit("hello world", "world", "there", false).unwrap();
        assert_eq!(out, "hello there");
        assert_eq!(n, 1);
    }

    #[test]
    fn apply_edit_without_replace_all_refuses_ambiguous_matches() {
        let err = apply_one_edit("a-b-a", "a", "x", false).unwrap_err();
        assert!(err.contains("matched 2 times"), "{err}");
    }

    #[test]
    fn apply_edit_replace_all_hits_every_occurrence() {
        let (out, _) = apply_one_edit("a-b-a-c-a", "a", "x", true).unwrap();
        assert_eq!(out, "x-b-x-c-x");
    }

    #[test]
    fn apply_edit_missing_match_reports_a_helpful_hint() {
        let err = apply_one_edit("# Heading\nbody", "zzz-absent", "y", false).unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert!(err.contains("File starts with"), "the hint is the point: {err}");
    }

    #[test]
    fn apply_edit_empty_old_string_is_rejected_before_any_scan() {
        assert!(apply_one_edit("abc", "", "y", true).is_err());
    }

    #[test]
    fn major_reduction_guard_thresholds() {
        // Small files are never gated.
        assert!(guard_major_reduction(150, 10, false).is_ok());
        // Over half on a non-trivial file is refused without acknowledgement…
        assert!(guard_major_reduction(400, 190, false).is_err());
        // …allowed at exactly half-or-more remaining…
        assert!(guard_major_reduction(400, 200, false).is_ok());
        // …and permitted with the flag.
        assert!(guard_major_reduction(400, 10, true).is_ok());
    }

    #[test]
    fn sha_normalisation_is_case_and_whitespace_insensitive() {
        assert_eq!(normalise_sha("  ABCDEF \n"), "abcdef");
    }

    #[test]
    fn safe_id_mirrors_the_variants_layer() {
        assert!(variants_is_safe_id("acme-ml"));
        assert!(!variants_is_safe_id("../escape"));
        assert!(!variants_is_safe_id("a/b"));
        assert!(!variants_is_safe_id("a\\b"));
        assert!(!variants_is_safe_id("."));
        assert!(!variants_is_safe_id(""));
    }

    #[test]
    fn main_source_discovery_prefers_canonical_names() {
        let dir = std::env::temp_dir().join(format!(
            "devprism-main-src-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(find_main_source(&dir).is_none(), "empty project has no source");
        std::fs::write(dir.join("other.typ"), "x").unwrap();
        assert_eq!(
            find_main_source(&dir),
            Some(dir.join("other.typ")),
            "falls back to the only source"
        );
        std::fs::write(dir.join("resume.typ"), "x").unwrap();
        std::fs::write(dir.join("main.typ"), "x").unwrap();
        assert_eq!(find_main_source(&dir), Some(dir.join("main.typ")));
        cleanup_tmp(&dir);
    }

    fn cleanup_tmp(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }
}
