use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};

const MAX_CONCURRENT: usize = 3;
const COMPILE_TIMEOUT_SECS: u64 = 30;

struct BuildInfo {
    work_dir: PathBuf,
    main_file_name: String, // stem without extension, e.g. "document"
}

#[derive(Clone)]
pub struct LatexCompilerState {
    last_builds: Arc<Mutex<HashMap<String, BuildInfo>>>,
    semaphore: Arc<Semaphore>,
}

impl Default for LatexCompilerState {
    fn default() -> Self {
        Self {
            last_builds: Arc::new(Mutex::new(HashMap::new())),
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT)),
        }
    }
}

#[derive(serde::Serialize)]
pub struct CompileResult {
    pub pdf_path: String,
}

#[derive(serde::Serialize)]
pub struct SynctexResult {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

// --- Helpers ---

struct CommandOutput {
    exit_code: i32,
    timed_out: bool,
    stdout: String,
    stderr: String,
}

/// Build an augmented PATH that includes common TeX installation directories.
/// macOS GUI apps don't inherit the user's shell PATH, so pdflatex etc. won't be found.
fn tex_path() -> String {
    let mut path = std::env::var("PATH").unwrap_or_default();
    let extras = [
        "/Library/TeX/texbin",
        "/usr/local/texlive/2024/bin/universal-darwin",
        "/usr/local/texlive/2023/bin/universal-darwin",
        "/usr/texbin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ];
    for extra in &extras {
        if Path::new(extra).exists() && !path.contains(extra) {
            path = format!("{}:{}", extra, path);
        }
    }
    path
}

async fn run_with_timeout(
    program: &str,
    args: &[&str],
    cwd: &Path,
    timeout_secs: u64,
) -> Result<CommandOutput, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("PATH", tex_path());

    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", program, e))?;

    match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => Ok(CommandOutput {
            exit_code: output.status.code().unwrap_or(-1),
            timed_out: false,
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        }),
        Ok(Err(e)) => Err(format!("Process error: {}", e)),
        Err(_) => Ok(CommandOutput {
            exit_code: -1,
            timed_out: true,
            stdout: String::new(),
            stderr: "Compilation timed out".to_string(),
        }),
    }
}

fn extract_error_lines(log: &str) -> String {
    if log.is_empty() {
        return String::new();
    }

    if log.lines().any(|l| l.contains("No pages of output")) {
        return "No pages of output. Add visible content to the document body.".to_string();
    }

    let error_lines: Vec<&str> = log
        .lines()
        .filter(|l| l.starts_with('!') || l.contains("Error:") || l.contains("error:"))
        .take(10)
        .collect();

    if error_lines.is_empty() {
        let start = log.len().saturating_sub(500);
        log[start..].to_string()
    } else {
        error_lines.join("\n")
    }
}

fn has_bib_files(dir: &Path) -> bool {
    fn check(dir: &Path) -> bool {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return false,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if check(&path) {
                    return true;
                }
            } else if path.extension().map(|e| e == "bib").unwrap_or(false) {
                return true;
            }
        }
        false
    }
    check(dir)
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

// --- Tauri Commands ---

#[tauri::command]
pub async fn compile_latex(
    state: tauri::State<'_, LatexCompilerState>,
    project_dir: String,
    main_file: String,
    compiler: Option<String>,
) -> Result<CompileResult, String> {
    // Acquire semaphore permit (non-blocking)
    let _permit = state
        .semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Server busy, too many concurrent compilations".to_string())?;

    let compiler_cmd = match compiler.as_deref() {
        Some("xelatex") => "xelatex",
        Some("lualatex") => "lualatex",
        _ => "pdflatex",
    };

    // Create temp build directory
    let raw_work_dir =
        std::env::temp_dir().join(format!("latex-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&raw_work_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    // Resolve symlinks (macOS: /var → /private/var) so synctex paths match
    let work_dir = std::fs::canonicalize(&raw_work_dir).unwrap_or(raw_work_dir);

    // Clean up previous build for this project
    {
        let mut builds = state.last_builds.lock().await;
        if let Some(prev) = builds.remove(&project_dir) {
            let _ = std::fs::remove_dir_all(&prev.work_dir);
        }
    }

    // Copy project to temp dir
    copy_dir_recursive(Path::new(&project_dir), &work_dir)
        .map_err(|e| format!("Failed to copy project: {}", e))?;

    let main_file_name = Path::new(&main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();

    // Detect .bib files
    let has_bib = has_bib_files(&work_dir);
    let latex_args: Vec<&str> = vec!["-interaction=nonstopmode", "-synctex=1", &main_file];
    let mut last_result;

    if has_bib {
        // Pass 1
        last_result =
            run_with_timeout(compiler_cmd, &latex_args, &work_dir, COMPILE_TIMEOUT_SECS).await?;
        if last_result.timed_out {
            return Err("Compilation timed out".to_string());
        }

        // BibTeX
        let aux_path = work_dir.join(format!("{}.aux", main_file_name));
        if aux_path.exists() {
            last_result = run_with_timeout(
                "bibtex",
                &[main_file_name.as_str()],
                &work_dir,
                COMPILE_TIMEOUT_SECS,
            )
            .await?;
            if last_result.timed_out {
                return Err("BibTeX timed out".to_string());
            }
        }

        // Pass 2 & 3
        for _ in 0..2 {
            last_result =
                run_with_timeout(compiler_cmd, &latex_args, &work_dir, COMPILE_TIMEOUT_SECS)
                    .await?;
            if last_result.timed_out {
                return Err("Compilation timed out".to_string());
            }
        }
    } else {
        // Two passes — beamer, hyperref, TOC, etc. need multiple passes
        // to resolve cross-references, navigation elements, and page numbers
        last_result =
            run_with_timeout(compiler_cmd, &latex_args, &work_dir, COMPILE_TIMEOUT_SECS).await?;
        if last_result.timed_out {
            return Err("Compilation timed out".to_string());
        }
        last_result =
            run_with_timeout(compiler_cmd, &latex_args, &work_dir, COMPILE_TIMEOUT_SECS).await?;
        if last_result.timed_out {
            return Err("Compilation timed out".to_string());
        }
    }

    // Read log file
    let log_path = work_dir.join(format!("{}.log", main_file_name));
    let log_content = std::fs::read_to_string(&log_path).unwrap_or_default();

    // Check for PDF; if "No pages of output", retry with \null injection
    let pdf_path = work_dir.join(format!("{}.pdf", main_file_name));
    if !pdf_path.exists() && log_content.contains("No pages of output") {
        let null_input = format!("\\AtEndDocument{{\\null}}\\input{{{}}}", main_file);
        let jobname_arg = format!("-jobname={}", main_file_name);
        let retry_args: Vec<&str> =
            vec!["-interaction=nonstopmode", &jobname_arg, &null_input];
        let _ = run_with_timeout(compiler_cmd, &retry_args, &work_dir, COMPILE_TIMEOUT_SECS).await;
    }

    // Store build info (even on failure, for debugging / synctex)
    let store_build = |builds: &mut HashMap<String, BuildInfo>| {
        builds.insert(
            project_dir.clone(),
            BuildInfo {
                work_dir: work_dir.clone(),
                main_file_name: main_file_name.clone(),
            },
        );
    };

    if pdf_path.exists() {
        let mut builds = state.last_builds.lock().await;
        store_build(&mut builds);
        Ok(CompileResult {
            pdf_path: pdf_path.to_string_lossy().to_string(),
        })
    } else {
        let mut builds = state.last_builds.lock().await;
        store_build(&mut builds);

        let details = extract_error_lines(&log_content);
        let fallback = if last_result.stderr.is_empty() {
            let s = &last_result.stdout;
            let start = s.len().saturating_sub(500);
            s[start..].to_string()
        } else {
            last_result.stderr
        };
        let msg = if details.is_empty() { fallback } else { details };
        Err(format!("Compilation failed\n\n{}", msg))
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

    // Verify synctex data exists
    let synctex_gz = build
        .work_dir
        .join(format!("{}.synctex.gz", build.main_file_name));
    let synctex_plain = build
        .work_dir
        .join(format!("{}.synctex", build.main_file_name));
    if !synctex_gz.exists() && !synctex_plain.exists() {
        return Err("No synctex data found. Recompile with synctex enabled.".to_string());
    }

    let pdf_file = format!("{}.pdf", build.main_file_name);
    let coord_arg = format!("{}:{}:{}:{}", page, x, y, pdf_file);
    let work_dir = build.work_dir.clone();
    drop(builds); // Release lock before spawning process

    let result = run_with_timeout("synctex", &["edit", "-o", &coord_arg], &work_dir, 10).await?;

    if result.exit_code != 0 {
        return Err(format!("synctex failed: {}", result.stderr));
    }

    // Parse synctex output
    let mut file = String::new();
    let mut line = 0u32;
    let mut column = 0u32;

    for l in result.stdout.lines() {
        let trimmed = l.trim();
        if let Some(rest) = trimmed.strip_prefix("Input:") {
            file = rest.to_string();
        } else if let Some(rest) = trimmed.strip_prefix("Line:") {
            line = rest.parse().unwrap_or(0);
        } else if let Some(rest) = trimmed.strip_prefix("Column:") {
            column = rest.parse::<i32>().unwrap_or(0).max(0) as u32;
        }
    }

    if file.is_empty() || line == 0 {
        return Err("Could not resolve source location".to_string());
    }

    // Normalize: strip work_dir prefix and "./" prefix
    let work_dir_str = work_dir.to_string_lossy().to_string();
    if let Some(rest) = file.strip_prefix(&format!("{}/", work_dir_str)) {
        file = rest.to_string();
    }
    if let Some(rest) = file.strip_prefix("./") {
        file = rest.to_string();
    }

    Ok(SynctexResult { file, line, column })
}

/// Clean up all remaining build directories on app exit.
pub async fn cleanup_all_builds(state: &LatexCompilerState) {
    let mut builds = state.last_builds.lock().await;
    for (_, build) in builds.drain() {
        let _ = std::fs::remove_dir_all(&build.work_dir);
    }
}
