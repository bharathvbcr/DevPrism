//! Deterministic resume/JD matching logic shared by the MCP tool surface.
//!
//! # Why this module exists
//!
//! The canonical owner of resume synthesis is the TypeScript pipeline under
//! `apps/desktop/src/lib/resume-synthesis/`. It runs in the webview and cannot
//! be called from the headless MCP server (stdio/HTTP transports have no
//! frontend). Before this module existed, `mcp/tools_resume.rs` filled that gap
//! with ad-hoc heuristics inline in its dispatch arms, which drifted badly from
//! the canonical behaviour:
//!
//! * skill matching was bidirectional `contains`, so "go" matched "mongodb";
//! * JD profiles used field names (`requiredSkills`, `cultureKeywords`) that no
//!   other layer understands;
//! * selection advertised knapsack + MMR but was a greedy first-fit;
//! * bullet scoring asked whether the JD contained the whole bullet, which is
//!   never true, so it was dead code;
//! * rewrite and coverage reported hardcoded success values.
//!
//! Each submodule here is a **faithful port** of its TypeScript counterpart,
//! named in that module's header, with parity tests pinning the shared cases.
//! When behaviour must change, change both sides.
//!
//! # What is deliberately NOT here
//!
//! Anything that needs an LLM (JD extraction proper, bullet rewriting, the
//! critic) stays out. The MCP tools expose the deterministic subset and report
//! honestly when a step could not run, rather than emitting a plausible
//! placeholder.

pub mod gap;
pub mod jd;
pub mod metrics;
pub mod render;
pub mod scoring;
pub mod selection;
pub mod text;
pub mod typst_escape;
