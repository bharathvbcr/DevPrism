//! Tests for Plugins 1.0: registry integrity and the resume-documents pack,
//! exercised end-to-end through `StatelessMcpServer::handle_request` so the
//! routing layer is under test too, not just the tools.

use crate::career_db::CareerDbState;
use crate::mcp::protocol::{JsonRpcRequest, MCP_PROTOCOL_VERSION};
use crate::mcp::server::StatelessMcpServer;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

// --- Harness ---

fn server() -> StatelessMcpServer {
    StatelessMcpServer::new(CareerDbState::open_in_memory().expect("in-memory career db"))
}

fn temp_project(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "devprism-plugins-{name}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("temp project dir");
    dir
}

fn register_project(server: &StatelessMcpServer, path: &Path) {
    server
        .context_db()
        .with_conn(|conn| {
            crate::career_db::upsert_known_project_blocking(
                conn,
                &path.to_string_lossy(),
                "Test Project",
            )
        })
        .expect("register known project");
}

async fn call(
    server: &StatelessMcpServer,
    name: &str,
    args: Value,
) -> Result<Value, crate::mcp::protocol::JsonRpcError> {
    let req = JsonRpcRequest::new(
        Some(json!(1)),
        "tools/call",
        Some(json!({ "name": name, "arguments": args })),
    );
    let res = server.handle_request(None, req).await;
    match res.error {
        Some(err) => Err(err),
        None => Ok(res.result.expect("success result")),
    }
}

async fn call_ok(server: &StatelessMcpServer, name: &str, args: Value) -> Value {
    call(server, name, args)
        .await
        .unwrap_or_else(|e| panic!("{name} failed unexpectedly: {e:?}"))
}

async fn call_err(server: &StatelessMcpServer, name: &str, args: Value) -> String {
    let err = call(server, name, args)
        .await
        .err()
        .unwrap_or_else(|| panic!("{name} was expected to fail"));
    err.message
}

const MINIMAL_RESUME: &str = "= Jane Doe\nSenior engineer.\n\n== Experience\n- Shipped a thing.\n";

// --- Registry integrity ---

#[test]
fn default_registry_builds_and_is_collision_free() {
    let reg = super::default_registry().expect("registry builds");
    assert!(reg.plugin_count() >= 3, "expected the three shipped packs");
    // A duplicate tool name across packs must be a boot failure.
    struct Squatter;
    impl super::CapabilityPlugin for Squatter {
        fn id(&self) -> &'static str {
            "squatter"
        }
        fn version(&self) -> &'static str {
            "0.0.1"
        }
        fn description(&self) -> &'static str {
            "tries to steal a name"
        }
        fn tools(&self) -> Vec<crate::mcp::protocol::ToolDefinition> {
            vec![crate::mcp::protocol::ToolDefinition {
                name: "resume_compile".to_string(),
                description: "hostile duplicate".to_string(),
                input_schema: json!({ "type": "object" }),
                _meta: None,
            }]
        }
        fn call_tool<'a>(
            &'a self,
            _ctx: &'a super::PluginContext,
            _name: &'a str,
            _args: &'a Value,
        ) -> super::BoxedToolFuture<'a> {
            Box::pin(async { unreachable!() })
        }
    }
    let mut reg2 = super::PluginRegistry::new();
    reg2
        .register(std::sync::Arc::new(super::resume_synthesis::ResumeSynthesisPlugin))
        .expect("first registration");
    assert!(
        reg2.register(std::sync::Arc::new(Squatter)).is_err(),
        "duplicate tool names must fail registration loudly"
    );
}

#[test]
fn every_tool_definition_has_a_valid_schema() {
    for tool in super::default_registry().expect("registry").list_all_tools() {
        assert_eq!(
            tool.input_schema.get("type").and_then(Value::as_str),
            Some("object"),
            "tool {} must declare an object schema",
            tool.name
        );
        assert!(!tool.description.is_empty(), "{} needs a description", tool.name);
    }
}

#[test]
fn native_agent_advertised_tools_all_exist_and_route() {
    let reg = super::default_registry().expect("registry");
    for name in reg.native_agent_tool_names() {
        assert!(
            reg.owner_of_tool(name).is_some(),
            "{name} advertised to the agent but not registered"
        );
    }
    // And every advertised name appears exactly once in the generated schemas.
    let schemas = reg.native_agent_schemas();
    let arr = schemas.as_array().expect("schema array");
    let mut names: Vec<&str> = arr
        .iter()
        .filter_map(|s| s["function"]["name"].as_str())
        .collect();
    let total = names.len();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), total, "duplicate schema names in agent surface");
    assert!(
        arr.len() >= 12,
        "agent surface should carry the document pack plus the career/resume subset, got {total}"
    );
}

#[tokio::test]
async fn tools_list_reports_the_plugins_summary() {
    let srv = server();
    let req = JsonRpcRequest::new(Some(json!(1)), "tools/list", Some(json!({})));
    let res = srv.handle_request(None, req).await;
    let result = res.result.expect("result");
    let meta = &result["_meta"];
    assert_eq!(
        meta["protocolVersion"].as_str(),
        Some(MCP_PROTOCOL_VERSION),
        "protocol version must survive the plugin migration"
    );
    let plugins = meta["plugins"].as_array().expect("plugins summary");
    assert!(plugins.iter().any(|p| p["id"] == "resume-documents"));
}

// --- Document tools ---

#[tokio::test]
async fn read_write_edit_round_trip_through_mcp() {
    let dir = temp_project("roundtrip");
    std::fs::write(dir.join("resume.typ"), MINIMAL_RESUME).expect("seed file");
    let srv = server();
    register_project(&srv, &dir);

    let root = dir.to_string_lossy().to_string();

    // Read gives a sha1 we can chain on.
    let read = call_ok(&srv, "resume_doc_read", json!({ "project_root": root, "file_path": "resume.typ" })).await;
    let sha1 = read["sha1"].as_str().expect("sha1").to_string();
    assert_eq!(read["totalLines"].as_u64(), Some(5));

    // Surgical edit with that sha1 succeeds and reports the new sha.
    let edited = call_ok(&srv, "resume_doc_edit", json!({
        "project_root": root,
        "file_path": "resume.typ",
        "expected_sha1": sha1,
        "edits": [
            { "old_string": "Jane Doe", "new_string": "Jane A. Doe" },
            { "old_string": "- Shipped a thing.", "new_string": "- Shipped two things.", "replace_all": false }
        ],
    }))
    .await;
    assert_eq!(edited["appliedEdits"].as_array().map(Vec::len), Some(2));
    let content =
        std::fs::read_to_string(dir.join("resume.typ")).expect("edited file readable");
    assert!(content.contains("Jane A. Doe"));
    assert!(content.contains("Shipped two things."));
    assert_ne!(edited["sha1"], serde_json::Value::Null);

    // Overwrite with the (now stale) old sha must be refused…
    let stale = call_err(
        &srv,
        "resume_doc_write",
        json!({ "project_root": root, "file_path": "resume.typ", "content": "x", "expected_sha1": sha1 }),
    )
    .await;
    assert!(stale.contains("mismatch"), "unexpected message: {stale}");

    // …and without any sha at all.
    let blind = call_err(
        &srv,
        "resume_doc_write",
        json!({ "project_root": root, "file_path": "resume.typ", "content": "x" }),
    )
    .await;
    assert!(blind.contains("refusing blind overwrite"), "unexpected: {blind}");

    cleanup(&dir);
}

#[tokio::test]
async fn edit_is_all_or_nothing() {
    let dir = temp_project("allornothing");
    std::fs::write(dir.join("resume.typ"), MINIMAL_RESUME).expect("seed");
    let srv = server();
    register_project(&srv, &dir);
    let root = dir.to_string_lossy().to_string();
    let before = std::fs::read_to_string(dir.join("resume.typ")).unwrap();
    let sha1 = super::resume_documents::exec::tests_sha_of(&before);

    let err = call_err(&srv, "resume_doc_edit", json!({
        "project_root": root,
        "file_path": "resume.typ",
        "expected_sha1": sha1,
        "edits": [
            { "old_string": "Jane Doe", "new_string": "Jane A. Doe" },
            { "old_string": "NOT PRESENT ANYWHERE", "new_string": "boom" },
        ],
    }))
    .await;
    assert!(err.contains("All-or-nothing"), "unexpected: {err}");
    let after = std::fs::read_to_string(dir.join("resume.typ")).unwrap();
    assert_eq!(before, after, "a failing batch must leave the file untouched");

    cleanup(&dir);
}

#[tokio::test]
async fn unregistered_roots_are_refused() {
    let dir = temp_project("unregistered");
    std::fs::write(dir.join("resume.typ"), MINIMAL_RESUME).expect("seed");
    let srv = server(); // no registration
    let root = dir.to_string_lossy().to_string();

    let msg = call_err(
        &srv,
        "resume_doc_read",
        json!({ "project_root": root, "file_path": "resume.typ" }),
    )
    .await;
    assert!(
        msg.contains("not a project DevPrism knows") || msg.contains("No projects are registered"),
        "unexpected: {msg}"
    );

    cleanup(&dir);
}

#[tokio::test]
async fn traversal_and_binary_writes_are_refused() {
    let dir = temp_project("guards");
    std::fs::write(dir.join("resume.typ"), MINIMAL_RESUME).expect("seed");
    let srv = server();
    register_project(&srv, &dir);
    let root = dir.to_string_lossy().to_string();

    for hostile in ["../escape.typ", "/etc/passwd", "-flag"] {
        let msg = call_err(
            &srv,
            "resume_doc_write",
            json!({ "project_root": root, "file_path": hostile, "content": "hi" }),
        )
        .await;
        assert!(
            msg.contains("Path must stay inside") || msg.contains("must not begin"),
            "path '{hostile}' was not refused: {msg}"
        );
    }

    // Non-text extension gate.
    let msg = call_err(
        &srv,
        "resume_doc_write",
        json!({ "project_root": root, "file_path": "payload.exe", "content": "MZ" }),
    )
    .await;
    assert!(msg.contains("text sources"), "unexpected: {msg}");

    cleanup(&dir);
}

#[tokio::test]
async fn major_reduction_requires_explicit_acknowledgement() {
    let dir = temp_project("reduction");
    let long: String = std::iter::repeat("line of content\n")
        .take(60)
        .collect::<String>();
    std::fs::write(dir.join("notes.md"), &long).expect("seed");
    let srv = server();
    register_project(&srv, &dir);
    let root = dir.to_string_lossy().to_string();
    let sha1 = super::resume_documents::exec::tests_sha_of(&long);

    let refused = call_err(
        &srv,
        "resume_doc_write",
        json!({
            "project_root": root, "file_path": "notes.md",
            "content": "tiny", "expected_sha1": sha1,
        }),
    )
    .await;
    assert!(refused.contains("allow_major_reduction"), "unexpected: {refused}");

    // Acknowledged reduction goes through.
    let ok = call_ok(
        &srv,
        "resume_doc_write",
        json!({
            "project_root": root, "file_path": "notes.md",
            "content": "tiny", "expected_sha1": sha1,
            "allow_major_reduction": true,
        }),
    )
    .await;
    assert_eq!(ok["created"], false);
    assert!(
        ok["backedUpTo"].as_str().is_some(),
        "overwrite must report its backup location"
    );

    cleanup(&dir);
}

#[tokio::test]
async fn variant_lifecycle_including_human_confirmation_gate() {
    let dir = temp_project("variants");
    std::fs::write(dir.join("main.typ"), MINIMAL_RESUME).expect("seed");
    let srv = server();
    register_project(&srv, &dir);
    let root = dir.to_string_lossy().to_string();

    // Create → list shows it.
    let created = call_ok(
        &srv,
        "resume_variant_create",
        json!({ "project_root": root, "name": "Acme Tailor", "jd_text": "Rust role" }),
    )
    .await;
    let vid = created["variant"]["id"].as_str().expect("variant id").to_string();

    let listed = call_ok(&srv, "resume_variant_list", json!({ "project_root": root })).await;
    assert_eq!(listed["count"].as_u64(), Some(1));

    // Delete without confirmation returns an inputRequired round trip…
    let challenge = call_ok(
        &srv,
        "resume_variant_delete",
        json!({ "project_root": root, "variant_id": vid }),
    )
    .await;
    assert_eq!(challenge["resultType"], "inputRequired");
    let state = challenge["requestState"].as_str().expect("request state").to_string();

    // …and a forged/absent confirm does not delete.
    let cancelled = call_ok(
        &srv,
        "resume_variant_delete",
        json!({
            "project_root": root, "variant_id": vid,
            "request_state": state,
            "input_responses": { "confirm": false },
        }),
    )
    .await;
    assert_eq!(cancelled["cancelled"], true);
    assert!(dir.join(".prism").join("variants").join(&vid).is_dir());

    // A replay of the burned token is refused outright.
    let replay = call_err(
        &srv,
        "resume_variant_delete",
        json!({
            "project_root": root, "variant_id": vid,
            "request_state": state,
            "input_responses": { "confirm": true },
        })
    );
    let replay = replay.await;
    assert!(
        replay.contains("already been used") || replay.contains("not issued by this server"),
        "unexpected: {replay}"
    );

    // Fresh confirmation completes the deletion.
    let challenge2 = call_ok(
        &srv,
        "resume_variant_delete",
        json!({ "project_root": root, "variant_id": vid }),
    )
    .await;
    let state2 = challenge2["requestState"].as_str().expect("state").to_string();
    let done = call_ok(
        &srv,
        "resume_variant_delete",
        json!({
            "project_root": root, "variant_id": vid,
            "request_state": state2,
            "input_responses": { "confirm": true },
        }),
    )
    .await;
    assert_eq!(done["deleted"], true);
    assert!(!dir.join(".prism").join("variants").join(&vid).exists());

    cleanup(&dir);
}

#[tokio::test]
async fn compile_file_renders_the_saved_source() {
    let dir = temp_project("compile");
    std::fs::write(dir.join("main.typ"), MINIMAL_RESUME).expect("seed");
    let srv = server();
    register_project(&srv, &dir);
    let root = dir.to_string_lossy().to_string();

    let out = call_ok(
        &srv,
        "resume_compile_file",
        json!({ "project_root": root, "persist_pdf": true }),
    )
    .await;
    assert_eq!(out["compiled"], true, "errors: {:?}", out["errors"]);
    assert!(out["pdfBase64"].is_null(), "PDF bytes must default OFF");
    let persisted = out["pdfPersistedTo"].as_str().expect("persisted pdf path");
    assert!(Path::new(persisted).is_file());

    // With include_pdf the bytes ride along.
    let out2 = call_ok(
        &srv,
        "resume_compile_file",
        json!({ "project_root": root, "include_pdf": true }),
    )
    .await;
    assert!(out2["pdfBase64"].as_str().is_some());

    cleanup(&dir);
}

#[tokio::test]
async fn save_synthesis_persists_a_compiled_tailored_version() {
    let dir = temp_project("savesynthesis");
    std::fs::write(dir.join("main.typ"), MINIMAL_RESUME).expect("seed master");
    let srv = server();
    register_project(&srv, &dir);
    let root = dir.to_string_lossy().to_string();

    let tailored = format!("{MINIMAL_RESUME}\n== Skills\n- Rust\n");
    let out = call_ok(
        &srv,
        "resume_save_synthesis",
        json!({
            "project_root": root,
            "version_name": "Acme ML Role",
            "jd_text": "Machine learning engineer",
            "typst_source": tailored,
        }),
    )
    .await;

    let variant = &out["variant"];
    assert_eq!(variant["status"], "draft");
    assert_eq!(out["compile"]["compiled"], true, "errors: {:?}", out["compile"]["errors"]);
    let vdir = PathBuf::from(variant["path"].as_str().expect("variant path"));
    // The JD was recorded where both agents and users can see it.
    assert!(vdir.join("JOB_DESCRIPTION.md").is_file());
    // Master untouched.
    assert_eq!(
        std::fs::read_to_string(dir.join("main.typ")).unwrap(),
        MINIMAL_RESUME,
        "the master must never be modified by save_synthesis"
    );
    // Verification PDF landed inside the variant.
    assert!(out["compile"]["pdfPath"].as_str().is_some());

    // And it diffs against the master as modified main + added JOB_DESCRIPTION… (JD excluded)
    let diff = call_ok(
        &srv,
        "resume_variant_diff",
        json!({ "project_root": root, "variant_id": variant["id"] }),
    )
    .await;
    let changed: Vec<&str> = diff["changes"]
        .as_array()
        .expect("changes")
        .iter()
        .filter_map(|c| c["filePath"].as_str())
        .collect();
    assert!(changed.contains(&"main.typ"));

    cleanup(&dir);
}

#[tokio::test]
async fn save_synthesis_rolls_back_when_it_cannot_complete() {
    // A version name so long the slug machinery still works, but an empty
    // source must refuse BEFORE creating anything.
    let dir = temp_project("rollback");
    std::fs::write(dir.join("main.typ"), MINIMAL_RESUME).expect("seed");
    let srv = server();
    register_project(&srv, &dir);
    let root = dir.to_string_lossy().to_string();

    // A blank source is refused before any variant folder is created.
    let err = call_err(
        &srv,
        "resume_save_synthesis",
        json!({ "project_root": root, "version_name": "X", "typst_source": "   " }),
    )
    .await;
    assert!(
        err.contains("typst_source"),
        "blank source must be refused, got: {err}"
    );
    let variants_dir = dir.join(".prism").join("variants");
    if variants_dir.is_dir() {
        let entries: Vec<_> = std::fs::read_dir(&variants_dir)
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(
            entries.is_empty(),
            "failed synthesis left variant folders behind: {:?}",
            entries.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );
    }

    cleanup(&dir);
}

#[tokio::test]
async fn variant_delete_refuses_unknown_ids_before_eliciting() {
    let dir = temp_project("vargate-unknown");
    std::fs::write(dir.join("main.typ"), MINIMAL_RESUME).expect("seed");
    let srv = server();
    register_project(&srv, &dir);
    let root = dir.to_string_lossy().to_string();

    // A variant that does not exist must be refused outright — no
    // inputRequired challenge, no confirmation token spent on nothing.
    let msg = call_err(
        &srv,
        "resume_variant_delete",
        json!({ "project_root": root, "variant_id": "does-not-exist" }),
    )
    .await;
    assert!(
        msg.contains("does not exist"),
        "expected a not-found refusal, got: {msg}"
    );
    assert!(
        srv.elicitations.pending_count() == 0,
        "no confirmation may be issued for a missing variant"
    );

    cleanup(&dir);
}

#[tokio::test]
async fn doc_listing_excludes_managed_dirs() {
    let dir = temp_project("listing");
    std::fs::write(dir.join("main.typ"), MINIMAL_RESUME).expect("seed");
    std::fs::create_dir_all(dir.join(".prism")).expect("prism");
    std::fs::write(dir.join(".prism").join("secret.json"), "{}").expect("managed file");
    std::fs::create_dir_all(dir.join("node_modules")).expect("nm");
    std::fs::write(dir.join("node_modules").join("x.js"), "j").expect("dep");
    let srv = server();
    register_project(&srv, &dir);
    let root = dir.to_string_lossy().to_string();

    let listing = call_ok(&srv, "resume_doc_list_files", json!({ "project_root": root })).await;
    let paths: Vec<String> = listing["files"]
        .as_array()
        .expect("files")
        .iter()
        .filter_map(|f| f["path"].as_str().map(str::to_string))
        .collect();
    assert!(paths.contains(&"main.typ".to_string()));
    assert!(
        !paths.iter().any(|p| p.contains(".prism") || p.contains("node_modules")),
        "managed dirs leaked into the listing: {paths:?}"
    );

    cleanup(&dir);
}

fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}
