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

use std::path::{Component, Path, PathBuf};

/// Resolve a user-supplied project-relative path to an absolute path confined
/// to `root`.
pub fn confine(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let raw = rel.trim();
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

    if rel_path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
    {
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
    if !starts_with(&real_target, &real_root) {
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

fn starts_with(path: &Path, base: &Path) -> bool {
    if path.starts_with(base) {
        return true;
    }
    // Case-insensitive filesystems (macOS default, Windows): a caller that
    // flips case between calls would otherwise bypass the prefix check.
    #[cfg(not(target_os = "linux"))]
    {
        path.to_string_lossy()
            .to_lowercase()
            .starts_with(&base.to_string_lossy().to_lowercase())
    }
    #[cfg(target_os = "linux")]
    {
        false
    }
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
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot determine parent dir of {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string()),
        std::process::id()
    ));
    std::fs::write(&tmp, bytes).map_err(|e| format!("Failed to write temp file: {e}"))?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(format!("Failed to replace {}: {e}", path.display()))
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
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create backup dir: {e}"))?;
    }
    std::fs::copy(file, &dest).map_err(|e| format!("Failed to back up {}: {e}", file.display()))?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "path-guard-{name}-{}",
            std::process::id()
        ));
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
