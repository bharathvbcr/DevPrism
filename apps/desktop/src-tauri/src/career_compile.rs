//! Temp-dir compile verifier for resume synthesis (plan §4.4).
//!
//! Kept separate from `career_db` so parallel foundation work does not conflict.

use crate::latex::{agent_compile_project, LatexCompileErrorItem};

/// Compile result for resume synthesis — same shape as `AgentCompileResult`
/// plus optional PDF bytes when the engine succeeded.
#[derive(Debug, serde::Serialize)]
pub struct CareerCompileResult {
    pub success: bool,
    pub main_file: String,
    pub errors: Vec<LatexCompileErrorItem>,
    pub summary: String,
    /// Present when compile succeeded and `resume.pdf` was readable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_bytes: Option<Vec<u8>>,
}

/// Compile arbitrary TeX source in an isolated tempfile project directory.
///
/// On success, returns PDF bytes from the engine output when available.
/// `engine`: `"texlive"` to force TeX Live; `"tectonic"` or `None` uses Tectonic.
#[tauri::command]
pub async fn career_verify_compile(
    tex_source: String,
    engine: Option<String>,
) -> Result<CareerCompileResult, String> {
    tokio::task::spawn_blocking(move || {
        career_verify_compile_blocking(&tex_source, engine.as_deref())
    })
    .await
    .map_err(|e| format!("career_verify_compile task failed: {e}"))?
}

fn career_verify_compile_blocking(
    tex_source: &str,
    engine: Option<&str>,
) -> Result<CareerCompileResult, String> {
    let dir =
        tempfile::TempDir::new().map_err(|e| format!("Failed to create temp compile dir: {e}"))?;
    let main_file = "resume.tex";
    let tex_path = dir.path().join(main_file);
    std::fs::write(&tex_path, tex_source)
        .map_err(|e| format!("Failed to write temp TeX source: {e}"))?;

    let use_texlive = matches!(engine, Some("texlive"));
    let result = agent_compile_project(dir.path(), main_file, use_texlive);

    // `agent_compile_project` writes into `<project>/.prism/build/`.
    let pdf_bytes = if result.success {
        let pdf_path = dir
            .path()
            .join(".prism")
            .join("build")
            .join("resume.pdf");
        match std::fs::read(&pdf_path) {
            Ok(bytes) if !bytes.is_empty() => Some(bytes),
            _ => None,
        }
    } else {
        None
    };

    Ok(CareerCompileResult {
        success: result.success,
        main_file: result.main_file,
        errors: result.errors,
        summary: result.summary,
        pdf_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_source_and_returns_structured_result() {
        // Minimal document — may fail if no engine is installed; we only assert
        // the helper returns a well-formed CareerCompileResult without panicking.
        let src = r"\documentclass{article}\begin{document}Hi\end{document}";
        let result = career_verify_compile_blocking(src, Some("tectonic"));
        assert!(result.is_ok());
        let r = result.expect("compile helper");
        assert_eq!(r.main_file, "resume.tex");
        // success / pdf_bytes depend on local TeX; either branch is fine
        let _ = r.success;
        let _ = r.pdf_bytes;
    }
}
