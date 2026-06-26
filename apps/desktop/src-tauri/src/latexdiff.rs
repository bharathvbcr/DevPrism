use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Windows CREATE_NO_WINDOW flag to keep a console window from flashing when
/// spawning the latexdiff child process from the GUI app.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Resolve the latexdiff executable. Reuses the TeXLive resolver so a
/// GUI-launched macOS app (which inherits a minimal PATH without the TeX bin
/// dir) still finds latexdiff. Returns None when latexdiff isn't installed.
fn latexdiff_binary() -> Option<PathBuf> {
    crate::latex::find_texlive_binary("latexdiff").ok()
}

fn latexdiff_command(bin: &PathBuf) -> Command {
    let mut cmd = Command::new(bin);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Return the last `max` lines of `text`, so error toasts stay readable.
fn tail_lines(text: &str, max: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(max);
    lines[start..].join("\n")
}

fn detect_latexdiff_blocking() -> bool {
    let Some(bin) = latexdiff_binary() else {
        return false;
    };
    latexdiff_command(&bin)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Report whether the `latexdiff` tool is available. When false the frontend
/// falls back to its self-contained markup generator.
#[tauri::command]
pub async fn detect_latexdiff() -> Result<bool, String> {
    tokio::task::spawn_blocking(detect_latexdiff_blocking)
        .await
        .map_err(|e| format!("latexdiff detection panicked: {}", e))
}

fn run_latexdiff(old_content: String, new_content: String) -> Result<String, String> {
    let Some(bin) = latexdiff_binary() else {
        return Err("latexdiff not found".to_string());
    };

    // tempfile gives a unique random scratch dir (no nanosecond-collision race)
    // and RAII cleanup, so a panic can't leak the directory.
    let dir = tempfile::Builder::new()
        .prefix("devprism-latexdiff-")
        .tempdir()
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let old_path: PathBuf = dir.path().join("old.tex");
    let new_path: PathBuf = dir.path().join("new.tex");

    std::fs::write(&old_path, old_content)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;
    std::fs::write(&new_path, new_content)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    // Force UTF-8 end to end (inputs are UTF-8) so accented characters aren't
    // mangled by an auto-detected 8-bit encoding. Default markup: \DIFadd (blue,
    // underlined) / \DIFdel (red, struck); latexdiff emits its own preamble so
    // the result compiles as-is.
    let output = latexdiff_command(&bin)
        .arg("--encoding=utf8")
        .arg(&old_path)
        .arg(&new_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    // `dir` (TempDir) is dropped at end of scope, removing the scratch files.
    match output {
        Ok(out) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(format!("latexdiff failed:\n{}", tail_lines(stderr.trim(), 15)))
        }
        Err(e) => Err(format!("Failed to run latexdiff: {}", e)),
    }
}

/// Generate high-fidelity track-changes LaTeX by running the system `latexdiff`
/// over the old and new full document sources. Returns the marked-up .tex
/// (already standalone, with latexdiff's own preamble). Errors if latexdiff is
/// not installed — callers fall back to the self-contained generator.
#[tauri::command]
pub async fn latexdiff_generate(
    old_content: String,
    new_content: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_latexdiff(old_content, new_content))
        .await
        .map_err(|e| format!("latexdiff task panicked: {}", e))?
}
