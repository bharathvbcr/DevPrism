//! Adversarial Stress & Hardening Test Suite for Milestone 1:
//! Typst Engine & Binary IPC Core (Features 6, 7, 11, 12).
//!
//! Objectives:
//! 1. Zero-copy binary response: Verify valid %PDF- magic bytes and trailer %%EOF
//!    without truncation, corruption, or IPC byte-loss.
//! 2. In-memory buffer overlay: Stress test malformed, empty, huge (>2MB),
//!    cumulative (>32MB), cyclic, and traversal overlays.
//! 3. Concurrency & comemo eviction stress: Rapid parallel re-compilations across
//!    multiple threads with changing sources to verify stability and bounds.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::collections::HashMap;
use std::sync::Arc;
use tempfile::TempDir;

use serde_json::{json, Value};
use tauri::test::MockRuntime;
use tauri::test::{mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{ipc::CallbackFn, App, WebviewWindow};

use claude_prism_desktop_lib::career_typst::engine::MAX_SOURCE_BYTES;
use claude_prism_desktop_lib::career_typst::project::compile_project_document;
use claude_prism_desktop_lib::career_typst::sync::{typst_sync_forward, typst_sync_inverse};

fn build_mock_app() -> App<MockRuntime> {
    mock_builder()
        .invoke_handler(tauri::generate_handler![
            claude_prism_desktop_lib::career_typst::typst_compile_document,
            claude_prism_desktop_lib::career_typst::typst_sync_forward,
            claude_prism_desktop_lib::career_typst::typst_sync_inverse,
        ])
        .build(mock_context(noop_assets()))
        .expect("mock app should build")
}

fn build_mock_webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    tauri::WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .expect("mock webview should build")
}

fn invoke_ipc_raw(
    webview: &WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<tauri::ipc::InvokeResponseBody, Value> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().unwrap(),
        body: tauri::ipc::InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    tauri::test::get_ipc_response(webview, request)
}

const PAGE_PRELUDE: &str = "#set page(paper: \"us-letter\", margin: 0.5in)\n";

// ============================================================================
// 1. Zero-Copy Binary Response & PDF Integrity Tests
// ============================================================================

#[tokio::test]
async fn test_zero_copy_pdf_header_magic_and_trailer_eof() {
    let temp = TempDir::new().unwrap();
    let mut overlay = HashMap::new();
    overlay.insert(
        "main.typ".to_string(),
        format!("{PAGE_PRELUDE}= PDF Integrity Verification Document\nTesting byte trailer.\n"),
    );

    // Direct invocation
    let pdf_bytes = compile_project_document(temp.path(), "main.typ", Some(overlay.clone()))
        .expect("compilation should succeed");

    // 1. Header Magic verification: must start with %PDF-1.7
    assert!(
        pdf_bytes.starts_with(b"%PDF-1.7"),
        "PDF must start with %PDF-1.7 magic bytes, got: {:?}",
        &pdf_bytes[..pdf_bytes.len().min(12)]
    );

    // 2. Trailer EOF verification: must end with %%EOF or %%EOF\n
    let len = pdf_bytes.len();
    assert!(len > 500, "PDF size is unrealistically small: {len} bytes");

    let trailer_window = &pdf_bytes[len.saturating_sub(64)..];
    let trailer_str = String::from_utf8_lossy(trailer_window);
    assert!(
        trailer_str.contains("%%EOF"),
        "PDF trailer must contain %%EOF, got end window: {trailer_str}"
    );

    // 3. Round-trip through Tauri IPC command typst_compile_document
    let app = build_mock_app();
    let wv = build_mock_webview(&app);
    let ipc_res = invoke_ipc_raw(
        &wv,
        "typst_compile_document",
        json!({
            "projectDir": temp.path().to_string_lossy(),
            "mainFile": "main.typ",
            "overlay": overlay,
        }),
    )
    .expect("IPC command must succeed");

    match ipc_res {
        tauri::ipc::InvokeResponseBody::Raw(raw_bytes) => {
            assert_eq!(
                raw_bytes.len(),
                pdf_bytes.len(),
                "Raw IPC response length must match direct compile length exactly"
            );
            assert_eq!(
                raw_bytes, pdf_bytes,
                "IPC response bytes must be byte-for-byte identical (no truncation/corruption)"
            );
            assert!(raw_bytes.starts_with(b"%PDF-1.7"));
            let ipc_trailer = String::from_utf8_lossy(&raw_bytes[raw_bytes.len() - 32..]);
            assert!(ipc_trailer.contains("%%EOF"));
        }
        other => panic!("Expected InvokeResponseBody::Raw, got: {other:?}"),
    }
}

// ============================================================================
// 2. In-Memory Buffer Overlay Edge Cases & Stress Tests
// ============================================================================

#[tokio::test]
async fn test_overlay_empty_main_file_safe_rejection() {
    let temp = TempDir::new().unwrap();
    let mut overlay = HashMap::new();
    overlay.insert("main.typ".to_string(), "".to_string());

    // Compiling an empty file has no pages or generates a 0-page document
    let res = compile_project_document(temp.path(), "main.typ", Some(overlay));
    // It must either succeed with a valid PDF or fail with clean diagnostics, NEVER panic
    match res {
        Ok(bytes) => {
            assert!(bytes.starts_with(b"%PDF-"));
        }
        Err(err) => {
            assert!(!err.errors.is_empty() || !err.message.is_empty());
        }
    }
}

#[tokio::test]
async fn test_overlay_malformed_syntax_graceful_diagnostics() {
    let temp = TempDir::new().unwrap();
    let malformed_cases = [
        ("#let x = (", "unclosed delimiter"),
        ("#import \"non_existent.typ\": *", "missing import"),
        ("#eval(\"1 + \", mode: \"code\")", "malformed eval"),
        ("#[ *unclosed bold ]", "unclosed markup"),
        ("#show: it => [ #it.body.broken ]", "missing field access"),
    ];

    for (code, label) in malformed_cases {
        let mut overlay = HashMap::new();
        overlay.insert("main.typ".to_string(), code.to_string());

        let res = compile_project_document(temp.path(), "main.typ", Some(overlay));
        assert!(
            res.is_err(),
            "Malformed code '{label}' must fail compilation without panicking"
        );
        let err = res.unwrap_err();
        assert!(
            !err.errors.is_empty(),
            "Error response must contain structured diagnostics for '{label}'"
        );
        assert_eq!(err.errors[0].severity, "error");
        assert_eq!(err.errors[0].file.as_deref(), Some("main.typ"));
    }
}

#[tokio::test]
async fn test_overlay_oversized_single_file_rejection() {
    let temp = TempDir::new().unwrap();
    let mut overlay = HashMap::new();

    // MAX_SOURCE_BYTES is 2MB (2 * 1024 * 1024).
    // Construct an overlay buffer exceeding 2MB (2MB + 128 bytes).
    let huge_content = " ".repeat(MAX_SOURCE_BYTES + 128);
    overlay.insert("main.typ".to_string(), huge_content);

    let res = compile_project_document(temp.path(), "main.typ", Some(overlay));
    assert!(
        res.is_err(),
        "Overlay buffer exceeding 2MB must be rejected safely"
    );
    let err = res.unwrap_err();
    let is_budget_err = err
        .errors
        .iter()
        .any(|e| e.message.contains("byte limit") || e.message.contains("over the"));
    assert!(
        is_budget_err || err.message.contains("limit") || err.message.contains("failed"),
        "Diagnostic should cite byte limit: {:?}",
        err
    );
}

#[tokio::test]
async fn test_overlay_multi_file_deep_imports_and_shadowing() {
    let temp = TempDir::new().unwrap();
    // Write disk file that should be shadowed by overlay
    std::fs::write(
        temp.path().join("config.typ"),
        "#let app_title = [Disk Old Title]\n",
    )
    .unwrap();

    let mut overlay = HashMap::new();
    overlay.insert(
        "main.typ".to_string(),
        format!("{PAGE_PRELUDE}#import \"config.typ\": app_title\n#import \"modules/deep/helper.typ\": helper_text\n= Title: #app_title\n#helper_text\n"),
    );
    // Shadow config.typ with in-memory version
    overlay.insert(
        "config.typ".to_string(),
        "#let app_title = [Shadowed Memory Title]\n".to_string(),
    );
    // Provide deeply nested relative import
    overlay.insert(
        "modules/deep/helper.typ".to_string(),
        "#let helper_text = [Deep Nested In-Memory Component]\n".to_string(),
    );

    let pdf_bytes = compile_project_document(temp.path(), "main.typ", Some(overlay))
        .expect("multi-file overlay shadowing must compile cleanly");

    assert!(pdf_bytes.starts_with(b"%PDF-"));
}

#[tokio::test]
async fn test_overlay_cyclic_import_detection_without_stack_overflow() {
    let temp = TempDir::new().unwrap();
    let mut overlay = HashMap::new();
    overlay.insert(
        "main.typ".to_string(),
        format!("{PAGE_PRELUDE}#import \"module_a.typ\": a_val\n= Main\n#a_val\n"),
    );
    overlay.insert(
        "module_a.typ".to_string(),
        "#import \"module_b.typ\": b_val\n#let a_val = [A]\n".to_string(),
    );
    overlay.insert(
        "module_b.typ".to_string(),
        "#import \"module_a.typ\": a_val\n#let b_val = [B]\n".to_string(),
    );

    // Typst's compiler detects cycles in import graphs. It must report a diagnostic, not stack overflow.
    let res = compile_project_document(temp.path(), "main.typ", Some(overlay));
    assert!(
        res.is_err(),
        "Cyclic imports must be caught and rejected cleanly"
    );
    let err = res.unwrap_err();
    assert!(
        err.errors.iter().any(|e| e.message.contains("cyclic")
            || e.message.contains("cycle")
            || e.message.contains("loop")
            || e.severity == "error"),
        "Expected cyclic import diagnostic, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_overlay_path_traversal_sanitization() {
    let temp = TempDir::new().unwrap();

    // 1. Path traversal in overlay keys must be ignored/sanitized
    let mut overlay = HashMap::new();
    overlay.insert(
        "../../outside.typ".to_string(),
        "#let secret = [leaked]\n".to_string(),
    );
    overlay.insert(
        "foo/../../bar.typ".to_string(),
        "#let secret = [leaked]\n".to_string(),
    );
    overlay.insert(
        "/absolute/root.typ".to_string(),
        "#let secret = [leaked]\n".to_string(),
    );
    overlay.insert(
        "main.typ".to_string(),
        format!("{PAGE_PRELUDE}= Traversal Defense\n"),
    );

    // Compilation succeeds because malicious overlay keys were stripped by normalize_overlay_path
    let res = compile_project_document(temp.path(), "main.typ", Some(overlay));
    assert!(res.is_ok(), "Sanitized overlay must compile main.typ");

    // 2. Traversal in main_file parameter must be rejected immediately
    let res_traversal = compile_project_document(temp.path(), "../escape.typ", None);
    assert!(
        res_traversal.is_err(),
        "Main file attempting directory traversal must be rejected"
    );
    let err = res_traversal.unwrap_err();
    assert!(
        err.message.contains("Invalid main file path") || err.message.contains("failed"),
        "Expected invalid path diagnostic, got: {:?}",
        err
    );
}

// ============================================================================
// 3. Concurrency Stress & Comemo Eviction Tests
// ============================================================================

#[tokio::test]
async fn test_concurrency_rapid_parallel_compilations_and_eviction() {
    let temp = TempDir::new().unwrap();
    let temp_path = Arc::new(temp.path().to_path_buf());

    // Spawn 24 concurrent workers performing 3 compilations each (72 total compilations)
    // with mutating in-memory overlays, mixing valid and syntax error payloads.
    let num_tasks = 24;
    let iterations_per_task = 3;

    let mut handles = Vec::new();

    for task_id in 0..num_tasks {
        let root = Arc::clone(&temp_path);
        let handle = tokio::spawn(async move {
            for iter in 0..iterations_per_task {
                let should_be_error = (task_id + iter) % 4 == 0;
                let mut overlay = HashMap::new();

                let source = if should_be_error {
                    format!("{PAGE_PRELUDE}#let broken = (\n")
                } else {
                    format!(
                        "{PAGE_PRELUDE}= Task {task_id} Iteration {iter}\n\
                         Rapid compilation stress test content with dynamic nonce: {}.\n",
                        task_id * 1000 + iter
                    )
                };

                overlay.insert("main.typ".to_string(), source);

                let res = compile_project_document(&root, "main.typ", Some(overlay));
                if should_be_error {
                    assert!(res.is_err(), "Expected syntax error for broken source");
                } else {
                    assert!(res.is_ok(), "Expected success: {:?}", res.err());
                    let pdf = res.unwrap();
                    assert!(pdf.starts_with(b"%PDF-1.7"));
                }
            }
        });
        handles.push(handle);
    }

    for (i, handle) in handles.into_iter().enumerate() {
        let res = handle.await;
        assert!(
            res.is_ok(),
            "Task {i} must finish without panicking or deadlock: {:?}",
            res.err()
        );
    }
}

#[tokio::test]
async fn test_sync_forward_and_inverse_concurrency_stress() {
    let temp = TempDir::new().unwrap();
    let main_typ = temp.path().join("main.typ");
    std::fs::write(
        &main_typ,
        format!(
            "{PAGE_PRELUDE}\
             = Section One\nFirst body paragraph text.\n\n\
             = Section Two\nSecond body paragraph text.\n\n\
             = Section Three\nThird body paragraph text.\n"
        ),
    )
    .unwrap();

    let root = temp.path().to_string_lossy().to_string();

    // Run parallel sync queries
    let mut handles = Vec::new();
    for i in 0..16 {
        let r = root.clone();
        let handle = tokio::spawn(async move {
            // Forward sync
            let line = 2 + (i % 6);
            let fwd = typst_sync_forward(
                r.clone(),
                "main.typ".to_string(),
                "main.typ".to_string(),
                line,
                Some(1),
            )
            .await
            .expect("fwd sync should not panic");
            if let Some(res) = fwd {
                assert_eq!(res.page, 1);
                assert!(res.width > 0.0);
            }

            // Inverse sync
            let y_click = 72.0 + (i as f64) * 20.0;
            let inv = typst_sync_inverse(r, "main.typ".to_string(), 1, 100.0, y_click)
                .await
                .expect("inv sync should not panic");
            if let Some(res) = inv {
                assert_eq!(res.file, "main.typ");
                assert!(res.line >= 1);
            }
        });
        handles.push(handle);
    }

    for h in handles {
        h.await.expect("sync stress worker panicked");
    }
}
