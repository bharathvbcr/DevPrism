use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};

const MAX_CONCURRENT: usize = 3;

struct BuildInfo {
    work_dir: PathBuf,
    main_file_name: String,
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

/// Sync only source files (.tex, .bib, .sty, .cls, .bst, images) from project to build dir.
/// Skips build artifacts (.aux, .log, .toc, .pdf, .synctex.gz, etc.) to preserve them.
fn sync_source_files(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            sync_source_files(&src_path, &dst_path)?;
        } else {
            let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let is_artifact = matches!(ext, "aux" | "log" | "toc" | "lof" | "lot" | "out"
                | "nav" | "snm" | "vrb" | "bbl" | "blg" | "fls" | "fdb_latexmk"
                | "synctex" | "pdf" | "idx" | "ind" | "ilg" | "glo" | "gls" | "glg"
                | "fmt" | "xdv");
            let is_synctex = src_path.to_string_lossy().ends_with(".synctex.gz");
            if !is_artifact && !is_synctex {
                std::fs::copy(&src_path, &dst_path)?;
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

// --- Tectonic Compilation ---

fn compile_with_tectonic(work_dir: &Path, main_file: &str) -> Result<(), String> {
    use tectonic::config::PersistentConfig;
    use tectonic::driver::{OutputFormat, PassSetting, ProcessingSessionBuilder};
    use tectonic::status::NoopStatusBackend;

    let mut status = NoopStatusBackend {};

    let config = PersistentConfig::open(false)
        .map_err(|e| format!("Failed to open tectonic config: {}", e))?;

    let bundle = config
        .default_bundle(false, &mut status)
        .map_err(|e| format!("Failed to load tectonic bundle (check network connection): {}", e))?;

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

    session
        .run(&mut status)
        .map_err(|e| format!("{}", e))?;

    Ok(())
}

// --- SyncTeX Native Parser ---

struct SynctexNode {
    tag: u32,
    line: u32,
    h: f64, // PDF points
    v: f64, // PDF points
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

        let first_byte = line.as_bytes()[0];
        match first_byte {
            b'{' => {
                let page: u32 = line[1..].parse().unwrap_or(0);
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
                if let Some(node) = parse_synctex_node(&line[1..], factor, x_offset, y_offset) {
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

    let best = &nodes[best_idx];
    let filename = inputs.get(&best.tag)?.clone();
    Some((filename, best.line, 0))
}

/// Parse a synctex node record (after stripping the type character).
/// Format: `<tag>,<line>,<column>:<h>,<v>[:<W>,<H>,<D>]`
fn parse_synctex_node(
    s: &str,
    factor: f64,
    x_offset: f64,
    y_offset: f64,
) -> Option<SynctexNode> {
    let colon_parts: Vec<&str> = s.splitn(4, ':').collect();
    if colon_parts.len() < 2 {
        return None;
    }

    // Parse tag and line (ignore column)
    let tlc: Vec<&str> = colon_parts[0].splitn(3, ',').collect();
    if tlc.len() < 2 {
        return None;
    }
    let tag: u32 = tlc[0].parse().ok()?;
    let line: u32 = tlc[1].parse().ok()?;

    // Parse h, v coordinates
    let hv: Vec<&str> = colon_parts[1].splitn(2, ',').collect();
    if hv.len() < 2 {
        return None;
    }
    let h_raw: i64 = hv[0].parse().ok()?;
    let v_raw: i64 = hv[1].parse().ok()?;

    let h = h_raw as f64 * factor + x_offset;
    let v = v_raw as f64 * factor + y_offset;

    Some(SynctexNode { tag, line, h, v })
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn compile_latex(
    state: tauri::State<'_, LatexCompilerState>,
    project_dir: String,
    main_file: String,
) -> Result<tauri::ipc::Response, String> {
    // Acquire semaphore permit (non-blocking)
    let _permit = state
        .semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Server busy, too many concurrent compilations".to_string())?;

    // Acquire per-project lock to prevent concurrent compilations on the same build dir.
    let project_lock = {
        let mut locks = state.project_locks.lock().await;
        locks
            .entry(project_dir.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _project_guard = project_lock.lock().await;

    let t0 = std::time::Instant::now();

    let main_file_name = Path::new(&main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();

    // Set up build directory
    let work_dir = persistent_build_dir(&project_dir);
    let is_reuse = work_dir.exists();

    if is_reuse {
        sync_source_files(Path::new(&project_dir), &work_dir)
            .map_err(|e| format!("Failed to sync project: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms sync source files (reuse)",
            t0.elapsed().as_millis()
        );
    } else {
        std::fs::create_dir_all(&work_dir)
            .map_err(|e| format!("Failed to create build dir: {}", e))?;
        copy_dir_recursive(Path::new(&project_dir), &work_dir)
            .map_err(|e| format!("Failed to copy project: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms full copy (first build)",
            t0.elapsed().as_millis()
        );
    }

    // Run Tectonic in a blocking task (it uses an internal global mutex)
    let work_dir_clone = work_dir.clone();
    let main_file_clone = main_file.clone();
    let compile_result = tokio::task::spawn_blocking(move || {
        compile_with_tectonic(&work_dir_clone, &main_file_clone)
    })
    .await
    .map_err(|e| format!("Compilation task panicked: {}", e))?;

    eprintln!(
        "[latex] +{:.0}ms tectonic done (ok={})",
        t0.elapsed().as_millis(),
        compile_result.is_ok()
    );

    let pdf_path = work_dir.join(format!("{}.pdf", main_file_name));
    let log_path = work_dir.join(format!("{}.log", main_file_name));

    // Handle "No pages of output" — retry with \AtEndDocument{\null} injection
    if !pdf_path.exists() {
        let log_content = std::fs::read_to_string(&log_path).unwrap_or_default();
        if log_content.contains("No pages of output") {
            eprintln!("[latex] no pages of output — retrying with \\null injection");
            let main_tex = work_dir.join(&main_file);
            if let Ok(content) = std::fs::read_to_string(&main_tex) {
                if let Some(pos) = content.find("\\begin{document}") {
                    let modified = format!(
                        "{}\\AtEndDocument{{\\null}}{}",
                        &content[..pos],
                        &content[pos..]
                    );
                    let _ = std::fs::write(&main_tex, &modified);
                    let work_dir_clone = work_dir.clone();
                    let main_file_clone = main_file.clone();
                    let retry_result = tokio::task::spawn_blocking(move || {
                        compile_with_tectonic(&work_dir_clone, &main_file_clone)
                    })
                    .await
                    .map_err(|e| format!("Retry task panicked: {}", e))?;
                    eprintln!(
                        "[latex] empty-body retry: ok={} pdf_exists={}",
                        retry_result.is_ok(),
                        pdf_path.exists()
                    );
                }
            }
        }
    }

    // Store build info
    {
        let mut builds = state.last_builds.lock().await;
        builds.insert(
            project_dir.clone(),
            BuildInfo {
                work_dir: work_dir.clone(),
                main_file_name: main_file_name.clone(),
            },
        );
    }

    if pdf_path.exists() {
        let pdf_bytes =
            std::fs::read(&pdf_path).map_err(|e| format!("Failed to read PDF: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms total (reuse={})",
            t0.elapsed().as_millis(),
            is_reuse
        );
        Ok(tauri::ipc::Response::new(pdf_bytes))
    } else {
        let log_content = std::fs::read_to_string(&log_path).unwrap_or_default();
        let details = extract_error_lines(&log_content);
        let msg = if details.is_empty() {
            match compile_result {
                Err(e) => e,
                Ok(_) => "Compilation failed: no PDF generated".to_string(),
            }
        } else {
            details
        };
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

    let synctex_gz = build
        .work_dir
        .join(format!("{}.synctex.gz", build.main_file_name));
    let synctex_plain = build
        .work_dir
        .join(format!("{}.synctex", build.main_file_name));

    let work_dir = build.work_dir.clone();
    drop(builds); // Release lock before I/O

    // Read and decompress synctex data
    let synctex_data = if synctex_gz.exists() {
        let compressed =
            std::fs::read(&synctex_gz).map_err(|e| format!("Failed to read synctex.gz: {}", e))?;
        let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
        let mut data = String::new();
        decoder
            .read_to_string(&mut data)
            .map_err(|e| format!("Failed to decompress synctex: {}", e))?;
        data
    } else if synctex_plain.exists() {
        std::fs::read_to_string(&synctex_plain)
            .map_err(|e| format!("Failed to read synctex: {}", e))?
    } else {
        return Err("No synctex data found. Recompile with synctex enabled.".to_string());
    };

    let (mut file, line, column) = parse_synctex_data(&synctex_data, page, x, y)
        .ok_or("Could not resolve source location")?;

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

/// Clear in-memory build state on app exit.
/// Persistent build directories are intentionally kept for fast restart.
pub async fn cleanup_all_builds(state: &LatexCompilerState) {
    let mut builds = state.last_builds.lock().await;
    builds.clear();
}
