//! Faithful port of `src/lib/resume-synthesis/scoring.ts`.
//!
//! score = 0.40*embedding + 0.30*skills + 0.15*persona
//!       + 0.10*recency + 0.05*seniority
//!
//! When embeddings are unavailable the embedding weight goes to 0 and the
//! remaining weights are renormalized — same as `weightsForFacets`.
//!
//! The TypeScript is the canonical owner (see `resume-synthesis/CLAUDE.md`).
//! Every deviation here must be deliberate and pinned by a test.

use crate::career_db::{ExperienceBlock, Persona, SkillTag};

use super::jd::JdProfile;

/// Weight of each score component. Mirrors `DEFAULT_WEIGHTS`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoreWeights {
    pub embedding: f64,
    pub skills: f64,
    pub persona: f64,
    pub recency: f64,
    pub seniority: f64,
}

pub const DEFAULT_WEIGHTS: ScoreWeights = ScoreWeights {
    embedding: 0.40,
    skills: 0.30,
    persona: 0.15,
    recency: 0.10,
    seniority: 0.05,
};

impl ScoreWeights {
    /// Renormalize so the weights sum to 1. Zeroes stay zero.
    pub fn renormalized(self) -> Self {
        let sum =
            self.embedding + self.skills + self.persona + self.recency + self.seniority;
        if sum <= 0.0 {
            return Self {
                embedding: 0.0,
                skills: 1.0,
                persona: 0.0,
                recency: 0.0,
                seniority: 0.0,
            };
        }
        Self {
            embedding: self.embedding / sum,
            skills: self.skills / sum,
            persona: self.persona / sum,
            recency: self.recency / sum,
            seniority: self.seniority / sum,
        }
    }
}

/// `weightsForFacets`: drop the embedding term when semantic matching is off.
pub fn weights_for_facets(semantic_matching_disabled: bool) -> ScoreWeights {
    if semantic_matching_disabled {
        ScoreWeights {
            embedding: 0.0,
            ..DEFAULT_WEIGHTS
        }
        .renormalized()
    } else {
        DEFAULT_WEIGHTS
    }
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreComponents {
    pub embedding: f64,
    pub skills: f64,
    pub persona: f64,
    pub recency: f64,
    pub seniority: f64,
}

#[derive(Debug, Clone)]
pub struct ScoredBlock {
    pub block: ExperienceBlock,
    pub score: f64,
    pub components: ScoreComponents,
}

pub fn clamp01(n: f64) -> f64 {
    if !n.is_finite() {
        return 0.0;
    }
    n.clamp(0.0, 1.0)
}

// --- Skill normalization -------------------------------------------------

/// True for the character class the TS `normSkill` keeps: `[a-z0-9+#.]`.
fn is_skill_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+' || c == '#' || c == '.'
}

/// `normSkill`: trim, lowercase, strip everything outside `[a-z0-9+#.]`.
pub fn norm_skill(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .chars()
        .filter(|c| is_skill_char(*c))
        .collect()
}

/// `skillTokens`: lowercase then split on runs of non-`[a-z0-9+#.]`.
pub fn skill_tokens(s: &str) -> Vec<String> {
    s.trim()
        .to_lowercase()
        .split(|c: char| !is_skill_char(c))
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// Canonical form → aliases. Matching is bidirectional. Deliberately omits
/// dangerous short overlaps (go↛cargo, java↛javascript).
const SKILL_ALIASES: &[(&str, &[&str])] = &[
    ("javascript", &["js"]),
    ("typescript", &["ts"]),
    ("python", &["py"]),
    ("golang", &["go"]),
    ("kubernetes", &["k8s"]),
    ("postgresql", &["postgres"]),
    ("c++", &["cpp", "cplusplus"]),
    ("c#", &["csharp"]),
    ("node.js", &["nodejs", "node"]),
    ("react", &["reactjs"]),
    ("machine learning", &["ml"]),
    ("deep learning", &["dl"]),
];

/// `canonicalSkillKey`: resolve to the alias-canonical form when known.
pub fn canonical_skill_key(s: &str) -> String {
    let n = norm_skill(s);
    if n.is_empty() {
        return String::new();
    }
    for (canon, aliases) in SKILL_ALIASES {
        let c = norm_skill(canon);
        if n == c {
            return c;
        }
        for a in *aliases {
            if n == norm_skill(a) {
                return c;
            }
        }
    }
    n
}

/// `skillsMatch`: token / word-boundary match, never a bare substring.
/// Does NOT match Java⊂JavaScript or Go⊂Cargo.
pub fn skills_match(a: &str, b: &str) -> bool {
    let ca = canonical_skill_key(a);
    let cb = canonical_skill_key(b);
    if ca.is_empty() || cb.is_empty() {
        return false;
    }
    if ca == cb {
        return true;
    }

    let ta: Vec<String> = skill_tokens(a).iter().map(|t| canonical_skill_key(t)).collect();
    let tb: Vec<String> = skill_tokens(b).iter().map(|t| canonical_skill_key(t)).collect();
    if ta.is_empty() || tb.is_empty() {
        return false;
    }
    if ta.len() == 1 && tb.len() == 1 {
        return ta[0] == tb[0];
    }

    // The shorter token list must be a subset of the longer.
    let (needle, hay) = if ta.len() <= tb.len() { (&ta, &tb) } else { (&tb, &ta) };
    needle.iter().all(|t| hay.contains(t))
}

/// Leading boundary class from the TS regex: `[^a-z0-9+#]`.
fn is_leading_boundary(c: char) -> bool {
    let c = c.to_ascii_lowercase();
    !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+' || c == '#')
}

/// Trailing boundary class from the TS regex: `[^a-z0-9+.]`.
///
/// Note the deliberate asymmetry with the leading class (`#` vs `.`); it is
/// reproduced verbatim so Rust and TypeScript agree on edge cases such as
/// `c#` and `node.js`.
fn is_trailing_boundary(c: char) -> bool {
    let c = c.to_ascii_lowercase();
    !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+' || c == '.')
}

/// Case-insensitive search for `needle` in `hay` with the boundary classes
/// above. Equivalent to the TS regex `(^|[^a-z0-9+#])needle([^a-z0-9+.]|$)`
/// without needing a regex engine.
fn contains_at_boundary(hay_lower: &str, needle_lower: &str) -> bool {
    if needle_lower.is_empty() {
        return false;
    }
    let hay: Vec<char> = hay_lower.chars().collect();
    let needle: Vec<char> = needle_lower.chars().collect();
    if needle.len() > hay.len() {
        return false;
    }
    for start in 0..=(hay.len() - needle.len()) {
        if hay[start..start + needle.len()] != needle[..] {
            continue;
        }
        let lead_ok = start == 0 || is_leading_boundary(hay[start - 1]);
        let end = start + needle.len();
        let trail_ok = end == hay.len() || is_trailing_boundary(hay[end]);
        if lead_ok && trail_ok {
            return true;
        }
    }
    false
}

/// `textCoversSkill`: does `skill` (or a known alias) appear in free text with
/// word-boundary matching?
pub fn text_covers_skill(text: &str, skill: &str) -> bool {
    let hay = text.trim().to_lowercase();
    if hay.is_empty() || skill.trim().is_empty() {
        return false;
    }

    let mut variants: Vec<String> = Vec::new();
    let push = |s: &str, out: &mut Vec<String>| {
        let t = s.trim().to_lowercase();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    };
    push(skill, &mut variants);

    let key = canonical_skill_key(skill);
    if !key.is_empty() {
        for (canon, aliases) in SKILL_ALIASES {
            let matches_group = norm_skill(canon) == key
                || aliases.iter().any(|a| norm_skill(a) == key);
            if matches_group {
                push(canon, &mut variants);
                for a in *aliases {
                    push(a, &mut variants);
                }
            }
        }
    }

    variants.iter().any(|v| contains_at_boundary(&hay, v))
}

// --- Components ----------------------------------------------------------

/// Look up a persona weight the way the TS chain does: raw name, then
/// normalized, then alias-canonical.
fn persona_weight(
    weights: Option<&serde_json::Map<String, serde_json::Value>>,
    skill: &str,
) -> f64 {
    let Some(map) = weights else { return 1.0 };
    for key in [
        skill.to_string(),
        norm_skill(skill),
        canonical_skill_key(skill),
    ] {
        if let Some(v) = map.get(&key).and_then(|v| v.as_f64()) {
            return v;
        }
    }
    1.0
}

/// `skillOverlap`: exact + token/alias overlap; must-haves count double.
pub fn skill_overlap(
    block_skills: &[SkillTag],
    must_have: &[String],
    nice_to_have: &[String],
    persona_weights: Option<&serde_json::Map<String, serde_json::Value>>,
) -> f64 {
    let names: Vec<&str> = block_skills
        .iter()
        .map(|s| s.name.as_str())
        .filter(|n| !n.trim().is_empty())
        .collect();
    if names.is_empty() && must_have.is_empty() && nice_to_have.is_empty() {
        return 0.0;
    }

    let match_one = |target: &str| -> bool {
        if target.trim().is_empty() {
            return false;
        }
        names.iter().any(|n| skills_match(n, target))
    };

    let mut hits = 0.0f64;
    let mut weight = 0.0f64;
    for s in must_have {
        weight += 2.0;
        if match_one(s) {
            hits += 2.0 * persona_weight(persona_weights, s).max(0.5);
        }
    }
    for s in nice_to_have {
        weight += 1.0;
        if match_one(s) {
            hits += persona_weight(persona_weights, s).max(0.5);
        }
    }

    if weight == 0.0 {
        // No JD skills listed — soft credit for domain-ish tags via persona weights.
        let Some(map) = persona_weights else {
            return 0.0;
        };
        let mut p_hits = 0.0f64;
        let mut p_w = 0.0f64;
        for (skill, raw) in map.iter() {
            let Some(w) = raw.as_f64() else { continue };
            p_w += w.abs();
            if match_one(skill) {
                p_hits += w.abs();
            }
        }
        return if p_w > 0.0 { clamp01(p_hits / p_w) } else { 0.0 };
    }
    clamp01(hits / weight)
}

pub fn persona_affinity(block_personas: &[String], persona_id: &str) -> f64 {
    if persona_id.is_empty() {
        return 0.5;
    }
    if block_personas.is_empty() {
        return 0.35;
    }
    if block_personas.iter().any(|p| p == persona_id) {
        return 1.0;
    }
    0.15
}

/// `parseYearMonth`: leading `YYYY` with optional `-MM`; month defaults to 6.
fn parse_year_month(iso: &str) -> Option<(i32, u32)> {
    let bytes: Vec<char> = iso.chars().collect();
    if bytes.len() < 4 || !bytes[..4].iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let year: i32 = iso[..4].parse().ok()?;
    if year < 1970 {
        return None;
    }
    let mut month = 6u32;
    if bytes.len() > 4 && bytes[4] == '-' {
        let digits: String = bytes[5..].iter().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() && digits.len() <= 2 {
            if let Ok(m) = digits.parse::<u32>() {
                month = m.clamp(1, 12);
            }
        } else if !digits.is_empty() {
            // More than two digits is not a month; TS's regex would capture at
            // most two, so mirror that by taking the first two.
            if let Ok(m) = digits[..2].parse::<u32>() {
                month = m.clamp(1, 12);
            }
        }
    }
    Some((year, month))
}

/// `recencyDecay`: exponential decay from end date (or start when open-ended),
/// half-life 4 years. Unparseable dates score 0.5.
pub fn recency_decay(start: &str, end: Option<&str>, now_year: i32, now_month: u32) -> f64 {
    let end_iso = end
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| start.trim());
    let Some((year, month)) = parse_year_month(end_iso) else {
        return 0.5;
    };
    let months = (now_year - year) * 12 + (now_month as i32 - month as i32);
    let years = (months as f64 / 12.0).max(0.0);
    clamp01(0.5f64.powf(years / 4.0))
}

fn seniority_rank(level: &str) -> i32 {
    match level {
        "ic" => 0,
        "senior" => 1,
        "lead" => 2,
        "manager" => 3,
        "director" => 4,
        // TS: `SENIORITY_RANK[x] ?? 1` — unknown levels sit at "senior".
        _ => 1,
    }
}

pub fn seniority_fit(block_level: &str, jd_seniority: &str) -> f64 {
    let dist = (seniority_rank(block_level) - seniority_rank(jd_seniority)).abs();
    match dist {
        0 => 1.0,
        1 => 0.7,
        2 => 0.4,
        _ => 0.15,
    }
}

pub fn combine_score(c: &ScoreComponents, w: &ScoreWeights) -> f64 {
    clamp01(
        w.embedding * c.embedding
            + w.skills * c.skills
            + w.persona * c.persona
            + w.recency * c.recency
            + w.seniority * c.seniority,
    )
}

/// Score one block. `embedding_score` is max facet cosine in [0,1] (0 when off).
#[allow(clippy::too_many_arguments)]
pub fn hybrid_score(
    block: &ExperienceBlock,
    profile: &JdProfile,
    persona: &Persona,
    embedding_score: f64,
    weights: &ScoreWeights,
    now_year: i32,
    now_month: u32,
) -> ScoredBlock {
    let components = ScoreComponents {
        embedding: clamp01(embedding_score),
        skills: skill_overlap(
            &block.skills,
            &profile.must_have_skills,
            &profile.nice_to_have_skills,
            Some(&persona.skill_weights),
        ),
        persona: persona_affinity(&block.personas, &persona.id),
        recency: recency_decay(
            &block.date_range.start,
            block.date_range.end.as_deref(),
            now_year,
            now_month,
        ),
        seniority: seniority_fit(&block.seniority_level, &profile.seniority),
    };
    ScoredBlock {
        score: combine_score(&components, weights),
        components,
        block: block.clone(),
    }
}

/// Score all blocks, sorted by score desc then block id asc (stable tiebreak).
pub fn score_blocks(
    blocks: &[ExperienceBlock],
    profile: &JdProfile,
    persona: &Persona,
    embedding_by_block_id: &std::collections::HashMap<String, f64>,
    semantic_matching_disabled: bool,
    now_year: i32,
    now_month: u32,
) -> Vec<ScoredBlock> {
    let weights = weights_for_facets(semantic_matching_disabled);
    let mut scored: Vec<ScoredBlock> = blocks
        .iter()
        .map(|b| {
            hybrid_score(
                b,
                profile,
                persona,
                embedding_by_block_id.get(&b.id).copied().unwrap_or(0.0),
                &weights,
                now_year,
                now_month,
            )
        })
        .collect();
    sort_scored(&mut scored);
    scored
}

/// The canonical ordering used everywhere selection compares blocks:
/// score descending, then block id ascending.
pub fn sort_scored(scored: &mut [ScoredBlock]) {
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.block.id.cmp(&b.block.id))
    });
}
