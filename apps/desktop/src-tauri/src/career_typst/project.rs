//! Typst compilation for **workspace projects**, where a document may
//! `#import` or `read()` sibling files.
//!
//! This is deliberately a second world, not a relaxation of
//! [`super::engine::ResumeWorld`]. Resume synthesis feeds AI-authored text to
//! the compiler and must stay hermetic; a workspace project is the user's own
//! source tree, the same trust level the LaTeX path already grants Tectonic.
//!
//! Reads are still confined: `VirtualPath` rejects `..` at construction, and
//! [`ProjectWorld::realize`] additionally canonicalizes and re-checks the
//! prefix so a symlink inside the project cannot point outside it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

use super::engine::{compile_world, today_utc, TypstCompileResult, FONTS, MAX_SOURCE_BYTES};

/// Cap on total bytes read from the project during one compile. Bounds a
/// document that tries to pull in the whole tree via `read()`.
const MAX_PROJECT_READ_BYTES: usize = 32 * 1024 * 1024;

pub struct ProjectWorld {
    library: LazyHash<Library>,
    /// Canonicalized project root; every resolved path must stay under it.
    root: PathBuf,
    main: FileId,
    sources: RwLock<HashMap<FileId, Source>>,
    files: RwLock<HashMap<FileId, Bytes>>,
    /// Running total of bytes read, for `MAX_PROJECT_READ_BYTES`.
    read_budget: Mutex<usize>,
}

impl ProjectWorld {
    /// Build a world rooted at `root` with `main_rel` as the entry document.
    ///
    /// `main_rel` is project-relative (e.g. `resume.typ`, `src/main.typ`).
    pub fn new(root: &Path, main_rel: &str) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|e| format!("Project root {}: {e}", root.display()))?;
        let vpath = VirtualPath::new(main_rel)
            .map_err(|e| format!("Invalid main file {main_rel}: {e}"))?;
        let main = FileId::new(RootedPath::new(VirtualRoot::Project, vpath));
        Ok(Self {
            library: LazyHash::new(Library::default()),
            root,
            main,
            sources: RwLock::new(HashMap::new()),
            files: RwLock::new(HashMap::new()),
            read_budget: Mutex::new(0),
        })
    }

    /// Map a `FileId` to a real path, refusing anything outside the root.
    fn realize(&self, id: FileId) -> FileResult<PathBuf> {
        // Packages are not fetched — a workspace project may only read itself.
        if !matches!(id.root(), VirtualRoot::Project) {
            return Err(FileError::AccessDenied);
        }
        let vpath = id.vpath();
        let path = vpath
            .realize(&self.root)
            .map_err(|_| FileError::AccessDenied)?;

        // `VirtualPath` already rejects `..`, but a symlink inside the project
        // could still resolve outside it. Canonicalize and re-check.
        match path.canonicalize() {
            Ok(real) => {
                if real.starts_with(&self.root) {
                    Ok(real)
                } else {
                    Err(FileError::AccessDenied)
                }
            }
            // Not-yet-existing paths cannot be canonicalized; the lexical form
            // is already root-relative and `..`-free, so report it as missing.
            Err(_) => Err(FileError::NotFound(path)),
        }
    }

    fn read_bytes(&self, id: FileId) -> FileResult<Vec<u8>> {
        let path = self.realize(id)?;
        let meta = std::fs::metadata(&path)
            .map_err(|e| FileError::from_io(e, &path))?;
        if meta.is_dir() {
            return Err(FileError::IsDirectory);
        }
        let len = meta.len() as usize;
        if len > MAX_SOURCE_BYTES {
            return Err(FileError::Other(Some(
                format!(
                    "{} is {len} bytes, over the {MAX_SOURCE_BYTES} byte limit",
                    path.display()
                )
                .into(),
            )));
        }
        {
            let mut budget = self
                .read_budget
                .lock()
                .map_err(|_| FileError::Other(Some("read budget poisoned".into())))?;
            *budget += len;
            if *budget > MAX_PROJECT_READ_BYTES {
                return Err(FileError::Other(Some(
                    format!(
                        "project read budget of {MAX_PROJECT_READ_BYTES} bytes exceeded"
                    )
                    .into(),
                )));
            }
        }
        std::fs::read(&path).map_err(|e| FileError::from_io(e, &path))
    }
}

impl World for ProjectWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        FONTS.book()
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if let Ok(cache) = self.sources.read() {
            if let Some(hit) = cache.get(&id) {
                return Ok(hit.clone());
            }
        }
        let bytes = self.read_bytes(id)?;
        let text = String::from_utf8(bytes).map_err(|_| FileError::InvalidUtf8)?;
        let source = Source::new(id, text);
        if let Ok(mut cache) = self.sources.write() {
            cache.insert(id, source.clone());
        }
        Ok(source)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if let Ok(cache) = self.files.read() {
            if let Some(hit) = cache.get(&id) {
                return Ok(hit.clone());
            }
        }
        let bytes = Bytes::new(self.read_bytes(id)?);
        if let Ok(mut cache) = self.files.write() {
            cache.insert(id, bytes.clone());
        }
        Ok(bytes)
    }

    fn font(&self, index: usize) -> Option<Font> {
        FONTS.font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        today_utc(offset)
    }
}

/// Compile `main_rel` inside `project_dir` to PDF.
pub fn compile_project_pdf(project_dir: &Path, main_rel: &str) -> TypstCompileResult {
    let ident = format!("devprism-project:{main_rel}");

    // Build the world ONCE, before entering the compile driver, so a bad path is
    // a clear message rather than a generic compile failure. This previously
    // built it twice and `expect`ed the second attempt to succeed; building once
    // removes both the duplicate canonicalize and the panic path.
    //
    // Constructing outside `compile_world`'s `catch_unwind` is safe because
    // `ProjectWorld::new` only canonicalizes and interns a `FileId` — it reads no
    // project files. Every untrusted read stays lazy, inside `source()`/`file()`,
    // and so remains contained.
    let world = match ProjectWorld::new(project_dir, main_rel) {
        Ok(world) => world,
        Err(message) => return TypstCompileResult::failure(message, 0),
    };

    compile_world(move || world, &ident)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            Self { dir: tempfile::TempDir::new().expect("tempdir") }
        }
        fn write(&self, rel: &str, body: &str) -> PathBuf {
            let path = self.dir.path().join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("mkdir");
            }
            std::fs::write(&path, body).expect("write");
            path
        }
        fn path(&self) -> &Path {
            self.dir.path()
        }
    }

    const PAGE: &str = "#set page(paper: \"us-letter\", margin: 1in)\n";

    #[test]
    fn compiles_a_single_project_file() {
        let f = Fixture::new();
        f.write("main.typ", &format!("{PAGE}= Hello\nBody text.\n"));
        let r = compile_project_pdf(f.path(), "main.typ");
        assert!(r.success, "{:?}", r.errors);
        assert_eq!(r.page_count, 1);
        assert!(r.pdf_bytes.expect("pdf").starts_with(b"%PDF-"));
    }

    #[test]
    fn resolves_sibling_imports() {
        let f = Fixture::new();
        f.write("lib.typ", "#let greet(n) = [Hello #n]\n");
        f.write(
            "main.typ",
            &format!("{PAGE}#import \"lib.typ\": greet\n#greet(\"world\")\n"),
        );
        let r = compile_project_pdf(f.path(), "main.typ");
        assert!(r.success, "sibling import failed: {:?}", r.errors);
    }

    #[test]
    fn resolves_nested_subdirectory_imports() {
        let f = Fixture::new();
        f.write("parts/intro.typ", "#let intro = [An intro]\n");
        f.write(
            "main.typ",
            &format!("{PAGE}#import \"parts/intro.typ\": intro\n#intro\n"),
        );
        let r = compile_project_pdf(f.path(), "main.typ");
        assert!(r.success, "nested import failed: {:?}", r.errors);
    }

    #[test]
    fn read_of_a_project_file_works() {
        let f = Fixture::new();
        f.write("data.txt", "42");
        f.write("main.typ", &format!("{PAGE}#read(\"data.txt\")\n"));
        let r = compile_project_pdf(f.path(), "main.typ");
        assert!(r.success, "project read failed: {:?}", r.errors);
    }

    #[test]
    fn parent_traversal_is_rejected() {
        let f = Fixture::new();
        // `..` is refused by VirtualPath itself, so this must never resolve.
        f.write("main.typ", &format!("{PAGE}#read(\"../outside.txt\")\n"));
        std::fs::write(f.path().parent().unwrap().join("outside.txt"), "secret").ok();
        let r = compile_project_pdf(f.path(), "main.typ");
        assert!(!r.success, "parent traversal must not resolve");
    }

    #[test]
    fn absolute_path_escape_is_rejected() {
        let f = Fixture::new();
        f.write("main.typ", &format!("{PAGE}#read(\"/etc/passwd\")\n"));
        let r = compile_project_pdf(f.path(), "main.typ");
        assert!(!r.success, "absolute path must not escape the root");
        assert!(
            !r.errors.is_empty(),
            "an escape attempt must produce a diagnostic"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_out_of_root_is_rejected() {
        let f = Fixture::new();
        let outside = f.dir.path().parent().unwrap().join("prism-symlink-target.txt");
        std::fs::write(&outside, "secret").expect("write outside");
        let link = f.path().join("escape.txt");
        std::os::unix::fs::symlink(&outside, &link).expect("symlink");
        f.write("main.typ", &format!("{PAGE}#read(\"escape.txt\")\n"));

        let r = compile_project_pdf(f.path(), "main.typ");
        std::fs::remove_file(&outside).ok();
        assert!(
            !r.success,
            "a symlink pointing outside the project must be denied"
        );
    }

    #[test]
    fn package_import_is_denied() {
        let f = Fixture::new();
        f.write(
            "main.typ",
            &format!("{PAGE}#import \"@preview/cetz:0.2.2\": *\n"),
        );
        let r = compile_project_pdf(f.path(), "main.typ");
        assert!(!r.success, "package registry must not be reachable");
    }

    #[test]
    fn missing_file_is_a_clean_error() {
        let f = Fixture::new();
        f.write("main.typ", &format!("{PAGE}#import \"nope.typ\": x\n"));
        let r = compile_project_pdf(f.path(), "main.typ");
        assert!(!r.success);
        assert!(r.errors.iter().any(|e| e.severity == "error"));
        assert!(r.pdf_bytes.is_none());
    }

    #[test]
    fn missing_main_file_is_a_clean_error() {
        let f = Fixture::new();
        let r = compile_project_pdf(f.path(), "absent.typ");
        assert!(!r.success);
        assert!(!r.errors.is_empty());
    }

    #[test]
    fn nonexistent_root_reports_rather_than_panics() {
        let r = compile_project_pdf(Path::new("/definitely/not/here"), "main.typ");
        assert!(!r.success);
        assert!(r.errors[0].message.contains("Project root"));
    }

    #[test]
    fn diagnostics_name_the_offending_import() {
        let f = Fixture::new();
        f.write("broken.typ", "#let x = (\n");
        f.write(
            "main.typ",
            &format!("{PAGE}#import \"broken.typ\": x\n"),
        );
        let r = compile_project_pdf(f.path(), "main.typ");
        assert!(!r.success);
        assert!(
            r.errors.iter().any(|e| e.file.as_deref() == Some("broken.typ")),
            "expected a diagnostic attributed to broken.typ, got {:?}",
            r.errors
        );
    }

    #[test]
    fn invalid_utf8_is_reported_not_panicked() {
        let f = Fixture::new();
        std::fs::write(f.path().join("bad.typ"), [0xff, 0xfe, 0x00]).expect("write");
        f.write("main.typ", &format!("{PAGE}#import \"bad.typ\": x\n"));
        let r = compile_project_pdf(f.path(), "main.typ");
        assert!(!r.success);
    }
}
