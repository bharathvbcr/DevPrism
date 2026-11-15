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
    "python",
    "r",
    "sql",
    "rust",
    "go",
    "golang",
    "java",
    "javascript",
    "typescript",
    "c++",
    "c#",
    "scala",
    "swift",
    "kotlin",
    "ruby",
    "php",
    "matlab",
    "bash",
    "shell",
    "perl",
    "julia",
    // ML / AI
    "machine learning",
    "deep learning",
    "nlp",
    "nlu",
    "generative ai",
    "llm",
    "large language models",
    "transformers",
    "pytorch",
    "tensorflow",
    "jax",
    "scikit-learn",
    "keras",
    "hugging face",
    "fine-tuning",
    "rlhf",
    "prompt engineering",
    "embeddings",
    "rag",
    "computer vision",
    "speech recognition",
    "asr",
    "tts",
    "multimodal",
    "reinforcement learning",
    "model evaluation",
    "benchmarking",
    "agentic",
    "ai safety",
    "responsible ai",
    // Human data / annotation / evaluation
    "annotation",
    "data annotation",
    "labeling",
    "labelling",
    "human evaluation",
    "human-in-the-loop",
    "inter-rater reliability",
    "inter-annotator agreement",
    "quality assurance",
    "quality framework",
    "statistical process control",
    "gold set",
    "calibration",
    "adjudication",
    "taxonomy",
    "guidelines",
    "crowdsourcing",
    "vendor management",
    "data collection",
    "data curation",
    "linguistics",
    "cognitive science",
    "psycholinguistics",
    "human factors",
    "user research",
    "usability",
    "experimental design",
    "a/b testing",
    "survey design",
    "qualitative research",
    "quantitative research",
    // Data / infra
    "etl",
    "data pipeline",
    "airflow",
    "spark",
    "hadoop",
    "kafka",
    "dbt",
    "snowflake",
    "bigquery",
    "redshift",
    "postgresql",
    "mysql",
    "sqlite",
    "mongodb",
    "redis",
    "elasticsearch",
    "pandas",
    "numpy",
    "statistics",
    "data analysis",
    "data visualization",
    "tableau",
    "looker",
    "dashboards",
    // Cloud / platform
    "aws",
    "gcp",
    "azure",
    "kubernetes",
    "docker",
    "terraform",
    "ci/cd",
    "microservices",
    "rest",
    "graphql",
    "grpc",
    "distributed systems",
    // Compliance
    "privacy",
    "gdpr",
    "compliance",
    "governance",
    "data governance",
    "hipaa",
    "glp",
    "gcp for clinical trials",
    "irb",
    // Process
    "cross-functional",
    "stakeholder management",
    "program management",
    "project management",
    "roadmap",
    "agile",
    "scrum",
];

/// Words that signal culture/tone rather than capability.
const TONE_VOCABULARY: &[&str] = &[
    "ownership",
    "impact",
    "collaboration",
    "collaborative",
    "scale",
    "velocity",
    "autonomy",
    "ambiguity",
    "fast-paced",
    "cross-functional",
    "customer-obsessed",
    "detail-oriented",
    "self-starter",
    "mentorship",
    "innovative",
    "curious",
    "rigorous",
    "pragmatic",
];

/// Domain hints.
const DOMAIN_VOCABULARY: &[&str] = &[
    "machine learning",
    "artificial intelligence",
    "data science",
    "infrastructure",
    "security",
    "healthcare",
    "biotech",
    "fintech",
    "e-commerce",
    "media",
    "education",
    "robotics",
    "search",
    "recommendations",
    "advertising",
    "developer tools",
    "linguistics",
    "cognitive science",
    "human factors",
];

// Heading lists are written in the normalised form `normalize_heading`
// produces: lowercase, straight apostrophes, and a hyphen joining two words
// read as a space ("Must-Have Skills" → "must have skills").

/// Headings that open a "must have" section.
///
/// The second group came from a sweep of postings that extracted no
/// must-haves at all (Quadric `REQUIRED`, Elastic `What You Bring`, Lambda
/// `You` / `Must-Have Skills`, Isomorphic `Essential:`, Applied Intuition
/// `WE'RE LOOKING FOR SOMEONE WHO HAS:`).
const MUST_HAVE_HEADINGS: &[&str] = &[
    "minimum qualifications",
    "minimum requirements",
    "basic qualifications",
    "required qualifications",
    "requirements",
    "what you'll need",
    "what you need",
    "qualifications",
    "required",
    "required skills",
    "required experience",
    "what we're looking for",
    "what we are looking for",
    "who we're looking for",
    "what we look for",
    "we're looking for someone who has",
    "we are looking for someone who has",
    "we expect you to",
    "you might thrive in this role if you",
    "you might thrive in this role if you have",
    "you'll thrive in this role if you",
    "you might be a good fit if you",
    "what you bring",
    "what you bring along",
    "what you'll bring",
    "what you will bring",
    "what you have",
    "you have",
    "you",
    "who you are",
    "about you",
    "must have",
    "must haves",
    "must have skills",
    "must have qualifications",
    "essential",
    "essential skills",
    "essential qualifications",
    "essential requirements",
    "skills and qualifications",
    "skills & qualifications",
    "skills and experience",
];

/// Headings that open a "nice to have" section.
const NICE_TO_HAVE_HEADINGS: &[&str] = &[
    "preferred qualifications",
    "preferred requirements",
    "preferred skills",
    "preferred experience",
    "nice to have",
    "nice to haves",
    "bonus points",
    "bonus",
    "desired qualifications",
    "preferred",
];

/// Headings that open a responsibilities section.
const RESPONSIBILITY_HEADINGS: &[&str] = &[
    "responsibilities",
    "what you'll do",
    "what you will do",
    "what you'll be doing",
    "what you will be doing",
    "the role",
    "about the role",
    "the opportunity",
    "your role",
    "your impact",
    "the impact you will have",
    "the impact you'll have",
    "in this role you will",
    "in this role, you will",
    "key responsibilities",
    "duties",
];

/// Headings that open a benefits, legal or privacy footer. Nothing under them
/// is a requirement, so they close the open section and feed no skill list.
const FOOTER_HEADINGS: &[&str] = &[
    "what we offer",
    "what we offer you",
    "benefits",
    "our benefits",
    "benefits and perks",
    "perks and benefits",
    "perks",
    "compensation",
    "compensation and benefits",
    "salary range",
    "salary range information",
    "pay range",
    "pay transparency",
    "equal employment opportunity",
    "equal opportunity",
    "equal opportunity employer",
    "eeo statement",
    "e verify",
    "e verify and right to work notices",
    "privacy",
    "privacy notice",
    "privacy policy",
    "privacy statement",
    "applicant privacy notice",
    "culture and values",
    "our values",
    "hybrid working",
    "why join us",
    "additional information",
    "how to apply",
    "accommodations",
    "reasonable accommodations",
];

/// Which bucket a line of the JD currently belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    Preamble,
    Responsibilities,
    MustHave,
    NiceToHave,
    /// A recognised heading that is none of the above ("About Lambda"). It
    /// closes the section before it; its skills are only ATS keywords.
    Other,
    /// Benefits, legal and privacy text. Feeds nothing.
    Footer,
}

/// Lowercase a candidate heading line and strip its list/markdown ornament,
/// so "## Minimum Qualifications", "**What You Bring**", "What You’ll Do" and
/// "MUST-HAVE:" compare against the heading lists.
fn normalize_heading(line: &str) -> String {
    let l = line
        .trim()
        .trim_start_matches(['#', '*', '-', '•', '=', '_', ' '])
        .trim_end_matches(['*', '#', '_', ':', '.', ' '])
        .to_lowercase();
    let chars: Vec<char> = l
        .chars()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' => '\'',
            c => c,
        })
        .collect();
    let mut out = String::with_capacity(l.len());
    for (i, &c) in chars.iter().enumerate() {
        // Only a hyphen joining two words is folded; " - " stays a separator
        // so "Additional Information - We Take Care of Our People" keeps it.
        let joins_words = c == '-'
            && i > 0
            && chars.get(i + 1).is_some_and(|n| n.is_alphanumeric())
            && chars[i - 1].is_alphanumeric();
        out.push(if joins_words { ' ' } else { c });
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Classify a line as a section heading, if it is one.
///
/// Checked most-specific first: "preferred qualifications" must win over the
/// bare "qualifications" heading, otherwise every preferred skill would be
/// promoted to must-have.
fn heading_for(line: &str) -> Option<Section> {
    let l = normalize_heading(line);
    if l.is_empty() || l.chars().count() > 60 {
        return None;
    }

    // A heading is the WHOLE line, not a prefix of it. Matching on `starts_with`
    // swallowed ordinary content: "Requirements gathering with stakeholders"
    // opened a must-have section, and everything after it was misfiled.
    // A short trailing remainder is tolerated so "Minimum Qualifications (US)"
    // still reads as a heading, and a dash- or pipe-separated tail of any
    // length so "Additional Information - We Take Care of Our People" does.
    let matches = |headings: &[&str]| -> bool {
        headings.iter().any(|h| {
            if l == *h {
                return true;
            }
            let Some(rest) = l.strip_prefix(h) else {
                return false;
            };
            let rest = rest.trim();
            // Only punctuation-led fragments count as heading decoration. An
            // apostrophe does not: "You're fluent in Kubernetes" is content.
            rest.is_empty()
                || rest.starts_with(['-', '\u{2013}', '\u{2014}', '|'])
                || (rest.chars().count() <= 12
                    && rest.starts_with(|c: char| !c.is_alphanumeric() && c != '\''))
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
    if matches(FOOTER_HEADINGS) {
        return Some(Section::Footer);
    }
    // "About Lambda", "About Iso": a company blurb. Short enough to be a
    // heading, never a requirement list ("About you" matched above).
    if l.strip_prefix("about ")
        .is_some_and(|name| !name.is_empty() && name.split(' ').count() <= 3)
    {
        return Some(Section::Other);
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
    let mut seen_content_section = false;
    for line in jd_text.lines() {
        if let Some(mut next) = heading_for(line) {
            // A footer heading ahead of every content section is a header line
            // ("Compensation: $150k") on a posting that may have no other
            // headings; treating it as a footer would discard the posting.
            if next == Section::Footer && !seen_content_section {
                next = Section::Other;
            }
            if matches!(
                next,
                Section::Responsibilities | Section::MustHave | Section::NiceToHave
            ) {
                seen_content_section = true;
            }
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
            Section::Preamble | Section::Other | Section::Footer => {}
        }
        if section == Section::Footer {
            continue;
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
    if matches!(
        v.as_str(),
        "ic" | "senior" | "lead" | "manager" | "director"
    ) {
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
        for expected in [
            "python",
            "r",
            "sql",
            "annotation",
            "linguistics",
            "cognitive science",
        ] {
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
            e.profile
                .nice_to_have_skills
                .iter()
                .any(|s| s == "vendor management" || s == "ai safety" || s == "responsible ai"),
            "nice-to-have was {:?}",
            e.profile.nice_to_have_skills
        );
        // "preferred qualifications" must not be swallowed by "qualifications".
        assert!(!e
            .profile
            .must_have_skills
            .iter()
            .any(|s| s == "responsible ai"));
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
        assert_eq!(
            extract_profile("Senior Software Engineer")
                .profile
                .seniority,
            "senior"
        );
        assert_eq!(extract_profile("Staff Engineer").profile.seniority, "lead");
        assert_eq!(
            extract_profile("Principal Engineer").profile.seniority,
            "lead"
        );
        assert_eq!(
            extract_profile("Engineering Manager").profile.seniority,
            "manager"
        );
        assert_eq!(
            extract_profile("Director of Data").profile.seniority,
            "director"
        );
        // Untitled role with an experience floor.
        assert_eq!(
            extract_profile("Data Scientist\n* 6+ years of experience required")
                .profile
                .seniority,
            "senior"
        );
        assert_eq!(extract_profile("Software Engineer").profile.seniority, "ic");
    }

    #[test]
    fn role_title_skips_metadata_lines() {
        let e = extract_profile(APPLE_JD);
        assert_eq!(
            e.profile.role_title,
            "AI/ML Evaluation Specialist, Human Data"
        );
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
        assert!(ok
            .profile
            .must_have_skills
            .iter()
            .any(|s| s == "kubernetes"));
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
        for stale in [
            "requiredSkills",
            "preferredSkills",
            "cultureKeywords",
            "company",
        ] {
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
        assert!(e
            .profile
            .nice_to_have_skills
            .iter()
            .any(|s| s == "kubernetes"));
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
            let jd = format!(
                "Engineer\n\n{heading}\n* Strong Python and SQL\n{}",
                "Filler line, more.\n".repeat(20)
            );
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
        assert_eq!(
            extract_profile("Senior Data Analyst").profile.seniority,
            "senior"
        );
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

    // --- Regressions from the Vani coverage sweep (2026-11-14). ---
    //
    // A recognised nice-to-have heading paired with an unrecognised requirement
    // heading left `must_have_skills` empty: the requirement lines fell into
    // the preamble, and the headingless promotion never fired because the
    // nice-to-have section was non-empty. Nothing closed that section either,
    // so benefits, EEO and privacy footers were read as nice-to-have skills.

    /// Minimal excerpt of the Quadric "AI Inference Optimization Engineer"
    /// posting (Ashby): ALL-CAPS headings, a bare `REQUIRED` under
    /// `WHAT WE'RE LOOKING FOR`, and a `PRIVACY` footer.
    const QUADRIC_JD: &str = "AI Inference Optimization Engineer
THE OPPORTUNITY
You'll own getting the latest AI models running fast on the GPNPU, from CNN perception models to LLMs.
WHAT YOU'LL DO
- Write and tune kernels and optimize model compute graphs
- Develop profiling tools and agentic automation
WHAT WE'RE LOOKING FOR
REQUIRED
- 3+ years experience in AI model deployment or kernel optimization
- BS/MS in CS/CE or related fields
- Strong C/C++ and Python
PREFERRED
- Hands-on experience in pruning and sparsification
- Understanding of compiler code generation and kernel scheduling
WHAT WE OFFER
The base salary range for this position is $160,000 to $195,000.
- Medical, dental, and vision insurance from day one
EQUAL EMPLOYMENT OPPORTUNITY
Quadric is an equal opportunity employer.
PRIVACY
By submitting an application, you acknowledge that Quadric will collect and process your personal information. Please review our Privacy Policy.
";

    /// Minimal excerpt of the Elastic "Full Stack Technical Developer" posting
    /// (Greenhouse): Title-Case headings, un-bulleted wrapped requirement lines,
    /// and a footer heading carrying a long dash-separated tail.
    const ELASTIC_JD: &str = "Full Stack Technical Developer
What You Will Be Doing
Build and maintain backend services, RESTful APIs, and database structures.
• Contribute to features in the frontend codebase (React/TypeScript).
What You Bring
2+ years of experience as a full stack or backend-leaning developer, with solid experience in server-side
development (e.g., Node.js, Python, or Go).
Working proficiency in frontend development using React and TypeScript
Experience working with CI/CD pipelines and GitOps-style development workflows.
Bonus Points
Familiarity with Google Cloud services (e.g., Cloud Functions, BigQuery)
Experience with NoSQL databases, specifically Elasticsearch
Additional Information - We Take Care of Our People
Health coverage for you and your family in many locations
Elastic is an equal opportunity employer and is committed to creating an inclusive culture.
Please see here for our Privacy Statement.
";

    fn has(list: &[String], skill: &str) -> bool {
        list.iter().any(|s| s == skill)
    }

    #[test]
    fn quadric_bare_required_heading_feeds_must_have() {
        let p = extract_profile(QUADRIC_JD).profile;
        for expected in ["c++", "python"] {
            assert!(
                has(&p.must_have_skills, expected),
                "must-have {expected:?} missing from {:?}",
                p.must_have_skills
            );
        }
        assert!(
            p.qualifications_text.starts_with("- 3+ years"),
            "qualificationsText must open at the REQUIRED bullets: {:?}",
            p.qualifications_text
        );
    }

    #[test]
    fn quadric_footers_do_not_feed_skills_or_qualifications() {
        let p = extract_profile(QUADRIC_JD).profile;
        for list in [&p.must_have_skills, &p.nice_to_have_skills, &p.ats_keywords] {
            assert!(!has(list, "privacy"), "PRIVACY footer leaked into {list:?}");
        }
        for footer in ["salary", "insurance", "equal opportunity", "Privacy Policy"] {
            assert!(
                !p.qualifications_text.contains(footer),
                "footer text {footer:?} leaked into qualificationsText: {:?}",
                p.qualifications_text
            );
        }
        // The PREFERRED bullets are still qualifications.
        assert!(p.qualifications_text.contains("pruning and sparsification"));
    }

    #[test]
    fn elastic_what_you_bring_feeds_must_have() {
        let p = extract_profile(ELASTIC_JD).profile;
        for expected in ["python", "go", "typescript", "ci/cd"] {
            assert!(
                has(&p.must_have_skills, expected),
                "must-have {expected:?} missing from {:?}",
                p.must_have_skills
            );
        }
        for expected in ["bigquery", "elasticsearch"] {
            assert!(
                has(&p.nice_to_have_skills, expected),
                "nice-to-have {expected:?} missing from {:?}",
                p.nice_to_have_skills
            );
        }
        assert!(
            p.responsibilities_text
                .starts_with("Build and maintain backend services"),
            "responsibilitiesText: {:?}",
            p.responsibilities_text
        );
    }

    #[test]
    fn elastic_additional_information_footer_is_closed() {
        let p = extract_profile(ELASTIC_JD).profile;
        for list in [&p.must_have_skills, &p.nice_to_have_skills, &p.ats_keywords] {
            assert!(!has(list, "privacy"), "privacy footer leaked into {list:?}");
        }
        assert!(
            !p.qualifications_text.contains("Health coverage"),
            "benefits leaked into qualificationsText: {:?}",
            p.qualifications_text
        );
    }

    /// Every requirement heading the sweep found unrecognised, in the casings
    /// postings actually use. A nice-to-have section follows so the headingless
    /// promotion cannot paper over a missed heading.
    #[test]
    fn requirement_heading_variants_open_must_have() {
        for heading in [
            "REQUIRED",
            "Required:",
            "Required Qualifications",
            "WHAT WE'RE LOOKING FOR",
            "What We\u{2019}re Looking For",
            "What we are looking for:",
            "WE'RE LOOKING FOR SOMEONE WHO HAS:",
            "What You Bring",
            "What you'll bring",
            "You Have:",
            "You",
            "Who You Are",
            "Must Have",
            "MUST-HAVE:",
            "Must-Have Skills",
            "Essential:",
            "Skills and Qualifications",
            "What We Look For",
            "WHO WE\u{2019}RE LOOKING FOR:",
            "You might thrive in this role if you have:",
            "You\u{2019}ll thrive in this role if you:",
            "You Might Be a Good Fit If You",
            "We expect you to:",
            "What You Bring Along",
            "**What You Bring**",
            "## Required",
        ] {
            let jd = format!(
                "Engineer\n\n{heading}\n* Strong Python and SQL\n\nNice to have\n* Kubernetes\n{}",
                "Filler line, more.\n".repeat(20)
            );
            let p = extract_profile(&jd).profile;
            assert!(
                has(&p.must_have_skills, "python") && !has(&p.must_have_skills, "kubernetes"),
                "heading {heading:?} not recognised: must={:?} nice={:?}",
                p.must_have_skills,
                p.nice_to_have_skills
            );
        }
    }

    #[test]
    fn responsibility_heading_variants_are_recognised() {
        for heading in [
            "What You\u{2019}ll Do",
            "What You Will Be Doing",
            "The Impact You Will Have",
            "The impact you\u{2019}ll have:",
            "IN THIS ROLE, YOU WILL:",
            "THE OPPORTUNITY",
        ] {
            let jd = format!(
                "Engineer\n\n{heading}\n* Ship Rust services\n\nMinimum Qualifications\n* Python\n{}",
                "Filler line, more.\n".repeat(20)
            );
            let p = extract_profile(&jd).profile;
            assert_eq!(
                p.responsibilities_text, "* Ship Rust services",
                "heading {heading:?} not recognised"
            );
        }
    }

    /// Each footer closes the open section and feeds nothing.
    #[test]
    fn footer_headings_close_the_section_and_feed_nothing() {
        for footer in [
            "WHAT WE OFFER",
            "Benefits",
            "Perks and Benefits:",
            "Salary Range Information",
            "Equal Opportunity Employer",
            "EQUAL EMPLOYMENT OPPORTUNITY",
            "E-VERIFY AND RIGHT TO WORK NOTICES",
            "PRIVACY",
            "Culture and values",
            "Additional Information - We Take Care of Our People",
        ] {
            let jd = format!(
                "Engineer\n\nMinimum Qualifications\n* Python\n\nNice to have\n* Kubernetes\n{footer}\n* Docker swag and a privacy-first culture\n{}",
                "Filler line, more.\n".repeat(20)
            );
            let p = extract_profile(&jd).profile;
            for skill in ["docker", "privacy"] {
                for list in [&p.must_have_skills, &p.nice_to_have_skills, &p.ats_keywords] {
                    assert!(
                        !has(list, skill),
                        "footer {footer:?} fed {skill:?} into {list:?}"
                    );
                }
            }
            assert!(has(&p.nice_to_have_skills, "kubernetes"));
            assert!(!p.qualifications_text.contains("Docker"));
        }
    }

    /// A company blurb ("About Lambda") ends the section before it, but its
    /// skills are still worth echoing as ATS keywords.
    #[test]
    fn about_company_heading_closes_the_section_into_ats_only() {
        let jd = format!(
            "Engineer\n\nNice to have\n* Kubernetes\nAbout Acme\nAcme runs a Docker platform.\n{}",
            "Filler line, more.\n".repeat(20)
        );
        let p = extract_profile(&jd).profile;
        assert!(
            !has(&p.nice_to_have_skills, "docker"),
            "{:?}",
            p.nice_to_have_skills
        );
        assert!(has(&p.ats_keywords, "docker"), "{:?}", p.ats_keywords);
    }

    // Guards: behaviour the new headings must not break.

    /// A footer-looking line at the top of a headingless posting must not
    /// swallow everything after it.
    #[test]
    fn a_leading_footer_heading_does_not_swallow_a_headingless_jd() {
        let jd = format!(
            "Compensation: $150k\nWe want someone strong in Python and Kubernetes. {}",
            "Additional context. ".repeat(20)
        );
        let p = extract_profile(&jd).profile;
        assert!(
            has(&p.must_have_skills, "python"),
            "{:?}",
            p.must_have_skills
        );
    }

    /// Content lines that start with a heading word stay content.
    #[test]
    fn content_lines_starting_with_new_heading_words_stay_content() {
        let jd = format!(
            "Engineer\n\nMinimum Qualifications\n* Benefits administration tooling in Python\n* You're fluent in Kubernetes\n* Required to know SQL well\n\nPreferred\n* Docker\n{}",
            "Filler line, more.\n".repeat(20)
        );
        let p = extract_profile(&jd).profile;
        for expected in ["python", "kubernetes", "sql"] {
            assert!(
                has(&p.must_have_skills, expected),
                "{expected:?} lost: must={:?}",
                p.must_have_skills
            );
        }
        assert!(has(&p.nice_to_have_skills, "docker"));
    }

    #[test]
    fn year_ranges_report_the_upper_bound() {
        assert_eq!(max_years_required("3-5 years of experience"), Some(5));
        assert_eq!(max_years_required("10+ years required"), Some(10));
        assert_eq!(max_years_required("no figure here"), None);
        assert_eq!(max_years_required("100 years"), None);
    }
}
