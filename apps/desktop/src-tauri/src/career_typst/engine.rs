//! In-process Typst compilation for resume synthesis.
//!
//! Deliberately tauri-free so it can be compiled and tested without the
//! native TeX toolchain that `crate::latex` drags in.
//!
//! ## Sandbox
//!
//! The [`ResumeWorld`] resolves exactly one file — the in-memory resume source.
//! `source()` for any other id and `file()` for every id return
//! [`FileError::AccessDenied`], so `#include`, `#import "@preview/..."` and
//! `read()` cannot reach the filesystem, the network, or the package registry.
//! Combined with the caller emitting all user text as Typst *string literals*
//! (see `typst-escape.ts`), a resume cannot execute anything.

use std::ops::Range;
use std::panic::AssertUnwindSafe;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use typst::diag::{FileError, FileResult, Severity, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration, Smart};
use typst::syntax::{
    DiagSpan, DiagSpanKind, FileId, RootedPath, Source, VirtualPath, VirtualRoot,
};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World, WorldExt};
use typst_kit::fonts::FontStore;
use typst_layout::PagedDocument;

/// Upper bound on resume source size. A rendered one-page resume is ~4 KB;
/// this is three orders of magnitude of headroom and still bounds the work
/// the engine can be asked to do.
pub const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;

/// Backstop against a runaway template producing an absurd document.
pub const MAX_PAGES: usize = 100;

/// How many compilation generations to keep in comemo's memo cache.
const COMEMO_MAX_AGE: usize = 10;

/// Fonts are discovered once per process. `typst_kit::fonts::system()` walks
/// the OS font directories, which costs 100s of milliseconds — doing it per
/// compile would defeat the entire point of moving off a subprocess engine.
/// Embedded faces are always present so output never depends on what happens
/// to be installed; system faces are additive so templates may request
/// Helvetica/Arial/Calibri when the user has them.
pub(crate) static FONTS: LazyLock<FontStore> = LazyLock::new(|| {
    let mut store = FontStore::new();
    store.extend(typst_kit::fonts::embedded());
    store.extend(typst_kit::fonts::system());
    store
});

/// Font families guaranteed present regardless of the host machine.
///
/// Templates must end their `fontStack` with one of these so a resume renders
/// identically everywhere. Enforced by `embedded_families_are_always_available`.
#[cfg(test)]
pub const EMBEDDED_FAMILIES: &[&str] = &[
    "Libertinus Serif",
    "New Computer Modern",
    "New Computer Modern Math",
    "DejaVu Sans Mono",
];

/// The single file every resume compile resolves.
const MAIN_FILE_NAME: &str = "resume.typ";

fn main_file_id() -> FileId {
    // `FileId::new` interns and reuses by path, so repeated compiles of
    // `MAIN_FILE_NAME` share one id rather than leaking a new one each time.
    //
    // `VirtualPath::new` is fallible in general, but *every* constructor in
    // `typst_syntax::path` is fallible, so there is no infallible fallback to
    // build this id from. Returning an error instead would mean making
    // `ResumeWorld::new` fallible, and that construction must stay inside
    // `compile_world`'s `catch_unwind` because `Source::new` parses untrusted
    // resume text — so the error could only be reported as a compile failure
    // whose message is unreachable for a compile-time constant.
    //
    // The suppression is therefore deliberate, and `main_file_id_is_infallible`
    // below proves the branch is unreachable rather than leaving it asserted in
    // a comment.
    #[allow(clippy::expect_used)]
    let vpath = VirtualPath::new(MAIN_FILE_NAME).expect("MAIN_FILE_NAME is a valid virtual path");
    FileId::new(RootedPath::new(VirtualRoot::Project, vpath))
}

/// A single-file, filesystem-isolated Typst world.
pub struct ResumeWorld {
    library: LazyHash<Library>,
    main: Source,
}

impl ResumeWorld {
    pub fn new(text: String) -> Self {
        Self {
            library: LazyHash::new(Library::default()),
            main: Source::new(main_file_id(), text),
        }
    }

}

impl World for ResumeWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        FONTS.book()
    }

    fn main(&self) -> FileId {
        self.main.id()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main.id() {
            Ok(self.main.clone())
        } else {
            Err(FileError::AccessDenied)
        }
    }

    fn file(&self, _id: FileId) -> FileResult<Bytes> {
        // No resume may read bytes off disk.
        Err(FileError::AccessDenied)
    }

    fn font(&self, index: usize) -> Option<Font> {
        FONTS.font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        today_utc(offset)
    }
}

/// Shared `World::today` implementation.
pub(crate) fn today_utc(offset: Option<Duration>) -> Option<Datetime> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
    let mut days = (now.as_secs() / 86_400) as i64;
    if let Some(offset) = offset {
        // `Duration::hours` is the documented accessor for a Typst duration.
        days += (offset.hours() / 24.0) as i64;
    }
    let (y, m, d) = civil_from_days(days);
    Datetime::from_ymd(y, m, d)
}

/// Days-since-Unix-epoch → (year, month, day), Howard Hinnant's civil_from_days.
/// Valid for the full proleptic Gregorian range; no external date dependency.
fn civil_from_days(z: i64) -> (i32, u8, u8) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u8;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

/// A compile diagnostic mapped back to 1-based line/column in the source.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TypstDiagnostic {
    pub severity: String,
    pub message: String,
    /// Project-relative path of the offending file. `None` for detached spans.
    /// Always `resume.typ` for single-file synthesis; meaningful once a
    /// workspace project `#import`s siblings.
    pub file: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub hints: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct TypstCompileResult {
    pub success: bool,
    pub page_count: usize,
    pub errors: Vec<TypstDiagnostic>,
    pub warnings: Vec<TypstDiagnostic>,
    pub duration_ms: u64,
    /// Present only on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_bytes: Option<Vec<u8>>,
}

impl TypstCompileResult {
    pub(crate) fn failure(message: impl Into<String>, duration_ms: u64) -> Self {
        Self {
            success: false,
            page_count: 0,
            errors: vec![TypstDiagnostic {
                severity: "error".to_string(),
                message: message.into(),
                file: None,
                line: None,
                column: None,
                hints: Vec::new(),
            }],
            warnings: Vec::new(),
            duration_ms,
            pdf_bytes: None,
        }
    }
}

/// Resolve a diagnostic span to (file, 1-based line, 1-based column).
///
/// Works for any `World`, so single-file synthesis and multi-file workspace
/// projects share one diagnostic path.
fn locate(
    world: &dyn World,
    span: DiagSpan,
) -> (Option<String>, Option<u32>, Option<u32>) {
    let file_id = match span.get() {
        DiagSpanKind::Detached => return (None, None, None),
        DiagSpanKind::Number { id, .. } | DiagSpanKind::Range { id, .. } => id,
    };
    let name = file_id.vpath().get_without_slash().to_string();
    let Some(range): Option<Range<usize>> = world.range(span) else {
        return (Some(name), None, None);
    };
    let Ok(source) = world.source(file_id) else {
        return (Some(name), None, None);
    };
    // Typst reports 0-based; editors and our UI are 1-based.
    match source.lines().byte_to_line_column(range.start) {
        Some((line, col)) => {
            (Some(name), Some(line as u32 + 1), Some(col as u32 + 1))
        }
        None => (Some(name), None, None),
    }
}

pub(crate) fn map_diagnostics(
    world: &dyn World,
    diags: &[SourceDiagnostic],
) -> Vec<TypstDiagnostic> {
    diags
        .iter()
        .map(|d| {
            let (file, line, column) = locate(world, d.span);
            TypstDiagnostic {
                severity: match d.severity {
                    Severity::Error => "error".to_string(),
                    Severity::Warning => "warning".to_string(),
                },
                message: d.message.to_string(),
                file,
                line,
                column,
                hints: d.hints.iter().map(|h| h.v.to_string()).collect(),
            }
        })
        .collect()
}

/// Compile Typst source to PDF bytes, entirely in-process.
///
/// Never panics: Typst is run under `catch_unwind` so a defect in the engine
/// surfaces as a failed compile rather than tearing down the host process.
pub fn compile_resume_pdf(source: &str) -> TypstCompileResult {
    if source.len() > MAX_SOURCE_BYTES {
        return TypstCompileResult::failure(
            format!(
                "Resume source is {} bytes, over the {} byte limit.",
                source.len(),
                MAX_SOURCE_BYTES
            ),
            0,
        );
    }
    compile_world(|| ResumeWorld::new(source.to_string()), "devprism-resume")
}

/// Compile any `World` to PDF, with the shared hardening applied.
///
/// `build` runs *inside* `catch_unwind` so a panic while constructing the
/// world (e.g. reading a malformed project file) is contained too.
pub(crate) fn compile_world<W, F>(build: F, ident: &str) -> TypstCompileResult
where
    W: World,
    F: FnOnce() -> W,
{
    let started = std::time::Instant::now();

    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let world = build();
        let compiled = typst::compile::<PagedDocument>(&world);
        let warnings = map_diagnostics(&world, &compiled.warnings);

        match compiled.output {
            Err(diags) => TypstCompileResult {
                success: false,
                page_count: 0,
                errors: map_diagnostics(&world, &diags),
                warnings,
                duration_ms: 0,
                pdf_bytes: None,
            },
            Ok(doc) => {
                let page_count = doc.pages().len();
                if page_count > MAX_PAGES {
                    return TypstCompileResult {
                        success: false,
                        page_count,
                        errors: vec![TypstDiagnostic {
                            severity: "error".to_string(),
                            message: format!(
                                "Rendered {page_count} pages, over the {MAX_PAGES} page limit."
                            ),
                            file: None,
                            line: None,
                            column: None,
                            hints: vec![
                                "Trim bullet text or reduce selected blocks.".to_string()
                            ],
                        }],
                        warnings,
                        duration_ms: 0,
                        pdf_bytes: None,
                    };
                }

                let options = typst_pdf::PdfOptions {
                    // Stable id keeps byte-identical output for identical input,
                    // which makes "did the resume actually change?" answerable.
                    ident: Smart::Custom(ident.to_string()),
                    creator: Smart::Custom(Some("DevPrism".to_string())),
                    // Tagged PDF (the default) is what gives ATS parsers a real
                    // reading order instead of guessing from glyph positions.
                    tagged: true,
                    ..Default::default()
                };

                match typst_pdf::pdf(&doc, &options) {
                    Ok(bytes) => TypstCompileResult {
                        success: true,
                        page_count,
                        errors: Vec::new(),
                        warnings,
                        duration_ms: 0,
                        pdf_bytes: Some(bytes),
                    },
                    Err(diags) => TypstCompileResult {
                        success: false,
                        page_count,
                        errors: map_diagnostics(&world, &diags),
                        warnings,
                        duration_ms: 0,
                        pdf_bytes: None,
                    },
                }
            }
        }
    }));

    // Bound Typst's incremental cache so a long-lived session does not
    // accumulate memoized layout frames without limit.
    //
    // MUST go through `typst::comemo`, not a direct `comemo` dependency: the
    // cache is a global static *per crate version*. A direct dep that resolved
    // to a different semver line than Typst's gave us a second, empty cache —
    // eviction silently did nothing and RSS grew ~36 KB per distinct compile
    // forever. Using the re-export makes the versions impossible to diverge.
    typst::comemo::evict(COMEMO_MAX_AGE);

    let duration_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(mut result) => {
            result.duration_ms = duration_ms;
            result
        }
        Err(_) => TypstCompileResult::failure(
            "Typst compiler panicked while rendering the document.",
            duration_ms,
        ),
    }
}

/// Font families the engine can actually resolve on this machine.
pub fn available_font_families() -> Vec<String> {
    let mut names: Vec<String> =
        FONTS.book().families().map(|(name, _)| name.to_string()).collect();
    names.sort();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Emit a Typst string literal exactly the way `typst-escape.ts` does, so
    /// these tests exercise the real contract rather than a friendlier one.
    fn lit(s: &str) -> String {
        let mut out = String::from("\"");
        for ch in s.chars() {
            match ch {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\n' | '\r' | '\t' => out.push(' '),
                c if (c as u32) < 0x20 || c as u32 == 0x7f => {}
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    const PRELUDE: &str = "#set page(paper: \"us-letter\", margin: 0.7in)\n\
         #set text(font: \"Libertinus Serif\", size: 11pt)\n\
         #let rich(parts) = parts.map(p => if p.at(0) { strong(p.at(1)) } else { p.at(1) }).join()\n";

    /// The shipping contract: literals are only ever passed as **code-mode**
    /// arguments to a preamble helper, never spliced into markup.
    fn doc_with_bullet(payload: &str) -> String {
        format!("{PRELUDE}- #rich(((false, {}),))\n", lit(payload))
    }

    /// The unsafe shape this design exists to prevent: a literal dropped
    /// straight into markup, where `#` still opens code mode.
    fn doc_with_markup_splice(payload: &str) -> String {
        format!("{PRELUDE}- {}\n", lit(payload))
    }

    #[test]
    fn compiles_a_minimal_resume() {
        let r = compile_resume_pdf(&doc_with_bullet("Shipped a thing."));
        assert!(r.success, "errors: {:?}", r.errors);
        assert_eq!(r.page_count, 1);
        let pdf = r.pdf_bytes.expect("pdf bytes");
        assert!(pdf.starts_with(b"%PDF-"), "not a pdf");
    }

    #[test]
    fn embedded_families_are_always_available() {
        let families = available_font_families();
        for want in EMBEDDED_FAMILIES {
            assert!(
                families.iter().any(|f| f == want),
                "missing embedded family {want}; have {families:?}"
            );
        }
    }

    #[test]
    fn code_injection_payloads_stay_inert() {
        // Each of these would be catastrophic if it reached code mode.
        let payloads = [
            "#read(\"/etc/passwd\")",
            "#eval(\"1+1\", mode: \"code\")",
            "#import \"@preview/evil:1.0.0\": *",
            "#include \"/etc/hosts\"",
            "\" + read(\"/etc/passwd\") + \"",
            "#show heading: it => [pwned]",
            "#set page(width: 100000pt)",
            "*/ #read(\"/x\") /*",
            "// comment\n#read(\"/x\")",
            "```typ #read(\"/x\") ```",
        ];
        for payload in payloads {
            let r = compile_resume_pdf(&doc_with_bullet(payload));
            assert!(r.success, "payload {payload:?} failed: {:?}", r.errors);
            assert_eq!(r.page_count, 1, "payload {payload:?} changed page count");
        }
    }

    /// Pins *why* the code-mode contract exists. Splicing an escaped literal
    /// into markup re-opens code mode at `#`, so at least one payload stops
    /// being inert. If Typst ever changed such that this passed, the finding
    /// would be that markup splicing had become safe — not that the test rotted.
    #[test]
    fn markup_splicing_is_unsafe_which_is_why_we_use_code_mode() {
        let hostile = "#read(\"/etc/passwd\")";
        let spliced = compile_resume_pdf(&doc_with_markup_splice(hostile));
        let code_mode = compile_resume_pdf(&doc_with_bullet(hostile));
        assert!(
            code_mode.success,
            "code-mode contract must keep the payload inert: {:?}",
            code_mode.errors
        );
        assert!(
            !spliced.success,
            "markup splicing must NOT be treated as safe — if this now \
             succeeds, verify the payload rendered literally before relaxing \
             the code-mode contract"
        );
    }

    /// Pins the invariant that justifies the `expect_used` suppression in
    /// `main_file_id`. If `MAIN_FILE_NAME` is ever changed to something
    /// `VirtualPath` rejects, this fails here instead of panicking mid-compile.
    #[test]
    fn main_file_id_is_infallible() {
        assert!(
            VirtualPath::new(MAIN_FILE_NAME).is_ok(),
            "MAIN_FILE_NAME ({MAIN_FILE_NAME:?}) must be a valid virtual path — \
             the `expect` in main_file_id relies on it"
        );
        // And the id it builds is stable across calls, which is what lets the
        // interning claim in that comment hold.
        assert_eq!(main_file_id(), main_file_id());
    }

    #[test]
    fn direct_file_access_is_denied() {
        let world = ResumeWorld::new("hello".to_string());
        let other = FileId::new(RootedPath::new(
            VirtualRoot::Project,
            VirtualPath::new("secrets.typ").expect("vpath"),
        ));
        assert!(matches!(world.source(other), Err(FileError::AccessDenied)));
        assert!(matches!(world.file(other), Err(FileError::AccessDenied)));
        assert!(matches!(
            world.file(world.main()),
            Err(FileError::AccessDenied)
        ));
    }

    #[test]
    fn unresolvable_read_is_an_error_not_a_leak() {
        // Raw Typst source (not a literal) asking for a file must fail closed.
        let src = "#set page(paper: \"us-letter\")\n#read(\"/etc/passwd\")\n";
        let r = compile_resume_pdf(src);
        assert!(!r.success, "reading /etc/passwd must not succeed");
        assert!(!r.errors.is_empty());
    }

    #[test]
    fn package_import_is_denied() {
        let src = "#import \"@preview/cetz:0.2.2\": *\n= hi\n";
        let r = compile_resume_pdf(src);
        assert!(!r.success, "package import must not resolve");
    }

    #[test]
    fn oversized_source_is_rejected_before_compiling() {
        let src = "a".repeat(MAX_SOURCE_BYTES + 1);
        let r = compile_resume_pdf(&src);
        assert!(!r.success);
        assert!(r.errors[0].message.contains("over the"));
        assert!(r.pdf_bytes.is_none());
    }

    #[test]
    fn runaway_page_count_is_rejected() {
        let huge = "word ".repeat(200_000);
        let r = compile_resume_pdf(&doc_with_bullet(&huge));
        assert!(!r.success, "expected page cap to trip, got {} pages", r.page_count);
        assert!(r.page_count > MAX_PAGES);
        assert!(r.pdf_bytes.is_none());
    }

    #[test]
    fn syntax_error_reports_one_based_line_and_column() {
        // Line 3 is malformed: an unclosed function call.
        let src = "#set page(paper: \"us-letter\")\n= Title\n#strong(\n";
        let r = compile_resume_pdf(src);
        assert!(!r.success);
        let first = &r.errors[0];
        assert_eq!(first.severity, "error");
        assert!(first.line.is_some(), "expected a line number: {first:?}");
        assert!(first.line.unwrap() >= 1, "line must be 1-based");
    }

    #[test]
    fn output_is_deterministic_for_identical_input() {
        let src = doc_with_bullet("Deterministic output check.");
        let a = compile_resume_pdf(&src).pdf_bytes.expect("a");
        let b = compile_resume_pdf(&src).pdf_bytes.expect("b");
        assert_eq!(a, b, "identical source must produce identical PDF bytes");
    }

    #[test]
    fn unicode_survives_round_trip() {
        for payload in [
            "🚀 építész 中文 عربي हिन्दी",
            "e\u{0301}\u{0302}\u{0303}x",
            "Hebrew: שלום Arabic: مرحبا",
        ] {
            let r = compile_resume_pdf(&doc_with_bullet(payload));
            assert!(r.success, "unicode {payload:?} failed: {:?}", r.errors);
        }
    }

    #[test]
    fn empty_source_does_not_panic() {
        let r = compile_resume_pdf("");
        // An empty document is legal Typst; it just has no pages to show.
        assert!(r.errors.iter().all(|e| e.severity == "error"));
        assert!(r.duration_ms < 60_000);
    }

    /// Compile every document the TypeScript templates actually emit.
    ///
    /// This is the only check that the two halves of the swap agree — a
    /// TS-side test can assert structure but not compilability, and a
    /// Rust-side test with hand-written Typst would not exercise the real
    /// renderer. Fixtures are regenerated by
    /// `src/__tests__/lib/typst-fixtures.emit.test.ts`.
    #[test]
    fn rendered_fixtures_compile() {
        let dir = std::env::var("TYPST_FIXTURE_DIR").unwrap_or_else(|_| {
            format!("{}/tests/fixtures/typst", env!("CARGO_MANIFEST_DIR"))
        });
        let entries = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("fixture dir {dir}: {e}"));

        let mut checked = 0usize;
        let mut failures = Vec::new();
        for entry in entries {
            let path = entry.expect("dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("typ") {
                continue;
            }
            let src = std::fs::read_to_string(&path).expect("read fixture");
            let result = compile_resume_pdf(&src);
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if !result.success {
                failures.push(format!("{name}: {:?}", result.errors));
            } else {
                // A resume that silently renders zero pages is also a failure.
                if result.page_count == 0 {
                    failures.push(format!("{name}: rendered 0 pages"));
                }
                assert!(
                    result
                        .pdf_bytes
                        .as_ref()
                        .is_some_and(|b| b.starts_with(b"%PDF-")),
                    "{name}: missing or malformed PDF"
                );
            }
            checked += 1;
        }

        assert!(
            checked >= 20,
            "expected the emitted fixture set, found {checked} files in {dir} \
             — run the TS emitter first"
        );
        assert!(failures.is_empty(), "fixtures failed to compile: {failures:#?}");
    }

    /// comemo's cache is a global static *per crate version*. If a second
    /// version ever enters the dependency graph, `typst::comemo::evict` and the
    /// cache Typst actually fills become different statics, eviction silently
    /// stops working, and memory grows unboundedly across a session. That is a
    /// real bug this project already shipped once, so it is pinned here.
    #[test]
    fn only_one_comemo_version_is_linked() {
        let lock = format!("{}/Cargo.lock", env!("CARGO_MANIFEST_DIR"));
        let Ok(text) = std::fs::read_to_string(&lock) else {
            return; // No lockfile in this build context; nothing to assert.
        };
        let versions: Vec<&str> = text
            .split("[[package]]")
            .filter(|block| block.contains("name = \"comemo\""))
            .filter_map(|block| {
                block
                    .lines()
                    .find_map(|l| l.trim().strip_prefix("version = "))
            })
            .collect();
        assert_eq!(
            versions.len(),
            1,
            "expected exactly one comemo version, found {versions:?} — \
             eviction only reaches the copy Typst links"
        );
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        // 2024 is a leap year: day 59 after Jan 1 is Feb 29.
        assert_eq!(civil_from_days(19_723 + 59), (2024, 2, 29));
    }

    #[test]
    fn today_returns_a_plausible_date() {
        let world = ResumeWorld::new(String::new());
        let today = world.today(None).expect("today");
        assert!(today.year().unwrap_or(0) >= 2024);
    }
}
