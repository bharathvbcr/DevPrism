//! Resume Synthesis & Fine-Tuning MCP Tools and Prompts.
//!
//! Exposes:
//! - `resume_analyze_jd`: extract requirements, hard/soft skills, seniority, and domains from a Job Description (plus deterministic metadata: salary range, benefits, culture signals, experience level, requirement buckets).
//! - `resume_gap_analysis`: calculate candidate coverage, missing skills, and warnings for missing non-negotiables.
//! - `resume_score_and_select`: score blocks and pack them into a page budget with a wrap-aware knapsack.
//! - `resume_rewrite_bullets`: verify caller-supplied bullet drafts against canonical metrics.
//! - `resume_synthesize`: deterministic analysis stages (JD -> score -> select -> gap -> ATS coverage -> parse check).
//! - `resume_compile`: compile Typst source to PDF. LaTeX is explicitly rejected, not faked.
//! - `resume_finetune_bullet`: analyse a bullet. Never writes or invents metrics.
//! - `resume_ats_check`: simulate how an ATS parses text (sections, contact info, formatting hazards) with an optional JD keyword heatmap. Ported from IgniteCV via `career_match::ats_sim`.
//!
//! Prompts:
//! - `tailor-resume-for-jd`: Prompt template for JD-tailored resume generation.
//! - `audit-resume-against-jd`: Prompt template for auditing candidate alignment against a JD.
//! - `distill-career-notes`: Prompt template for extracting atomic facts.
//! - `finetune-bullet-metrics`: Prompt template for strengthening bullet metrics.

use crate::career_db::{self, ExperienceBlock};
use crate::career_match::{gap, jd, metrics, render, scoring, selection};
use crate::career_match::ats_sim;
use crate::career_typst::engine;
use crate::mcp::protocol::{
    JsonRpcError, PromptArgument, PromptDefinition, ResponseMeta, ToolDefinition,
};
use crate::mcp::tasks::TaskManager;
// Shared input bounds: resume tools take the same arbitrary-JSON text bodies
// career tools do, and were the one family still accepting unbounded strings.
use crate::mcp::tools_career::{bounded_bytes, MAX_TEXT_BYTES};
use base64::prelude::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub fn list_resume_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "resume_analyze_jd".to_string(),
            description: "Extract a canonical JDProfile from a job description: roleTitle, seniority, mustHaveSkills, niceToHaveSkills, domains, atsKeywords, toneSignals, and the responsibilities/qualifications section text. Extraction is a deterministic controlled-vocabulary scan (extractionMethod=heuristic), not model extraction, and reports extractionEmpty plus a warning when it finds nothing.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "jd_text": {
                        "type": "string",
                        "description": "Full text of the job description or job posting"
                    }
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
            description: "Classify every JD must-have as covered / weak / missing by searching block skill tags, domains, bullet text AND the fact pool with word-boundary matching. Returns per-skill evidence hits, counts, and a coverage percentage computed over the blocks that would actually be printed.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "jd_text": {
                        "type": "string",
                        "description": "Target job description text"
                    },
                    "persona_id": {
                        "type": "string",
                        "description": "Optional persona ID to bias evaluation (e.g. 'ai', 'management', 'life-sciences')"
                    },
                    "page_budget": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 4,
                        "description": "Page count that defines which blocks count as 'selected' for the coverage denominator, 1 (default) to 4. Must match the value passed to resume_synthesize for the two to agree."
                    }
                },
                "required": ["jd_text"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_score_and_select".to_string(),
            description: "Score every experience block (skills / persona / recency / seniority, renormalised because no embedding provider is bound) and pack them into a page budget with a wrap-aware greedy knapsack: per-section caps, per-org de-duplication, and a must-have coverage repair pass. Reports uncovered must-haves and any swaps it made.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "jd_text": {
                        "type": "string",
                        "description": "Target job description text"
                    },
                    "persona_id": {
                        "type": "string",
                        "description": "Optional persona id"
                    },
                    "page_budget": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 4,
                        "description": "Target page count, 1 (default) to 4"
                    }
                },
                "required": ["jd_text"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_rewrite_bullets".to_string(),
            description: "Verify bullet drafts against canonical provenance. This server does NOT generate rewrites: supply your own drafts in `drafts` and every canonical metric on the source bullet is checked against your text, with drops reported and the canonical text substituted on failure. Called without drafts it returns canonical bullets and target keywords, and provenanceVerified is false because nothing was verified.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "block_id": {
                        "type": "string",
                        "description": "Target experience block ID"
                    },
                    "jd_text": {
                        "type": "string",
                        "description": "Target job description text"
                    },
                    "bullet_ids": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional specific bullet IDs to consider (defaults to all in block)"
                    },
                    "drafts": {
                        "type": "array",
                        "description": "Your proposed rewrites, verified against canonical metrics",
                        "items": {
                            "type": "object",
                            "properties": {
                                "bulletId": { "type": "string" },
                                "text": { "type": "string" }
                            },
                            "required": ["bulletId", "text"]
                        }
                    }
                },
                "required": ["block_id", "jd_text"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_synthesize".to_string(),
            description: "Run the deterministic synthesis stages: JD scan, block scoring, knapsack selection, must-have gap analysis, real ATS keyword coverage, and (unless render=false) materialization through an injection-safe plain Typst layout. Model-dependent stages (semantic JD extraction, bullet rewriting, critic) are skipped and listed in llmStagesSkipped. Supports async execution via the Tasks extension.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "jd_text": {
                        "type": "string",
                        "description": "Full target job description text"
                    },
                    "persona_id": {
                        "type": "string",
                        "description": "Persona ID to steer tone and template selection (default: 'ai')"
                    },
                    "template_id": {
                        "type": "string",
                        "enum": ["typst-ats-single", "typst-ats-two-column"],
                        "description": "Accepted for compatibility and validated, but this server renders one plain headless layout; template-driven design is owned by the desktop app"
                    },
                    "page_budget": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 4,
                        "description": "Target page count, 1 (default) to 4"
                    },
                    "render": {
                        "type": "boolean",
                        "description": "Materialize Typst + PDF (default true). Set false for analysis only."
                    },
                    "header_name": {
                        "type": "string",
                        "description": "Candidate name for the rendered header"
                    },
                    "contact_lines": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Up to 4 contact lines rendered under the name"
                    },
                    "async": {
                        "type": "boolean",
                        "description": "If true, starts execution in background and immediately returns taskId for polling via tasks/get"
                    }
                },
                "required": ["jd_text"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_compile".to_string(),
            description: "Compile Typst resume source to PDF with the in-process, filesystem-denied Typst engine, returning diagnostics; pdfBase64 only when include_pdf=true (default false — PDF bytes flood agent context; pdfOmitted reports a suppressed PDF honestly). LaTeX is NOT supported through MCP and is rejected with an explanatory error rather than reported as compiled.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "typst_source": {
                        "type": "string",
                        "description": "Typst resume source code"
                    },
                    "include_pdf": {
                        "type": "boolean",
                        "description": "Include pdfBase64 in the response (default false)"
                    },
                    "latex_source": {
                        "type": "string",
                        "description": "Rejected. LaTeX cannot be compiled safely from the MCP server; use the desktop app."
                    }
                }
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_finetune_bullet".to_string(),
            description: "Analyse a bullet against a JD and report findings: weak opening verb, presence of a quantity, which supplied verified metrics are actually expressed in the text, JD keywords present/absent, and estimated rendered lines. This tool never writes a bullet and never invents a metric; `rewrite` is always null.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "bullet_text": {
                        "type": "string",
                        "description": "The current draft or canonical bullet text"
                    },
                    "jd_text": {
                        "type": "string",
                        "description": "Target job description or requirement snippet"
                    },
                    "context": {
                        "type": "string",
                        "description": "Optional context: role title, company, or verified metrics"
                    },
                    "verified_metrics": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Known-true metric values; each is checked for presence in bullet_text"
                    }
                },
                "required": ["bullet_text", "jd_text"]
            }),
            _meta: None,
        },
        ToolDefinition {
            name: "resume_ats_check".to_string(),
            description: "Simulate how an applicant tracking system parses resume text: which sections it detects (summary/experience/education/skills/projects/publications/leadership/certifications/awards/languages/volunteer/links/contact), whether the system's required sections are present, what contact info survives (name/email/phone/links), and formatting hazards (tables or tabs, exotic symbols, over-long lines). Supply jd_text to also get a per-section keyword-density heatmap with heat levels 0-5, missing critical keywords, and keyword-stuffing detection. Deterministic heuristic audit — no model involved.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Resume text (or any document text) to simulate parsing on"
                    },
                    "jd_text": {
                        "type": "string",
                        "description": "Optional job description; enables the keyword-density heatmap"
                    },
                    "ats_system": {
                        "type": "string",
                        "enum": ["taleo", "workday", "greenhouse", "lever", "jobvite", "icims", "generic"],
                        "description": "Which ATS rule set to apply (default generic)"
                    }
                },
                "required": ["text"]
            }),
            _meta: None,
        },
    ]
}

pub fn list_resume_prompts() -> Vec<PromptDefinition> {
    vec![
        PromptDefinition {
            name: "tailor-resume-for-jd".to_string(),
            description: Some("Guided workflow prompt for tailoring a resume to a target job description.".to_string()),
            arguments: vec![
                PromptArgument {
                    name: "jd_text".to_string(),
                    description: Some("The job description to tailor for".to_string()),
                    required: true,
                },
                PromptArgument {
                    name: "persona_id".to_string(),
                    description: Some("Optional persona ID (e.g. 'ai', 'management')".to_string()),
                    required: false,
                },
            ],
            _meta: Some(ResponseMeta {
                ttl_ms: Some(300_000),
                cache_scope: Some("public".to_string()),
                extra: HashMap::new(),
            }),
        },
        PromptDefinition {
            name: "audit-resume-against-jd".to_string(),
            description: Some("Audit candidate's background against a JD to discover missing skills and gaps.".to_string()),
            arguments: vec![
                PromptArgument {
                    name: "jd_text".to_string(),
                    description: Some("The target job description".to_string()),
                    required: true,
                },
            ],
            _meta: Some(ResponseMeta {
                ttl_ms: Some(300_000),
                cache_scope: Some("public".to_string()),
                extra: HashMap::new(),
            }),
        },
        PromptDefinition {
            name: "distill-career-notes".to_string(),
            description: Some("Extract atomic facts and metrics from unorganized project notes or performance reviews.".to_string()),
            arguments: vec![
                PromptArgument {
                    name: "notes".to_string(),
                    description: Some("Raw unstructured notes or retro documentation".to_string()),
                    required: true,
                },
            ],
            _meta: Some(ResponseMeta {
                ttl_ms: Some(300_000),
                cache_scope: Some("public".to_string()),
                extra: HashMap::new(),
            }),
        },
        PromptDefinition {
            name: "finetune-bullet-metrics".to_string(),
            description: Some("Polish a bullet to strengthen X-Y-Z (Accomplished [X] as measured by [Y] by doing [Z]) formatting.".to_string()),
            arguments: vec![
                PromptArgument {
                    name: "bullet_text".to_string(),
                    description: Some("The bullet text to polish".to_string()),
                    required: true,
                },
                PromptArgument {
                    name: "metrics".to_string(),
                    description: Some("Verified quantitative metrics (e.g. '30%', '$1.2M', '500k QPS')".to_string()),
                    required: false,
                },
            ],
            _meta: Some(ResponseMeta {
                ttl_ms: Some(300_000),
                cache_scope: Some("public".to_string()),
                extra: HashMap::new(),
            }),
        },
    ]
}

pub fn get_resume_prompt(name: &str, arguments: &HashMap<String, String>) -> Result<Value, JsonRpcError> {
    match name {
        "tailor-resume-for-jd" => {
            let jd = arguments.get("jd_text").cloned().unwrap_or_default();
            let persona = arguments.get("persona_id").cloned().unwrap_or_else(|| "ai".to_string());
            Ok(json!({
                "description": "Tailor resume for target job description",
                "messages": [
                    {
                        "role": "user",
                        "content": {
                            "type": "text",
                            "text": format!(
                                "Please tailor my master career resume for the following job description using persona '{persona}':\n\n=== JOB DESCRIPTION ===\n{jd}\n\nSteps to follow:\n1. Use `resume_analyze_jd` to extract requirements.\n2. Use `resume_gap_analysis` to identify strengths and coverage.\n3. Use `resume_score_and_select` to select high-impact experience blocks.\n4. Tailor bullets with `resume_rewrite_bullets` maintaining strict fact provenance.\n5. Output synthesized Typst resume content and compile with `resume_compile`."
                            )
                        }
                    }
                ]
            }))
        }
        "audit-resume-against-jd" => {
            let jd = arguments.get("jd_text").cloned().unwrap_or_default();
            Ok(json!({
                "description": "Audit candidate background against JD",
                "messages": [
                    {
                        "role": "user",
                        "content": {
                            "type": "text",
                            "text": format!(
                                "Please perform a detailed gap analysis comparing my career knowledgebase against this job description:\n\n=== JOB DESCRIPTION ===\n{jd}\n\nCall `resume_gap_analysis` and `career_search_kb` to show:\n- Must-have skill coverage percentage\n- Missing required skills\n- Missing preferred skills\n- Key experience highlights that offset missing requirements"
                            )
                        }
                    }
                ]
            }))
        }
        "distill-career-notes" => {
            let notes = arguments.get("notes").cloned().unwrap_or_default();
            Ok(json!({
                "description": "Distill raw career notes into structured facts",
                "messages": [
                    {
                        "role": "user",
                        "content": {
                            "type": "text",
                            "text": format!(
                                "Please distill the following unorganized career notes into atomic structured facts using `career_distill_facts`:\n\n=== RAW NOTES ===\n{notes}"
                            )
                        }
                    }
                ]
            }))
        }
        "finetune-bullet-metrics" => {
            let bullet = arguments.get("bullet_text").cloned().unwrap_or_default();
            let metrics = arguments.get("metrics").cloned().unwrap_or_default();
            Ok(json!({
                "description": "Strengthen bullet impact and metric formatting",
                "messages": [
                    {
                        "role": "user",
                        "content": {
                            "type": "text",
                            "text": format!(
                                "Please refine this resume bullet point for maximum executive impact using the Google X-Y-Z formula (Accomplished [X], as measured by [Y], by doing [Z]):\n\nBullet: {bullet}\nVerified Metrics: {metrics}\n\nEnsure no metrics or technologies outside verified facts are introduced."
                            )
                        }
                    }
                ]
            }))
        }
        _ => Err(JsonRpcError::method_not_found(name)),
    }
}

// --- Tool Implementations ---

// --- Tool Implementations ---
//
// Every arm below reports what it actually computed. Where a step cannot run
// headlessly (no model, no LaTeX engine), the response says so in a dedicated
// status field instead of emitting a plausible placeholder. See the module
// header for the list of behaviours this replaced.

/// Blocks plus the JD profile, loaded once per call.
struct ResumeContext {
    blocks: Vec<ExperienceBlock>,
    extraction: jd::JdExtraction,
}

fn load_context(
    db: &career_db::CareerDbState,
    jd_text: &str,
) -> Result<ResumeContext, String> {
    let extraction = jd::extract_profile(jd_text);
    let blocks = db.with_conn(|conn| career_db::list_blocks_blocking(conn, false))?;
    Ok(ResumeContext { blocks, extraction })
}

fn current_year_month() -> (i32, u32) {
    let now = chrono::Utc::now();
    use chrono::Datelike;
    (now.year(), now.month())
}

/// Fraction of the draft's significant words that also appear in the canonical
/// bullet.
///
/// A crude but honest guard: this server cannot verify that a rewritten claim
/// is true, so a draft sharing almost no vocabulary with its source is treated
/// as a new assertion rather than a rewrite.
fn canonical_overlap(canonical: &str, draft: &str) -> f64 {
    let words = |s: &str| -> Vec<String> {
        s.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.chars().count() > 3)
            .map(str::to_string)
            .collect()
    };
    let d = words(draft);
    let c = words(canonical);
    if d.is_empty() {
        // No significant words to compare. Overlap is UNMEASURABLE, not
        // perfect: returning 1.0 let a draft of only short words ("we ran it
        // all day") sail through as a maximum-confidence match. Fall back to
        // the canonical side: if it also has nothing to compare, the two are
        // equally uninformative and the draft is allowed through; otherwise
        // the draft has thrown away everything specific and is not a rewrite.
        return if c.is_empty() { 1.0 } else { 0.0 };
    }
    let hits = d.iter().filter(|w| c.contains(w)).count();
    hits as f64 / d.len() as f64
}

/// Validate a caller-supplied page budget.
///
/// `SelectionBudget::for_pages` clamps internally, so an unvalidated value used
/// to be silently clamped and then echoed back verbatim: a request for 40 pages
/// answered "pageBudget: 40" while packing 4 pages' worth.
fn page_budget_arg(args: &Value) -> Result<u64, JsonRpcError> {
    let n = args.get("page_budget").and_then(|v| v.as_u64()).unwrap_or(1);
    if !(1..=4).contains(&n) {
        return Err(JsonRpcError::invalid_params(format!(
            "page_budget must be between 1 and 4, got {n}"
        )));
    }
    Ok(n)
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| JsonRpcError::invalid_params(format!("Missing required '{key}'")))
}

/// Build the scoring context for a persona.
fn scoring_context<'a>(
    profile: &'a jd::JdProfile,
    persona_id: &'a str,
    now: (i32, u32),
) -> scoring::ScoringContext<'a> {
    scoring::ScoringContext {
        must_have: &profile.must_have_skills,
        nice_to_have: &profile.nice_to_have_skills,
        jd_seniority: &profile.seniority,
        persona_id,
        persona_weights: None,
        // The MCP server has no guaranteed embedding provider, so semantic
        // similarity is unavailable and its weight is redistributed rather
        // than silently counted as zero signal.
        weights: scoring::weights_for(false),
        now_year: now.0,
        now_month: now.1,
    }
}

pub async fn execute_resume_tool(
    db: &career_db::CareerDbState,
    task_manager: &Arc<TaskManager>,
    name: &str,
    arguments: &Value,
) -> Result<Value, JsonRpcError> {
    match name {
        // ---------------------------------------------------------------
        // Defect #7: emit the canonical JDProfile shape from a real scan.
        // ---------------------------------------------------------------
        "resume_analyze_jd" => {
            let jd_text = bounded_bytes(require_str(arguments, "jd_text")?, "jd_text", MAX_TEXT_BYTES)?;
            let extraction = jd::extract_profile(jd_text);
            let mut out = serde_json::to_value(&extraction)
                .map_err(|e| JsonRpcError::internal_error(format!("profile encode: {e}")))?;
            if let Some(obj) = out.as_object_mut() {
                obj.insert(
                    "_meta".to_string(),
                    json!({ "ttlMs": 300_000, "cacheScope": "public" }),
                );
            }
            // Deterministic heuristic metadata (salary range, benefits,
            // culture signals, experience level, requirement buckets). Every
            // field is evidence, not truth — nullable on purpose.
            let metadata = ats_sim::analyze_jd_metadata(jd_text);
            let metadata_value = serde_json::to_value(&metadata)
                .map_err(|e| JsonRpcError::internal_error(format!("metadata encode: {e}")))?;
            Ok(json!({ "profile": out, "metadata": metadata_value }))
        }

        // ---------------------------------------------------------------
        // Defect #8: search skills, domains, bullets AND facts, with
        // word-boundary matching and a covered/weak/missing ladder.
        // ---------------------------------------------------------------
        "resume_gap_analysis" => {
            let jd_text = bounded_bytes(require_str(arguments, "jd_text")?, "jd_text", MAX_TEXT_BYTES)?.to_string();
            let persona_id = arguments
                .get("persona_id")
                .and_then(|v| v.as_str())
                .unwrap_or("ai")
                .to_string();
            let page_budget = page_budget_arg(arguments)?;

            let db_clone = db.clone();
            let now = current_year_month();
            let report = tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let ctx = load_context(&db_clone, &jd_text)?;
                let profile = &ctx.extraction.profile;

                // "Selected" means the blocks that would actually be printed,
                // so coverage reflects the resume, not the whole database.
                let sctx = scoring_context(profile, &persona_id, now);
                let scored = scoring::score_blocks(&ctx.blocks, &sctx, &HashMap::new());
                let budget = selection::SelectionBudget::for_pages(page_budget as usize);
                let sel = selection::knapsack_select(
                    &scored,
                    &budget,
                    &profile.must_have_skills,
                    selection::DEFAULT_ORG_SCORE_GAP,
                );
                let selected_blocks: Vec<ExperienceBlock> =
                    sel.selected.iter().map(|s| s.block.clone()).collect();

                let must = gap::analyze_must_have_gaps(
                    &profile.must_have_skills,
                    &selected_blocks,
                    &ctx.blocks,
                );
                let nice = gap::analyze_must_have_gaps(
                    &profile.nice_to_have_skills,
                    &selected_blocks,
                    &ctx.blocks,
                );

                let mut warnings: Vec<String> = Vec::new();
                if let Some(w) = &ctx.extraction.warning {
                    warnings.push(w.clone());
                }
                if must.missing_count > 0 {
                    let missing: Vec<&str> = must
                        .items
                        .iter()
                        .filter(|i| i.status == gap::GapStatus::Missing)
                        .map(|i| i.skill.as_str())
                        .collect();
                    warnings.push(format!(
                        "{} must-have skill(s) have no evidence anywhere in the knowledgebase: {}",
                        missing.len(),
                        missing.join(", ")
                    ));
                }
                if ctx.blocks.is_empty() {
                    warnings.push(
                        "Career knowledgebase is empty, so 0% coverage reflects missing data, \
                         not a missing skillset."
                            .to_string(),
                    );
                }

                Ok(json!({
                    "personaId": persona_id,
                    "extractionMethod": ctx.extraction.extraction_method,
                    "extractionEmpty": ctx.extraction.extraction_empty,
                    "blocksInKnowledgebase": ctx.blocks.len(),
                    "blocksConsideredSelected": selected_blocks.len(),
                    "mustHave": must,
                    "niceToHave": nice,
                    "coveragePercentage": must.coverage_percentage,
                    "warnings": warnings,
                }))
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("gap analysis task error: {e}")))?
            .map_err(JsonRpcError::internal_error)?;

            Ok(report)
        }

        // ---------------------------------------------------------------
        // Defect #6: real knapsack with a wrap-aware line model, section
        // caps, per-org de-duplication and must-have coverage repair.
        // ---------------------------------------------------------------
        "resume_score_and_select" => {
            let jd_text = bounded_bytes(require_str(arguments, "jd_text")?, "jd_text", MAX_TEXT_BYTES)?.to_string();
            let persona_id = arguments
                .get("persona_id")
                .and_then(|v| v.as_str())
                .unwrap_or("ai")
                .to_string();
            let requested_pages = page_budget_arg(arguments)?;

            let db_clone = db.clone();
            let now = current_year_month();
            let selection_json = tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let ctx = load_context(&db_clone, &jd_text)?;
                let profile = &ctx.extraction.profile;
                let sctx = scoring_context(profile, &persona_id, now);
                let scored = scoring::score_blocks(&ctx.blocks, &sctx, &HashMap::new());
                let budget = selection::SelectionBudget::for_pages(requested_pages as usize);
                let sel = selection::knapsack_select(
                    &scored,
                    &budget,
                    &profile.must_have_skills,
                    selection::DEFAULT_ORG_SCORE_GAP,
                );

                let selected: Vec<Value> = sel
                    .selected
                    .iter()
                    .map(|s| {
                        let kept = selection::trim_selected_bullets(
                            &s.block,
                            &profile.must_have_skills,
                            budget.bullets_per_block(),
                        );
                        json!({
                            "blockId": s.block.id,
                            "title": s.block.title,
                            "org": s.block.org,
                            "kind": s.block.kind,
                            "section": selection::section_for_block(&s.block),
                            "score": s.score,
                            "scoreComponents": s.components,
                            "estimatedLines": selection::estimate_block_lines(
                                &s.block,
                                selection::CHARS_PER_LINE,
                            ),
                            "bulletCount": s.block.bullets.len(),
                            "selectedBullets": kept,
                        })
                    })
                    .collect();

                Ok(json!({
                    "pageBudget": requested_pages,
                    "lineBudget": budget.total_lines,
                    "estimatedTotalLines": sel.estimated_lines,
                    "charsPerLine": selection::CHARS_PER_LINE,
                    "selectedBlocks": selected,
                    "selectedCount": sel.selected.len(),
                    "consideredCount": scored.len(),
                    "uncoveredMustHaves": sel.uncovered_must_haves,
                    "coverageSwaps": sel.swaps,
                    "semanticScoringAvailable": false,
                    "note": "Embedding weight was redistributed across the deterministic \
                             components because the MCP server has no embedding provider bound.",
                }))
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("selection task error: {e}")))?
            .map_err(JsonRpcError::internal_error)?;

            Ok(selection_json)
        }

        // ---------------------------------------------------------------
        // Defect #1: verify provenance for real. Optionally accept drafts
        // from the calling agent and check every canonical metric survived.
        // ---------------------------------------------------------------
        "resume_rewrite_bullets" => {
            let block_id = require_str(arguments, "block_id")?.to_string();
            let jd_text = bounded_bytes(require_str(arguments, "jd_text")?, "jd_text", MAX_TEXT_BYTES)?.to_string();
            let bullet_ids: Option<HashSet<String>> = arguments
                .get("bullet_ids")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect());

            // { bulletId -> proposed text } supplied by the calling agent.
            let mut drafts: HashMap<String, String> = HashMap::new();
            if let Some(arr) = arguments.get("drafts").and_then(|v| v.as_array()) {
                for d in arr {
                    let (Some(id), Some(text)) = (
                        d.get("bulletId").and_then(|v| v.as_str()),
                        d.get("text").and_then(|v| v.as_str()),
                    ) else {
                        return Err(JsonRpcError::invalid_params(
                            "each draft needs 'bulletId' and 'text'",
                        ));
                    };
                    drafts.insert(id.to_string(), text.to_string());
                }
            }

            let db_clone = db.clone();
            let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
                let ctx = load_context(&db_clone, &jd_text)?;
                let block = ctx
                    .blocks
                    .iter()
                    .find(|b| b.id == block_id)
                    .ok_or_else(|| format!("Block '{block_id}' not found"))?;
                let profile = &ctx.extraction.profile;

                // A draft naming a bullet that does not exist was silently
                // dropped, so a caller could believe it had submitted work that
                // was never checked.
                let known: HashSet<&str> = block.bullets.iter().map(|b| b.id.as_str()).collect();
                let unknown: Vec<String> = drafts
                    .keys()
                    .filter(|id| !known.contains(id.as_str()))
                    .cloned()
                    .collect();
                if !unknown.is_empty() {
                    return Err(format!(
                        "drafts reference bullet ids not in block '{}': {}",
                        block.id,
                        unknown.join(", ")
                    ));
                }

                let mut out = Vec::new();
                let mut verified_count = 0usize;
                let mut rejected_count = 0usize;

                for bullet in &block.bullets {
                    if let Some(filter) = &bullet_ids {
                        if !filter.contains(&bullet.id) {
                            continue;
                        }
                    }
                    let canonical_metrics: Vec<String> =
                        bullet.metrics.iter().map(|m| m.value.clone()).collect();
                    let jd_keywords: Vec<String> = profile
                        .ats_keywords
                        .iter()
                        .filter(|k| {
                            crate::career_match::text::text_covers_skill(&bullet.canonical, k)
                        })
                        .cloned()
                        .collect();

                    match drafts.get(&bullet.id) {
                        Some(proposed) => {
                            let dropped = metrics::dropped_metrics(&bullet.metrics, proposed);
                            let kept_all =
                                metrics::metrics_values_preserved(&bullet.metrics, proposed);
                            debug_assert_eq!(kept_all, dropped.is_empty());
                            // Preservation alone is not enough: a bullet with no
                            // recorded metrics preserves all zero of them, so a
                            // draft could invent a figure and pass. Also reject
                            // quantities the knowledgebase does not support.
                            let introduced = metrics::introduced_numbers(
                                &bullet.canonical,
                                &bullet.metrics,
                                proposed,
                            );
                            // A locked bullet is not open for rewriting. The
                            // flag was reported and then ignored.
                            let locked_block = bullet.locked;
                            // Token overlap with the canonical text. This server
                            // has no model and cannot judge whether a claim is
                            // true, so a draft that shares almost nothing with
                            // the canonical bullet is surfaced rather than
                            // waved through.
                            let overlap = canonical_overlap(&bullet.canonical, proposed);
                            const MIN_OVERLAP: f64 = 0.25;
                            let preserved = kept_all
                                && introduced.is_empty()
                                && !locked_block
                                && overlap >= MIN_OVERLAP;
                            // Both failure modes can apply at once, so they are
                            // listed rather than collapsed into one status with
                            // an arbitrary precedence. Built outside `json!`,
                            // which cannot parse a turbofish in a block.
                            let mut rejection_reasons: Vec<&str> = Vec::new();
                            if !dropped.is_empty() {
                                rejection_reasons.push("dropped_metric");
                            }
                            if !introduced.is_empty() {
                                rejection_reasons.push("unsupported_number");
                            }
                            if locked_block {
                                rejection_reasons.push("bullet_locked");
                            }
                            if overlap < MIN_OVERLAP {
                                rejection_reasons.push("insufficient_overlap_with_canonical");
                            }
                            if preserved {
                                verified_count += 1;
                            } else {
                                rejected_count += 1;
                            }
                            out.push(json!({
                                "bulletId": bullet.id,
                                "canonical": bullet.canonical,
                                "proposed": proposed,
                                // The accepted text is the draft only when it
                                // survived verification; otherwise we fall back
                                // to canonical rather than shipping a claim we
                                // could not substantiate.
                                "accepted": if preserved { proposed.clone() } else { bullet.canonical.clone() },
                                "status": if preserved { "verified" } else { "rejected_canonical_fallback" },
                                "rejectionReasons": rejection_reasons,
                                "provenanceVerified": preserved,
                                // Naming the checks that actually ran, because
                                // "provenanceVerified" alone reads as a claim
                                // this server cannot make: it has no model and
                                // cannot judge whether a rewritten statement is
                                // true, only whether the numbers and wording
                                // stay tied to the canonical bullet.
                                "verifiedChecks": [
                                    "canonical_metrics_preserved",
                                    "no_unsupported_numbers",
                                    "not_locked",
                                    "token_overlap_with_canonical"
                                ],
                                "notVerified": [
                                    "factual_truth_of_new_claims",
                                    "employer_or_scope_accuracy"
                                ],
                                "canonicalOverlap": overlap,
                                "droppedMetrics": dropped,
                                "introducedNumbers": introduced,
                                "canonicalMetrics": canonical_metrics,
                                "jdKeywordsPresent": jd_keywords,
                                "locked": bullet.locked,
                            }));
                        }
                        None => {
                            out.push(json!({
                                "bulletId": bullet.id,
                                "canonical": bullet.canonical,
                                "accepted": bullet.canonical,
                                "status": "canonical_only",
                                // No rewrite was attempted, so nothing was
                                // verified. Reporting `true` here is what the
                                // previous implementation did and it is exactly
                                // the failure this field must not have.
                                "provenanceVerified": false,
                                "canonicalMetrics": canonical_metrics,
                                "jdKeywordsPresent": jd_keywords,
                                "locked": bullet.locked,
                            }));
                        }
                    }
                }

                if out.is_empty() && bullet_ids.is_some() {
                    return Err(format!(
                        "No bullets in block '{block_id}' matched the requested bullet_ids"
                    ));
                }

                Ok(json!({
                    "blockId": block.id,
                    "title": block.title,
                    "org": block.org,
                    "bullets": out,
                    "rewriteMode": if drafts.is_empty() { "verify_only_no_drafts_supplied" } else { "verified_supplied_drafts" },
                    "verifiedCount": verified_count,
                    "rejectedCount": rejected_count,
                    "targetKeywords": profile.ats_keywords,
                    "guidance": "This server does not generate rewrites. Draft bullets yourself, \
                                 then resubmit them in 'drafts' to have every canonical metric \
                                 checked against the proposed text.",
                }))
            })
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("rewrite error: {e}")))?
            .map_err(JsonRpcError::internal_error)?;

            Ok(result)
        }

        // ---------------------------------------------------------------
        // Defect #4: real analysis, real ATS coverage, no mock renderer.
        // ---------------------------------------------------------------
        "resume_synthesize" => {
            let jd_text = bounded_bytes(require_str(arguments, "jd_text")?, "jd_text", MAX_TEXT_BYTES)?.to_string();
            let persona_id = arguments
                .get("persona_id")
                .and_then(|v| v.as_str())
                .unwrap_or("ai")
                .to_string();
            let page_budget = page_budget_arg(arguments)?;
            let is_async = arguments.get("async").and_then(|v| v.as_bool()).unwrap_or(false);
            let render_doc = arguments.get("render").and_then(|v| v.as_bool()).unwrap_or(true);
            let header_name = arguments
                .get("header_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let contact_lines: Vec<String> = arguments
                .get("contact_lines")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();

            if let Some(t) = arguments.get("template_id").and_then(|v| v.as_str()) {
                if !matches!(t, "typst-ats-single" | "typst-ats-two-column") {
                    return Err(JsonRpcError::invalid_params(format!(
                        "Unknown template_id '{t}'. This server does not render templates; \
                         known ids are 'typst-ats-single' and 'typst-ats-two-column', both \
                         rendered by the desktop app."
                    )));
                }
            }

            let run = {
                let db_clone = db.clone();
                let now = current_year_month();
                move || -> Result<Value, String> {
                    let ctx = load_context(&db_clone, &jd_text)?;
                    let profile = &ctx.extraction.profile;
                    let sctx = scoring_context(profile, &persona_id, now);
                    let scored = scoring::score_blocks(&ctx.blocks, &sctx, &HashMap::new());
                    let budget = selection::SelectionBudget::for_pages(page_budget as usize);
                    let sel = selection::knapsack_select(
                        &scored,
                        &budget,
                        &profile.must_have_skills,
                        selection::DEFAULT_ORG_SCORE_GAP,
                    );
                    let selected_blocks: Vec<ExperienceBlock> =
                        sel.selected.iter().map(|s| s.block.clone()).collect();

                    let gap_report = gap::analyze_must_have_gaps(
                        &profile.must_have_skills,
                        &selected_blocks,
                        &ctx.blocks,
                    );

                    // Coverage over the bullets that would actually print.
                    let mut bullet_texts: Vec<String> = Vec::new();
                    let mut skill_names: Vec<String> = Vec::new();
                    for b in &selected_blocks {
                        let kept = selection::trim_selected_bullets(
                            b,
                            &profile.must_have_skills,
                            budget.bullets_per_block(),
                        );
                        for bullet in &b.bullets {
                            if kept.contains(&bullet.id) {
                                bullet_texts.push(bullet.canonical.clone());
                            }
                        }
                        // Skill tags are metadata; `render_resume` prints only
                        // the header, entries and bullets. Counting tags in the
                        // ATS corpus reported keyword coverage the produced PDF
                        // does not actually have.
                        if !render_doc {
                            for s in &b.skills {
                                skill_names.push(s.name.clone());
                            }
                        }
                    }
                    let ats = gap::compute_ats_coverage_pct(
                        &bullet_texts,
                        &skill_names,
                        &profile.ats_keywords,
                    );

                    // ATS parse check over the corpus this run would print:
                    // header, contact lines, section titles, entries, and the
                    // trimmed bullets — mirroring what render_resume emits.
                    let ats_system = ats_sim::detect_ats_systems(&jd_text)[0];
                    let mut corpus_lines: Vec<String> = Vec::new();
                    if !header_name.trim().is_empty() {
                        corpus_lines.push(header_name.trim().to_string());
                    }
                    for line in &contact_lines {
                        if !line.trim().is_empty() {
                            corpus_lines.push(line.trim().to_string());
                        }
                    }
                    let mut last_section: Option<String> = None;
                    for b in &selected_blocks {
                        let section = selection::section_for_block(b);
                        if last_section.as_deref() != Some(section.as_str()) {
                            corpus_lines.push(section.to_uppercase());
                            last_section = Some(section.clone());
                        }
                        let head = [b.title.trim(), b.org.trim()]
                            .iter()
                            .filter(|part| !part.is_empty())
                            .map(|part| part.to_string())
                            .collect::<Vec<_>>()
                            .join(", ");
                        if !head.is_empty() {
                            corpus_lines.push(head);
                        }
                        if let Some(loc) = b.location.as_deref() {
                            if !loc.trim().is_empty() {
                                corpus_lines.push(loc.trim().to_string());
                            }
                        }
                        let dates = match (&b.date_range.start, &b.date_range.end) {
                            (start, Some(end)) => format!("{start} - {end}"),
                            (start, None) => format!("{start} - Present"),
                        };
                        corpus_lines.push(dates);
                        let kept =
                            selection::trim_selected_bullets(b, &profile.must_have_skills, budget.bullets_per_block());
                        for bullet in &b.bullets {
                            if kept.contains(&bullet.id) && !bullet.canonical.trim().is_empty() {
                                corpus_lines.push(bullet.canonical.trim().to_string());
                            }
                        }
                    }
                    let ats_parse_json = serde_json::to_value(ats_sim::summarize_ats_parse(
                        &ats_sim::simulate_ats_parsing(
                            &corpus_lines.join("\n"),
                            ats_system,
                        ),
                    ))
                    .map_err(|e| format!("ats parse encode: {e}"))?;

                    // Materialize through the injection-safe code-mode renderer.
                    // The design layer (templates, two-column, typography) stays
                    // owned by the desktop app; this is the plain layout that
                    // lets a headless agent finish the job.
                    let materialization = if render_doc {
                        let mut kept_by_block: HashMap<String, Vec<String>> = HashMap::new();
                        for b in &selected_blocks {
                            kept_by_block.insert(
                                b.id.clone(),
                                selection::trim_selected_bullets(
                                    b,
                                    &profile.must_have_skills,
                                    budget.bullets_per_block(),
                                ),
                            );
                        }
                        let source = render::render_resume(
                            &header_name,
                            &contact_lines,
                            &selected_blocks,
                            Some(&kept_by_block),
                        );
                        // Defence in depth: refuse to emit source whose literals
                        // do not round-trip, rather than handing back something
                        // that might carry an unbalanced quote.
                        if let Some(bad) = render::audit_rendered_literals(&source) {
                            json!({
                                "status": "refused_unsafe_source",
                                "reason": format!("rendered literal failed validation: {bad}"),
                                "typstSource": Value::Null,
                            })
                        } else {
                            let compiled = engine::compile_resume_pdf(&source);
                            json!({
                                "status": if compiled.pdf_bytes.is_some() { "rendered" } else { "render_compile_failed" },
                                "renderer": "career_match::render (plain layout, code-mode literals)",
                                "note": "Template-driven layouts live in the desktop app; this is \
                                         the headless fallback layout.",
                                "typstSource": source,
                                "pageCount": compiled.page_count,
                                "errors": compiled.errors,
                                "warnings": compiled.warnings,
                                "pdfBytesLength": compiled.pdf_bytes.as_ref().map(|b| b.len()).unwrap_or(0),
                                "pdfBase64": compiled.pdf_bytes.as_ref().map(|b| BASE64_STANDARD.encode(b)),
                            })
                        }
                    } else {
                        json!({
                            "status": "skipped_by_request",
                            "typstSource": Value::Null,
                        })
                    };

                    Ok(json!({
                        "personaId": persona_id,
                        "pageBudget": page_budget,
                        "profile": profile,
                        "extractionMethod": ctx.extraction.extraction_method,
                        "selectedBlocks": selected_blocks.iter().map(|b| json!({
                            "blockId": b.id, "title": b.title, "org": b.org,
                        })).collect::<Vec<_>>(),
                        "estimatedTotalLines": sel.estimated_lines,
                        "lineBudget": budget.total_lines,
                        "uncoveredMustHaves": sel.uncovered_must_haves,
                        "gapAnalysis": gap_report,
                        "matchReport": {
                            "atsCoveragePercentage": ats,
                            "mustHaveCoveragePercentage": gap_report.coverage_percentage,
                            "bulletsConsidered": bullet_texts.len(),
                            "aiRewrittenCount": 0,
                            "canonicalFallbackCount": bullet_texts.len(),
                            "atsParseCheck": ats_parse_json,
                        },
                        "materialization": materialization,
                        "llmStagesSkipped": ["jd-extraction-model", "bullet-rewrite", "critic"],
                    }))
                }
            };

            if is_async {
                let handle = task_manager.create_task("resume_synthesize", Some(600));
                let task_id = handle.task_id.clone();
                let task_mgr = Arc::clone(task_manager);
                let handle_clone = handle.clone();

                tokio::spawn(async move {
                    task_mgr.update_progress(
                        &task_id,
                        0.1,
                        Some("Analyzing JD and loading knowledgebase".to_string()),
                    );
                    if handle_clone.is_cancelled() {
                        task_mgr.fail_task(&task_id, "cancelled".to_string());
                        return;
                    }
                    // Progress is reported around the one real unit of work
                    // rather than interpolated with a sleep.
                    task_mgr.update_progress(
                        &task_id,
                        0.5,
                        Some("Scoring, selecting and computing coverage".to_string()),
                    );
                    match tokio::task::spawn_blocking(run).await {
                        Ok(Ok(val)) => task_mgr.complete_task(&task_id, val),
                        Ok(Err(e)) => task_mgr.fail_task(&task_id, e),
                        Err(e) => task_mgr.fail_task(&task_id, format!("Join error: {e}")),
                    }
                });

                return Ok(json!({
                    "taskId": handle.task_id,
                    "status": "working",
                    "message": "Resume synthesis started. Poll with 'tasks/get'.",
                }));
            }

            tokio::task::spawn_blocking(run)
                .await
                .map_err(|e| JsonRpcError::internal_error(format!("synthesis task error: {e}")))?
                .map_err(JsonRpcError::internal_error)
        }

        // ---------------------------------------------------------------
        // Defect #5: LaTeX was reported as compiled without being compiled.
        // ---------------------------------------------------------------
        "resume_compile" => {
            let typst_source = arguments.get("typst_source").and_then(|v| v.as_str());
            let latex_source = arguments.get("latex_source").and_then(|v| v.as_str());
            // PDF bytes are opt-in. A base64-encoded PDF is hundreds of
            // kilobytes straight into an agent context window; the useful
            // fields are `pageCount` and the diagnostics. Previously this arg
            // was accepted and silently ignored — a caller passing false got
            // the full payload anyway.
            let include_pdf = arguments
                .get("include_pdf")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if typst_source.is_some() && latex_source.is_some() {
                return Err(JsonRpcError::invalid_params(
                    "Provide exactly one of 'typst_source' or 'latex_source', not both",
                ));
            }

            if let Some(typst) = typst_source {
                if typst.trim().is_empty() {
                    return Err(JsonRpcError::invalid_params("'typst_source' is empty"));
                }
                let typst_owned = typst.to_string();
                let compile_res =
                    tokio::task::spawn_blocking(move || engine::compile_resume_pdf(&typst_owned))
                        .await
                        .map_err(|e| {
                            JsonRpcError::internal_error(format!("compile task error: {e}"))
                        })?;

                let pdf_base64 = if include_pdf {
                    compile_res.pdf_bytes.as_ref().map(|b| BASE64_STANDARD.encode(b))
                } else {
                    None
                };
                return Ok(json!({
                    "engine": "typst",
                    "success": compile_res.pdf_bytes.is_some(),
                    "errors": compile_res.errors,
                    "warnings": compile_res.warnings,
                    "pageCount": compile_res.page_count,
                    // Honest accounting: suppressed is not absent.
                    "pdfOmitted": !include_pdf && compile_res.pdf_bytes.is_some(),
                    "pdfBase64": pdf_base64,
                    "byteLength": compile_res.pdf_bytes.as_ref().map(|b| b.len()).unwrap_or(0),
                }));
            }

            if latex_source.is_some() {
                // Honest refusal. The in-process Tectonic driver cannot be
                // called from the long-lived MCP server: its C `font_cache`
                // static is not reset on failure, so a second failed compile
                // aborts the whole process, and it has no timeout. The
                // subprocess-isolated wrapper is private and the safe public
                // entry point needs a project directory plus LatexCompilerState,
                // neither of which the MCP transports have.
                return Err(JsonRpcError::invalid_params(
                    "LaTeX compilation is not available through the MCP server. The in-process \
                     Tectonic engine is not safe to call here (no timeout; a failed run poisons a \
                     process-wide font cache), and the subprocess path requires a project \
                     directory this transport does not have. Compile LaTeX in the desktop app, or \
                     pass 'typst_source' instead.",
                ));
            }

            Err(JsonRpcError::invalid_params(
                "Provide 'typst_source'. ('latex_source' is rejected: see resume_compile docs.)",
            ))
        }

        // ---------------------------------------------------------------
        // ATS parse simulation (IgniteCV port). Deterministic audit of how
        // an applicant tracking system would read the supplied text.
        // ---------------------------------------------------------------
        "resume_ats_check" => {
            let text = bounded_bytes(require_str(arguments, "text")?, "text", MAX_TEXT_BYTES)?;
            let system = match arguments.get("ats_system").and_then(|v| v.as_str()) {
                Some(raw) => {
                    let Some(parsed) = ats_sim::AtsSystemId::parse(raw) else {
                        return Err(JsonRpcError::invalid_params(format!(
                            "Unknown ats_system '{raw}'. Known systems: taleo, workday, \
                             greenhouse, lever, jobvite, icims, generic."
                        )));
                    };
                    parsed
                }
                None => ats_sim::AtsSystemId::Generic,
            };
            let jd_text = arguments
                .get("jd_text")
                .and_then(|v| v.as_str())
                .map(|jd| bounded_bytes(jd, "jd_text", MAX_TEXT_BYTES))
                .transpose()?;

            let report = ats_sim::simulate_ats_parsing(text, system);
            let mut out = serde_json::to_value(ats_sim::summarize_ats_parse(&report))
                .map_err(|e| JsonRpcError::internal_error(format!("ats encode: {e}")))?;
            if let Some(jd) = jd_text {
                let heat = ats_sim::generate_keyword_heatmap(text, jd);
                let heat_value = serde_json::to_value(ats_sim::summarize_keyword_heatmap(&heat))
                    .map_err(|e| JsonRpcError::internal_error(format!("heatmap encode: {e}")))?;
                if let Some(obj) = out.as_object_mut() {
                    obj.insert("heatmap".to_string(), heat_value);
                }
            }
            Ok(out)
        }

        // ---------------------------------------------------------------
        // Defect #2: never fabricate a metric. Report only what is there.
        // ---------------------------------------------------------------
        "resume_finetune_bullet" => {
            let bullet_text = bounded_bytes(require_str(arguments, "bullet_text")?, "bullet_text", MAX_TEXT_BYTES)?;
            let jd_text = bounded_bytes(require_str(arguments, "jd_text")?, "jd_text", MAX_TEXT_BYTES)?;
            let context = arguments.get("context").and_then(|v| v.as_str()).unwrap_or("");

            let extraction = jd::extract_profile(jd_text);
            let profile = &extraction.profile;

            let trimmed = bullet_text.trim();
            let lower = trimmed.to_lowercase();

            // Verified metrics may be supplied by the caller; we check them
            // against the text rather than inventing any.
            let supplied_metrics: Vec<String> = arguments
                .get("verified_metrics")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            // Blank entries are dropped rather than counted: an empty metric is
            // vacuously "preserved", which inflated suppliedMetricsPresent.
            let supplied_metrics: Vec<String> = supplied_metrics
                .into_iter()
                .filter(|m| !m.trim().is_empty())
                .collect();
            let missing_supplied: Vec<String> = supplied_metrics
                .iter()
                .filter(|m| !metrics::metric_preserved_in_text(m, trimmed))
                .cloned()
                .collect();

            let has_number = trimmed.chars().any(|c| c.is_ascii_digit());
            let has_unit = trimmed.contains('%') || trimmed.contains('$') || trimmed.contains('×');

            let first_word = trimmed.split_whitespace().next().unwrap_or("");
            let weak_openers = [
                "responsible", "helped", "assisted", "worked", "tasked",
                "involved", "participated", "supported", "contributed",
                "handled", "did", "made",
            ];
            let weak_opener = weak_openers
                .iter()
                .find(|w| lower.starts_with(*w))
                .map(|w| (*w).to_string());

            let matched_keywords: Vec<String> = profile
                .ats_keywords
                .iter()
                .filter(|k| crate::career_match::text::text_covers_skill(trimmed, k))
                .cloned()
                .collect();
            let missing_keywords: Vec<String> = profile
                .must_have_skills
                .iter()
                .filter(|k| !crate::career_match::text::text_covers_skill(trimmed, k))
                .cloned()
                .collect();

            let mut suggestions: Vec<String> = Vec::new();
            if let Some(w) = &weak_opener {
                suggestions.push(format!(
                    "Opens with the weak verb '{w}'. Lead with the action you took."
                ));
            }
            if !has_number {
                suggestions.push(
                    "No quantity present. If you have a verified figure for this work, add it. \
                     Do not invent one."
                        .to_string(),
                );
            }
            if !missing_supplied.is_empty() {
                suggestions.push(format!(
                    "These supplied metrics are not expressed in the text: {}",
                    missing_supplied.join(", ")
                ));
            }
            if !missing_keywords.is_empty() {
                suggestions.push(format!(
                    "JD must-haves not evidenced here: {}. Only add them if this work genuinely \
                     involved them.",
                    missing_keywords.join(", ")
                ));
            }
            if context.trim().is_empty() {
                suggestions.push(
                    "No context supplied; pass 'context' (role, org, verified metrics) for a \
                     sharper review."
                        .to_string(),
                );
            }

            Ok(json!({
                "original": bullet_text,
                // Deliberately absent: a machine-written "improved" bullet.
                // The previous implementation appended a fabricated
                // "(impact: improved latency/efficiency by 25%)" to any bullet
                // with no number in it.
                "rewrite": Value::Null,
                "rewritePolicy": "This server never generates or appends metrics. It reports \
                                  findings; you write the bullet and may resubmit it to \
                                  resume_rewrite_bullets for provenance verification.",
                "analysis": {
                    "hasNumber": has_number,
                    "hasUnit": has_unit,
                    "openingWord": first_word,
                    "weakOpener": weak_opener,
                    "suppliedMetricsPresent": supplied_metrics.len() - missing_supplied.len(),
                    "suppliedMetricsMissing": missing_supplied,
                    "jdKeywordsPresent": matched_keywords,
                    "jdMustHavesAbsent": missing_keywords,
                    "characterCount": trimmed.chars().count(),
                    "estimatedRenderedLines": selection::estimate_bullet_lines(
                        trimmed,
                        selection::CHARS_PER_LINE,
                    ),
                },
                "suggestions": suggestions,
                "recommendation": "Google X-Y-Z: accomplished [X], as measured by [Y], by doing [Z].",
            }))
        }

        _ => Err(JsonRpcError::method_not_found(name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::career_db::CareerDbState;

    fn db() -> CareerDbState {
        CareerDbState::open_in_memory().unwrap()
    }

    /// The resume tools accept arbitrary text straight from any MCP client;
    /// every text body is now byte-capped with the same error style as the
    /// career tools (`Argument '<key>' is N bytes, exceeding the M-byte limit`).
    #[tokio::test]
    async fn oversized_text_arguments_are_rejected_with_byte_limit_errors() {
        let db = db();
        let tasks = Arc::new(TaskManager::new());
        let big = "x".repeat(MAX_TEXT_BYTES + 1);
        let cases: Vec<(&str, Value)> = vec![
            ("resume_analyze_jd", json!({ "jd_text": big })),
            ("resume_gap_analysis", json!({ "jd_text": big })),
            ("resume_score_and_select", json!({ "jd_text": big })),
            (
                "resume_rewrite_bullets",
                json!({ "block_id": "b", "jd_text": big }),
            ),
            ("resume_synthesize", json!({ "jd_text": big })),
            ("resume_ats_check", json!({ "text": big })),
            (
                "resume_ats_check",
                json!({ "text": "ok", "jd_text": big }),
            ),
            (
                "resume_finetune_bullet",
                json!({ "bullet_text": "ok", "jd_text": big }),
            ),
            (
                "resume_finetune_bullet",
                json!({ "bullet_text": big, "jd_text": "ok" }),
            ),
        ];
        for (tool, args) in cases {
            let err = match execute_resume_tool(&db, &tasks, tool, &args).await {
                Ok(_) => panic!("{tool} accepted an oversized argument"),
                Err(e) => e,
            };
            assert_eq!(err.code, crate::mcp::protocol::ERR_INVALID_PARAMS, "{tool}");
            assert!(
                err.message.contains("byte limit"),
                "{tool} error text drifted: {}",
                err.message
            );
        }
    }

    /// Normal-sized inputs must still pass untouched.
    #[tokio::test]
    async fn normal_sized_inputs_still_pass_the_cap() {
        let db = db();
        let tasks = Arc::new(TaskManager::new());
        let out = execute_resume_tool(
            &db,
            &tasks,
            "resume_analyze_jd",
            &json!({ "jd_text": "We need a Rust engineer with Kubernetes and gRPC experience." }),
        )
        .await
        .unwrap();
        assert!(out.get("profile").is_some(), "analyze_jd lost its profile");

        let out = execute_resume_tool(
            &db,
            &tasks,
            "resume_ats_check",
            &json!({
                "text": "EXPERIENCE\nAcme — Engineer\nBuilt pipelines",
                "jd_text": "rust kubernetes"
            }),
        )
        .await
        .unwrap();
        assert!(
            out.get("sections").is_some() || out.get("heatmap").is_some(),
            "ats_check lost its report fields"
        );
    }
}
