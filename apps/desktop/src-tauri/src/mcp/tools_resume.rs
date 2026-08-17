//! Résumé synthesis MCP tools — the harness surface over the real pipeline.
//!
//! Every tool here delegates to [`crate::career_match`], the deterministic core
//! ported from `src/lib/resume-synthesis/`. Nothing in this file computes a
//! score, a coverage figure, or a compile result on its own.
//!
//! ## Who supplies the language
//!
//! Two of the seven stages need a model: JD analysis and bullet rewriting.
//! Every tool accepts an optional `language` argument selecting the provider:
//!
//! ```json
//! {"mode": "deterministic"}                          // default, no model
//! {"mode": "agent"}                                  // the MCP client rewrites
//! {"mode": "ollama", "model": "qwen3.5:27b"}         // local, zero external tokens
//! ```
//!
//! In `agent` mode the harness drives the loop: call `resume_score_and_select`
//! to learn what to write, rewrite the bullets yourself, then submit them to
//! `resume_verify_rewrite`, which enforces metric preservation and the budget
//! and tells you exactly what was rejected and why. A rejected bullet falls
//! back to the candidate's own canonical text — the pipeline degrades to
//! verified truth, never to invention.
//!
//! Tools:
//! - `resume_analyze_jd` — JD → canonical `JDProfile`.
//! - `resume_gap_analysis` — coverage of must/nice-to-have skills, with evidence.
//! - `resume_score_and_select` — hybrid scoring + knapsack selection + bullet trim.
//! - `resume_rewrite_bullets` — tailor one block's bullets under verification.
//! - `resume_verify_rewrite` — the agent-driven gate (accept/reject + reason).
//! - `resume_synthesize` — the full pipeline through to a compiled PDF.
//! - `resume_compile` — compile Typst source with the in-process engine.
//! - `resume_finetune_bullet` — analyse one bullet; never rewrites it.

use crate::career_db::{self, ExperienceBlock, Persona};
use crate::career_match::language::{
    verify_rewrite, LanguageProvider, RewrittenBullet,
    DEFAULT_PER_BULLET_CHARS,
};
use crate::career_match::selection::{self, SelectionBudget, TrimOptions};
use crate::career_match::typst_emit::{self, HeaderFields, RenderBlock};
use crate::career_match::{jd::JdProfile, now_year_month, scoring};
use crate::career_typst::engine;
use crate::mcp::protocol::{
    JsonRpcError, PromptArgument, PromptDefinition, ResponseMeta, ToolDefinition,
};
use crate::mcp::tasks::TaskManager;
use base64::prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// Shared schema fragment for the language-provider argument.
fn language_schema() -> Value {
    json!({
        "type": "object",
        "description": "Which provider supplies natural language. Omit for deterministic (no model, canonical bullets).",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["deterministic", "agent", "ollama"],
                "description": "'deterministic' = lexicon extraction + canonical bullets; 'agent' = you supply text and submit it to resume_verify_rewrite; 'ollama' = a local model runs in-process at zero external token cost."
            },
            "model": { "type": "string", "description": "Ollama model tag, e.g. 'qwen3.5:27b'. Defaults to the first installed chat model." },
            "baseUrl": { "type": "string", "description": "Ollama base URL (default http://localhost:11434)." },
            "numCtx": { "type": "integer", "description": "Context window. Ollama's default (2048) silently truncates long JDs." },
            "temperature": { "type": "number", "description": "Sampling temperature (default 0.1 for extraction fidelity)." }
        }
    })
}

fn header_schema() -> Value {
    json!({
        "type": "object",
        "description": "Contact header. Omitted fields are simply left off the page.",
        "properties": {
            "name": { "type": "string" },
            "email": { "type": "string" },
            "phone": { "type": "string" },
            "location": { "type": "string" },
            "links": { "type": "array", "items": { "type": "string" } }
        }
    })
}

pub fn list_resume_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "resume_analyze_jd".to_string(),
            description: "Analyze a job description into the canonical JDProfile: role title, seniority, must-have and nice-to-have skills, domains, ATS keywords, tone signals, and responsibility/qualification extracts. Reports whether the profile came from a model or the deterministic lexicon extractor.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "jd_text": { "type": "string", "description": "Full text of the job description" },
                    "language": language_schema()
                },
                "required": ["jd_text"]
            }),
            _meta: Some(ResponseMeta {
                ttl_ms: Some(300_000),
                cache_scope: Some("public".to_string()),
                extra: HashMap::new(),
            }),
        },
        ToolDefinition {
            name: "resume_gap_analysis".to_string(),
            description: "Compare the career knowledgebase against a job description: which must-have and nice-to-have skills are covered, which are missing, and which blocks provide the evidence. Skill matching is word-boundary aware, so 'Go' does not match 'Django'.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "jd_text": { "type": "string" },
                    "persona_id": { "type": "string", "description": "Persona to bias scoring (default: first persona in the DB)" },
                    "language": language_schema()
                },
                "required": ["jd_text"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_score_and_select".to_string(),
            description: "Score every experience block against the JD (0.40 embedding + 0.30 skills + 0.15 persona + 0.10 recency + 0.05 seniority) and select the set that fits the page budget using greedy knapsack with per-section caps, a one-block-per-org rule, and must-have coverage swaps. Returns the per-component score breakdown and the trimmed bullet set.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "jd_text": { "type": "string" },
                    "persona_id": { "type": "string" },
                    "page_budget": { "type": "integer", "description": "1 (default) or 2 pages" },
                    "max_bullets_per_block": { "type": "integer", "description": "Default 4" },
                    "language": language_schema()
                },
                "required": ["jd_text"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_rewrite_bullets".to_string(),
            description: "Tailor one block's bullets to the JD. Every candidate is verified before acceptance: ground-truth metrics must survive, the character budget must hold, and locked bullets are never touched. Rejected candidates fall back to the canonical text with the reason reported. In 'deterministic' and 'agent' modes this returns the canonical bullets plus the work order to rewrite them.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "block_id": { "type": "string" },
                    "jd_text": { "type": "string" },
                    "bullet_ids": { "type": "array", "items": { "type": "string" }, "description": "Defaults to every bullet in the block" },
                    "per_bullet_chars": { "type": "integer", "description": "Character budget per bullet (default 140)" },
                    "language": language_schema()
                },
                "required": ["block_id", "jd_text"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_verify_rewrite".to_string(),
            description: "Verify agent-written bullets against the knowledgebase before they reach the page. For each submitted bullet: confirms every ground-truth metric on the canonical bullet still appears (rejecting inflation such as 25% becoming 125%), enforces the character budget, and refuses to alter locked bullets. Returns accepted text or the rejection reason plus the exact metrics dropped. This is the gate that makes agent-driven rewriting safe.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "bullets": {
                        "type": "array",
                        "description": "Candidate rewrites keyed by canonical bullet id",
                        "items": {
                            "type": "object",
                            "properties": {
                                "bullet_id": { "type": "string" },
                                "text": { "type": "string", "description": "Your rewritten bullet" }
                            },
                            "required": ["bullet_id", "text"]
                        }
                    },
                    "per_bullet_chars": { "type": "integer", "description": "Character budget per bullet (default 140)" }
                },
                "required": ["bullets"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_synthesize".to_string(),
            description: "Run the full pipeline: JD analysis, hybrid scoring, knapsack selection, bullet trim, verified rewrite, Typst materialization, and in-process compilation to PDF. Returns the Typst source, the PDF byte length, and a match report whose coverage and rewrite counts are measured, not assumed. Supports async execution via the Tasks extension.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "jd_text": { "type": "string" },
                    "persona_id": { "type": "string" },
                    "page_budget": { "type": "integer", "description": "1 (default) or 2" },
                    "header": header_schema(),
                    "summary": { "type": "string", "description": "Optional summary paragraph" },
                    "include_pdf": { "type": "boolean", "description": "Return base64 PDF bytes (default false; the byte length and page count are always returned)" },
                    "async": { "type": "boolean", "description": "Run as a background task and return a taskId" },
                    "language": language_schema()
                },
                "required": ["jd_text"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_compile".to_string(),
            description: "Compile Typst résumé source to PDF with the sandboxed in-process engine. The sandbox resolves exactly one file, so imports, package loads and filesystem reads all fail closed. Returns page count, diagnostics with 1-based line/column, and optionally the PDF bytes.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "typst_source": { "type": "string", "description": "Typst document source" },
                    "include_pdf": { "type": "boolean", "description": "Return base64 PDF bytes (default true)" }
                },
                "required": ["typst_source"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_finetune_bullet".to_string(),
            description: "Analyze a single bullet against the Google X-Y-Z formula and the JD's keywords: reports whether it carries a metric, whether it opens with a strong action verb, its length against the budget, and which JD keywords it already echoes. Returns analysis only — it never rewrites the bullet and never invents a metric.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "bullet_text": { "type": "string" },
                    "jd_text": { "type": "string" },
                    "per_bullet_chars": { "type": "integer", "description": "Character budget (default 140)" }
                },
                "required": ["bullet_text", "jd_text"]
            }),
            _meta: None,
        },
    ]
}

// --- Prompts -------------------------------------------------------------

pub fn list_resume_prompts() -> Vec<PromptDefinition> {
    vec![
        PromptDefinition {
            name: "tailor-resume-for-jd".to_string(),
            description: Some("Drive the full résumé pipeline for a job description.".to_string()),
            arguments: vec![
                PromptArgument { name: "jd_text".to_string(), description: Some("Target job description".to_string()), required: true },
                PromptArgument { name: "persona_id".to_string(), description: Some("Persona id".to_string()), required: false },
            ],
            _meta: None,
        },
        PromptDefinition {
            name: "agent-rewrite-loop".to_string(),
            description: Some("Rewrite bullets yourself and have them verified against the knowledgebase.".to_string()),
            arguments: vec![
                PromptArgument { name: "jd_text".to_string(), description: Some("Target job description".to_string()), required: true },
                PromptArgument { name: "block_id".to_string(), description: Some("Block to rewrite".to_string()), required: false },
            ],
            _meta: None,
        },
        PromptDefinition {
            name: "audit-resume-against-jd".to_string(),
            description: Some("Audit candidate background against a JD.".to_string()),
            arguments: vec![PromptArgument {
                name: "jd_text".to_string(),
                description: Some("Target job description".to_string()),
                required: true,
            }],
            _meta: None,
        },
        PromptDefinition {
            name: "distill-career-notes".to_string(),
            description: Some("Distill raw career notes into structured facts.".to_string()),
            arguments: vec![PromptArgument {
                name: "notes".to_string(),
                description: Some("Raw notes".to_string()),
                required: true,
            }],
            _meta: None,
        },
    ]
}

fn user_message(description: &str, text: String) -> Value {
    json!({
        "description": description,
        "messages": [{ "role": "user", "content": { "type": "text", "text": text } }]
    })
}

pub fn get_resume_prompt(
    name: &str,
    arguments: &HashMap<String, String>,
) -> Result<Value, JsonRpcError> {
    let arg = |k: &str| arguments.get(k).cloned().unwrap_or_default();
    match name {
        "tailor-resume-for-jd" => {
            let jd = arg("jd_text");
            let persona = arguments.get("persona_id").cloned().unwrap_or_else(|| "(default)".into());
            Ok(user_message(
                "Tailor a résumé for this JD",
                format!(
                    "Tailor my résumé for the job description below (persona: {persona}).\n\n\
                     === JOB DESCRIPTION ===\n{jd}\n\n\
                     Work in this order:\n\
                     1. `resume_analyze_jd` — confirm the extracted must-have skills look right.\n\
                     2. `resume_gap_analysis` — see what my background does and does not cover.\n\
                     3. `resume_score_and_select` — get the selected blocks and their trimmed bullets.\n\
                     4. For each selected block, rewrite the bullets yourself, then submit them to \
                     `resume_verify_rewrite`. Preserve every figure exactly; anything you drop or \
                     inflate will be rejected and fall back to my original wording.\n\
                     5. `resume_synthesize` — produce the compiled document.\n\n\
                     Report honestly which bullets were accepted and which fell back, and never \
                     introduce a metric, employer, or technology that is not already in my \
                     knowledgebase."
                ),
            ))
        }
        "agent-rewrite-loop" => {
            let jd = arg("jd_text");
            let block = arguments.get("block_id").cloned().unwrap_or_else(|| "(all selected)".into());
            Ok(user_message(
                "Agent-driven verified rewrite",
                format!(
                    "Rewrite my résumé bullets for this JD, block {block}.\n\n\
                     === JOB DESCRIPTION ===\n{jd}\n\n\
                     Call `resume_rewrite_bullets` with `language: {{\"mode\":\"agent\"}}` to get the \
                     canonical bullets and their protected figures. Rewrite each one, then submit \
                     via `resume_verify_rewrite`.\n\n\
                     Rules the verifier enforces (so write to them):\n\
                     - Every figure listed for a bullet must appear unchanged. Rounding, inflating, \
                     or dropping one is a rejection.\n\
                     - Stay within the character budget.\n\
                     - Locked bullets are returned unchanged whatever you submit.\n\n\
                     Iterate on rejections until every bullet is accepted or you can explain why \
                     the canonical text is the better choice."
                ),
            ))
        }
        "audit-resume-against-jd" => Ok(user_message(
            "Audit candidate background against JD",
            format!(
                "Audit my background against this job description:\n\n=== JOB DESCRIPTION ===\n{}\n\n\
                 Call `resume_gap_analysis` and `career_search_kb`, then report must-have coverage, \
                 the specific missing skills, and which of my experiences best offset them. Do not \
                 soften a gap that is real.",
                arg("jd_text")
            ),
        )),
        "distill-career-notes" => Ok(user_message(
            "Distill raw career notes into structured facts",
            format!(
                "Distill these career notes into atomic structured facts using \
                 `career_distill_facts`. Keep every figure exactly as written and flag any claim \
                 that has no evidence behind it.\n\n=== RAW NOTES ===\n{}",
                arg("notes")
            ),
        )),
        _ => Err(JsonRpcError::method_not_found(name)),
    }
}

// --- Shared helpers ------------------------------------------------------

/// Blocks + the persona to score against.
struct MatchContext {
    blocks: Vec<ExperienceBlock>,
    persona: Persona,
}

/// A persona used when the DB has none, so scoring still runs.
fn fallback_persona(id: &str) -> Persona {
    Persona {
        id: id.to_string(),
        label: id.to_string(),
        skill_weights: serde_json::Map::new(),
        default_template_id: "typst-ats-single-column".to_string(),
        section_order: Vec::new(),
        tone_directive: String::new(),
    }
}

fn load_context(
    db: &career_db::CareerDbState,
    persona_id: Option<String>,
) -> Result<MatchContext, String> {
    db.with_conn(|conn| {
        let blocks = career_db::list_blocks_blocking(conn, false)?;
        let personas = career_db::list_personas_blocking(conn)?;
        let persona = match persona_id.as_deref() {
            Some(id) => personas
                .iter()
                .find(|p| p.id == id)
                .cloned()
                .unwrap_or_else(|| fallback_persona(id)),
            None => personas
                .first()
                .cloned()
                .unwrap_or_else(|| fallback_persona("default")),
        };
        Ok(MatchContext { blocks, persona })
    })
}

async fn load_context_async(
    db: &career_db::CareerDbState,
    persona_id: Option<String>,
) -> Result<MatchContext, JsonRpcError> {
    let db = db.clone();
    tokio::task::spawn_blocking(move || load_context(&db, persona_id))
        .await
        .map_err(|e| JsonRpcError::internal_error(format!("career db task failed: {e}")))?
        .map_err(JsonRpcError::internal_error)
}

/// Selection budget for a page count.
///
/// Line totals come from the shipped Typst ATS templates
/// (`typst-ats.ts`: 55 lines single-column). A second page adds a full page of
/// body lines without repeating the header overhead.
fn budget_for(page_budget: usize, per_bullet_chars: usize) -> SelectionBudget {
    let pages = page_budget.clamp(1, 2);
    let total = if pages == 1 { 55 } else { 55 + 48 };
    let mut caps: HashMap<String, usize> = HashMap::new();
    caps.insert("experience".into(), 3 * pages);
    caps.insert("projects".into(), 2 * pages);
    caps.insert("education".into(), 2);
    caps.insert("leadership".into(), pages);
    caps.insert("publications".into(), 2 * pages);
    SelectionBudget::from_template(total, per_bullet_chars, caps)
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    arg_str(args, key)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| JsonRpcError::invalid_params(format!("Missing required '{key}'")))
}

fn arg_usize(args: &Value, key: &str, default: usize) -> usize {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(default)
}

fn arg_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn per_bullet_chars(args: &Value) -> usize {
    arg_usize(args, "per_bullet_chars", DEFAULT_PER_BULLET_CHARS)
}

fn header_from_args(args: &Value) -> HeaderFields {
    let h = args.get("header");
    let get = |k: &str| {
        h.and_then(|v| v.get(k))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    HeaderFields {
        name: get("name"),
        email: get("email"),
        phone: get("phone"),
        location: get("location"),
        links: h
            .and_then(|v| v.get("links"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Embedding similarity per block, or `None` when semantic matching is off.
async fn embedding_scores(
    db: &career_db::CareerDbState,
    provider: &LanguageProvider,
    jd_text: &str,
) -> Option<HashMap<String, f64>> {
    let query = provider.embed_query(jd_text).await?;
    let db = db.clone();
    let hits = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            career_db::vectors::vector_search(
                conn,
                &query,
                64,
                &career_db::vectors::SearchFilter {
                    owner_kind: Some("block".to_string()),
                    personas: None,
                    domains: None,
                    kinds: None,
                    model: None,
                },
            )
        })
    })
    .await
    .ok()?
    .ok()?;
    if hits.is_empty() {
        return None;
    }
    Some(
        hits.into_iter()
            .map(|h| (h.owner_id, (h.score as f64).clamp(0.0, 1.0)))
            .collect(),
    )
}

/// Everything the selection stage produced, reused by several tools.
struct Selection {
    profile: JdProfile,
    notices: Vec<String>,
    semantic_disabled: bool,
    scored: Vec<scoring::ScoredBlock>,
    selected: Vec<scoring::ScoredBlock>,
    uncovered_must_haves: Vec<String>,
    swaps: Vec<selection::SwapRecord>,
    budget: SelectionBudget,
}

async fn run_selection(
    db: &career_db::CareerDbState,
    provider: &LanguageProvider,
    jd_text: &str,
    persona_id: Option<String>,
    page_budget: usize,
    max_bullets: usize,
    per_bullet: usize,
) -> Result<(MatchContext, Selection), JsonRpcError> {
    let ctx = load_context_async(db, persona_id).await?;
    let (profile, mut notices) = provider.analyze_jd(jd_text).await;

    let embeddings = embedding_scores(db, provider, jd_text).await;
    let semantic_disabled = embeddings.is_none();
    if semantic_disabled {
        notices.push(
            "Semantic matching is unavailable (no local embedding model or no stored block embeddings); the embedding weight was renormalized away rather than counted as zero similarity."
                .to_string(),
        );
    }
    let embeddings = embeddings.unwrap_or_default();

    let (year, month) = now_year_month();
    let scored = scoring::score_blocks(
        &ctx.blocks,
        &profile,
        &ctx.persona,
        &embeddings,
        semantic_disabled,
        year,
        month,
    );

    let budget = budget_for(page_budget, per_bullet);
    let result = selection::knapsack_select(&scored, &budget, &profile.must_have_skills, None);

    let relevance: HashMap<String, f64> = HashMap::new();
    let selected = selection::trim_selected_bullets(
        &result.selected,
        &TrimOptions {
            max_bullets_per_block: max_bullets,
            relevance_by_bullet_id: &relevance,
            must_have_skills: &profile.must_have_skills,
        },
    );

    Ok((
        ctx,
        Selection {
            profile,
            notices,
            semantic_disabled,
            scored,
            selected,
            uncovered_must_haves: result.uncovered_must_haves,
            swaps: result.swaps,
            budget,
        },
    ))
}

fn scored_block_json(s: &scoring::ScoredBlock) -> Value {
    json!({
        "blockId": s.block.id,
        "title": s.block.title,
        "org": s.block.org,
        "kind": s.block.kind,
        "section": selection::section_for_block(&s.block),
        "score": s.score,
        "components": s.components,
        "estimatedLines": selection::estimate_block_lines(&s.block),
        "bulletIds": s.block.bullets.iter().map(|b| b.id.clone()).collect::<Vec<_>>(),
    })
}

/// Which selected blocks provide evidence for a skill.
fn evidence_for(selected: &[scoring::ScoredBlock], skill: &str) -> Vec<String> {
    selected
        .iter()
        .filter(|s| selection::covers_skill(&s.block, skill))
        .map(|s| s.block.id.clone())
        .collect()
}

// --- Tool dispatch -------------------------------------------------------

pub async fn execute_resume_tool(
    db: &career_db::CareerDbState,
    task_manager: &Arc<TaskManager>,
    name: &str,
    arguments: &Value,
) -> Result<Value, JsonRpcError> {
    match name {
        "resume_analyze_jd" => {
            let jd_text = require_str(arguments, "jd_text")?;
            let provider = LanguageProvider::from_args(arguments.get("language"));
            let (profile, notices) = provider.analyze_jd(jd_text).await;
            Ok(json!({
                "profile": profile,
                "source": provider.label(),
                "notices": notices,
                "extractionEmpty": profile.is_extraction_empty(),
                "_meta": { "ttlMs": 300_000, "cacheScope": "public" }
            }))
        }

        "resume_gap_analysis" => {
            let jd_text = require_str(arguments, "jd_text")?;
            let provider = LanguageProvider::from_args(arguments.get("language"));
            let persona_id = arg_str(arguments, "persona_id").map(str::to_string);
            let (ctx, sel) = run_selection(
                db,
                &provider,
                jd_text,
                persona_id,
                arg_usize(arguments, "page_budget", 1),
                selection::DEFAULT_MAX_BULLETS_PER_BLOCK,
                per_bullet_chars(arguments),
            )
            .await?;

            // Coverage is measured against the whole knowledgebase, so a gap
            // here is a real gap rather than a selection artifact.
            let all: Vec<scoring::ScoredBlock> = sel.scored.clone();
            let classify = |skills: &[String]| -> (Vec<Value>, Vec<String>) {
                let mut covered = Vec::new();
                let mut missing = Vec::new();
                for s in skills {
                    let evidence = evidence_for(&all, s);
                    if evidence.is_empty() {
                        missing.push(s.clone());
                    } else {
                        covered.push(json!({ "skill": s, "evidenceBlockIds": evidence }));
                    }
                }
                (covered, missing)
            };
            let (must_covered, must_missing) = classify(&sel.profile.must_have_skills);
            let (nice_covered, nice_missing) = classify(&sel.profile.nice_to_have_skills);

            let must_total = sel.profile.must_have_skills.len();
            // An empty must-have list means "unknown", not "100% covered".
            let coverage = if must_total == 0 {
                Value::Null
            } else {
                json!(((must_covered.len() as f64 / must_total as f64) * 1000.0).round() / 10.0)
            };

            let mut warnings = sel.notices.clone();
            if must_total == 0 {
                warnings.push(
                    "The JD yielded no must-have skills, so coverage is unknown rather than complete."
                        .to_string(),
                );
            }
            if !must_missing.is_empty() {
                warnings.push(format!(
                    "{} required skill(s) have no supporting evidence anywhere in the knowledgebase: {}",
                    must_missing.len(),
                    must_missing.join(", ")
                ));
            }

            Ok(json!({
                "personaId": ctx.persona.id,
                "source": provider.label(),
                "coveragePercentage": coverage,
                "mustHave": { "total": must_total, "covered": must_covered, "missing": must_missing },
                "niceToHave": {
                    "total": sel.profile.nice_to_have_skills.len(),
                    "covered": nice_covered,
                    "missing": nice_missing
                },
                "uncoveredAfterSelection": sel.uncovered_must_haves,
                "blocksInKnowledgebase": ctx.blocks.len(),
                "warnings": warnings
            }))
        }

        "resume_score_and_select" => {
            let jd_text = require_str(arguments, "jd_text")?;
            let provider = LanguageProvider::from_args(arguments.get("language"));
            let persona_id = arg_str(arguments, "persona_id").map(str::to_string);
            let page_budget = arg_usize(arguments, "page_budget", 1);
            let (ctx, sel) = run_selection(
                db,
                &provider,
                jd_text,
                persona_id,
                page_budget,
                arg_usize(
                    arguments,
                    "max_bullets_per_block",
                    selection::DEFAULT_MAX_BULLETS_PER_BLOCK,
                ),
                per_bullet_chars(arguments),
            )
            .await?;

            let used_lines: usize = sel
                .selected
                .iter()
                .map(|s| selection::estimate_block_lines(&s.block))
                .sum();

            Ok(json!({
                "personaId": ctx.persona.id,
                "source": provider.label(),
                "semanticMatchingDisabled": sel.semantic_disabled,
                "profile": sel.profile,
                "pageBudget": page_budget.clamp(1, 2),
                "lineBudget": sel.budget.total_lines,
                "estimatedLinesUsed": used_lines,
                "selectedBlocks": sel.selected.iter().map(scored_block_json).collect::<Vec<_>>(),
                "allScores": sel.scored.iter().map(scored_block_json).collect::<Vec<_>>(),
                "mustHaveSwaps": sel.swaps,
                "uncoveredMustHaves": sel.uncovered_must_haves,
                "budgetViolations": selection::budget_violations(&sel.selected, &sel.budget),
                "notices": sel.notices
            }))
        }

        "resume_rewrite_bullets" => {
            let block_id = require_str(arguments, "block_id")?.to_string();
            let jd_text = require_str(arguments, "jd_text")?;
            let provider = LanguageProvider::from_args(arguments.get("language"));
            let per_bullet = per_bullet_chars(arguments);
            let wanted: Option<Vec<String>> = arguments
                .get("bullet_ids")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect());

            let ctx = load_context_async(db, None).await?;
            let mut block = ctx
                .blocks
                .iter()
                .find(|b| b.id == block_id)
                .cloned()
                .ok_or_else(|| {
                    JsonRpcError::invalid_params(format!("Block '{block_id}' not found"))
                })?;
            if let Some(ids) = &wanted {
                block.bullets.retain(|b| ids.contains(&b.id));
                if block.bullets.is_empty() {
                    return Err(JsonRpcError::invalid_params(
                        "No bullets in this block matched 'bullet_ids'",
                    ));
                }
            }

            let (profile, notices) = provider.analyze_jd(jd_text).await;
            let rewritten = provider.rewrite_block(&block, &profile, per_bullet).await;

            let accepted = rewritten.iter().filter(|b| b.ai_generated).count();
            Ok(json!({
                "blockId": block.id,
                "title": block.title,
                "org": block.org,
                "source": provider.label(),
                "bullets": rewritten,
                "acceptedCount": accepted,
                "canonicalFallbackCount": rewritten.len() - accepted,
                // In agent mode the caller is the model: hand it the work order.
                "workOrder": match provider {
                    LanguageProvider::Agent => json!({
                        "instructions": "Rewrite each bullet below, then submit them to `resume_verify_rewrite`. Every figure listed under `protectedMetrics` must appear unchanged or the bullet is rejected.",
                        "perBulletChars": per_bullet,
                        "targetRole": profile.role_title,
                        "atsKeywords": profile.ats_keywords,
                        "bullets": block.bullets.iter().map(|b| json!({
                            "bulletId": b.id,
                            "canonical": b.canonical,
                            "locked": b.locked,
                            "protectedMetrics": b.metrics.iter().map(|m| m.value.clone()).collect::<Vec<_>>(),
                        })).collect::<Vec<_>>()
                    }),
                    _ => Value::Null,
                },
                "notices": notices
            }))
        }

        "resume_verify_rewrite" => {
            let submitted = arguments
                .get("bullets")
                .and_then(Value::as_array)
                .ok_or_else(|| JsonRpcError::invalid_params("Missing required 'bullets' array"))?;
            if submitted.is_empty() {
                return Err(JsonRpcError::invalid_params("'bullets' must not be empty"));
            }
            let per_bullet = per_bullet_chars(arguments);

            let ctx = load_context_async(db, None).await?;
            // bulletId → (block, bullet), so a submission is matched against
            // the real canonical text rather than anything the caller claims.
            let mut index = HashMap::new();
            for b in &ctx.blocks {
                for bullet in &b.bullets {
                    index.insert(bullet.id.clone(), (b.id.clone(), bullet.clone()));
                }
            }

            let mut results = Vec::new();
            let mut accepted = 0usize;
            let mut unknown = 0usize;
            for item in submitted {
                let Some(id) = item.get("bullet_id").and_then(Value::as_str) else {
                    return Err(JsonRpcError::invalid_params(
                        "Every entry in 'bullets' needs a 'bullet_id'",
                    ));
                };
                let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                let Some((block_id, bullet)) = index.get(id) else {
                    unknown += 1;
                    results.push(json!({
                        "bulletId": id,
                        "accepted": false,
                        "reason": "unknown-bullet",
                        "detail": "No bullet with this id exists in the knowledgebase, so there is no canonical text to verify against."
                    }));
                    continue;
                };
                match verify_rewrite(bullet, text, per_bullet) {
                    Ok(accepted_text) => {
                        accepted += 1;
                        results.push(json!({
                            "bulletId": id,
                            "blockId": block_id,
                            "accepted": true,
                            "text": accepted_text,
                            "canonical": bullet.canonical,
                        }));
                    }
                    Err((reason, dropped)) => {
                        results.push(json!({
                            "bulletId": id,
                            "blockId": block_id,
                            "accepted": false,
                            "reason": reason.as_str(),
                            "droppedMetrics": dropped,
                            "text": bullet.canonical,
                            "canonical": bullet.canonical,
                            "detail": "Rejected. The canonical text is returned in `text`; fix the listed problem and resubmit if you want the tailored wording."
                        }));
                    }
                }
            }

            Ok(json!({
                "results": results,
                "submitted": submitted.len(),
                "accepted": accepted,
                "rejected": submitted.len() - accepted,
                "unknownBullets": unknown,
                "perBulletChars": per_bullet
            }))
        }

        "resume_synthesize" => {
            let jd_text = require_str(arguments, "jd_text")?.to_string();
            if arg_bool(arguments, "async", false) {
                let handle = task_manager.create_task("resume_synthesize", Some(600));
                let task_id = handle.task_id.clone();
                let task_mgr = Arc::clone(task_manager);
                let db = db.clone();
                let args = arguments.clone();
                let cancel_probe = handle.clone();

                tokio::spawn(async move {
                    task_mgr.update_progress(
                        &task_id,
                        0.15,
                        Some("Analyzing the job description".to_string()),
                    );
                    if cancel_probe.is_cancelled() {
                        return;
                    }
                    match synthesize(&db, &args, &jd_text, Some((&task_mgr, &task_id))).await {
                        Ok(v) => task_mgr.complete_task(&task_id, v),
                        Err(e) => task_mgr.fail_task(&task_id, e.message.clone()),
                    }
                });

                return Ok(json!({
                    "taskId": handle.task_id,
                    "status": "working",
                    "message": "Synthesis started. Poll with 'tasks/get'."
                }));
            }
            synthesize(db, arguments, &jd_text, None).await
        }

        "resume_compile" => {
            let source = require_str(arguments, "typst_source")?.to_string();
            let include_pdf = arg_bool(arguments, "include_pdf", true);
            let result = tokio::task::spawn_blocking(move || engine::compile_resume_pdf(&source))
                .await
                .map_err(|e| JsonRpcError::internal_error(format!("compile task failed: {e}")))?;

            let byte_length = result.pdf_bytes.as_ref().map(Vec::len).unwrap_or(0);
            Ok(json!({
                "engine": "typst",
                "success": result.success,
                "pageCount": result.page_count,
                "errors": result.errors,
                "warnings": result.warnings,
                "durationMs": result.duration_ms,
                "byteLength": byte_length,
                "pdfBase64": if include_pdf {
                    result.pdf_bytes.as_ref().map(|b| BASE64_STANDARD.encode(b)).map(Value::String).unwrap_or(Value::Null)
                } else {
                    Value::Null
                }
            }))
        }

        "resume_finetune_bullet" => {
            let bullet_text = require_str(arguments, "bullet_text")?;
            let jd_text = require_str(arguments, "jd_text")?;
            let per_bullet = per_bullet_chars(arguments);

            let profile = crate::career_match::jd::extract_heuristic(jd_text);
            let echoed: Vec<String> = profile
                .ats_keywords
                .iter()
                .filter(|k| scoring::text_covers_skill(bullet_text, k))
                .cloned()
                .collect();
            let missing: Vec<String> = profile
                .must_have_skills
                .iter()
                .filter(|k| !scoring::text_covers_skill(bullet_text, k))
                .cloned()
                .collect();

            let has_metric = bullet_text.chars().any(|c| c.is_ascii_digit());
            let first_word = bullet_text.split_whitespace().next().unwrap_or("");
            let strong_verb = is_strong_action_verb(first_word);
            let len = bullet_text.chars().count();

            let mut suggestions = Vec::new();
            if !has_metric {
                suggestions.push(
                    "No figure present. If a real, measured number exists in your knowledgebase, add it — do not estimate one."
                        .to_string(),
                );
            }
            if !strong_verb {
                suggestions.push(format!(
                    "Opens with \"{first_word}\". Lead with a past-tense accomplishment verb (Built, Led, Reduced, Shipped, Designed)."
                ));
            }
            if len > per_bullet {
                suggestions.push(format!(
                    "{len} characters exceeds the {per_bullet}-character budget; tighten it or it will be truncated."
                ));
            }
            if echoed.is_empty() && !profile.ats_keywords.is_empty() {
                suggestions.push(
                    "Echoes none of the JD's keywords. Where the underlying work genuinely matches, use the JD's vocabulary for it."
                        .to_string(),
                );
            }

            Ok(json!({
                "bullet": bullet_text,
                "lengthChars": len,
                "perBulletChars": per_bullet,
                "withinBudget": len <= per_bullet,
                "hasMetric": has_metric,
                "actionVerb": first_word,
                "strongActionVerb": strong_verb,
                "jdKeywordsEchoed": echoed,
                "jdMustHavesNotEchoed": missing,
                "suggestions": suggestions,
                "note": "Analysis only. This tool never rewrites a bullet and never supplies a metric — use `resume_rewrite_bullets` or `resume_verify_rewrite` to change text, and only from figures already in your knowledgebase."
            }))
        }

        _ => Err(JsonRpcError::method_not_found(name)),
    }
}

/// Past-tense accomplishment verbs the X-Y-Z formula wants a bullet to open on.
const STRONG_VERBS: &[&str] = &[
    "architected", "authored", "automated", "built", "created", "cut", "delivered",
    "designed", "developed", "diagnosed", "doubled", "drove", "eliminated", "engineered",
    "established", "expanded", "founded", "grew", "halved", "identified", "implemented",
    "improved", "increased", "instrumented", "introduced", "launched", "led", "migrated",
    "modernized", "negotiated", "optimized", "orchestrated", "overhauled", "owned",
    "pioneered", "prototyped", "rebuilt", "reduced", "refactored", "removed", "resolved",
    "scaled", "shipped", "simplified", "standardized", "streamlined", "tripled",
    "unblocked", "unified",
];

fn is_strong_action_verb(word: &str) -> bool {
    let w: String = word
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .collect();
    STRONG_VERBS.contains(&w.as_str())
}

/// The full pipeline, shared by the sync and async entry points.
async fn synthesize(
    db: &career_db::CareerDbState,
    args: &Value,
    jd_text: &str,
    progress: Option<(&Arc<TaskManager>, &str)>,
) -> Result<Value, JsonRpcError> {
    let started = std::time::Instant::now();
    let provider = LanguageProvider::from_args(args.get("language"));
    let persona_id = arg_str(args, "persona_id").map(str::to_string);
    let page_budget = arg_usize(args, "page_budget", 1);
    let per_bullet = per_bullet_chars(args);

    let report = |p: f64, msg: &str| {
        if let Some((mgr, id)) = progress {
            mgr.update_progress(id, p, Some(msg.to_string()));
        }
    };

    report(0.3, "Scoring and selecting experience blocks");
    let (ctx, sel) = run_selection(
        db,
        &provider,
        jd_text,
        persona_id,
        page_budget,
        selection::DEFAULT_MAX_BULLETS_PER_BLOCK,
        per_bullet,
    )
    .await?;

    report(0.6, "Rewriting bullets under provenance verification");
    let mut rewritten_by_block: Vec<(ExperienceBlock, Vec<RewrittenBullet>)> = Vec::new();
    for s in &sel.selected {
        let bullets = provider
            .rewrite_block(&s.block, &sel.profile, per_bullet)
            .await;
        rewritten_by_block.push((s.block.clone(), bullets));
    }

    report(0.85, "Materializing and compiling");
    let render_blocks: Vec<RenderBlock<'_>> = rewritten_by_block
        .iter()
        .map(|(block, bullets)| RenderBlock { block, bullets })
        .collect();

    // Skills line: JD must-haves the selection actually evidences, so the
    // résumé never claims a skill the knowledgebase cannot support.
    let skills: Vec<String> = sel
        .profile
        .must_have_skills
        .iter()
        .chain(sel.profile.nice_to_have_skills.iter())
        .filter(|s| sel.selected.iter().any(|b| selection::covers_skill(&b.block, s)))
        .cloned()
        .collect();

    let header = header_from_args(args);
    let summary = arg_str(args, "summary");
    let typst_source = typst_emit::render_resume(&header, summary, &skills, &render_blocks);

    let source_for_compile = typst_source.clone();
    let compiled =
        tokio::task::spawn_blocking(move || engine::compile_resume_pdf(&source_for_compile))
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("compile task failed: {e}")))?;

    let total_bullets: usize = rewritten_by_block.iter().map(|(_, b)| b.len()).sum();
    let ai_rewritten = rewritten_by_block
        .iter()
        .flat_map(|(_, b)| b.iter())
        .filter(|b| b.ai_generated)
        .count();
    let fallbacks: Vec<Value> = rewritten_by_block
        .iter()
        .flat_map(|(block, bullets)| {
            bullets.iter().filter_map(move |b| {
                b.fallback_reason.map(|reason| {
                    json!({
                        "blockId": block.id,
                        "bulletId": b.id,
                        "reason": reason,
                        "droppedMetrics": b.dropped_metrics
                    })
                })
            })
        })
        .collect();

    let must_total = sel.profile.must_have_skills.len();
    let covered = must_total - sel.uncovered_must_haves.len();
    let coverage = if must_total == 0 {
        Value::Null
    } else {
        json!(((covered as f64 / must_total as f64) * 1000.0).round() / 10.0)
    };

    let include_pdf = arg_bool(args, "include_pdf", false);
    let byte_length = compiled.pdf_bytes.as_ref().map(Vec::len).unwrap_or(0);

    Ok(json!({
        "personaId": ctx.persona.id,
        "source": provider.label(),
        "externalTokenCost": if provider.is_local() { "none" } else { "borne by the calling agent" },
        "profile": sel.profile,
        "typstSource": typst_source,
        "compile": {
            "success": compiled.success,
            "pageCount": compiled.page_count,
            "errors": compiled.errors,
            "warnings": compiled.warnings,
            "durationMs": compiled.duration_ms,
            "byteLength": byte_length,
        },
        "pdfBase64": if include_pdf {
            compiled.pdf_bytes.as_ref().map(|b| BASE64_STANDARD.encode(b)).map(Value::String).unwrap_or(Value::Null)
        } else {
            Value::Null
        },
        "matchReport": {
            "coveragePercentage": coverage,
            "mustHaveTotal": must_total,
            "mustHaveCovered": covered,
            "uncoveredMustHaves": sel.uncovered_must_haves,
            "selectedBlockCount": sel.selected.len(),
            "totalBullets": total_bullets,
            "aiRewrittenCount": ai_rewritten,
            "canonicalFallbackCount": total_bullets - ai_rewritten,
            "fallbacks": fallbacks,
            "mustHaveSwaps": sel.swaps,
            "semanticMatchingDisabled": sel.semantic_disabled,
            "budgetViolations": selection::budget_violations(&sel.selected, &sel.budget),
            "notices": sel.notices,
            "elapsedMs": started.elapsed().as_millis() as u64,
        },
        "selectedBlocks": sel.selected.iter().map(scored_block_json).collect::<Vec<_>>(),
    }))
}
