#[cfg(test)]
mod tests {
    use crate::career_db::{CareerDbState, ExperienceBlock, DateRange, SkillTag, Bullet};
    use crate::mcp::protocol::{
        HttpHeaders, JsonRpcRequest, MCP_PROTOCOL_VERSION, ERR_HEADER_MISMATCH,
    };
    use crate::mcp::server::StatelessMcpServer;
    use serde_json::json;
    use std::collections::HashMap;

    /// An MCP server over a private in-memory career DB seeded with one known
    /// block.
    ///
    /// This used to be `CareerDbState::default()`, which opens the *user's*
    /// real `career.db`: the assertions depended on whatever they happened to
    /// have stored, and the block-delete test created and removed rows in
    /// their actual career data.
    fn setup_test_server() -> StatelessMcpServer {
        let db = CareerDbState::open_in_memory().expect("in-memory career db");
        db.with_conn(|conn| {
            crate::career_db::upsert_block_blocking(conn, &fixture_block())
        })
        .expect("seed fixture block");
        StatelessMcpServer::new(db)
    }

    /// A deterministic block covering Rust + TypeScript, so coverage
    /// assertions mean something.
    fn fixture_block() -> ExperienceBlock {
        ExperienceBlock {
            id: "fixture-block".to_string(),
            kind: "experience".to_string(),
            title: "Senior Systems Engineer".to_string(),
            org: "Fixture Corp".to_string(),
            date_range: DateRange {
                start: "2022-01".to_string(),
                end: None,
            },
            personas: vec!["ai".to_string()],
            domains: vec!["developer tools".to_string()],
            skills: vec![
                SkillTag { name: "Rust".to_string(), level: 5, years: Some(6.0) },
                SkillTag { name: "TypeScript".to_string(), level: 4, years: Some(5.0) },
                SkillTag { name: "SQLite".to_string(), level: 4, years: None },
            ],
            seniority_level: "senior".to_string(),
            location: None,
            url: None,
            url_label: None,
            extra: None,
            bullets: vec![Bullet {
                id: "fixture-bullet".to_string(),
                canonical: "Built a Rust and TypeScript desktop app backed by SQLite, cutting cold start by 40%".to_string(),
                variants: serde_json::Map::new(),
                metrics: vec![crate::career_db::BulletMetric {
                    value: "40%".to_string(),
                    kind: "percent".to_string(),
                }],
                evidence_refs: Vec::new(),
                locked: false,
            }],
            facts: Vec::new(),
            notes: None,
            embedding_text: None,
            updated_at: "2026-01-01".to_string(),
        }
    }

    #[tokio::test]
    async fn test_tools_list_returns_stateless_meta_and_caching() {
        let server = setup_test_server();
        let req = JsonRpcRequest::new(
            Some(json!(1)),
            "tools/list",
            Some(json!({
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION
                }
            })),
        );

        let res = server.handle_request(None, req).await;
        assert!(res.error.is_none());
        let result = res.result.expect("result present");
        let tools = result["tools"].as_array().expect("tools array");
        assert!(tools.len() >= 10);

        // Verify caching metadata
        let meta = &result["_meta"];
        assert_eq!(meta["protocolVersion"], MCP_PROTOCOL_VERSION);
        assert_eq!(meta["ttlMs"], 300000);
        assert_eq!(meta["cacheScope"], "public");
    }

    #[tokio::test]
    async fn test_header_validation_mismatch_rejection() {
        let server = setup_test_server();

        // 1. Header method does not match body method
        let mut headers = HashMap::new();
        headers.insert("mcp-method".to_string(), "tools/call".to_string());
        headers.insert("mcp-name".to_string(), "resume_analyze_jd".to_string());

        let req = JsonRpcRequest::new(
            Some(json!(2)),
            "tools/list", // Mismatch! Header says tools/call
            None,
        );

        let http_headers = HttpHeaders::from_map(&headers);
        let res = server.handle_request(Some(&http_headers), req).await;
        assert!(res.result.is_none());
        let err = res.error.expect("error present");
        assert_eq!(err.code, ERR_HEADER_MISMATCH);
        assert!(err.message.contains("Header 'mcp-method: tools/call' does not match"));

        // 2. Header name does not match body name
        let mut headers2 = HashMap::new();
        headers2.insert("mcp-method".to_string(), "tools/call".to_string());
        headers2.insert("mcp-name".to_string(), "resume_analyze_jd".to_string());

        let req2 = JsonRpcRequest::new(
            Some(json!(3)),
            "tools/call",
            Some(json!({
                "name": "career_search_kb", // Mismatch! Header says resume_analyze_jd
                "arguments": { "query": "rust" }
            })),
        );

        let http_headers2 = HttpHeaders::from_map(&headers2);
        let res2 = server.handle_request(Some(&http_headers2), req2).await;
        assert!(res2.result.is_none());
        let err2 = res2.error.expect("error present");
        assert_eq!(err2.code, ERR_HEADER_MISMATCH);
        assert!(err2.message.contains("Header 'mcp-name: resume_analyze_jd' does not match"));
    }

    #[tokio::test]
    async fn test_resume_analyze_jd_and_gap_analysis() {
        let server = setup_test_server();

        let jd_text = "We are seeking a Senior Rust & TypeScript Engineer with experience in Distributed Systems, SQLite, and Typst to build high-performance desktop apps.";

        // 1. Analyze JD
        let req = JsonRpcRequest::new(
            Some(json!("req-1")),
            "tools/call",
            Some(json!({
                "name": "resume_analyze_jd",
                "arguments": {
                    "jd_text": jd_text
                }
            })),
        );

        let res = server.handle_request(None, req).await;
        assert!(res.error.is_none());
        let val = res.result.expect("result present");
        let profile = &val["profile"];
        // Canonical `JDProfile` shape (jd-analysis.ts): lowercase seniority
        // enum and `mustHaveSkills`. The previous facade emitted "Senior" and
        // `requiredSkills`, a shape no other layer in the app consumed.
        assert_eq!(profile["seniority"], "senior");
        let must_have = profile["mustHaveSkills"]
            .as_array()
            .expect("mustHaveSkills present");
        assert!(
            must_have.iter().any(|s| s == "rust"),
            "expected rust in {must_have:?}"
        );
        assert!(
            must_have.iter().any(|s| s == "typescript"),
            "expected typescript in {must_have:?}"
        );
        // Every canonical field must be present, so downstream consumers can
        // rely on one shape regardless of which provider produced it.
        for key in [
            "roleTitle", "seniority", "mustHaveSkills", "niceToHaveSkills",
            "domains", "atsKeywords", "toneSignals", "responsibilitiesText",
            "qualificationsText",
        ] {
            assert!(profile.get(key).is_some(), "missing canonical field {key}");
        }
        // The response says how the profile was derived rather than implying a
        // model read the JD.
        assert_eq!(val["source"], "deterministic");

        // 2. Gap analysis
        let req_gap = JsonRpcRequest::new(
            Some(json!("req-2")),
            "tools/call",
            Some(json!({
                "name": "resume_gap_analysis",
                "arguments": {
                    "jd_text": jd_text,
                    "persona_id": "ai"
                }
            })),
        );

        let res_gap = server.handle_request(None, req_gap).await;
        assert!(res_gap.error.is_none());
        let gap_val = res_gap.result.expect("gap result");

        // Coverage is measured against the seeded block, not asserted.
        assert_eq!(gap_val["blocksInKnowledgebase"], 1);
        let covered: Vec<String> = gap_val["mustHave"]["covered"]
            .as_array()
            .expect("covered list")
            .iter()
            .map(|e| e["skill"].as_str().unwrap_or_default().to_string())
            .collect();
        assert!(covered.contains(&"rust".to_string()), "covered: {covered:?}");

        // Every covered skill names the block that evidences it, so a coverage
        // claim can be checked rather than taken on faith.
        for entry in gap_val["mustHave"]["covered"].as_array().expect("covered") {
            let ids = entry["evidenceBlockIds"].as_array().expect("evidence ids");
            assert!(
                !ids.is_empty(),
                "skill {:?} was reported covered with no evidence",
                entry["skill"]
            );
            assert_eq!(ids[0], "fixture-block");
        }

        let pct = gap_val["coveragePercentage"].as_f64().expect("coverage %");
        assert!((0.0..=100.0).contains(&pct), "coverage {pct} out of range");
        // The fixture cannot cover a skill it does not have.
        let missing = gap_val["mustHave"]["missing"].as_array().expect("missing");
        assert!(
            missing.iter().all(|m| m != "rust"),
            "a covered skill must not also be missing"
        );
    }

    /// An empty knowledgebase must report unknown coverage, never 100%.
    #[tokio::test]
    async fn gap_analysis_on_an_empty_kb_reports_zero_not_success() {
        let db = CareerDbState::open_in_memory().expect("db");
        let server = StatelessMcpServer::new(db);
        let req = JsonRpcRequest::new(
            Some(json!("req-empty")),
            "tools/call",
            Some(json!({
                "name": "resume_gap_analysis",
                "arguments": { "jd_text": "Requirements\n- 5 years of Rust\n- Kubernetes in production\n" }
            })),
        );
        let res = server.handle_request(None, req).await;
        assert!(res.error.is_none());
        let val = res.result.expect("result");
        assert_eq!(val["blocksInKnowledgebase"], 0);
        assert_eq!(val["coveragePercentage"], 0.0);
        assert!(
            val["mustHave"]["covered"].as_array().expect("covered").is_empty(),
            "an empty KB cannot cover anything"
        );
        let warnings = val["warnings"].as_array().expect("warnings");
        assert!(
            warnings.iter().any(|w| w.as_str().unwrap_or("").contains("no supporting evidence")),
            "missing skills must be surfaced as a warning: {warnings:?}"
        );
    }

    /// The gate that makes agent-driven rewriting safe.
    #[tokio::test]
    async fn verify_rewrite_rejects_an_inflated_metric() {
        let server = setup_test_server();
        let req = JsonRpcRequest::new(
            Some(json!("req-verify")),
            "tools/call",
            Some(json!({
                "name": "resume_verify_rewrite",
                "arguments": {
                    "bullets": [
                        // Inflates 40% → 90%.
                        { "bullet_id": "fixture-bullet", "text": "Built a Rust and TypeScript app on SQLite, cutting cold start by 90%" },
                        { "bullet_id": "no-such-bullet", "text": "Anything at all" }
                    ]
                }
            })),
        );
        let res = server.handle_request(None, req).await;
        assert!(res.error.is_none());
        let val = res.result.expect("result");
        assert_eq!(val["accepted"], 0);
        assert_eq!(val["rejected"], 2);
        assert_eq!(val["unknownBullets"], 1);

        let results = val["results"].as_array().expect("results");
        let inflated = &results[0];
        assert_eq!(inflated["accepted"], false);
        assert_eq!(inflated["reason"], "metrics-lost");
        assert_eq!(inflated["droppedMetrics"][0], "40%");
        // A rejection returns the user's verified text, not the model's.
        assert_eq!(inflated["text"], inflated["canonical"]);

        // An id that is not in the knowledgebase has no canonical text to
        // verify against, so it must never be accepted.
        assert_eq!(results[1]["reason"], "unknown-bullet");
    }

    #[tokio::test]
    async fn verify_rewrite_accepts_a_faithful_rewrite() {
        let server = setup_test_server();
        let req = JsonRpcRequest::new(
            Some(json!("req-verify-ok")),
            "tools/call",
            Some(json!({
                "name": "resume_verify_rewrite",
                "arguments": {
                    "bullets": [{
                        "bullet_id": "fixture-bullet",
                        "text": "Shipped a SQLite-backed Rust/TypeScript desktop app, cutting cold start 40 percent"
                    }]
                }
            })),
        );
        let res = server.handle_request(None, req).await;
        let val = res.result.expect("result");
        assert_eq!(val["accepted"], 1, "results: {:?}", val["results"]);
        assert_eq!(val["results"][0]["accepted"], true);
    }

    /// End-to-end: the pipeline must produce a real compiled document and a
    /// match report whose numbers are measured.
    #[tokio::test]
    async fn synthesize_produces_a_compiled_pdf_and_an_honest_report() {
        let server = setup_test_server();
        let req = JsonRpcRequest::new(
            Some(json!("req-synth")),
            "tools/call",
            Some(json!({
                "name": "resume_synthesize",
                "arguments": {
                    "jd_text": "Senior Rust Engineer\n\nRequirements\n- Rust and TypeScript\n- SQLite\n",
                    "header": { "name": "Ada Lovelace", "email": "ada@example.com" },
                    "include_pdf": true
                }
            })),
        );
        let res = server.handle_request(None, req).await;
        assert!(res.error.is_none(), "error: {:?}", res.error);
        let val = res.result.expect("result");

        assert_eq!(val["compile"]["success"], true, "errors: {:?}", val["compile"]["errors"]);
        assert_eq!(val["compile"]["pageCount"], 1);
        assert!(val["compile"]["byteLength"].as_u64().unwrap_or(0) > 1000);
        let pdf = val["pdfBase64"].as_str().expect("pdf bytes requested");
        assert!(pdf.starts_with("JVBER"), "base64 of %PDF- header");

        // Deterministic mode rewrites nothing, and must say so rather than
        // claiming AI authorship.
        let report = &val["matchReport"];
        assert_eq!(report["aiRewrittenCount"], 0);
        assert_eq!(report["totalBullets"], 1);
        assert_eq!(report["canonicalFallbackCount"], 1);
        assert_eq!(val["source"], "deterministic");
        assert_eq!(val["externalTokenCost"], "none");

        // Coverage is derived from selection, and the source is real Typst.
        assert!(report["coveragePercentage"].as_f64().unwrap_or(-1.0) >= 0.0);
        let src = val["typstSource"].as_str().expect("typst source");
        assert!(src.contains("#let rich("), "must use the code-mode helper");
        assert!(src.contains("Ada Lovelace"));
    }

    /// Résumé text must never reach Typst code mode.
    #[tokio::test]
    async fn synthesize_neutralizes_typst_injection_in_stored_text() {
        let db = CareerDbState::open_in_memory().expect("db");
        let mut block = fixture_block();
        block.bullets[0].canonical = "#set page(width: 100000pt) and #read(\"/etc/passwd\")".to_string();
        block.bullets[0].metrics.clear();
        block.title = "#read(\"/etc/hosts\")".to_string();
        db.with_conn(|conn| crate::career_db::upsert_block_blocking(conn, &block))
            .expect("seed");
        let server = StatelessMcpServer::new(db);

        let req = JsonRpcRequest::new(
            Some(json!("req-inject")),
            "tools/call",
            Some(json!({
                "name": "resume_synthesize",
                "arguments": { "jd_text": "Requirements\n- Rust\n" }
            })),
        );
        let res = server.handle_request(None, req).await;
        let val = res.result.expect("result");
        assert_eq!(
            val["compile"]["success"], true,
            "payload must render as text, not break the compile: {:?}",
            val["compile"]["errors"]
        );
        assert_eq!(val["compile"]["pageCount"], 1, "page geometry must be unchanged");
    }

    #[tokio::test]
    async fn test_mrtr_stateless_elicitation_on_block_delete() {
        let server = setup_test_server();

        // 1. Create a block with bullets
        let block_id = format!("test-block-{}", uuid::Uuid::new_v4());
        let test_block = ExperienceBlock {
            id: block_id.clone(),
            kind: "work".to_string(),
            title: "Staff Systems Engineer".to_string(),
            org: "Cloud Corp".to_string(),
            date_range: DateRange {
                start: "2022".to_string(),
                end: Some("2024".to_string()),
            },
            personas: vec!["ai".to_string()],
            domains: vec!["cloud".to_string()],
            skills: vec![SkillTag {
                name: "Rust".to_string(),
                level: 5,
                years: Some(4.0),
            }],
            seniority_level: "staff".to_string(),
            location: Some("San Francisco, CA".to_string()),
            url: None,
            url_label: None,
            extra: None,
            bullets: vec![Bullet {
                id: "b1".to_string(),
                canonical: "Engineered distributed stream parser improving throughput by 40%".to_string(),
                variants: serde_json::Map::new(),
                metrics: Vec::new(),
                evidence_refs: Vec::new(),
                locked: false,
            }],
            facts: Vec::new(),
            notes: Some("Key accomplishment".to_string()),
            embedding_text: None,
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };

        let req_upsert = JsonRpcRequest::new(
            Some(json!("up-1")),
            "tools/call",
            Some(json!({
                "name": "career_upsert_block",
                "arguments": {
                    "block": test_block
                }
            })),
        );
        let res_upsert = server.handle_request(None, req_upsert).await;
        assert!(res_upsert.error.is_none());

        // 2. Try deleting the block -> Server should return InputRequiredResult (MRTR)
        let req_del = JsonRpcRequest::new(
            Some(json!("del-1")),
            "tools/call",
            Some(json!({
                "name": "career_delete_block",
                "arguments": {
                    "block_id": block_id
                }
            })),
        );

        let res_del = server.handle_request(None, req_del).await;
        assert!(res_del.error.is_none());
        let del_val = res_del.result.expect("mrtr result");
        assert_eq!(del_val["resultType"], "inputRequired");
        let request_state = del_val["requestState"].as_str().expect("requestState string");
        assert!(!request_state.is_empty());

        // 3. Confirm deletion in second roundtrip with requestState
        let req_confirm = JsonRpcRequest::new(
            Some(json!("del-2")),
            "tools/call",
            Some(json!({
                "name": "career_delete_block",
                "arguments": {
                    "block_id": block_id,
                    "input_responses": {
                        "confirm": true
                    },
                    "request_state": request_state
                }
            })),
        );

        let res_confirm = server.handle_request(None, req_confirm).await;
        assert!(res_confirm.error.is_none());
        let confirm_val = res_confirm.result.expect("confirm result");
        assert_eq!(confirm_val["success"], true);
        assert_eq!(confirm_val["deletedBlockId"], block_id);
    }

    #[tokio::test]
    async fn test_tasks_extension_async_synthesis() {
        let server = setup_test_server();

        // 1. Kick off async synthesis
        let req = JsonRpcRequest::new(
            Some(json!("synth-1")),
            "tools/call",
            Some(json!({
                "name": "resume_synthesize",
                "arguments": {
                    "jd_text": "Senior Rust AI Engineer needed for agent scaling infrastructure",
                    "persona_id": "ai",
                    "template_id": "modern-cv",
                    "async": true
                }
            })),
        );

        let res = server.handle_request(None, req).await;
        assert!(res.error.is_none());
        let val = res.result.expect("task response");
        let task_id = val["taskId"].as_str().expect("taskId string");
        assert_eq!(val["status"], "working");

        // 2. Poll tasks/get until complete
        let mut completed = false;
        for _ in 0..20 {
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            let req_poll = JsonRpcRequest::new(
                Some(json!("poll-1")),
                "tasks/get",
                Some(json!({
                    "taskId": task_id
                })),
            );

            let res_poll = server.handle_request(None, req_poll).await;
            assert!(res_poll.error.is_none());
            let poll_val = res_poll.result.expect("poll result");
            let task = &poll_val["task"];
            if task["status"] == "completed" {
                completed = true;
                assert_eq!(task["progress"], 1.0);
                assert!(task["result"].is_object());
                break;
            }
        }
        assert!(completed, "Task should complete within timeout");
    }

    #[tokio::test]
    async fn test_resume_compile_typst_engine() {
        let server = setup_test_server();

        let typst_code = r#"
#set page(paper: "a4", margin: 1.5cm)
#set text(font: "New Computer Modern", size: 11pt)

= Test Candidate
DevPrism Engineer

== Experience
- Built high performance Stateless MCP 2.0 servers in Rust
- Integrated full 7-stage resume synthesis pipeline
"#;

        let req = JsonRpcRequest::new(
            Some(json!("compile-1")),
            "tools/call",
            Some(json!({
                "name": "resume_compile",
                "arguments": {
                    "typst_source": typst_code
                }
            })),
        );

        let res = server.handle_request(None, req).await;
        assert!(res.error.is_none());
        let val = res.result.expect("compile result");
        assert_eq!(val["engine"], "typst");
        assert_eq!(val["success"], true);
        assert!(val["pdfBase64"].is_string());
        assert!(val["byteLength"].as_u64().unwrap_or(0) > 1000);
    }

    // --- Live local-model tests ------------------------------------------
    //
    // These need a running Ollama with the named model, so they are #[ignore]d
    // and excluded from the default run. Exercise them with:
    //   cargo test --lib -- --ignored --nocapture live_ollama
    //
    // Env overrides: DEVPRISM_TEST_OLLAMA_MODEL, DEVPRISM_TEST_OLLAMA_URL.

    fn live_model() -> String {
        std::env::var("DEVPRISM_TEST_OLLAMA_MODEL")
            .unwrap_or_else(|_| "qwen3.8:27b-mlx".to_string())
    }

    fn live_language() -> serde_json::Value {
        json!({
            "mode": "ollama",
            "model": live_model(),
            "baseUrl": std::env::var("DEVPRISM_TEST_OLLAMA_URL")
                .unwrap_or_else(|_| "http://localhost:11434".to_string()),
            // Ollama defaults /api/chat to ~2048 tokens, which silently
            // truncates a real job description.
            "numCtx": 16384
        })
    }

    #[tokio::test]
    #[ignore = "requires a running Ollama with a chat model"]
    async fn live_ollama_analyzes_a_jd_into_the_canonical_shape() {
        let server = setup_test_server();
        let jd = "Staff Machine Learning Engineer\n\n                  About the role\n                  Own the inference stack for large language models in production.\n\n                  Requirements\n                  - 8+ years building production systems in Python\n                  - Deep PyTorch experience, including custom CUDA kernels\n                  - Kubernetes at scale\n\n                  Preferred\n                  - Rust\n                  - Experience with quantization and model distillation\n";

        let req = JsonRpcRequest::new(
            Some(json!("live-1")),
            "tools/call",
            Some(json!({
                "name": "resume_analyze_jd",
                "arguments": { "jd_text": jd, "language": live_language() }
            })),
        );
        let res = server.handle_request(None, req).await;
        assert!(res.error.is_none(), "error: {:?}", res.error);
        let val = res.result.expect("result");
        eprintln!("source: {}", val["source"]);
        eprintln!("profile: {}", serde_json::to_string_pretty(&val["profile"]).unwrap());

        let profile = &val["profile"];
        // Whatever the model returns, it is normalized into the canonical shape.
        for key in [
            "roleTitle", "seniority", "mustHaveSkills", "niceToHaveSkills",
            "domains", "atsKeywords", "toneSignals", "responsibilitiesText",
            "qualificationsText",
        ] {
            assert!(profile.get(key).is_some(), "missing canonical field {key}");
        }
        let seniority = profile["seniority"].as_str().expect("seniority");
        assert!(
            ["ic", "senior", "lead", "manager", "director"].contains(&seniority),
            "seniority must be normalized to the enum, got {seniority:?}"
        );
        assert!(
            !profile["mustHaveSkills"].as_array().expect("array").is_empty(),
            "a substantive JD must yield must-have skills"
        );
    }

    /// The point of the whole design: a local model cannot put an unverified
    /// number on the page, no matter what it generates.
    #[tokio::test]
    #[ignore = "requires a running Ollama with a chat model"]
    async fn live_ollama_synthesis_cannot_fabricate_a_figure() {
        let server = setup_test_server();
        let req = JsonRpcRequest::new(
            Some(json!("live-2")),
            "tools/call",
            Some(json!({
                "name": "resume_synthesize",
                "arguments": {
                    "jd_text": "Senior Rust Engineer\n\nRequirements\n- Rust\n- TypeScript\n- SQLite\n",
                    "header": { "name": "Ada Lovelace", "email": "ada@example.com" },
                    "language": live_language()
                }
            })),
        );
        let res = server.handle_request(None, req).await;
        assert!(res.error.is_none(), "error: {:?}", res.error);
        let val = res.result.expect("result");

        eprintln!("source: {}", val["source"]);
        eprintln!("matchReport: {}", serde_json::to_string_pretty(&val["matchReport"]).unwrap());
        eprintln!("typst:\n{}", val["typstSource"].as_str().unwrap_or(""));

        assert_eq!(val["compile"]["success"], true, "{:?}", val["compile"]["errors"]);
        assert_eq!(val["externalTokenCost"], "none", "a local model costs no external tokens");
        assert!(val["source"].as_str().unwrap_or("").starts_with("ollama:"));

        // The fixture bullet's only figure is 40%. Check the *bullet lines*
        // specifically — scanning the whole document would also pick up the
        // preamble's point sizes and the `\u{2014}` em-dash escape (which
        // contains "2014"), neither of which comes from résumé content.
        let src = val["typstSource"].as_str().expect("typst source");
        let canonical = fixture_block().bullets[0].canonical.clone();
        let metrics = fixture_block().bullets[0].metrics.clone();
        let mut checked = 0usize;
        for line in src.lines().filter(|l| l.starts_with("- #rich(")) {
            checked += 1;
            let invented =
                crate::career_match::metrics::introduced_figures(&canonical, &metrics, line);
            assert!(
                invented.is_empty(),
                "the local model put an unverifiable figure on the page: {invented:?}\n  line: {line}\n  canonical: {canonical}"
            );
        }
        assert_eq!(checked, 1, "expected exactly one rendered bullet");

        // Whatever the model wrote, the protected metric survived.
        assert!(src.contains("40%"), "the ground-truth metric must reach the page");
    }

    // ---------------------------------------------------------------------
    // Hardening regressions.
    //
    // Each names the defect it pins. Several describe behaviour that used to be
    // *possible*, so they fail loudly if the guard is ever removed.
    // ---------------------------------------------------------------------

    /// Call a tool and return the raw JSON-RPC response.
    async fn call_tool(
        server: &StatelessMcpServer,
        tool: &str,
        arguments: serde_json::Value,
    ) -> crate::mcp::protocol::JsonRpcResponse {
        let req = JsonRpcRequest::new(
            Some(json!("t")),
            "tools/call",
            Some(json!({ "name": tool, "arguments": arguments })),
        );
        server.handle_request(None, req).await
    }

    async fn block_exists(server: &StatelessMcpServer, block_id: &str) -> bool {
        let res = call_tool(server, "career_get_profile", json!({})).await;
        res.result
            .and_then(|v| v["blocks"].as_array().cloned())
            .map(|blocks| blocks.iter().any(|b| b["id"] == block_id))
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn a_forged_request_state_cannot_delete_a_block() {
        // THE BYPASS: `career_delete_block` treated the *presence* of any
        // decodable `request_state` as proof the user had answered the
        // confirmation. `e30=` is base64 for `{}` — six characters that deleted
        // an experience block and all of its embeddings with no prompt shown.
        let server = setup_test_server();

        for forged in [
            "e30=",                                             // {}
            "eyJibG9ja0lkIjoiZml4dHVyZS1ibG9jayJ9",             // {"blockId":"fixture-block"}
            "eyJfX25vbmNlIjoiZmFrZSJ9",                         // {"__nonce":"fake"}
        ] {
            let res = call_tool(
                &server,
                "career_delete_block",
                json!({
                    "block_id": "fixture-block",
                    "input_responses": { "confirm": true },
                    "request_state": forged
                }),
            )
            .await;

            assert!(
                res.error.is_some(),
                "forged requestState '{forged}' must be refused, got {:?}",
                res.result
            );
            assert!(
                block_exists(&server, "fixture-block").await,
                "the block must survive a forged confirmation ('{forged}')"
            );
        }
    }

    #[tokio::test]
    async fn a_confirmation_token_cannot_be_replayed() {
        let server = setup_test_server();

        let elicit = call_tool(
            &server,
            "career_delete_block",
            json!({ "block_id": "fixture-block" }),
        )
        .await
        .result
        .expect("elicitation");
        let state = elicit["requestState"].as_str().expect("requestState").to_string();

        // Re-seed so there is something to delete on the replay attempt.
        let confirm = json!({
            "block_id": "fixture-block",
            "input_responses": { "confirm": true },
            "request_state": state
        });
        let first = call_tool(&server, "career_delete_block", confirm.clone()).await;
        assert!(first.error.is_none(), "the genuine round trip must succeed");

        server
            .career_db
            .with_conn(|conn| crate::career_db::upsert_block_blocking(conn, &fixture_block()))
            .expect("re-seed");

        let replay = call_tool(&server, "career_delete_block", confirm).await;
        assert!(
            replay.error.is_some(),
            "a spent confirmation must not authorise a second deletion"
        );
        assert!(block_exists(&server, "fixture-block").await);
    }

    #[tokio::test]
    async fn a_confirmation_for_one_block_cannot_delete_another() {
        let server = setup_test_server();

        let mut other = fixture_block();
        other.id = "other-block".to_string();
        server
            .career_db
            .with_conn(|conn| crate::career_db::upsert_block_blocking(conn, &other))
            .expect("seed second block");

        let elicit = call_tool(
            &server,
            "career_delete_block",
            json!({ "block_id": "other-block" }),
        )
        .await
        .result
        .expect("elicitation");
        let state = elicit["requestState"].as_str().expect("requestState");

        let res = call_tool(
            &server,
            "career_delete_block",
            json!({
                "block_id": "fixture-block",
                "input_responses": { "confirm": true },
                "request_state": state
            }),
        )
        .await;

        assert!(res.error.is_some(), "a token is bound to its subject");
        assert!(block_exists(&server, "fixture-block").await);
    }

    #[tokio::test]
    async fn an_overwrite_that_discards_bullets_requires_confirmation() {
        // `career_upsert_block` is a whole-document replace with a caller-supplied
        // id, and it had no gate at all — so overwriting a block with an empty one
        // was a delete that bypassed the delete confirmation entirely.
        let server = setup_test_server();

        let mut gutted = fixture_block();
        gutted.bullets.clear();

        let res = call_tool(&server, "career_upsert_block", json!({ "block": gutted }))
            .await
            .result
            .expect("result");
        assert_eq!(
            res["resultType"], "inputRequired",
            "discarding a bullet must elicit confirmation first, got {res}"
        );

        // The stored block is untouched until the round trip completes.
        let profile = call_tool(&server, "career_get_profile", json!({}))
            .await
            .result
            .expect("profile");
        let stored = profile["blocks"]
            .as_array()
            .and_then(|b| b.iter().find(|b| b["id"] == "fixture-block"))
            .expect("fixture block still present")
            .clone();
        assert_eq!(
            stored["bullets"].as_array().map(|a| a.len()),
            Some(1),
            "the bullet must survive an unconfirmed overwrite"
        );
    }

    #[tokio::test]
    async fn a_same_size_replacement_still_requires_confirmation() {
        // The first version of this gate compared bullet *counts*, so swapping
        // every bullet for a different one of the same cardinality reported no
        // loss — destroying the originals' text, metrics, evidenceRefs and
        // locked flags with no prompt.
        let server = setup_test_server();

        let mut swapped = fixture_block();
        swapped.bullets = vec![Bullet {
            id: "totally-different-bullet".to_string(),
            canonical: "Unrelated claim".to_string(),
            variants: serde_json::Map::new(),
            metrics: Vec::new(),
            evidence_refs: Vec::new(),
            locked: false,
        }];

        let res = call_tool(&server, "career_upsert_block", json!({ "block": swapped }))
            .await
            .result
            .expect("result");
        assert_eq!(
            res["resultType"], "inputRequired",
            "replacing a bullet with a different one is a loss, got {res}"
        );
    }

    #[tokio::test]
    async fn a_locked_bullet_cannot_be_rewritten_without_confirmation() {
        // `locked` means "do not rewrite this". A same-id payload that changes a
        // locked bullet's text — or silently drops the flag, which is
        // `#[serde(default)]` — must not pass unchallenged.
        let server = setup_test_server();

        let mut locked = fixture_block();
        locked.bullets[0].locked = true;
        server
            .career_db
            .with_conn(|conn| crate::career_db::upsert_block_blocking(conn, &locked))
            .expect("seed locked bullet");

        let mut rewritten = locked.clone();
        rewritten.bullets[0].canonical = "Rewritten by an agent".to_string();

        let res = call_tool(&server, "career_upsert_block", json!({ "block": rewritten }))
            .await
            .result
            .expect("result");
        assert_eq!(res["resultType"], "inputRequired", "got {res}");

        // Dropping the flag alone also counts.
        let mut unlocked = locked.clone();
        unlocked.bullets[0].locked = false;
        let res = call_tool(&server, "career_upsert_block", json!({ "block": unlocked }))
            .await
            .result
            .expect("result");
        assert_eq!(
            res["resultType"], "inputRequired",
            "silently clearing `locked` is itself the loss, got {res}"
        );
    }

    #[tokio::test]
    async fn a_confirmation_cannot_be_redeemed_against_a_different_payload() {
        // The confirmation must approve a *change*, not a block id. Bound to the
        // id alone, a token issued for "drop one bullet" — which is what the
        // human saw and approved — could be redeemed on a second call carrying
        // an empty block, gutting everything.
        let server = setup_test_server();

        let mut big = fixture_block();
        for i in 0..5 {
            big.bullets.push(Bullet {
                id: format!("extra-{i}"),
                canonical: format!("Accomplishment {i}"),
                variants: serde_json::Map::new(),
                metrics: Vec::new(),
                evidence_refs: Vec::new(),
                locked: false,
            });
        }
        server
            .career_db
            .with_conn(|conn| crate::career_db::upsert_block_blocking(conn, &big))
            .expect("seed six bullets");

        // Approve dropping exactly one.
        let mut drop_one = big.clone();
        drop_one.bullets.pop();
        let elicit = call_tool(&server, "career_upsert_block", json!({ "block": drop_one }))
            .await
            .result
            .expect("elicitation");
        let state = elicit["requestState"].as_str().expect("requestState");

        // Redeem it against a payload that guts the block instead.
        let mut gutted = big.clone();
        gutted.bullets.clear();
        let res = call_tool(
            &server,
            "career_upsert_block",
            json!({
                "block": gutted,
                "input_responses": { "confirm": true },
                "request_state": state
            }),
        )
        .await;
        assert!(
            res.error.is_some(),
            "a token must not authorise a payload the user never saw"
        );

        let profile = call_tool(&server, "career_get_profile", json!({}))
            .await
            .result
            .expect("profile");
        let stored = profile["blocks"]
            .as_array()
            .and_then(|b| b.iter().find(|b| b["id"] == "fixture-block"))
            .expect("block present")
            .clone();
        assert_eq!(
            stored["bullets"].as_array().map(|a| a.len()),
            Some(6),
            "the block must be untouched after the swapped-payload attempt"
        );
    }

    #[tokio::test]
    async fn an_overwrite_that_only_adds_content_needs_no_confirmation() {
        // The gate must not turn ordinary edits into two-step flows.
        let server = setup_test_server();

        let mut grown = fixture_block();
        grown.bullets.push(Bullet {
            id: "second-bullet".to_string(),
            canonical: "Added a second accomplishment".to_string(),
            variants: serde_json::Map::new(),
            metrics: Vec::new(),
            evidence_refs: Vec::new(),
            locked: false,
        });

        let res = call_tool(&server, "career_upsert_block", json!({ "block": grown }))
            .await
            .result
            .expect("result");
        assert_eq!(res["success"], true, "a pure addition must apply directly");
        assert_eq!(res["created"], false);
    }

    #[tokio::test]
    async fn search_filters_are_applied_rather_than_silently_dropped() {
        // `persona_id` / `domain` / `owner_kinds` were collected into a
        // `SearchFilter` bound to `_filter` and never read, so every scoped
        // search silently returned unscoped results.
        let server = setup_test_server();

        let matching = call_tool(
            &server,
            "career_search_kb",
            json!({ "query": "Rust", "persona_id": "ai" }),
        )
        .await
        .result
        .expect("result");
        assert!(
            !matching["hits"].as_array().expect("hits").is_empty(),
            "the fixture block carries persona 'ai' and must still match"
        );

        let excluded = call_tool(
            &server,
            "career_search_kb",
            json!({ "query": "Rust", "persona_id": "no-such-persona" }),
        )
        .await
        .result
        .expect("result");
        assert!(
            excluded["hits"].as_array().expect("hits").is_empty(),
            "a persona filter that matches nothing must return nothing, got {}",
            excluded["hits"]
        );

        let wrong_domain = call_tool(
            &server,
            "career_search_kb",
            json!({ "query": "Rust", "domain": "aerospace" }),
        )
        .await
        .result
        .expect("result");
        assert!(
            wrong_domain["hits"].as_array().expect("hits").is_empty(),
            "a domain filter must exclude non-matching blocks"
        );
    }

    #[tokio::test]
    async fn search_scores_are_computed_rather_than_constant() {
        // Chunk hits were hardcoded `0.85` and block scores saturated at exactly
        // 1.0 after any two matches, so ranking carried no information.
        let server = setup_test_server();

        let mut weak = fixture_block();
        weak.id = "weak-block".to_string();
        weak.title = "Rust Engineer".to_string();
        weak.bullets.clear();
        weak.skills.clear();
        server
            .career_db
            .with_conn(|conn| crate::career_db::upsert_block_blocking(conn, &weak))
            .expect("seed weak block");

        let res = call_tool(&server, "career_search_kb", json!({ "query": "Rust" }))
            .await
            .result
            .expect("result");
        assert_eq!(res["searchMode"], "keyword-substring");

        let hits = res["hits"].as_array().expect("hits").clone();
        let score_of = |id: &str| -> f64 {
            hits.iter()
                .find(|h| h["ownerId"] == id)
                .and_then(|h| h["score"].as_f64())
                .unwrap_or(-1.0)
        };

        let strong = score_of("fixture-block");
        let faint = score_of("weak-block");
        assert!(strong > 0.0 && faint > 0.0, "both blocks should match 'Rust'");
        assert!(
            strong > faint,
            "a block matching in header+bullet must outrank a header-only match ({strong} vs {faint})"
        );
        assert!(
            strong < 1.0,
            "scores must stay below 1.0 so they remain comparable, got {strong}"
        );
    }

    #[tokio::test]
    async fn a_wrong_typed_filter_errors_instead_of_returning_everything() {
        // `.and_then(|v| v.as_str())` collapsed "absent" and "wrong type" into
        // the same `None`, so `{"persona_id": 123}` read as *no filter* and
        // returned the entire unscoped profile.
        let server = setup_test_server();

        for tool in ["career_search_kb", "career_get_profile"] {
            let mut args = json!({ "persona_id": 123 });
            if tool == "career_search_kb" {
                args["query"] = json!("Rust");
            }
            let res = call_tool(&server, tool, args).await;
            assert!(
                res.error.is_some(),
                "{tool} must reject a non-string persona_id rather than ignoring it"
            );
        }
    }

    #[tokio::test]
    async fn oversized_inputs_are_refused() {
        let server = setup_test_server();

        let huge = "x".repeat(2 * 1024 * 1024);
        let res = call_tool(
            &server,
            "career_ingest_knowledge",
            json!({ "title": "big", "text": huge }),
        )
        .await;
        assert!(res.error.is_some(), "a 2 MiB ingest must be refused");

        let long_query = "q".repeat(5_000);
        let res = call_tool(&server, "career_search_kb", json!({ "query": long_query })).await;
        assert!(res.error.is_some(), "an over-long query must be refused");
    }

    #[tokio::test]
    async fn a_search_limit_cannot_be_used_to_demand_an_unbounded_response() {
        let server = setup_test_server();
        let res = call_tool(
            &server,
            "career_search_kb",
            json!({ "query": "Rust", "limit": 100_000_000_u64 }),
        )
        .await;
        assert!(res.error.is_none(), "a large limit is clamped, not rejected");
    }

    #[tokio::test]
    async fn ingest_cannot_overwrite_a_source_it_did_not_create() {
        // `uri` is the dedup key: naming an existing source deletes its chunks
        // and embeddings and rewrites its title, with no confirmation. Source
        // uris are readable from `career://kb/sources`.
        let server = setup_test_server();

        let res = call_tool(
            &server,
            "career_ingest_knowledge",
            json!({
                "title": "hijacked",
                "text": "replacement",
                "uri": "file:///Users/someone/resume.pdf"
            }),
        )
        .await;
        assert!(
            res.error.is_some(),
            "a tool call must not address a source ingested outside MCP"
        );

        // Omitting `uri` still works and creates its own namespaced source.
        let ok = call_tool(
            &server,
            "career_ingest_knowledge",
            json!({ "title": "notes", "text": "some paragraph" }),
        )
        .await;
        assert!(ok.error.is_none(), "a plain ingest must still succeed: {:?}", ok.error);
    }

    #[tokio::test]
    async fn a_built_in_persona_cannot_be_redefined_over_mcp() {
        // `career_delete_persona` refuses to remove a seeded persona; upsert had
        // no such guard, so a tool call could replace `ai` wholesale instead.
        let server = setup_test_server();

        let res = call_tool(
            &server,
            "career_upsert_persona",
            json!({
                "persona": {
                    "id": "ai",
                    "label": "Hijacked",
                    "skillWeights": {},
                    "defaultTemplateId": "typst-ats-single-column",
                    "sectionOrder": ["experience"],
                    "toneDirective": ""
                }
            }),
        )
        .await;
        assert!(res.error.is_some(), "built-in personas are not remotely redefinable");
    }

    #[tokio::test]
    async fn every_advertised_tool_is_dispatchable() {
        // The tool list and the `career_`/`resume_` prefix dispatch can drift: a
        // tool could be advertised and then answered with "method not found".
        let server = setup_test_server();

        for tool in server.list_all_tools() {
            let res = call_tool(&server, &tool.name, json!({})).await;
            if let Some(err) = res.error {
                assert_ne!(
                    err.code,
                    crate::mcp::protocol::ERR_METHOD_NOT_FOUND,
                    "advertised tool '{}' is not dispatchable",
                    tool.name
                );
            }
        }
    }

    #[tokio::test]
    async fn an_unsupported_protocol_version_header_is_rejected() {
        // The header was parsed into `HttpHeaders` and then never checked,
        // despite the module advertising SEP-2243 validation.
        let server = setup_test_server();
        let headers = HttpHeaders::from_map(&HashMap::from([(
            "mcp-protocol-version".to_string(),
            "1999-01-01".to_string(),
        )]));
        let req = JsonRpcRequest::new(Some(json!(1)), "tools/list", None);
        let res = server.handle_request(Some(&headers), req).await;

        let err = res.error.expect("version mismatch must be reported");
        assert_eq!(err.code, ERR_HEADER_MISMATCH);

        // The supported version still passes.
        let ok_headers = HttpHeaders::from_map(&HashMap::from([(
            "mcp-protocol-version".to_string(),
            MCP_PROTOCOL_VERSION.to_string(),
        )]));
        let req = JsonRpcRequest::new(Some(json!(2)), "tools/list", None);
        assert!(server
            .handle_request(Some(&ok_headers), req)
            .await
            .error
            .is_none());
    }

    #[tokio::test]
    async fn notification_methods_are_accepted_rather_than_refused() {
        // Answering `notifications/initialized` with -32601 is fatal to strict
        // clients. Transports drop the response; the dispatcher must not error.
        let server = setup_test_server();
        let req = JsonRpcRequest::new(None, "notifications/initialized", Some(json!({})));
        let res = server.handle_request(None, req).await;
        assert!(res.error.is_none(), "notifications must not be refused");
    }

    #[tokio::test]
    async fn a_hostile_tool_call_cannot_panic_the_dispatcher() {
        // Every advertised tool, hit with argument shapes chosen to break naive
        // `as_str().unwrap()` / indexing / cast code. Any panic fails the test.
        let server = setup_test_server();

        let hostile = [
            json!({}),
            json!({ "query": null, "block_id": null, "text": null, "title": null }),
            json!({ "query": [], "limit": -1, "persona_id": {}, "block": [] }),
            json!({ "query": "\u{0}\u{feff}\u{202e}עברית", "limit": 1.5 }),
            json!({ "query": "%_\\", "facts": "not-an-array" }),
            json!({ "block_id": "\u{1f600}", "request_state": "!!!not-base64!!!" }),
            json!({ "block_id": "x", "request_state": "e30=", "input_responses": [] }),
            json!({ "query": "a", "owner_kinds": [1, 2, 3] }),
            json!({ "text": "", "title": "", "uri": "" }),
        ];

        for tool in server.list_all_tools() {
            for args in &hostile {
                // The assertion is simply that this returns: a panic in the
                // dispatch path would abort the test process.
                let _ = call_tool(&server, &tool.name, args.clone()).await;
            }
        }
    }
}
