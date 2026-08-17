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

pub fn list_career_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "career_search_kb".to_string(),
            description: "Search the career knowledgebase across blocks, bullets, facts and KB chunks. Runs semantic vector search when an embedding provider is reachable and always runs a word-boundary lexical pass, merging both. The response reports `searchMode` and `semanticStatus` ('ran' / 'ran_no_matches' / 'unavailable' with a reason) so a lexical-only result is never mistaken for a semantic one. persona/domain/owner_kind filters apply to both passes.".to_string(),
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
            description: "Create or update an experience block (work, project, education, skill_group, leadership) in the candidate's career database.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "block": {
                        "type": "object",
                        "description": "The ExperienceBlock object to insert or update"
                    }
                },
                "required": ["block"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "career_delete_block".to_string(),
            description: "Delete an experience block and its associated embeddings. Requires MRTR confirmation when the block has bullets or facts; the returned request_state binds the confirmation to that specific block, and a follow-up naming a different block_id is rejected.".to_string(),
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
    name: &str,
    arguments: &Value,
) -> Result<Value, JsonRpcError> {
    match name {
        "career_search_kb" => {
            let query = arguments
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'query' argument"))?;
            // Bounded: `limit` reaches an over-fetch multiplier and a Vec
            // truncate, so an unbounded value is an allocation lever.
            const MAX_SEARCH_LIMIT: usize = 200;
            let limit = arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|n| (n as usize).clamp(1, MAX_SEARCH_LIMIT))
                .unwrap_or(10);

            let owner_kinds = arguments
                .get("owner_kinds")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                });

            let persona_id = arguments
                .get("persona_id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let domain = arguments
                .get("domain")
                .and_then(|v| v.as_str())
                .map(str::to_string);

            // Deliberately does NOT carry persona/domain down to `vector_search`:
            // `passes_block_filters` rejects every non-block owner kind when
            // either is set, which silently deleted all bullet/fact hits. The
            // parent-aware equivalent is applied to the returned hits below,
            // using the parent tags that `resolve_hit_text` puts in `meta`.
            let filter = career_db::SearchFilter {
                owner_kind: None,
                personas: None,
                domains: None,
                kinds: None,
                model: None,
            };

            // Semantic first. `career_search_kb` advertises vector search, and
            // the crate has both an embedder (`native_agent::ai_embed`) and a
            // real ANN/brute-force index (`career_db::vectors::vector_search`);
            // the previous implementation built a SearchFilter, discarded it,
            // and substring-matched instead.
            let embed = crate::native_agent::ai_embed(
                vec![query.to_string()],
                None,
                None,
                None,
                None,
            )
            .await;

            let mut semantic_hits: Vec<Value> = Vec::new();
            let mut semantic_error: Option<String> = None;
            match embed {
                Ok(vecs) if !vecs.is_empty() && !vecs[0].is_empty() => {
                    let qv = vecs[0].clone();
                    let db_v = db.clone();
                    let f = filter.clone();
                    let over_fetch = limit.saturating_mul(4).max(limit);
                    let res = tokio::task::spawn_blocking(move || {
                        db_v.with_conn(|conn| {
                            career_db::vector_search_blocking(conn, &qv, over_fetch, &f)
                        })
                    })
                    .await
                    .map_err(|e| JsonRpcError::internal_error(format!("vector task error: {e}")))?;

                    match res {
                        Ok(hits) => {
                            for h in hits {
                                // `vector_search` applies persona/domain filters
                                // only to block-kind owners, and knows nothing
                                // about owner_kinds, so both are enforced here.
                                // Without this, a filtered search returned
                                // semantic hits the lexical pass would exclude.
                                if let Some(kinds) = &owner_kinds {
                                    if !kinds.iter().any(|k| *k == h.owner_kind) {
                                        continue;
                                    }
                                }
                                // Block hits and child hits both carry the
                                // relevant tags in `meta`; a kb_chunk carries
                                // neither and so cannot satisfy such a filter.
                                let parent_ok = |key: &str, want: &Option<String>| -> bool {
                                    let Some(w) = want else { return true };
                                    match h.meta.get(key).and_then(|v| v.as_array()) {
                                        Some(arr) => {
                                            arr.iter().any(|v| v.as_str() == Some(w.as_str()))
                                        }
                                        None => false,
                                    }
                                };
                                if !parent_ok("personas", &persona_id)
                                    || !parent_ok("domains", &domain)
                                {
                                    continue;
                                }
                                semantic_hits.push(json!({
                                    "ownerId": h.owner_id,
                                    "ownerKind": h.owner_kind,
                                    "score": h.score,
                                    "matchedBy": "semantic",
                                    "text": h.text,
                                    "meta": h.meta,
                                }));
                            }
                        }
                        Err(e) => semantic_error = Some(e),
                    }
                }
                Ok(_) => semantic_error = Some("embedder returned no vector".to_string()),
                Err(e) => semantic_error = Some(e),
            }

            // Three distinct states, kept distinct: the semantic path could not
            // run; it ran and matched nothing; it ran and matched. Collapsing
            // the first two would make "no embedding provider" look identical
            // to "nothing in the index is relevant".
            let semantic_available = semantic_error.is_none();
            let semantic_hit_count = semantic_hits.len();
            let semantic_status = match (&semantic_error, semantic_hit_count) {
                (Some(_), _) => "unavailable",
                (None, 0) => "ran_no_matches",
                (None, _) => "ran",
            };

            // Lexical pass always runs: it is cheap, and it catches exact
            // identifiers that embeddings routinely miss. Results are merged,
            // never silently substituted.
            let query_owned = query.to_string();
            let db_clone = db.clone();
            let kinds_filter = owner_kinds.clone();
            let persona_f = persona_id.clone();
            let domain_f = domain.clone();
            let lexical = tokio::task::spawn_blocking(move || {
                db_clone.with_conn(|conn| {
                    let blocks = career_db::list_blocks_blocking(conn, false)?;
                    let mut scored: Vec<Value> = Vec::new();
                    let q = query_owned.trim();
                    // A natural-language query ("kubernetes experience at scale")
                    // matched nothing, because the whole phrase was required to
                    // appear contiguously. Match the phrase OR any significant
                    // token, so multi-word queries behave like a search box.
                    let tokens: Vec<String> = q
                        .split(|c: char| !c.is_alphanumeric() && c != '+' && c != '#' && c != '.')
                        .filter(|t| t.chars().count() > 2)
                        .map(|t| t.to_string())
                        .collect();
                    let hits_text = |hay: &str| -> bool {
                        if crate::career_match::text::text_covers_skill(hay, q) {
                            return true;
                        }
                        !tokens.is_empty()
                            && tokens
                                .iter()
                                .any(|t| crate::career_match::text::text_covers_skill(hay, t))
                    };

                    let wants = |kind: &str| -> bool {
                        kinds_filter.as_ref().is_none_or(|k| k.iter().any(|x| x == kind))
                    };

                    for block in blocks {
                        // Apply the persona/domain filters that were previously
                        // parsed and then dropped on the floor.
                        if let Some(p) = &persona_f {
                            if !block.personas.iter().any(|bp| bp == p) {
                                continue;
                            }
                        }
                        if let Some(d) = &domain_f {
                            if !block.domains.iter().any(|bd| bd == d) {
                                continue;
                            }
                        }

                        if wants("block") {
                            let head = format!(
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
                            if hits_text(&head) {
                                scored.push(json!({
                                    "ownerId": block.id,
                                    "ownerKind": "block",
                                    "score": 0.80,
                                    "matchedBy": "lexical",
                                    "scoreKind": "lexical_constant",
                                    "title": block.title,
                                    "org": block.org,
                                    "kind": block.kind,
                                    "personas": block.personas,
                                    "domains": block.domains,
                                }));
                            }
                        }

                        if wants("bullet") {
                            for bullet in &block.bullets {
                                if hits_text(&bullet.canonical) {
                                    scored.push(json!({
                                        "ownerId": bullet.id,
                                        "ownerKind": "bullet",
                                        "score": 0.90,
                                        "matchedBy": "lexical",
                                        "blockId": block.id,
                                        "text": bullet.canonical,
                                    }));
                                }
                            }
                        }

                        if wants("fact") {
                            for fact in &block.facts {
                                let hit = hits_text(&fact.text)
                                    || fact.skills.iter().any(|s| {
                                        crate::career_match::text::skills_match(s, q)
                                    });
                                if hit {
                                    scored.push(json!({
                                        "ownerId": fact.id,
                                        "ownerKind": "fact",
                                        "score": 0.95,
                                        "matchedBy": "lexical",
                                        "blockId": block.id,
                                        "text": fact.text,
                                    }));
                                }
                            }
                        }
                    }

                    // A KB chunk carries no persona or domain, so when either
                    // filter is set it cannot satisfy it and must be excluded
                    // rather than returned as an unfiltered extra.
                    if wants("kb_chunk") && persona_f.is_none() && domain_f.is_none() {
                        let chunks = career_db::ingest::list_kb_chunks(conn, None, false)?;
                        for chunk in chunks {
                            if hits_text(&chunk.text) {
                                scored.push(json!({
                                    "ownerId": chunk.id,
                                    "ownerKind": "kb_chunk",
                                    "score": 0.85,
                                    "matchedBy": "lexical",
                                    "sourceId": chunk.source_id,
                                    "snippet": chunk.text.chars().take(200).collect::<String>(),
                                }));
                            }
                        }
                    }

                    Ok(scored)
                })
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("search task error: {e}")))?
            .map_err(JsonRpcError::internal_error)?;

            // Merge, preferring the semantic score when both modes hit the same
            // owner, and de-duplicate by (ownerKind, ownerId).
            let mut merged: Vec<Value> = Vec::new();
            let mut seen: std::collections::HashSet<(String, String)> =
                std::collections::HashSet::new();
            for h in semantic_hits.into_iter().chain(lexical.into_iter()) {
                let key = (
                    h.get("ownerKind").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    h.get("ownerId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                );
                if seen.insert(key) {
                    merged.push(h);
                }
            }
            // Lexical "scores" are fixed confidence constants, not similarities.
            // Ranking them in the same ordering as real cosine values let a
            // constant 0.8 evict a genuine 0.66 semantic match under a small
            // limit, so the two families are ranked in separate tiers with
            // semantic first, and each tier sorted by its own score.
            merged.sort_by(|a, b| {
                let tier = |v: &Value| -> u8 {
                    if v.get("matchedBy").and_then(|m| m.as_str()) == Some("semantic") {
                        0
                    } else {
                        1
                    }
                };
                let sa = a.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let sb = b.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
                tier(a).cmp(&tier(b)).then_with(|| {
                    sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
                })
            });
            merged.truncate(limit);
            let count = merged.len();

            Ok(json!({
                "query": query,
                "hits": merged,
                "count": count,
                // A search that could not run semantically must not look like
                // one that did.
                "searchMode": if semantic_available { "semantic+lexical" } else { "lexical_only" },
                "semanticAvailable": semantic_available,
                "semanticStatus": semantic_status,
                "semanticHitCount": semantic_hit_count,
                "semanticUnavailableReason": semantic_error,
                "filtersApplied": {
                    "personaId": persona_id,
                    "domain": domain,
                    "ownerKinds": owner_kinds,
                },
                "_meta": {
                    "ttlMs": 30000,
                    "cacheScope": "user"
                }
            }))
        }

        "career_get_profile" => {
            let db_clone = db.clone();
            let persona_filter = arguments
                .get("persona_id")
                .and_then(|v| v.as_str())
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
            let block: ExperienceBlock = serde_json::from_value(block_val.clone())
                .map_err(|e| JsonRpcError::invalid_params(format!("Invalid ExperienceBlock schema: {e}")))?;

            let db_clone = db.clone();
            let block_id = block.id.clone();
            tokio::task::spawn_blocking(move || {
                db_clone.with_conn(|conn| career_db::upsert_block_blocking(conn, &block))
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("upsert block task error: {e}")))?
            .map_err(|e| JsonRpcError::internal_error(e))?;

            Ok(json!({
                "success": true,
                "blockId": block_id,
                "message": format!("Block '{block_id}' saved successfully")
            }))
        }

        "career_delete_block" => {
            let block_id = arguments
                .get("block_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'block_id' argument"))?;

            // Check if MRTR response or state was provided
            let input_responses = arguments.get("input_responses");
            let request_state = arguments.get("request_state").and_then(|v| v.as_str());

            if let Some(state_str) = request_state {
                // Decode stateless requestState
                let state_val = InputRequiredResult::decode_state(state_str)
                    .map_err(|e| JsonRpcError::new(crate::mcp::protocol::ERR_ELICITATION_FAILED, e))?;

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

                // The signed state is the authority on WHAT was confirmed.
                // Previously this fell back to the caller's `block_id` and then
                // reported that id as deleted, so a client could confirm
                // deleting block A and have block B's id echoed back, and a
                // state without a blockId would delete whatever the caller
                // named. Both defeat the confirmation gate.
                let bid = state_val
                    .get("blockId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        JsonRpcError::new(
                            crate::mcp::protocol::ERR_ELICITATION_FAILED,
                            "request_state carries no blockId; re-run the deletion to obtain a \
                             fresh confirmation".to_string(),
                        )
                    })?
                    .to_string();
                if bid != block_id {
                    return Err(JsonRpcError::invalid_params(format!(
                        "block_id '{block_id}' does not match the confirmed block '{bid}'. \
                         Re-run the deletion for the block you intend to delete."
                    )));
                }

                let db_clone = db.clone();
                let bid_for_delete = bid.clone();
                tokio::task::spawn_blocking(move || {
                    db_clone
                        .with_conn(|conn| career_db::delete_block_blocking(conn, &bid_for_delete))
                })
                .await
                .map_err(|e| JsonRpcError::internal_error(format!("delete task error: {e}")))?
                .map_err(|e| JsonRpcError::internal_error(e))?;

                return Ok(json!({
                    "success": true,
                    "deletedBlockId": bid,
                    "message": format!("Block '{bid}' and all associated embeddings deleted")
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

                let mrtr = InputRequiredResult::new(requests, &state_payload)
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
            let text = arguments
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'text' argument"))?;
            let source = arguments
                .get("source")
                .and_then(|v| v.as_str())
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

                // The tool description promises extracted skills; this used to
                // hardcode an empty vec. Extraction reuses the same controlled
                // vocabulary and word-boundary matcher the JD scanner uses, so
                // fact skills and JD requirements are directly comparable.
                let skills = crate::career_match::jd::skills_in_text(trimmed);

                facts.push(BlockFact {
                    id: format!("fact-{}", Uuid::new_v4().to_string().chars().take(8).collect::<String>()),
                    text: trimmed.to_string(),
                    skills,
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
            let block_id = arguments
                .get("block_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'block_id'"))?;
            let facts_val = arguments
                .get("facts")
                .and_then(|v| v.as_array())
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'facts' array"))?;

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
            let persona: Persona = serde_json::from_value(p_val.clone())
                .map_err(|e| JsonRpcError::invalid_params(format!("Invalid Persona: {e}")))?;

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
            let title = arguments
                .get("title")
                .and_then(|v| v.as_str())
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'title'"))?;
            let text = arguments
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'text'"))?;
            let source_type = arguments
                .get("source_type")
                .and_then(|v| v.as_str())
                .unwrap_or("notes")
                .to_string();
            let uri = arguments
                .get("uri")
                .and_then(|v| v.as_str())
                .unwrap_or("notes://direct")
                .to_string();

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
