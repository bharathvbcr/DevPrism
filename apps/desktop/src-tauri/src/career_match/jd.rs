//! Job-description profile extraction.
//!
//! # Canonical shape
//!
//! [`JdProfile`] mirrors `JDProfile` in
//! `src/lib/resume-synthesis/types.ts` field for field: `roleTitle`,
//! `seniority`, `mustHaveSkills`, `niceToHaveSkills`, `domains`,
//! `atsKeywords`, `toneSignals`, `responsibilitiesText`,
//! `qualificationsText`.
//!
//! The previous MCP heuristic emitted a *different* shape entirely
//! (`title`, `company`, `requiredSkills`, `preferredSkills`, `domain`,
//! `cultureKeywords`) that overlapped the canonical type on one key. Nothing
//! downstream of the MCP server could consume it.
//!
//! # Heuristic, and honest about it
//!
//! The canonical extractor (`analyzeJobDescription`) is LLM-driven. The MCP
//! server is headless and has no guaranteed model, so this module extracts
//! deterministically from a controlled vocabulary and the JD's own section
//! structure. It therefore reports [`ExtractionMethod::Heuristic`] and callers
//! surface that, rather than presenting heuristic output as model-quality
//! extraction. The old code hardcoded a 20-item skill list and split it
//! "first four are required, rest are preferred", which is not an analysis.

use super::text::{contains_at_boundary, text_covers_skill};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How a profile was produced. Lets callers avoid presenting a keyword scan as
/// if it were semantic extraction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtractionMethod {
    /// Deterministic vocabulary + section scan (this module).
    Heuristic,
    /// Produced by a language model (the canonical TS path).
    Model,
}

/// Canonical JD profile. Field names and casing match the TypeScript type.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JdProfile {
    pub role_title: String,
    pub seniority: String,
    pub must_have_skills: Vec<String>,
    pub nice_to_have_skills: Vec<String>,
    pub domains: Vec<String>,
    pub ats_keywords: Vec<String>,
    pub tone_signals: Vec<String>,
    pub responsibilities_text: String,
    pub qualifications_text: String,
}

impl JdProfile {
    /// Mirrors `isExtractionEmpty`: the scan found nothing usable to match on.
    ///
    /// Single owner for this rule — `extract_profile` and the language layer
    /// both go through it, so a change cannot apply to only one of them.
    pub fn is_extraction_empty(&self) -> bool {
        self.must_have_skills.is_empty()
            && self.nice_to_have_skills.is_empty()
            && self.ats_keywords.is_empty()
    }
}

/// A profile plus provenance about how it was derived.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JdExtraction {
    #[serde(flatten)]
    pub profile: JdProfile,
    pub extraction_method: ExtractionMethod,
    /// True when the scan found no skills at all, mirroring `isExtractionEmpty`.
    pub extraction_empty: bool,
    /// Set when the JD is too short to analyse meaningfully.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Mirrors `JD_NONTRIVIAL_MIN_CHARS` in jd-analysis.ts.
pub const JD_NONTRIVIAL_MIN_CHARS: usize = 200;

/// Controlled vocabulary.
///
/// Deliberately broad: the JD this engine is most often pointed at is an
/// AI/ML evaluation role whose real requirements ("annotation", "inter-rater
/// reliability", "R", "human-in-the-loop") were entirely absent from the old
/// 20-item list, so the tool reported them as covered-by-omission.
const VOCABULARY: &[&str] = &[
    // Languages and runtimes
    "python", "r", "sql", "rust", "go", "golang", "java", "javascript",
    "typescript", "c++", "c#", "scala", "swift", "kotlin", "ruby", "php",
    "matlab", "bash", "shell", "perl", "julia",
    // ML / AI
    "machine learning", "deep learning", "nlp", "nlu", "generative ai",
    "llm", "large language models", "transformers", "pytorch", "tensorflow",
    "jax", "scikit-learn", "keras", "hugging face", "fine-tuning", "rlhf",
    "prompt engineering", "embeddings", "rag", "computer vision",
    "speech recognition", "asr", "tts", "multimodal", "reinforcement learning",
    "model evaluation", "benchmarking", "agentic", "ai safety",
    "responsible ai",
    // Human data / annotation / evaluation
    "annotation", "data annotation", "labeling", "labelling", "human evaluation",
    "human-in-the-loop", "inter-rater reliability", "inter-annotator agreement",
    "quality assurance", "quality framework", "statistical process control",
    "gold set", "calibration", "adjudication", "taxonomy", "guidelines",
    "crowdsourcing", "vendor management", "data collection", "data curation",
    "linguistics", "cognitive science", "psycholinguistics", "human factors",
    "user research", "usability", "experimental design", "a/b testing",
    "survey design", "qualitative research", "quantitative research",
    // Data / infra
    "etl", "data pipeline", "airflow", "spark", "hadoop", "kafka", "dbt",
    "snowflake", "bigquery", "redshift", "postgresql", "mysql", "sqlite",
    "mongodb", "redis", "elasticsearch", "pandas", "numpy", "statistics",
    "data analysis", "data visualization", "tableau", "looker", "dashboards",
    // Cloud / platform
    "aws", "gcp", "azure", "kubernetes", "docker", "terraform", "ci/cd",
    "microservices", "rest", "graphql", "grpc", "distributed systems",
    // Compliance
    "privacy", "gdpr", "compliance", "governance", "data governance",
    "hipaa", "glp", "gcp for clinical trials", "irb",
    // Process
    "cross-functional", "stakeholder management", "program management",
    "project management", "roadmap", "agile", "scrum",
];

/// Words that signal culture/tone rather than capability.
const TONE_VOCABULARY: &[&str] = &[
    "ownership", "impact", "collaboration", "collaborative", "scale",
    "velocity", "autonomy", "ambiguity", "fast-paced", "cross-functional",
    "customer-obsessed", "detail-oriented", "self-starter", "mentorship",
    "innovative", "curious", "rigorous", "pragmatic",
];

/// Domain hints.
const DOMAIN_VOCABULARY: &[&str] = &[
    "machine learning", "artificial intelligence", "data science",
    "infrastructure", "security", "healthcare", "biotech", "fintech",
    "e-commerce", "media", "education", "robotics", "search",
    "recommendations", "advertising", "developer tools", "linguistics",
    "cognitive science", "human factors",
];

/// Headings that open a "must have" section.
const MUST_HAVE_HEADINGS: &[&str] = &[
    "minimum qualifications",
    "minimum requirements",
    "basic qualifications",
    "required qualifications",
    "requirements",
    "what you'll need",
    "what you need",
    "qualifications",
];

/// Headings that open a "nice to have" section.
const NICE_TO_HAVE_HEADINGS: &[&str] = &[
    "preferred qualifications",
    "preferred requirements",
    "nice to have",
    "nice-to-have",
    "bonus points",
    "desired qualifications",
    "preferred",
];

/// Headings that open a responsibilities section.
const RESPONSIBILITY_HEADINGS: &[&str] = &[
    "responsibilities",
    "what you'll do",
    "what you will do",
    "the role",
    "about the role",
    "key responsibilities",
    "duties",
];

/// Which bucket a line of the JD currently belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    Preamble,
    Responsibilities,
    MustHave,
    NiceToHave,
}

/// Classify a line as a section heading, if it is one.
///
/// Checked most-specific first: "preferred qualifications" must win over the
/// bare "qualifications" heading, otherwise every preferred skill would be
/// promoted to must-have.
fn heading_for(line: &str) -> Option<Section> {
    // Strip list/markdown ornament so "## Minimum Qualifications" and
    // "**Preferred Qualifications**" are recognised.
    let mut l = line.trim();
    l = l.trim_start_matches(['#', '*', '-', '•', '=', '_', ' ']);
    l = l.trim_end_matches(['*', '#', '_', ':', '.', ' ']);
    let l = l.to_lowercase();
    if l.is_empty() || l.chars().count() > 60 {
        return None;
    }

    // A heading is the WHOLE line, not a prefix of it. Matching on `starts_with`
    // swallowed ordinary content: "Requirements gathering with stakeholders"
    // opened a must-have section, and everything after it was misfiled.
    // A short trailing remainder is tolerated so "Minimum Qualifications (US)"
    // still reads as a heading.
    let matches = |headings: &[&str]| -> bool {
        headings.iter().any(|h| {
            if l == *h {
                return true;
            }
            let Some(rest) = l.strip_prefix(h) else { return false };
            let rest = rest.trim();
            // Only punctuation-led fragments count as heading decoration.
            rest.is_empty()
                || (rest.chars().count() <= 12
                    && rest.starts_with(|c: char| !c.is_alphanumeric()))
        })
    };

    if matches(NICE_TO_HAVE_HEADINGS) {
        return Some(Section::NiceToHave);
    }
    if matches(MUST_HAVE_HEADINGS) {
        return Some(Section::MustHave);
    }
    if matches(RESPONSIBILITY_HEADINGS) {
        return Some(Section::Responsibilities);
    }
    None
}

fn push_unique(out: &mut Vec<String>, value: &str) {
    if value.is_empty() {
        return;
    }
    // Alias-aware: the vocabulary lists both "go" and "golang", which are the
    // same requirement, and emitting both double-counted it in scoring.
    let key = super::text::canonical_skill_key(value);
    if out.iter().any(|e| {
        e.eq_ignore_ascii_case(value)
            || (!key.is_empty() && super::text::canonical_skill_key(e) == key)
    }) {
        return;
    }
    out.push(value.to_string());
}

/// Detect seniority. Order matters: "staff" and "principal" outrank "senior",
/// and an explicit years-of-experience floor promotes an untitled role.
/// Seniority is read from the title region only.
///
/// Scanning the whole JD matched prose like "you will work with senior
/// stakeholders" or "reports to the director" and promoted an IC role.
fn seniority_scope(jd_text: &str) -> String {
    // The detected role title when there is one. Widening this even to the
    // first few lines was wrong: "Partner with senior stakeholders and the
    // director" promoted an analyst role to director.
    let title = detect_role_title(jd_text);
    if !title.is_empty() {
        return title.to_lowercase();
    }
    // A prose posting with no title line ("We are seeking a Senior Rust
    // Engineer...") still states seniority up front, so fall back to the first
    // non-empty line only.
    jd_text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_lowercase()
}

fn detect_seniority(title_scope: &str, whole: &str) -> String {
    let lower = title_scope;
    for (needle, level) in [
        ("director", "director"),
        ("vp of", "director"),
        ("head of", "director"),
        ("principal", "lead"),
        ("staff", "lead"),
        ("lead ", "lead"),
        ("manager", "manager"),
        ("senior", "senior"),
        ("sr.", "senior"),
        ("junior", "ic"),
        ("intern", "ic"),
        ("entry level", "ic"),
    ] {
        if lower.contains(needle) {
            return level.to_string();
        }
    }
    // "8+ years" style floors imply seniority even with a plain title, and are
    // read from the whole posting.
    if let Some(years) = max_years_required(whole) {
        if years >= 8 {
            return "lead".to_string();
        }
        if years >= 4 {
            return "senior".to_string();
        }
    }
    "ic".to_string()
}

/// Largest `N+ years` figure in the text.
fn max_years_required(lower: &str) -> Option<u32> {
    let bytes = lower.as_bytes();
    let mut best: Option<u32> = None;
    let mut i = 0usize;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        let num: u32 = lower[start..i].parse().unwrap_or(0);
        let rest = lower[i..].trim_start_matches(['+', '-', ' ']);
        // A range like "3-5 years" reports the upper bound, which is why the
        // scan keeps going rather than stopping at the first figure.
        if rest.starts_with("year") && num > 0 && num <= 60 {
            best = Some(best.map_or(num, |b: u32| b.max(num)));
        }
    }
    best
}

/// Best-effort role title: the first non-empty line that is short enough to be
/// a title and is not a section heading.
fn detect_role_title(jd_text: &str) -> String {
    for line in jd_text.lines() {
        let t = line.trim();
        if t.is_empty() || t.len() > 90 {
            continue;
        }
        if heading_for(t).is_some() {
            continue;
        }
        // Skip obvious metadata lines.
        let lower = t.to_lowercase();
        if lower.starts_with("posted:")
            || lower.starts_with("role number")
            || lower.starts_with("summary")
            || lower.starts_with("description")
        {
            continue;
        }
        return t.to_string();
    }
    String::new()
}

/// Every controlled-vocabulary skill named in `text`, word-boundary matched.
///
/// Shared with fact distillation so a fact's skills and a JD's requirements are
/// drawn from the same vocabulary and compare directly.
pub fn skills_in_text(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for skill in VOCABULARY {
        if text_covers_skill(text, skill) {
            push_unique(&mut out, skill);
        }
    }
    out
}

/// Extract a canonical [`JdProfile`] from raw JD text.
pub fn extract_profile(jd_text: &str) -> JdExtraction {
    let mut must: Vec<String> = Vec::new();
    let mut nice: Vec<String> = Vec::new();
    let mut ats: Vec<String> = Vec::new();
    let mut responsibilities = String::new();
    let mut qualifications = String::new();

    let mut section = Section::Preamble;
    for line in jd_text.lines() {
        if let Some(next) = heading_for(line) {
            section = next;
            continue;
        }
        match section {
            Section::Responsibilities => {
                responsibilities.push_str(line);
                responsibilities.push('\n');
            }
            Section::MustHave | Section::NiceToHave => {
                qualifications.push_str(line);
                qualifications.push('\n');
            }
            Section::Preamble => {}
        }

        for skill in VOCABULARY {
            if !text_covers_skill(line, skill) {
                continue;
            }
            match section {
                Section::MustHave => push_unique(&mut must, skill),
                Section::NiceToHave => push_unique(&mut nice, skill),
                _ => push_unique(&mut ats, skill),
            }
        }
    }

    // A skill named in both sections is a must-have; drop the weaker copy.
    nice.retain(|n| !must.iter().any(|m| m.eq_ignore_ascii_case(n)));

    // ATS keywords are the union: anything named anywhere is worth echoing.
    let mut ats_keywords: Vec<String> = Vec::new();
    for s in must.iter().chain(nice.iter()).chain(ats.iter()) {
        push_unique(&mut ats_keywords, s);
    }

    // When the JD has no recognised section headings, everything landed in
    // `ats`. Promote it to must-have so scoring has something to work with,
    // rather than reporting zero requirements.
    if must.is_empty() && nice.is_empty() && !ats.is_empty() {
        must = ats.clone();
    }

    let lower = jd_text.to_lowercase();

    let mut domains: Vec<String> = Vec::new();
    for d in DOMAIN_VOCABULARY {
        if text_covers_skill(&lower, d) {
            push_unique(&mut domains, d);
        }
    }

    let mut tone_signals: Vec<String> = Vec::new();
    for t in TONE_VOCABULARY {
        if text_covers_skill(&lower, t) {
            push_unique(&mut tone_signals, t);
        }
    }

    let profile = JdProfile {
        role_title: detect_role_title(jd_text),
        seniority: detect_seniority(&seniority_scope(jd_text), &lower),
        must_have_skills: must,
        nice_to_have_skills: nice,
        domains,
        ats_keywords,
        tone_signals,
        responsibilities_text: responsibilities.trim().to_string(),
        qualifications_text: qualifications.trim().to_string(),
    };
    // Single owner for the rule; the language layer asks the same question of
    // model-derived profiles.
    let extraction_empty = profile.is_extraction_empty();
    let warning = if jd_text.trim().chars().count() < JD_NONTRIVIAL_MIN_CHARS {
        Some(format!(
            "Job description is under {JD_NONTRIVIAL_MIN_CHARS} characters; \
             heuristic extraction is unreliable at this length."
        ))
    } else if extraction_empty {
        Some(
            "No known skills matched the controlled vocabulary. Treat this \
             profile as empty rather than as evidence of no requirements."
                .to_string(),
        )
    } else {
        None
    };

    JdExtraction {
        profile,
        extraction_method: ExtractionMethod::Heuristic,
        extraction_empty,
        warning,
    }
}

/// Port of `normalizeSeniority`. Order matters: director before manager before
/// lead before senior, so "Senior Engineering Manager" resolves to manager.
pub fn normalize_seniority(value: &str) -> String {
    let v = value.trim().to_lowercase();
    if matches!(v.as_str(), "ic" | "senior" | "lead" | "manager" | "director") {
        return v;
    }
    if v.contains("director") || v.contains("vp") || v.contains("head of") {
        return "director".into();
    }
    if v.contains("manager") || v.contains("mgmt") {
        return "manager".into();
    }
    if v.contains("lead") || v.contains("staff") || v.contains("principal") {
        return "lead".into();
    }
    // `sr\b` in TS — require a word boundary after "sr" so "usr" does not match.
    if v.contains("senior") || contains_at_boundary(&v, "sr") {
        return "senior".into();
    }
    if v.contains("junior")
        || v.contains("entry")
        || v.contains("associate")
        || contains_at_boundary(&v, "ic")
    {
        return "ic".into();
    }
    "senior".into()
}

fn as_string_array(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Char-safe prefix. Never splits a multi-byte character.
pub fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Port of `normalizeJDProfile`: accept whatever a language model returned and
/// coerce it into the canonical shape, falling back to JD slices for the facet
/// text.
///
/// This is the model-supplied counterpart to [`extract_profile`], which is the
/// deterministic fallback used when the caller supplies no model. Callers that
/// use this path report [`ExtractionMethod::Model`].
pub fn normalize(value: &Value, jd_text: &str) -> JdProfile {
    let obj = value.as_object();
    let get = |k: &str| obj.and_then(|o| o.get(k));
    let get_str = |k: &str| {
        get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };

    let role_title = get_str("roleTitle")
        .or_else(|| get_str("role"))
        .unwrap_or("Role")
        .to_string();

    // TS slices by UTF-16 code unit; we slice by char boundary. The cap is a
    // budget, not a contract, so a few characters of difference is harmless —
    // but it must never panic on a multi-byte boundary.
    let slice_1200 = || truncate_chars(jd_text, 1200);

    JdProfile {
        role_title,
        seniority: normalize_seniority(get_str("seniority").unwrap_or("")),
        must_have_skills: as_string_array(get("mustHaveSkills")),
        nice_to_have_skills: as_string_array(get("niceToHaveSkills")),
        domains: as_string_array(get("domains")),
        ats_keywords: as_string_array(get("atsKeywords")),
        tone_signals: as_string_array(get("toneSignals")),
        responsibilities_text: get_str("responsibilitiesText")
            .map(str::to_string)
            .unwrap_or_else(slice_1200),
        qualifications_text: get_str("qualificationsText")
            .map(str::to_string)
            .unwrap_or_else(slice_1200),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Condensed from the real Apple "AI/ML Evaluation Specialist, Human Data"
    /// posting that exposed the original 20-skill list as inadequate.
    const APPLE_JD: &str = "AI/ML Evaluation Specialist, Human Data
Cupertino, California, United States
Posted: Jul 02, 2026
Role Number:200670744-0836

Description
The Human-centered AI team is looking for an ML Evaluation Specialist to join our
Data Quality and Operations division, specialising in data collection, curation,
annotation, and human evaluation efforts.

Responsibilities
* Lead the end-to-end execution of human data collection programs for multilingual,
  multimodal, and multi-turn AI features
* Build and implement human data quality frameworks, including developing statistical
  process controls to detect quality degradation
* Design and own the measurement framework, defining indicators such as spend, speed,
  inter-rater reliability, and volume

Minimum Qualifications
* Bachelor's degree in Cognitive Science, Linguistics, or a related field
* 4+ years of experience defining and leading cross-team human data programs for AI/ML,
  including annotation operations and quality frameworks, within an NLP/NLU or
  generative AI environment
* Proficiency in programming and data languages (Python, R, SQL) to process and analyze
  large datasets
* Expertise in end-to-end data annotation quality management
* Familiarity with privacy-preserving data handling practices and compliance frameworks

Preferred Qualifications
* Master's degree in Cognitive Science, Linguistics, or a related field
* Experience managing external vendor or workforce partners at scale
* Familiarity with AI Safety and Responsible AI principles
";

    #[test]
    fn skills_in_text_extracts_from_a_fact_sentence() {
        let s = skills_in_text("Built a Python ETL pipeline feeding a PostgreSQL warehouse");
        assert!(s.contains(&"python".to_string()), "{s:?}");
        assert!(s.contains(&"postgresql".to_string()), "{s:?}");
        assert!(skills_in_text("Wrote the onboarding doc").is_empty());
    }

    #[test]
    fn apple_jd_surfaces_the_requirements_the_old_list_missed() {
        let e = extract_profile(APPLE_JD);
        let must = &e.profile.must_have_skills;
        for expected in ["python", "r", "sql", "annotation", "linguistics", "cognitive science"] {
            assert!(
                must.iter().any(|s| s == expected),
                "must-have {expected:?} missing from {must:?}"
            );
        }
        assert!(!e.extraction_empty);
    }

    #[test]
    fn preferred_section_does_not_leak_into_must_have() {
        let e = extract_profile(APPLE_JD);
        assert!(
            e.profile.nice_to_have_skills.iter().any(|s| s == "vendor management"
                || s == "ai safety"
                || s == "responsible ai"),
            "nice-to-have was {:?}",
            e.profile.nice_to_have_skills
        );
        // "preferred qualifications" must not be swallowed by "qualifications".
        assert!(!e.profile.must_have_skills.iter().any(|s| s == "responsible ai"));
    }

    #[test]
    fn single_letter_skill_r_does_not_match_every_word() {
        // "R" is a real requirement, but must only match as a standalone token.
        let e = extract_profile(
            "Minimum Qualifications\n* Strong programming in Rust and Ruby for our backend\n",
        );
        assert!(!e.profile.must_have_skills.iter().any(|s| s == "r"));
        assert!(e.profile.must_have_skills.iter().any(|s| s == "rust"));
    }

    #[test]
    fn substring_collisions_do_not_create_requirements() {
        let e = extract_profile("Minimum Qualifications\n* Experience with MongoDB at scale\n");
        assert!(!e.profile.must_have_skills.iter().any(|s| s == "go"));
        assert!(e.profile.must_have_skills.iter().any(|s| s == "mongodb"));
    }

    #[test]
    fn seniority_is_detected_from_title_and_years() {
        assert_eq!(extract_profile("Senior Software Engineer").profile.seniority, "senior");
        assert_eq!(extract_profile("Staff Engineer").profile.seniority, "lead");
        assert_eq!(extract_profile("Principal Engineer").profile.seniority, "lead");
        assert_eq!(extract_profile("Engineering Manager").profile.seniority, "manager");
        assert_eq!(extract_profile("Director of Data").profile.seniority, "director");
        // Untitled role with an experience floor.
        assert_eq!(
            extract_profile("Data Scientist\n* 6+ years of experience required").profile.seniority,
            "senior"
        );
        assert_eq!(extract_profile("Software Engineer").profile.seniority, "ic");
    }

    #[test]
    fn role_title_skips_metadata_lines() {
        let e = extract_profile(APPLE_JD);
        assert_eq!(e.profile.role_title, "AI/ML Evaluation Specialist, Human Data");
    }

    #[test]
    fn short_jd_is_flagged_not_silently_analysed() {
        let e = extract_profile("We need a Python dev.");
        assert!(e.warning.is_some(), "short JD should warn");
        assert_eq!(e.extraction_method, ExtractionMethod::Heuristic);
    }

    #[test]
    fn empty_extraction_is_reported_not_disguised() {
        let jd = "x".repeat(400);
        let e = extract_profile(&jd);
        assert!(e.extraction_empty);
        assert!(e.warning.is_some());
        assert!(e.profile.must_have_skills.is_empty());
    }

    #[test]
    fn headingless_jd_still_produces_requirements() {
        let jd = format!(
            "We want someone strong in Python and Kubernetes, ideally both. {}",
            "Additional context. ".repeat(20)
        );
        let e = extract_profile(&jd);
        assert!(e.profile.must_have_skills.iter().any(|s| s == "python"));
        assert!(e.profile.must_have_skills.iter().any(|s| s == "kubernetes"));
    }

    /// A requirement ending a sentence is now extracted. Previously the
    /// trailing '.' blocked the match and the requirement was silently dropped.
    #[test]
    fn a_sentence_final_requirement_is_extracted() {
        let e = extract_profile(&format!(
            "Minimum Qualifications\n* Deep experience with Kubernetes.\n{}",
            "Filler line.\n".repeat(30)
        ));
        assert!(
            e.profile.must_have_skills.iter().any(|s| s == "kubernetes"),
            "sentence-final requirement dropped: {:?}",
            e.profile.must_have_skills
        );
        let ok = extract_profile(&format!(
            "Minimum Qualifications\n* Deep experience with Kubernetes, at scale\n{}",
            "Filler line.\n".repeat(30)
        ));
        assert!(ok.profile.must_have_skills.iter().any(|s| s == "kubernetes"));
    }

    #[test]
    fn empty_and_giant_inputs_are_safe() {
        let e = extract_profile("");
        assert!(e.extraction_empty);
        assert!(e.profile.role_title.is_empty());

        let huge = "Python engineering work. ".repeat(20_000);
        let e2 = extract_profile(&huge);
        assert!(e2.profile.must_have_skills.iter().any(|s| s == "python"));
    }

    #[test]
    fn profile_serialises_with_canonical_camel_case_keys() {
        let e = extract_profile(APPLE_JD);
        let v = serde_json::to_value(&e).unwrap_or(serde_json::Value::Null);
        for key in [
            "roleTitle",
            "seniority",
            "mustHaveSkills",
            "niceToHaveSkills",
            "domains",
            "atsKeywords",
            "toneSignals",
            "responsibilitiesText",
            "qualificationsText",
            "extractionMethod",
        ] {
            assert!(v.get(key).is_some(), "missing key {key} in {v}");
        }
        // The old, non-canonical field names must be gone.
        for stale in ["requiredSkills", "preferredSkills", "cultureKeywords", "company"] {
            assert!(v.get(stale).is_none(), "stale key {stale} still present");
        }
    }

    // --- Regressions from the adversarial pass. ---

    /// A content line that merely STARTS with a heading word must not open a
    /// section; that misfiled everything after it.
    #[test]
    fn a_content_line_is_not_mistaken_for_a_heading() {
        let jd = format!(
            "Data Scientist\n\nResponsibilities\n* Requirements gathering with stakeholders\n             * Build dashboards in Python\n\nPreferred Qualifications\n* Kubernetes, at scale\n{}",
            "Filler line, more text.\n".repeat(20)
        );
        let e = extract_profile(&jd);
        // "Requirements gathering..." must NOT have opened a must-have section,
        // so Python stays out of must-have.
        assert!(
            !e.profile.must_have_skills.iter().any(|s| s == "python"),
            "content line opened a section: must={:?}",
            e.profile.must_have_skills
        );
        assert!(e.profile.nice_to_have_skills.iter().any(|s| s == "kubernetes"));
    }

    #[test]
    fn markdown_and_bold_headings_are_recognised() {
        for heading in [
            "## Minimum Qualifications",
            "**Minimum Qualifications**",
            "MINIMUM QUALIFICATIONS:",
            "- Minimum Qualifications",
            "Minimum Qualifications (US)",
        ] {
            let jd = format!("Engineer\n\n{heading}\n* Strong Python and SQL\n{}",
                             "Filler line, more.\n".repeat(20));
            let e = extract_profile(&jd);
            assert!(
                e.profile.must_have_skills.iter().any(|s| s == "python"),
                "heading {heading:?} not recognised: {:?}",
                e.profile.must_have_skills
            );
        }
    }

    /// Seniority must come from the title, not from body prose.
    #[test]
    fn a_prose_posting_without_a_title_line_still_reports_seniority() {
        let jd = "We are seeking a Senior Rust Engineer to build high-performance \
                  desktop applications with Distributed Systems experience.";
        assert_eq!(extract_profile(jd).profile.seniority, "senior");
    }

    #[test]
    fn body_prose_does_not_promote_seniority() {
        let jd = format!(
            "Data Analyst\n\nResponsibilities\n* Partner with senior stakeholders and the director\n             * Support the principal investigator\n{}",
            "Filler line, more.\n".repeat(20)
        );
        assert_eq!(extract_profile(&jd).profile.seniority, "ic");
        // A genuinely senior title still resolves.
        assert_eq!(extract_profile("Senior Data Analyst").profile.seniority, "senior");
    }

    #[test]
    fn alias_duplicates_are_collapsed() {
        let jd = format!(
            "Engineer\n\nMinimum Qualifications\n* Experience with Go and Golang services\n{}",
            "Filler line, more.\n".repeat(20)
        );
        let must = extract_profile(&jd).profile.must_have_skills;
        let go_like = must.iter().filter(|s| *s == "go" || *s == "golang").count();
        assert_eq!(go_like, 1, "alias duplicate emitted: {must:?}");
    }

    #[test]
    fn year_ranges_report_the_upper_bound() {
        assert_eq!(max_years_required("3-5 years of experience"), Some(5));
        assert_eq!(max_years_required("10+ years required"), Some(10));
        assert_eq!(max_years_required("no figure here"), None);
        assert_eq!(max_years_required("100 years"), None);
    }
}
