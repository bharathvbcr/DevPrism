//! Skill normalisation and word-boundary matching.
//!
//! This is a faithful Rust port of `src/lib/resume-synthesis/scoring.ts`
//! (`normSkill`, `canonicalSkillKey`, `skillTokens`, `skillsMatch`,
//! `textCoversSkill`). The TypeScript module is the canonical owner; this port
//! exists because the MCP server runs headless and cannot call into the
//! webview. Any behaviour change must land in both, and `parity` tests below
//! pin the cases the TS suite pins.
//!
//! The rule these functions implement, and the reason they exist: skill
//! matching is **token / word-boundary**, never bare substring. The MCP tools
//! previously used `a.contains(b) || b.contains(a)`, which matched "go" inside
//! "mongodb" and "r" inside virtually everything.

/// Characters that are part of a skill token: `[a-z0-9+#.]`.
///
/// `+`, `#` and `.` are kept so `c++`, `c#` and `node.js` survive
/// normalisation as single tokens.
fn is_skill_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+' || c == '#' || c == '.'
}

/// Strip to lowercase alphanumeric (plus `+#.`). Port of `normSkill`.
pub fn norm_skill(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .chars()
        .filter(|c| is_skill_char(*c))
        .collect()
}

/// Split a skill into normalised word tokens. Port of `skillTokens`.
pub fn skill_tokens(s: &str) -> Vec<String> {
    s.trim()
        .to_lowercase()
        .split(|c: char| !is_skill_char(c))
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// Canonical form → aliases. Port of `SKILL_ALIASES`.
///
/// Deliberately omits dangerous short overlaps (`go` does not alias `cargo`,
/// `java` does not alias `javascript`).
pub const SKILL_ALIASES: &[(&str, &[&str])] = &[
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

/// Resolve a skill name to its alias-canonical form. Port of `canonicalSkillKey`.
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

/// Token / word-boundary skill match. Port of `skillsMatch`.
///
/// Never matches on bare substring: `skills_match("mongodb", "go")` is false.
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

    // The shorter token list must be a subset of the longer one.
    let (needle, hay) = if ta.len() <= tb.len() { (&ta, &tb) } else { (&tb, &ta) };
    needle.iter().all(|t| hay.contains(t))
}

/// Leading boundary class from the canonical regex `(^|[^a-z0-9+#&])`.
fn is_leading_boundary(c: char) -> bool {
    !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+' || c == '#' || c == '&')
}

/// Trailing boundary class from the canonical regex `([^a-z0-9+&]|$)`.
///
/// Two edges are deliberate, and were changed here and in `scoring.ts`
/// together:
///   * `.` IS a valid right edge, so a skill ending a sentence
///     ("...and Kubernetes.") matches. It previously did not, silently dropping
///     requirements from real job descriptions. Letters remain excluded, so
///     Node⊄Nodemon still holds.
///   * `&` is not a valid edge on either side, so "R&D" is not evidence of the
///     skill "R". An ampersand joins tokens rather than separating them.
fn is_trailing_boundary(c: char) -> bool {
    !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+' || c == '&')
}

/// True when `needle` occurs in `hay` at a word boundary. Both must already be
/// lowercase. Replaces the canonical regex without pulling in a regex crate.
fn contains_at_boundary(hay: &str, needle: &str) -> bool {
    if needle.is_empty() || needle.len() > hay.len() {
        return false;
    }
    let mut from = 0usize;
    while let Some(rel) = hay[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();

        let before_ok = hay[..start].chars().next_back().is_none_or(is_leading_boundary);
        let after_ok = hay[end..].chars().next().is_none_or(is_trailing_boundary);
        if before_ok && after_ok {
            return true;
        }
        // Advance by one char, not one byte, so we stay on a UTF-8 boundary.
        match hay[start..].chars().next() {
            Some(c) => from = start + c.len_utf8(),
            None => break,
        }
    }
    false
}

/// True when `skill` appears in free text with word-boundary matching and
/// alias variants. Port of `textCoversSkill`.
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
            let matches_group =
                norm_skill(canon) == key || aliases.iter().any(|a| norm_skill(a) == key);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_skill_keeps_plus_hash_dot() {
        assert_eq!(norm_skill("  C++ "), "c++");
        assert_eq!(norm_skill("C#"), "c#");
        assert_eq!(norm_skill("Node.js"), "node.js");
        assert_eq!(norm_skill("Machine Learning"), "machinelearning");
        assert_eq!(norm_skill(""), "");
        assert_eq!(norm_skill("   "), "");
        assert_eq!(norm_skill("!!!"), "");
    }

    #[test]
    fn skill_tokens_splits_on_non_skill_chars() {
        assert_eq!(skill_tokens("Machine Learning"), vec!["machine", "learning"]);
        assert_eq!(skill_tokens("PyTorch  Lightning"), vec!["pytorch", "lightning"]);
        assert_eq!(skill_tokens("C++/CUDA"), vec!["c++", "cuda"]);
        assert!(skill_tokens("   ").is_empty());
    }

    #[test]
    fn canonical_key_folds_known_aliases() {
        assert_eq!(canonical_skill_key("JS"), "javascript");
        assert_eq!(canonical_skill_key("k8s"), "kubernetes");
        assert_eq!(canonical_skill_key("Go"), "golang");
        assert_eq!(canonical_skill_key("cpp"), "c++");
        assert_eq!(canonical_skill_key("node"), "node.js");
        // Unknown skills fold to their normalised form, not to an alias.
        assert_eq!(canonical_skill_key("Rust"), "rust");
    }

    /// The defect this whole module exists to kill.
    #[test]
    fn substring_collisions_do_not_match() {
        assert!(!skills_match("MongoDB", "Go"));
        assert!(!skills_match("JavaScript", "Java"));
        assert!(!skills_match("Cargo", "Go"));
        assert!(!text_covers_skill("we use mongodb in production", "go"));
        assert!(!text_covers_skill("strong javascript background", "java"));
        // A single letter must not match everything.
        assert!(!text_covers_skill("built a rust parser", "r"));
    }

    #[test]
    fn genuine_matches_still_match() {
        assert!(skills_match("Go", "golang"));
        assert!(skills_match("PyTorch Lightning", "pytorch"));
        assert!(text_covers_skill("shipped a Go service", "golang"));
        assert!(text_covers_skill("deep experience with Kubernetes", "k8s"));
        assert!(text_covers_skill("wrote C++ kernels", "c++"));
        assert!(text_covers_skill("Node.js backend", "node"));
        // Start and end of string are boundaries.
        assert!(text_covers_skill("rust", "rust"));
        assert!(text_covers_skill("Python", "python"));
    }

    /// A skill ending a sentence must match. Fixed in this port and in
    /// `scoring.ts` together (both boundary classes changed in the same
    /// change), so the two remain in lockstep.
    #[test]
    fn a_sentence_final_skill_matches() {
        assert!(text_covers_skill("we chose go. it was fast", "golang"));
        assert!(text_covers_skill("deep experience with kubernetes.", "kubernetes"));
        assert!(text_covers_skill("expert in c++.", "c++"));
        assert!(text_covers_skill("fluent in c#.", "c#"));
        assert!(text_covers_skill("we chose go, it was fast", "golang"));
        assert!(text_covers_skill("we chose go it was fast", "golang"));
        // Leading class excludes '+', so "c++" preceded by a space matches.
        assert!(text_covers_skill("uses c++ heavily", "c++"));
        // Allowing '.' as a right edge must NOT reintroduce Node in Nodemon.
        assert!(!text_covers_skill("nodemon watcher", "node"));
    }

    /// An ampersand joins tokens, so "R&D" is not evidence of the skill "R".
    #[test]
    fn ampersand_is_not_a_word_boundary() {
        assert!(!text_covers_skill("led R&D initiatives", "r"));
        assert!(!text_covers_skill("R&D and AT&T", "d"));
        assert!(text_covers_skill("proficient in R and Python", "r"));
        assert!(text_covers_skill("analysis in R.", "r"));
    }

    #[test]
    fn empty_and_whitespace_inputs_are_safe() {
        assert!(!text_covers_skill("", "rust"));
        assert!(!text_covers_skill("rust", ""));
        assert!(!text_covers_skill("   ", "  "));
        assert!(!skills_match("", ""));
        assert!(!skills_match("rust", ""));
    }

    #[test]
    fn unicode_input_does_not_panic_or_split_mid_char() {
        // Multi-byte haystack with a repeated needle-like prefix.
        assert!(!text_covers_skill("日本語のプログラミング", "go"));
        assert!(text_covers_skill("emoji 🚀 then rust here", "rust"));
        // Needle appearing many times without a boundary must terminate.
        let hay = "gogogogogogogogogogo".to_string();
        assert!(!text_covers_skill(&hay, "golang"));
        assert!(!text_covers_skill(&hay, "go"));
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert!(text_covers_skill("SHIPPED RUST CODE", "rust"));
        assert!(text_covers_skill("shipped rust code", "RUST"));
        assert!(skills_match("RUST", "rust"));
    }
}
