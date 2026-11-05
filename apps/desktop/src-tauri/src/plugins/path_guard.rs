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
///
/// `Path::strip_prefix` is byte-exact, so a same-inode child whose project
/// component differs only by case (`proj` vs `PROJ`) would miss. The fallback
/// compares components with [`component_eq`] — case-insensitive per component
/// where [`path_is_within`] is, never a case-folded string prefix.
fn strip_root_prefix(root: &Path, candidate: &Path) -> Option<PathBuf> {
    if let Ok(rest) = candidate.strip_prefix(root) {
        return Some(rest.to_path_buf());
    }
    let root_c = normalized_components(root)?;
    let cand_c = normalized_components(candidate)?;
    if root_c.is_empty() || cand_c.len() < root_c.len() {
        return None;
    }
    if !root_c
        .iter()
        .zip(cand_c.iter())
        .all(|(root_comp, cand_comp)| component_eq(root_comp, cand_comp))
    {
        return None;
    }
    let mut rest = PathBuf::new();
    for comp in cand_c.into_iter().skip(root_c.len()) {
        match comp {
            NormComp::Normal(name) => rest.push(name),
            NormComp::Root | NormComp::Prefix(_) => return None,
        }
    }
    Some(rest)
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
/// The temp path is a new file (`create_new`, random suffix) opened on a
/// directory fd. A planted symlink at the final component is replaced, not
/// followed. A symlink in any ancestor — other than the platform directory
/// aliases directly under `/` — is refused, and missing directories are created
/// with `mkdirat` on that fd so `create_dir_all` cannot walk a link.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    nofollow::atomic_write(path, bytes)
}

pub(crate) use nofollow::{
    ensure_dir_nofollow, open_read_nofollow, remove_tree_nofollow, write_nofollow, DirFd,
};

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

#[cfg(unix)]
mod nofollow {
    use std::ffi::{CString, OsStr};
    use std::fs::File;
    use std::io::{self, Write};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::io::{AsRawFd, FromRawFd, RawFd};
    use std::path::{Component, Path, PathBuf};

    /// Directory held open so later creates and writes use `openat`/`mkdirat`
    /// and cannot follow a symlink swapped into the path.
    pub(crate) struct DirFd {
        file: File,
    }

    impl DirFd {
        fn from_raw(fd: RawFd) -> Self {
            Self {
                file: unsafe { File::from_raw_fd(fd) },
            }
        }

        fn raw(&self) -> RawFd {
            self.file.as_raw_fd()
        }

        pub(crate) fn open(path: &Path) -> io::Result<Self> {
            walk(path, false)
        }

        pub(crate) fn ensure(path: &Path) -> io::Result<Self> {
            walk(path, true)
        }

        /// Create or open a child directory. A child symlink is refused.
        pub(crate) fn subdir(&self, name: &OsStr) -> io::Result<Self> {
            match self.open_child(name) {
                Ok(dir) => Ok(dir),
                Err(e) if is_eloop(&e) => Err(refuse()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    self.mkdir(name)?;
                    self.open_child(name)
                        .map_err(|err| if is_eloop(&err) { refuse() } else { err })
                }
                Err(e) => Err(e),
            }
        }

        pub(crate) fn write(&self, name: &OsStr, bytes: &[u8]) -> io::Result<()> {
            let mut file = self.open_write(name, false)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            Ok(())
        }

        pub(crate) fn create_new(&self, name: &OsStr) -> io::Result<File> {
            self.open_write(name, true)
        }

        /// Replace `to`, including when `to` is a symlink. `renameat` replaces
        /// the directory entry and does not follow it.
        pub(crate) fn rename_replace(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
            let src = cstring(from)?;
            let dst = cstring(to)?;
            let rc = unsafe { libc::renameat(self.raw(), src.as_ptr(), self.raw(), dst.as_ptr()) };
            if rc == 0 {
                return Ok(());
            }
            let err = io::Error::last_os_error();
            if self.child_is_symlink(to).unwrap_or(false) {
                self.unlink_file(to)?;
                let rc =
                    unsafe { libc::renameat(self.raw(), src.as_ptr(), self.raw(), dst.as_ptr()) };
                if rc == 0 {
                    return Ok(());
                }
                return Err(io::Error::last_os_error());
            }
            Err(err)
        }

        pub(crate) fn unlink_file(&self, name: &OsStr) -> io::Result<()> {
            let c = cstring(name)?;
            let rc = unsafe { libc::unlinkat(self.raw(), c.as_ptr(), 0) };
            if rc == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }

        fn mkdir(&self, name: &OsStr) -> io::Result<()> {
            let c = cstring(name)?;
            let rc = unsafe { libc::mkdirat(self.raw(), c.as_ptr(), 0o755 as libc::mode_t) };
            if rc == 0 {
                return Ok(());
            }
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::AlreadyExists {
                Ok(())
            } else {
                Err(err)
            }
        }

        fn open_child(&self, name: &OsStr) -> io::Result<DirFd> {
            let c = cstring(name)?;
            let fd = unsafe {
                libc::openat(
                    self.raw(),
                    c.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                let err = io::Error::last_os_error();
                if self.child_is_symlink(name).unwrap_or(false) {
                    return Err(io::Error::from_raw_os_error(libc::ELOOP));
                }
                return Err(err);
            }
            Ok(DirFd::from_raw(fd))
        }

        fn open_write(&self, name: &OsStr, exclusive: bool) -> io::Result<File> {
            let c = cstring(name)?;
            let mut flags = libc::O_WRONLY | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC;
            flags |= if exclusive {
                libc::O_EXCL
            } else {
                libc::O_TRUNC
            };
            let fd = unsafe { libc::openat(self.raw(), c.as_ptr(), flags, 0o644 as libc::c_uint) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(unsafe { File::from_raw_fd(fd) })
        }

        fn child_is_symlink(&self, name: &OsStr) -> io::Result<bool> {
            let c = cstring(name)?;
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            let rc = unsafe {
                libc::fstatat(self.raw(), c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW)
            };
            if rc != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok((st.st_mode & libc::S_IFMT) == libc::S_IFLNK)
        }

        fn read_link(&self, name: &OsStr) -> io::Result<PathBuf> {
            let c = cstring(name)?;
            let mut cap = 1024usize;
            loop {
                let mut buf = vec![0u8; cap];
                let n = unsafe {
                    libc::readlinkat(
                        self.raw(),
                        c.as_ptr(),
                        buf.as_mut_ptr() as *mut libc::c_char,
                        buf.len(),
                    )
                };
                if n < 0 {
                    return Err(io::Error::last_os_error());
                }
                let n = n as usize;
                if n < buf.len() {
                    buf.truncate(n);
                    return Ok(PathBuf::from(OsStr::from_bytes(&buf)));
                }
                cap = cap.saturating_mul(2);
                if cap > 1024 * 1024 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "symlink target too long",
                    ));
                }
            }
        }

        fn remove_child(&self, name: &OsStr) -> io::Result<()> {
            match self.open_child(name) {
                Ok(child) => {
                    child.clear_children()?;
                    let c = cstring(name)?;
                    let rc = unsafe { libc::unlinkat(self.raw(), c.as_ptr(), libc::AT_REMOVEDIR) };
                    if rc == 0 {
                        Ok(())
                    } else {
                        Err(io::Error::last_os_error())
                    }
                }
                Err(e) if is_eloop(&e) => self.unlink_file(name),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(e) if e.raw_os_error() == Some(libc::ENOTDIR) => self.unlink_file(name),
                Err(e) => Err(e),
            }
        }

        fn clear_children(&self) -> io::Result<()> {
            let dup_fd = unsafe { libc::fcntl(self.raw(), libc::F_DUPFD_CLOEXEC, 0) };
            if dup_fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let dirp = unsafe { libc::fdopendir(dup_fd) };
            if dirp.is_null() {
                unsafe { libc::close(dup_fd) };
                return Err(io::Error::last_os_error());
            }
            let names = match read_names(dirp) {
                Ok(names) => names,
                Err(err) => {
                    unsafe { libc::closedir(dirp) };
                    return Err(err);
                }
            };
            if unsafe { libc::closedir(dirp) } != 0 {
                return Err(io::Error::last_os_error());
            }
            for name in names {
                self.remove_child(OsStr::from_bytes(&name))?;
            }
            Ok(())
        }
    }

    pub(crate) fn ensure_dir_nofollow(path: &Path) -> io::Result<()> {
        DirFd::ensure(path).map(|_| ())
    }

    pub(crate) fn write_nofollow(path: &Path, bytes: &[u8]) -> io::Result<()> {
        let parent = parent_or_dot(path)?;
        let name = file_name(path)?;
        DirFd::ensure(parent)?.write(name, bytes)
    }

    pub(crate) fn open_read_nofollow(path: &Path) -> io::Result<File> {
        let parent = parent_or_dot(path)?;
        let name = file_name(path)?;
        let dir = DirFd::open(parent)?;
        let c = cstring(name)?;
        let fd = unsafe {
            libc::openat(
                dir.raw(),
                c.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub(crate) fn remove_tree_nofollow(path: &Path) -> io::Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent"))?;
        let name = file_name(path)?;
        DirFd::open(parent)?.remove_child(name)
    }

    pub(super) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| format!("Cannot determine parent dir of {}", path.display()))?;
        let name = file_name(path).map_err(|e| format!("Cannot determine file name: {e}"))?;
        let dir = DirFd::ensure(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        let mut last_err = String::from("Failed to create temp file");
        for _ in 0..16 {
            let mut tmp_bytes = b".".to_vec();
            tmp_bytes.extend_from_slice(name.as_bytes());
            tmp_bytes
                .extend_from_slice(format!(".tmp-{}", uuid::Uuid::new_v4().simple()).as_bytes());
            let tmp = std::ffi::OsString::from_vec(tmp_bytes);
            let mut file = match dir.create_new(&tmp) {
                Ok(file) => file,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    last_err = format!("Failed to create temp file: {e}");
                    continue;
                }
                Err(e) => return Err(format!("Failed to create temp file: {e}")),
            };
            if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                drop(file);
                let _ = dir.unlink_file(&tmp);
                return Err(format!("Failed to write temp file: {e}"));
            }
            drop(file);
            match dir.rename_replace(&tmp, name) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let _ = dir.unlink_file(&tmp);
                    return Err(format!("Failed to replace {}: {e}", path.display()));
                }
            }
        }
        Err(last_err)
    }

    fn parent_or_dot(path: &Path) -> io::Result<&Path> {
        match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => Ok(parent),
            Some(_) => Ok(Path::new(".")),
            None => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "missing parent",
            )),
        }
    }

    fn file_name(path: &Path) -> io::Result<&OsStr> {
        path.file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing file name"))
    }

    fn walk(path: &Path, create: bool) -> io::Result<DirFd> {
        let path = absolute(path)?;
        let mut dir = open_root()?;
        let mut logical = PathBuf::from("/");
        for comp in path.components() {
            match comp {
                Component::RootDir => {}
                Component::Prefix(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "path prefix is not supported",
                    ));
                }
                Component::CurDir => {}
                Component::ParentDir => {
                    dir = dir.open_child(OsStr::new("..")).map_err(|err| {
                        if is_eloop(&err) {
                            refuse()
                        } else {
                            err
                        }
                    })?;
                    logical.pop();
                    if logical.as_os_str().is_empty() {
                        logical.push("/");
                    }
                }
                Component::Normal(name) => {
                    let (next, next_logical) = step(&dir, name, &logical, create)?;
                    dir = next;
                    logical = next_logical;
                }
            }
        }
        Ok(dir)
    }

    /// macOS publishes `/tmp` and `/var` as symlinks directly under `/`. Those
    /// are the only ancestor symlinks this walk traverses, by opening the
    /// canonical directory rather than by a later path lookup. Any other
    /// ancestor symlink is refused, and a missing component is created with
    /// `mkdirat` on the already-opened parent.
    fn step(
        dir: &DirFd,
        name: &OsStr,
        logical: &Path,
        create: bool,
    ) -> io::Result<(DirFd, PathBuf)> {
        match dir.open_child(name) {
            Ok(next) => {
                let mut next_logical = logical.to_path_buf();
                next_logical.push(name);
                Ok((next, next_logical))
            }
            Err(e) if is_eloop(&e) => {
                if logical != Path::new("/") {
                    return Err(refuse());
                }
                let target = dir.read_link(name)?;
                let joined = if target.is_absolute() {
                    target
                } else {
                    logical.join(target)
                };
                let canon = std::fs::canonicalize(&joined).map_err(|_| refuse())?;
                let next = walk(&canon, false)?;
                Ok((next, canon))
            }
            Err(e) if create && e.kind() == io::ErrorKind::NotFound => {
                dir.mkdir(name)?;
                let next =
                    dir.open_child(name)
                        .map_err(|err| if is_eloop(&err) { refuse() } else { err })?;
                let mut next_logical = logical.to_path_buf();
                next_logical.push(name);
                Ok((next, next_logical))
            }
            Err(e) => Err(e),
        }
    }

    fn absolute(path: &Path) -> io::Result<PathBuf> {
        if path.as_os_str().is_empty() {
            return std::env::current_dir();
        }
        if path.is_absolute() {
            Ok(path.to_path_buf())
        } else {
            Ok(std::env::current_dir()?.join(path))
        }
    }

    fn open_root() -> io::Result<DirFd> {
        let root = CString::new("/")
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "root path"))?;
        let fd = unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(DirFd::from_raw(fd))
    }

    fn cstring(name: &OsStr) -> io::Result<CString> {
        CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains NUL"))
    }

    fn is_eloop(err: &io::Error) -> bool {
        err.raw_os_error() == Some(libc::ELOOP)
    }

    fn refuse() -> io::Error {
        io::Error::new(io::ErrorKind::Other, "refusing to follow symlink")
    }

    fn clear_errno() {
        #[cfg(target_os = "macos")]
        unsafe {
            *libc::__error() = 0;
        }
        #[cfg(not(target_os = "macos"))]
        unsafe {
            *libc::__errno_location() = 0;
        }
    }

    fn errno_get() -> i32 {
        #[cfg(target_os = "macos")]
        unsafe {
            *libc::__error()
        }
        #[cfg(not(target_os = "macos"))]
        unsafe {
            *libc::__errno_location()
        }
    }

    fn read_names(dirp: *mut libc::DIR) -> io::Result<Vec<Vec<u8>>> {
        let mut names = Vec::new();
        loop {
            clear_errno();
            let ent = unsafe { libc::readdir(dirp) };
            if ent.is_null() {
                if errno_get() == 0 {
                    break;
                }
                return Err(io::Error::last_os_error());
            }
            let bytes = unsafe { std::ffi::CStr::from_ptr((*ent).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            names.push(bytes.to_vec());
        }
        Ok(names)
    }
}

#[cfg(not(unix))]
mod nofollow {
    use std::ffi::OsStr;
    use std::fs::{self, File};
    use std::io::{self, Write};
    use std::path::{Path, PathBuf};

    pub(crate) struct DirFd {
        path: PathBuf,
    }

    impl DirFd {
        pub(crate) fn open(path: &Path) -> io::Result<Self> {
            if path.is_dir() {
                Ok(Self {
                    path: path.to_path_buf(),
                })
            } else {
                Err(io::Error::new(io::ErrorKind::NotFound, "not a directory"))
            }
        }

        pub(crate) fn ensure(path: &Path) -> io::Result<Self> {
            fs::create_dir_all(path)?;
            Ok(Self {
                path: path.to_path_buf(),
            })
        }

        pub(crate) fn subdir(&self, name: &OsStr) -> io::Result<Self> {
            let path = self.path.join(name);
            fs::create_dir_all(&path)?;
            Ok(Self { path })
        }

        pub(crate) fn write(&self, name: &OsStr, bytes: &[u8]) -> io::Result<()> {
            let mut file = File::create(self.path.join(name))?;
            file.write_all(bytes)?;
            file.sync_all()?;
            Ok(())
        }

        pub(crate) fn create_new(&self, name: &OsStr) -> io::Result<File> {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.path.join(name))
        }

        pub(crate) fn unlink_file(&self, name: &OsStr) -> io::Result<()> {
            fs::remove_file(self.path.join(name))
        }

        pub(crate) fn rename_replace(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
            let tmp = self.path.join(from);
            let dest = self.path.join(to);
            match fs::rename(&tmp, &dest) {
                Ok(()) => Ok(()),
                Err(e) => {
                    let is_link = fs::symlink_metadata(&dest)
                        .map(|m| m.file_type().is_symlink())
                        .unwrap_or(false);
                    if !is_link {
                        return Err(e);
                    }
                    fs::remove_file(&dest)?;
                    fs::rename(&tmp, &dest)
                }
            }
        }
    }

    pub(crate) fn ensure_dir_nofollow(path: &Path) -> io::Result<()> {
        DirFd::ensure(path).map(|_| ())
    }

    pub(crate) fn write_nofollow(path: &Path, bytes: &[u8]) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        fs::write(path, bytes)
    }

    pub(crate) fn open_read_nofollow(path: &Path) -> io::Result<File> {
        File::open(path)
    }

    pub(crate) fn remove_tree_nofollow(path: &Path) -> io::Result<()> {
        fs::remove_dir_all(path)
    }

    pub(super) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| format!("Cannot determine parent dir of {}", path.display()))?;
        let dir = DirFd::ensure(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        let name = path
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_else(|| "file".into());
        let mut last_err = String::from("Failed to create temp file");
        for _ in 0..16 {
            let tmp_name = format!(
                ".{}.tmp-{}",
                name.to_string_lossy(),
                uuid::Uuid::new_v4().simple()
            );
            let tmp = OsStr::new(&tmp_name);
            let mut file = match dir.create_new(tmp) {
                Ok(file) => file,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    last_err = format!("Failed to create temp file: {e}");
                    continue;
                }
                Err(e) => return Err(format!("Failed to create temp file: {e}")),
            };
            if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                drop(file);
                let _ = dir.unlink_file(tmp);
                return Err(format!("Failed to write temp file: {e}"));
            }
            drop(file);
            match dir.rename_replace(tmp, &name) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let _ = dir.unlink_file(tmp);
                    return Err(format!("Failed to replace {}: {e}", path.display()));
                }
            }
        }
        Err(last_err)
    }
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

    #[cfg(unix)]
    #[test]
    fn adversarial_atomic_parent_symlink_is_not_followed() {
        let root = tmpdir("adv-atomic-parent");
        let outside = tmpdir("adv-atomic-parent-out");
        std::fs::write(outside.join("secret.txt"), b"original").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("parentlink")).unwrap();
        let existing = root.join("parentlink").join("secret.txt");
        let existing_result = atomic_write(&existing, b"pwned");
        assert_eq!(
            std::fs::read(outside.join("secret.txt")).unwrap(),
            b"original",
            "parent symlink was followed onto an existing file; write={existing_result:?}"
        );
        let fresh = root.join("parentlink").join("brand-new.txt");
        let fresh_result = atomic_write(&fresh, b"pwned");
        assert!(
            !outside.join("brand-new.txt").exists(),
            "parent symlink was followed for a new file; write={fresh_result:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn adversarial_atomic_ancestor_symlink_is_not_followed() {
        let root = tmpdir("adv-atomic-anc");
        let outside = tmpdir("adv-atomic-anc-out");
        std::fs::write(outside.join("secret.txt"), b"original").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let dest = root.join("link").join("newdir").join("file.txt");
        let result = atomic_write(&dest, b"pwned");
        assert!(
            !outside.join("newdir").exists(),
            "ancestor symlink was followed; write={result:?} tree={:?}",
            std::fs::read_dir(&outside)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            std::fs::read(outside.join("secret.txt")).unwrap(),
            b"original"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    fn flip_component_case(path: &Path, component: &std::ffi::OsStr) -> PathBuf {
        let mut out = PathBuf::new();
        for c in path.components() {
            match c {
                Component::Normal(name) if name == component => {
                    let flipped: String = name
                        .to_string_lossy()
                        .chars()
                        .map(|ch| {
                            if ch.is_ascii_lowercase() {
                                ch.to_ascii_uppercase()
                            } else if ch.is_ascii_uppercase() {
                                ch.to_ascii_lowercase()
                            } else {
                                ch
                            }
                        })
                        .collect();
                    out.push(flipped);
                }
                Component::Normal(name) => out.push(name),
                Component::RootDir => out.push("/"),
                Component::CurDir => out.push("."),
                Component::ParentDir => out.push(".."),
                Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            }
        }
        out
    }

    #[cfg(unix)]
    #[test]
    fn adversarial_confine_dot_slash_sibling_and_case() {
        let base = tmpdir("adv-comp");
        let root = base.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("secret.txt"), b"inside").unwrap();

        assert_eq!(
            confine(&root, "./secret.txt").unwrap(),
            root.join("secret.txt")
        );
        assert!(confine(&root, "secret.txt/").is_ok());
        let abs_dot = root.join(".").join("secret.txt");
        assert!(
            confine(&root, abs_dot.to_str().unwrap()).is_ok(),
            "absolute dot child refused"
        );
        assert!(confine(&root, "/proj-secret").is_err());
        assert!(confine(&root, "/a/cv-private").is_err());

        let proj_secret = base.join("proj-secret");
        std::fs::create_dir_all(&proj_secret).unwrap();
        std::fs::write(proj_secret.join("secret.txt"), b"nope").unwrap();
        assert!(confine(&root, proj_secret.to_str().unwrap()).is_err());

        let cv = base.join("a").join("cv");
        let cv_private = base.join("a").join("cv-private");
        std::fs::create_dir_all(&cv).unwrap();
        std::fs::create_dir_all(&cv_private).unwrap();
        std::fs::write(cv_private.join("secret.txt"), b"nope").unwrap();
        assert!(confine(&cv, cv_private.to_str().unwrap()).is_err());

        #[cfg(not(target_os = "linux"))]
        assert!(
            confine(&root, "SECRET.TXT").is_ok(),
            "case-only relative child refused"
        );

        let flipped = flip_component_case(&root.join("secret.txt"), root.file_name().unwrap());
        #[cfg(not(target_os = "linux"))]
        {
            assert!(
                flipped.exists(),
                "case-variant path did not resolve on this volume: {}",
                flipped.display()
            );
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                std::fs::metadata(root.join("secret.txt")).unwrap().ino(),
                std::fs::metadata(&flipped).unwrap().ino()
            );
            let got = confine(&root, flipped.to_str().unwrap());
            assert!(
                got.is_ok(),
                "real child refused (same inode, different component case): path={} err={got:?}",
                flipped.display()
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
