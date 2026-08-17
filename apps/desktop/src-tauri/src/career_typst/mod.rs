//! Tauri surface for the in-process Typst resume engine.
//!
//! The compiler itself lives in [`engine`], which is deliberately free of any
//! Tauri or TeX dependency so it can be built and tested on its own.

pub mod engine;
pub mod project;

pub use engine::TypstCompileResult;

/// Compile Typst resume source to PDF bytes.
///
/// Links the compiler into the host process and touches no filesystem at all.
/// Warm compiles are sub-millisecond, which is what makes live preview viable.
/// This replaced a Tectonic subprocess that recompiled from a fresh temp
/// directory on every call.
#[tauri::command]
pub async fn career_typst_compile(source: String) -> Result<TypstCompileResult, String> {
    // Typst compilation is CPU-bound and synchronous; keep it off the async
    // runtime's worker threads.
    tokio::task::spawn_blocking(move || engine::compile_resume_pdf(&source))
        .await
        .map_err(|e| format!("career_typst_compile task failed: {e}"))
}

/// Compile a Typst document that lives in a workspace project directory.
///
/// Unlike `career_typst_compile` (hermetic, single in-memory source), this
/// resolves `#import` / `read()` against the project root — reads are confined
/// to that root. Use it for user-authored `.typ` files in the editor.
#[tauri::command]
pub async fn career_typst_compile_project(
    project_dir: String,
    main_file: String,
) -> Result<TypstCompileResult, String> {
    tokio::task::spawn_blocking(move || {
        project::compile_project_pdf(std::path::Path::new(&project_dir), &main_file)
    })
    .await
    .map_err(|e| format!("career_typst_compile_project task failed: {e}"))
}

/// Font families the Typst engine can resolve on this machine.
///
/// Exposed so the template picker can show which fonts are actually
/// selectable rather than offering families that would silently fall back.
#[tauri::command]
pub async fn career_typst_fonts() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(engine::available_font_families)
        .await
        .map_err(|e| format!("career_typst_fonts task failed: {e}"))
}
