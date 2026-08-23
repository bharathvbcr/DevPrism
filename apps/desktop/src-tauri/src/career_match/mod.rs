//! Deterministic resume/JD matching core, shared by the UI-driven Tauri
//! commands and the headless MCP server.
//!
//! # Why this module exists
//!
//! The canonical owner of resume synthesis is the TypeScript pipeline under
//! `apps/desktop/src/lib/resume-synthesis/`. It runs in the webview. The MCP
//! server does not: `main.rs --mcp` builds a Tokio runtime and a
//! `CareerDbState` and nothing else — no Tauri app, no webview, no JS engine.
//! So MCP cannot call the TypeScript, and before this module existed
//! `mcp/tools_resume.rs` filled the gap with ad-hoc heuristics that drifted
//! into fiction:
//!
//! * skill matching was bidirectional `contains`, so "go" matched "mongodb"
//!   and "Go" matched "Django";
//! * JD profiles used field names (`requiredSkills`, `cultureKeywords`) that no
//!   other layer understands;
//! * selection advertised knapsack + MMR but was a greedy first-fit;
//! * bullet scoring asked whether the JD contained the whole bullet, which is
//!   never true, so it was dead code;
//! * rewrite reported `provenanceVerified: true, hasHallucination: false`
//!   without rewriting anything, and coverage was hardcoded at 88%.
//!
//! Each submodule here is a **faithful port** of its TypeScript counterpart,
//! named in that module's header, with parity tests pinning the shared cases.
//! When behaviour must change, change both sides.
//!
//! Constants that must not drift: `CHARS_PER_LINE = 95`,
//! `DEFAULT_MAX_BULLETS_PER_BLOCK = 4`, score weights
//! `0.40/0.30/0.15/0.10/0.05`, org-replacement gap `0.12`.
//!
//! # The language boundary
//!
//! Only two of the seven pipeline stages need a model, and this module contains
//! neither. The MCP tools take model output as an *argument* (the caller's agent
//! supplies drafts) and this core verifies it — see `resume_rewrite_bullets`,
//! which checks every draft against the recorded metrics and rejects one that
//! drops or inflates a figure. When a stage cannot run because nothing supplied
//! the language, the tools report that rather than emitting a placeholder.

pub mod ats_sim;
pub mod gap;
pub mod jd;
pub mod metrics;
pub mod render;
pub mod scoring;
pub mod selection;
pub mod text;
pub mod typst_escape;

#[cfg(test)]
pub(crate) mod stress;

pub use jd::{JdExtraction, JdProfile};
pub use scoring::{ScoreComponents, ScoredBlock};
pub use selection::{SelectionBudget, SelectionResult};

/// Current UTC year/month, used for recency decay. Split out so tests can
/// pin a date instead of depending on the wall clock.
pub fn now_year_month() -> (i32, u32) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let (y, m, _) = civil_from_days(days);
    (y, m as u32)
}

/// Days-since-Unix-epoch → (year, month, day). Howard Hinnant's
/// `civil_from_days`; same routine as `career_typst::engine`, kept local so
/// this module stays independent of the Typst engine.
fn civil_from_days(z: i64) -> (i32, u8, u8) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u8;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}
