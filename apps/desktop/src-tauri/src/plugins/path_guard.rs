//! Filesystem confinement and safe write primitives for plugin file tools.
//!
//! Every path a caller supplies arrives as hostile JSON. This module is the
//! one place that decides what may be opened:
//!
//! * `..` traversal, absolute paths outside the root, `Component::Prefix`/
//!   `RootDir` games and leading `-` (flag injection into any future shell
//!   use) are rejected lexically;
//! * symlinks are resolved on the longest existing ancestor and the real
//!   target must stay inside the canonicalized root — an in-project symlink
//!   pointing at `/Users/…` cannot launder a write;
//! * if the root itself cannot be canonicalized we fail CLOSED rather than
//!   returning the unchecked path.
//!
//! The same checks exist in `native_agent::tools::resolve` for the agent's own
//! Read/Write/Edit tools; this module is the shared-shape port for plugin
//! packs so both surfaces enforce identical rules.

use std::borrow::Cow;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// Strip a Windows verbatim prefix (`\\?\`, including `\\?\UNC\`) so confinement
/// sees the path it actually names. Pure: no filesystem access, runs on every OS.
pub fn strip_verbatim_prefix(raw: &str) -> Cow<'_, str> {
    let raw = raw.trim();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        Cow::Owned(format!(r"\\{rest}"))
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        Cow::Borrowed(rest)
    } else {
        Cow::Borrowed(raw)
    }
}

/// Resolve a user-supplied project-relative path to an absolute path confined
/// to `root`.
pub fn confine(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // F-17: strip `\\?\` before any component or prefix check.
    let stripped = strip_verbatim_prefix(rel);
    let raw = stripped.as_ref();
    if raw.is_empty() {
        return Ok(root.to_path_buf());
    }
    if raw.starts_with('-') {
        return Err("Path must not begin with '-'.".to_string());
    }
    let candidate = Path::new(raw);
    let is_abs = raw.starts_with('/') || raw.starts_with('\\') || candidate.is_absolute();

    // An absolute path is accepted only when it actually lives inside the root
    // (models routinely echo back the absolute path they were handed).
    let rel_path: PathBuf = if is_abs {
        strip_root_prefix(root, candidate).ok_or_else(|| {
            "Path must stay inside the project (absolute path is outside the project root)."
                .to_string()
        })?
    } else {
        candidate.to_path_buf()
    };

    if rel_path.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    }) {
        return Err("Path must stay inside the project (no '..').".to_string());
    }
    if rel_path.as_os_str().is_empty() {
        return Ok(root.to_path_buf());
    }

    let joined = root.join(rel_path);
    let Some(real_root) = canonicalize_existing(root) else {
        return Err("Path could not be validated (project root is unavailable).".to_string());
    };
    let real_target = canonicalize_existing(&joined).unwrap_or_else(|| joined.clone());
    if !path_is_within(&real_target, &real_root) {
        return Err(
            "Path escapes the project (it resolves through a symlink to outside the project root)."
                .to_string(),
        );
    }
    Ok(joined)
}

/// Canonicalize the longest existing ancestor of `p`, re-appending the tail.
pub fn canonicalize_existing(p: &Path) -> Option<PathBuf> {
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

/// Whether `path` is `base` or a path inside it.
///
/// Comparison is by path components, never a string prefix: `/proj-secret` is
/// not inside `/proj`, and `/a/cv-private` is not inside `/a/cv`. On
/// case-insensitive filesystems each whole component is compared
/// case-insensitively, which still rejects a longer sibling name.
///
/// F-3 was not chosen. This helper does not deny dot-config paths and does not
/// apply an extension allow-list. Dotfiles are not rejected here.
pub fn path_is_within(path: &Path, base: &Path) -> bool {
    let Some(path_c) = normalized_components(path) else {
        return false;
    };
    let Some(base_c) = normalized_components(base) else {
        return false;
    };
    if base_c.is_empty() {
        return path_c.is_empty();
    }
    if path_c.len() < base_c.len() {
        return false;
    }
    path_c
        .iter()
        .zip(base_c.iter())
        .all(|(p, b)| component_eq(p, b))
}

/// Component-wise equality. Not a prefix check. Same case rule as [`path_is_within`].
pub fn paths_equivalent(a: &Path, b: &Path) -> bool {
    match (normalized_components(a), normalized_components(b)) {
        (Some(a), Some(b)) => {
            a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| component_eq(x, y))
        }
        _ => false,
    }
}

#[derive(Clone)]
enum NormComp {
    Prefix(std::ffi::OsString),
    Root,
    Normal(std::ffi::OsString),
}

fn component_eq(a: &NormComp, b: &NormComp) -> bool {
    match (a, b) {
        (NormComp::Root, NormComp::Root) => true,
        (NormComp::Prefix(a), NormComp::Prefix(b)) | (NormComp::Normal(a), NormComp::Normal(b)) => {
            if a == b {
                return true;
            }
            // Case-insensitive filesystems (macOS default, Windows). Linux stays
            // byte-exact so a case-only difference is a different path.
            #[cfg(not(target_os = "linux"))]
            {
                a.to_string_lossy()
                    .eq_ignore_ascii_case(&b.to_string_lossy())
            }
            #[cfg(target_os = "linux")]
            {
                false
            }
        }
        _ => false,
    }
}

/// Lexical components with `.` dropped and `..` applied. `None` if `..` would
/// escape the root (those paths are not "within" anything).
fn normalized_components(path: &Path) -> Option<Vec<NormComp>> {
    let mut out = Vec::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => match out.pop() {
                Some(NormComp::Normal(_)) => {}
                Some(other) => {
                    out.push(other);
                    return None;
                }
                None => return None,
            },
            Component::RootDir => out.push(NormComp::Root),
            Component::Prefix(p) => out.push(NormComp::Prefix(p.as_os_str().to_os_string())),
            Component::Normal(s) => out.push(NormComp::Normal(s.to_os_string())),
        }
    }
    Some(out)
}

/// Lexically strip `root` from `candidate` when candidate is inside it.
/// Tolerates separator/case drift on Windows.
fn strip_root_prefix(root: &Path, candidate: &Path) -> Option<PathBuf> {
    if let Ok(rest) = candidate.strip_prefix(root) {
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
        let r = norm(root);
        let c = norm(candidate);
        if c.starts_with(&r) && c.as_bytes().get(r.len()) == Some(&b'/') {
            return Some(PathBuf::from(&candidate.to_string_lossy()[r.len() + 1..]));
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    None
}

/// SHA-1 hex digest (the repo already depends on `sha1`; this is also the hash
/// used for elicitation subjects in `tools_career`).
pub fn sha1_hex(data: &[u8]) -> String {
    use sha1::Digest;
    let digest = sha1::Sha1::digest(data);
    let mut out = String::with_capacity(40);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Write via temp file + rename so a reader (or a crash mid-write) never sees
/// a half-written document.
///
/// The temp path is a new file (`create_new`, random suffix). A planted symlink
/// at that name is not opened. Rename then replaces a planted symlink at
/// `path` without following it, so the link target does not receive the write.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot determine parent dir of {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let mut last_err = String::from("Failed to create temp file");
    for _ in 0..16 {
        let tmp = parent.join(format!(".{name}.tmp-{}", uuid::Uuid::new_v4().simple()));
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = format!("Failed to create temp file: {e}");
                continue;
            }
            Err(e) => return Err(format!("Failed to create temp file: {e}")),
        };
        if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("Failed to write temp file: {e}"));
        }
        drop(file);
        match replace_without_following_symlink(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("Failed to replace {}: {e}", path.display()));
            }
        }
    }
    Err(last_err)
}

/// `rename` replaces a destination symlink's directory entry. If a platform
/// refuses to rename onto an existing symlink, unlink that symlink node (not
/// its target) and retry. Never open the destination for writing.
fn replace_without_following_symlink(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    match std::fs::rename(tmp, dest) {
        Ok(()) => Ok(()),
        Err(e) => {
            let is_link = std::fs::symlink_metadata(dest)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            if !is_link {
                return Err(e);
            }
            std::fs::remove_file(dest)?;
            std::fs::rename(tmp, dest)
        }
    }
}

/// Copy `file` to `<root>/.prism/mcp-backups/<timestamp_ms>/<rel>` before a
/// destructive overwrite. Returns the backup's absolute path.
///
/// Backups are best-effort but failures abort the operation: silently writing
/// without the backup the response promised is worse than refusing.
pub fn backup_file(root: &Path, file: &Path) -> Result<PathBuf, String> {
    let rel = file
        .strip_prefix(root)
        .map_err(|_| "backup target is not inside the project root".to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = root
        .join(".prism")
        .join("mcp-backups")
        .join(ts.to_string())
        .join(rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create backup dir: {e}"))?;
    }
    std::fs::copy(file, &dest).map_err(|e| format!("Failed to back up {}: {e}", file.display()))?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("path-guard-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn traversal_is_rejected_lexically() {
        let root = tmpdir("traversal");
        assert!(confine(&root, "../escape").is_err());
        assert!(confine(&root, "a/../../escape").is_err());
        assert!(confine(&root, "-flag").is_err());
        assert!(confine(&root, "/etc/passwd").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absolute_inside_root_resolves() {
        let root = tmpdir("abs");
        std::fs::write(root.join("resume.typ"), "hi").unwrap();
        let abs = root.join("resume.typ");
        let got = confine(&root, abs.to_str().unwrap()).unwrap();
        assert_eq!(got, root.join("resume.typ"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_refused() {
        let root = tmpdir("symlink");
        let outside = tmpdir("symlink-outside");
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(confine(&root, "link/secret.txt").is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn sha1_matches_known_vectors() {
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }

    #[test]
    fn atomic_write_never_leaves_the_temp_file_behind() {
        let root = tmpdir("atomic");
        let file = root.join("doc.typ");
        atomic_write(&file, b"v1").unwrap();
        atomic_write(&file, b"v2-longer").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"v2-longer");
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files leaked: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn component_confine_rejects_string_prefix_siblings() {
        // F-1. A case-folded string prefix would accept both of these.
        assert!(!path_is_within(
            Path::new("/a/cv-private"),
            Path::new("/a/cv")
        ));
        assert!(!path_is_within(
            Path::new("/proj-secret"),
            Path::new("/proj")
        ));
        assert!(path_is_within(
            Path::new("/a/cv/private"),
            Path::new("/a/cv")
        ));
        assert!(path_is_within(
            Path::new("/proj/src/main.rs"),
            Path::new("/proj")
        ));
        assert!(path_is_within(Path::new("/proj"), Path::new("/proj")));
        assert!(paths_equivalent(Path::new("/proj"), Path::new("/proj")));
        assert!(!paths_equivalent(
            Path::new("/proj"),
            Path::new("/proj-secret")
        ));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn component_confine_folds_case_per_component_only() {
        assert!(path_is_within(Path::new("/Proj/File"), Path::new("/proj")));
        assert!(!path_is_within(
            Path::new("/Proj-secret"),
            Path::new("/proj")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn confine_refuses_sibling_prefix_symlink() {
        let base = tmpdir("sibling");
        let root = base.join("proj");
        let secret = base.join("proj-secret");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&secret).unwrap();
        std::fs::write(secret.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(secret.join("secret.txt"), root.join("link")).unwrap();
        assert!(confine(&root, "link").is_err());

        let cv = base.join("a").join("cv");
        let private = base.join("a").join("cv-private");
        std::fs::create_dir_all(&cv).unwrap();
        std::fs::create_dir_all(&private).unwrap();
        std::fs::write(private.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(private.join("secret.txt"), cv.join("link")).unwrap();
        assert!(confine(&cv, "link").is_err());

        std::fs::write(root.join("inside.txt"), "ok").unwrap();
        assert_eq!(
            confine(&root, "inside.txt").unwrap(),
            root.join("inside.txt")
        );
        assert_eq!(confine(&root, root.to_str().unwrap()).unwrap(), root);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn strip_verbatim_prefix_is_pure_and_runs_everywhere() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\proj\file").as_ref(),
            r"C:\proj\file"
        );
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\a").as_ref(),
            r"\\server\share\a"
        );
        assert_eq!(strip_verbatim_prefix("/proj/file").as_ref(), "/proj/file");
        assert_eq!(
            strip_verbatim_prefix(r"\\?\..\escape").as_ref(),
            r"..\escape"
        );
        // Applied before confine: the prefix is not a literal relative name.
        let root = tmpdir("verbatim");
        std::fs::write(root.join("file.txt"), "x").unwrap();
        assert_eq!(
            confine(&root, r"\\?\file.txt").unwrap(),
            root.join("file.txt")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn confine_strips_verbatim_prefix_before_parent_check() {
        let root = tmpdir("verbatim-win");
        assert!(confine(&root, r"\\?\..\escape").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_does_not_follow_destination_symlink() {
        let root = tmpdir("symlink-dest");
        let outside = tmpdir("symlink-dest-out");
        let target = outside.join("secret.txt");
        std::fs::write(&target, b"original").unwrap();
        let dest = root.join("comments.json");
        std::os::unix::fs::symlink(&target, &dest).unwrap();
        atomic_write(&dest, b"new-content").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        let meta = std::fs::symlink_metadata(&dest).unwrap();
        assert!(!meta.file_type().is_symlink());
        assert_eq!(std::fs::read(&dest).unwrap(), b"new-content");
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files leaked: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn backup_preserves_relative_layout() {
        let root = tmpdir("backup");
        let file = root.join("chapters").join("cv.typ");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "old").unwrap();
        let dest = backup_file(&root, &file).unwrap();
        assert!(dest.starts_with(root.join(".prism").join("mcp-backups")));
        assert_eq!(std::fs::read_to_string(dest).unwrap(), "old");
        let _ = std::fs::remove_dir_all(&root);
    }
}
