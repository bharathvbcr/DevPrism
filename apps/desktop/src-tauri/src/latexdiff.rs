use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use crate::proc::{run_with_timeout, succeeds_within};

/// latexdiff is a Perl script over two files; it should never take long, but an
/// unbounded wait would hold a blocking-pool thread for the session.
const LATEXDIFF_TIMEOUT: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

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
    #[allow(unused_mut)] // only needs to be mut on Windows, for creation_flags below
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
    let mut cmd = latexdiff_command(&bin);
    cmd.arg("--version");
    succeeds_within(cmd, PROBE_TIMEOUT)
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
    let mut cmd = latexdiff_command(&bin);
    cmd.arg("--encoding=utf8").arg(&old_path).arg(&new_path);
    let output = run_with_timeout(cmd, LATEXDIFF_TIMEOUT);

    // `dir` (TempDir) is dropped at end of scope, removing the scratch files.
    match output {
        Ok(out) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(format!("latexdiff failed:\n{}", tail_lines(stderr.trim(), 15)))
        }
        Err(e) => Err(e.to_message("latexdiff")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_lines_keeps_the_last_n() {
        assert_eq!(tail_lines("a\nb\nc\nd", 2), "c\nd");
        assert_eq!(tail_lines("only", 5), "only");
        assert_eq!(tail_lines("", 5), "");
        // Fewer lines than requested must not panic on the slice.
        assert_eq!(tail_lines("a\nb", 100), "a\nb");
    }

    #[test]
    fn detection_is_bounded_and_never_panics() {
        // Whether latexdiff exists here is irrelevant; this must return either
        // way, promptly, rather than hanging or unwrapping a missing binary.
        let started = std::time::Instant::now();
        let _ = detect_latexdiff_blocking();
        assert!(started.elapsed() < Duration::from_secs(30));
    }

    #[test]
    fn missing_latexdiff_is_an_error_not_a_panic() {
        // When the binary is absent the command must fail cleanly so the
        // frontend can fall back to its self-contained markup generator.
        if latexdiff_binary().is_none() {
            let err = run_latexdiff("a".into(), "b".into()).unwrap_err();
            assert!(err.contains("latexdiff not found"), "{err}");
        }
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
