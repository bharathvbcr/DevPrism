//! Empirical Challenger Stress Tests: Typst Bidirectional Sync Navigation Boundaries
//! and Multi-File #import / #include Source Span Resolution.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

use claude_prism_desktop_lib::career_typst::sync::{typst_sync_forward, typst_sync_inverse};

struct TestWorkspace {
    dir: TempDir,
}

impl TestWorkspace {
    fn new() -> Self {
        Self {
            dir: TempDir::new().unwrap(),
        }
    }

    fn write(&self, rel: &str, content: &str) -> PathBuf {
        let path = self.dir.path().join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, content).unwrap();
        path
    }

    fn root(&self) -> String {
        self.dir.path().to_string_lossy().to_string()
    }
}

const PRELUDE: &str = "#set page(paper: \"us-letter\", margin: 1in)\n";

// ============================================================================
// Objective 1: Sync Navigation Boundaries & Graceful Failure (No Panics)
// ============================================================================

#[tokio::test]
async fn test_sync_forward_boundary_line_zero() {
    let ws = TestWorkspace::new();
    ws.write("main.typ", &format!("{PRELUDE}= Header\nParagraph.\n"));

    let res = typst_sync_forward(ws.root(), "main.typ".into(), "main.typ".into(), 0, None)
        .await
        .expect("line 0 query must not panic or error");
    assert!(res.is_none(), "line 0 is invalid and must return None");
}

#[tokio::test]
async fn test_sync_forward_boundary_line_out_of_bounds() {
    let ws = TestWorkspace::new();
    ws.write("main.typ", &format!("{PRELUDE}= Header\nParagraph.\n"));

    // Beyond document lines
    let res = typst_sync_forward(ws.root(), "main.typ".into(), "main.typ".into(), 100, None)
        .await
        .expect("line out of bounds must not panic or error");
    assert!(res.is_none(), "line 100 must return None");

    // Extreme line u32::MAX
    let res_max = typst_sync_forward(
        ws.root(),
        "main.typ".into(),
        "main.typ".into(),
        u32::MAX,
        None,
    )
    .await
    .expect("u32::MAX line query must not panic");
    assert!(res_max.is_none(), "u32::MAX line must return None");
}

#[tokio::test]
async fn test_sync_forward_boundary_column_out_of_bounds() {
    let ws = TestWorkspace::new();
    ws.write(
        "main.typ",
        &format!("{PRELUDE}= Header\nParagraph text here.\n"),
    );

    // Valid line (line 2 = Header), but column 100000
    let res = typst_sync_forward(
        ws.root(),
        "main.typ".into(),
        "main.typ".into(),
        2,
        Some(100_000),
    )
    .await
    .expect("column 100_000 query must not panic");
    assert!(
        res.is_some(),
        "forward sync should still resolve the line's bounding box"
    );

    // Valid line, column u32::MAX
    let res_max = typst_sync_forward(
        ws.root(),
        "main.typ".into(),
        "main.typ".into(),
        2,
        Some(u32::MAX),
    )
    .await
    .expect("column u32::MAX query must not panic");
    assert!(
        res_max.is_some(),
        "column u32::MAX should resolve without integer overflow"
    );
}

#[tokio::test]
async fn test_sync_forward_nonexistent_or_malformed_file() {
    let ws = TestWorkspace::new();
    ws.write("main.typ", &format!("{PRELUDE}= Main\n"));

    // File that does not exist
    let res = typst_sync_forward(ws.root(), "main.typ".into(), "missing.typ".into(), 1, None)
        .await
        .expect("nonexistent file query must return Ok(None)");
    assert!(res.is_none(), "nonexistent file should return None");

    // Path traversal in file
    let res_traversal = typst_sync_forward(
        ws.root(),
        "main.typ".into(),
        "../../etc/passwd".into(),
        1,
        None,
    )
    .await;
    // Must either return Ok(None) or Err with clear error string, NEVER panic
    match res_traversal {
        Ok(opt) => assert!(opt.is_none()),
        Err(e) => assert!(
            e.contains("Invalid file path") || e.contains("outside") || e.contains("traversal")
        ),
    }
}

#[tokio::test]
async fn test_sync_inverse_boundary_page_zero() {
    let ws = TestWorkspace::new();
    ws.write("main.typ", &format!("{PRELUDE}= Heading\nText.\n"));

    let res = typst_sync_inverse(ws.root(), "main.typ".into(), 0, 100.0, 100.0)
        .await
        .expect("page 0 query must not panic");
    assert!(res.is_none(), "page 0 must return None");
}

#[tokio::test]
async fn test_sync_inverse_boundary_page_greater_than_total() {
    let ws = TestWorkspace::new();
    // 1-page document
    ws.write(
        "main.typ",
        &format!("{PRELUDE}= Heading\nSingle page text.\n"),
    );

    // Page 2 on a 1-page document
    let res_page2 = typst_sync_inverse(ws.root(), "main.typ".into(), 2, 100.0, 100.0)
        .await
        .expect("page 2 query on 1-page doc must not panic");
    assert!(res_page2.is_none(), "page 2 on 1-page doc must return None");

    // Page u32::MAX
    let res_max = typst_sync_inverse(ws.root(), "main.typ".into(), u32::MAX, 100.0, 100.0)
        .await
        .expect("page u32::MAX query must not panic");
    assert!(res_max.is_none(), "page u32::MAX must return None");
}

#[tokio::test]
async fn test_sync_inverse_boundary_clicks_outside_margins() {
    let ws = TestWorkspace::new();
    ws.write(
        "main.typ",
        &format!("{PRELUDE}= Document Title\nBody paragraph begins here.\n"),
    );

    // Top margin (x=10, y=10)
    let res_top = typst_sync_inverse(ws.root(), "main.typ".into(), 1, 10.0, 10.0)
        .await
        .expect("top margin click must not panic");
    assert!(res_top.is_none(), "top margin click must return None");

    // Extreme negative coordinates (x=-1000.0, y=-1000.0)
    let res_neg = typst_sync_inverse(ws.root(), "main.typ".into(), 1, -1000.0, -1000.0)
        .await
        .expect("negative coordinate click must not panic");
    assert!(
        res_neg.is_none(),
        "negative coordinate click must return None"
    );

    // Extreme positive coordinates (x=10000.0, y=10000.0)
    let res_pos = typst_sync_inverse(ws.root(), "main.typ".into(), 1, 10000.0, 10000.0)
        .await
        .expect("extreme positive coordinate click must not panic");
    assert!(
        res_pos.is_none(),
        "extreme positive coordinate click must return None"
    );

    // Infinity coordinates
    let res_inf = typst_sync_inverse(
        ws.root(),
        "main.typ".into(),
        1,
        f64::INFINITY,
        f64::INFINITY,
    )
    .await
    .expect("infinity coordinate click must not panic");
    assert!(res_inf.is_none(), "infinity click must return None");

    // NaN coordinates: must not panic
    let res_nan = typst_sync_inverse(ws.root(), "main.typ".into(), 1, f64::NAN, f64::NAN).await;
    assert!(res_nan.is_ok(), "NaN click must not panic");
}

// ============================================================================
// Objective 2: Multi-File #include and #import Span Resolution
// ============================================================================

#[tokio::test]
async fn test_sync_inverse_resolves_multi_file_include_path() {
    let ws = TestWorkspace::new();
    ws.write(
        "main.typ",
        &format!("{PRELUDE}= Main Root\n\n#include \"sections/body.typ\"\n"),
    );
    ws.write(
        "sections/body.typ",
        "= Section Body Title\nThis text is located exclusively inside sections/body.typ.\n",
    );

    // Let's do forward sync on sections/body.typ line 1 ("= Section Body Title")
    let fwd = typst_sync_forward(
        ws.root(),
        "main.typ".into(),
        "sections/body.typ".into(),
        1,
        Some(1),
    )
    .await
    .expect("forward sync on included file must not error")
    .expect("forward sync on sections/body.typ should find location");

    assert_eq!(fwd.page, 1);
    assert!(fwd.x > 0.0);
    assert!(fwd.y > 0.0);

    // Now do inverse sync clicking precisely at the resolved forward coordinates of sections/body.typ
    let inv = typst_sync_inverse(
        ws.root(),
        "main.typ".into(),
        fwd.page,
        fwd.x + 2.0,
        fwd.y + 2.0,
    )
    .await
    .expect("inverse sync must not error")
    .expect("clicking on included text should resolve to source line");

    // CRUCIAL VERIFICATION: The file must be "sections/body.typ", NOT "main.typ"!
    assert_eq!(
        inv.file, "sections/body.typ",
        "Inverse sync on text from #include must return 'sections/body.typ', but returned: '{}'",
        inv.file
    );
    assert_eq!(inv.line, 1, "Line must match line in sections/body.typ");
}

#[tokio::test]
async fn test_sync_inverse_resolves_multi_file_import_path() {
    let ws = TestWorkspace::new();
    ws.write(
        "main.typ",
        &format!(
            "{PRELUDE}#import \"sections/experience.typ\": exp_heading, exp_detail\n\n\
             = Main Resume\n\
             #exp_heading\n\
             #exp_detail\n"
        ),
    );
    ws.write(
        "sections/experience.typ",
        "#let exp_heading = [= Staff Infrastructure Architect]\n\
         #let exp_detail = [Spearheaded cross-region distributed database migration.]\n",
    );

    // Forward sync on sections/experience.typ line 2
    let fwd = typst_sync_forward(
        ws.root(),
        "main.typ".into(),
        "sections/experience.typ".into(),
        2,
        Some(1),
    )
    .await
    .expect("forward sync on imported file must not error")
    .expect("forward sync on sections/experience.typ line 2 should resolve");

    assert_eq!(fwd.page, 1);
    assert!(fwd.x > 0.0);
    assert!(fwd.y > 0.0);

    // Inverse sync on that location
    let inv = typst_sync_inverse(
        ws.root(),
        "main.typ".into(),
        fwd.page,
        fwd.x + 2.0,
        fwd.y + 2.0,
    )
    .await
    .expect("inverse sync must not error")
    .expect("inverse sync on imported variable content should resolve");

    // In Typst, AST spans inside content blocks `[Spearheaded ...]` track the definition file:
    assert_eq!(
        inv.file, "sections/experience.typ",
        "Inverse sync on imported content block must resolve to 'sections/experience.typ', got: '{}'",
        inv.file
    );
    assert_eq!(
        inv.line, 2,
        "Line must match line 2 of sections/experience.typ"
    );
}

#[tokio::test]
async fn test_sync_forward_with_subfolder_nested_relative_imports() {
    let ws = TestWorkspace::new();
    ws.write(
        "main.typ",
        &format!("{PRELUDE}#include \"modules/level1/level2.typ\"\n"),
    );
    ws.write(
        "modules/level1/level2.typ",
        "= Deeply Nested Component\nDeep body text line.\n",
    );

    let fwd = typst_sync_forward(
        ws.root(),
        "main.typ".into(),
        "modules/level1/level2.typ".into(),
        1,
        None,
    )
    .await
    .expect("forward sync should not error")
    .expect("forward sync on deeply nested module should resolve");

    assert_eq!(fwd.page, 1);
    assert!(fwd.x > 0.0);
    assert!(fwd.y > 0.0);

    let inv = typst_sync_inverse(
        ws.root(),
        "main.typ".into(),
        fwd.page,
        fwd.x + 5.0,
        fwd.y + 5.0,
    )
    .await
    .expect("inverse sync should not error")
    .expect("inverse sync should resolve");

    assert_eq!(inv.file, "modules/level1/level2.typ");
    assert_eq!(inv.line, 1);
}
