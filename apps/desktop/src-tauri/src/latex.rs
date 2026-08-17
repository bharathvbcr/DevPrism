use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Semaphore};

const MAX_CONCURRENT: usize = 3;

/// Deadline for one TeX engine pass (or the whole Tectonic run).
///
/// TeX can loop forever on a recursive macro, and an unbounded wait would hold
/// a `MAX_CONCURRENT` permit plus the per-project lock for the rest of the
/// session. Generous enough for a large real document, short enough that a
/// runaway is recoverable.
const ENGINE_TIMEOUT: Duration = Duration::from_secs(180);

/// Deadline for the bibliography helpers, which are far quicker than a pass.
const BIB_TIMEOUT: Duration = Duration::from_secs(60);

/// Deadline for `--version`-style availability probes.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Prune the per-project lock map once it exceeds this many entries.
const PROJECT_LOCK_PRUNE_AT: usize = 64;

/// Windows CREATE_NO_WINDOW flag to prevent console windows from flashing
/// when spawning TeXLive/Tectonic child processes from the GUI app.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

struct BuildInfo {
    work_dir: PathBuf,
    main_file_name: String,
    report: LatexBuildReport,
}

/// What the last compile of a project actually did, for the UI and the agent.
///
/// Page count lives here because "why is this one page longer than Overleaf?"
/// is only answerable next to the engine that produced it.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct LatexBuildReport {
    /// Engine that typeset the document, e.g. `Tectonic (XeTeX)`.
    pub engine: String,
    /// Engine the document asked for via `% !TEX program`, if any.
    pub requested_engine: Option<String>,
    /// Pages in the produced PDF, read from the engine log.
    pub pages: Option<u32>,
    /// Reasons this build can differ from the same source built elsewhere.
    pub fidelity: Vec<LatexFidelityNote>,
}

#[derive(Clone)]
pub struct LatexCompilerState {
    last_builds: Arc<Mutex<HashMap<String, BuildInfo>>>,
    /// Per-project locks to prevent concurrent compilations on the same build directory.
    project_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    semaphore: Arc<Semaphore>,
}

impl Default for LatexCompilerState {
    fn default() -> Self {
        Self {
            last_builds: Arc::new(Mutex::new(HashMap::new())),
            project_locks: Arc::new(Mutex::new(HashMap::new())),
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT)),
        }
    }
}

#[derive(serde::Serialize)]
pub struct SynctexResult {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

// --- Helpers ---

fn extract_error_lines(log: &str) -> String {
    if log.is_empty() {
        return String::new();
    }

    let lines: Vec<&str> = log.lines().collect();

    let mut blocks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() && blocks.len() < 5 {
        let line = lines[i];
        let is_error_start =
            line.starts_with('!') || line.contains("Error:") || line.contains("error:");

        if is_error_start {
            let end = (i + 14).min(lines.len());
            blocks.push(lines[i..end].join("\n"));
            i = end;
            continue;
        }

        i += 1;
    }

    if !blocks.is_empty() {
        let mut result = blocks.join("\n\n");
        result.push_str("\n\n---- Engine output ----\n");
        let tail_start = lines.len().saturating_sub(20);
        result.push_str(&lines[tail_start..].join("\n"));
        return result;
    }

    if lines.iter().any(|l| l.contains("No pages of output")) {
        return "No pages of output. Add visible content to the document body.".to_string();
    }

    // Fallback: return tail of log.
    //
    // `saturating_sub` bounds the offset but says nothing about char boundaries,
    // and slicing a `str` at a non-boundary byte *panics*. TeX logs routinely
    // carry non-ASCII (font names, package warnings, file paths), so a multi-byte
    // character straddling `len - 500` was a crash — on the UI path, outside any
    // `spawn_blocking`, which meant the compile promise never resolved and the
    // spinner hung for the session.
    let mut start = log.len().saturating_sub(500);
    while start < log.len() && !log.is_char_boundary(start) {
        start += 1;
    }
    log[start..].to_string()
}

/// Read a TeX log for diagnostics: bounded, and never fatal on encoding.
///
/// Two problems with `read_to_string(&log_path).unwrap_or_default()`:
///
/// * **Unbounded.** A document can emit an arbitrarily large log — `\loop
///   \message{...}\repeat` writes for the whole 180s engine timeout — and the
///   whole thing was pulled into memory before anything truncated it.
/// * **Encoding-fatal.** `read_to_string` fails on invalid UTF-8, and TeX writes
///   logs in the input encoding, so Latin-1 bytes in a font name or a
///   `\PackageWarning` turned the entire log into `""`. An empty log is
///   indistinguishable from "no errors", so the actionable message
///   (`! LaTeX Error: File 'r\xe9sum\xe9.sty' not found`) was silently discarded and
///   the user saw only "Compilation failed: no PDF generated".
///
/// Keeps the tail, which is where TeX puts the error block and the summary.
fn read_log_bounded(log_path: &Path) -> String {
    use std::io::{Read, Seek, SeekFrom};

    const MAX_LOG_BYTES: u64 = 1024 * 1024;

    let Ok(mut file) = std::fs::File::open(log_path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len > MAX_LOG_BYTES {
        let _ = file.seek(SeekFrom::Start(len - MAX_LOG_BYTES));
    }
    let mut bytes = Vec::new();
    if file.take(MAX_LOG_BYTES).read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Check if the log contains real TeX errors (! lines or Error: messages).
fn has_real_errors(log: &str) -> bool {
    log.lines()
        .any(|l| l.starts_with('!') || l.contains("Error:"))
}

/// One structured LaTeX compile diagnostic for agent/UI consumers.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct LatexCompileErrorItem {
    pub file: Option<String>,
    pub line: Option<u32>,
    pub message: String,
}

/// Parse `l.N` line numbers from a log line.
fn parse_latex_line_number(s: &str) -> Option<u32> {
    let trimmed = s.trim();
    let rest = trimmed.strip_prefix("l.")?;
    let num: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let n: u32 = num.parse().ok()?;
    (n > 0).then_some(n)
}

/// Parse `path.tex:42:` style file+line references (SyncTeX / engine output).
fn parse_latex_file_line_ref(s: &str) -> Option<(String, u32)> {
    let s = s.trim().trim_start_matches("./").replace('\\', "/");
    let (file_part, after) = s.split_once(':')?;
    if !file_part.ends_with(".tex") {
        return None;
    }
    let line_str: String = after
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let line: u32 = line_str.parse().ok()?;
    (line > 0).then_some((file_part.to_string(), line))
}

/// Extract structured errors (file, line, message) from a LaTeX engine log.
pub fn parse_structured_latex_errors(log: &str) -> Vec<LatexCompileErrorItem> {
    if log.is_empty() {
        return Vec::new();
    }
    let lines: Vec<&str> = log.lines().collect();
    let mut out: Vec<LatexCompileErrorItem> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() && out.len() < 20 {
        let line = lines[i].trim();
        let is_error =
            line.starts_with('!') || line.contains("Error:") || line.contains("error:");
        if !is_error {
            i += 1;
            continue;
        }
        let message = line.trim_start_matches('!').trim().to_string();
        let mut file: Option<String> = None;
        let mut line_no: Option<u32> = None;
        for j in i..(i + 10).min(lines.len()) {
            let l = lines[j].trim();
            if line_no.is_none() {
                line_no = parse_latex_line_number(l);
            }
            if file.is_none() {
                if let Some((f, ln)) = parse_latex_file_line_ref(l) {
                    file = Some(f);
                    if line_no.is_none() {
                        line_no = Some(ln);
                    }
                }
            }
        }
        out.push(LatexCompileErrorItem {
            file,
            line: line_no,
            message,
        });
        i += 1;
    }
    out
}

/// A reason this build can paginate differently from the same source typeset
/// somewhere else.
///
/// Overleaf (and most `latexmk` setups) default to **pdfLaTeX**; the bundled
/// engine is **XeTeX** (Tectonic), which cannot be swapped out. The two lay text
/// out differently, and the difference is cumulative — most visibly, `microtype`
/// only performs font expansion under pdfTeX/LuaTeX, so under XeTeX every line
/// is set at its natural width and a document that just fits N pages elsewhere
/// can spill onto N+1 here. That is a real property of the engine, not a bug we
/// can fix in the typesetter, so the honest thing is to say so.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct LatexFidelityNote {
    /// Stable identifier — matched by tests and the UI, never shown verbatim.
    pub code: String,
    /// One human-readable sentence, including what to do about it.
    pub message: String,
}

impl LatexFidelityNote {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// What actually typeset the document, for reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActualEngine {
    /// Bundled Tectonic — always XeTeX-based.
    TectonicXetex,
    /// A TeX Live binary the user has installed.
    Texlive(TexEngine),
}

impl ActualEngine {
    fn label(self) -> &'static str {
        match self {
            ActualEngine::TectonicXetex => "Tectonic (XeTeX)",
            ActualEngine::Texlive(TexEngine::Latex) => "TeX Live pdfLaTeX",
            ActualEngine::Texlive(TexEngine::XeLaTeX) => "TeX Live XeLaTeX",
            ActualEngine::Texlive(TexEngine::LuaLaTeX) => "TeX Live LuaLaTeX",
        }
    }

    /// True when this engine applies pdfTeX-style font expansion (microtype's
    /// `expansion` feature). XeTeX does not implement it at all.
    fn has_font_expansion(self) -> bool {
        matches!(
            self,
            ActualEngine::Texlive(TexEngine::Latex) | ActualEngine::Texlive(TexEngine::LuaLaTeX)
        )
    }
}

/// Strip TeX comments so package scans don't match commented-out lines.
/// `\%` is an escaped percent and does not start a comment.
fn strip_tex_comments(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    for line in content.lines() {
        let bytes = line.as_bytes();
        let mut end = line.len();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'\\' {
                // Skip the escaped character, whatever it is.
                i += 2;
                continue;
            }
            if bytes[i] == b'%' {
                end = i;
                break;
            }
            i += 1;
        }
        out.push_str(&line[..end]);
        out.push('\n');
    }
    out
}

/// Does the source load `name` via `\usepackage` / `\RequirePackage`?
/// Handles option brackets and comma-separated package lists.
fn source_loads_package(content: &str, name: &str) -> bool {
    let stripped = strip_tex_comments(content);
    for keyword in ["\\usepackage", "\\RequirePackage"] {
        let mut rest = stripped.as_str();
        while let Some(pos) = rest.find(keyword) {
            rest = &rest[pos + keyword.len()..];
            // Skip an optional `[...]` option group.
            let after_opts = match rest.trim_start().strip_prefix('[') {
                Some(inner) => match inner.find(']') {
                    Some(close) => &inner[close + 1..],
                    None => continue,
                },
                None => rest,
            };
            let Some(open) = after_opts.trim_start().strip_prefix('{') else {
                continue;
            };
            let Some(close) = open.find('}') else { continue };
            if open[..close]
                .split(',')
                .any(|pkg| pkg.trim().eq_ignore_ascii_case(name))
            {
                return true;
            }
        }
    }
    false
}

/// Page count from the engine's `Output written on … (N pages, …)` line.
fn parse_output_pages(log: &str) -> Option<u32> {
    let idx = log.rfind("Output written on")?;
    let tail = &log[idx..];
    let open = tail.find('(')?;
    let after = &tail[open + 1..];
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || !after[digits.len()..].trim_start().starts_with("page") {
        return None;
    }
    digits.parse().ok()
}

/// Build the list of reasons this compile may not match another toolchain.
///
/// `source` is the pristine project source (not the build-dir copy), `log` the
/// engine log for this run.
pub(crate) fn collect_fidelity_notes(
    source: &str,
    log: &str,
    actual: ActualEngine,
    requested: Option<TexEngine>,
) -> Vec<LatexFidelityNote> {
    let mut notes = Vec::new();

    if let Some(req) = requested {
        let honoured = match actual {
            ActualEngine::Texlive(e) => e == req,
            ActualEngine::TectonicXetex => req == TexEngine::XeLaTeX,
        };
        if !honoured {
            notes.push(LatexFidelityNote::new(
                "engine-substituted",
                format!(
                    "This document requests {} (`% !TEX program`), but it was typeset with {}. \
                     Install TeX Live and switch the compiler to TeX Live in Settings to build it \
                     with the engine it was written for — line breaks and page count can differ \
                     between engines.",
                    req.program_name(),
                    actual.label()
                ),
            ));
        }
    }

    // microtype's font expansion is pdfTeX/LuaTeX-only. Under XeTeX microtype
    // still does character protrusion, but every line is set at its natural
    // width, so text occupies more lines than the same source on Overleaf.
    let microtype_active =
        log.contains("microtype-xetex.def") || source_loads_package(source, "microtype");
    if microtype_active && !actual.has_font_expansion() {
        notes.push(LatexFidelityNote::new(
            "microtype-expansion-unavailable",
            format!(
                "`microtype` font expansion is not available under {} — it is a pdfTeX/LuaTeX \
                 feature. Character protrusion still applies, but lines are set at their natural \
                 width, so this build can run longer (often exactly one page longer) than the same \
                 source compiled with pdfLaTeX on Overleaf.",
                actual.label()
            ),
        ));
    }

    if let Some(line) = log
        .lines()
        .find(|l| l.contains("Font shape") && l.contains("undefined"))
    {
        notes.push(LatexFidelityNote::new(
            "font-substituted",
            format!(
                "A requested font was unavailable and the engine substituted another, which \
                 changes text metrics and therefore line and page breaks: {}",
                line.trim()
            ),
        ));
    }

    notes
}

/// Result of a synchronous agent-side compile (no PDF bytes — check success only).
#[derive(Debug, serde::Serialize)]
pub struct AgentCompileResult {
    pub success: bool,
    pub main_file: String,
    pub errors: Vec<LatexCompileErrorItem>,
    pub summary: String,
}

/// Normalize and validate a caller-supplied TeX root, returning it
/// project-relative.
///
/// **The rewrite must happen before the check, not after.** `agent_compile_project`
/// used to normalize separators with `main_file.trim().replace('\\', "/")` and
/// join the result — *after* its caller had validated the raw string. On Unix a
/// backslash is an ordinary filename character, so `a\..\..\..\etc\x.tex` is a
/// single `Component::Normal` and passes every traversal check; the rewrite then
/// turned it into `a/../../../etc/x.tex` and every subsequent `join` followed it
/// out of the project. Because the `Compile` tool takes `main_file` from the
/// model, that was a model-reachable arbitrary-file read (the TeX log echoes
/// source lines back into the agent's context) and write
/// (`prepend_xetex_compat_input` rewrites the file it compiles).
///
/// Validating here rather than in the caller also means no future caller can
/// reintroduce the gap by forgetting to check.
fn validated_main_rel(project_dir: &Path, main_file: &str) -> Result<String, String> {
    let normalized = main_file.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("No main file specified.".to_string());
    }

    // Rejects a leading '-' (argv injection into the TeX engine), absolute
    // paths, `..`, and symlinks that resolve outside the project.
    let absolute = crate::export::resolve_project_relative(project_dir, &normalized)?;

    let root = project_dir
        .canonicalize()
        .map_err(|e| format!("Project folder not found: {e}"))?;
    let relative = absolute
        .strip_prefix(&root)
        .map_err(|_| format!("Path must not leave the project: {normalized}"))?;

    // Re-derive from the *validated* path rather than reusing the input string,
    // so the value that reaches every `join` is the one that was checked.
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

/// Compile a project TeX root for the native agent `Compile` tool. Uses the same
/// persistent build dir as the UI compile path but skips the global semaphore.
pub fn agent_compile_project(
    project_dir: &Path,
    main_file: &str,
    use_texlive: bool,
) -> AgentCompileResult {
    let main_rel = match validated_main_rel(project_dir, main_file) {
        Ok(rel) => rel,
        Err(summary) => {
            return AgentCompileResult {
                success: false,
                main_file: main_file.to_string(),
                errors: vec![],
                summary,
            }
        }
    };

    let project_str = project_dir.to_string_lossy();
    let work_dir = persistent_build_dir(&project_str);
    let main_tex_path = work_dir.join(&main_rel);

    if let Err(e) = (|| {
        if work_dir.exists() {
            sync_source_files(project_dir, &work_dir)
                .map_err(|e| format!("Failed to sync project: {}", e))
        } else {
            std::fs::create_dir_all(&work_dir)
                .map_err(|e| format!("Failed to create build dir: {}", e))?;
            copy_dir_recursive(project_dir, &work_dir)
                .map_err(|e| format!("Failed to copy project: {}", e))
        }
    })() {
        return AgentCompileResult {
            success: false,
            main_file: main_rel.clone(),
            errors: vec![],
            summary: e,
        };
    }

    if !work_dir.join(&main_rel).exists() {
        return AgentCompileResult {
            success: false,
            main_file: main_rel.clone(),
            errors: vec![],
            summary: format!("No .tex file found: \"{}\".", main_rel),
        };
    }

    let main_file_name = Path::new(&main_rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();
    let pdf_path = work_dir.join(format!("{}.pdf", main_file_name));
    let log_path = work_dir.join(format!("{}.log", main_file_name));
    // Both, so this run is never judged by the previous run's log (see the
    // matching comment in `compile_latex_inner`).
    let _ = std::fs::remove_file(&pdf_path);
    let _ = std::fs::remove_file(&log_path);

    // Read the pristine project source, not the build copy a previous compile
    // spliced the XeTeX shim into.
    let main_tex_content = std::fs::read_to_string(project_dir.join(&main_rel))
        .unwrap_or_else(|_| {
            strip_xetex_compat_input(&std::fs::read_to_string(&main_tex_path).unwrap_or_default())
        });
    let requested_engine = detect_tex_engine(&main_tex_content);

    let resolved = resolve_backend(use_texlive, requested_engine, &main_tex_content, &|name| {
        find_texlive_binary(name).is_ok()
    });
    let compile_result = if let Some(err) = resolved.hard_error {
        Err(err)
    } else if resolved.use_texlive {
        compile_with_texlive(&work_dir, &main_rel, resolved.engine, &main_tex_content)
    } else {
        compile_with_tectonic_subprocess(&work_dir, &main_rel)
    };
    // Same safety net as the UI path: never let honouring the magic comment turn
    // a building document into a failing one.
    let compile_result = if resolved.use_texlive && !use_texlive && !pdf_path.exists() {
        let _ = std::fs::remove_file(&log_path);
        compile_with_tectonic_subprocess(&work_dir, &main_rel)
    } else {
        compile_result
    };

    if pdf_path.exists() {
        // A PDF on disk is not by itself proof the run succeeded.
        //
        // `compile_with_texlive` makes up to three passes; `run_texlive_pass`
        // returns `Err` on a spawn failure or a *timeout*, and pass 1 has already
        // written a PDF by then. Reporting "Compiled successfully" while
        // discarding that `Err` handed the agent a PDF with unresolved `??`
        // references and swallowed the timeout entirely.
        let summary = match &compile_result {
            Ok(_) => format!("Compiled `{}` successfully.", main_rel),
            Err(e) => format!(
                "Compiled `{}` to a PDF, but the run did not finish cleanly: {e}. \
                 References, citations or the page count may be stale.",
                main_rel
            ),
        };
        return AgentCompileResult {
            success: compile_result.is_ok(),
            main_file: main_rel.clone(),
            errors: vec![],
            summary,
        };
    }

    let log_content = read_log_bounded(&log_path);
    let mut errors = parse_structured_latex_errors(&log_content);
    if errors.is_empty() {
        let fallback = extract_error_lines(&log_content);
        if !fallback.trim().is_empty() {
            for block in fallback.split("\n\n") {
                let msg = block.lines().next().unwrap_or(block).trim();
                if !msg.is_empty() {
                    errors.push(LatexCompileErrorItem {
                        file: Some(main_rel.clone()),
                        line: parse_latex_line_number(msg),
                        message: msg.to_string(),
                    });
                }
            }
        }
    }
    if errors.is_empty() {
        if let Err(e) = compile_result {
            errors.push(LatexCompileErrorItem {
                file: Some(main_rel.clone()),
                line: None,
                message: e,
            });
        } else {
            errors.push(LatexCompileErrorItem {
                file: Some(main_rel.clone()),
                line: None,
                message: "Compilation failed: no PDF generated.".into(),
            });
        }
    }
    let summary = format!(
        "Compilation of `{}` failed with {} error(s).",
        main_rel,
        errors.len()
    );
    AgentCompileResult {
        success: false,
        main_file: main_rel,
        errors,
        summary,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TexEngine {
    Latex,
    XeLaTeX,
    LuaLaTeX,
}

impl TexEngine {
    /// The binary name, which is also how `% !TEX program` spells it.
    fn program_name(self) -> &'static str {
        match self {
            TexEngine::Latex => "pdflatex",
            TexEngine::XeLaTeX => "xelatex",
            TexEngine::LuaLaTeX => "lualatex",
        }
    }
}

/// Detect TeX engine from `% !TEX program = <engine>` magic comment in the first 20 lines.
fn detect_tex_engine(content: &str) -> Option<TexEngine> {
    for line in content.lines().take(20) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix('%') {
            let rest = rest.trim();
            if let Some(rest) = rest.strip_prefix("!TEX") {
                let rest = rest.trim();
                if let Some(rest) = rest.strip_prefix("program") {
                    let rest = rest.trim();
                    if let Some(rest) = rest.strip_prefix('=') {
                        let engine = rest.trim().to_lowercase();
                        return match engine.as_str() {
                            "xelatex" => Some(TexEngine::XeLaTeX),
                            "lualatex" => Some(TexEngine::LuaLaTeX),
                            "pdflatex" | "latex" => Some(TexEngine::Latex),
                            _ => None,
                        };
                    }
                }
            }
        }
    }
    None
}

/// Packages that only work under XeTeX or LuaTeX. Their presence means the
/// document *cannot* be built with pdfLaTeX, so the absence of a
/// `% !TEX program` line still tells us which engine was intended.
const UNICODE_ENGINE_PACKAGES: &[&str] = &[
    "fontspec",
    "unicode-math",
    "polyglossia",
    "xeCJK",
    "luatexja",
    "luacode",
];

/// Engine a document needs when it does not say so itself.
///
/// pdfLaTeX is the default everywhere else (Overleaf, `latexmk`, TeXShop), so it
/// is the default that reproduces other toolchains' pagination. We only depart
/// from it when the source loads something pdfLaTeX physically cannot run.
fn infer_tex_engine(content: &str) -> TexEngine {
    let stripped = strip_tex_comments(content);
    if UNICODE_ENGINE_PACKAGES
        .iter()
        .any(|pkg| source_loads_package(content, pkg))
        || stripped.contains("\\setmainfont")
        || stripped.contains("\\setsansfont")
        || stripped.contains("\\setmonofont")
    {
        TexEngine::XeLaTeX
    } else {
        TexEngine::Latex
    }
}

/// Which backend/engine pair will actually run.
pub(crate) struct ResolvedBackend {
    pub use_texlive: bool,
    /// Engine handed to the TeX Live driver; `None` when Tectonic runs.
    pub engine: Option<TexEngine>,
    pub actual: ActualEngine,
    /// Set when the request cannot be served at all — compile must not start.
    pub hard_error: Option<String>,
}

/// Decide the backend, honouring `% !TEX program` wherever it is possible.
///
/// Tectonic is XeTeX-only. Silently substituting XeTeX for a document that
/// explicitly asked for pdfLaTeX is what makes page counts drift away from
/// Overleaf without any signal to the user, so when TeX Live can serve the
/// requested engine we use it even if Tectonic is the configured backend.
pub(crate) fn resolve_backend(
    prefer_texlive: bool,
    requested: Option<TexEngine>,
    source: &str,
    texlive_lookup: &dyn Fn(&str) -> bool,
) -> ResolvedBackend {
    if prefer_texlive {
        // No magic comment: infer rather than defaulting to XeLaTeX, so a plain
        // pdfLaTeX document is built by pdfLaTeX and paginates like Overleaf.
        let engine = requested.unwrap_or_else(|| infer_tex_engine(source));
        return ResolvedBackend {
            use_texlive: true,
            engine: Some(engine),
            actual: ActualEngine::Texlive(engine),
            hard_error: None,
        };
    }

    match requested {
        // Tectonic can serve XeLaTeX, and an unmarked document gets whatever the
        // bundled engine is — that case is reported through the fidelity notes.
        Some(TexEngine::XeLaTeX) | None => ResolvedBackend {
            use_texlive: false,
            engine: None,
            actual: ActualEngine::TectonicXetex,
            hard_error: None,
        },
        Some(engine) => {
            if texlive_lookup(engine.program_name()) {
                ResolvedBackend {
                    use_texlive: true,
                    engine: Some(engine),
                    actual: ActualEngine::Texlive(engine),
                    hard_error: None,
                }
            } else if engine == TexEngine::LuaLaTeX {
                // LuaLaTeX documents genuinely cannot run on XeTeX — refusing is
                // more useful than emitting a broken PDF.
                ResolvedBackend {
                    use_texlive: false,
                    engine: None,
                    actual: ActualEngine::TectonicXetex,
                    hard_error: Some(
                        "This document requires LuaLaTeX (% !TEX program = lualatex), \
                         which is not supported. Prism uses a XeTeX-based engine (Tectonic). \
                         Install TeX Live to build it, switch to XeLaTeX, or remove the magic \
                         comment."
                            .to_string(),
                    ),
                }
            } else {
                // pdfLaTeX requested, no TeX Live: XeTeX will usually produce a
                // correct-looking PDF, so build it and report the substitution
                // rather than refusing.
                ResolvedBackend {
                    use_texlive: false,
                    engine: None,
                    actual: ActualEngine::TectonicXetex,
                    hard_error: None,
                }
            }
        }
    }
}

#[derive(Debug, PartialEq)]
enum BibTool {
    Biber,
    BibTeX,
    None,
}

/// Detect which bibliography tool is needed by scanning .tex content.
fn detect_bib_tool(content: &str) -> BibTool {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('%') {
            continue;
        }
        if trimmed.contains("\\usepackage") && trimmed.contains("biblatex") {
            return BibTool::Biber;
        }
    }
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('%') {
            continue;
        }
        if trimmed.contains("\\bibliography{") || trimmed.contains("\\addbibresource{") {
            return BibTool::BibTeX;
        }
    }
    BibTool::None
}

/// Resolve a TeXLive binary (engine or tool, e.g. latexdiff) to its full path.
/// GUI apps on macOS lack the user's shell PATH, so we check standard
/// TeXLive installation locations and fall back to a login-shell query.
pub(crate) fn find_texlive_binary(name: &str) -> Result<PathBuf, String> {
    // 1. Try PATH (works when launched from terminal)
    if let Ok(path) = which::which(name) {
        return Ok(path);
    }

    // 2. Check standard TeXLive locations
    #[cfg(not(target_os = "windows"))]
    {
        let standard_paths = [
            format!("/Library/TeX/texbin/{}", name),
            format!("/usr/local/texlive/2025/bin/universal-darwin/{}", name),
            format!("/usr/local/texlive/2024/bin/universal-darwin/{}", name),
            format!("/usr/local/texlive/2025/bin/x86_64-linux/{}", name),
            format!("/usr/local/texlive/2024/bin/x86_64-linux/{}", name),
            format!("/opt/homebrew/bin/{}", name),
            format!("/usr/bin/{}", name),
        ];
        for path_str in &standard_paths {
            let p = PathBuf::from(path_str);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let standard_paths = [
            format!("C:\\texlive\\2025\\bin\\windows\\{}.exe", name),
            format!("C:\\texlive\\2024\\bin\\windows\\{}.exe", name),
        ];
        for path_str in &standard_paths {
            let p = PathBuf::from(path_str);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    // 3. macOS: ask login shell for PATH
    #[cfg(target_os = "macos")]
    {
        let mut probe = std::process::Command::new("/bin/zsh");
        probe.args(["-l", "-c", &format!("which {}", name)]);
        if let Ok(output) = crate::proc::run_with_timeout(probe, PROBE_TIMEOUT) {
            if output.status.success() {
                let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let p = PathBuf::from(&resolved);
                if p.exists() {
                    return Ok(p);
                }
            }
        }
    }

    Err(format!(
        "{} not found. Install TeXLive or add it to your PATH.",
        name
    ))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            // Skip hidden directories (.git, .claudeprism, etc.)
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Sync only source files (.tex, .bib, .sty, .cls, .bst, images, .pdf figures) from project to build dir.
/// Skips build artifacts (.aux, .log, .toc, .synctex.gz, etc.) to preserve them.
/// Note: .pdf is NOT skipped — figure PDFs must be synced. The output PDF is managed by compile_latex.
/// Extensions the engine produces in the build directory. These have no
/// counterpart in the project, so orphan-pruning must leave them alone.
fn is_generated_artifact(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".synctex.gz") || name.ends_with(".synctex") {
        return true;
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    matches!(
        ext,
        "aux" | "log" | "toc" | "lof" | "lot" | "out" | "nav" | "snm" | "vrb"
            | "bbl" | "blg" | "fls" | "fdb_latexmk" | "idx" | "ind" | "ilg"
            | "glo" | "gls" | "glg" | "fmt" | "xdv" | "bcf"
    )
}

// NOTE: `.pdf` is deliberately absent. A project may legitimately contain
// figure PDFs, and treating every PDF as generated would keep a deleted figure
// alive in the build dir — the same staleness bug pruning exists to fix. The
// engine's own output PDF is safe because `compile_latex` removes it before
// each run and regenerates it.

/// Delete build-dir entries whose source counterpart is gone.
///
/// Without this the build directory only ever grows, and — worse — a file the
/// user deleted keeps compiling from its stale copy, so the preview shows a
/// document that no longer exists on disk. Best-effort: failing to remove one
/// entry must not fail the compile.
fn prune_orphans(src: &Path, dst: &Path) {
    let Ok(entries) = std::fs::read_dir(dst) else {
        return;
    };
    for entry in entries.flatten() {
        let dst_path = entry.path();
        let src_path = src.join(entry.file_name());
        if dst_path.is_dir() {
            if src_path.is_dir() {
                prune_orphans(&src_path, &dst_path);
            } else {
                let _ = std::fs::remove_dir_all(&dst_path);
            }
        } else if !src_path.exists() && !is_generated_artifact(&dst_path) {
            let _ = std::fs::remove_file(&dst_path);
        }
    }
}

fn sync_source_files(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    prune_orphans(src, dst);
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dst_path = dst.join(&file_name);
        if src_path.is_dir() {
            let name = file_name.to_string_lossy();
            if name.starts_with('.') || matches!(name.as_ref(), "node_modules" | "target" | "dist")
            {
                continue;
            }
            sync_source_files(&src_path, &dst_path)?;
        } else {
            let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let is_artifact = matches!(
                ext,
                "aux"
                    | "log"
                    | "toc"
                    | "lof"
                    | "lot"
                    | "out"
                    | "nav"
                    | "snm"
                    | "vrb"
                    | "bbl"
                    | "blg"
                    | "fls"
                    | "fdb_latexmk"
                    | "synctex"
                    | "idx"
                    | "ind"
                    | "ilg"
                    | "glo"
                    | "gls"
                    | "glg"
                    | "fmt"
                    | "xdv"
            );
            let is_synctex = src_path.to_string_lossy().ends_with(".synctex.gz");
            if !is_artifact && !is_synctex {
                // Cloud storage (Dropbox/iCloud) may keep files as online-only
                // placeholders with 0 bytes. Reading the file forces a download.
                let metadata = std::fs::metadata(&src_path)?;

                if metadata.len() > 0 {
                    if let Ok(dst_meta) = std::fs::metadata(&dst_path) {
                        if metadata.len() == dst_meta.len() {
                            if let (Ok(src_m), Ok(dst_m)) =
                                (metadata.modified(), dst_meta.modified())
                            {
                                if src_m == dst_m {
                                    continue;
                                }
                            }
                        }
                    }
                }

                if metadata.len() == 0 {
                    // Attempt to materialize the file by reading it
                    let data = std::fs::read(&src_path)?;
                    if !data.is_empty() {
                        std::fs::write(&dst_path, &data)?;
                    } else {
                        std::fs::copy(&src_path, &dst_path)?;
                    }
                } else {
                    std::fs::copy(&src_path, &dst_path)?;
                }
            }
        }
    }
    Ok(())
}

/// Persistent build directory inside the project.
/// Stored in `<project>/.prism/build/` — hidden from file tree (dot-prefix is filtered).
fn persistent_build_dir(project_dir: &str) -> PathBuf {
    PathBuf::from(project_dir).join(".prism").join("build")
}

// --- Thread priority ---

/// Lower the current thread's scheduling priority so CPU-heavy compilation
/// does not starve the WebView's main thread (and thus the UI / typing).
fn lower_thread_priority() {
    #[cfg(target_os = "macos")]
    {
        // QOS_CLASS_UTILITY (0x11) — lower than default, appropriate for long-running work.
        extern "C" {
            fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        }
        unsafe { pthread_set_qos_class_self_np(0x11, 0) };
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        extern "C" {
            fn nice(inc: i32) -> i32;
        }
        unsafe { nice(10) };
    }
}

// --- Tectonic Compilation ---

/// Shadow the bundle's `glyphtounicode.tex` with a harmless stub so that
/// pdfLaTeX-oriented templates compile under the XeTeX-based Tectonic engine.
///
/// XeTeX has no `\pdfglyphtounicode` primitive (it is pdfTeX-only). Many
/// conference/journal templates do an *unguarded* `\input{glyphtounicode}`,
/// whose body is thousands of `\pdfglyphtounicode{...}{...}` lines — under
/// Tectonic the first one aborts with "Undefined control sequence" and no PDF
/// is produced. Tectonic searches the filesystem root before the bundle (see
/// `bridgestate_ioprovider_cascade!` in tectonic's driver), so dropping our own
/// `glyphtounicode.tex` into the build dir makes `\input glyphtounicode` load
/// this stub instead. xdvipdfmx already derives ToUnicode CMaps from each
/// font's cmap, so glyph-to-unicode mapping here is a genuine no-op and the
/// output PDF's copy/paste fidelity is unaffected.
///
/// We never overwrite a `glyphtounicode.tex` that the user's own project
/// provides, and we deliberately do *not* define `\pdfglyphtounicode` globally:
/// doing so would flip `\ifdefined\pdfglyphtounicode` engine-detection guards to
/// true under XeTeX and could trip *other* pdfTeX-only branches. The stub only
/// defines a no-op when it is actually `\input`-ed (i.e. the template asked for
/// it), so guarded templates that skip the input on XeTeX are unaffected.
fn install_glyphtounicode_stub(work_dir: &Path) {
    let stub_path = work_dir.join("glyphtounicode.tex");
    if stub_path.exists() {
        // Respect a copy the user's project ships with.
        return;
    }
    let stub = "\
% glyphtounicode.tex — injected by DevPrism for the XeTeX/Tectonic engine.
% XeTeX lacks the pdfTeX primitive \\pdfglyphtounicode, so pdfLaTeX templates
% that \\input this file abort. This stub shadows the bundle copy (the build
% dir is searched before the bundle). xdvipdfmx builds ToUnicode CMaps from the
% font, so this is a functional no-op.
\\ifx\\pdfglyphtounicode\\undefined
  \\long\\def\\pdfglyphtounicode#1#2{}%
\\fi
\\endinput
";
    // Best-effort: if this write fails the compile simply behaves as before.
    let _ = std::fs::write(&stub_path, stub);
}

/// Marker prepended to the main `.tex` file so pdfTeX-only count-register
/// assignments (e.g. `\pdfgentounicode=1` in `fontenc` / `ragged2e`) compile
/// under the XeTeX-based Tectonic engine.
///
/// Deliberately carries **no trailing newline**: it is spliced onto the front of
/// line 1 rather than occupying a line of its own.  See
/// `prepend_xetex_compat_input`.
const XETEX_COMPAT_INPUT: &str = "\\input{devprism-xetex-compat}";

/// Substring that marks a main file as already carrying the shim.
const XETEX_COMPAT_MARKER: &str = "devprism-xetex-compat";

/// Write `devprism-xetex-compat.tex` into the build dir.  XeTeX lacks several
/// pdfTeX count registers that pdfLaTeX-oriented packages assign during their
/// setup (notably `\pdfgentounicode`, set by `fontenc` and `ragged2e`).  Under
/// Tectonic the first `\pdfgentounicode=1` aborts with "Undefined control
/// sequence".  Defining them as ordinary count registers makes the assignments
/// harmless no-ops; xdvipdfmx already handles ToUnicode mapping from the font.
fn install_xetex_compat_stub(work_dir: &Path) {
    let stub_path = work_dir.join("devprism-xetex-compat.tex");
    if stub_path.exists() {
        return;
    }
    let stub = "\
% devprism-xetex-compat.tex — injected by DevPrism for the XeTeX/Tectonic engine.
% pdfTeX-only count registers are defined as no-op stubs so assignments like
% \\pdfgentounicode=1 in pdfLaTeX-oriented packages do not abort under XeTeX.
\\ifcsname pdfgentounicode\\endcsname\\else
  \\newcount\\pdfgentounicode
\\fi
\\ifcsname pdfinclusioncopyfonts\\endcsname\\else
  \\newcount\\pdfinclusioncopyfonts
\\fi
\\ifcsname pdfcompresslevel\\endcsname\\else
  \\newcount\\pdfcompresslevel
\\fi
\\endinput
";
    let _ = std::fs::write(&stub_path, stub);
}

/// Prepend `\\input{devprism-xetex-compat}` to the main `.tex` in `work_dir`
/// so the shim runs before `\\documentclass` and early `\\usepackage` calls.
/// Idempotent: skips if the marker is already present (e.g. on retry).
///
/// **The shim must not occupy a line of its own.**  The engine reports positions
/// (`l.N` in the log, and every SyncTeX record) against the file it actually
/// read — this mutated build-directory copy — while the user edits the pristine
/// project file.  A trailing newline here would make every reported line one
/// greater than the real one, so "Fix with AI", the error list and
/// click-to-source would all land one line late for the entire document.
/// Splicing onto the front of line 1 keeps the line count identical: TeX loads
/// the shim and then continues on the same line, whether line 1 is
/// `\documentclass`, a `% !TEX` magic comment, or anything else.
///
/// A leading UTF-8 BOM stays in byte position 0 — XeTeX only skips one there,
/// and pushing it mid-line would turn it into a typeset character.
fn prepend_xetex_compat_input(work_dir: &Path, main_file: &str) {
    let main_path = work_dir.join(main_file);
    let Ok(content) = std::fs::read_to_string(&main_path) else {
        return;
    };
    if let Some(modified) = splice_xetex_compat_input(&content) {
        let _ = std::fs::write(&main_path, &modified);
    }
}

/// Splice the shim into `content` without adding a line.
/// `None` when it is already there.
fn splice_xetex_compat_input(content: &str) -> Option<String> {
    if content.contains(XETEX_COMPAT_MARKER) {
        return None;
    }
    // A BOM only stays invisible at byte 0.
    let (prefix, rest) = match content.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", content),
    };
    // A `%&format` directive is only honoured as the first characters of the
    // file, so splice into line 2 instead. Line 1 is a comment either way, so
    // nothing has executed yet and the shim still runs before `\documentclass`.
    if rest.starts_with("%&") {
        if let Some(nl) = rest.find('\n') {
            let (first_line, tail) = rest.split_at(nl + 1);
            return Some(format!("{prefix}{first_line}{XETEX_COMPAT_INPUT}{tail}"));
        }
        // Nothing but the directive — there are no later lines to shift.
        return Some(format!("{prefix}{rest}\n{XETEX_COMPAT_INPUT}"));
    }
    Some(format!("{prefix}{XETEX_COMPAT_INPUT}{rest}"))
}

/// Strip the injected shim from a build-directory copy of a main file, so that
/// content-based detection (engine magic comment, package scans) sees what the
/// user actually wrote rather than what the previous compile left behind.
fn strip_xetex_compat_input(content: &str) -> String {
    content.replacen(XETEX_COMPAT_INPUT, "", 1)
}

pub(crate) fn compile_with_tectonic(work_dir: &Path, main_file: &str) -> Result<(), String> {
    use tectonic::config::PersistentConfig;
    use tectonic::driver::{OutputFormat, PassSetting, ProcessingSessionBuilder};
    use tectonic::status::NoopStatusBackend;

    install_glyphtounicode_stub(work_dir);
    install_xetex_compat_stub(work_dir);
    prepend_xetex_compat_input(work_dir, main_file);

    let mut status = NoopStatusBackend {};

    let config = PersistentConfig::open(false)
        .map_err(|e| format!("Failed to open tectonic config: {}", e))?;

    let bundle = config.default_bundle(false, &mut status).map_err(|e| {
        format!(
            "Failed to load tectonic bundle (check network connection): {}",
            e
        )
    })?;

    let format_cache = config
        .format_cache_path()
        .map_err(|e| format!("Failed to get format cache path: {}", e))?;

    let mut builder = ProcessingSessionBuilder::default();
    builder
        .bundle(bundle)
        .primary_input_path(work_dir.join(main_file))
        .tex_input_name(main_file)
        .filesystem_root(work_dir)
        .output_dir(work_dir)
        .format_name("latex")
        .format_cache_path(format_cache)
        .output_format(OutputFormat::Pdf)
        .pass(PassSetting::Default)
        .synctex(true)
        .keep_intermediates(true)
        .keep_logs(true);

    let mut session = builder
        .create(&mut status)
        .map_err(|e| format!("Failed to create tectonic session: {}", e))?;

    session.run(&mut status).map_err(|e| format!("{}", e))?;

    Ok(())
}

/// Run tectonic compilation in an isolated subprocess.
///
/// This avoids the font cache assertion failure (`font_cache.fonts == NULL`)
/// that occurs when tectonic is called multiple times in the same process.
/// The C-level static `font_cache` in `dpx-pdffont.c` is not cleaned up
/// on compilation failure, causing subsequent calls to abort.
///
/// By spawning a subprocess, each compilation gets a fresh process with
/// clean global state, and cleanup happens automatically on process exit.
fn compile_with_tectonic_subprocess(work_dir: &Path, main_file: &str) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to get current executable path: {}", e))?;

    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["--tectonic-compile", &work_dir.to_string_lossy(), main_file]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = crate::proc::run_with_timeout(cmd, ENGINE_TIMEOUT)
        .map_err(|e| e.to_message("Compilation"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return Err(stderr);
    }

    // A signalled engine writes neither a log nor a message, so without this the
    // user sees a bare "no PDF generated". The overwhelmingly common cause is a
    // font the document asks for that the engine cannot load — XeTeX aborts
    // rather than reporting it.
    Err(describe_engine_death(&output.status))
}

/// Human-readable cause for a TeX engine that exited without saying anything.
fn describe_engine_death(status: &std::process::ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return format!(
                "The TeX engine was terminated by signal {signal} without writing a log. \
                 This is usually a font the document requests but the engine cannot load — \
                 check any `\\setmainfont`/`fontspec` fonts are installed, or that packages \
                 needing system fonts (e.g. `fontawesome5`) have theirs.",
            );
        }
    }
    match status.code() {
        Some(code) => format!("The TeX engine exited with status {code} without writing a log."),
        None => "The TeX engine exited abnormally without writing a log.".to_string(),
    }
}

// --- TeXLive Compilation ---

/// Build a PATH that includes the TeXLive bin directory so that xelatex
/// can find xdvipdfmx, kpsewhich, and other tools it invokes internally.
/// GUI apps on macOS have a minimal PATH that doesn't include TeXLive.
fn texlive_env_path(engine: &Path) -> String {
    let texbin = engine
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let current_path = std::env::var("PATH").unwrap_or_default();
    if current_path.contains(&texbin) {
        current_path
    } else {
        #[cfg(target_os = "windows")]
        {
            format!("{};{}", texbin, current_path)
        }
        #[cfg(not(target_os = "windows"))]
        {
            format!("{}:{}", texbin, current_path)
        }
    }
}

/// Run a single TeX engine pass.  Never returns `Err` for a non-zero exit
/// code — TeXLive returns non-zero for warnings, font substitutions, etc.
/// The only `Err` is when the process cannot be *spawned* at all.
/// The caller decides success by checking whether the PDF was produced.
fn run_texlive_pass(
    engine: &Path,
    args: &[&str],
    main_file: &Path,
    work_dir: &Path,
) -> Result<(), String> {
    let mut cmd = std::process::Command::new(engine);
    cmd.args(args)
        .arg(main_file)
        .current_dir(work_dir)
        .env("PATH", texlive_env_path(engine));
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = crate::proc::run_with_timeout(cmd, ENGINE_TIMEOUT)
        .map_err(|e| e.to_message(&format!("{}", engine.display())))?;

    // TeXLive returns non-zero on warnings too — don't fail here.
    // The caller decides success by checking whether the PDF was produced.
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            eprintln!("[texlive] engine stderr: {}", stderr.trim());
        }
    }
    Ok(())
}

fn compile_with_texlive(
    work_dir: &Path,
    main_file: &str,
    engine: Option<TexEngine>,
    tex_content: &str,
) -> Result<(), String> {
    let engine_name = match engine {
        Some(TexEngine::XeLaTeX) | None => "xelatex",
        Some(TexEngine::Latex) => "pdflatex",
        Some(TexEngine::LuaLaTeX) => "lualatex",
    };

    let engine_path = find_texlive_binary(engine_name)?;
    let env_path = texlive_env_path(&engine_path);
    eprintln!(
        "[texlive] backend: {} ({})",
        engine_name,
        engine_path.display()
    );
    let bib_tool = detect_bib_tool(tex_content);

    // Use "." as output-directory since current_dir is already work_dir.
    // Absolute paths break when they contain ~ (e.g. iCloud's com~apple~CloudDocs)
    // because TeX interprets ~ as a home directory shortcut.
    let output_dir_arg = "-output-directory=.".to_string();
    // Do NOT use -halt-on-error: xelatex is a pipeline (xetex → .xdv → xdvipdfmx → .pdf).
    // With -halt-on-error, recoverable warnings (e.g. missing font shapes) cause xetex to
    // exit non-zero, and the xelatex wrapper skips the xdvipdfmx step — producing .xdv but
    // no .pdf.  -interaction=nonstopmode alone is sufficient to avoid interactive prompts.
    let common_args: Vec<&str> = vec!["-synctex=1", "-interaction=nonstopmode", &output_dir_arg];

    let main_file_path = Path::new(main_file);

    // Pass 1
    run_texlive_pass(&engine_path, &common_args, main_file_path, work_dir)?;

    // Bib pass (if needed)
    let main_stem = Path::new(main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");

    match bib_tool {
        BibTool::Biber => {
            let biber_path = find_texlive_binary("biber")?;
            let mut cmd = std::process::Command::new(&biber_path);
            cmd.arg(main_stem)
                .current_dir(work_dir)
                .env("PATH", &env_path)
                ;
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let output = crate::proc::run_with_timeout(cmd, BIB_TIMEOUT)
                .map_err(|e| e.to_message("biber"))?;
            if !output.status.success() {
                eprintln!(
                    "[texlive] biber warning: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        BibTool::BibTeX => {
            let bibtex_path = find_texlive_binary("bibtex")?;
            let aux_file = work_dir.join(format!("{}.aux", main_stem));
            let mut cmd = std::process::Command::new(&bibtex_path);
            cmd.arg(&aux_file)
                .current_dir(work_dir)
                .env("PATH", &env_path)
                ;
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let output = crate::proc::run_with_timeout(cmd, BIB_TIMEOUT)
                .map_err(|e| e.to_message("bibtex"))?;
            if !output.status.success() {
                eprintln!(
                    "[texlive] bibtex warning: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        BibTool::None => {}
    }

    // Pass 2: resolve references / TOC
    run_texlive_pass(&engine_path, &common_args, &main_file_path, work_dir)?;

    // Pass 3: stabilize citations (only if bib was used)
    if !matches!(bib_tool, BibTool::None) {
        run_texlive_pass(&engine_path, &common_args, &main_file_path, work_dir)?;
    }

    let pdf_path = work_dir.join(format!("{}.pdf", main_stem));
    let xdv_path = work_dir.join(format!("{}.xdv", main_stem));

    // Fallback: if xelatex produced .xdv but no .pdf (e.g. xdvipdfmx was skipped due to
    // warnings), manually run xdvipdfmx to convert .xdv → .pdf.
    if !pdf_path.exists() && xdv_path.exists() {
        eprintln!("[texlive] .xdv exists but no .pdf — running xdvipdfmx manually");
        if let Ok(xdvipdfmx) = find_texlive_binary("xdvipdfmx") {
            let mut cmd = std::process::Command::new(&xdvipdfmx);
            cmd.args(["-o", &pdf_path.to_string_lossy()])
                .arg(&xdv_path)
                .current_dir(work_dir)
                .env("PATH", &env_path);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let output = crate::proc::run_with_timeout(cmd, ENGINE_TIMEOUT)
                .map_err(|e| e.to_message("xdvipdfmx"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if !stderr.trim().is_empty() {
                    eprintln!("[texlive] xdvipdfmx stderr: {}", stderr.trim());
                }
            }
        }
    }

    // Success is determined by whether the PDF exists, not by exit codes.
    // The caller (compile_latex) checks pdf_path.exists() and reads the log for errors.
    Ok(())
}

// --- SyncTeX Native Parser ---

struct SynctexNode {
    tag: u32,
    line: u32,
    h: f64, // PDF points
    v: f64, // PDF points
    width: f64,
    height: f64,
}

#[derive(serde::Serialize)]
pub struct SynctexForwardResult {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn normalize_synctex_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches(".\\")
        .to_string()
}

fn synctex_paths_match(stored: &str, target: &str) -> bool {
    let a = normalize_synctex_path(stored);
    let b = normalize_synctex_path(target);
    if a == b {
        return true;
    }
    if a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}")) {
        return true;
    }
    let a_name = Path::new(&a).file_name().and_then(|s| s.to_str()).unwrap_or("");
    let b_name = Path::new(&b).file_name().and_then(|s| s.to_str()).unwrap_or("");
    !a_name.is_empty() && a_name == b_name
}

/// Forward SyncTeX: source (file, line) → PDF page + rectangle in points.
fn parse_synctex_forward(
    data: &str,
    target_file: &str,
    target_line: u32,
) -> Option<SynctexForwardResult> {
    let mut inputs: HashMap<u32, String> = HashMap::new();
    let mut magnification: f64 = 1000.0;
    let mut unit: f64 = 1.0;
    let mut x_offset: f64 = 0.0;
    let mut y_offset: f64 = 0.0;

    let mut in_content = false;
    let mut current_page: u32 = 0;
    let mut best: Option<(u32, SynctexNode, u32)> = None; // page, node, line distance

    for raw_line in data.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if !in_content {
            if let Some(rest) = line.strip_prefix("Input:") {
                if let Some(colon_pos) = rest.find(':') {
                    if let Ok(tag) = rest[..colon_pos].parse::<u32>() {
                        inputs.insert(tag, rest[colon_pos + 1..].to_string());
                    }
                }
            } else if let Some(rest) = line.strip_prefix("Magnification:") {
                magnification = rest.trim().parse().unwrap_or(1000.0);
            } else if let Some(rest) = line.strip_prefix("Unit:") {
                unit = rest.trim().parse().unwrap_or(1.0);
            } else if let Some(rest) = line.strip_prefix("X Offset:") {
                x_offset = rest.trim().parse().unwrap_or(0.0);
            } else if let Some(rest) = line.strip_prefix("Y Offset:") {
                y_offset = rest.trim().parse().unwrap_or(0.0);
            } else if line == "Content:" {
                in_content = true;
            }
            continue;
        }

        if line.starts_with("Postamble:") {
            break;
        }

        let first_byte = match line.as_bytes().first() {
            Some(b) => *b,
            None => continue,
        };

        match first_byte {
            b'{' => {
                current_page = line.get(1..).and_then(|s| s.parse().ok()).unwrap_or(0);
            }
            b'}' => {
                current_page = 0;
            }
            b'[' | b'(' | b'h' | b'v' | b'k' | b'x' | b'g' | b'$' if current_page > 0 => {
                let factor = unit * magnification / (1000.0 * 65536.0) * 72.0 / 72.27;
                if let Some(node) = line
                    .get(1..)
                    .and_then(|s| parse_synctex_node(s, factor, x_offset, y_offset))
                {
                    let file = inputs.get(&node.tag)?;
                    if !synctex_paths_match(file, target_file) {
                        continue;
                    }
                    let line_dist = node.line.abs_diff(target_line);
                    let replace = match best {
                        None => true,
                        Some((_, _, prev_dist)) => {
                            line_dist < prev_dist
                                || (line_dist == prev_dist && node.line >= target_line)
                        }
                    };
                    if replace {
                        best = Some((current_page, node, line_dist));
                    }
                }
            }
            _ => {}
        }
    }

    let (page, node, _) = best?;
    Some(SynctexForwardResult {
        page,
        x: node.h,
        y: node.v,
        width: node.width.max(24.0),
        height: node.height.max(12.0),
    })
}

/// Parse synctex data and find the source location closest to (target_x, target_y) on target_page.
fn parse_synctex_data(
    data: &str,
    target_page: u32,
    target_x: f64,
    target_y: f64,
) -> Option<(String, u32, u32)> {
    let mut inputs: HashMap<u32, String> = HashMap::new();
    let mut magnification: f64 = 1000.0;
    let mut unit: f64 = 1.0;
    let mut x_offset: f64 = 0.0;
    let mut y_offset: f64 = 0.0;

    let mut in_content = false;
    let mut on_target_page = false;
    let mut nodes: Vec<SynctexNode> = Vec::new();

    for raw_line in data.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if !in_content {
            if let Some(rest) = line.strip_prefix("Input:") {
                if let Some(colon_pos) = rest.find(':') {
                    if let Ok(tag) = rest[..colon_pos].parse::<u32>() {
                        inputs.insert(tag, rest[colon_pos + 1..].to_string());
                    }
                }
            } else if let Some(rest) = line.strip_prefix("Magnification:") {
                magnification = rest.trim().parse().unwrap_or(1000.0);
            } else if let Some(rest) = line.strip_prefix("Unit:") {
                unit = rest.trim().parse().unwrap_or(1.0);
            } else if let Some(rest) = line.strip_prefix("X Offset:") {
                x_offset = rest.trim().parse().unwrap_or(0.0);
            } else if let Some(rest) = line.strip_prefix("Y Offset:") {
                y_offset = rest.trim().parse().unwrap_or(0.0);
            } else if line == "Content:" {
                in_content = true;
            }
            continue;
        }

        // Content section
        if line.starts_with("Postamble:") {
            break;
        }

        let first_byte = match line.as_bytes().first() {
            Some(b) => *b,
            None => continue,
        };
        match first_byte {
            b'{' => {
                let page: u32 = line.get(1..).and_then(|s| s.parse().ok()).unwrap_or(0);
                on_target_page = page == target_page;
            }
            b'}' => {
                on_target_page = false;
            }
            // Box/node records: [, (, h, v, k, x, g, $
            b'[' | b'(' | b'h' | b'v' | b'k' | b'x' | b'g' | b'$' if on_target_page => {
                // Convert synctex internal units to PDF points (bp)
                // 1 TeX pt = 65536 sp; 1 inch = 72.27 TeX pt = 72 PDF bp
                let factor = unit * magnification / (1000.0 * 65536.0) * 72.0 / 72.27;
                if let Some(node) = line
                    .get(1..)
                    .and_then(|s| parse_synctex_node(s, factor, x_offset, y_offset))
                {
                    nodes.push(node);
                }
            }
            _ => {}
        }
    }

    if nodes.is_empty() {
        return None;
    }

    // Find closest node to (target_x, target_y)
    let mut best_idx = 0;
    let mut best_dist = f64::MAX;
    for (i, node) in nodes.iter().enumerate() {
        let dx = node.h - target_x;
        let dy = node.v - target_y;
        let dist = dx * dx + dy * dy;
        if dist < best_dist {
            best_dist = dist;
            best_idx = i;
        }
    }

    let best = nodes.get(best_idx)?;
    let filename = inputs.get(&best.tag)?.clone();
    Some((filename, best.line, 0))
}

/// Parse a synctex node record (after stripping the type character).
/// Format: `<tag>,<line>,<column>:<h>,<v>[:<W>,<H>,<D>]`
fn parse_synctex_node(s: &str, factor: f64, x_offset: f64, y_offset: f64) -> Option<SynctexNode> {
    let colon_parts: Vec<&str> = s.splitn(4, ':').collect();
    if colon_parts.len() < 2 {
        return None;
    }

    // Parse tag and line (ignore column)
    let first_part = colon_parts.first()?;
    let tlc: Vec<&str> = first_part.splitn(3, ',').collect();
    if tlc.len() < 2 {
        return None;
    }
    let tag: u32 = tlc.first()?.parse().ok()?;
    let line: u32 = tlc.get(1)?.parse().ok()?;

    // Parse h, v coordinates
    let second_part = colon_parts.get(1)?;
    let hv: Vec<&str> = second_part.splitn(2, ',').collect();
    if hv.len() < 2 {
        return None;
    }
    let h_raw: i64 = hv.first()?.parse().ok()?;
    let v_raw: i64 = hv.get(1)?.parse().ok()?;

    let h = h_raw as f64 * factor + x_offset;
    let v = v_raw as f64 * factor + y_offset;

    let (width, height) = if colon_parts.len() >= 3 {
        let whd: Vec<&str> = colon_parts[2].splitn(3, ',').collect();
        let w = whd
            .first()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0)
            * factor;
        let ht = whd
            .get(1)
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0)
            * factor;
        (w, ht)
    } else {
        (0.0, 0.0)
    };

    Some(SynctexNode {
        tag,
        line,
        h,
        v,
        width,
        height,
    })
}

// --- Tauri Commands ---

#[derive(serde::Serialize)]
pub struct TexliveStatus {
    pub available: bool,
    pub engines: Vec<String>,
    pub version: Option<String>,
}

#[tauri::command]
pub fn detect_texlive() -> TexliveStatus {
    let engines_to_check = ["pdflatex", "xelatex", "lualatex"];
    let mut found_engines = Vec::new();

    for name in &engines_to_check {
        if find_texlive_binary(name).is_ok() {
            found_engines.push(name.to_string());
        }
    }

    let version = find_texlive_binary("pdflatex").ok().and_then(|path| {
        let mut cmd = std::process::Command::new(&path);
        cmd.arg("--version");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        crate::proc::run_with_timeout(cmd, PROBE_TIMEOUT).ok().and_then(|o| {
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout.lines().next().map(|l| l.to_string())
        })
    });

    TexliveStatus {
        available: !found_engines.is_empty(),
        engines: found_engines,
        version,
    }
}

#[tauri::command]
pub async fn compile_latex(
    state: tauri::State<'_, LatexCompilerState>,
    project_dir: String,
    main_file: String,
    use_texlive: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    match compile_latex_inner(&state, project_dir, main_file, use_texlive).await {
        Ok(bytes) => Ok(tauri::ipc::Response::new(bytes)),
        Err(fail) => Err(fail.into_user_message()),
    }
}

/// What the last successful compile of `project_dir` did, including every reason
/// its pagination can differ from the same source built elsewhere.
///
/// `None` when nothing has been compiled for this project yet.
#[tauri::command]
pub async fn latex_build_report(
    state: tauri::State<'_, LatexCompilerState>,
    project_dir: String,
) -> Result<Option<LatexBuildReport>, String> {
    let builds = state.last_builds.lock().await;
    Ok(builds.get(&project_dir).map(|b| b.report.clone()))
}

struct CompileFail {
    backend_label: String,
    message: String,
}

impl CompileFail {
    fn into_user_message(self) -> String {
        format!(
            "Compilation failed ({})\n\n{}",
            self.backend_label, self.message
        )
    }

    fn new(backend_label: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            backend_label: backend_label.into(),
            message: message.into(),
        }
    }
}

async fn compile_latex_inner(
    state: &LatexCompilerState,
    project_dir: String,
    main_file: String,
    use_texlive: Option<bool>,
) -> Result<Vec<u8>, CompileFail> {
    // Acquire semaphore permit (non-blocking)
    let _permit = state
        .semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| CompileFail {
            backend_label: "n/a".into(),
            message: "Server busy, too many concurrent compilations".into(),
        })?;

    // Acquire per-project lock to prevent concurrent compilations on the same build dir.
    let project_lock = {
        let mut locks = state.project_locks.lock().await;
        // Drop locks nobody is holding or waiting on. Without this the map
        // grows by one entry per project opened and never shrinks. A strong
        // count of 1 means only the map itself holds the Arc.
        if locks.len() > PROJECT_LOCK_PRUNE_AT {
            locks.retain(|key, lock| key == &project_dir || Arc::strong_count(lock) > 1);
        }
        locks
            .entry(project_dir.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _project_guard = project_lock.lock().await;

    // Suppress macOS App Nap while Tectonic runs so a backgrounded window does
    // not throttle the compile. Released on every return path (drop at fn end).
    #[cfg(target_os = "macos")]
    let _nap = crate::app_nap::NapActivity::begin("LaTeX compile");

    let t0 = std::time::Instant::now();
    let use_texlive = use_texlive.unwrap_or(false);

    let main_file_name = Path::new(&main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();

    // Set up build directory (offload blocking I/O to avoid starving the async runtime)
    let work_dir = persistent_build_dir(&project_dir);
    let is_reuse = work_dir.exists();

    {
        let work_dir = work_dir.clone();
        let project_dir = project_dir.clone();
        tokio::task::spawn_blocking(move || {
            if is_reuse {
                sync_source_files(Path::new(&project_dir), &work_dir)
                    .map_err(|e| format!("Failed to sync project: {}", e))
            } else {
                std::fs::create_dir_all(&work_dir)
                    .map_err(|e| format!("Failed to create build dir: {}", e))?;
                copy_dir_recursive(Path::new(&project_dir), &work_dir)
                    .map_err(|e| format!("Failed to copy project: {}", e))
            }
        })
        .await
        .map_err(|e| CompileFail::new("n/a", format!("File sync task panicked: {e}")))?
        .map_err(|e| CompileFail::new("n/a", e))?;
    }

    eprintln!(
        "[latex] +{:.0}ms {} ({}, backend={})",
        t0.elapsed().as_millis(),
        if is_reuse {
            "sync source files"
        } else {
            "full copy"
        },
        if is_reuse { "reuse" } else { "first build" },
        if use_texlive { "texlive" } else { "tectonic" }
    );

    // Remove the stale PDF *and log* so this run cannot be judged by the last
    // one's output. Leaving the log behind means a run that dies before writing
    // one (a signalled engine, a missing font) reports the previous run's
    // errors, and — worse — a stale "No pages of output" triggers the
    // `\AtEndDocument{\null}` retry below, which appends an empty box and can
    // push a full page over onto a new one.
    let pdf_path = work_dir.join(format!("{}.pdf", main_file_name));
    let log_path = work_dir.join(format!("{}.log", main_file_name));
    let _ = std::fs::remove_file(&pdf_path);
    let _ = std::fs::remove_file(&log_path);

    // Verify the main TeX file exists before attempting compilation
    let main_tex_path = work_dir.join(&main_file);
    if !main_tex_path.exists() {
        return Err(CompileFail::new(
            "n/a",
            format!(
                "No .tex file found: \"{main_file}\". Create a document.tex or main.tex file to compile."
            ),
        ));
    }

    // Engine detection reads the *project* source, never the build-dir copy: a
    // previous compile spliced the XeTeX shim into that copy, and reading it
    // back would let our own injection influence what we detect.
    let main_tex_content = std::fs::read_to_string(Path::new(&project_dir).join(&main_file))
        .map(|c| c.to_string())
        .unwrap_or_else(|_| {
            strip_xetex_compat_input(&std::fs::read_to_string(&main_tex_path).unwrap_or_default())
        });
    let requested_engine = detect_tex_engine(&main_tex_content);

    let resolved = resolve_backend(use_texlive, requested_engine, &main_tex_content, &|name| {
        find_texlive_binary(name).is_ok()
    });
    if let Some(err) = resolved.hard_error {
        return Err(CompileFail::new(
            if use_texlive { "TeXLive" } else { "Tectonic" },
            err,
        ));
    }
    let auto_switched_to_texlive = resolved.use_texlive && !use_texlive;
    let mut use_texlive = resolved.use_texlive;
    let engine = resolved.engine;

    let mut actual_engine = resolved.actual;
    let mut backend_label = actual_engine.label().to_string();

    let mut compile_result = if use_texlive {
        let work_dir_clone = work_dir.clone();
        let main_file_clone = main_file.clone();
        let source = main_tex_content.clone();
        let result = tokio::task::spawn_blocking(move || {
            lower_thread_priority();
            compile_with_texlive(&work_dir_clone, &main_file_clone, engine, &source)
        })
        .await
        .map_err(|e| CompileFail::new(&backend_label, format!("Compilation task panicked: {e}")))?;
        eprintln!(
            "[latex] +{:.0}ms texlive done (ok={})",
            t0.elapsed().as_millis(),
            result.is_ok()
        );
        result
    } else {
        // Run Tectonic in a subprocess to isolate C-level global state (font cache, etc.).
        let work_dir_clone = work_dir.clone();
        let main_file_clone = main_file.clone();
        let backend = backend_label.clone();
        let result = tokio::task::spawn_blocking(move || {
            lower_thread_priority();
            compile_with_tectonic_subprocess(&work_dir_clone, &main_file_clone)
        })
        .await
        .map_err(|e| CompileFail::new(&backend, format!("Compilation task panicked: {e}")))?;
        eprintln!(
            "[latex] +{:.0}ms tectonic done (ok={})",
            t0.elapsed().as_millis(),
            result.is_ok()
        );
        result
    };

    // Honouring `% !TEX program` must never make a document that used to build
    // stop building: a TeX Live install can be incomplete where the Tectonic
    // bundle is not. If the engine we switched to produced nothing, fall back to
    // the configured backend and say so in the report.
    let mut texlive_fallback = false;
    if auto_switched_to_texlive && !pdf_path.exists() {
        eprintln!("[latex] auto-selected TeX Live produced no PDF — falling back to Tectonic");
        let _ = std::fs::remove_file(&log_path);
        let work_dir_clone = work_dir.clone();
        let main_file_clone = main_file.clone();
        let backend = backend_label.clone();
        compile_result = tokio::task::spawn_blocking(move || {
            lower_thread_priority();
            compile_with_tectonic_subprocess(&work_dir_clone, &main_file_clone)
        })
        .await
        .map_err(|e| CompileFail::new(&backend, format!("Compilation task panicked: {e}")))?;
        use_texlive = false;
        texlive_fallback = true;
        actual_engine = ActualEngine::TectonicXetex;
        backend_label = actual_engine.label().to_string();
    }

    // Handle "No pages of output" — retry with \AtEndDocument{\null} injection (Tectonic only).
    // TeXLive multi-pass handles this differently; the injection is Tectonic-specific.
    if !use_texlive && !pdf_path.exists() {
        let log_path_clone = log_path.clone();
        let main_tex = work_dir.join(&main_file);
        let pdf_path_clone = pdf_path.clone();
        let main_file_clone = main_file.clone();
        let work_dir_clone = work_dir.clone();

        let needs_retry = tokio::task::spawn_blocking(move || {
            let log_content = std::fs::read_to_string(&log_path_clone).unwrap_or_default();
            if !log_content.contains("No pages of output") || has_real_errors(&log_content) {
                return Ok(false);
            }
            eprintln!("[latex] no pages of output — retrying with \\null injection");
            if let Ok(content) = std::fs::read_to_string(&main_tex) {
                if let Some(pos) = content.find("\\begin{document}") {
                    let modified = format!(
                        "{}\\AtEndDocument{{\\null}}{}",
                        &content[..pos],
                        &content[pos..]
                    );
                    let _ = std::fs::write(&main_tex, &modified);
                    return Ok(true);
                }
            }
            Ok::<bool, String>(false)
        })
        .await
        .map_err(|e| CompileFail::new(&backend_label, format!("Retry prep panicked: {e}")))?
        .map_err(|e| CompileFail::new(&backend_label, e))?;

        if needs_retry {
            let retry_result = tokio::task::spawn_blocking(move || {
                compile_with_tectonic_subprocess(&work_dir_clone, &main_file_clone)
            })
            .await
            .map_err(|e| CompileFail::new(&backend_label, format!("Retry task panicked: {e}")))?;
            eprintln!(
                "[latex] empty-body retry: ok={} pdf_exists={}",
                retry_result.is_ok(),
                pdf_path_clone.exists()
            );
        }
    }

    // Explain, from this run's own log, every way the result can differ from the
    // same source built on another toolchain. Without this a page count that
    // disagrees with Overleaf looks like a defect with no visible cause.
    let final_log = read_log_bounded(&log_path);
    let mut fidelity = collect_fidelity_notes(
        &main_tex_content,
        &final_log,
        actual_engine,
        requested_engine,
    );
    if texlive_fallback {
        fidelity.insert(
            0,
            LatexFidelityNote::new(
                "texlive-fallback",
                "TeX Live was selected to match the engine this document requests, but it \
                 produced no PDF, so the build fell back to the bundled Tectonic engine.",
            ),
        );
    }
    let report = LatexBuildReport {
        engine: backend_label.clone(),
        requested_engine: requested_engine.map(|e| e.program_name().to_string()),
        pages: parse_output_pages(&final_log),
        fidelity,
    };
    for note in &report.fidelity {
        eprintln!("[latex] fidelity: {} — {}", note.code, note.message);
    }

    // Store build info — but NOT for DevPrism's throwaway temp compiles (e.g.
    // the track-changes diff preview `.devprism-...tex`). Those share the
    // per-project build dir, so recording them here would overwrite the real
    // document's BuildInfo and make SyncTeX (click-to-source / forward sync)
    // resolve against the temp document until the next real compile.
    if !main_file_name.starts_with(".devprism-") {
        let mut builds = state.last_builds.lock().await;
        builds.insert(
            project_dir.clone(),
            BuildInfo {
                work_dir: work_dir.clone(),
                main_file_name: main_file_name.clone(),
                report,
            },
        );
    }

    if pdf_path.exists() {
        let pdf_path_clone = pdf_path.clone();
        let pdf_bytes = tokio::task::spawn_blocking(move || std::fs::read(&pdf_path_clone))
            .await
            .map_err(|e| CompileFail::new(&backend_label, format!("PDF read task panicked: {e}")))?
            .map_err(|e| CompileFail::new(&backend_label, format!("Failed to read PDF: {e}")))?;
        eprintln!(
            "[latex] +{:.0}ms total (reuse={}, backend={}) pdf_size={}KB",
            t0.elapsed().as_millis(),
            is_reuse,
            backend_label,
            pdf_bytes.len() / 1024
        );
        // Sweep DevPrism's throwaway preview artifacts from the persistent build
        // dir so they don't accumulate (each preview uses a unique temp name).
        // Self-healing: removes leftovers from earlier previews too.
        if main_file_name.starts_with(".devprism-") {
            let sweep_dir = work_dir.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(entries) = std::fs::read_dir(&sweep_dir) {
                    for entry in entries.flatten() {
                        if entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".devprism-")
                        {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            })
            .await;
        }
        Ok(pdf_bytes)
    } else {
        let log_content = read_log_bounded(&log_path);
        let details = extract_error_lines(&log_content);
        let msg = if details.is_empty() {
            match compile_result {
                Err(e) => e,
                Ok(_) => "Compilation failed: no PDF generated".to_string(),
            }
        } else {
            details
        };
        Err(CompileFail::new(&backend_label, msg))
    }
}

#[tauri::command]
pub async fn synctex_edit(
    state: tauri::State<'_, LatexCompilerState>,
    project_dir: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SynctexResult, String> {
    let builds = state.last_builds.lock().await;
    let build = builds
        .get(&project_dir)
        .ok_or("No build found for this project")?;

    let synctex_gz = build
        .work_dir
        .join(format!("{}.synctex.gz", build.main_file_name));
    let synctex_plain = build
        .work_dir
        .join(format!("{}.synctex", build.main_file_name));

    let work_dir = build.work_dir.clone();
    drop(builds); // Release lock before I/O

    // Read, decompress, and parse synctex data (blocking I/O + CPU work → offload)
    let (mut file, line, column) = tokio::task::spawn_blocking(move || {
        let synctex_data = if synctex_gz.exists() {
            let compressed = std::fs::read(&synctex_gz)
                .map_err(|e| format!("Failed to read synctex.gz: {}", e))?;
            let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
            let mut data = String::new();
            decoder
                .read_to_string(&mut data)
                .map_err(|e| format!("Failed to decompress synctex: {}", e))?;
            Ok::<_, String>(data)
        } else if synctex_plain.exists() {
            std::fs::read_to_string(&synctex_plain)
                .map_err(|e| format!("Failed to read synctex: {}", e))
        } else {
            Err("No synctex data found. Recompile with synctex enabled.".to_string())
        }?;

        parse_synctex_data(&synctex_data, page, x, y)
            .ok_or_else(|| "Could not resolve source location".to_string())
    })
    .await
    .map_err(|e| format!("Synctex task panicked: {}", e))??;

    // Normalize: strip work_dir prefix and "./" or ".\\" prefix
    let work_dir_str = work_dir.to_string_lossy().to_string();
    if let Some(rest) = file.strip_prefix(&format!("{}/", work_dir_str)) {
        file = rest.to_string();
    } else if let Some(rest) = file.strip_prefix(&format!("{}\\", work_dir_str)) {
        file = rest.to_string();
    }
    if let Some(rest) = file.strip_prefix("./") {
        file = rest.to_string();
    } else if let Some(rest) = file.strip_prefix(".\\") {
        file = rest.to_string();
    }

    Ok(SynctexResult { file, line, column })
}

#[tauri::command]
pub async fn synctex_forward(
    state: tauri::State<'_, LatexCompilerState>,
    project_dir: String,
    file: String,
    line: u32,
    column: u32,
) -> Result<SynctexForwardResult, String> {
    let _ = column;
    let builds = state.last_builds.lock().await;
    let build = builds
        .get(&project_dir)
        .ok_or("No build found for this project. Compile first.")?;

    let synctex_gz = build
        .work_dir
        .join(format!("{}.synctex.gz", build.main_file_name));
    let synctex_plain = build
        .work_dir
        .join(format!("{}.synctex", build.main_file_name));

    drop(builds);

    tokio::task::spawn_blocking(move || {
        let synctex_data = if synctex_gz.exists() {
            let compressed = std::fs::read(&synctex_gz)
                .map_err(|e| format!("Failed to read synctex.gz: {}", e))?;
            let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
            let mut data = String::new();
            decoder
                .read_to_string(&mut data)
                .map_err(|e| format!("Failed to decompress synctex: {}", e))?;
            Ok::<_, String>(data)
        } else if synctex_plain.exists() {
            std::fs::read_to_string(&synctex_plain)
                .map_err(|e| format!("Failed to read synctex: {}", e))
        } else {
            Err("No synctex data found. Recompile with synctex enabled.".to_string())
        }?;

        parse_synctex_forward(&synctex_data, &file, line)
            .ok_or_else(|| format!("Could not locate line {line} in the PDF"))
    })
    .await
    .map_err(|e| format!("Synctex forward task panicked: {}", e))?
}

/// Clear in-memory build state on app exit.
/// Persistent build directories are intentionally kept for fast restart.
pub async fn cleanup_all_builds(state: &LatexCompilerState) {
    let mut builds = state.last_builds.lock().await;
    builds.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `Compile` tool's `main_file` is model-supplied. Its caller validated
    /// the raw string, but `agent_compile_project` then rewrote `\` to `/`,
    /// manufacturing traversal the check had already approved.
    #[test]
    fn a_backslash_path_cannot_escape_the_project_after_normalization() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(root.path().join("main.tex"), "\\documentclass{article}")
            .expect("write main");

        // On Unix this is ONE Normal component pre-rewrite, so a lexical `..`
        // check on the raw string passes it. Post-rewrite it is real traversal.
        let escaping = "a\\..\\..\\..\\etc\\passwd.tex";
        assert!(
            validated_main_rel(root.path(), escaping).is_err(),
            "a backslash-encoded traversal must be refused"
        );

        for bad in ["../outside.tex", "/etc/passwd", "-shell-escape", "  "] {
            assert!(
                validated_main_rel(root.path(), bad).is_err(),
                "'{bad}' must be refused"
            );
        }

        // The ordinary case still works, and comes back project-relative.
        assert_eq!(
            validated_main_rel(root.path(), "main.tex").expect("valid"),
            "main.tex"
        );
    }

    /// A `-` prefix would reach the TeX engine's argv as a flag.
    #[test]
    fn a_flag_shaped_main_file_is_refused_before_reaching_the_engine() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(root.path().join("-shell-escape"), "x").expect("write");
        assert!(validated_main_rel(root.path(), "-shell-escape").is_err());
    }

    /// The log tail was byte-sliced at `len - 500` with no boundary check.
    #[test]
    fn the_log_tail_does_not_panic_on_a_multibyte_boundary() {
        // Sweep offsets so a multi-byte char lands across the 500-byte cut.
        for pad in 0..8usize {
            let log = format!("{}é{}", "x".repeat(pad), "y".repeat(600));
            let tail = extract_error_lines(&log);
            assert!(!tail.is_empty(), "pad {pad} produced an empty tail");
        }
        // And a log that is entirely multi-byte.
        let cjk = "日本語テキスト".repeat(200);
        let _ = extract_error_lines(&cjk);
    }

    // --- detect_bib_tool ---

    #[test]
    fn test_detect_bib_tool_biber() {
        let content =
            "\\documentclass{article}\n\\usepackage{biblatex}\n\\begin{document}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::Biber);
    }

    #[test]
    fn test_detect_bib_tool_biblatex_with_options() {
        let content = "\\documentclass{article}\n\\usepackage[style=apa,backend=biber]{biblatex}\n\\begin{document}";
        assert_eq!(detect_bib_tool(content), BibTool::Biber);
    }

    #[test]
    fn test_detect_bib_tool_bibtex() {
        let content = "\\documentclass{article}\n\\bibliography{refs}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::BibTeX);
    }

    #[test]
    fn test_detect_bib_tool_addbibresource() {
        let content = "\\documentclass{article}\n\\addbibresource{refs.bib}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::BibTeX);
    }

    #[test]
    fn test_detect_bib_tool_none() {
        let content = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::None);
    }

    #[test]
    fn test_detect_bib_tool_commented_out() {
        let content = "\\documentclass{article}\n% \\bibliography{refs}\n% \\usepackage{biblatex}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::None);
    }

    #[test]
    fn parse_structured_errors_extracts_line_and_message() {
        let log = "! Undefined control sequence.\nl.42 \\foo\n";
        let errs = parse_structured_latex_errors(log);
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].line, Some(42));
        assert!(errs[0].message.contains("Undefined control sequence"));
    }

    #[test]
    fn parse_structured_errors_extracts_file_reference() {
        let log = "! LaTeX Error: Something wrong.\n./chapters/intro.tex:15: error\nl.15 \\bad\n";
        let errs = parse_structured_latex_errors(log);
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].file.as_deref(), Some("chapters/intro.tex"));
        assert_eq!(errs[0].line, Some(15));
    }

    // --- parse_latex_line_number ---

    #[test]
    fn parse_latex_line_number_reads_value() {
        assert_eq!(parse_latex_line_number("l.42 \\foo"), Some(42));
        assert_eq!(parse_latex_line_number("  l.7"), Some(7));
    }

    #[test]
    fn parse_latex_line_number_rejects_invalid() {
        assert_eq!(parse_latex_line_number("l.0"), None); // line numbers are 1-based
        assert_eq!(parse_latex_line_number("l.abc"), None);
        assert_eq!(parse_latex_line_number("no prefix here"), None);
    }

    // --- parse_latex_file_line_ref ---

    #[test]
    fn parse_latex_file_line_ref_parses_tex_reference() {
        assert_eq!(
            parse_latex_file_line_ref("./chapters/intro.tex:15: error"),
            Some(("chapters/intro.tex".to_string(), 15))
        );
    }

    #[test]
    fn parse_latex_file_line_ref_normalizes_backslashes() {
        assert_eq!(
            parse_latex_file_line_ref("chapters\\intro.tex:3:"),
            Some(("chapters/intro.tex".to_string(), 3))
        );
    }

    #[test]
    fn parse_latex_file_line_ref_rejects_non_tex_or_zero_line() {
        assert_eq!(parse_latex_file_line_ref("notes.txt:10:"), None);
        assert_eq!(parse_latex_file_line_ref("intro.tex:0:"), None);
    }

    // --- has_real_errors ---

    #[test]
    fn has_real_errors_detects_bang_and_error_colon() {
        assert!(has_real_errors("! Undefined control sequence."));
        assert!(has_real_errors("LaTeX Error: Something broke"));
    }

    #[test]
    fn has_real_errors_ignores_lowercase_error_and_plain_text() {
        // has_real_errors only matches `!` lines or the exact "Error:" marker.
        assert!(!has_real_errors("error: lowercase is not matched"));
        assert!(!has_real_errors("everything compiled fine"));
        assert!(!has_real_errors(""));
    }

    // --- install_glyphtounicode_stub ---

    #[test]
    fn test_install_glyphtounicode_stub_writes_stub() {
        let work_dir = tempfile::tempdir().unwrap();
        let stub_path = work_dir.path().join("glyphtounicode.tex");
        assert!(!stub_path.exists());

        install_glyphtounicode_stub(work_dir.path());

        assert!(stub_path.exists(), "stub should be created");
        let contents = std::fs::read_to_string(&stub_path).unwrap();
        // It must neutralize the pdfTeX primitive without containing any
        // `\pdfglyphtounicode{..}{..}` invocations that XeTeX would choke on.
        assert!(contents.contains("\\pdfglyphtounicode"));
        assert!(contents.contains("\\endinput"));
    }

    #[test]
    fn test_install_glyphtounicode_stub_does_not_clobber_project_copy() {
        let work_dir = tempfile::tempdir().unwrap();
        let stub_path = work_dir.path().join("glyphtounicode.tex");
        std::fs::write(&stub_path, "USER PROVIDED").unwrap();

        install_glyphtounicode_stub(work_dir.path());

        assert_eq!(
            std::fs::read_to_string(&stub_path).unwrap(),
            "USER PROVIDED",
            "a project-provided glyphtounicode.tex must be left untouched"
        );
    }

    // --- install_xetex_compat_stub / prepend_xetex_compat_input ---

    #[test]
    fn test_install_xetex_compat_stub_writes_stub() {
        let work_dir = tempfile::tempdir().unwrap();
        let stub_path = work_dir.path().join("devprism-xetex-compat.tex");
        assert!(!stub_path.exists());

        install_xetex_compat_stub(work_dir.path());

        assert!(stub_path.exists(), "stub should be created");
        let contents = std::fs::read_to_string(&stub_path).unwrap();
        assert!(contents.contains("\\pdfgentounicode"));
        assert!(contents.contains("\\pdfinclusioncopyfonts"));
        assert!(contents.contains("\\pdfcompresslevel"));
        assert!(contents.contains("\\endinput"));
    }

    #[test]
    fn test_install_xetex_compat_stub_does_not_clobber_existing() {
        let work_dir = tempfile::tempdir().unwrap();
        let stub_path = work_dir.path().join("devprism-xetex-compat.tex");
        std::fs::write(&stub_path, "USER PROVIDED").unwrap();

        install_xetex_compat_stub(work_dir.path());

        assert_eq!(
            std::fs::read_to_string(&stub_path).unwrap(),
            "USER PROVIDED",
            "an existing devprism-xetex-compat.tex must be left untouched"
        );
    }

    #[test]
    fn test_prepend_xetex_compat_input_prepends_once() {
        let work_dir = tempfile::tempdir().unwrap();
        let main_path = work_dir.path().join("main.tex");
        std::fs::write(&main_path, "\\documentclass{article}\n").unwrap();

        prepend_xetex_compat_input(work_dir.path(), "main.tex");

        let first = std::fs::read_to_string(&main_path).unwrap();
        assert!(
            first.starts_with("\\input{devprism-xetex-compat}"),
            "compat input should be prepended"
        );
        assert!(first.contains("\\documentclass{article}"));

        prepend_xetex_compat_input(work_dir.path(), "main.tex");

        let second = std::fs::read_to_string(&main_path).unwrap();
        assert_eq!(
            second.matches("devprism-xetex-compat").count(),
            1,
            "compat input must not be prepended twice"
        );
    }

    /// The engine reports `l.N` and SyncTeX positions against the copy it read.
    /// If the shim took a line of its own, every reported line would be one past
    /// the user's real source, for the whole document.
    #[test]
    fn test_prepend_xetex_compat_input_preserves_line_numbering() {
        let cases = [
            "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n",
            "% !TEX program = pdflatex\n\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n",
            "\u{feff}\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n",
            // `%&format` directive: must stay at byte 0.
            "%&pdflatex\n\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n",
            // CRLF line endings.
            "\\documentclass{article}\r\n\\begin{document}\r\nx\r\n\\end{document}\r\n",
            // No trailing newline.
            "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}",
            "",
        ];
        // The structural guarantee the line numbering rests on.
        assert!(!XETEX_COMPAT_INPUT.contains('\n'));

        for original in cases {
            let work_dir = tempfile::tempdir().unwrap();
            let main_path = work_dir.path().join("main.tex");
            std::fs::write(&main_path, original).unwrap();

            prepend_xetex_compat_input(work_dir.path(), "main.tex");

            let modified = std::fs::read_to_string(&main_path).unwrap();
            if !original.is_empty() {
                assert_eq!(
                    modified.lines().count(),
                    original.lines().count(),
                    "injection changed the line count of {original:?}"
                );
            }
            // Every original line must keep its own line number. Exactly one
            // line gains the shim as a prefix; none may move.
            for (n, (before, after)) in original.lines().zip(modified.lines()).enumerate() {
                // The BOM legitimately moves ahead of the shim on line 1.
                let before = before.trim_start_matches('\u{feff}');
                let after = after.trim_start_matches('\u{feff}');
                assert!(
                    after.ends_with(before),
                    "line {} moved in {original:?}: {after:?} should end with {before:?}",
                    n + 1
                );
            }
            assert_eq!(strip_xetex_compat_input(&modified), original);
        }
    }

    /// `%&format` is only honoured as the first characters of the file.
    #[test]
    fn splice_keeps_format_directive_at_byte_zero() {
        let out = splice_xetex_compat_input("%&pdflatex\n\\documentclass{article}\n").unwrap();
        assert!(out.starts_with("%&pdflatex\n\\input{devprism-xetex-compat}\\documentclass"));
        // Still only one line for line 1 and one for line 2.
        assert_eq!(out.lines().count(), 2);

        // Degenerate: the directive is the whole file, so no line can shift.
        let out = splice_xetex_compat_input("%&pdflatex").unwrap();
        assert!(out.starts_with("%&pdflatex\n"));
    }

    #[test]
    fn splice_is_idempotent() {
        let once = splice_xetex_compat_input("\\documentclass{article}\n").unwrap();
        assert!(splice_xetex_compat_input(&once).is_none());
    }

    /// A BOM only suppresses a typeset character when it is at byte 0.
    #[test]
    fn test_prepend_xetex_compat_input_keeps_bom_first() {
        let work_dir = tempfile::tempdir().unwrap();
        let main_path = work_dir.path().join("main.tex");
        std::fs::write(&main_path, "\u{feff}\\documentclass{article}\n").unwrap();

        prepend_xetex_compat_input(work_dir.path(), "main.tex");

        let modified = std::fs::read_to_string(&main_path).unwrap();
        assert!(
            modified.starts_with("\u{feff}\\input{devprism-xetex-compat}\\documentclass"),
            "BOM must stay at byte 0, got {modified:?}"
        );
    }

    // --- engine resolution ---

    fn no_texlive(_: &str) -> bool {
        false
    }
    fn all_texlive(_: &str) -> bool {
        true
    }

    #[test]
    fn pdflatex_request_uses_texlive_when_available() {
        let r = resolve_backend(false, Some(TexEngine::Latex), "", &all_texlive);
        assert!(r.use_texlive);
        assert_eq!(r.actual, ActualEngine::Texlive(TexEngine::Latex));
        assert!(r.hard_error.is_none());
    }

    #[test]
    fn pdflatex_request_falls_back_to_tectonic_without_texlive() {
        let r = resolve_backend(false, Some(TexEngine::Latex), "", &no_texlive);
        assert!(!r.use_texlive);
        assert_eq!(r.actual, ActualEngine::TectonicXetex);
        assert!(
            r.hard_error.is_none(),
            "a pdfLaTeX document should still build under XeTeX, with a warning"
        );
    }

    #[test]
    fn lualatex_request_still_errors_without_texlive() {
        let r = resolve_backend(false, Some(TexEngine::LuaLaTeX), "", &no_texlive);
        assert!(r.hard_error.is_some());
    }

    #[test]
    fn lualatex_request_uses_texlive_when_available() {
        let r = resolve_backend(false, Some(TexEngine::LuaLaTeX), "", &all_texlive);
        assert!(r.use_texlive);
        assert!(r.hard_error.is_none());
    }

    #[test]
    fn texlive_backend_infers_pdflatex_for_plain_documents() {
        let r = resolve_backend(true, None, "\\documentclass{article}", &all_texlive);
        assert_eq!(
            r.actual,
            ActualEngine::Texlive(TexEngine::Latex),
            "an unmarked document should build with pdfLaTeX, like Overleaf"
        );
    }

    #[test]
    fn texlive_backend_infers_xelatex_when_fontspec_is_used() {
        let src = "\\documentclass{article}\n\\usepackage{fontspec}\n";
        let r = resolve_backend(true, None, src, &all_texlive);
        assert_eq!(r.actual, ActualEngine::Texlive(TexEngine::XeLaTeX));
    }

    #[test]
    fn magic_comment_beats_inference() {
        let src = "% !TEX program = xelatex\n\\documentclass{article}\n";
        let r = resolve_backend(true, Some(TexEngine::XeLaTeX), src, &all_texlive);
        assert_eq!(r.actual, ActualEngine::Texlive(TexEngine::XeLaTeX));
    }

    #[test]
    fn commented_out_fontspec_does_not_force_xelatex() {
        let src = "\\documentclass{article}\n% \\usepackage{fontspec}\n";
        let r = resolve_backend(true, None, src, &all_texlive);
        assert_eq!(r.actual, ActualEngine::Texlive(TexEngine::Latex));
    }

    // --- package scanning ---

    #[test]
    fn source_loads_package_handles_options_and_lists() {
        assert!(source_loads_package("\\usepackage{microtype}", "microtype"));
        assert!(source_loads_package(
            "\\usepackage[protrusion=true]{microtype}",
            "microtype"
        ));
        assert!(source_loads_package(
            "\\usepackage{geometry, microtype , xcolor}",
            "microtype"
        ));
        assert!(source_loads_package(
            "\\RequirePackage{microtype}",
            "microtype"
        ));
        assert!(!source_loads_package("% \\usepackage{microtype}", "microtype"));
        assert!(!source_loads_package("\\usepackage{microtypo}", "microtype"));
        assert!(!source_loads_package("", "microtype"));
    }

    #[test]
    fn strip_tex_comments_respects_escaped_percent() {
        assert_eq!(strip_tex_comments("50\\% off % a comment\n"), "50\\% off \n");
    }

    // --- fidelity notes ---

    #[test]
    fn microtype_under_xetex_is_reported() {
        let notes = collect_fidelity_notes(
            "\\usepackage{microtype}",
            "",
            ActualEngine::TectonicXetex,
            None,
        );
        assert!(notes.iter().any(|n| n.code == "microtype-expansion-unavailable"));
    }

    #[test]
    fn microtype_under_pdflatex_is_not_reported() {
        let notes = collect_fidelity_notes(
            "\\usepackage{microtype}",
            "",
            ActualEngine::Texlive(TexEngine::Latex),
            None,
        );
        assert!(notes.is_empty(), "got {notes:?}");
    }

    #[test]
    fn engine_substitution_is_reported() {
        let notes = collect_fidelity_notes(
            "",
            "",
            ActualEngine::TectonicXetex,
            Some(TexEngine::Latex),
        );
        assert!(notes.iter().any(|n| n.code == "engine-substituted"));
    }

    #[test]
    fn honoured_engine_request_is_not_reported() {
        let notes = collect_fidelity_notes(
            "",
            "",
            ActualEngine::Texlive(TexEngine::Latex),
            Some(TexEngine::Latex),
        );
        assert!(notes.is_empty(), "got {notes:?}");
    }

    #[test]
    fn font_substitution_is_reported() {
        let log = "LaTeX Font Warning: Font shape `T1/zi4/m/n' undefined\n";
        let notes = collect_fidelity_notes("", log, ActualEngine::Texlive(TexEngine::Latex), None);
        assert!(notes.iter().any(|n| n.code == "font-substituted"));
    }

    #[test]
    fn microtype_detected_from_log_when_source_is_indirect() {
        // The preamble lives in a `.sty`, so only the log knows microtype loaded.
        let log = "(microtype.sty ... (microtype-xetex.def)";
        let notes = collect_fidelity_notes("", log, ActualEngine::TectonicXetex, None);
        assert!(notes.iter().any(|n| n.code == "microtype-expansion-unavailable"));
    }

    // --- page count parsing ---

    #[test]
    fn parse_output_pages_reads_the_engine_line() {
        assert_eq!(
            parse_output_pages("Output written on main.xdv (3 pages, 15724 bytes)."),
            Some(3)
        );
        assert_eq!(
            parse_output_pages("Output written on main.pdf (1 page, 900 bytes)."),
            Some(1)
        );
        // The last run wins when a log holds several passes.
        assert_eq!(
            parse_output_pages(
                "Output written on main.xdv (4 pages, 1 bytes).\n\
                 Output written on main.xdv (3 pages, 1 bytes)."
            ),
            Some(3)
        );
        assert_eq!(parse_output_pages("No pages of output."), None);
        assert_eq!(parse_output_pages(""), None);
        assert_eq!(parse_output_pages("Output written on main.xdv (bytes)."), None);
    }

    // --- extract_error_lines ---

    #[test]
    fn test_extract_error_lines_empty_log() {
        assert_eq!(extract_error_lines(""), "");
    }

    #[test]
    fn test_extract_error_lines_no_pages() {
        let log = "Some preamble\nNo pages of output.\nSome trailing";
        let result = extract_error_lines(log);
        assert_eq!(
            result,
            "No pages of output. Add visible content to the document body."
        );
    }

    #[test]
    fn test_extract_error_lines_with_errors() {
        let log = "line 1\n! Undefined control sequence.\nline 3\n! Missing $ inserted.\nline 5";
        let result = extract_error_lines(log);
        assert!(result.contains("Undefined control sequence"));
        assert!(result.contains("Missing $ inserted"));
    }

    #[test]
    fn test_extract_error_lines_error_colon() {
        let log = "stuff\nLatex Error: Bad math environment\nmore stuff";
        let result = extract_error_lines(log);
        assert!(result.contains("Error:"));
    }

    #[test]
    fn test_extract_error_lines_no_errors_returns_tail() {
        let log = "a".repeat(1000);
        let result = extract_error_lines(&log);
        // Should return last 500 chars
        assert_eq!(result.len(), 500);
    }

    #[test]
    fn test_extract_error_lines_limits_to_10() {
        let mut log = String::new();
        for i in 0..20 {
            log.push_str(&format!("! Error number {}\n", i));
        }
        let result = extract_error_lines(&log);
        assert!(result.contains("---- Engine output ----"));
        let count = result.lines().count();
        assert!(count <= 120);
    }

    // --- persistent_build_dir ---

    #[test]
    fn test_persistent_build_dir() {
        let dir = persistent_build_dir("/Users/dev/my-project");
        assert_eq!(dir, PathBuf::from("/Users/dev/my-project/.prism/build"));
    }

    // --- parse_synctex_node ---

    #[test]
    fn test_parse_synctex_node_basic() {
        // Format: tag,line,column:h,v
        let node = parse_synctex_node("1,42,0:1000,2000", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let node = node.unwrap();
        assert_eq!(node.tag, 1);
        assert_eq!(node.line, 42);
        assert_eq!(node.h, 1000.0);
        assert_eq!(node.v, 2000.0);
    }

    #[test]
    fn test_parse_synctex_node_with_dimensions() {
        // Format: tag,line,column:h,v:W,H,D
        let node = parse_synctex_node("3,10,0:500,600:100,20,5", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let node = node.unwrap();
        assert_eq!(node.tag, 3);
        assert_eq!(node.line, 10);
    }

    #[test]
    fn test_parse_synctex_node_with_offset() {
        let node = parse_synctex_node("1,1,0:0,0", 1.0, 10.0, 20.0);
        let node = node.unwrap();
        assert_eq!(node.h, 10.0); // 0 * 1.0 + 10.0
        assert_eq!(node.v, 20.0); // 0 * 1.0 + 20.0
    }

    #[test]
    fn test_parse_synctex_node_invalid_missing_colon() {
        assert!(parse_synctex_node("1,1,0", 1.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn test_parse_synctex_node_invalid_missing_comma() {
        assert!(parse_synctex_node("1:100,200", 1.0, 0.0, 0.0).is_none());
    }

    // --- parse_synctex_data ---

    #[test]
    fn test_parse_synctex_forward_basic() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:1000,2000:500,100,0
}1
Postamble:
";
        let result = parse_synctex_forward(data, "main.tex", 5);
        assert!(result.is_some());
        let hit = result.unwrap();
        assert_eq!(hit.page, 1);
        assert!(hit.x > 0.0);
        assert!(hit.y > 0.0);
        assert!(hit.width >= 24.0);
    }

    #[test]
    fn test_parse_synctex_forward_closest_line() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,8,0:0,0
h1,12,0:100000000,100000000
}1
Postamble:
";
        let near12 = parse_synctex_forward(data, "./main.tex", 11).unwrap();
        let near8 = parse_synctex_forward(data, "./main.tex", 8).unwrap();
        assert!(near12.y > near8.y);
    }

    #[test]
    fn test_parse_synctex_data_basic() {
        let data = "\
SyncTeX Version:1
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:1000,2000:500,100,0
}1
Postamble:
";
        let result = parse_synctex_data(data, 1, 50.0, 50.0);
        assert!(result.is_some());
        let (file, line, _col) = result.unwrap();
        assert_eq!(file, "./main.tex");
        assert_eq!(line, 5);
    }

    #[test]
    fn test_parse_synctex_data_wrong_page() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:1000,2000
}1
Postamble:
";
        // Looking for page 2 but data only has page 1
        let result = parse_synctex_data(data, 2, 50.0, 50.0);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_synctex_data_closest_node() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,10,0:0,0
h1,20,0:100000000,100000000
}1
Postamble:
";
        // (0, 0) is closer to the first node
        let result = parse_synctex_data(data, 1, 0.0, 0.0);
        assert!(result.is_some());
        let (_, line, _) = result.unwrap();
        assert_eq!(line, 10);
    }

    #[test]
    fn test_parse_synctex_data_empty() {
        let result = parse_synctex_data("", 1, 0.0, 0.0);
        assert!(result.is_none());
    }

    // --- extract_error_lines additional edge cases ---

    #[test]
    fn test_extract_error_lines_mixed_error_formats() {
        let log = "preamble\n! LaTeX Error: File not found.\nl.42 \\input{missing}\nerror: compilation stopped";
        let result = extract_error_lines(log);
        assert!(result.contains("LaTeX Error"));
        assert!(result.contains("error: compilation stopped"));
    }

    #[test]
    fn test_extract_error_lines_short_log_no_errors() {
        let log = "This is a short log without errors";
        let result = extract_error_lines(log);
        // Short log (< 500 chars) returned as tail
        assert_eq!(result, log);
    }

    // --- parse_synctex_node additional edge cases ---

    #[test]
    fn test_parse_synctex_node_negative_coordinates() {
        let node = parse_synctex_node("1,1,0:-500,300", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let n = node.unwrap();
        assert_eq!(n.h, -500.0);
        assert_eq!(n.v, 300.0);
    }

    #[test]
    fn test_parse_synctex_node_factor_scaling() {
        // factor=2.0 should double the coordinates
        let node = parse_synctex_node("1,1,0:100,200", 2.0, 0.0, 0.0);
        let n = node.unwrap();
        assert_eq!(n.h, 200.0);
        assert_eq!(n.v, 400.0);
    }

    #[test]
    fn test_parse_synctex_node_zero_tag_and_line() {
        let node = parse_synctex_node("0,0,0:0,0", 1.0, 0.0, 0.0);
        let n = node.unwrap();
        assert_eq!(n.tag, 0);
        assert_eq!(n.line, 0);
    }

    // --- parse_synctex_data additional edge cases ---

    #[test]
    fn test_parse_synctex_data_multiple_inputs() {
        let data = "\
Input:1:./main.tex
Input:2:./chapter1.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h2,15,0:500,500
}1
Postamble:
";
        let result = parse_synctex_data(data, 1, 0.0, 0.0);
        assert!(result.is_some());
        let (file, line, _) = result.unwrap();
        assert_eq!(file, "./chapter1.tex");
        assert_eq!(line, 15);
    }

    #[test]
    fn test_parse_synctex_data_multiple_pages() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:100,100
}1
{2
h1,25,0:200,200
}2
Postamble:
";
        let result = parse_synctex_data(data, 2, 200.0, 200.0);
        assert!(result.is_some());
        let (_, line, _) = result.unwrap();
        assert_eq!(line, 25);
    }

    // --- extract_error_lines: real errors take priority over "No pages of output" ---

    #[test]
    fn test_extract_error_lines_real_errors_over_no_pages() {
        let log = "Some preamble\n! LaTeX Error: File `missing.sty' not found.\nNo pages of output.\nMore stuff";
        let result = extract_error_lines(log);
        assert!(
            result.contains("LaTeX Error"),
            "real error should be shown, got: {}",
            result
        );
        assert!(
            !result.contains("Add visible content"),
            "No pages fallback should NOT appear"
        );
    }

    // --- has_real_errors ---

    #[test]
    fn test_has_real_errors_with_bang() {
        assert!(has_real_errors("ok\n! Undefined control sequence.\nmore"));
    }

    #[test]
    fn test_has_real_errors_with_error_colon() {
        assert!(has_real_errors("LaTeX Error: Bad math\nstuff"));
    }

    #[test]
    fn test_has_real_errors_none() {
        assert!(!has_real_errors("This is pdfTeX\nNo pages of output.\n"));
    }

    // --- detect_tex_engine ---

    #[test]
    fn test_detect_tex_engine_xelatex() {
        let content = "% !TEX program = xelatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_pdflatex() {
        let content = "% !TEX program = pdflatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::Latex));
    }

    #[test]
    fn test_detect_tex_engine_lualatex() {
        let content = "% !TEX program = lualatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::LuaLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_none() {
        let content = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n";
        assert_eq!(detect_tex_engine(content), None);
    }

    #[test]
    fn test_detect_tex_engine_case_insensitive() {
        let content = "% !TEX program = XeLaTeX\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_no_spaces() {
        let content = "%!TEX program=xelatex\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    // --- persistent_build_dir edge case ---

    #[test]
    fn test_persistent_build_dir_trailing_slash() {
        let dir = persistent_build_dir("/project/");
        assert_eq!(dir, PathBuf::from("/project/.prism/build"));
    }

    // --- copy_dir_recursive integration tests ---

    #[test]
    fn test_copy_dir_recursive_nested() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        // Create nested structure
        std::fs::create_dir_all(src.path().join("sub").join("deep")).unwrap();
        std::fs::write(src.path().join("top.tex"), "top").unwrap();
        std::fs::write(src.path().join("sub").join("mid.tex"), "mid").unwrap();
        std::fs::write(
            src.path().join("sub").join("deep").join("bottom.tex"),
            "bottom",
        )
        .unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("top.tex")).unwrap(),
            "top"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("sub").join("mid.tex")).unwrap(),
            "mid"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("sub").join("deep").join("bottom.tex"))
                .unwrap(),
            "bottom"
        );
    }

    #[test]
    fn test_copy_dir_recursive_skips_hidden_dirs() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join(".git")).unwrap();
        std::fs::write(src.path().join(".git").join("config"), "secret").unwrap();
        std::fs::write(src.path().join("main.tex"), "doc").unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert!(!dst.path().join(".git").exists(), ".git should be skipped");
    }

    #[test]
    fn test_copy_dir_recursive_empty_subdir() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("empty_sub")).unwrap();
        std::fs::write(src.path().join("a.tex"), "a").unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("empty_sub").exists());
        assert!(dst.path().join("empty_sub").is_dir());
    }

    // --- sync_source_files integration tests ---

    #[test]
    fn test_sync_source_files_copies_sources() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("refs.bib"), "bib").unwrap();
        std::fs::write(src.path().join("style.sty"), "sty").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("main.tex")).unwrap(),
            "doc"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("refs.bib")).unwrap(),
            "bib"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("style.sty")).unwrap(),
            "sty"
        );
    }

    #[test]
    fn test_sync_source_files_skips_artifacts() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("main.aux"), "aux").unwrap();
        std::fs::write(src.path().join("main.log"), "log").unwrap();
        std::fs::write(src.path().join("main.synctex.gz"), "sync").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert!(!dst.path().join("main.aux").exists());
        assert!(!dst.path().join("main.log").exists());
        assert!(!dst.path().join("main.synctex.gz").exists());
    }

    #[test]
    fn test_sync_source_files_recursive_and_skips_hidden() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("chapters")).unwrap();
        std::fs::create_dir_all(src.path().join(".claudeprism")).unwrap();
        std::fs::write(src.path().join("chapters").join("ch1.tex"), "ch1").unwrap();
        std::fs::write(src.path().join("chapters").join("ch1.aux"), "aux").unwrap();
        std::fs::write(src.path().join(".claudeprism").join("data"), "data").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("chapters").join("ch1.tex")).unwrap(),
            "ch1"
        );
        assert!(!dst.path().join("chapters").join("ch1.aux").exists());
        assert!(!dst.path().join(".claudeprism").exists());
    }

    // --- sync_source_files copies figure PDFs ---

    #[test]
    fn test_sync_source_files_copies_figure_pdfs() {
        // .pdf files (e.g. figures) must be synced — they are NOT artifacts.
        // The output PDF is managed by compile_latex (explicit remove_file).
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("figures")).unwrap();
        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("figures").join("chart.pdf"), "pdf figure").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert_eq!(
            std::fs::read_to_string(dst.path().join("figures").join("chart.pdf")).unwrap(),
            "pdf figure"
        );
    }

    #[test]
    fn sync_removes_a_source_file_deleted_from_the_project() {
        // Without pruning, a chapter the user deleted keeps compiling from the
        // stale build-dir copy, so the preview shows a document that no longer
        // exists on disk.
        let src = tempfile::TempDir::new().unwrap();
        let dst = tempfile::TempDir::new().unwrap();
        std::fs::write(src.path().join("main.tex"), "\\input{ch1}").unwrap();
        std::fs::write(src.path().join("ch1.tex"), "one").unwrap();
        sync_source_files(src.path(), dst.path()).unwrap();
        assert!(dst.path().join("ch1.tex").exists());

        std::fs::remove_file(src.path().join("ch1.tex")).unwrap();
        sync_source_files(src.path(), dst.path()).unwrap();
        assert!(
            !dst.path().join("ch1.tex").exists(),
            "deleted source file must not survive in the build dir"
        );
        assert!(dst.path().join("main.tex").exists(), "kept file was removed");
    }

    #[test]
    fn sync_keeps_engine_generated_artifacts() {
        // Artifacts live only in the build dir and have no source counterpart;
        // pruning must not delete the output PDF or the SyncTeX map.
        let src = tempfile::TempDir::new().unwrap();
        let dst = tempfile::TempDir::new().unwrap();
        std::fs::write(src.path().join("main.tex"), "x").unwrap();
        sync_source_files(src.path(), dst.path()).unwrap();

        for artifact in ["main.aux", "main.log", "main.synctex.gz", "main.xdv"] {
            std::fs::write(dst.path().join(artifact), "generated").unwrap();
        }
        sync_source_files(src.path(), dst.path()).unwrap();
        for artifact in ["main.aux", "main.log", "main.synctex.gz", "main.xdv"] {
            assert!(
                dst.path().join(artifact).exists(),
                "{artifact} must survive the sync"
            );
        }
    }

    #[test]
    fn sync_removes_a_figure_pdf_deleted_from_the_project() {
        // `.pdf` is not treated as a generated artifact precisely so this
        // works; the engine's output PDF is removed by compile_latex anyway.
        let src = tempfile::TempDir::new().unwrap();
        let dst = tempfile::TempDir::new().unwrap();
        std::fs::write(src.path().join("main.tex"), "m").unwrap();
        std::fs::write(src.path().join("figure.pdf"), "fig").unwrap();
        sync_source_files(src.path(), dst.path()).unwrap();
        assert!(dst.path().join("figure.pdf").exists());

        std::fs::remove_file(src.path().join("figure.pdf")).unwrap();
        sync_source_files(src.path(), dst.path()).unwrap();
        assert!(
            !dst.path().join("figure.pdf").exists(),
            "deleted figure must not survive in the build dir"
        );
    }

    #[test]
    fn sync_removes_a_deleted_subdirectory() {
        let src = tempfile::TempDir::new().unwrap();
        let dst = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(src.path().join("parts")).unwrap();
        std::fs::write(src.path().join("parts/a.tex"), "a").unwrap();
        std::fs::write(src.path().join("main.tex"), "m").unwrap();
        sync_source_files(src.path(), dst.path()).unwrap();
        assert!(dst.path().join("parts/a.tex").exists());

        std::fs::remove_dir_all(src.path().join("parts")).unwrap();
        sync_source_files(src.path(), dst.path()).unwrap();
        assert!(
            !dst.path().join("parts").exists(),
            "deleted directory must not survive"
        );
    }

    #[test]
    fn sync_removes_a_stale_track_changes_preview_source() {
        // `previewTrackedChangesPdf` writes `.devprism-…tex` into the project,
        // compiles, then deletes it. The build-dir copy must go too, or every
        // preview leaves one behind for the rest of the session.
        let src = tempfile::TempDir::new().unwrap();
        let dst = tempfile::TempDir::new().unwrap();
        std::fs::write(src.path().join("main.tex"), "m").unwrap();
        let temp = ".devprism-track-changes-preview-123.tex";
        std::fs::write(src.path().join(temp), "diff").unwrap();
        sync_source_files(src.path(), dst.path()).unwrap();
        assert!(dst.path().join(temp).exists());

        std::fs::remove_file(src.path().join(temp)).unwrap();
        sync_source_files(src.path(), dst.path()).unwrap();
        assert!(
            !dst.path().join(temp).exists(),
            "throwaway preview source leaked into the build dir"
        );
    }

    #[test]
    fn test_sync_source_files_overwrites_changed_tex_content() {
        // Regression: when a user empties a file, sync must overwrite
        // the old content in the build dir with the empty content.
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        // Old content in build dir
        std::fs::write(dst.path().join("main.tex"), "old content").unwrap();
        // User emptied the file
        std::fs::write(src.path().join("main.tex"), "").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("main.tex")).unwrap(),
            ""
        );
    }

    // --- persistent_build_dir ---

    #[test]
    fn test_stale_pdf_removal_pattern() {
        // Simulates the pattern used in compile_latex: remove stale PDF
        // before compilation so a failed compile doesn't return old results.
        let build_dir = tempfile::tempdir().unwrap();
        let pdf_path = build_dir.path().join("document.pdf");

        // Simulate previous successful build left a PDF
        std::fs::write(&pdf_path, "old pdf data").unwrap();
        assert!(pdf_path.exists());

        // This is what compile_latex does before running tectonic
        let _ = std::fs::remove_file(&pdf_path);
        assert!(!pdf_path.exists());

        // If compilation fails, pdf_path.exists() is false → error returned
    }

    #[test]
    fn test_stale_pdf_removal_no_existing_file() {
        // remove_file on a non-existent path should not panic (we use let _ =)
        let build_dir = tempfile::tempdir().unwrap();
        let pdf_path = build_dir.path().join("document.pdf");

        assert!(!pdf_path.exists());
        let result = std::fs::remove_file(&pdf_path);
        // It's an error but we ignore it with let _ =
        assert!(result.is_err());
    }
}
