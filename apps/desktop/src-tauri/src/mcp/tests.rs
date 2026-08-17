#[cfg(test)]
mod tests {
    use crate::career_db::{CareerDbState, ExperienceBlock, DateRange, SkillTag, Bullet};
    use crate::mcp::protocol::{
        HttpHeaders, JsonRpcRequest, MCP_PROTOCOL_VERSION, ERR_HEADER_MISMATCH,
    };
    use crate::mcp::server::StatelessMcpServer;
    use serde_json::json;
    use std::collections::HashMap;

    fn setup_test_server() -> StatelessMcpServer {
        let db = CareerDbState::default();
        StatelessMcpServer::new(db)
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
        assert_eq!(profile["seniority"], "Senior");
        let required = profile["requiredSkills"].as_array().expect("required skills");
        assert!(required.iter().any(|s| s == "rust" || s == "typescript"));

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
}
