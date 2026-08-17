//! Metric preservation — the anti-hallucination guarantee.
//!
//! Port of `metricPreservedInText` / `metricsValuesPreserved` from
//! `resume-synthesis/rewrite.ts`. A rewritten bullet is only accepted when
//! every ground-truth metric on the canonical bullet still appears in it.
//!
//! ## Deliberate divergence from TypeScript: no scope expansion
//!
//! The TS implementation short-circuits on `text.includes(v)` for any metric
//! that is not a bare integer, so it reports `"25%"` as preserved inside
//! `"125%"` — an inflated figure passes verification. That is exactly the
//! failure this check exists to catch, so every branch here requires a
//! left boundary (the preceding character must not be a digit, comma, or
//! decimal point).
//!
//! The divergence is one-directional: Rust accepts a strict subset of what TS
//! accepts. A rejected rewrite falls back to the canonical bullet, so being
//! stricter can cost tailoring quality but can never invent a number.
//! Pinned by `rust_is_strictly_stronger_than_ts_on_scope_expansion`.

use crate::career_db::BulletMetric;

/// Characters that, immediately before a number, mean we are looking at part
/// of a larger number rather than the number itself.
fn is_number_context(c: char) -> bool {
    c.is_ascii_digit() || c == ',' || c == '.'
}

/// Byte offsets in `hay` where `needle` occurs with a safe left boundary.
fn occurrences_with_left_boundary(hay: &str, needle: &str) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = hay[from..].find(needle) {
        let at = from + rel;
        let prev_ok = hay[..at].chars().next_back().is_none_or(|c| !is_number_context(c));
        if prev_ok {
            out.push(at);
        }
        // Advance by one char so overlapping matches are still found.
        from = at + hay[at..].chars().next().map_or(1, char::len_utf8);
        if from >= hay.len() {
            break;
        }
    }
    out
}

/// The remainder of `hay` immediately after an occurrence of `needle` at `at`.
fn tail_after<'a>(hay: &'a str, at: usize, needle: &str) -> &'a str {
    &hay[at + needle.len()..]
}

/// True when `tail` begins with optional whitespace then any of `units`,
/// and the unit is not glued to a further word character.
fn tail_has_unit(tail: &str, units: &[&str]) -> bool {
    let rest = tail.trim_start_matches([' ', '\t', '\u{a0}']);
    for u in units {
        if let Some(after) = rest.strip_prefix(*u) {
            // "5x" must not match inside "5xyz".
            let next_ok = after
                .chars()
                .next()
                .is_none_or(|c| !c.is_ascii_alphanumeric());
            if next_ok {
                return true;
            }
        }
    }
    false
}

/// True when the number at `at` is not immediately followed by more digits,
/// a comma-group, or a decimal expansion.
fn right_boundary_ok(tail: &str) -> bool {
    tail.chars().next().is_none_or(|c| !is_number_context(c))
}

/// Does `num` appear in `text` as a standalone number followed by one of
/// `units` (empty `units` means "no unit required")?
fn number_with_unit(text: &str, num: &str, units: &[&str]) -> bool {
    for at in occurrences_with_left_boundary(text, num) {
        let tail = tail_after(text, at, num);
        if units.is_empty() {
            if right_boundary_ok(tail) {
                return true;
            }
        } else if tail_has_unit(tail, units) {
            return true;
        }
    }
    false
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

/// Leading numeric literal of `s` (digits with optional single decimal part).
fn leading_number(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut seen_dot = false;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_ascii_digit() {
            i += 1;
        } else if c == '.' && !seen_dot && i + 1 < bytes.len() && (bytes[i + 1] as char).is_ascii_digit() {
            seen_dot = true;
            i += 1;
        } else {
            break;
        }
    }
    if i == 0 { None } else { Some(&s[..i]) }
}

/// Format an integer with `en-US` thousands separators, matching
/// `Number.prototype.toLocaleString("en-US")` for whole numbers.
fn with_thousands(n: u128) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Is a ground-truth metric preserved in the rewritten text?
///
/// An empty metric is vacuously preserved (nothing to check), matching TS.
pub fn metric_preserved_in_text(metric_value: &str, text: &str) -> bool {
    let v = metric_value.trim();
    if v.is_empty() {
        return true;
    }
    let text_l = text.to_lowercase();
    let v_l = v.to_lowercase();

    // 1. Percentage: "25%" → "25%", "25 percent", "25 pct", "25.0%".
    if let Some(rest) = v_l.strip_suffix('%').map(str::trim_end) {
        if let Some(num) = leading_number(rest) {
            if rest.len() == num.len() {
                const PCT: &[&str] = &["%", "percent", "pct", "percentage"];
                if number_with_unit(&text_l, num, PCT) {
                    return true;
                }
                // "25" also written as "25.0"
                if let Ok(f) = num.parse::<f64>() {
                    let one_dp = format!("{f:.1}");
                    if one_dp != num && number_with_unit(&text_l, &one_dp, PCT) {
                        return true;
                    }
                }
                return false;
            }
        }
    }

    // 2. Multiplier: "5x" → "5x", "5-fold", "5 fold", "5 times".
    if let Some(rest) = v_l.strip_suffix('x').map(str::trim_end) {
        if let Some(num) = leading_number(rest) {
            if rest.len() == num.len() {
                const MULT: &[&str] = &["x", "-fold", "fold", "times", "\u{d7}"];
                return number_with_unit(&text_l, num, MULT);
            }
        }
    }

    // 3. Currency / magnitude: "$1.2M", "$100K", "$5B", "1.2 million".
    if let Some((num, mag)) = parse_currency(&v_l) {
        let Ok(num_val) = num.parse::<f64>() else {
            return false;
        };
        let (units, scale): (&[&str], f64) = match mag.as_deref() {
            Some("m") | Some("million") => (&["m", "million", "mm"], 1e6),
            Some("k") | Some("thousand") => (&["k", "thousand"], 1e3),
            Some("b") | Some("billion") => (&["b", "billion"], 1e9),
            _ => (&[], 1.0),
        };
        if !units.is_empty() {
            if number_with_unit(&text_l, num, units) {
                return true;
            }
            // Same value spelled out in full: "$1.2M" ↔ "1,200,000".
            let full = (num_val * scale).round();
            if full >= 0.0 && full < u128::MAX as f64 {
                let full_u = full as u128;
                if number_with_unit(&text_l, &with_thousands(full_u), &[])
                    || number_with_unit(&text_l, &full_u.to_string(), &[])
                {
                    return true;
                }
            }
            return false;
        }
        // Bare number, possibly with a currency symbol.
        if number_with_unit(&text_l, num, &[]) {
            return true;
        }
    }

    // 4. Comma-formatted number: "10,000" ↔ "10000" ↔ "10k".
    if is_comma_grouped(&v_l) {
        let raw: String = v_l.chars().filter(char::is_ascii_digit).collect();
        if number_with_unit(&text_l, &raw, &[]) || number_with_unit(&text_l, &v_l, &[]) {
            return true;
        }
        if let Ok(n) = raw.parse::<u128>() {
            if n % 1000 == 0 {
                let as_k = format!("{}", n / 1000);
                if number_with_unit(&text_l, &as_k, &["k"]) {
                    return true;
                }
            }
        }
        return false;
    }

    // 5. Bare integer: boundary-checked, plus its English word form.
    if !v_l.is_empty() && v_l.chars().all(|c| c.is_ascii_digit()) {
        if number_with_unit(&text_l, &v_l, &[]) {
            return true;
        }
        if let Some((_, word)) = NUMBER_WORDS.iter().find(|(d, _)| *d == v_l) {
            if word_present(&text_l, word) {
                return true;
            }
        }
        return false;
    }

    // 6. Anything else (e.g. "sub-second", "p99"): require a boundary-safe
    //    literal occurrence rather than a bare substring.
    occurrences_with_left_boundary(&text_l, &v_l)
        .into_iter()
        .any(|at| {
            let tail = tail_after(&text_l, at, &v_l);
            // Only guard the right edge when the metric ends in a digit;
            // "p99" must not match "p999", but "sub-second" may be followed
            // by anything.
            if v_l.chars().next_back().is_some_and(|c| c.is_ascii_digit()) {
                right_boundary_ok(tail)
            } else {
                true
            }
        })
}

fn is_comma_grouped(s: &str) -> bool {
    let parts: Vec<&str> = s.split(',').collect();
    if parts.len() < 2 {
        return false;
    }
    if parts[0].is_empty() || parts[0].len() > 3 || !parts[0].chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    parts[1..]
        .iter()
        .all(|p| p.len() == 3 && p.chars().all(|c| c.is_ascii_digit()))
}

/// Split "$1.2m" / "1.2 million" / "€500k" into (number, magnitude).
fn parse_currency(s: &str) -> Option<(&str, Option<String>)> {
    let t = s
        .trim_start_matches(['$', '€', '£', ' '])
        .trim_start_matches("usd")
        .trim_start();
    let num = leading_number(t)?;
    let rest = t[num.len()..].trim().trim_end_matches("usd").trim();
    if rest.is_empty() {
        return Some((num, None));
    }
    for m in ["million", "thousand", "billion", "mm", "m", "k", "b"] {
        if rest == m {
            return Some((num, Some(m.to_string())));
        }
    }
    None
}

fn word_present(hay: &str, needle: &str) -> bool {
    let h: Vec<char> = hay.chars().collect();
    let n: Vec<char> = needle.chars().collect();
    if n.is_empty() || n.len() > h.len() {
        return false;
    }
    for i in 0..=(h.len() - n.len()) {
        if h[i..i + n.len()] != n[..] {
            continue;
        }
        let lead = i == 0 || !h[i - 1].is_ascii_alphanumeric();
        let end = i + n.len();
        let trail = end == h.len() || !h[end].is_ascii_alphanumeric();
        if lead && trail {
            return true;
        }
    }
    false
}

/// Every metric value must survive. Mirrors `metricsValuesPreserved`.
pub fn metrics_values_preserved(metrics: &[BulletMetric], text: &str) -> bool {
    metrics
        .iter()
        .all(|m| metric_preserved_in_text(&m.value, text))
}

/// Metric values that did NOT survive — for reporting which claim was dropped.
pub fn dropped_metrics(metrics: &[BulletMetric], text: &str) -> Vec<String> {
    metrics
        .iter()
        .filter(|m| !metric_preserved_in_text(&m.value, text))
        .map(|m| m.value.clone())
        .collect()
}

// --- Fabrication detection ----------------------------------------------

/// Numeric tokens in a string: runs of digits, with `.` or `,` kept only when
/// they sit between digits (so "p99." yields "99", "1,200.50" yields one token).
pub fn numeric_tokens(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len()
            && (chars[i].is_ascii_digit()
                || ((chars[i] == '.' || chars[i] == ',')
                    && i + 1 < chars.len()
                    && chars[i + 1].is_ascii_digit()))
        {
            i += 1;
        }
        out.push(chars[start..i].iter().collect());
    }
    out
}

/// Canonical form of a numeric token so `1,200,000`, `1200000` and `1200000.0`
/// all compare equal.
fn canonical_number(token: &str) -> String {
    let stripped: String = token.chars().filter(|c| *c != ',').collect();
    match stripped.parse::<f64>() {
        Ok(n) if n.is_finite() => {
            // Trim trailing zeros and a trailing point without going through
            // scientific notation.
            let mut s = format!("{n:.6}");
            while s.contains('.') && (s.ends_with('0') || s.ends_with('.')) {
                s.pop();
            }
            s
        }
        _ => stripped,
    }
}

/// Every figure a rewrite is permitted to contain: those already in the
/// canonical text, those in a declared metric, and the magnitude expansions of
/// a declared metric (so `$1.2M` may legitimately be written `1,200,000`).
fn allowed_figures(canonical: &str, metrics: &[BulletMetric]) -> Vec<String> {
    let mut allowed: Vec<String> = numeric_tokens(canonical)
        .iter()
        .map(|t| canonical_number(t))
        .collect();
    for m in metrics {
        let v = m.value.trim();
        for t in numeric_tokens(v) {
            allowed.push(canonical_number(&t));
        }
        if let Some((num, Some(mag))) = parse_currency(&v.to_lowercase()) {
            if let Ok(n) = num.parse::<f64>() {
                let scale = match mag.as_str() {
                    "m" | "mm" | "million" => 1e6,
                    "k" | "thousand" => 1e3,
                    "b" | "billion" => 1e9,
                    _ => 1.0,
                };
                allowed.push(canonical_number(&format!("{}", (n * scale).round())));
            }
        }
    }
    allowed
}

/// Figures in `text` that are traceable to neither the canonical bullet nor a
/// declared metric.
///
/// ## Why this exists
///
/// `metrics_values_preserved` only asks whether *known* figures survived. It
/// says nothing about figures that were **added**, so a bullet carrying no
/// recorded metrics passes vacuously and a model may attach any number it
/// likes — "Improved throughput by 999%" against a canonical bullet with no
/// numbers at all. The TypeScript `enforceBulletInvariants` has the same hole.
///
/// Found by `stress::stress_pipeline_over_generated_adversarial_input`, which
/// feeds every bullet through a deliberately dishonest rewriter.
pub fn introduced_figures(
    canonical: &str,
    metrics: &[BulletMetric],
    text: &str,
) -> Vec<String> {
    let allowed = allowed_figures(canonical, metrics);
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for tok in numeric_tokens(text) {
        let c = canonical_number(&tok);
        if allowed.contains(&c) || seen.contains(&c) {
            continue;
        }
        seen.push(c);
        out.push(tok);
    }
    out
}
