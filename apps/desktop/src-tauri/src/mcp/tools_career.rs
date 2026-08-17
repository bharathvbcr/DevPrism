//! Career Knowledgebase MCP Tools and Resources.
//!
//! Exposes:
//! - `career_search_kb`: hybrid vector semantic search over experience blocks, facts, and KB chunks.
//! - `career_get_profile`: fetch complete career profile, experience blocks, and personas.
//! - `career_upsert_block`: add or modify an experience block.
//! - `career_delete_block`: delete an experience block (with MRTR elicitation safety check).
//! - `career_distill_facts`: extract atomic structured facts from raw notes or text.
//! - `career_add_facts`: append verified structured facts to an experience block.
//! - `career_list_personas`: list available career personas.
//! - `career_upsert_persona`: add/update a career persona.
//! - `career_ingest_knowledge`: ingest raw documents or text into KB chunks.
//!
//! Resources:
//! - `career://profile`: full candidate profile and blocks.
//! - `career://blocks/{id}`: individual block details.
//! - `career://personas`: list of personas.
//! - `career://kb/sources`: list of knowledge sources.

use crate::career_db::{
    self, BlockFact, BulletMetric, ExperienceBlock, Persona,
};
use crate::mcp::protocol::{
    InputRequest, InputRequiredResult, JsonRpcError, ResourceDefinition, ResponseMeta,
    ToolDefinition,
};
use serde_json::{json, Value};
use sha1::Digest;
use std::collections::HashMap;
use uuid::Uuid;

// --- Input bounds ---
//
// Every argument here arrives as arbitrary JSON from any MCP client, and several
// of them are written straight into SQLite. Before these caps existed, a single
// `career_ingest_knowledge` call could hand the server an arbitrarily large
// `text`, which `ingest` splits into one row per paragraph and inserts one
// statement at a time while holding the process-wide DB mutex — freezing the
// desktop UI along with every other tool for as long as it took.
//
// The JSON Schemas in the tool definitions are advisory: MCP clients are not
// obliged to honour them and a hostile one certainly will not. These are the
// enforcement.

/// Longest search query accepted. Every hit does a substring scan against it.
const MAX_QUERY_CHARS: usize = 1_000;
/// Largest single body of text accepted for ingest or distillation.
const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// Longest short identifier-ish field (titles, ids, source kinds).
const MAX_LABEL_CHARS: usize = 512;
/// Longest source URI.
const MAX_URI_CHARS: usize = 2_048;
/// Most facts appended in one call.
const MAX_FACTS_PER_CALL: usize = 500;
/// Largest experience block accepted, measured on its serialized JSON.
const MAX_BLOCK_JSON_BYTES: usize = 1024 * 1024;
/// Largest `limit` a caller may request, and the default when absent.
const MAX_SEARCH_LIMIT: usize = 200;
const DEFAULT_SEARCH_LIMIT: usize = 10;

/// What an overwrite of an existing block would destroy.
///
/// Counting bullets was not enough. `upsert_block_blocking` replaces the whole
/// document, so a payload with the *same number* of bullets silently discards
/// every original `canonical`, `metrics`, `evidence_refs`, and — because
/// `Bullet::locked` is `#[serde(default)]` — every `locked` flag, while a
/// count-based check reports no loss at all. The gate has to compare identities
/// and protected content, not cardinality.
#[derive(Default)]
struct OverwriteLoss {
    dropped_bullet_ids: Vec<String>,
    dropped_fact_ids: Vec<String>,
    /// Locked bullets whose text or metrics the payload would change. `locked`
    /// exists precisely to mean "do not rewrite this".
    modified_locked_bullets: Vec<String>,
}

impl OverwriteLoss {
    fn is_destructive(&self) -> bool {
        !self.dropped_bullet_ids.is_empty()
            || !self.dropped_fact_ids.is_empty()
            || !self.modified_locked_bullets.is_empty()
    }

    fn describe(&self) -> String {
        let mut parts = Vec::new();
        if !self.dropped_bullet_ids.is_empty() {
            parts.push(format!("{} bullet(s)", self.dropped_bullet_ids.len()));
        }
        if !self.dropped_fact_ids.is_empty() {
            parts.push(format!("{} fact(s)", self.dropped_fact_ids.len()));
        }
        if !self.modified_locked_bullets.is_empty() {
            parts.push(format!(
                "{} locked bullet(s) rewritten",
                self.modified_locked_bullets.len()
            ));
        }
        parts.join(", ")
    }
}

fn overwrite_loss(prior: &ExperienceBlock, next: &ExperienceBlock) -> OverwriteLoss {
    let next_bullets: HashMap<&str, &crate::career_db::Bullet> =
        next.bullets.iter().map(|b| (b.id.as_str(), b)).collect();
    let next_fact_ids: std::collections::HashSet<&str> =
        next.facts.iter().map(|f| f.id.as_str()).collect();

    let mut loss = OverwriteLoss::default();
    for bullet in &prior.bullets {
        match next_bullets.get(bullet.id.as_str()) {
            None => loss.dropped_bullet_ids.push(bullet.id.clone()),
            Some(incoming) if bullet.locked => {
                let text_changed = incoming.canonical != bullet.canonical;
                let metrics_changed = incoming.metrics.len() != bullet.metrics.len()
                    || incoming
                        .metrics
                        .iter()
                        .zip(&bullet.metrics)
                        .any(|(a, b)| a.value != b.value || a.kind != b.kind);
                // Silently clearing `locked` is itself the loss.
                if text_changed || metrics_changed || !incoming.locked {
                    loss.modified_locked_bullets.push(bullet.id.clone());
                }
            }
            Some(_) => {}
        }
    }
    for fact in &prior.facts {
        if !next_fact_ids.contains(fact.id.as_str()) {
            loss.dropped_fact_ids.push(fact.id.clone());
        }
    }
    loss
}

/// Digest of the exact payload a confirmation approves.
///
/// The confirmation subject must identify the *change*, not just the block. Bound
/// to the id alone, a token issued for "drop 1 of 20 bullets" — which is what the
/// human was shown and approved — could be redeemed on a second call carrying an
/// empty block of the same id, gutting all 20. Binding to the payload makes the
/// approved write the only write the token authorises.
fn overwrite_subject(block_id: &str, block: &Value) -> String {
    let canonical = serde_json::to_string(block).unwrap_or_default();
    let digest = sha1::Sha1::digest(canonical.as_bytes());
    format!("{block_id}:{digest:x}")
}

/// Read a required string argument.
fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    match args.get(key) {
        Some(Value::String(s)) => Ok(s.as_str()),
        Some(other) => Err(JsonRpcError::invalid_params(format!(
            "Argument '{key}' must be a string, got {}",
            json_type_name(other)
        ))),
        None => Err(JsonRpcError::invalid_params(format!(
            "Missing required '{key}' argument"
        ))),
    }
}

/// Read an optional string argument, rejecting a present-but-wrong-typed value.
///
/// The previous `arguments.get(k).and_then(|v| v.as_str())` collapsed "absent"
/// and "wrong type" into the same `None`. For a filter argument that means
/// `{"persona_id": 123}` is read as *no persona filter* and silently returns the
/// entire unscoped profile — a wrong answer that looks like a right one.
fn optional_str<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, JsonRpcError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(other) => Err(JsonRpcError::invalid_params(format!(
            "Argument '{key}' must be a string, got {}",
            json_type_name(other)
        ))),
    }
}

fn json_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Reject an over-long string, counting characters.
fn bounded_chars<'a>(value: &'a str, key: &str, max: usize) -> Result<&'a str, JsonRpcError> {
    let len = value.chars().count();
    if len > max {
        return Err(JsonRpcError::invalid_params(format!(
            "Argument '{key}' is {len} characters, exceeding the {max}-character limit"
        )));
    }
    Ok(value)
}

/// Reject an over-long body of text, counting bytes (what actually hits storage).
fn bounded_bytes<'a>(value: &'a str, key: &str, max: usize) -> Result<&'a str, JsonRpcError> {
    if value.len() > max {
        return Err(JsonRpcError::invalid_params(format!(
            "Argument '{key}' is {} bytes, exceeding the {max}-byte limit",
            value.len()
        )));
    }
    Ok(value)
}

/// Read a `limit`, clamped to `MAX_SEARCH_LIMIT`.
fn bounded_limit(args: &Value) -> Result<usize, JsonRpcError> {
    match args.get("limit") {
        None | Some(Value::Null) => Ok(DEFAULT_SEARCH_LIMIT),
        Some(Value::Number(n)) => {
            let raw = n.as_u64().ok_or_else(|| {
                JsonRpcError::invalid_params("Argument 'limit' must be a non-negative integer")
            })?;
            Ok((raw as usize).clamp(1, MAX_SEARCH_LIMIT))
        }
        Some(other) => Err(JsonRpcError::invalid_params(format!(
            "Argument 'limit' must be a number, got {}",
            json_type_name(other)
        ))),
    }
}

pub fn list_career_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "career_search_kb".to_string(),
            // Says keyword, because it does keyword. The previous wording
            // ("semantic vector search") described a code path this tool has
            // never taken — it computes no embedding and never calls
            // `vectors::vector_search`. A caller that believes it is getting
            // semantic recall silently under-retrieves on any phrasing that does
            // not literally appear in the text.
            description: "Search the candidate's experience blocks, bullets, facts, and ingested knowledgebase chunks by case-insensitive keyword match, with optional persona/domain/kind filtering. This is literal substring matching, not semantic vector search: a query only matches text that contains it.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language query or skill term to search for"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of hits to return (default 10)"
                    },
                    "owner_kinds": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional filter by owner kind: 'block', 'bullet', 'fact', 'kb_chunk'"
                    },
                    "persona_id": {
                        "type": "string",
                        "description": "Optional persona id filter"
                    },
                    "domain": {
                        "type": "string",
                        "description": "Optional domain filter"
                    }
                },
                "required": ["query"]
            }),
            _meta: Some(ResponseMeta {
                ttl_ms: Some(30_000),
                cache_scope: Some("user".to_string()),
                extra: HashMap::new(),
            }),
        },
        ToolDefinition {
            name: "career_get_profile".to_string(),
            description: "Retrieve the candidate's complete master career profile including all experience blocks (work, education, projects, skills), distilled facts, and personas.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "persona_id": {
                        "type": "string",
                        "description": "Optional persona ID to filter persona-specific configurations"
                    }
                }
            }),
            _meta: Some(ResponseMeta {
                ttl_ms: Some(60_000),
                cache_scope: Some("user".to_string()),
                extra: HashMap::new(),
            }),
        },
        ToolDefinition {
            name: "career_upsert_block".to_string(),
            description: "Create or update an experience block (work, project, education, skill_group, leadership) in the candidate's career database. This is a whole-document replace: any bullet or fact absent from the payload is discarded. If the update would drop existing bullets or facts, it requires MRTR confirmation first.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "block": {
                        "type": "object",
                        "description": "The ExperienceBlock object to insert or update"
                    },
                    "input_responses": {
                        "type": "object",
                        "description": "Elicitation responses from a previous roundtrip, when the update discards content"
                    },
                    "request_state": {
                        "type": "string",
                        "description": "Server-issued state from a previous roundtrip. Must be the exact value the server returned; a forged or reused value is rejected."
                    }
                },
                "required": ["block"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "career_delete_block".to_string(),
            description: "Delete an experience block and its associated embeddings from the career database. Requires MRTR confirmation if block has facts or bullets.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "block_id": {
                        "type": "string",
                        "description": "Unique ID of the experience block to delete"
                    },
                    "input_responses": {
                        "type": "object",
                        "description": "Elicitation responses from previous roundtrip"
                    },
                    "request_state": {
                        "type": "string",
                        "description": "Self-contained serialized state from previous roundtrip"
                    }
                },
                "required": ["block_id"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "career_distill_facts".to_string(),
            description: "Distill unstructured notes, project summaries, or accomplishment write-ups into structured atomic facts with extracted skills and metrics.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Raw unstructured notes or documentation to distill"
                    },
                    "source": {
                        "type": "string",
                        "description": "Optional source attribution label (e.g. 'project-notes', 'retro')"
                    }
                },
                "required": ["text"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "career_add_facts".to_string(),
            description: "Append verified atomic facts to an existing experience block in the career database.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "block_id": {
                        "type": "string",
                        "description": "Target experience block ID"
                    },
                    "facts": {
                        "type": "array",
                        "items": { "type": "object" },
                        "description": "Array of BlockFact objects to append"
                    }
                },
                "required": ["block_id", "facts"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "career_list_personas".to_string(),
            description: "List all career personas (AI/ML, Life Sciences, Management, Custom) with their default templates, skill weights, and tone directives.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
            _meta: Some(ResponseMeta {
                ttl_ms: Some(120_000),
                cache_scope: Some("user".to_string()),
                extra: HashMap::new(),
            }),
        },
        ToolDefinition {
            name: "career_upsert_persona".to_string(),
            description: "Create or update a career persona with tailored section orders and tone directives.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "persona": {
                        "type": "object",
                        "description": "The Persona definition"
                    }
                },
                "required": ["persona"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "career_ingest_knowledge".to_string(),
            description: "Ingest a document, text notes, or resume into the career knowledgebase chunk store for semantic retrieval.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Document title"
                    },
                    "text": {
                        "type": "string",
                        "description": "Document body text"
                    },
                    "source_type": {
                        "type": "string",
                        "description": "Type of source: 'markdown', 'pdf', 'notes', 'resume'"
                    },
                    "uri": {
                        "type": "string",
                        "description": "Optional file path or URI reference"
                    }
                },
                "required": ["title", "text"]
            }),
            _meta: None,
        },
    ]
}

pub fn list_career_resources() -> Vec<ResourceDefinition> {
    vec![
        ResourceDefinition {
            uri: "career://profile".to_string(),
            name: "Candidate Master Profile".to_string(),
            description: Some("Complete career profile with all blocks, skills, and facts".to_string()),
            mime_type: Some("application/json".to_string()),
            _meta: Some(ResponseMeta {
                ttl_ms: Some(60_000),
                cache_scope: Some("user".to_string()),
                extra: HashMap::new(),
            }),
        },
        ResourceDefinition {
            uri: "career://personas".to_string(),
            name: "Career Personas".to_string(),
            description: Some("List of defined career personas and tone directives".to_string()),
            mime_type: Some("application/json".to_string()),
            _meta: Some(ResponseMeta {
                ttl_ms: Some(120_000),
                cache_scope: Some("user".to_string()),
                extra: HashMap::new(),
            }),
        },
        ResourceDefinition {
            uri: "career://kb/sources".to_string(),
            name: "Knowledgebase Sources".to_string(),
            description: Some("List of ingested KB sources and document metadata".to_string()),
            mime_type: Some("application/json".to_string()),
            _meta: Some(ResponseMeta {
                ttl_ms: Some(60_000),
                cache_scope: Some("user".to_string()),
                extra: HashMap::new(),
            }),
        },
    ]
}

pub async fn execute_career_tool(
    db: &career_db::CareerDbState,
    elicitations: &crate::mcp::elicitation::ElicitationStore,
    name: &str,
    arguments: &Value,
) -> Result<Value, JsonRpcError> {
    match name {
        "career_search_kb" => {
            let query = bounded_chars(
                require_str(arguments, "query")?,
                "query",
                MAX_QUERY_CHARS,
            )?;
            let limit = bounded_limit(arguments)?;

            let owner_kinds = match arguments.get("owner_kinds") {
                None | Some(Value::Null) => None,
                Some(Value::Array(arr)) => Some(
                    arr.iter()
                        .map(|v| {
                            v.as_str().map(str::to_string).ok_or_else(|| {
                                JsonRpcError::invalid_params(
                                    "Every entry in 'owner_kinds' must be a string",
                                )
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                Some(other) => {
                    return Err(JsonRpcError::invalid_params(format!(
                        "Argument 'owner_kinds' must be an array, got {}",
                        json_type_name(other)
                    )))
                }
            };

            let persona_id = optional_str(arguments, "persona_id")?
                .map(|s| bounded_chars(s, "persona_id", MAX_LABEL_CHARS))
                .transpose()?
                .map(str::to_string);
            let domain = optional_str(arguments, "domain")?
                .map(|s| bounded_chars(s, "domain", MAX_LABEL_CHARS))
                .transpose()?
                .map(str::to_string);

            // These three arguments used to be collected into a `SearchFilter`
            // that was bound to `_filter` and never read — the underscore
            // silenced the dead-value warning, so `persona_id`, `domain` and
            // `owner_kinds` were advertised in the schema and had no effect at
            // all. A caller asking for persona-scoped results got the whole
            // knowledgebase back and no indication that its scoping was dropped.
            let want_blocks = owner_kinds
                .as_ref()
                .map(|k| k.iter().any(|s| s == "block"))
                .unwrap_or(true);
            let want_chunks = owner_kinds
                .as_ref()
                .map(|k| k.iter().any(|s| s == "kb_chunk"))
                .unwrap_or(true);

            let query_owned = query.to_string();
            let persona_filter = persona_id.clone();
            let domain_filter = domain.clone();
            let db_clone = db.clone();
            let hits = tokio::task::spawn_blocking(move || {
                db_clone.with_conn(|conn| {
                    let mut scored: Vec<Value> = Vec::new();
                    let q_lower = query_owned.to_lowercase();

                    if want_blocks {
                        for block in career_db::list_blocks_blocking(conn, false)? {
                            if let Some(ref persona) = persona_filter {
                                if !block.personas.iter().any(|p| p == persona) {
                                    continue;
                                }
                            }
                            if let Some(ref want_domain) = domain_filter {
                                if !block.domains.iter().any(|d| d == want_domain) {
                                    continue;
                                }
                            }

                            // A real, explainable relevance number.
                            //
                            // The previous scoring added a fixed 0.8/0.9/0.95 per
                            // matching field and clamped to 1.0, so any block with
                            // two matches scored exactly 1.0 and ranking carried no
                            // information. This weights by *where* the match landed
                            // (a fact is stronger evidence than a job title) and
                            // saturates smoothly, so more matches always rank
                            // strictly higher without every result pinning to 1.0.
                            let header = format!(
                                "{} {} {}",
                                block.title,
                                block.org,
                                block
                                    .skills
                                    .iter()
                                    .map(|s| s.name.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" ")
                            );
                            let header_hits =
                                usize::from(header.to_lowercase().contains(&q_lower));
                            let bullet_hits = block
                                .bullets
                                .iter()
                                .filter(|b| b.canonical.to_lowercase().contains(&q_lower))
                                .count();
                            let fact_hits = block
                                .facts
                                .iter()
                                .filter(|f| f.text.to_lowercase().contains(&q_lower))
                                .count();

                            let weighted = 1.0 * header_hits as f64
                                + 1.5 * bullet_hits as f64
                                + 2.0 * fact_hits as f64;
                            if weighted <= 0.0 {
                                continue;
                            }
                            // 1 - e^-x: strictly increasing, asymptotic to 1, never
                            // reaches it — so the number stays comparable.
                            let score = 1.0 - (-weighted / 3.0).exp();

                            scored.push(json!({
                                "ownerId": block.id,
                                "ownerKind": "block",
                                "score": score,
                                "matchedIn": {
                                    "header": header_hits,
                                    "bullets": bullet_hits,
                                    "facts": fact_hits
                                },
                                "title": block.title,
                                "org": block.org,
                                "kind": block.kind,
                                "skills": block.skills,
                                "bulletCount": block.bullets.len(),
                                "factCount": block.facts.len()
                            }));
                        }
                    }

                    // Persona and domain live on experience blocks, so a chunk can
                    // never satisfy them. Skipping chunks under those filters
                    // matches `vectors::passes_block_filters`, which returns false
                    // for any non-block owner when a block-scoped filter is set.
                    let chunks_filtered_out =
                        persona_filter.is_some() || domain_filter.is_some();
                    if want_chunks && !chunks_filtered_out {
                        for chunk in career_db::ingest::list_kb_chunks(conn, None, false)? {
                            let lower = chunk.text.to_lowercase();
                            let occurrences = lower.matches(&q_lower).count();
                            if occurrences == 0 {
                                continue;
                            }
                            // Same curve as blocks, so chunk and block scores are
                            // on one comparable scale rather than a constant 0.85.
                            let score = 1.0 - (-(occurrences as f64) / 3.0).exp();
                            scored.push(json!({
                                "ownerId": chunk.id,
                                "ownerKind": "kb_chunk",
                                "score": score,
                                "matchedIn": { "occurrences": occurrences },
                                "sourceId": chunk.source_id,
                                "snippet": chunk.text.chars().take(200).collect::<String>()
                            }));
                        }
                    }

                    scored.sort_by(|a, b| {
                        let sa = a.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let sb = b.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
                    });

                    scored.truncate(limit);
                    Ok(scored)
                })
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("search task error: {e}")))?
            .map_err(|e| JsonRpcError::internal_error(e))?;

            Ok(json!({
                "query": query,
                // State the retrieval mode and the filters actually applied, so a
                // caller can tell scoped results from unscoped ones instead of
                // inferring it from arguments the server may have ignored.
                "searchMode": "keyword-substring",
                "appliedFilters": {
                    "personaId": persona_id,
                    "domain": domain,
                    "ownerKinds": owner_kinds
                },
                "hits": hits,
                "count": hits.len(),
                "_meta": {
                    "ttlMs": 30000,
                    "cacheScope": "user"
                }
            }))
        }

        "career_get_profile" => {
            let db_clone = db.clone();
            let persona_filter = optional_str(arguments, "persona_id")?
                .map(|s| bounded_chars(s, "persona_id", MAX_LABEL_CHARS))
                .transpose()?
                .map(str::to_string);

            let profile = tokio::task::spawn_blocking(move || {
                db_clone.with_conn(|conn| {
                    let mut blocks = career_db::list_blocks_blocking(conn, false)?;
                    let personas = career_db::list_personas_blocking(conn)?;
                    if let Some(pid) = persona_filter {
                        blocks.retain(|b| b.personas.is_empty() || b.personas.contains(&pid));
                    }
                    Ok((blocks, personas))
                })
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("profile task error: {e}")))?
            .map_err(|e| JsonRpcError::internal_error(e))?;

            Ok(json!({
                "blocks": profile.0,
                "personas": profile.1,
                "totalBlocks": profile.0.len(),
                "_meta": {
                    "ttlMs": 60000,
                    "cacheScope": "user"
                }
            }))
        }

        "career_upsert_block" => {
            let block_val = arguments
                .get("block")
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'block' object"))?;

            // Bound before deserializing: `ExperienceBlock` has unbounded `Vec`
            // fields, and the whole document is written to one SQLite row.
            let encoded = serde_json::to_string(block_val)
                .map_err(|e| JsonRpcError::invalid_params(format!("Unserializable block: {e}")))?;
            bounded_bytes(&encoded, "block", MAX_BLOCK_JSON_BYTES)?;

            let block: ExperienceBlock = serde_json::from_value(block_val.clone())
                .map_err(|e| JsonRpcError::invalid_params(format!("Invalid ExperienceBlock schema: {e}")))?;

            // `upsert_block_blocking` is `ON CONFLICT(id) DO UPDATE SET json =
            // excluded.json` — a whole-document replace. The caller supplies the
            // id, so naming an existing block silently discards every bullet,
            // fact, metric and `locked` flag the payload omits. Overwriting a
            // block with an empty one was strictly more destructive than
            // `career_delete_block`, and it was the one of the two with no gate
            // at all.
            //
            // Growth and in-place edits stay a single call. Only *losing*
            // content needs the same confirmation round trip as a delete.
            let block_id = block.id.clone();
            let db_probe = db.clone();
            let probe_id = block_id.clone();
            let existing = tokio::task::spawn_blocking(move || {
                db_probe.with_conn(|conn| {
                    let blocks = career_db::list_blocks_blocking(conn, false)?;
                    Ok(blocks.into_iter().find(|b| b.id == probe_id))
                })
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("block probe error: {e}")))?
            .map_err(JsonRpcError::internal_error)?;

            if let Some(prior) = &existing {
                let loss = overwrite_loss(prior, &block);

                if loss.is_destructive() {
                    let subject = overwrite_subject(&block_id, block_val);
                    let request_state = optional_str(arguments, "request_state")?;
                    match request_state {
                        Some(state_str) => {
                            let state_val = InputRequiredResult::decode_state(state_str).map_err(
                                |e| {
                                    JsonRpcError::new(
                                        crate::mcp::protocol::ERR_ELICITATION_FAILED,
                                        e,
                                    )
                                },
                            )?;
                            let nonce = InputRequiredResult::nonce_from_state(&state_val)
                                .ok_or_else(|| {
                                    JsonRpcError::new(
                                        crate::mcp::protocol::ERR_ELICITATION_FAILED,
                                        "requestState is not bound to a server-issued confirmation",
                                    )
                                })?;
                            // Subject is the payload digest, so the token only
                            // authorises the exact write the user approved.
                            elicitations
                                .consume(nonce, "career_upsert_block", &subject)
                                .map_err(|rejection| {
                                    JsonRpcError::with_data(
                                        crate::mcp::protocol::ERR_ELICITATION_FAILED,
                                        rejection.detail(),
                                        json!({ "blockId": block_id }),
                                    )
                                })?;

                            let confirmed = arguments
                                .get("input_responses")
                                .and_then(|r| r.get("confirm"))
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            if !confirmed {
                                return Ok(json!({
                                    "success": false,
                                    "cancelled": true,
                                    "message": "Block overwrite was cancelled by the user"
                                }));
                            }
                        }
                        None => {
                            let mut requests = HashMap::new();
                            requests.insert(
                                "confirm".to_string(),
                                InputRequest {
                                    kind: "confirmation".to_string(),
                                    message: format!(
                                        "Overwriting block '{}' at '{}' will permanently discard {}. Continue?",
                                        prior.title,
                                        prior.org,
                                        loss.describe()
                                    ),
                                    schema: json!({
                                        "type": "boolean",
                                        "description": "True to overwrite and discard the missing content, false to cancel"
                                    }),
                                },
                            );

                            let state_payload = json!({
                                "tool": "career_upsert_block",
                                "blockId": block_id,
                                "droppedBulletIds": loss.dropped_bullet_ids,
                                "droppedFactIds": loss.dropped_fact_ids,
                                "modifiedLockedBullets": loss.modified_locked_bullets,
                                "timestamp": chrono::Utc::now().timestamp_millis()
                            });
                            let nonce = elicitations.issue("career_upsert_block", &subject);
                            let mrtr =
                                InputRequiredResult::new_bound(requests, &state_payload, &nonce)
                                    .map_err(JsonRpcError::internal_error)?;
                            return serde_json::to_value(mrtr)
                                .map_err(|e| JsonRpcError::internal_error(e.to_string()));
                        }
                    }
                }
            }

            let created = existing.is_none();
            let db_clone = db.clone();
            tokio::task::spawn_blocking(move || {
                db_clone.with_conn(|conn| career_db::upsert_block_blocking(conn, &block))
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("upsert block task error: {e}")))?
            .map_err(|e| JsonRpcError::internal_error(e))?;

            Ok(json!({
                "success": true,
                "blockId": block_id,
                "created": created,
                "message": format!(
                    "Block '{block_id}' {}",
                    if created { "created" } else { "updated" }
                )
            }))
        }

        "career_delete_block" => {
            let block_id = arguments
                .get("block_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'block_id' argument"))?;

            // Check if MRTR response or state was provided
            let input_responses = arguments.get("input_responses");
            let request_state = optional_str(arguments, "request_state")?;

            if let Some(state_str) = request_state {
                // Decode stateless requestState
                let state_val = InputRequiredResult::decode_state(state_str)
                    .map_err(|e| JsonRpcError::new(crate::mcp::protocol::ERR_ELICITATION_FAILED, e))?;

                // Prove this state came from *this* server's confirmation prompt
                // for *this* block, and has not already been spent.
                //
                // Before this check the mere presence of a `request_state`
                // argument put the call on the deletion path: any caller could
                // attach `{"request_state":"e30=","input_responses":{"confirm":
                // true}}` and permanently delete a block plus its embeddings
                // without a human ever seeing the prompt. The confirmation is
                // only a gate if the token coming back is proven to be the token
                // that went out.
                let nonce = InputRequiredResult::nonce_from_state(&state_val).ok_or_else(|| {
                    JsonRpcError::new(
                        crate::mcp::protocol::ERR_ELICITATION_FAILED,
                        "requestState is not bound to a server-issued confirmation",
                    )
                })?;
                elicitations
                    .consume(nonce, "career_delete_block", block_id)
                    .map_err(|rejection| {
                        JsonRpcError::with_data(
                            crate::mcp::protocol::ERR_ELICITATION_FAILED,
                            rejection.detail(),
                            json!({ "blockId": block_id }),
                        )
                    })?;

                let confirmed = input_responses
                    .and_then(|r| r.get("confirm"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if !confirmed {
                    return Ok(json!({
                        "success": false,
                        "cancelled": true,
                        "message": "Block deletion was cancelled by the user"
                    }));
                }

                // Delete exactly the block the token was issued for. `consume`
                // has already established that `state_val`'s subject and
                // `block_id` agree, so this is the same id either way.
                let bid = block_id.to_string();

                let db_clone = db.clone();
                tokio::task::spawn_blocking(move || {
                    db_clone.with_conn(|conn| career_db::delete_block_blocking(conn, &bid))
                })
                .await
                .map_err(|e| JsonRpcError::internal_error(format!("delete task error: {e}")))?
                .map_err(|e| JsonRpcError::internal_error(e))?;

                return Ok(json!({
                    "success": true,
                    "deletedBlockId": block_id,
                    "message": format!("Block '{block_id}' and all associated embeddings deleted")
                }));
            }

            // Inspect block first to see if it contains critical content needing confirmation
            let db_clone = db.clone();
            let bid = block_id.to_string();
            let block_opt = tokio::task::spawn_blocking(move || {
                db_clone.with_conn(|conn| {
                    let blocks = career_db::list_blocks_blocking(conn, false)?;
                    Ok(blocks.into_iter().find(|b| b.id == bid))
                })
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("check block error: {e}")))?
            .map_err(|e| JsonRpcError::internal_error(e))?;

            let block = block_opt
                .ok_or_else(|| JsonRpcError::invalid_params(format!("Block '{block_id}' not found")))?;

            // If block has multiple bullets or facts, require MRTR confirmation
            if !block.bullets.is_empty() || !block.facts.is_empty() {
                let mut requests = HashMap::new();
                requests.insert(
                    "confirm".to_string(),
                    InputRequest {
                        kind: "confirmation".to_string(),
                        message: format!(
                            "Are you sure you want to delete experience block '{}' at '{}' with {} bullets and {} facts?",
                            block.title,
                            block.org,
                            block.bullets.len(),
                            block.facts.len()
                        ),
                        schema: json!({
                            "type": "boolean",
                            "description": "True to permanently delete, false to cancel"
                        }),
                    },
                );

                let state_payload = json!({
                    "tool": "career_delete_block",
                    "blockId": block.id,
                    "title": block.title,
                    "org": block.org,
                    "timestamp": chrono::Utc::now().timestamp_millis()
                });

                let nonce = elicitations.issue("career_delete_block", &block.id);
                let mrtr = InputRequiredResult::new_bound(requests, &state_payload, &nonce)
                    .map_err(|e| JsonRpcError::internal_error(e))?;

                return Ok(serde_json::to_value(mrtr)
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))?);
            }

            // Otherwise delete immediately
            let bid = block_id.to_string();
            let db_clone = db.clone();
            tokio::task::spawn_blocking(move || {
                db_clone.with_conn(|conn| career_db::delete_block_blocking(conn, &bid))
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("delete task error: {e}")))?
            .map_err(|e| JsonRpcError::internal_error(e))?;

            Ok(json!({
                "success": true,
                "deletedBlockId": block_id
            }))
        }

        "career_distill_facts" => {
            let text = bounded_bytes(require_str(arguments, "text")?, "text", MAX_TEXT_BYTES)?;
            let source = optional_str(arguments, "source")?
                .map(|s| bounded_chars(s, "source", MAX_LABEL_CHARS))
                .transpose()?
                .unwrap_or("manual");

            // Extract bullet points / sentences into atomic facts
            let lines = text.lines();
            let mut facts: Vec<BlockFact> = Vec::new();
            let now = chrono::Utc::now().to_rfc3339();

            for line in lines {
                let trimmed = line.trim().trim_start_matches(['-', '*', '•']).trim();
                if trimmed.len() < 10 {
                    continue;
                }

                // Extract metric candidates
                let mut metrics = Vec::new();
                for word in trimmed.split_whitespace() {
                    if (word.contains('%') || word.starts_with('$') || word.chars().any(|c| c.is_ascii_digit())) && word.len() >= 2 {
                        metrics.push(BulletMetric {
                            value: word.trim_matches([',', '.', ';', '(', ')']).to_string(),
                            kind: "metric".to_string(),
                        });
                    }
                }

                facts.push(BlockFact {
                    id: format!("fact-{}", Uuid::new_v4().to_string().chars().take(8).collect::<String>()),
                    text: trimmed.to_string(),
                    skills: Vec::new(),
                    metrics,
                    source: source.to_string(),
                    created_at: now.clone(),
                });
            }

            Ok(json!({
                "facts": facts,
                "count": facts.len(),
                "source": source
            }))
        }

        "career_add_facts" => {
            let block_id = bounded_chars(
                require_str(arguments, "block_id")?,
                "block_id",
                MAX_LABEL_CHARS,
            )?;
            let facts_val = arguments
                .get("facts")
                .and_then(|v| v.as_array())
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'facts' array"))?;
            if facts_val.len() > MAX_FACTS_PER_CALL {
                return Err(JsonRpcError::invalid_params(format!(
                    "'facts' has {} entries, exceeding the {MAX_FACTS_PER_CALL}-entry limit",
                    facts_val.len()
                )));
            }

            // Count alone is not a bound: `BlockFact.text` is an unbounded
            // `String`, so 500 facts of 10 MB each is a ~5 GB row written through
            // the process-wide DB mutex — the freeze these caps exist to prevent.
            let facts_encoded = serde_json::to_string(facts_val)
                .map_err(|e| JsonRpcError::invalid_params(format!("Unserializable facts: {e}")))?;
            bounded_bytes(&facts_encoded, "facts", MAX_BLOCK_JSON_BYTES)?;

            let mut new_facts = Vec::new();
            for f in facts_val {
                let fact: BlockFact = serde_json::from_value(f.clone())
                    .map_err(|e| JsonRpcError::invalid_params(format!("Invalid BlockFact: {e}")))?;
                new_facts.push(fact);
            }

            let bid = block_id.to_string();
            let db_clone = db.clone();
            tokio::task::spawn_blocking(move || {
                db_clone.with_conn(|conn| {
                    let mut blocks = career_db::list_blocks_blocking(conn, false)?;
                    let block = blocks
                        .iter_mut()
                        .find(|b| b.id == bid)
                        .ok_or_else(|| format!("Block '{bid}' not found"))?;

                    block.facts.extend(new_facts);
                    block.updated_at = chrono::Utc::now().to_rfc3339();
                    career_db::upsert_block_blocking(conn, block)
                })
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("add facts error: {e}")))?
            .map_err(|e| JsonRpcError::internal_error(e))?;

            Ok(json!({
                "success": true,
                "blockId": block_id,
                "addedCount": facts_val.len()
            }))
        }

        "career_list_personas" => {
            let db_clone = db.clone();
            let personas = tokio::task::spawn_blocking(move || {
                db_clone.with_conn(career_db::list_personas_blocking)
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("personas error: {e}")))?
            .map_err(|e| JsonRpcError::internal_error(e))?;

            Ok(json!({
                "personas": personas,
                "count": personas.len(),
                "_meta": {
                    "ttlMs": 120000,
                    "cacheScope": "user"
                }
            }))
        }

        "career_upsert_persona" => {
            let p_val = arguments
                .get("persona")
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'persona' object"))?;
            // `Persona` carries an unbounded `skill_weights` map and an
            // unbounded `tone_directive`; neither was capped.
            let persona_encoded = serde_json::to_string(p_val)
                .map_err(|e| JsonRpcError::invalid_params(format!("Unserializable persona: {e}")))?;
            bounded_bytes(&persona_encoded, "persona", MAX_BLOCK_JSON_BYTES)?;

            let persona: Persona = serde_json::from_value(p_val.clone())
                .map_err(|e| JsonRpcError::invalid_params(format!("Invalid Persona: {e}")))?;

            // `career_delete_persona` refuses to remove a built-in persona, but
            // upsert had no such guard — so a tool call could not delete `ai`
            // yet could replace its label, skill weights, template, section
            // order and tone directive wholesale. The invariant "built-in
            // personas are stable" was enforced on one path and not the other.
            // The user's own UI path is unaffected; this refuses only remote
            // callers.
            if career_db::is_seeded_persona_id(&persona.id) {
                return Err(JsonRpcError::invalid_params(format!(
                    "Persona '{}' is built-in and cannot be redefined over MCP; use a new id to create a custom persona",
                    persona.id
                )));
            }

            let pid = persona.id.clone();
            let db_clone = db.clone();
            tokio::task::spawn_blocking(move || {
                db_clone.with_conn(|conn| career_db::upsert_persona_blocking(conn, &persona))
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("upsert persona error: {e}")))?
            .map_err(|e| JsonRpcError::internal_error(e))?;

            Ok(json!({
                "success": true,
                "personaId": pid
            }))
        }

        "career_ingest_knowledge" => {
            let title =
                bounded_chars(require_str(arguments, "title")?, "title", MAX_LABEL_CHARS)?;
            let text = bounded_bytes(require_str(arguments, "text")?, "text", MAX_TEXT_BYTES)?;
            let source_type = optional_str(arguments, "source_type")?
                .map(|s| bounded_chars(s, "source_type", MAX_LABEL_CHARS))
                .transpose()?
                .unwrap_or("notes")
                .to_string();

            // `uri` is the dedup key: `upsert_prepared_source` matches an
            // existing row by it, then deletes every chunk (and embedding) whose
            // content hash is absent from the new payload and rewrites the
            // title. A caller that names an existing source therefore *destroys*
            // it — silently, with no confirmation, unlike `career_delete_block`.
            // Source URIs are readable from `career://kb/sources`, so the target
            // is trivially discoverable.
            //
            // MCP-ingested content now lives under its own namespace, so a tool
            // call cannot address a source ingested through the app. Replacing a
            // specific MCP-ingested source stays possible by passing its exact
            // `mcp://ingest/...` uri back.
            const MCP_INGEST_PREFIX: &str = "mcp://ingest/";
            let uri = match optional_str(arguments, "uri")? {
                None => format!("{MCP_INGEST_PREFIX}{}", Uuid::new_v4()),
                Some(supplied) => {
                    let supplied = bounded_chars(supplied, "uri", MAX_URI_CHARS)?;
                    if supplied.starts_with(MCP_INGEST_PREFIX) {
                        supplied.to_string()
                    } else {
                        return Err(JsonRpcError::invalid_params(format!(
                            "Argument 'uri' must begin with '{MCP_INGEST_PREFIX}' — a tool call may not overwrite a source ingested outside MCP. Omit 'uri' to create a new source."
                        )));
                    }
                }
            };

            let title_owned = title.to_string();
            let text_owned = text.to_string();
            let db_clone = db.clone();

            let report = tokio::task::spawn_blocking(move || {
                db_clone.with_conn(|conn| {
                    let digest = sha1::Sha1::digest(text_owned.as_bytes());
                    let hash = format!("{digest:x}");

                    // Chunk paragraphs
                    let paragraphs: Vec<&str> = text_owned.split("\n\n").filter(|s| !s.trim().is_empty()).collect();
                    let mut prepared_chunks = Vec::new();
                    for (i, p) in paragraphs.iter().enumerate() {
                        let cdigest = sha1::Sha1::digest(p.as_bytes());
                        prepared_chunks.push(career_db::ingest::PreparedChunk {
                            text: p.to_string(),
                            meta: json!({
                                "contentHash": format!("{cdigest:x}"),
                                "index": i
                            }),
                        });
                    }

                    let prepared = career_db::ingest::PreparedSource {
                        uri,
                        source_type,
                        title: title_owned,
                        content_hash: hash,
                        chunks: prepared_chunks,
                    };

                    career_db::ingest::upsert_prepared_source(conn, &prepared)
                })
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("ingest error: {e}")))?
            .map_err(|e| JsonRpcError::internal_error(e))?;

            Ok(json!({
                "sourceId": report.source_id,
                "chunkCount": report.chunk_count,
                "needsEmbedding": report.needs_embedding.len(),
                "skipped": report.skipped
            }))
        }

        _ => Err(JsonRpcError::method_not_found(name)),
    }
}

pub async fn read_career_resource(
    db: &career_db::CareerDbState,
    uri: &str,
) -> Result<Value, JsonRpcError> {
    let db_clone = db.clone();
    let uri_owned = uri.to_string();

    tokio::task::spawn_blocking(move || {
        db_clone.with_conn(|conn| {
            if uri_owned == "career://profile" {
                let blocks = career_db::list_blocks_blocking(conn, false)?;
                let personas = career_db::list_personas_blocking(conn)?;
                Ok(json!({
                    "uri": "career://profile",
                    "mimeType": "application/json",
                    "contents": json!({
                        "blocks": blocks,
                        "personas": personas,
                        "totalBlocks": blocks.len()
                    }),
                    "_meta": {
                        "ttlMs": 60000,
                        "cacheScope": "user"
                    }
                }))
            } else if uri_owned == "career://personas" {
                let personas = career_db::list_personas_blocking(conn)?;
                Ok(json!({
                    "uri": "career://personas",
                    "mimeType": "application/json",
                    "contents": personas,
                    "_meta": {
                        "ttlMs": 120000,
                        "cacheScope": "user"
                    }
                }))
            } else if uri_owned == "career://kb/sources" {
                let sources = career_db::ingest::list_kb_sources(conn)?;
                Ok(json!({
                    "uri": "career://kb/sources",
                    "mimeType": "application/json",
                    "contents": sources,
                    "_meta": {
                        "ttlMs": 60000,
                        "cacheScope": "user"
                    }
                }))
            } else if let Some(block_id) = uri_owned.strip_prefix("career://blocks/") {
                let blocks = career_db::list_blocks_blocking(conn, false)?;
                let block = blocks
                    .into_iter()
                    .find(|b| b.id == block_id)
                    .ok_or_else(|| format!("Block '{block_id}' not found"))?;
                Ok(json!({
                    "uri": uri_owned,
                    "mimeType": "application/json",
                    "contents": block,
                    "_meta": {
                        "ttlMs": 60000,
                        "cacheScope": "user"
                    }
                }))
            } else {
                Err(format!("Resource '{uri_owned}' not found"))
            }
        })
    })
    .await
    .map_err(|e| JsonRpcError::internal_error(format!("read resource task error: {e}")))?
    .map_err(|e| JsonRpcError::new(-32602, e))
}
