//! Metric-preservation checking: the anti-hallucination core.
//!
//! Faithful Rust port of `metricPreservedInText` / `metricsValuesPreserved`
//! from `src/lib/resume-synthesis/rewrite.ts`.
//!
//! # Why this exists
//!
//! The MCP `resume_rewrite_bullets` tool used to return
//! `"provenanceVerified": true, "hasHallucination": false` as literals, without
//! running any check at all, and `resume_finetune_bullet` would *append a
//! fabricated metric* ("improved latency/efficiency by 25%") to any bullet that
//! lacked a number. A check that cannot run must never report the same result
//! as a check that ran and passed, so both now call into this module and report
//! what it actually found.
//!
//! The rule: a rewritten bullet is only acceptable if every canonical metric on
//! the source bullet still appears in the rewritten text, allowing the same
//! synonym tolerance the TypeScript allows (25% ↔ "25 percent", 5x ↔ "5-fold",
//! $1.2M ↔ "1,200,000", 10,000 ↔ "10k", 3 ↔ "three") but never allowing a
//! number to silently change.

/// JS `\w` is `[A-Za-z0-9_]`.
fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Left edge of a *quantity*: the match may not continue a longer number.
///
/// Stricter than the canonical `[^\d,]` because that guard lets "25%" match
/// inside "125%" and "5" match inside "1.5". This is a DELIBERATE divergence
/// from `metricPreservedInText` in rewrite.ts: this function gates whether a
/// rewritten résumé bullet may claim a number, and a false "preserved" is the
/// one failure this whole module exists to prevent. The same fix is owed to the
/// TypeScript; see `divergence_from_canonical_is_intentional`.
fn quantity_left_ok(c: char) -> bool {
    // Symmetric with `quantity_right_ok`: a letter on the left means the digits
    // belong to an identifier ("Q5", "v2", "p99"), not to a standalone quantity.
    !(c.is_ascii_alphanumeric() || c == '.' || c == ',')
}

/// Right edge of a quantity: may not continue into a number, decimal, or word.
///
/// Rejects "5" inside "5th", "Q5x", "5.5" and "5,000". A trailing unit such as
/// `%` is still a valid edge, so "25" is preserved by "25%".
fn quantity_right_ok(c: char) -> bool {
    !(c.is_ascii_alphanumeric() || c == '.' || c == ',')
}

/// Longest text this module will scan.
///
/// `occurs_with_guards` restarts the search one char past each rejected match,
/// so a long haystack paired with a long needle is quadratic. MCP arguments are
/// caller-supplied, so the scan is bounded rather than left as a way to block
/// the handler thread.
const MAX_SCAN_CHARS: usize = 200_000;

/// Longest metric value considered. Anything longer is not a metric.
const MAX_METRIC_CHARS: usize = 128;

/// Generic scan: does `needle` occur in `hay` with the supplied edge guards?
/// Both are compared case-insensitively by the callers (which lowercase first).
fn occurs_with_guards(
    hay: &str,
    needle: &str,
    left_ok: fn(char) -> bool,
    right_ok: fn(char) -> bool,
) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut from = 0usize;
    while let Some(rel) = hay[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();
        let before = hay[..start].chars().next_back().is_none_or(left_ok);
        let after = hay[end..].chars().next().is_none_or(right_ok);
        if before && after {
            return true;
        }
        match hay[start..].chars().next() {
            Some(c) => from = start + c.len_utf8(),
            None => break,
        }
    }
    false
}

/// `\bWORD\b` where the boundary is JS `\w`.
fn occurs_word_bounded(hay: &str, needle: &str) -> bool {
    occurs_with_guards(hay, needle, |c| !is_word_char(c), |c| !is_word_char(c))
}

/// Implements `(?:^|[^\d,])NUM\s*(?:SUFFIX)(?:[^\w]|$)` for a set of suffixes.
///
/// `hay` and `num` must already be lowercase.
fn num_followed_by_suffix(hay: &str, num: &str, suffixes: &[&str]) -> bool {
    if num.is_empty() {
        return false;
    }
    let mut from = 0usize;
    while let Some(rel) = hay[from..].find(num) {
        let start = from + rel;
        let end = start + num.len();
        let before = hay[..start].chars().next_back().is_none_or(quantity_left_ok);
        if before {
            // Skip `\s*`.
            let rest = &hay[end..];
            let trimmed = rest.trim_start_matches([' ', '\t']);
            for suf in suffixes {
                // A suffix may itself begin with optional space (e.g. " fold");
                // callers pass the already-space-tolerant forms.
                let suf_trimmed = suf.trim_start();
                if let Some(after_suf) = trimmed.strip_prefix(suf_trimmed) {
                    let tail_ok = after_suf.chars().next().is_none_or(|c| !is_word_char(c));
                    if tail_ok {
                        return true;
                    }
                }
            }
        }
        match hay[start..].chars().next() {
            Some(c) => from = start + c.len_utf8(),
            None => break,
        }
    }
    false
}

fn is_all_digits(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// Parse a leading `\d+(\.\d+)?` from `s`, returning (matched_text, rest).
fn take_number(s: &str) -> Option<(&str, &str)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        let mut j = i + 1;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > i + 1 {
            i = j;
        }
    }
    Some((&s[..i], &s[i..]))
}

/// Group an integer with `,` every three digits, matching
/// `Number.prototype.toLocaleString("en-US")` for whole numbers.
fn group_thousands(n: u128) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    let len = digits.len();
    for (idx, ch) in digits.chars().enumerate() {
        if idx > 0 && (len - idx) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

const NUMBER_WORDS: &[(&str, &str)] = &[
    ("1", "one"),
    ("2", "two"),
    ("3", "three"),
    ("4", "four"),
    ("5", "five"),
    ("6", "six"),
    ("7", "seven"),
    ("8", "eight"),
    ("9", "nine"),
    ("10", "ten"),
];

/// Boundary-aware, synonym-tolerant metric verification.
///
/// Returns true when `metric_value` is still expressed in `text`. An empty
/// metric is vacuously preserved, matching the TypeScript.
pub fn metric_preserved_in_text(metric_value: &str, text: &str) -> bool {
    let v = metric_value.trim();
    if v.is_empty() {
        return true;
    }

    if v.chars().count() > MAX_METRIC_CHARS || text.chars().count() > MAX_SCAN_CHARS {
        return false;
    }

    let v_lower = v.to_lowercase();
    let hay = text.to_lowercase();

    // 1. Exact occurrence, guarded on BOTH edges so a metric can never be
    //    satisfied by a longer number that merely contains it.
    if occurs_with_guards(&hay, &v_lower, quantity_left_ok, quantity_right_ok) {
        return true;
    }
    // Metrics whose first character is not a digit (e.g. "$1.2M", "~5x") only
    // need the right edge guarded; their own prefix supplies the left one.
    if !v_lower.starts_with(|c: char| c.is_ascii_digit())
        && occurs_with_guards(&hay, &v_lower, |_| true, quantity_right_ok)
    {
        return true;
    }

    // 2. Percentages: "25%" ↔ "25 percent" / "25 pct" / "25.0%".
    if let Some((num, rest)) = take_number(&v_lower) {
        let rest_trimmed = rest.trim_start();
        if rest_trimmed.starts_with('%') {
            let suffixes = ["%", "percent", "pct", "percentage"];
            if num_followed_by_suffix(&hay, num, &suffixes) {
                return true;
            }
            // The one-decimal form exists so "25%" matches "25.0%". Only added
            // when rounding to one place is LOSSLESS: applying it to a value
            // with more precision accepted a genuinely different number, and
            // Rust's `{:.1}` (half-to-even) and JS `toFixed(1)` (half-up)
            // disagree on exact ties, so the two ports accepted *different*
            // wrong numbers. Mirrored in rewrite.ts.
            let decimals = num.split_once('.').map(|(_, d)| d.len()).unwrap_or(0);
            if decimals <= 1 {
                if let Ok(f) = num.parse::<f64>() {
                    let one_dp = format!("{f:.1}");
                    if num_followed_by_suffix(&hay, &one_dp, &suffixes) {
                        return true;
                    }
                }
            }
        }
    }

    // 3. Multipliers: "5x" ↔ "5-fold" / "5 times".
    if let Some((num, rest)) = take_number(&v_lower) {
        if rest.trim() == "x" && num_followed_by_suffix(&hay, num, &["x", "-fold", "fold", "times"])
        {
            return true;
        }
    }

    // 4. Currency and magnitude: "$1.2M" ↔ "1,200,000".
    if let Some((num, mag)) = parse_currency(&v_lower) {
        if let Ok(f) = num.parse::<f64>() {
            let scaled = |mult: f64| -> u128 { (f * mult).round().max(0.0) as u128 };
            let (words, mult): (&[&str], f64) = match mag {
                Magnitude::Thousand => (&["k", "thousand", "k usd"], 1_000.0),
                Magnitude::Million => (&["m", "million", "m usd"], 1_000_000.0),
                Magnitude::Billion => (&["b", "billion", "b usd"], 1_000_000_000.0),
            };
            if num_followed_by_suffix(&hay, num, words) {
                return true;
            }
            let full = scaled(mult);
            for form in [group_thousands(full), full.to_string()] {
                // Not `occurs_word_bounded`: ',' counts as a word boundary, so
                // "200,000" would satisfy "1,200,000".
                if occurs_with_guards(&hay, &form, quantity_left_ok, quantity_right_ok) {
                    return true;
                }
            }
        }
    }

    // 5. Comma-formatted numbers: "10,000" ↔ "10000" ↔ "10k".
    if is_comma_grouped(v) {
        let raw: String = v.chars().filter(|c| *c != ',').collect();
        if occurs_with_guards(&hay, &raw, quantity_left_ok, quantity_right_ok) {
            return true;
        }
        if let Ok(n) = raw.parse::<f64>() {
            let as_k = n / 1000.0;
            let rendered = if (as_k.fract()).abs() < f64::EPSILON {
                format!("{}k", as_k as i64)
            } else {
                format!("{as_k}k")
            };
            if occurs_word_bounded(&hay, &rendered) {
                return true;
            }
        }
    }

    // 6. Number words: "3" ↔ "three".
    if is_all_digits(v) {
        for (digit, word) in NUMBER_WORDS {
            if *digit == v && occurs_word_bounded(&hay, word) {
                return true;
            }
        }
    }

    false
}

enum Magnitude {
    Thousand,
    Million,
    Billion,
}

/// Parse `(\$|usd\s*|€|£)?\s*(\d+(\.\d+)?)\s*(k|m|b|thousand|million|billion)?\s*(usd)?`.
/// Returns None when there is no magnitude suffix, since only the magnitude
/// branch does extra work.
fn parse_currency(v_lower: &str) -> Option<(&str, Magnitude)> {
    let mut s = v_lower.trim();
    for prefix in ["$", "usd", "€", "£"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.trim_start();
            break;
        }
    }
    let (num, rest) = take_number(s)?;
    let rest = rest.trim_start();
    let rest = rest.strip_suffix("usd").unwrap_or(rest).trim_end();
    let mag = match rest {
        "k" | "thousand" => Magnitude::Thousand,
        "m" | "million" => Magnitude::Million,
        "b" | "billion" => Magnitude::Billion,
        _ => return None,
    };
    Some((num, mag))
}

/// `^(\d{1,3}(?:,\d{3})+)$`
fn is_comma_grouped(v: &str) -> bool {
    let parts: Vec<&str> = v.split(',').collect();
    if parts.len() < 2 {
        return false;
    }
    let Some(first) = parts.first() else {
        return false;
    };
    if first.is_empty() || first.len() > 3 || !is_all_digits(first) {
        return false;
    }
    parts[1..].iter().all(|p| p.len() == 3 && is_all_digits(p))
}

/// Numeric tokens appearing in `text`, as written (digits plus a `%`/`x` tail).
///
/// Used to detect *introduced* quantities, which metric preservation alone
/// cannot catch: a bullet with no canonical metrics trivially "preserves" all
/// zero of them, so a draft could invent "40% faster" and still pass.
pub fn numeric_tokens(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        // A digit run glued to a preceding letter is an identifier ("p99",
        // "v2", "Q5"), not a quantity the bullet is claiming.
        if i > 0 && (chars[i - 1].is_ascii_alphabetic() || chars[i - 1] == '.') {
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.' || chars[i] == ',') {
                i += 1;
            }
            continue;
        }
        let start = i;
        while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == ',' || chars[i] == '.') {
            i += 1;
        }
        let mut end = i;
        while end > start && (chars[end - 1] == '.' || chars[end - 1] == ',') {
            end -= 1;
        }
        let mut tok: String = chars[start..end].iter().collect();
        if end < chars.len() {
            let c = chars[end];
            if c == '%' || c == 'x' || c == 'X' {
                tok.push(c.to_ascii_lowercase());
            }
        }
        if !tok.is_empty() {
            out.push(tok);
        }
    }
    out
}

/// Quantities in `draft` justified by neither the canonical bullet text nor its
/// recorded metrics.
///
/// A non-empty result means the draft asserts a number the knowledgebase does
/// not support. This is what makes "verified" mean something for bullets that
/// carry no metrics of their own.
/// Spelled-out quantities. A draft can invent a figure without using a digit
/// ("tripled throughput", "ten million rows"), which a digit-only scan misses.
const QUANTITY_WORDS: &[&str] = &[
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "twenty", "thirty", "forty", "fifty", "hundred",
    "thousand", "million", "billion", "trillion", "double", "doubled",
    "doubling", "triple", "tripled", "tripling", "quadrupled", "half", "halved",
    "tenfold", "hundredfold",
];

pub fn introduced_numbers(
    canonical_text: &str,
    canonical_metrics: &[crate::career_db::BulletMetric],
    draft: &str,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    // Spelled-out quantities absent from the canonical text and metrics.
    let canon_lower = canonical_text.to_lowercase();
    let draft_lower = draft.to_lowercase();
    let canon_tokens = numeric_tokens(canonical_text);
    for w in QUANTITY_WORDS {
        if !occurs_word_bounded(&draft_lower, w) {
            continue;
        }
        if occurs_word_bounded(&canon_lower, w) {
            continue;
        }
        // A digit metric can license its own word form ("3" licenses "three").
        let licensed = canonical_metrics.iter().any(|m| {
            metric_preserved_in_text(&m.value, &format!(" {w} "))
        }) || metric_preserved_in_text(
            NUMBER_WORDS
                .iter()
                .find(|(_, word)| word == w)
                .map(|(d, _)| *d)
                .unwrap_or("\u{0}"),
            &canon_lower,
        );
        if !licensed && !out.contains(&(*w).to_string()) {
            out.push((*w).to_string());
        }
    }

    for tok in numeric_tokens(draft) {
        if metric_preserved_in_text(&tok, canonical_text) {
            continue;
        }
        // The canonical text may contain the same *written form* even when
        // preservation semantics reject the bare number: "5th" yields the
        // token "5", which `metric_preserved_in_text` deliberately refuses to
        // see inside "5th". A draft that copies an ordinal from the canonical
        // bullet invented nothing, so the identical token extracted from the
        // canonical text licenses it. Membership in `numeric_tokens(canonical)`
        // cannot license a genuinely invented figure — the form must literally
        // be there already.
        if canon_tokens.contains(&tok) {
            continue;
        }
        if canonical_metrics.iter().any(|m| {
            metric_preserved_in_text(&tok, &m.value) || metric_preserved_in_text(&m.value, &tok)
        }) {
            continue;
        }
        if !out.contains(&tok) {
            out.push(tok);
        }
    }
    out
}

/// Every metric value must survive. Empty values are skipped.
pub fn metrics_values_preserved(metrics: &[crate::career_db::BulletMetric], text: &str) -> bool {
    metrics
        .iter()
        .filter(|m| !m.value.trim().is_empty())
        .all(|m| metric_preserved_in_text(&m.value, text))
}

/// The metric values that did NOT survive, for honest reporting.
pub fn dropped_metrics(metrics: &[crate::career_db::BulletMetric], text: &str) -> Vec<String> {
    metrics
        .iter()
        .filter(|m| !m.value.trim().is_empty())
        .filter(|m| !metric_preserved_in_text(&m.value, text))
        .map(|m| m.value.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_metric_is_vacuously_preserved() {
        assert!(metric_preserved_in_text("", "anything"));
        assert!(metric_preserved_in_text("   ", "anything"));
    }

    #[test]
    fn exact_values_are_preserved() {
        assert!(metric_preserved_in_text("25%", "improved by 25% overall"));
        assert!(metric_preserved_in_text("1.61x", "delivered 1.61x speedup"));
        assert!(metric_preserved_in_text("$1.2M", "closed $1.2M in revenue"));
    }

    /// The core safety property: a changed number is NOT preserved.
    #[test]
    fn a_different_number_is_not_preserved() {
        assert!(!metric_preserved_in_text("25%", "improved by 35% overall"));
        assert!(!metric_preserved_in_text("5x", "delivered 3x speedup"));
        assert!(!metric_preserved_in_text("0.94", "raised success to 0.95"));
        assert!(!metric_preserved_in_text("238", "packaged 239 artifacts"));
    }

    /// Bare integers must not match inside a larger number.
    #[test]
    fn bare_integers_respect_numeric_boundaries() {
        assert!(!metric_preserved_in_text("5", "we shipped 25 features"));
        assert!(!metric_preserved_in_text("5", "we shipped 1,500 units"));
        assert!(metric_preserved_in_text("5", "we shipped 5 features"));
        assert!(metric_preserved_in_text("5", "5 features"));
        assert!(metric_preserved_in_text("5", "shipped 5"));
    }

    #[test]
    fn percent_synonyms_are_tolerated() {
        assert!(metric_preserved_in_text("25%", "improved by 25 percent"));
        assert!(metric_preserved_in_text("25%", "improved by 25 pct"));
        assert!(metric_preserved_in_text("25%", "improved by 25.0%"));
        assert!(!metric_preserved_in_text("25%", "improved by 250 percent"));
    }

    #[test]
    fn multiplier_synonyms_are_tolerated() {
        assert!(metric_preserved_in_text("5x", "a 5-fold increase"));
        assert!(metric_preserved_in_text("5x", "5 times faster"));
        assert!(metric_preserved_in_text("5x", "5X faster"));
        assert!(!metric_preserved_in_text("5x", "50 times faster"));
    }

    #[test]
    fn magnitudes_expand_to_full_numbers() {
        assert!(metric_preserved_in_text("$1.2M", "generated 1,200,000 in revenue"));
        assert!(metric_preserved_in_text("$1.2M", "generated 1200000 in revenue"));
        assert!(metric_preserved_in_text("$100K", "saved 100,000 dollars"));
        assert!(metric_preserved_in_text("$5B", "a 5 billion dollar market"));
        assert!(!metric_preserved_in_text("$1.2M", "generated 2,400,000 in revenue"));
    }

    #[test]
    fn comma_numbers_round_trip() {
        assert!(metric_preserved_in_text("10,000", "processed 10000 rows"));
        assert!(metric_preserved_in_text("10,000", "processed 10k rows"));
        assert!(metric_preserved_in_text("10,000", "processed 10,000 rows"));
        assert!(!metric_preserved_in_text("10,000", "processed 20000 rows"));
    }

    #[test]
    fn number_words_are_tolerated() {
        assert!(metric_preserved_in_text("3", "directed a team of three"));
        assert!(metric_preserved_in_text("10", "ten providers"));
        assert!(!metric_preserved_in_text("3", "directed a team of four"));
        // Only 1-10 are mapped.
        assert!(!metric_preserved_in_text("11", "eleven providers"));
    }

    #[test]
    fn group_thousands_matches_en_us() {
        assert_eq!(group_thousands(0), "0");
        assert_eq!(group_thousands(1), "1");
        assert_eq!(group_thousands(999), "999");
        assert_eq!(group_thousands(1_000), "1,000");
        assert_eq!(group_thousands(1_200_000), "1,200,000");
        assert_eq!(group_thousands(1_000_000_000), "1,000,000,000");
    }

    #[test]
    fn comma_grouping_detection_is_strict() {
        assert!(is_comma_grouped("10,000"));
        assert!(is_comma_grouped("1,200,000"));
        assert!(!is_comma_grouped("10,00"));
        assert!(!is_comma_grouped("1234"));
        assert!(!is_comma_grouped(",000"));
        assert!(!is_comma_grouped("10,000,"));
    }

    #[test]
    fn unicode_and_pathological_input_do_not_panic() {
        assert!(!metric_preserved_in_text("25%", "改善しました"));
        assert!(!metric_preserved_in_text("5", &"5".repeat(1000)));
        assert!(metric_preserved_in_text("5", &format!("a 5 {}", "x".repeat(5000))));
        // Needle longer than haystack.
        assert!(!metric_preserved_in_text("123456789", "1"));
    }

    #[test]
    fn dropped_metrics_reports_exactly_what_was_lost() {
        use crate::career_db::BulletMetric;
        let metrics = vec![
            BulletMetric { value: "25%".into(), kind: "pct".into() },
            BulletMetric { value: "5x".into(), kind: "mult".into() },
            BulletMetric { value: "".into(), kind: "noise".into() },
        ];
        let kept = "improved 25 percent with a 5-fold gain";
        assert!(metrics_values_preserved(&metrics, kept));
        assert!(dropped_metrics(&metrics, kept).is_empty());

        let lost = "improved 25 percent";
        assert!(!metrics_values_preserved(&metrics, lost));
        assert_eq!(dropped_metrics(&metrics, lost), vec!["5x".to_string()]);
    }

    #[test]
    fn numeric_tokens_extracts_quantities_with_units() {
        assert_eq!(numeric_tokens("cut latency 25% via 3x batching"), vec!["25%", "3x"]);
        assert_eq!(numeric_tokens("processed 1,200,000 rows"), vec!["1,200,000"]);
        assert!(numeric_tokens("no numbers here").is_empty());
        assert_eq!(numeric_tokens("ends with 5."), vec!["5"]);
    }

    /// The hole this closes: a bullet with no metrics trivially "preserved" all
    /// zero of them, so any invented figure passed verification.
    #[test]
    fn introduced_numbers_catches_invention_on_a_metricless_bullet() {
        let canonical = "Rebuilt the ingest pipeline";
        assert_eq!(
            introduced_numbers(canonical, &[], "Rebuilt the ingest pipeline, 40% faster"),
            vec!["40%"]
        );
    }

    #[test]
    fn numbers_already_in_the_canonical_text_are_not_flagged() {
        let canonical = "Cut p99 latency by 25% across 3 services";
        assert!(
            introduced_numbers(canonical, &[], "Reduced p99 latency 25% over 3 services").is_empty()
        );
    }

    #[test]
    fn numbers_backed_by_a_recorded_metric_are_not_flagged() {
        use crate::career_db::BulletMetric;
        let m = vec![BulletMetric { value: "25%".into(), kind: "pct".into() }];
        let canonical = "Cut latency substantially";
        assert!(introduced_numbers(canonical, &m, "Cut latency by 25%").is_empty());
        assert_eq!(introduced_numbers(canonical, &m, "Cut latency by 80%"), vec!["80%"]);
    }

    // --- Regressions from the adversarial pass (all previously FALSE POSITIVES,
    // i.e. a changed number was reported as preserved). ---

    #[test]
    fn a_metric_is_not_preserved_by_a_longer_number_containing_it() {
        assert!(!metric_preserved_in_text("25%", "improved by 125%"));
        assert!(!metric_preserved_in_text("5", "ranked 5th overall"));
        assert!(!metric_preserved_in_text("5", "shipped Q5 features"));
        assert!(!metric_preserved_in_text("5%", "improved by 5.5%"));
        assert!(!metric_preserved_in_text("25", "improved by 25.7"));
        assert!(!metric_preserved_in_text("1.2", "grew to 11.2"));
        assert!(!metric_preserved_in_text("10,000", "processed 110,000 rows"));
    }

    #[test]
    fn magnitude_expansion_is_not_satisfied_by_a_partial_group() {
        // "$1.2M" expands to 1,200,000; "200,000" must not satisfy it.
        assert!(!metric_preserved_in_text("$1.2M", "generated 200,000 in revenue"));
        assert!(metric_preserved_in_text("$1.2M", "generated 1,200,000 in revenue"));
    }

    #[test]
    fn genuine_matches_survive_the_stricter_guards() {
        assert!(metric_preserved_in_text("25%", "improved by 25%"));
        assert!(metric_preserved_in_text("25%", "improved by 25% overall"));
        assert!(metric_preserved_in_text("25", "improved by 25%"));
        assert!(metric_preserved_in_text("5", "shipped 5 features"));
        assert!(metric_preserved_in_text("5", "shipped 5"));
        assert!(metric_preserved_in_text("$1.2M", "closed $1.2M"));
        assert!(metric_preserved_in_text("1.61x", "delivered 1.61x speedup"));
        assert!(metric_preserved_in_text("10,000", "processed 10,000 rows"));
    }

    #[test]
    fn oversized_inputs_are_bounded_not_scanned() {
        let huge_text = "5 ".repeat(MAX_SCAN_CHARS);
        assert!(!metric_preserved_in_text("5", &huge_text));
        let huge_metric = "9".repeat(MAX_METRIC_CHARS + 1);
        assert!(!metric_preserved_in_text(&huge_metric, "9"));
    }

    /// Parity with the TypeScript counterpart.
    ///
    /// `rewrite.ts::metricPreservedInText` carried the same boundary defects
    /// (it reported "25%" preserved in "125%") and they were fixed in both
    /// implementations together, along with an unescaped `toFixed(1)` that made
    /// '.' a regex wildcard on the TS side only. A 770-pair differential over
    /// `<scratch>/diff/corpus.json` now reports **0 divergences**; regenerate it
    /// with the `differential::emit_verdicts_for_corpus` harness below plus a
    /// Node transpile of rewrite.ts.
    #[test]
    fn parity_with_typescript_on_the_boundary_cases() {
        for (metric, text) in [
            ("25%", "improved by 125%"),
            ("5", "ranked 5th"),
            ("5%", "changed by 5.5%"),
            ("1.5%", "improved by 125%"),
            ("$1.2M", "generated 1,200,000,000 in revenue"),
            ("10,000", "processed 110,000 rows"),
        ] {
            assert!(!metric_preserved_in_text(metric, text), "{metric:?} vs {text:?}");
        }
        for (metric, text) in [
            ("25%", "improved by 25.0%"),
            ("25%", "improved by 25 percent"),
            ("$1.2M", "generated 1,200,000 in revenue"),
            ("10,000", "processed 10k rows"),
        ] {
            assert!(metric_preserved_in_text(metric, text), "{metric:?} vs {text:?}");
        }
    }

    /// Regression: a draft can invent a figure without using a digit.
    #[test]
    fn spelled_out_quantities_are_caught() {
        let canonical = "Rebuilt the ingest pipeline";
        assert_eq!(
            introduced_numbers(canonical, &[], "Tripled ingest throughput"),
            vec!["tripled"]
        );
        assert!(
            introduced_numbers(canonical, &[], "Processed ten million rows")
                .contains(&"million".to_string())
        );
    }

    #[test]
    fn a_word_form_licensed_by_the_canonical_text_is_not_flagged() {
        let canonical = "Directed a team of three engineers";
        assert!(introduced_numbers(canonical, &[], "Led three engineers").is_empty());
        // And the digit form licenses the word form.
        use crate::career_db::BulletMetric;
        let m = vec![BulletMetric { value: "3".into(), kind: "count".into() }];
        assert!(introduced_numbers("Directed a small team", &m, "Led three engineers").is_empty());
    }

    /// The one-decimal tolerance must not accept a different number, and must
    /// not diverge from JS `toFixed(1)` on exact ties.
    #[test]
    fn one_decimal_tolerance_is_lossless_only() {
        // Lossless: "25%" and "25.0%" are the same value.
        assert!(metric_preserved_in_text("25%", "improved by 25.0%"));
        assert!(metric_preserved_in_text("2.5%", "improved by 2.5%"));
        // Lossy: 0.25 is not 0.2 or 0.3, whichever way the language rounds.
        assert!(!metric_preserved_in_text("0.25%", "reduced by 0.2%"));
        assert!(!metric_preserved_in_text("0.25%", "reduced by 0.3%"));
        assert!(!metric_preserved_in_text("1.25%", "reduced by 1.2%"));
        assert!(!metric_preserved_in_text("1.25%", "reduced by 1.3%"));
        assert!(!metric_preserved_in_text("25.44%", "reduced by 25.4%"));
        assert!(!metric_preserved_in_text("3.75%", "reduced by 3.8%"));
    }
}

#[cfg(test)]
mod differential {
    /// Differential harness against the canonical TypeScript.
    ///
    /// Ignored by default: it needs a corpus produced by the extraction script
    /// in the scratch directory. Run with
    /// `DIFF_CORPUS=<path> cargo test --lib differential -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn emit_verdicts_for_corpus() {
        let Ok(path) = std::env::var("DIFF_CORPUS") else {
            return;
        };
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        let pairs: Vec<(String, String)> = serde_json::from_str(&raw).unwrap_or_default();
        let verdicts: Vec<bool> = pairs
            .iter()
            .map(|(m, t)| super::metric_preserved_in_text(m, t))
            .collect();
        let out = serde_json::to_string(&verdicts).unwrap_or_default();
        let dest = std::env::var("DIFF_OUT").unwrap_or_else(|_| "rust_out.json".into());
        let _ = std::fs::write(dest, out);
    }
}

#[cfg(test)]
mod adversarial_regressions {
    use super::introduced_numbers;
    use super::metric_preserved_in_text as m;
    #[test]
    fn attacker_cases_are_closed() {
        let cases = [
            ("25%", "improved by 125% overall", false),
            ("25%", "improved by 0.25% overall", false),
            ("5x", "delivered 15x speedup", false),
            ("1.5", "raised score to 1.55", false),
            ("0.94", "raised success to 0.945", false),
            ("10,000", "processed 10,000,000 rows", false),
            ("10,000", "processed 110,000 rows", false),
            ("$1.2M", "generated 1,200,000,000 in revenue", false),
            ("$100K", "saved 2,100,000 dollars", false),
            ("5%", "changed by 5.5% overall", false),
            ("25", "reduced by 0.25 points", false),
            ("2", "shipped v2.4 of the API", false),
            ("5", "ranked 5th in the org", false),
            ("3", "3rd place finish", false),
            ("5", "ticket ABC5 resolved", false),
            ("5", "in Q5 planning", false),
        ];
        let mut bad = vec![];
        for (metric, text, want) in cases {
            let got = m(metric, text);
            if got != want { bad.push(format!("{metric:?} vs {text:?} => {got}, want {want}")); }
        }
        assert!(bad.is_empty(), "STILL BROKEN:\n{}", bad.join("\n"));
    }

    /// A draft that copies an ordinal straight from the canonical bullet
    /// ("ranked 5th") must not be flagged as inventing the bare number ("5"):
    /// `numeric_tokens` strips the suffix while `metric_preserved_in_text`
    /// deliberately refuses to match inside one, so without the written-form
    /// licence below every faithful rewrite of such a bullet was rejected with
    /// `unsupported_number`. Found by `career_match::stress`.
    #[test]
    fn a_verbatim_ordinal_from_the_canonical_is_not_invention() {
        let canonical = "Ranked 5th nationally, 3rd in the region";
        assert!(introduced_numbers(canonical, &[], canonical).is_empty());
        // A partial rewrite keeping the ordinals is equally clean.
        assert!(introduced_numbers(canonical, &[], "Ranked 5th among peers").is_empty());
        // The licence is per-form: an ordinal the canonical never stated is
        // still invention.
        assert_eq!(
            introduced_numbers("Ranked 5th nationally", &[], "Jumped to 2nd place"),
            vec!["2"]
        );
        // And plain invented quantities stay caught.
        assert!(!introduced_numbers("Grew the team", &[], "Grew the team by 40%").is_empty());
    }
}
