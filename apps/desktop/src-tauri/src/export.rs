use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Windows CREATE_NO_WINDOW flag to keep a console window from flashing when
/// spawning the pandoc child process from the GUI app.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn pandoc_command() -> Command {
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

    // Verify pandoc is installed up front so we can give a friendly message
    // instead of a raw spawn error.
    let available = pandoc_command()
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !available {
        return Err(
            "Pandoc is required to export to Word/HTML/Markdown but was not found. \
             Install it from https://pandoc.org/installing.html and restart DevPrism."
                .to_string(),
        );
    }

    let to = match format.as_str() {
        "docx" => "docx",
        "html" => "html",
        "markdown" => "markdown",
        other => return Err(format!("Unsupported export format: {}", other)),
    };

    let mut cmd = pandoc_command();
    cmd.current_dir(&work)
        .arg(&tex_path)
        .args(["-f", "latex"])
        .args(["-t", to])
        .arg("--standalone")
        .args(["-o", &output_path]);

    // When a bibliography is present, resolve \cite commands through citeproc.
    if let Some(bib) = bib_path.as_ref().filter(|b| !b.is_empty()) {
        cmd.arg("--citeproc").args(["--bibliography", bib]);
    }

    let output = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run pandoc: {}", e))?;

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
/// `tex_path` and `bib_path` are project-relative; pandoc runs with the project
/// root as its working directory so relative `\input`/`\includegraphics` paths
/// resolve. `output_path` is an absolute destination chosen by the user.
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
