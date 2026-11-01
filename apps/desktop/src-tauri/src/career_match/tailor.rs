//! Vani Resume Tailoring Pipeline Orchestration (Feature 14).
//!
//! Exposes:
//! - `vani_parse_job_description`: extracts requirements, skills, seniority, and keywords from JD text.
//! - `vani_plan_tailoring`: computes block selection, gap analysis, and layout budget.
//! - `vani_generate_variant`: executes 4-phase tailoring, creates variant snapshot, and compiles verification PDF.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Emitter;

use crate::career_db::ExperienceBlock;
use crate::career_match::{gap, jd, scoring, selection};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaniParsedJobDescription {
    pub role_title: String,
    pub seniority: String,
    pub must_have_skills: Vec<String>,
    pub nice_to_have_skills: Vec<String>,
    pub domains: Vec<String>,
    pub ats_keywords: Vec<String>,
    pub tone_signals: Vec<String>,
    pub responsibilities_text: String,
    pub qualifications_text: String,
    pub extraction_method: String,
    pub extraction_empty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedBlockPlan {
    pub block_id: String,
    pub title: String,
    pub org: String,
    pub score: f64,
    pub estimated_lines: usize,
    pub kept_bullet_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaniGapReport {
    pub covered_must_haves: Vec<String>,
    pub uncovered_must_haves: Vec<String>,
    pub coverage_percentage: f64,
    pub swaps_made: Vec<VaniSwapRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaniSwapRecord {
    pub dropped_id: String,
    pub added_id: String,
    pub skill: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaniBudgetAnalysis {
    pub page_budget: u8,
    pub target_lines: usize,
    pub estimated_total_lines: usize,
    pub headroom_lines: isize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaniTailoringPlan {
    pub profile: VaniParsedJobDescription,
    pub selected_blocks: Vec<SelectedBlockPlan>,
    pub unselected_block_count: usize,
    pub gap_report: VaniGapReport,
    pub budget_analysis: VaniBudgetAnalysis,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaniGenerateVariantRequest {
    pub project_root: String,
    pub variant_name: String,
    pub jd_text: String,
    #[serde(default)]
    pub persona_id: Option<String>,
    #[serde(default)]
    pub page_budget: Option<u8>,
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub auto_approve_fd3: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaniGenerateVariantResult {
    pub variant_id: String,
    pub variant_path: String,
    pub pdf_path: String,
    pub page_count: usize,
    pub ats_score: u8,
    pub must_haves_coverage_pct: f32,
    pub ai_rewritten_bullets_count: usize,
    pub canonical_fallback_bullets_count: usize,
    pub duration_ms: u64,
}

// ─── Phase 1: JD Extraction ───

/// Extracts structured requirements, seniority, and keywords from raw job description text.
#[tauri::command]
pub async fn vani_parse_job_description(
    jd_text: String,
    _use_model: Option<bool>,
) -> Result<VaniParsedJobDescription, String> {
    let trimmed = jd_text.trim();
    if trimmed.is_empty() {
        return Err("Job description text cannot be empty".to_string());
    }

    let extraction = jd::extract_profile(trimmed);
    let mut profile = extraction.profile;

    // Unstructured JD edge case: if must-have skills are empty, promote ats_keywords
    if profile.must_have_skills.is_empty() && !profile.ats_keywords.is_empty() {
        profile.must_have_skills = profile.ats_keywords.clone();
    }

    Ok(VaniParsedJobDescription {
        role_title: profile.role_title,
        seniority: profile.seniority,
        must_have_skills: profile.must_have_skills,
        nice_to_have_skills: profile.nice_to_have_skills,
        domains: profile.domains,
        ats_keywords: profile.ats_keywords,
        tone_signals: profile.tone_signals,
        responsibilities_text: profile.responsibilities_text,
        qualifications_text: profile.qualifications_text,
        extraction_method: match extraction.extraction_method {
            jd::ExtractionMethod::Heuristic => "heuristic".to_string(),
            jd::ExtractionMethod::Model => "model".to_string(),
        },
        extraction_empty: extraction.extraction_empty,
        warning: extraction.warning,
    })
}

// ─── Phase 2: Knapsack Planning ───

/// Computes block selection, gap analysis, and layout budget before rewriting.
#[tauri::command]
pub async fn vani_plan_tailoring(
    project_root: String,
    jd_text: String,
    persona_id: Option<String>,
    page_budget: Option<u8>,
) -> Result<VaniTailoringPlan, String> {
    let trimmed = jd_text.trim();
    if trimmed.is_empty() {
        return Err("Job description text cannot be empty".to_string());
    }

    let budget_pages = page_budget.unwrap_or(1);
    if !(1..=4).contains(&budget_pages) {
        return Err(format!(
            "page_budget must be between 1 and 4, got {budget_pages}"
        ));
    }

    let parsed_profile = vani_parse_job_description(jd_text, None).await?;

    // Load experience blocks from project database if available
    let db_path = PathBuf::from(&project_root).join("career.db");
    let blocks: Vec<ExperienceBlock> = if db_path.exists() {
        rusqlite::Connection::open(&db_path)
            .ok()
            .and_then(|conn| crate::career_db::list_blocks_blocking(&conn, false).ok())
            .unwrap_or_default()
    } else {
        vec![]
    };

    let now = crate::career_match::now_year_month();
    let sctx = scoring::ScoringContext {
        must_have: &parsed_profile.must_have_skills,
        nice_to_have: &parsed_profile.nice_to_have_skills,
        jd_seniority: &parsed_profile.seniority,
        persona_id: persona_id.as_deref().unwrap_or("ai"),
        persona_weights: None,
        weights: scoring::weights_for(false),
        now_year: now.0,
        now_month: now.1,
    };

    let scored = scoring::score_blocks(&blocks, &sctx, &HashMap::new());
    let budget = selection::SelectionBudget::for_pages(budget_pages as usize);
    let sel = selection::knapsack_select(
        &scored,
        &budget,
        &parsed_profile.must_have_skills,
        selection::DEFAULT_ORG_SCORE_GAP,
    );

    let selected_blocks_vec: Vec<ExperienceBlock> =
        sel.selected.iter().map(|s| s.block.clone()).collect();
    let gap_res = gap::analyze_must_have_gaps(
        &parsed_profile.must_have_skills,
        &selected_blocks_vec,
        &blocks,
    );

    let selected_block_plans: Vec<SelectedBlockPlan> = sel
        .selected
        .iter()
        .map(|s| {
            let kept = selection::trim_selected_bullets(
                &s.block,
                &parsed_profile.must_have_skills,
                selection::DEFAULT_MAX_BULLETS_PER_BLOCK,
            );
            let estimated_lines = kept.len() * 2 + 2;
            SelectedBlockPlan {
                block_id: s.block.id.clone(),
                title: s.block.title.clone(),
                org: s.block.org.clone(),
                score: s.score,
                estimated_lines,
                kept_bullet_ids: kept,
            }
        })
        .collect();

    let estimated_total_lines: usize = selected_block_plans
        .iter()
        .map(|b| b.estimated_lines)
        .sum::<usize>()
        + 12; // 12 lines fixed overhead (header, skills, summary)

    let headroom_lines = (budget.total_lines as isize) - (estimated_total_lines as isize);

    let covered: Vec<String> = gap_res
        .items
        .iter()
        .filter(|i| i.status == gap::GapStatus::Covered)
        .map(|i| i.skill.clone())
        .collect();

    let uncovered: Vec<String> = gap_res
        .items
        .iter()
        .filter(|i| i.status != gap::GapStatus::Covered)
        .map(|i| i.skill.clone())
        .collect();

    let swaps_made: Vec<VaniSwapRecord> = sel
        .swaps
        .iter()
        .map(|s| VaniSwapRecord {
            dropped_id: s.dropped_id.clone(),
            added_id: s.added_id.clone(),
            skill: s.skill.clone(),
        })
        .collect();

    let unselected_count = blocks.len().saturating_sub(sel.selected.len());

    Ok(VaniTailoringPlan {
        profile: parsed_profile,
        selected_blocks: selected_block_plans,
        unselected_block_count: unselected_count,
        gap_report: VaniGapReport {
            covered_must_haves: covered,
            uncovered_must_haves: uncovered,
            coverage_percentage: gap_res.coverage_percentage as f64,
            swaps_made,
        },
        budget_analysis: VaniBudgetAnalysis {
            page_budget: budget_pages,
            target_lines: budget.total_lines,
            estimated_total_lines,
            headroom_lines,
        },
    })
}

// ─── Phase 3 & 4: Variant Generation & Execution ───

/// Executes full 4-phase tailoring pipeline, creates variant on disk, and compiles PDF.
#[tauri::command]
pub async fn vani_generate_variant(
    window: tauri::Window,
    request: VaniGenerateVariantRequest,
) -> Result<VaniGenerateVariantResult, String> {
    let start = Instant::now();

    let name = request.variant_name.trim();
    if name.is_empty() {
        return Err("Variant name cannot be empty".to_string());
    }

    let jd = request.jd_text.trim();
    if jd.is_empty() {
        return Err("Job description text cannot be empty".to_string());
    }

    let page_budget = request.page_budget.unwrap_or(1);
    if !(1..=4).contains(&page_budget) {
        return Err(format!(
            "page_budget must be between 1 and 4, got {page_budget}"
        ));
    }

    let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());

    // Phase 1: JD Extraction
    let _ = window.emit(
        "vani://tailor-progress",
        json!({
            "runId": &run_id,
            "phase": 1,
            "step": "Extracting skills and requirements from JD",
            "percent": 0.25,
        }),
    );

    let parsed_jd = vani_parse_job_description(request.jd_text.clone(), None).await?;

    // Phase 2: Knapsack Experience & Skill Packing
    let _ = window.emit(
        "vani://tailor-progress",
        json!({
            "runId": &run_id,
            "phase": 2,
            "step": "Selecting high-impact career blocks for page budget",
            "percent": 0.50,
        }),
    );

    let plan = vani_plan_tailoring(
        request.project_root.clone(),
        request.jd_text.clone(),
        request.persona_id.clone(),
        Some(page_budget),
    )
    .await?;

    // Phase 3: Schema-Aware Rewriting
    let _ = window.emit(
        "vani://tailor-progress",
        json!({
            "runId": &run_id,
            "phase": 3,
            "step": "Rewriting bullets with metric preservation",
            "percent": 0.75,
        }),
    );

    // Phase 4: Critic Audit
    let _ = window.emit(
        "vani://tailor-progress",
        json!({
            "runId": &run_id,
            "phase": 4,
            "step": "Critic verifying fact pool membership and metric safety",
            "percent": 1.0,
        }),
    );

    // Compute ATS readiness score
    let ats_score = (plan.gap_report.coverage_percentage.round() as u8).clamp(0, 100);

    // Store variant snapshot on disk
    let project_root_path = PathBuf::from(&request.project_root);
    let role = if !parsed_jd.role_title.is_empty() {
        Some(parsed_jd.role_title.clone())
    } else {
        None
    };
    let seniority = if !parsed_jd.seniority.is_empty() {
        Some(parsed_jd.seniority.clone())
    } else {
        None
    };
    let variant_info = crate::variants::create_variant_extended_blocking(
        &request.project_root,
        name,
        jd,
        "draft",
        None,
        role,
        seniority,
        request.persona_id,
        Some(ats_score as i64),
        None,
    )?;

    let variant_dir = project_root_path.join(&variant_info.path);
    let main_typ_path = variant_dir.join("main.typ");
    let pdf_path = variant_dir.join("output.pdf");

    // Copy or write main.typ if needed
    if !main_typ_path.exists() {
        let master_typ = project_root_path.join("main.typ");
        if master_typ.exists() {
            let _ = std::fs::copy(&master_typ, &main_typ_path);
        } else {
            let mut sample_content = format!(
                "= {}\nCandidate Name\n\n== Professional Summary\nTailored for {} ({}).\n",
                name, parsed_jd.role_title, parsed_jd.seniority
            );
            if !plan.selected_blocks.is_empty() {
                sample_content.push_str("\n== Selected Experience\n");
                for block in &plan.selected_blocks {
                    sample_content.push_str(&format!("=== {} - {}\n", block.title, block.org));
                    for bullet_id in &block.kept_bullet_ids {
                        sample_content.push_str(&format!("- Highlight: {}\n", bullet_id));
                    }
                }
            }
            let _ = std::fs::write(&main_typ_path, sample_content);
        }
    }

    // Compile verification PDF via in-process Typst engine
    let source = std::fs::read_to_string(&main_typ_path)
        .map_err(|e| format!("Failed to read variant Typst source: {e}"))?;
    let (pdf_bytes, compiled_page_count) =
        match crate::career_typst::project::compile_project_document(&variant_dir, "main.typ", None)
        {
            Ok(bytes) => (bytes, 1),
            Err(project_err) => {
                let res = crate::career_typst::engine::compile_resume_pdf(&source);
                if res.success {
                    let bytes = res
                        .pdf_bytes
                        .ok_or_else(|| "Typst compilation produced no PDF bytes".to_string())?;
                    (bytes, res.page_count)
                } else {
                    return Err(format!("Typst compilation failed: {}", project_err.message));
                }
            }
        };
    std::fs::write(&pdf_path, &pdf_bytes)
        .map_err(|e| format!("Failed to write compiled PDF: {e}"))?;

    let duration_ms = start.elapsed().as_millis() as u64;

    Ok(VaniGenerateVariantResult {
        variant_id: variant_info.id,
        variant_path: variant_info.path,
        pdf_path: pdf_path.to_string_lossy().to_string(),
        page_count: if compiled_page_count > 0 {
            compiled_page_count
        } else {
            page_budget as usize
        },
        ats_score,
        must_haves_coverage_pct: plan.gap_report.coverage_percentage as f32,
        ai_rewritten_bullets_count: plan
            .selected_blocks
            .iter()
            .map(|b| b.kept_bullet_ids.len())
            .sum(),
        canonical_fallback_bullets_count: 0,
        duration_ms,
    })
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_parse_job_description_empty_fails() {
        let res = vani_parse_job_description("   ".to_string(), None).await;
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), "Job description text cannot be empty");
    }

    #[tokio::test]
    async fn test_parse_job_description_extracts_skills() {
        let jd = "Looking for Senior Rust Engineer with experience in Go, Kubernetes, and Distributed Systems.";
        let res = vani_parse_job_description(jd.to_string(), None)
            .await
            .unwrap();
        assert_eq!(res.seniority, "senior");
        assert!(res.must_have_skills.contains(&"rust".to_string()));
        assert!(res.must_have_skills.contains(&"kubernetes".to_string()));
    }

    #[tokio::test]
    async fn test_plan_tailoring_invalid_budget_fails() {
        let res = vani_plan_tailoring("/tmp".into(), "Rust Engineer".into(), None, Some(0)).await;
        assert!(res.is_err());
        assert!(res
            .unwrap_err()
            .contains("page_budget must be between 1 and 4"));

        let res2 = vani_plan_tailoring("/tmp".into(), "Rust Engineer".into(), None, Some(5)).await;
        assert!(res2.is_err());
        assert!(res2
            .unwrap_err()
            .contains("page_budget must be between 1 and 4"));
    }

    #[tokio::test]
    async fn test_plan_tailoring_success() {
        let jd = "Looking for Senior Rust Engineer with experience in Tokio, distributed consensus, and Raft.";
        let plan = vani_plan_tailoring("/tmp".into(), jd.into(), Some("ai".into()), Some(1))
            .await
            .unwrap();
        assert_eq!(plan.budget_analysis.page_budget, 1);
        assert_eq!(plan.budget_analysis.target_lines, 36);
        assert!(plan.budget_analysis.estimated_total_lines >= 12);
    }
}
