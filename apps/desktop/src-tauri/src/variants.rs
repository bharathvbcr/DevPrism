//! Tailored document versions ("variants").
//!
//! A user keeps one master document (e.g. a resume) and tailors it per target
//! (e.g. per job description). Instead of duplicating the whole project folder
//! for every target — which sprawls the projects list — each tailored version
//! lives *inside* the owning project under `<project>/.prism/variants/<slug>/`.
//!
//! Why `.prism/variants/`:
//!   - The file-tree scanner skips any dir whose name starts with `.`
//!     (see `latex.rs`), so variants never pollute the master's Files panel.
//!   - History/Git excludes `.prism/`, so each variant keeps an independent
//!     snapshot history and compiles to its own `.prism/build/`.
//!
//! A variant folder is itself a fully self-contained project (it holds a copy
//! of the master's source at creation time), so the frontend "switches" to a
//! variant by simply opening its path like any other project. The owning
//! project is always derivable from a variant's path, which keeps switching
//! stateless.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// One tailored version, as surfaced to the frontend.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VariantInfo {
    /// Slug — also the variant's folder name. Stable for the variant's life.
    pub id: String,
    /// Human-facing name (what the user typed).
    pub name: String,
    /// Free-form pipeline state: "draft" | "applied" | "interview" | ...
    pub status: String,
    /// The target text this version was tailored for (e.g. the job description).
    pub jd: String,
    /// Creation time, epoch milliseconds.
    pub created_at: i64,
    /// Absolute path to the variant's project folder.
    pub path: String,
}

/// Machine metadata stored at `<variant>/.prism/variant.json` (hidden). The
/// folder name is the id and the absolute path is derived, so neither is
/// persisted here. The JD is intentionally *not* here — it lives in a visible
/// `JOB_DESCRIPTION.md` so the AI agent (which reads project files) and the user
/// can both see it. Older manifests embedded `jd`; that field is now ignored on
/// read and recovered into the file via `legacy_jd`.
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VariantManifest {
    name: String,
    status: String,
    created_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Resolve the owning project root for any project path. If `project_root` is
/// itself a variant (`<owner>/.prism/variants/<slug>`), return `<owner>`;
/// otherwise the path is already an owner and is returned unchanged.
fn derive_owner_root(project_root: &str) -> PathBuf {
    let path = Path::new(project_root);
    // A variant path looks like `<owner>/.prism/variants/<slug>`. Walk up from
    // the slug and confirm the two intermediate segments before returning owner.
    if let Some(variants) = path.parent() {
        if variants.file_name().is_some_and(|n| n == "variants") {
            if let Some(prism) = variants.parent() {
                if prism.file_name().is_some_and(|n| n == ".prism") {
                    if let Some(owner) = prism.parent() {
                        return owner.to_path_buf();
                    }
                }
            }
        }
    }
    path.to_path_buf()
}

fn variants_dir(owner: &Path) -> PathBuf {
    owner.join(".prism").join("variants")
}

/// Turn a display name into a safe single-segment folder slug.
fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "version".to_string()
    } else {
        trimmed
    }
}

/// Reject a variant id that isn't a single safe path segment (defends the
/// delete/update paths against `..` traversal or separators).
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains('\0')
}

/// Pick `base`, else `base-2`, `base-3`, … that does not yet exist in `dir`.
fn unique_slug(dir: &Path, base: &str) -> String {
    if !dir.join(base).exists() {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{}-{}", base, n);
        if !dir.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Copy the master's source tree into a new variant folder. Skips dot-dirs
/// (`.prism`, `.claudeprism`, `.git`) — which also prevents recursively copying
/// sibling variants — and common heavy non-source dirs.
fn copy_master_tree(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let src_path = entry.path();
        if src_path.is_dir() {
            if name_str.starts_with('.')
                || matches!(name_str.as_ref(), "node_modules" | "target" | "dist")
            {
                continue;
            }
            copy_master_tree(&src_path, &dst.join(&name))?;
        } else {
            fs::copy(&src_path, &dst.join(&name))?;
        }
    }
    Ok(())
}

/// Metadata lives in the variant's hidden `.prism/` dir so it never surfaces in
/// the Files panel when the variant is opened (the scanner skips dot-dirs).
fn manifest_path(variant_dir: &Path) -> PathBuf {
    variant_dir.join(".prism").join("variant.json")
}

/// Pre-0.x layout kept the manifest visible at the variant root; still read it
/// (and migrate away from it on the next write).
fn legacy_manifest_path(variant_dir: &Path) -> PathBuf {
    variant_dir.join("manifest.json")
}

fn read_manifest(variant_dir: &Path) -> VariantManifest {
    let primary = manifest_path(variant_dir);
    let path = if primary.is_file() {
        primary
    } else {
        legacy_manifest_path(variant_dir)
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_manifest(variant_dir: &Path, manifest: &VariantManifest) -> Result<(), String> {
    let path = manifest_path(variant_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create variant metadata dir: {}", e))?;
    }
    let raw = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Failed to serialize variant manifest: {}", e))?;
    fs::write(&path, raw).map_err(|e| format!("Failed to write variant manifest: {}", e))?;
    // Migrate away from the old visible location so it stops cluttering the tree.
    let legacy = legacy_manifest_path(variant_dir);
    if legacy.is_file() {
        let _ = fs::remove_file(legacy);
    }
    Ok(())
}

/// The JD lives in a visible file at the variant root so the AI agent can read
/// it as ordinary project context.
const JD_FILENAME: &str = "JOB_DESCRIPTION.md";

fn jd_path(variant_dir: &Path) -> PathBuf {
    variant_dir.join(JD_FILENAME)
}

/// Recover a JD embedded in an older manifest (pre-`JOB_DESCRIPTION.md` layout).
fn legacy_jd(variant_dir: &Path) -> String {
    let path = if manifest_path(variant_dir).is_file() {
        manifest_path(variant_dir)
    } else {
        legacy_manifest_path(variant_dir)
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("jd").and_then(|j| j.as_str()).map(str::to_string))
        .unwrap_or_default()
}

fn read_jd(variant_dir: &Path) -> String {
    let path = jd_path(variant_dir);
    if path.is_file() {
        fs::read_to_string(path).unwrap_or_default()
    } else {
        legacy_jd(variant_dir)
    }
}

/// Materialize the JD as a visible file. An empty JD removes the file rather
/// than leaving a blank one cluttering the tree.
fn write_jd(variant_dir: &Path, jd: &str) -> Result<(), String> {
    let path = jd_path(variant_dir);
    if jd.trim().is_empty() {
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to clear job description: {}", e))?;
        }
        return Ok(());
    }
    fs::write(&path, jd).map_err(|e| format!("Failed to write job description: {}", e))
}

fn info_from_dir(slug: &str, variant_dir: &Path) -> VariantInfo {
    let m = read_manifest(variant_dir);
    VariantInfo {
        id: slug.to_string(),
        name: if m.name.is_empty() {
            slug.to_string()
        } else {
            m.name
        },
        status: if m.status.is_empty() {
            "draft".to_string()
        } else {
            m.status
        },
        jd: read_jd(variant_dir),
        created_at: m.created_at,
        path: variant_dir.to_string_lossy().to_string(),
    }
}

fn list_variants_blocking(project_root: &str) -> Result<Vec<VariantInfo>, String> {
    let owner = derive_owner_root(project_root);
    let dir = variants_dir(&owner);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read variants: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(slug) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        out.push(info_from_dir(slug, &path));
    }
    // Newest first; fall back to name for stable ordering when timestamps tie.
    out.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

fn create_variant_blocking(
    project_root: &str,
    name: &str,
    jd: &str,
    status: &str,
) -> Result<VariantInfo, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Version name cannot be empty.".to_string());
    }
    let owner = derive_owner_root(project_root);
    if !owner.is_dir() {
        return Err("Project folder no longer exists.".to_string());
    }
    let dir = variants_dir(&owner);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create variants folder: {}", e))?;

    let slug = unique_slug(&dir, &slugify(name));
    let variant_dir = dir.join(&slug);

    if let Err(err) = copy_master_tree(&owner, &variant_dir) {
        let _ = fs::remove_dir_all(&variant_dir);
        return Err(format!("Failed to copy the master document: {}", err));
    }

    let manifest = VariantManifest {
        name: name.to_string(),
        status: if status.trim().is_empty() {
            "draft".to_string()
        } else {
            status.trim().to_string()
        },
        created_at: now_ms(),
    };
    let written = write_manifest(&variant_dir, &manifest).and_then(|_| write_jd(&variant_dir, jd));
    if let Err(err) = written {
        let _ = fs::remove_dir_all(&variant_dir);
        return Err(err);
    }

    Ok(info_from_dir(&slug, &variant_dir))
}

fn update_variant_blocking(
    project_root: &str,
    variant_id: &str,
    name: Option<String>,
    status: Option<String>,
    jd: Option<String>,
) -> Result<VariantInfo, String> {
    if !is_safe_id(variant_id) {
        return Err("Invalid version id.".to_string());
    }
    let owner = derive_owner_root(project_root);
    let variant_dir = variants_dir(&owner).join(variant_id);
    if !variant_dir.is_dir() {
        return Err("That version no longer exists.".to_string());
    }
    // Capture the effective JD up front (new value, or the existing one — which
    // may still be embedded in a legacy manifest) before `write_manifest`
    // migrates and removes that legacy file.
    let effective_jd = jd.unwrap_or_else(|| read_jd(&variant_dir));

    let mut manifest = read_manifest(&variant_dir);
    if let Some(name) = name {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            manifest.name = trimmed.to_string();
        }
    }
    if let Some(status) = status {
        let trimmed = status.trim();
        if !trimmed.is_empty() {
            manifest.status = trimmed.to_string();
        }
    }
    write_jd(&variant_dir, &effective_jd)?;
    write_manifest(&variant_dir, &manifest)?;
    Ok(info_from_dir(variant_id, &variant_dir))
}

fn delete_variant_blocking(project_root: &str, variant_id: &str) -> Result<(), String> {
    if !is_safe_id(variant_id) {
        return Err("Invalid version id.".to_string());
    }
    let owner = derive_owner_root(project_root);
    let variant_dir = variants_dir(&owner).join(variant_id);
    if !variant_dir.is_dir() {
        return Ok(()); // already gone — treat as success
    }
    fs::remove_dir_all(&variant_dir).map_err(|e| format!("Failed to delete version: {}", e))
}

/// One changed file when comparing a variant against its master. `old_content`
/// is the master's version, `new_content` the variant's (so it reads as
/// master → variant). Matches the frontend's camelCase diff shape.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VariantFileDiff {
    pub file_path: String,
    pub status: String, // "added" | "modified" | "deleted"
    pub old_content: Option<String>,
    pub new_content: Option<String>,
}

/// Collect text files of a tree as `relativePath → content`, skipping dot-dirs,
/// heavy non-source dirs, and the variant-only target file (JOB_DESCRIPTION.md).
/// Binary/non-UTF-8 files are skipped (they can't be line-diffed).
fn collect_text_files(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    collect_text_files_inner(root, root, &mut out);
    out
}

fn collect_text_files_inner(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if path.is_dir() {
            if name_str.starts_with('.')
                || matches!(name_str.as_ref(), "node_modules" | "target" | "dist")
            {
                continue;
            }
            collect_text_files_inner(root, &path, out);
        } else if let Ok(rel) = path.strip_prefix(root) {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            // The target file is variant-only metadata, not a document change.
            if rel_str == JD_FILENAME {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&path) {
                out.insert(rel_str, content);
            }
        }
    }
}

fn diff_variant_blocking(
    project_root: &str,
    variant_id: &str,
) -> Result<Vec<VariantFileDiff>, String> {
    if !is_safe_id(variant_id) {
        return Err("Invalid version id.".to_string());
    }
    let owner = derive_owner_root(project_root);
    let variant_dir = variants_dir(&owner).join(variant_id);
    if !variant_dir.is_dir() {
        return Err("That version no longer exists.".to_string());
    }

    let master = collect_text_files(&owner);
    let variant = collect_text_files(&variant_dir);

    let mut out = Vec::new();
    // Union of paths, sorted (BTreeMap keys are ordered) for stable output.
    let mut paths: Vec<&String> = master.keys().chain(variant.keys()).collect();
    paths.sort();
    paths.dedup();

    for path in paths {
        let m = master.get(path);
        let v = variant.get(path);
        match (m, v) {
            (Some(mc), Some(vc)) if mc != vc => out.push(VariantFileDiff {
                file_path: path.clone(),
                status: "modified".to_string(),
                old_content: Some(mc.clone()),
                new_content: Some(vc.clone()),
            }),
            (Some(mc), None) => out.push(VariantFileDiff {
                file_path: path.clone(),
                status: "deleted".to_string(),
                old_content: Some(mc.clone()),
                new_content: None,
            }),
            (None, Some(vc)) => out.push(VariantFileDiff {
                file_path: path.clone(),
                status: "added".to_string(),
                old_content: None,
                new_content: Some(vc.clone()),
            }),
            _ => {} // identical → not a change
        }
    }
    Ok(out)
}

/// List all tailored versions for the project that owns `project_root`.
/// Accepts either an owner path or a variant path (the owner is derived).
#[tauri::command]
pub async fn list_variants(project_root: String) -> Result<Vec<VariantInfo>, String> {
    tokio::task::spawn_blocking(move || list_variants_blocking(&project_root))
        .await
        .map_err(|e| format!("List versions task failed: {}", e))?
}

/// Create a new tailored version by snapshotting the master's source into
/// `<owner>/.prism/variants/<slug>/` and return it.
#[tauri::command]
pub async fn create_variant(
    project_root: String,
    name: String,
    jd: String,
    status: String,
) -> Result<VariantInfo, String> {
    tokio::task::spawn_blocking(move || create_variant_blocking(&project_root, &name, &jd, &status))
        .await
        .map_err(|e| format!("Create version task failed: {}", e))?
}

/// Patch a version's metadata (name / status / target text). Any `None` field
/// is left unchanged. The slug (folder) is intentionally never renamed so open
/// variant paths stay valid.
#[tauri::command]
pub async fn update_variant(
    project_root: String,
    variant_id: String,
    name: Option<String>,
    status: Option<String>,
    jd: Option<String>,
) -> Result<VariantInfo, String> {
    tokio::task::spawn_blocking(move || {
        update_variant_blocking(&project_root, &variant_id, name, status, jd)
    })
    .await
    .map_err(|e| format!("Update version task failed: {}", e))?
}

/// Permanently delete a tailored version and its folder.
#[tauri::command]
pub async fn delete_variant(project_root: String, variant_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || delete_variant_blocking(&project_root, &variant_id))
        .await
        .map_err(|e| format!("Delete version task failed: {}", e))?
}

/// Compare a tailored version against its master, returning one entry per
/// changed text file (master → variant).
#[tauri::command]
pub async fn diff_variant(
    project_root: String,
    variant_id: String,
) -> Result<Vec<VariantFileDiff>, String> {
    tokio::task::spawn_blocking(move || diff_variant_blocking(&project_root, &variant_id))
        .await
        .map_err(|e| format!("Diff version task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_makes_safe_kebab() {
        assert_eq!(slugify("Acme — Senior PM"), "acme-senior-pm");
        assert_eq!(slugify("  Google/L5  "), "google-l5");
        assert_eq!(slugify("!!!"), "version");
        assert_eq!(slugify(""), "version");
    }

    #[test]
    fn owner_root_is_identity_for_plain_project() {
        let p = "/home/u/Documents/DevPrism/Resume";
        assert_eq!(derive_owner_root(p), PathBuf::from(p));
    }

    #[test]
    fn owner_root_strips_variant_suffix() {
        let owner = "/home/u/Documents/DevPrism/Resume";
        let variant = format!("{}/.prism/variants/acme-pm", owner);
        assert_eq!(derive_owner_root(&variant), PathBuf::from(owner));
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(is_safe_id("acme-pm"));
        assert!(!is_safe_id(".."));
        assert!(!is_safe_id("a/b"));
        assert!(!is_safe_id("a\\b"));
        assert!(!is_safe_id(""));
    }

    #[test]
    fn create_list_update_delete_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let owner = tmp.path().join("Resume");
        fs::create_dir_all(&owner).unwrap();
        fs::write(owner.join("main.tex"), b"\\documentclass{article}").unwrap();
        // A dot-dir that must NOT be copied into the variant.
        fs::create_dir_all(owner.join(".claudeprism")).unwrap();
        fs::write(owner.join(".claudeprism").join("h"), b"x").unwrap();

        let owner_str = owner.to_string_lossy().to_string();
        let v = create_variant_blocking(&owner_str, "Acme PM", "JD body", "draft").unwrap();
        assert_eq!(v.id, "acme-pm");
        assert_eq!(v.name, "Acme PM");
        assert_eq!(v.status, "draft");

        // Master source copied; dot-dir skipped.
        let vdir = variants_dir(&owner).join("acme-pm");
        assert!(vdir.join("main.tex").is_file());
        assert!(!vdir.join(".claudeprism").exists());

        // Metadata is hidden under `.prism/` — never visible at the variant root.
        assert!(vdir.join(".prism").join("variant.json").is_file());
        assert!(!vdir.join("manifest.json").exists());

        // The JD is a visible file the agent can read, holding the raw text.
        assert_eq!(
            fs::read_to_string(vdir.join("JOB_DESCRIPTION.md")).unwrap(),
            "JD body"
        );

        // Listing from a *variant* path still resolves the owner.
        let listed = list_variants_blocking(&v.path).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].jd, "JD body");

        // A second variant with an empty JD gets a unique slug and no JD file.
        let v2 = create_variant_blocking(&owner_str, "Acme PM", "", "applied").unwrap();
        assert_eq!(v2.id, "acme-pm-2");
        assert!(!variants_dir(&owner)
            .join("acme-pm-2")
            .join("JOB_DESCRIPTION.md")
            .exists());

        // A status-only update preserves the existing JD file.
        let updated =
            update_variant_blocking(&owner_str, "acme-pm", None, Some("offer".into()), None).unwrap();
        assert_eq!(updated.status, "offer");
        assert_eq!(updated.jd, "JD body");

        delete_variant_blocking(&owner_str, "acme-pm").unwrap();
        assert!(!vdir.exists());
        assert_eq!(list_variants_blocking(&owner_str).unwrap().len(), 1);
    }

    #[test]
    fn diffs_variant_against_master() {
        let tmp = tempfile::tempdir().unwrap();
        let owner = tmp.path().join("Resume");
        fs::create_dir_all(&owner).unwrap();
        fs::write(owner.join("main.tex"), "line one\nline two\n").unwrap();
        fs::write(owner.join("skills.tex"), "C++\n").unwrap();

        let owner_str = owner.to_string_lossy().to_string();
        let v = create_variant_blocking(&owner_str, "Acme PM", "the JD text", "draft").unwrap();
        let vdir = variants_dir(&owner).join(&v.id);

        // No edits yet → identical (JOB_DESCRIPTION.md is excluded from the diff).
        assert!(diff_variant_blocking(&owner_str, &v.id).unwrap().is_empty());

        // Modify one file, add one, delete another in the variant.
        fs::write(vdir.join("main.tex"), "line one\nline TWO\n").unwrap();
        fs::write(vdir.join("cover.tex"), "Dear hiring manager\n").unwrap();
        fs::remove_file(vdir.join("skills.tex")).unwrap();

        let diff = diff_variant_blocking(&owner_str, &v.id).unwrap();
        let by_path: std::collections::HashMap<_, _> =
            diff.iter().map(|d| (d.file_path.as_str(), d)).collect();

        assert_eq!(by_path["main.tex"].status, "modified");
        assert_eq!(by_path["main.tex"].old_content.as_deref(), Some("line one\nline two\n"));
        assert_eq!(by_path["main.tex"].new_content.as_deref(), Some("line one\nline TWO\n"));
        assert_eq!(by_path["cover.tex"].status, "added");
        assert_eq!(by_path["skills.tex"].status, "deleted");
        // The target file is never reported as a change.
        assert!(!by_path.contains_key("JOB_DESCRIPTION.md"));
    }

    #[test]
    fn reads_and_migrates_legacy_root_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let owner = tmp.path().join("Resume");
        let vdir = variants_dir(&owner).join("old-pm");
        fs::create_dir_all(&vdir).unwrap();
        // Simulate the pre-relocation layout: manifest at the variant root.
        fs::write(
            vdir.join("manifest.json"),
            r#"{"name":"Old PM","status":"applied","jd":"legacy","createdAt":42}"#,
        )
        .unwrap();

        let owner_str = owner.to_string_lossy().to_string();
        let listed = list_variants_blocking(&owner_str).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Old PM");
        assert_eq!(listed[0].jd, "legacy");

        // A write migrates metadata into the hidden dir, removes the visible
        // manifest, and rescues the embedded JD into JOB_DESCRIPTION.md.
        update_variant_blocking(&owner_str, "old-pm", None, Some("offer".into()), None).unwrap();
        assert!(vdir.join(".prism").join("variant.json").is_file());
        assert!(!vdir.join("manifest.json").exists());
        assert_eq!(
            fs::read_to_string(vdir.join("JOB_DESCRIPTION.md")).unwrap(),
            "legacy"
        );
        assert_eq!(list_variants_blocking(&owner_str).unwrap()[0].jd, "legacy");
    }
}
