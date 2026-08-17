//! Headless integration tests over the real Tauri IPC layer.
//!
//! The unit tests call engine functions directly, which skips everything the
//! app actually goes through: command registration, argument deserialization
//! (the frontend sends camelCase; Rust declares snake_case), `spawn_blocking`
//! on Tauri's runtime, and result serialization back to the webview.
//!
//! These tests build a real `App` on Tauri's `MockRuntime` and dispatch
//! commands using the exact JSON payloads the TypeScript call sites send. A
//! renamed parameter or a serde shape the frontend cannot read fails here
//! instead of at runtime in front of a user.
//!
//! Registration is checked separately and statically against the app's real
//! `command_handler()`, because that list is `Wry`-typed and cannot be built
//! on `MockRuntime` — see `every_command_the_frontend_calls_is_registered`.

use serde_json::{json, Value};
use tauri::test::{mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{ipc::CallbackFn, App, Manager, WebviewWindow};
use tauri::test::MockRuntime;

/// Commands exercised over real IPC here.
///
/// A subset rather than the app's full `command_handler()`: many commands take
/// a concrete `AppHandle`/`WebviewWindow` (i.e. `Wry`) and cannot be built on
/// `MockRuntime`. `every_command_the_frontend_calls_is_registered` covers the
/// full list statically, and `ipc_tested_commands_are_registered_in_the_app`
/// makes sure this subset never drifts out of the real handler.
const IPC_TESTED_COMMANDS: &[&str] = &[
    "career_typst_compile",
    "career_typst_compile_project",
    "career_typst_fonts",
    "export_document",
    "compile_latex",
    "detect_latexdiff",
];

/// Build an app with the same managed state `run()` installs.
fn app() -> App<MockRuntime> {
    mock_builder()
        .manage(claude_prism_desktop_lib::latex::LatexCompilerState::default())
        .invoke_handler(tauri::generate_handler![
            claude_prism_desktop_lib::career_typst::career_typst_compile,
            claude_prism_desktop_lib::career_typst::career_typst_compile_project,
            claude_prism_desktop_lib::career_typst::career_typst_fonts,
            claude_prism_desktop_lib::export::export_document,
            claude_prism_desktop_lib::latex::compile_latex,
            claude_prism_desktop_lib::latexdiff::detect_latexdiff,
        ])
        .build(mock_context(noop_assets()))
        .expect("failed to build mock app")
}

fn webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    tauri::WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .expect("failed to build mock webview")
}

/// Dispatch a command the way the frontend does, returning the JSON result.
fn invoke(
    webview: &WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: tauri::ipc::InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    tauri::test::get_ipc_response(webview, request)
        .map(|b| b.deserialize::<Value>().unwrap_or(Value::Null))
}

// --- Typst resume engine -------------------------------------------------

#[test]
fn career_typst_compile_round_trips_through_ipc() {
    let app = app();
    let wv = webview(&app);

    // Exactly what `typstCompile()` sends.
    let res = invoke(
        &wv,
        "career_typst_compile",
        json!({
            "source": "#set page(paper: \"us-letter\")\n= Hello\nBody.\n"
        }),
    )
    .expect("command should succeed");

    assert_eq!(res["success"], json!(true), "got {res}");
    assert_eq!(res["page_count"], json!(1));
    assert!(res["duration_ms"].is_number());
    assert!(res["errors"].is_array());
    assert!(res["warnings"].is_array());

    // The frontend reads `pdf_bytes` as number[] and rebuilds a Uint8Array.
    let bytes = res["pdf_bytes"].as_array().expect("pdf_bytes array");
    assert!(bytes.len() > 1000, "suspiciously small pdf");
    let header: Vec<u8> = bytes
        .iter()
        .take(5)
        .map(|v| v.as_u64().unwrap() as u8)
        .collect();
    assert_eq!(&header, b"%PDF-", "pdf_bytes is not a PDF");
}

#[test]
fn career_typst_compile_reports_errors_in_the_shape_the_ui_reads() {
    let app = app();
    let wv = webview(&app);

    let res = invoke(
        &wv,
        "career_typst_compile",
        json!({ "source": "#set page(paper: \"us-letter\")\n#strong(\n" }),
    )
    .expect("command itself should not fail");

    assert_eq!(res["success"], json!(false));
    let errors = res["errors"].as_array().expect("errors array");
    assert!(!errors.is_empty(), "expected a diagnostic");
    // `TypstDiagnostic` in typst-compile.ts.
    let first = &errors[0];
    assert_eq!(first["severity"], json!("error"));
    assert!(first["message"].is_string());
    assert!(first.get("file").is_some(), "missing `file` key");
    assert!(first.get("line").is_some(), "missing `line` key");
    assert!(first["hints"].is_array());
    assert!(res["pdf_bytes"].is_null(), "no PDF on failure");
}

#[test]
fn career_typst_compile_project_accepts_camel_case_arguments() {
    // The single highest-value assertion here: the frontend sends
    // `projectDir`/`mainFile`, Rust declares `project_dir`/`main_file`. If that
    // mapping ever breaks the app fails only at runtime.
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("lib.typ"),
        "#let greet(n) = [Hello #n]\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("main.typ"),
        "#set page(paper: \"us-letter\")\n#import \"lib.typ\": greet\n#greet(\"world\")\n",
    )
    .unwrap();

    let app = app();
    let wv = webview(&app);
    let res = invoke(
        &wv,
        "career_typst_compile_project",
        json!({
            "projectDir": dir.path().to_string_lossy(),
            "mainFile": "main.typ",
        }),
    )
    .expect("command should succeed");

    assert_eq!(res["success"], json!(true), "got {res}");
    assert_eq!(res["page_count"], json!(1));
}

#[test]
fn career_typst_compile_project_confines_reads_to_the_project() {
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("main.typ"),
        "#set page(paper: \"us-letter\")\n#read(\"../outside.txt\")\n",
    )
    .unwrap();
    std::fs::write(dir.path().parent().unwrap().join("outside.txt"), "secret").ok();

    let app = app();
    let wv = webview(&app);
    let res = invoke(
        &wv,
        "career_typst_compile_project",
        json!({
            "projectDir": dir.path().to_string_lossy(),
            "mainFile": "main.typ",
        }),
    )
    .expect("command should return a result");

    assert_eq!(
        res["success"],
        json!(false),
        "a read outside the project must not resolve"
    );
}

#[test]
fn career_typst_fonts_returns_the_embedded_families() {
    let app = app();
    let wv = webview(&app);
    let res = invoke(&wv, "career_typst_fonts", json!({})).expect("should succeed");

    let families: Vec<String> = serde_json::from_value(res).expect("string array");
    for want in ["Libertinus Serif", "New Computer Modern", "DejaVu Sans Mono"] {
        assert!(
            families.iter().any(|f| f == want),
            "missing embedded family {want}"
        );
    }
}

// --- Export --------------------------------------------------------------

#[test]
fn export_document_accepts_camel_case_and_rejects_traversal() {
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(dir.path().join("main.tex"), "x").unwrap();

    let app = app();
    let wv = webview(&app);
    // Payload shape from export-menu.tsx.
    let err = invoke(
        &wv,
        "export_document",
        json!({
            "projectRoot": dir.path().to_string_lossy(),
            "texPath": "../escape.tex",
            "format": "docx",
            "outputPath": "/tmp/devprism-ipc-test.docx",
            "bibPath": null,
        }),
    )
    .expect_err("traversal must be rejected");

    let msg = err.as_str().unwrap_or_default();
    assert!(
        msg.contains("must not leave the project"),
        "unexpected error: {msg}"
    );
}

#[test]
fn export_document_rejects_an_unsupported_format() {
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(dir.path().join("main.tex"), "x").unwrap();

    let app = app();
    let wv = webview(&app);
    let err = invoke(
        &wv,
        "export_document",
        json!({
            "projectRoot": dir.path().to_string_lossy(),
            "texPath": "main.tex",
            "format": "pdf",
            "outputPath": "/tmp/devprism-ipc-test.pdf",
            "bibPath": null,
        }),
    )
    .expect_err("pdf is not a pandoc target here");

    assert!(
        err.as_str().unwrap_or_default().contains("Unsupported export format"),
        "unexpected error: {err}"
    );
}

// --- LaTeX ---------------------------------------------------------------

#[test]
fn compile_latex_accepts_camel_case_and_reports_a_missing_project() {
    // Exercises the managed-state path (`LatexCompilerState`) and the
    // camelCase mapping, without needing a TeX engine on the machine.
    let app = app();
    let wv = webview(&app);
    let err = invoke(
        &wv,
        "compile_latex",
        json!({
            "projectDir": "/definitely/not/a/real/project",
            "mainFile": "main.tex",
            "useTexlive": false,
        }),
    )
    .expect_err("a missing project must not compile");

    let msg = err.as_str().unwrap_or_default();
    assert!(
        msg.contains("Compilation failed"),
        "expected a compile failure message, got: {msg}"
    );
}

#[test]
fn detect_latexdiff_answers_without_hanging() {
    // Whether latexdiff exists is machine-dependent; the contract is that the
    // probe is bounded and returns a bool either way.
    let app = app();
    let wv = webview(&app);
    let started = std::time::Instant::now();
    let res = invoke(&wv, "detect_latexdiff", json!({})).expect("should succeed");
    assert!(res.is_boolean(), "expected a bool, got {res}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(30),
        "probe took {:?}",
        started.elapsed()
    );
}

// --- Registration --------------------------------------------------------

#[test]
fn an_unregistered_command_is_rejected() {
    // Proves the harness would actually notice a missing registration rather
    // than silently passing.
    let app = app();
    let wv = webview(&app);
    let err = invoke(&wv, "no_such_command_xyz", json!({}))
        .expect_err("unknown commands must not resolve");
    assert!(
        err.as_str().unwrap_or_default().contains("not found"),
        "unexpected error: {err}"
    );
}

/// Command names inside `command_handler()` in `lib.rs`.
fn registered_commands() -> std::collections::BTreeSet<String> {
    let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read lib.rs");
    let start = lib
        .find("pub fn command_handler(")
        .expect("command_handler not found in lib.rs");
    let list_start = lib[start..].find("generate_handler![").expect("handler list") + start;
    let list_end = lib[list_start..].find("\n    ]").expect("handler list end") + list_start;
    lib[list_start..list_end]
        .lines()
        .skip(1)
        .filter_map(|l| {
            let l = l.trim().trim_end_matches(',');
            if l.is_empty() || l.starts_with("//") {
                return None;
            }
            l.rsplit("::").next().map(|s| s.to_string())
        })
        .collect()
}

#[test]
fn every_command_the_frontend_calls_is_registered() {
    // Scrapes `invoke("...")` from the TypeScript sources and checks each name
    // against the real handler list. A command the UI calls but the app never
    // registered fails only at runtime otherwise — this catches it in CI, and
    // covers all of them, not just the subset the mock runtime can build.
    let registered = registered_commands();
    assert!(
        registered.len() > 100,
        "parsed only {} registered commands — the lib.rs scrape is wrong",
        registered.len()
    );

    let src_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../src");
    let mut invoked = std::collections::BTreeSet::new();
    collect_invoked_commands(std::path::Path::new(src_root), &mut invoked);
    assert!(
        invoked.len() > 50,
        "scraper found only {} invoked commands",
        invoked.len()
    );

    // Plugin commands are handled by their own plugins, not this handler.
    let missing: Vec<&String> = invoked
        .iter()
        .filter(|c| !registered.contains(*c))
        .filter(|c| !c.starts_with("plugin:"))
        .collect();
    assert!(
        missing.is_empty(),
        "frontend invokes commands absent from command_handler(): {missing:?}"
    );
}

#[test]
fn ipc_tested_commands_are_registered_in_the_app() {
    // The mock handler above is hand-written; this stops it drifting into
    // testing commands the real app no longer ships.
    let registered = registered_commands();
    for cmd in IPC_TESTED_COMMANDS {
        assert!(
            registered.contains(*cmd),
            "{cmd} is IPC-tested but missing from command_handler()"
        );
    }
}

fn collect_invoked_commands(
    dir: &std::path::Path,
    out: &mut std::collections::BTreeSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if name != "__tests__" && name != "node_modules" {
                collect_invoked_commands(&path, out);
            }
            continue;
        }
        if !(name.ends_with(".ts") || name.ends_with(".tsx")) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        // `invoke("cmd"` and `invoke<T>("cmd"`.
        for part in text.split("invoke").skip(1) {
            let part = part.trim_start();
            let part = if part.starts_with('<') {
                match part.find('>') {
                    Some(i) => part[i + 1..].trim_start(),
                    None => continue,
                }
            } else {
                part
            };
            let Some(rest) = part.strip_prefix('(') else {
                continue;
            };
            let rest = rest.trim_start();
            let Some(rest) = rest.strip_prefix('"') else {
                continue;
            };
            if let Some(end) = rest.find('"') {
                let cmd = &rest[..end];
                if !cmd.is_empty()
                    && cmd
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                {
                    out.insert(cmd.to_string());
                }
            }
        }
    }
}
