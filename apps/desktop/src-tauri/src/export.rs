use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::proc::{run_with_timeout, succeeds_within};

/// Windows CREATE_NO_WINDOW flag to keep a console window from flashing when
/// spawning the pandoc child process from the GUI app.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Pandoc converts a whole document; allow generously but not forever.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(180);
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

fn pandoc_command() -> Command {
    #[allow(unused_mut)] // only needs to be mut on Windows, for creation_flags below
    let mut cmd = Command::new("pandoc");
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

/// Validate a caller-supplied, project-relative input path.
///
/// The frontend is the only caller today, but this command takes raw strings
/// over IPC and hands them to a subprocess, so it validates rather than trusts
/// — the same confinement `career_typst`'s `ProjectWorld` applies:
///
/// - rejects absolute paths and `..`, so a document outside the project cannot
///   be read and converted,
/// - rejects a leading `-`, which pandoc would parse as a flag rather than a
///   filename (argument injection),
/// - resolves symlinks and re-checks the prefix, so a link inside the project
///   cannot point outside it.
pub fn resolve_project_relative(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("Empty path.".to_string());
    }
    if rel.starts_with('-') {
        return Err(format!("Refusing path that looks like a flag: {rel}"));
    }

    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err(format!("Path must be inside the project: {rel}"));
    }
    for part in candidate.components() {
        match part {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("Path must not leave the project: {rel}"))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Path must be inside the project: {rel}"))
            }
        }
    }

    let root = root
        .canonicalize()
        .map_err(|e| format!("Project folder not found: {e}"))?;
    let joined = root.join(candidate);
    let real = joined
        .canonicalize()
        .map_err(|_| format!("File not found in project: {rel}"))?;
    if !real.starts_with(&root) {
        return Err(format!("Path must not leave the project: {rel}"));
    }
    Ok(real)
}

fn run_export(
    project_root: String,
    tex_path: String,
    format: String,
    output_path: String,
    bib_path: Option<String>,
) -> Result<(), String> {
    let work = PathBuf::from(&project_root);
    if !work.is_dir() {
        return Err("Project folder not found.".to_string());
    }

    // Validate inputs before touching pandoc so a bad path is a clear message.
    let tex_abs = resolve_project_relative(&work, &tex_path)?;
    let bib_abs = match bib_path.as_ref().filter(|b| !b.trim().is_empty()) {
        Some(bib) => Some(resolve_project_relative(&work, bib)?),
        None => None,
    };
    if output_path.trim().is_empty() || output_path.starts_with('-') {
        return Err(format!("Invalid output path: {output_path}"));
    }

    let to = match format.as_str() {
        "docx" => "docx",
        "html" => "html",
        "markdown" => "markdown",
        other => return Err(format!("Unsupported export format: {}", other)),
    };

    // Verify pandoc is installed up front so we can give a friendly message
    // instead of a raw spawn error.
    let mut probe = pandoc_command();
    probe.arg("--version");
    if !succeeds_within(probe, PROBE_TIMEOUT) {
        return Err(
            "Pandoc is required to export to Word/HTML/Markdown but was not found. \
             Install it from https://pandoc.org/installing.html and restart DevPrism."
                .to_string(),
        );
    }

    let mut cmd = pandoc_command();
    cmd.current_dir(&work)
        .args(["-f", "latex"])
        .args(["-t", to])
        .arg("--standalone")
        .args(["-o", &output_path]);

    // When a bibliography is present, resolve \cite commands through citeproc.
    if let Some(bib) = bib_abs.as_ref() {
        cmd.arg("--citeproc").arg("--bibliography").arg(bib);
    }

    // `--` ends option parsing: everything after it is a positional input,
    // even if a future path somehow begins with a dash.
    cmd.arg("--").arg(&tex_abs);

    let output =
        run_with_timeout(cmd, EXPORT_TIMEOUT).map_err(|e| e.to_message("Pandoc export"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "Pandoc export failed:\n{}",
            tail_lines(stderr.trim(), 15)
        ))
    }
}

/// Convert a LaTeX document to Word/HTML/Markdown via pandoc.
///
/// `tex_path` and `bib_path` are project-relative and are confined to
/// `project_root`; pandoc runs with the project root as its working directory
/// so relative `\input`/`\includegraphics` paths resolve. `output_path` is an
/// absolute destination chosen by the user.
#[tauri::command]
pub async fn export_document(
    project_root: String,
    tex_path: String,
    format: String,
    output_path: String,
    bib_path: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_export(project_root, tex_path, format, output_path, bib_path)
    })
    .await
    .map_err(|e| format!("Export task panicked: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().expect("tempdir");
        std::fs::write(dir.path().join("main.tex"), "x").expect("write");
        std::fs::create_dir_all(dir.path().join("sub")).expect("mkdir");
        std::fs::write(dir.path().join("sub/child.tex"), "y").expect("write");
        dir
    }

    #[test]
    fn accepts_a_file_inside_the_project() {
        let d = fixture();
        let got = resolve_project_relative(d.path(), "main.tex").expect("should resolve");
        assert!(got.ends_with("main.tex"));
        assert!(resolve_project_relative(d.path(), "sub/child.tex").is_ok());
        assert!(resolve_project_relative(d.path(), "./main.tex").is_ok());
    }

    #[test]
    fn rejects_parent_traversal() {
        let d = fixture();
        for bad in ["../outside.tex", "sub/../../outside.tex", ".."] {
            assert!(
                resolve_project_relative(d.path(), bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_absolute_paths() {
        let d = fixture();
        assert!(resolve_project_relative(d.path(), "/etc/passwd").is_err());
    }

    #[test]
    fn rejects_a_path_that_looks_like_a_flag() {
        // Would otherwise reach pandoc as an option rather than an input file.
        let d = fixture();
        let err = resolve_project_relative(d.path(), "--metadata=x").unwrap_err();
        assert!(err.contains("flag"), "{err}");
        assert!(resolve_project_relative(d.path(), "-o").is_err());
    }

    #[test]
    fn rejects_empty_and_missing_paths() {
        let d = fixture();
        assert!(resolve_project_relative(d.path(), "").is_err());
        assert!(resolve_project_relative(d.path(), "   ").is_err());
        assert!(resolve_project_relative(d.path(), "nope.tex").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_pointing_outside_the_project() {
        let d = fixture();
        let outside = d.path().parent().unwrap().join("prism-export-escape.tex");
        std::fs::write(&outside, "secret").expect("write outside");
        std::os::unix::fs::symlink(&outside, d.path().join("link.tex")).expect("symlink");

        let result = resolve_project_relative(d.path(), "link.tex");
        std::fs::remove_file(&outside).ok();
        assert!(result.is_err(), "symlink escape must be rejected");
    }

    #[test]
    fn rejects_unsupported_formats_before_running_anything() {
        let d = fixture();
        let err = run_export(
            d.path().to_string_lossy().into(),
            "main.tex".into(),
            "pdf".into(),
            "/tmp/out.pdf".into(),
            None,
        )
        .unwrap_err();
        assert!(err.contains("Unsupported export format"), "{err}");
    }

    #[test]
    fn rejects_a_traversing_tex_path_before_running_anything() {
        let d = fixture();
        let err = run_export(
            d.path().to_string_lossy().into(),
            "../escape.tex".into(),
            "docx".into(),
            "/tmp/out.docx".into(),
            None,
        )
        .unwrap_err();
        assert!(err.contains("must not leave the project"), "{err}");
    }

    #[test]
    fn rejects_a_traversing_bib_path() {
        let d = fixture();
        let err = run_export(
            d.path().to_string_lossy().into(),
            "main.tex".into(),
            "docx".into(),
            "/tmp/out.docx".into(),
            Some("../../refs.bib".into()),
        )
        .unwrap_err();
        assert!(err.contains("must not leave the project"), "{err}");
    }

    #[test]
    fn rejects_an_output_path_that_looks_like_a_flag() {
        let d = fixture();
        let err = run_export(
            d.path().to_string_lossy().into(),
            "main.tex".into(),
            "docx".into(),
            "--template=evil".into(),
            None,
        )
        .unwrap_err();
        assert!(err.contains("Invalid output path"), "{err}");
    }

    #[test]
    fn missing_project_folder_is_reported() {
        let err = run_export(
            "/definitely/not/here".into(),
            "main.tex".into(),
            "docx".into(),
            "/tmp/out.docx".into(),
            None,
        )
        .unwrap_err();
        assert!(err.contains("Project folder not found"), "{err}");
    }

    #[test]
    fn tail_lines_keeps_the_last_n() {
        assert_eq!(tail_lines("a\nb\nc\nd", 2), "c\nd");
        assert_eq!(tail_lines("only", 5), "only");
        assert_eq!(tail_lines("", 5), "");
    }
}
