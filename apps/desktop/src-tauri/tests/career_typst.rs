//! Integration tests for the Typst engine & binary IPC core.
//!
//! Covers:
//! - In-memory overlay compilation (`ProjectWorld::with_overlay`)
//! - Binary document compilation (`compile_project_document`)
//! - Bidirectional sync forward (`typst_sync_forward`)
//! - Bidirectional sync inverse (`typst_sync_inverse`)

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

use claude_prism_desktop_lib::career_typst::project::{
    compile_project_document, normalize_overlay_path,
};
use claude_prism_desktop_lib::career_typst::sync::{typst_sync_forward, typst_sync_inverse};

struct TestFixture {
    dir: TempDir,
}

impl TestFixture {
    fn new() -> Self {
        Self {
            dir: TempDir::new().unwrap(),
        }
    }

    fn write(&self, rel: &str, content: &str) -> PathBuf {
        let path = self.dir.path().join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, content).unwrap();
        path
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }
}

const PAGE_HEADER: &str = "#set page(paper: \"us-letter\", margin: 1in)\n";

#[test]
fn normalize_overlay_path_handles_prefixes_and_rejects_traversal() {
    assert_eq!(
        normalize_overlay_path("main.typ").as_deref(),
        Some("main.typ")
    );
    assert_eq!(
        normalize_overlay_path("/main.typ").as_deref(),
        Some("main.typ")
    );
    assert_eq!(
        normalize_overlay_path("./main.typ").as_deref(),
        Some("main.typ")
    );
    assert_eq!(
        normalize_overlay_path("sections\\exp.typ").as_deref(),
        Some("sections/exp.typ")
    );
    assert_eq!(
        normalize_overlay_path("./sections/exp.typ").as_deref(),
        Some("sections/exp.typ")
    );
    assert_eq!(normalize_overlay_path("../outside.typ"), None);
    assert_eq!(normalize_overlay_path("foo/../../bar.typ"), None);
}

#[tokio::test]
async fn compile_document_with_overlay_compiles_without_disk_flush() {
    let f = TestFixture::new();
    // Do NOT write main.typ to disk!
    let mut overlay = HashMap::new();
    overlay.insert(
        "main.typ".to_string(),
        format!("{PAGE_HEADER}= In-Memory Only Document\nThis was never written to disk.\n"),
    );

    let pdf_bytes = compile_project_document(f.path(), "main.typ", Some(overlay))
        .expect("in-memory overlay compilation must succeed");

    assert!(pdf_bytes.starts_with(b"%PDF-"), "must be valid PDF");
    assert!(pdf_bytes.len() > 1000);
}

#[tokio::test]
async fn compile_document_with_multi_file_overlay_resolves_imports() {
    let f = TestFixture::new();
    let mut overlay = HashMap::new();
    overlay.insert(
        "main.typ".to_string(),
        format!(
            "{PAGE_HEADER}#import \"sections/summary.typ\": *\n= Main Document\n#summary_text\n"
        ),
    );
    overlay.insert(
        "sections/summary.typ".to_string(),
        "#let summary_text = [Unsaved live editor buffer summary]\n".to_string(),
    );

    let pdf_bytes = compile_project_document(f.path(), "main.typ", Some(overlay))
        .expect("multi-file overlay compilation must succeed");

    assert!(pdf_bytes.starts_with(b"%PDF-"));
}

#[tokio::test]
async fn compile_document_returns_structured_error_on_syntax_error() {
    let f = TestFixture::new();
    let mut overlay = HashMap::new();
    overlay.insert("main.typ".to_string(), "#let x = (\n".to_string());

    let err = compile_project_document(f.path(), "main.typ", Some(overlay))
        .expect_err("syntax error must fail compilation");

    assert!(!err.errors.is_empty(), "must report errors");
    let first = &err.errors[0];
    assert_eq!(first.severity, "error");
    assert_eq!(first.file.as_deref(), Some("main.typ"));
    assert_eq!(first.line, Some(1));
}

#[tokio::test]
async fn typst_sync_forward_resolves_source_line_to_pdf_rect() {
    let f = TestFixture::new();
    f.write(
        "main.typ",
        &format!(
            "{PAGE_HEADER}= First Heading\nLine 3 paragraph text here.\n\n= Second Heading\nLine 6 paragraph text here.\n"
        ),
    );

    let res = typst_sync_forward(
        f.path().to_string_lossy().to_string(),
        "main.typ".to_string(),
        "main.typ".to_string(),
        2, // "= First Heading"
        Some(1),
    )
    .await
    .expect("command should not error")
    .expect("line 2 should resolve to forward sync location");

    assert_eq!(res.page, 1);
    assert!(res.x > 0.0);
    assert!(res.y > 0.0);
    assert!(res.width >= 24.0);
    assert!(res.height >= 12.0);
}

#[tokio::test]
async fn typst_sync_forward_handles_out_of_bounds_gracefully() {
    let f = TestFixture::new();
    f.write("main.typ", "= Short\n");

    let res = typst_sync_forward(
        f.path().to_string_lossy().to_string(),
        "main.typ".to_string(),
        "main.typ".to_string(),
        99999,
        None,
    )
    .await
    .expect("command should not error");

    assert!(res.is_none(), "out-of-bounds line must return None");
}

#[tokio::test]
async fn typst_sync_inverse_resolves_click_to_source_line() {
    let f = TestFixture::new();
    f.write(
        "main.typ",
        &format!("{PAGE_HEADER}= Inverse Test Title\nClick target body line.\n"),
    );

    // Click near the top-left margin where text begins (around x=100, y=90)
    let res = typst_sync_inverse(
        f.path().to_string_lossy().to_string(),
        "main.typ".to_string(),
        1,
        100.0,
        90.0,
    )
    .await
    .expect("command should not error")
    .expect("click near text should resolve to source line");

    assert_eq!(res.file, "main.typ");
    assert!(res.line >= 1);
}

#[tokio::test]
async fn typst_sync_inverse_returns_none_on_page_margin_clicks() {
    let f = TestFixture::new();
    f.write("main.typ", &format!("{PAGE_HEADER}= Header\nText.\n"));

    // Click in top-left margin (x=10, y=10)
    let res = typst_sync_inverse(
        f.path().to_string_lossy().to_string(),
        "main.typ".to_string(),
        1,
        10.0,
        10.0,
    )
    .await
    .expect("command should not error");

    assert!(res.is_none(), "margin click should return None");
}
