//! JD profile: the canonical shape plus a deterministic extractor.
//!
//! The struct and `normalize` mirror `resume-synthesis/jd-analysis.ts`
//! (`JDProfile`, `normalizeJDProfile`, `normalizeSeniority`) so an LLM-produced
//! profile and a locally-derived one are interchangeable downstream.
//!
//! `extract_heuristic` has no TypeScript counterpart: the TS pipeline always
//! has an LLM available, while the MCP server must still answer when no
//! language provider is configured. It is section-aware rather than
//! positional, and it is always reported as `source: "heuristic"` so callers
//! can tell a parsed JD from an inferred one.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::scoring::text_covers_skill;

/// Canonical JD profile. Field names match the TypeScript `JDProfile` exactly;
/// the wire form is camelCase so MCP clients see one shape across languages.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
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

/// Non-trivial JDs longer than this must yield skills/keywords.
/// Mirrors `JD_NONTRIVIAL_MIN_CHARS`.
pub const JD_NONTRIVIAL_MIN_CHARS: usize = 200;

impl JdProfile {
    /// Mirrors `isExtractionEmpty`.
    pub fn is_extraction_empty(&self) -> bool {
        self.must_have_skills.is_empty() && self.ats_keywords.is_empty()
    }
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
    // `sr\b` in TS — require a non-alphanumeric after "sr".
    if v.contains("senior") || word_present(&v, "sr") {
        return "senior".into();
    }
    if v.contains("junior")
        || v.contains("entry")
        || v.contains("associate")
        || word_present(&v, "ic")
    {
        return "ic".into();
    }
    "senior".into()
}

/// Whole-word presence of an ASCII needle in already-lowercased text.
fn word_present(hay: &str, needle: &str) -> bool {
    let h: Vec<char> = hay.chars().collect();
    let n: Vec<char> = needle.chars().collect();
    if n.is_empty() || n.len() > h.len() {
        return false;
    }
    let alnum = |c: char| c.is_ascii_alphanumeric();
    for i in 0..=(h.len() - n.len()) {
        if h[i..i + n.len()] != n[..] {
            continue;
        }
        let lead = i == 0 || !alnum(h[i - 1]);
        let end = i + n.len();
        let trail = end == h.len() || !alnum(h[end]);
        if lead && trail {
            return true;
        }
    }
    false
}

/// Port of `normalizeJDProfile`: accept whatever an LLM returned and coerce it
/// into the canonical shape, falling back to JD slices for the facet text.
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

/// Char-safe prefix. Never splits a multi-byte character.
pub fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

// --- Deterministic extraction -------------------------------------------

/// Skill lexicon for the no-LLM path. Matched with `text_covers_skill`, so
/// `go` will not fire inside `Django` and `java` will not fire inside
/// `JavaScript`.
const SKILL_LEXICON: &[&str] = &[
    // Languages
    "python", "rust", "typescript", "javascript", "go", "golang", "java", "kotlin",
    "swift", "c++", "c#", "ruby", "php", "scala", "elixir", "haskell", "r", "julia",
    "matlab", "perl", "bash", "sql", "objective-c", "dart", "lua", "zig",
    // Frontend
    "react", "vue", "angular", "svelte", "next.js", "tailwind", "webpack", "vite",
    "html", "css", "sass", "redux", "graphql", "webassembly",
    // Backend / infra
    "node.js", "django", "flask", "fastapi", "rails", "spring", "express", "grpc",
    "rest", "microservices", "kubernetes", "docker", "terraform", "ansible", "helm",
    "nginx", "kafka", "rabbitmq", "redis", "elasticsearch", "consul", "istio",
    // Cloud
    "aws", "gcp", "azure", "lambda", "s3", "ec2", "cloudformation", "cloudflare",
    // Data
    "postgresql", "mysql", "mongodb", "sqlite", "cassandra", "dynamodb", "snowflake",
    "spark", "hadoop", "airflow", "dbt", "databricks", "clickhouse", "duckdb",
    // ML / AI
    "machine learning", "deep learning", "pytorch", "tensorflow", "jax", "keras",
    "scikit-learn", "pandas", "numpy", "transformers", "llm", "nlp", "computer vision",
    "reinforcement learning", "mlops", "cuda", "triton", "onnx", "rag", "embeddings",
    "diffusion", "quantization", "fine-tuning", "distributed training",
    // Practice
    "ci/cd", "git", "linux", "distributed systems", "system design", "observability",
    "prometheus", "grafana", "datadog", "testing", "tdd", "agile", "scrum",
    "security", "cryptography", "performance", "scalability", "api design",
];

const DOMAIN_LEXICON: &[&str] = &[
    "fintech", "healthcare", "genomics", "bioinformatics", "biotech", "e-commerce",
    "gaming", "robotics", "autonomous", "cybersecurity", "logistics", "edtech",
    "adtech", "climate", "energy", "aerospace", "defense", "insurance", "banking",
    "payments", "supply chain", "telecom", "media", "advertising", "retail",
    "manufacturing", "pharmaceutical", "clinical", "legal", "real estate",
];

const TONE_LEXICON: &[&str] = &[
    "collaborative", "data-driven", "metrics-driven", "fast-paced", "autonomous",
    "ownership", "customer-obsessed", "pragmatic", "rigorous", "innovative",
    "cross-functional", "mission-driven", "entrepreneurial", "impact",
];

/// Headings that open a *preferred* (nice-to-have) requirements block.
const PREFERRED_HEADINGS: &[&str] = &[
    "nice to have", "nice-to-have", "preferred qualifications", "preferred skills",
    "preferred", "bonus points", "bonus", "plus", "desirable", "good to have",
    "it's a plus", "extra credit", "pluses",
];

/// Headings that open a *required* requirements block.
const REQUIRED_HEADINGS: &[&str] = &[
    "requirements", "required qualifications", "minimum qualifications",
    "basic qualifications", "qualifications", "what you'll need", "what you need",
    "must have", "must-have", "who you are", "you have", "we're looking for",
];

/// Headings that open a responsibilities block.
const RESPONSIBILITY_HEADINGS: &[&str] = &[
    "responsibilities", "what you'll do", "what you will do", "the role",
    "about the role", "your impact", "day to day", "day-to-day", "duties",
    "in this role",
];

#[derive(Clone, Copy, PartialEq, Debug)]
enum Section {
    Unknown,
    Responsibilities,
    Required,
    Preferred,
}

/// Does this line look like a section heading for `needles`?
///
/// Headings are short lines; a 400-character paragraph that happens to contain
/// "preferred" is prose, not a heading.
fn heading_matches(line_lower: &str, needles: &[&str]) -> bool {
    if line_lower.len() > 80 {
        return false;
    }
    needles.iter().any(|n| line_lower.contains(n))
}

/// Split a JD into labelled sections by walking its lines.
fn sectionize(jd_text: &str) -> Vec<(Section, String)> {
    let mut out: Vec<(Section, String)> = Vec::new();
    let mut current = Section::Unknown;
    for raw in jd_text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let lower = line.to_lowercase();
        // Preferred is checked first: "Preferred Qualifications" contains
        // "qualifications", which would otherwise classify it as required.
        let next = if heading_matches(&lower, PREFERRED_HEADINGS) {
            Some(Section::Preferred)
        } else if heading_matches(&lower, REQUIRED_HEADINGS) {
            Some(Section::Required)
        } else if heading_matches(&lower, RESPONSIBILITY_HEADINGS) {
            Some(Section::Responsibilities)
        } else {
            None
        };
        if let Some(sec) = next {
            current = sec;
            // A heading line carries no requirement text of its own.
            continue;
        }
        out.push((current, line.to_string()));
    }
    out
}

fn collect_lexicon(text: &str, lexicon: &[&str]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for term in lexicon {
        if text_covers_skill(text, term) && !found.iter().any(|f| f == term) {
            found.push((*term).to_string());
        }
    }
    found
}

/// Guess the role title: the first short, non-heading line that reads like a
/// title, else the first line.
fn guess_role_title(jd_text: &str) -> String {
    for raw in jd_text.lines() {
        let line = raw.trim().trim_start_matches(['#', '*', '-', '•']).trim();
        if line.is_empty() {
            continue;
        }
        // Explicit "Title: X" / "Role: X" wins.
        for prefix in ["title:", "role:", "position:", "job title:"] {
            if line.to_lowercase().starts_with(prefix) {
                let v = line[prefix.len()..].trim();
                if !v.is_empty() {
                    return truncate_chars(v, 120);
                }
            }
        }
        if line.len() <= 90 && !line.ends_with('.') {
            return truncate_chars(line, 120);
        }
        break;
    }
    "Role".to_string()
}

/// Extract the first `max_lines` lines assigned to `want` as a plain-text blob.
fn section_text(sections: &[(Section, String)], want: Section, max_chars: usize) -> String {
    let mut out = String::new();
    for (sec, line) in sections {
        if *sec != want {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(line);
        if out.chars().count() >= max_chars {
            break;
        }
    }
    truncate_chars(&out, max_chars)
}

/// Deterministic, section-aware JD extraction for the no-LLM path.
///
/// Unlike an LLM pass this cannot infer unlisted skills or paraphrase; it
/// reports exactly the lexicon terms it found and where it found them.
pub fn extract_heuristic(jd_text: &str) -> JdProfile {
    let text = jd_text.trim();
    if text.is_empty() {
        return JdProfile {
            role_title: "Role".into(),
            seniority: "senior".into(),
            ..Default::default()
        };
    }

    let sections = sectionize(text);

    let required_text: String = sections
        .iter()
        .filter(|(s, _)| *s == Section::Required)
        .map(|(_, l)| l.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let preferred_text: String = sections
        .iter()
        .filter(|(s, _)| *s == Section::Preferred)
        .map(|(_, l)| l.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    let mut must_have = collect_lexicon(&required_text, SKILL_LEXICON);
    let preferred = collect_lexicon(&preferred_text, SKILL_LEXICON);

    // A skill named in both blocks is a hard requirement.
    let nice_to_have: Vec<String> =
        preferred.into_iter().filter(|p| !must_have.contains(p)).collect();

    // When the JD has no recognizable requirements section, fall back to the
    // whole document rather than reporting nothing.
    if must_have.is_empty() && nice_to_have.is_empty() {
        must_have = collect_lexicon(text, SKILL_LEXICON);
    }

    let domains = collect_lexicon(text, DOMAIN_LEXICON);
    let tone_signals = collect_lexicon(text, TONE_LEXICON);

    // ATS keywords: every matched skill plus every matched domain, deduped and
    // in JD order of first appearance.
    let mut ats_keywords: Vec<String> = Vec::new();
    for term in must_have.iter().chain(nice_to_have.iter()).chain(domains.iter()) {
        if !ats_keywords.contains(term) {
            ats_keywords.push(term.clone());
        }
    }

    let role_title = guess_role_title(text);
    let seniority = normalize_seniority(&role_title);
    // The title is the strongest seniority signal; fall back to the body only
    // when the title says nothing (normalize_seniority defaults to "senior").
    let seniority = if seniority == "senior" && !title_states_seniority(&role_title) {
        normalize_seniority(&truncate_chars(text, 600))
    } else {
        seniority
    };

    let responsibilities_text = {
        let s = section_text(&sections, Section::Responsibilities, 1200);
        if s.is_empty() { truncate_chars(text, 1200) } else { s }
    };
    let qualifications_text = {
        let s = if required_text.is_empty() { preferred_text.clone() } else { required_text };
        if s.is_empty() { truncate_chars(text, 1200) } else { truncate_chars(&s, 1200) }
    };

    JdProfile {
        role_title,
        seniority,
        must_have_skills: must_have,
        nice_to_have_skills: nice_to_have,
        domains,
        ats_keywords,
        tone_signals,
        responsibilities_text,
        qualifications_text,
    }
}

/// True when the title itself carries a seniority marker, so we know
/// `normalize_seniority`'s "senior" default was a real read and not a fallback.
fn title_states_seniority(title: &str) -> bool {
    let t = title.to_lowercase();
    ["director", "vp", "head of", "manager", "mgmt", "lead", "staff", "principal",
     "senior", "junior", "entry", "associate"]
        .iter()
        .any(|m| t.contains(m))
        || word_present(&t, "sr")
        || word_present(&t, "ic")
}
