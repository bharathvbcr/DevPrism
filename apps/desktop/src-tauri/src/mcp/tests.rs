#[cfg(test)]
mod tests {
    use crate::career_db::{Bullet, CareerDbState, DateRange, ExperienceBlock, SkillTag};
    use crate::mcp::protocol::{
        HttpHeaders, JsonRpcRequest, JsonRpcResponse, MCP_PROTOCOL_VERSION, ERR_HEADER_MISMATCH,
    };
    use crate::mcp::server::StatelessMcpServer;
    use serde_json::{json, Value};
    use std::collections::HashMap;

    /// An isolated, in-memory career DB.
    ///
    /// This used to be `CareerDbState::default()`, which opens the user's real
    /// `~/Library/Application Support/DevPrism/career.db`. Every test here was
    /// therefore reading (and `resume_synthesize` writing) production career
    /// data, and tests could interfere with each other through it.
    fn setup_test_server() -> StatelessMcpServer {
        let db = CareerDbState::open_in_memory().expect("in-memory career db");
        StatelessMcpServer::new(db)
    }

    /// A server seeded with two blocks that exercise every evidence source:
    /// skill tags, domains, bullet text, and the fact pool.
    fn seeded_server() -> StatelessMcpServer {
        let db = CareerDbState::open_in_memory().expect("in-memory career db");
        db.with_conn(|conn| {
            for b in [rust_block(), mongo_block()] {
                crate::career_db::upsert_block_blocking(conn, &b)?;
            }
            Ok(())
        })
        .expect("seed blocks");
        StatelessMcpServer::new(db)
    }

    fn mk_block(
        id: &str,
        org: &str,
        skills: &[&str],
        bullets: &[(&str, &str, &[&str])],
    ) -> ExperienceBlock {
        ExperienceBlock {
            id: id.to_string(),
            kind: "experience".into(),
            title: "Engineer".into(),
            org: org.to_string(),
            date_range: DateRange { start: "2024-01".into(), end: None },
            personas: vec!["ai".into()],
            domains: vec![],
            skills: skills
                .iter()
                .map(|s| SkillTag { name: (*s).to_string(), level: 4, years: None })
                .collect(),
            seniority_level: "senior".into(),
            location: None,
            url: None,
            url_label: None,
            extra: None,
            bullets: bullets
                .iter()
                .map(|(bid, text, metrics)| Bullet {
                    id: (*bid).to_string(),
                    canonical: (*text).to_string(),
                    variants: serde_json::Map::new(),
                    metrics: metrics
                        .iter()
                        .map(|m| crate::career_db::BulletMetric {
                            value: (*m).to_string(),
                            kind: "scalar".into(),
                        })
                        .collect(),
                    evidence_refs: vec![],
                    locked: false,
                })
                .collect(),
            facts: vec![],
            notes: None,
            embedding_text: None,
            updated_at: "0".into(),
        }
    }

    fn rust_block() -> ExperienceBlock {
        mk_block(
            "blk-rust",
            "Acme",
            &["Rust", "Kubernetes"],
            &[("bul-1", "Cut p99 latency by 25% across the Rust ingest path", &["25%"][..])],
        )
    }

    fn mongo_block() -> ExperienceBlock {
        mk_block("blk-mongo", "Globex", &["MongoDB"], &[("bul-2", "Ran MongoDB clusters", &[][..])])
    }

    async fn call_tool(server: &StatelessMcpServer, name: &str, args: Value) -> JsonRpcResponse {
        let req = JsonRpcRequest::new(
            Some(json!(1)),
            "tools/call",
            Some(json!({ "name": name, "arguments": args })),
        );
        server.handle_request(None, req).await
    }

    fn ok_result(res: JsonRpcResponse) -> Value {
        assert!(res.error.is_none(), "unexpected error: {:?}", res.error);
        res.result.expect("result present")
    }

    /// MCP tool results are wrapped; dig out the tool's JSON payload.
    fn tool_payload(v: &Value) -> Value {
        if let Some(sc) = v.get("structuredContent") {
            return sc.clone();
        }
        if let Some(text) = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
        {
            if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                return parsed;
            }
        }
        v.clone()
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
        // Contract updated: the tool now emits the canonical JDProfile shape
        // (roleTitle / mustHaveSkills / niceToHaveSkills / atsKeywords, with a
        // lowercase seniority ladder) instead of the MCP-only shape whose field
        // names nothing else in the system consumed.
        let profile = &val["profile"];
        assert_eq!(profile["seniority"], "senior");
        assert!(profile.get("requiredSkills").is_none(), "stale shape returned");
        let must = profile["mustHaveSkills"].as_array().expect("mustHaveSkills");
        assert!(
            must.iter().any(|s| s == "rust" || s == "typescript"),
            "expected rust/typescript in {must:?}"
        );

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
        assert!(gap_val.get("coveragePercentage").is_some());
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
                    // "modern-cv" was a LaTeX-era id removed from the template
                    // registry; the tool now validates against the real ids.
                    "template_id": "typst-ats-single",
                    "render": false,
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

    // =================================================================
    // Regression suite for the eight engine defects.
    // Each test names the behaviour that used to ship.
    // =================================================================

    const APPLE_JD: &str = "AI/ML Evaluation Specialist, Human Data

Minimum Qualifications
* 4+ years defining human data programs for AI/ML, including annotation
  operations and quality frameworks, within an NLP or generative AI environment
* Proficiency in Python, R, SQL to process and analyze large datasets
* Expertise in end-to-end data annotation quality management

Preferred Qualifications
* Familiarity with AI Safety and Responsible AI principles
";

    /// #7: the profile used to be a 20-item keyword list emitted under field
    /// names nothing else in the system understands.
    #[tokio::test]
    async fn jd_analysis_emits_the_canonical_profile_shape() {
        let server = setup_test_server();
        let out = tool_payload(&ok_result(
            call_tool(&server, "resume_analyze_jd", json!({ "jd_text": APPLE_JD })).await,
        ));
        let p = &out["profile"];
        for key in ["roleTitle", "seniority", "mustHaveSkills", "niceToHaveSkills",
                    "domains", "atsKeywords", "toneSignals", "extractionMethod"] {
            assert!(!p[key].is_null(), "missing {key} in {p}");
        }
        for stale in ["requiredSkills", "preferredSkills", "cultureKeywords", "company"] {
            assert!(p.get(stale).is_none(), "stale field {stale} still emitted");
        }
        let empty: Vec<Value> = Vec::new();
        let must: Vec<&str> = p["mustHaveSkills"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        for expected in ["python", "r", "sql", "annotation"] {
            assert!(must.contains(&expected), "must-have {expected} missing from {must:?}");
        }
        assert_eq!(p["extractionMethod"], "heuristic");
    }

    /// #8: coverage used to look only at block.skills with substring matching.
    #[tokio::test]
    async fn gap_analysis_uses_all_evidence_sources_and_word_boundaries() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_gap_analysis",
                json!({ "jd_text": "Minimum Qualifications\n* Kubernetes and Go required\n" }),
            )
            .await,
        ));
        let items = out["mustHave"]["items"].as_array().cloned().unwrap_or_default();
        let by = |name: &str| -> String {
            items
                .iter()
                .find(|i| i["skill"] == name)
                .map(|i| i["status"].as_str().unwrap_or("").to_string())
                .unwrap_or_default()
        };
        // Kubernetes is a skill tag on the Rust block.
        assert_eq!(by("kubernetes"), "covered");
        // "go" must NOT be satisfied by "MongoDB".
        assert_ne!(by("go"), "covered", "substring collision resurfaced: {items:?}");
        assert!(out["coveragePercentage"].as_u64().is_some());
    }

    #[tokio::test]
    async fn gap_analysis_on_empty_kb_says_the_kb_is_empty() {
        let server = setup_test_server();
        let out = tool_payload(&ok_result(
            call_tool(&server, "resume_gap_analysis", json!({ "jd_text": APPLE_JD })).await,
        ));
        assert_eq!(out["coveragePercentage"], 0);
        let warnings = out["warnings"].as_array().cloned().unwrap_or_default();
        assert!(
            warnings.iter().any(|w| w.as_str().unwrap_or("").contains("knowledgebase is empty")),
            "empty KB not disclosed: {warnings:?}"
        );
    }

    /// #6: selection advertised knapsack + MMR but was a greedy first-fit with
    /// a one-line-per-bullet cost model.
    #[tokio::test]
    async fn selection_reports_a_real_line_budget_and_respects_it() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_score_and_select",
                json!({ "jd_text": APPLE_JD, "page_budget": 1 }),
            )
            .await,
        ));
        let est = out["estimatedTotalLines"].as_u64().unwrap_or(u64::MAX);
        let budget = out["lineBudget"].as_u64().unwrap_or(0);
        assert!(est <= budget, "over budget {est} > {budget}");
        assert_eq!(out["charsPerLine"], 95);
        assert!(out["selectedBlocks"].as_array().is_some_and(|a| !a.is_empty()));
        // Scores must not all be pinned at the old 1.0 ceiling.
        for b in out["selectedBlocks"].as_array().cloned().unwrap_or_default() {
            let s = b["score"].as_f64().unwrap_or(-1.0);
            assert!((0.0..=1.0).contains(&s), "score out of range: {s}");
            assert!(b["scoreComponents"].is_object());
        }
    }

    #[tokio::test]
    async fn selection_rejects_an_out_of_range_page_budget() {
        let server = seeded_server();
        let res = call_tool(
            &server,
            "resume_score_and_select",
            json!({ "jd_text": APPLE_JD, "page_budget": 99 }),
        )
        .await;
        assert!(res.error.is_some(), "page_budget 99 was accepted");
    }

    /// #1: this returned provenanceVerified:true without verifying anything.
    #[tokio::test]
    async fn rewrite_without_drafts_does_not_claim_verification() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_rewrite_bullets",
                json!({ "block_id": "blk-rust", "jd_text": APPLE_JD }),
            )
            .await,
        ));
        let bullets = out["bullets"].as_array().cloned().unwrap_or_default();
        assert!(!bullets.is_empty());
        for b in &bullets {
            assert_eq!(b["status"], "canonical_only");
            assert_eq!(b["provenanceVerified"], false, "claimed verification with no draft");
        }
        assert_eq!(out["rewriteMode"], "verify_only_no_drafts_supplied");
    }

    /// #1 (positive path): a faithful draft is accepted.
    #[tokio::test]
    async fn rewrite_accepts_a_draft_that_preserves_every_metric() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_rewrite_bullets",
                json!({
                    "block_id": "blk-rust",
                    "jd_text": APPLE_JD,
                    "drafts": [{ "bulletId": "bul-1", "text": "Reduced p99 latency 25 percent on the Rust ingest path" }]
                }),
            )
            .await,
        ));
        let b = &out["bullets"][0];
        assert_eq!(b["status"], "verified");
        assert_eq!(b["provenanceVerified"], true);
        assert!(b["droppedMetrics"].as_array().is_some_and(|a| a.is_empty()));
        assert_eq!(out["verifiedCount"], 1);
    }

    /// #1 (the property that matters): a draft that drops a metric is rejected
    /// and the canonical text is substituted.
    #[tokio::test]
    async fn rewrite_rejects_a_draft_that_loses_a_metric() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_rewrite_bullets",
                json!({
                    "block_id": "blk-rust",
                    "jd_text": APPLE_JD,
                    "drafts": [{ "bulletId": "bul-1", "text": "Massively improved latency everywhere" }]
                }),
            )
            .await,
        ));
        let b = &out["bullets"][0];
        assert_eq!(b["status"], "rejected_canonical_fallback");
        assert_eq!(b["rejectionReasons"][0], "dropped_metric");
        assert_eq!(b["provenanceVerified"], false);
        assert_eq!(b["droppedMetrics"][0], "25%");
        assert_eq!(b["accepted"], b["canonical"], "rejected draft was still accepted");
        assert_eq!(out["rejectedCount"], 1);
    }

    /// A silently *changed* number is the worst case: it looks plausible.
    #[tokio::test]
    async fn rewrite_rejects_a_draft_that_inflates_a_metric() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_rewrite_bullets",
                json!({
                    "block_id": "blk-rust",
                    "jd_text": APPLE_JD,
                    "drafts": [{ "bulletId": "bul-1", "text": "Cut p99 latency by 65% on the Rust path" }]
                }),
            )
            .await,
        ));
        assert_eq!(out["bullets"][0]["status"], "rejected_canonical_fallback");
        assert_eq!(out["bullets"][0]["droppedMetrics"][0], "25%");
        // Inflating trips both: the real metric vanished AND a new one appeared.
        let reasons = out["bullets"][0]["rejectionReasons"].to_string();
        assert!(reasons.contains("dropped_metric"), "{reasons}");
        assert!(reasons.contains("unsupported_number"), "{reasons}");
    }

    #[tokio::test]
    async fn rewrite_on_a_missing_block_errors() {
        let server = seeded_server();
        let res = call_tool(
            &server,
            "resume_rewrite_bullets",
            json!({ "block_id": "nope", "jd_text": APPLE_JD }),
        )
        .await;
        assert!(res.error.is_some());
    }

    /// #2: this appended "(impact: improved latency/efficiency by 25%)" to any
    /// bullet without a number in it.
    #[tokio::test]
    async fn finetune_never_fabricates_a_metric() {
        let server = setup_test_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_finetune_bullet",
                json!({ "bullet_text": "Worked on the data pipeline", "jd_text": APPLE_JD }),
            )
            .await,
        ));
        assert!(out["rewrite"].is_null(), "a rewrite was generated: {}", out["rewrite"]);
        let blob = out.to_string();
        assert!(!blob.contains("improved latency/efficiency by 25%"), "fabricated metric returned");
        assert_eq!(out["analysis"]["hasNumber"], false);
        // The weak opener must be detected, not asserted strong.
        assert_eq!(out["analysis"]["weakOpener"], "worked");
    }

    #[tokio::test]
    async fn finetune_checks_supplied_metrics_against_the_text() {
        let server = setup_test_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_finetune_bullet",
                json!({
                    "bullet_text": "Cut latency by 25% across the fleet",
                    "jd_text": APPLE_JD,
                    "verified_metrics": ["25%", "3x"]
                }),
            )
            .await,
        ));
        assert_eq!(out["analysis"]["suppliedMetricsPresent"], 1);
        assert_eq!(out["analysis"]["suppliedMetricsMissing"][0], "3x");
    }

    /// #5: LaTeX used to return success:true without compiling.
    #[tokio::test]
    async fn latex_compile_is_refused_not_faked() {
        let server = setup_test_server();
        let res = call_tool(
            &server,
            "resume_compile",
            json!({ "latex_source": "\\documentclass{article}\\begin{document}x\\end{document}" }),
        )
        .await;
        assert!(res.error.is_some(), "LaTeX still reports success: {:?}", res.result);
        let msg = res.error.map(|e| e.message).unwrap_or_default();
        assert!(msg.to_lowercase().contains("latex"), "unhelpful error: {msg}");
    }

    #[tokio::test]
    async fn typst_compile_still_works_and_returns_a_pdf() {
        let server = setup_test_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_compile",
                json!({ "typst_source": "#set page(paper: \"us-letter\")\nHello" }),
            )
            .await,
        ));
        assert_eq!(out["success"], true);
        assert_eq!(out["engine"], "typst");
        assert!(out["byteLength"].as_u64().unwrap_or(0) > 0);
    }

    #[tokio::test]
    async fn compile_rejects_both_sources_at_once() {
        let server = setup_test_server();
        let res = call_tool(
            &server,
            "resume_compile",
            json!({ "typst_source": "x", "latex_source": "y" }),
        )
        .await;
        assert!(res.error.is_some());
    }

    /// #4: coverage was the literal 88.0 regardless of input.
    #[tokio::test]
    async fn synthesis_coverage_is_computed_not_hardcoded() {
        // A JD whose keywords the seeded blocks genuinely cover, so the
        // comparison measures computation rather than an unrelated fixture.
        const RUST_JD: &str = "Platform Engineer

Minimum Qualifications
* Deep experience with Rust in production systems
* Operating Kubernetes clusters at scale
* Strong SQL and data pipeline background
";
        let seeded = tool_payload(&ok_result(
            call_tool(
                &seeded_server(),
                "resume_synthesize",
                json!({ "jd_text": RUST_JD, "render": false }),
            )
            .await,
        ));
        let empty = tool_payload(&ok_result(
            call_tool(
                &setup_test_server(),
                "resume_synthesize",
                json!({ "jd_text": RUST_JD, "render": false }),
            )
            .await,
        ));
        let a = seeded["matchReport"]["atsCoveragePercentage"].as_u64().unwrap_or(999);
        let b = empty["matchReport"]["atsCoveragePercentage"].as_u64().unwrap_or(999);
        assert_ne!(a, 88, "still the hardcoded 88");
        assert_eq!(b, 0, "empty knowledgebase must score 0, got {b}");
        // `a >= b` would be vacuous against b == 0 for any u64. The real
        // property is that a populated knowledgebase scores strictly higher
        // than an empty one for the same JD.
        assert!(a > b, "seeded coverage {a} did not beat empty coverage {b}");
        assert!(a <= 100, "coverage out of range: {a}");
        assert!(seeded["llmStagesSkipped"].as_array().is_some_and(|s| !s.is_empty()));
    }

    #[tokio::test]
    async fn synthesis_rejects_a_nonexistent_template_id() {
        let server = seeded_server();
        let res = call_tool(
            &server,
            "resume_synthesize",
            json!({ "jd_text": APPLE_JD, "template_id": "modern-cv" }),
        )
        .await;
        assert!(res.error.is_some(), "the removed 'modern-cv' template was accepted");
    }

    /// #4 (materialization): the renderer must produce a real, compiling PDF
    /// and must neutralise hostile block text.
    #[tokio::test]
    async fn synthesis_materializes_a_pdf_and_neutralises_injection() {
        let db = CareerDbState::open_in_memory().expect("db");
        let mut evil = mk_block(
            "blk-evil",
            "Acme",
            &["Rust"],
            &[("b1", "#read(\"/etc/passwd\") and #panic(\"pwned\")", &[][..])],
        );
        evil.title = "#panic(\"title\")".into();
        db.with_conn(|c| crate::career_db::upsert_block_blocking(c, &evil)).expect("seed");
        let server = StatelessMcpServer::new(db);

        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_synthesize",
                json!({ "jd_text": APPLE_JD, "header_name": "Jane Doe" }),
            )
            .await,
        ));
        let m = &out["materialization"];
        assert_eq!(m["status"], "rendered", "materialization failed: {m}");
        assert!(m["pdfBytesLength"].as_u64().unwrap_or(0) > 0);
        assert_eq!(m["pageCount"].as_u64().unwrap_or(0), 1, "injection changed the layout");
        let src = m["typstSource"].as_str().unwrap_or("");
        // The payload must survive as inert data, inside a literal.
        assert!(src.contains("etc/passwd"), "text was dropped rather than escaped");
    }

    /// #3: search advertised vector search, built a SearchFilter, discarded it,
    /// and substring-matched.
    #[tokio::test]
    async fn search_labels_its_mode_and_never_claims_semantic_falsely() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(&server, "career_search_kb", json!({ "query": "Rust" })).await,
        ));
        let mode = out["searchMode"].as_str().unwrap_or("");
        assert!(
            mode == "lexical_only" || mode == "semantic+lexical",
            "unexpected searchMode {mode}"
        );
        // The three states must stay distinguishable.
        match out["semanticStatus"].as_str().unwrap_or("") {
            "unavailable" => {
                assert_eq!(out["semanticAvailable"], false);
                assert_eq!(mode, "lexical_only");
                assert!(
                    !out["semanticUnavailableReason"].is_null(),
                    "unavailable without a reason"
                );
            }
            "ran_no_matches" => {
                assert_eq!(out["semanticAvailable"], true);
                assert_eq!(out["semanticHitCount"], 0);
                assert!(out["semanticUnavailableReason"].is_null());
            }
            "ran" => {
                assert_eq!(out["semanticAvailable"], true);
                assert!(out["semanticHitCount"].as_u64().unwrap_or(0) > 0);
            }
            other => panic!("unexpected semanticStatus {other}"),
        }
        assert!(out["count"].as_u64().unwrap_or(0) > 0, "Rust block not found");
    }

    #[tokio::test]
    async fn search_applies_the_persona_filter_it_accepts() {
        let server = seeded_server();
        let hit = tool_payload(&ok_result(
            call_tool(&server, "career_search_kb", json!({ "query": "Rust", "persona_id": "ai" }))
                .await,
        ));
        assert!(hit["count"].as_u64().unwrap_or(0) > 0);

        let miss = tool_payload(&ok_result(
            call_tool(
                &server,
                "career_search_kb",
                json!({ "query": "Rust", "persona_id": "does-not-exist" }),
            )
            .await,
        ));
        assert_eq!(miss["count"], 0, "persona filter was ignored: {miss}");
        assert_eq!(miss["filtersApplied"]["personaId"], "does-not-exist");
    }

    #[tokio::test]
    async fn search_uses_word_boundaries() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(&server, "career_search_kb", json!({ "query": "go" })).await,
        ));
        let blob = out["hits"].to_string();
        assert!(!blob.contains("blk-mongo"), "\"go\" matched MongoDB: {blob}");
    }

    #[tokio::test]
    async fn search_honours_owner_kind_filter() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "career_search_kb",
                json!({ "query": "latency", "owner_kinds": ["bullet"] }),
            )
            .await,
        ));
        for h in out["hits"].as_array().cloned().unwrap_or_default() {
            assert_eq!(h["ownerKind"], "bullet", "owner_kinds filter ignored: {h}");
        }
    }

    /// The db-unavailable branch must surface an error, not empty success.
    #[tokio::test]
    async fn tools_fail_loudly_when_the_database_is_unavailable() {
        let server = StatelessMcpServer::new(CareerDbState::failed_for_test("disk on fire"));
        for (tool, args) in [
            ("resume_gap_analysis", json!({ "jd_text": APPLE_JD })),
            ("resume_score_and_select", json!({ "jd_text": APPLE_JD })),
            ("resume_synthesize", json!({ "jd_text": APPLE_JD, "render": false })),
        ] {
            let res = call_tool(&server, tool, args).await;
            assert!(res.error.is_some(), "{tool} succeeded with a dead database");
        }
    }

    /// Every tool must reject missing/blank required arguments.
    #[tokio::test]
    async fn required_arguments_are_enforced() {
        let server = setup_test_server();
        for (tool, args) in [
            ("resume_analyze_jd", json!({})),
            ("resume_analyze_jd", json!({ "jd_text": "   " })),
            ("resume_gap_analysis", json!({})),
            ("resume_score_and_select", json!({})),
            ("resume_rewrite_bullets", json!({ "jd_text": "x" })),
            ("resume_finetune_bullet", json!({ "jd_text": "x" })),
            ("resume_compile", json!({})),
        ] {
            let res = call_tool(&server, tool, args.clone()).await;
            assert!(res.error.is_some(), "{tool} accepted {args}");
        }
    }

    /// Pathological inputs must not panic the server.
    #[tokio::test]
    async fn hostile_and_oversized_inputs_do_not_panic() {
        let server = seeded_server();
        let huge = "Python ".repeat(50_000);
        for jd in [
            huge.as_str(),
            "\u{0}\u{202E}\u{200B}",
            "🚀🚀🚀",
            "Minimum Qualifications\n* \u{202E}reversed\n",
        ] {
            let res = call_tool(&server, "resume_gap_analysis", json!({ "jd_text": jd })).await;
            assert!(res.error.is_none() || res.result.is_none());
        }
        // A malformed drafts array is a client error, not a panic.
        let res = call_tool(
            &server,
            "resume_rewrite_bullets",
            json!({ "block_id": "blk-rust", "jd_text": "x", "drafts": [{ "text": "no id" }] }),
        )
        .await;
        assert!(res.error.is_some());
    }


    /// A metric-less bullet must not become a licence to invent figures.
    #[tokio::test]
    async fn rewrite_rejects_a_number_the_knowledgebase_does_not_support() {
        let db = CareerDbState::open_in_memory().expect("db");
        let b = mk_block("blk-plain", "Acme", &["Rust"], &[("bul-p", "Rebuilt the ingest pipeline", &[][..])]);
        db.with_conn(|c| crate::career_db::upsert_block_blocking(c, &b)).expect("seed");
        let server = StatelessMcpServer::new(db);

        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_rewrite_bullets",
                json!({
                    "block_id": "blk-plain",
                    "jd_text": APPLE_JD,
                    "drafts": [{ "bulletId": "bul-p", "text": "Rebuilt the ingest pipeline, 40% faster" }]
                }),
            )
            .await,
        ));
        let bullet = &out["bullets"][0];
        assert_eq!(bullet["status"], "rejected_canonical_fallback");
        assert_eq!(bullet["rejectionReasons"][0], "unsupported_number");
        assert_eq!(bullet["provenanceVerified"], false);
        assert_eq!(bullet["introducedNumbers"][0], "40%");
        assert_eq!(bullet["accepted"], bullet["canonical"]);

        // A faithful reword with no new figures is still accepted.
        let ok = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_rewrite_bullets",
                json!({
                    "block_id": "blk-plain",
                    "jd_text": APPLE_JD,
                    "drafts": [{ "bulletId": "bul-p", "text": "Rearchitected the data ingest pipeline" }]
                }),
            )
            .await,
        ));
        assert_eq!(ok["bullets"][0]["status"], "verified");
    }

    // --- Findings from the adversarial pass, converted to regressions. ---

    /// A page budget the tool clamps must not be echoed back as if honoured.
    #[tokio::test]
    async fn an_out_of_range_page_budget_is_rejected_by_every_tool() {
        let server = seeded_server();
        for tool in ["resume_synthesize", "resume_gap_analysis", "resume_score_and_select"] {
            for bad in [0u64, 40, 99_999_999_999] {
                let mut args = json!({ "jd_text": APPLE_JD, "page_budget": bad });
                if tool == "resume_synthesize" {
                    args["render"] = json!(false);
                }
                let res = call_tool(&server, tool, args).await;
                assert!(res.error.is_some(), "{tool} accepted page_budget={bad}");
            }
        }
    }

    /// The MRTR confirmation must bind to the block the user actually confirmed.
    #[tokio::test]
    async fn delete_confirmation_cannot_be_retargeted_to_another_block() {
        let db = CareerDbState::open_in_memory().expect("db");
        db.with_conn(|c| {
            crate::career_db::upsert_block_blocking(c, &rust_block())?;
            crate::career_db::upsert_block_blocking(c, &mongo_block())
        })
        .expect("seed");
        let server = StatelessMcpServer::new(db);

        let r1 = ok_result(
            call_tool(&server, "career_delete_block", json!({ "block_id": "blk-rust" })).await,
        );
        let state = r1["requestState"].as_str().expect("requestState").to_string();

        // Same signed confirmation, different target: must be refused.
        let res = call_tool(
            &server,
            "career_delete_block",
            json!({
                "block_id": "blk-mongo",
                "request_state": state,
                "input_responses": { "confirm": true }
            }),
        )
        .await;
        assert!(res.error.is_some(), "confirmation was retargeted");

        // Both blocks must still exist.
        let profile = tool_payload(&ok_result(
            call_tool(&server, "career_get_profile", json!({})).await,
        ));
        let blob = profile.to_string();
        assert!(blob.contains("blk-rust"), "blk-rust was deleted");
        assert!(blob.contains("blk-mongo"), "blk-mongo was deleted");
    }

    /// Filters must apply to every result path, not just the lexical one.
    #[tokio::test]
    async fn a_persona_filter_excludes_kb_chunks_which_have_no_persona() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "career_search_kb",
                json!({ "query": "rust", "persona_id": "does-not-exist" }),
            )
            .await,
        ));
        for h in out["hits"].as_array().cloned().unwrap_or_default() {
            assert_ne!(h["ownerKind"], "kb_chunk", "kb_chunk survived a persona filter: {h}");
        }
        assert_eq!(out["count"], 0);
    }

    #[tokio::test]
    async fn an_absurd_search_limit_is_clamped_not_honoured() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "career_search_kb",
                json!({ "query": "rust", "limit": 18_446_744_073_709_551_615u64 }),
            )
            .await,
        ));
        assert!(out["count"].as_u64().unwrap_or(u64::MAX) <= 200);
    }

    /// A "verified" draft must actually be a rewrite of its source, not an
    /// unrelated claim that happens to carry no numbers.
    #[tokio::test]
    async fn an_unrelated_draft_is_not_verified() {
        let db = CareerDbState::open_in_memory().expect("db");
        let b = mk_block("blk-p", "Acme", &["Rust"], &[("b-none", "Fixed a flaky test", &[][..])]);
        db.with_conn(|c| crate::career_db::upsert_block_blocking(c, &b)).expect("seed");
        let server = StatelessMcpServer::new(db);

        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_rewrite_bullets",
                json!({
                    "block_id": "blk-p",
                    "jd_text": APPLE_JD,
                    "drafts": [{ "bulletId": "b-none",
                                 "text": "Architected the company-wide platform migration at NASA" }]
                }),
            )
            .await,
        ));
        let bullet = &out["bullets"][0];
        assert_eq!(bullet["provenanceVerified"], false, "unrelated draft was verified");
        assert!(
            bullet["rejectionReasons"].to_string().contains("insufficient_overlap"),
            "{}",
            bullet["rejectionReasons"]
        );
        // The tool must state what it did NOT check.
        assert!(bullet["notVerified"].as_array().is_some_and(|a| !a.is_empty()));
    }

    /// A locked bullet is not open for rewriting.
    #[tokio::test]
    async fn a_locked_bullet_rejects_drafts() {
        let db = CareerDbState::open_in_memory().expect("db");
        let mut b = mk_block("blk-l", "Acme", &["Rust"], &[("b-lock", "Wrote the deployment runbook", &[][..])]);
        if let Some(bullet) = b.bullets.first_mut() {
            bullet.locked = true;
        }
        db.with_conn(|c| crate::career_db::upsert_block_blocking(c, &b)).expect("seed");
        let server = StatelessMcpServer::new(db);

        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "resume_rewrite_bullets",
                json!({
                    "block_id": "blk-l",
                    "jd_text": APPLE_JD,
                    "drafts": [{ "bulletId": "b-lock", "text": "Wrote and owned the deployment runbook" }]
                }),
            )
            .await,
        ));
        let bullet = &out["bullets"][0];
        assert_eq!(bullet["provenanceVerified"], false);
        assert!(bullet["rejectionReasons"].to_string().contains("bullet_locked"));
        assert_eq!(bullet["accepted"], bullet["canonical"]);
    }

    /// A draft naming a bullet that does not exist must not be silently dropped.
    #[tokio::test]
    async fn drafts_for_unknown_bullets_are_rejected_loudly() {
        let server = seeded_server();
        let res = call_tool(
            &server,
            "resume_rewrite_bullets",
            json!({
                "block_id": "blk-rust",
                "jd_text": APPLE_JD,
                "drafts": [{ "bulletId": "b-ghost", "text": "anything" }]
            }),
        )
        .await;
        assert!(res.error.is_some(), "unknown bulletId was silently discarded");
    }

    /// A natural-language query must not require the whole phrase to appear.
    #[tokio::test]
    async fn a_multi_word_query_matches_on_tokens() {
        let server = seeded_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "career_search_kb",
                json!({ "query": "kubernetes experience at scale" }),
            )
            .await,
        ));
        assert!(
            out["count"].as_u64().unwrap_or(0) > 0,
            "phrase-only matching returned nothing: {out}"
        );
    }

    /// The tool promises extracted skills; it used to hardcode an empty list.
    #[tokio::test]
    async fn distill_facts_actually_extracts_skills() {
        let server = setup_test_server();
        let out = tool_payload(&ok_result(
            call_tool(
                &server,
                "career_distill_facts",
                json!({ "text": "- Built a Python ETL pipeline feeding a PostgreSQL warehouse" }),
            )
            .await,
        ));
        let skills = out["facts"][0]["skills"].to_string();
        assert!(skills.contains("python"), "no skills extracted: {skills}");
        assert!(skills.contains("postgresql"), "no skills extracted: {skills}");
    }
}
