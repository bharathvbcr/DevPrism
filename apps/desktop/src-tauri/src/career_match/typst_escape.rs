//! Hardened plain-text to Typst conversion.
//!
//! Faithful Rust port of `src/lib/resume-synthesis/typst-escape.ts`. Read that
//! file's header for the full rationale; the short version is that this module
//! **never emits markup**. Every user- or AI-derived string becomes a Typst
//! *string literal*, which is lexically terminated only by an unescaped `"`.
//! Escaping `\` and `"` is therefore complete rather than best-effort, because
//! Typst's markup specials (`#`, `*`, `_`, backtick, `$`, `@`, `<`, `=`, `-`,
//! `/`, `[`, `]`, `//`) carry no meaning inside a literal.
//!
//! This matters here specifically: the MCP resume renderer it replaces built
//! output with `format!("- {}\n", bullet.canonical)`, splicing unescaped user
//! text straight into Typst markup, where a leading `#` reopens code mode.
//!
//! Order of operations, matching the TypeScript exactly:
//!   1. NFC normalise
//!   2. Strip C0 / DEL / bidi / zero-width controls
//!   3. Fold newlines and tabs to spaces (a literal may not span lines)
//!   4. Clamp length
//!   5. Escape `\` then `"`
//!
//! Step 1 uses `unicode-normalization`, which typst already links transitively,
//! so this matches `String.prototype.normalize("NFC")` in the TypeScript rather
//! than skipping the step. It matters for the clamp: NFC composes "e" plus a
//! combining acute into one scalar, so the two ports count the same number of
//! characters and truncate at the same place.

/// Hard cap for a single slot's text. Longer input is truncated, never dropped.
pub const MAX_SLOT_CHARS: usize = 4000;

/// Hard cap on rich-text segments per slot (bold parsing fan-out).
pub const MAX_RICH_PARTS: usize = 64;

/// C0 controls and DEL: U+0000-0008, U+000B, U+000C, U+000E-001F, U+007F.
///
/// Tab, LF and CR are deliberately absent: they are folded to a space by
/// [`is_line_break`] instead of removed, so words do not get glued together.
fn is_c0_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' | '\u{7F}')
}

/// Bidi isolates/embeds/overrides and zero-width / soft-hyphen injection vectors.
fn is_bidi_or_zero_width(c: char) -> bool {
    matches!(c,
        '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{2069}'
        | '\u{FEFF}'
        | '\u{AD}')
}

/// Line/paragraph separators folded to a single space.
fn is_line_break(c: char) -> bool {
    matches!(c, '\r' | '\n' | '\t' | '\u{B}' | '\u{C}' | '\u{2028}' | '\u{2029}')
}

/// Normalise plain text before it becomes a Typst literal.
///
/// Deliberately does *not* fold smart quotes or dashes to ASCII: Typst is
/// Unicode-native and typesets them correctly.
pub fn normalize_typst_plain_text(input: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let mut out = String::with_capacity(input.len());
    let mut in_break_run = false;
    for c in input.nfc() {
        if is_c0_control(c) || is_bidi_or_zero_width(c) {
            continue;
        }
        if is_line_break(c) {
            // The TS regex is `+`-quantified, so a run collapses to one space.
            if !in_break_run {
                out.push(' ');
                in_break_run = true;
            }
            continue;
        }
        in_break_run = false;
        out.push(c);
    }
    out
}

/// Truncate on a char boundary, appending an ellipsis when cut.
pub fn clamp_slot_text(input: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let chars: Vec<char> = input.chars().collect();
    if chars.len() <= max {
        return input.to_string();
    }
    let mut out: String = chars[..max.saturating_sub(1)].iter().collect();
    out.push('…');
    out
}

/// Escape a normalised string into the *body* of a Typst string literal.
///
/// Backslash is replaced first so the backslashes introduced by the quote rule
/// are not themselves re-escaped.
pub fn escape_typst_string_body(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out
}

/// Full pipeline: plain text to a complete, quoted Typst string literal.
pub fn to_typst_string(input: &str, max: usize) -> String {
    let clean = clamp_slot_text(&normalize_typst_plain_text(input), max);
    format!("\"{}\"", escape_typst_string_body(&clean))
}

/// Result of [`validate_typst_string`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlotValidation {
    Ok,
    Invalid(&'static str),
}

impl SlotValidation {
    pub fn is_ok(&self) -> bool {
        matches!(self, SlotValidation::Ok)
    }
}

/// Verify a rendered literal really is a single closed Typst string.
///
/// Defence in depth: [`to_typst_string`] is total, so a failure here means a
/// caller hand-built a literal. Scans for a `"` preceded by an even number of
/// backslashes (an unescaped terminator) before the end.
pub fn validate_typst_string(literal: &str) -> SlotValidation {
    let chars: Vec<char> = literal.chars().collect();
    if chars.len() < 2 || chars.first() != Some(&'"') || chars.last() != Some(&'"') {
        return SlotValidation::Invalid("not a quoted literal");
    }
    let body = &chars[1..chars.len() - 1];
    let mut backslashes = 0usize;
    for ch in body {
        if *ch == '\\' {
            backslashes += 1;
            continue;
        }
        if *ch == '"' && backslashes % 2 == 0 {
            return SlotValidation::Invalid("unescaped quote");
        }
        backslashes = 0;
    }
    if backslashes % 2 != 0 {
        return SlotValidation::Invalid("trailing escape");
    }
    SlotValidation::Ok
}

/// Build a validated literal, falling back to the canonical text and finally to
/// a hard-sanitised form.
pub fn typst_string_or_canonical(input: &str, canonical_fallback: Option<&str>) -> String {
    let primary = to_typst_string(input, MAX_SLOT_CHARS);
    if validate_typst_string(&primary).is_ok() {
        return primary;
    }
    if let Some(fb) = canonical_fallback {
        if fb != input {
            let fallback = to_typst_string(fb, MAX_SLOT_CHARS);
            if validate_typst_string(&fallback).is_ok() {
                return fallback;
            }
        }
    }
    let source = canonical_fallback.unwrap_or(input);
    let stripped: String = normalize_typst_plain_text(source)
        .chars()
        .filter(|c| *c != '"' && *c != '\\')
        .collect();
    format!("\"{}\"", clamp_slot_text(&stripped, MAX_SLOT_CHARS))
}

/// One run of text with a bold flag, derived from `**markdown**` markers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RichPart {
    pub bold: bool,
    pub text: String,
}

/// Split `**bold**` runs out of plain text.
///
/// Unmatched or empty markers stay literal. Never drops characters: the
/// round-trip `parts.map(text).join("")` equals the input with only its matched
/// `**` pairs removed. Mirrors the JS regex `/\*\*([^*]+)\*\*/g`, whose inner
/// class forbids `*`, so `****` and `** **`-style inputs stay literal.
pub fn parse_rich_parts(input: &str) -> Vec<RichPart> {
    let chars: Vec<char> = input.chars().collect();
    let mut parts: Vec<RichPart> = Vec::new();
    let mut last = 0usize;
    let mut i = 0usize;

    while i + 3 < chars.len() {
        if chars[i] != '*' || chars[i + 1] != '*' {
            i += 1;
            continue;
        }
        // Find the closing `**` with no `*` in between (JS class is [^*]+).
        let content_start = i + 2;
        let mut j = content_start;
        while j < chars.len() && chars[j] != '*' {
            j += 1;
        }
        let matched = j > content_start && j + 1 < chars.len() && chars[j] == '*' && chars[j + 1] == '*';
        if !matched {
            i += 1;
            continue;
        }
        if parts.len() >= MAX_RICH_PARTS - 1 {
            break;
        }
        if i > last {
            parts.push(RichPart { bold: false, text: chars[last..i].iter().collect() });
        }
        parts.push(RichPart { bold: true, text: chars[content_start..j].iter().collect() });
        last = j + 2;
        i = last;
    }

    if last < chars.len() {
        parts.push(RichPart { bold: false, text: chars[last..].iter().collect() });
    }
    if parts.is_empty() {
        parts.push(RichPart { bold: false, text: String::new() });
    }
    parts
}

/// Render plain text as a call to the preamble's `rich` helper:
/// `rich(((false, "a"), (true, "b")))`.
pub fn to_typst_rich(input: &str, canonical_fallback: Option<&str>) -> String {
    let primary = normalize_typst_plain_text(input);
    let source = if !primary.trim().is_empty() || canonical_fallback.is_none() {
        primary
    } else {
        normalize_typst_plain_text(canonical_fallback.unwrap_or(""))
    };

    let clamped = clamp_slot_text(&source, MAX_SLOT_CHARS);
    let parts = parse_rich_parts(&clamped);
    let rendered = parts
        .iter()
        .map(|p| {
            let lit = typst_string_or_canonical(&p.text, None);
            format!("({}, {})", if p.bold { "true" } else { "false" }, lit)
        })
        .collect::<Vec<_>>()
        .join(", ");
    // Trailing comma keeps a single-element Typst array from collapsing to a
    // parenthesised group.
    let tail = if parts.len() == 1 { "," } else { "" };
    format!("rich(({rendered}{tail}))")
}

/// Schemes safe to put behind `link("...")` in a resume.
fn has_safe_scheme(s: &str) -> bool {
    let lower = s.to_lowercase();
    lower.starts_with("https:")
        || lower.starts_with("http:")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:")
}

/// True when the string has no `scheme:` prefix at all, matching the JS
/// `/^[a-z][a-z0-9+.-]*:/i` test.
fn looks_schemeless(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return true,
    }
    for c in chars {
        if c == ':' {
            return false;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
            return true;
        }
    }
    true
}

/// Escape a URL for `link("...")`, rejecting schemes that could execute on click.
pub fn to_typst_url(input: &str) -> String {
    let clean = normalize_typst_plain_text(input).trim().to_string();
    if clean.is_empty() {
        return "\"\"".to_string();
    }
    let safe = if looks_schemeless(&clean) {
        format!("https://{clean}")
    } else if has_safe_scheme(&clean) {
        clean
    } else {
        String::new()
    };
    to_typst_string(&safe, 2048)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The payloads `career_typst::engine`'s own injection test uses, plus the
    /// ones that specifically defeat markup splicing.
    const INJECTION_PAYLOADS: &[&str] = &[
        "#panic(\"pwned\")",
        "\" + panic() + \"",
        "#read(\"/etc/passwd\")",
        "]#panic()[",
        "#{ let x = 1 }",
        "*bold* _italic_ `code`",
        "$ x^2 $",
        "#import \"@preview/evil:0.1.0\"",
        "\\\\\"",
        "\\",
        "\"",
        "#let f() = 1",
        "// comment\n#panic()",
        "<label> @ref",
    ];

    #[test]
    fn every_injection_payload_produces_a_valid_closed_literal() {
        for p in INJECTION_PAYLOADS {
            let lit = to_typst_string(p, MAX_SLOT_CHARS);
            assert!(
                validate_typst_string(&lit).is_ok(),
                "payload {p:?} produced invalid literal {lit:?}"
            );
            // The body must never contain a bare quote that would terminate early.
            let body = &lit[1..lit.len() - 1];
            let mut bs = 0usize;
            for ch in body.chars() {
                if ch == '\\' {
                    bs += 1;
                    continue;
                }
                assert!(!(ch == '"' && bs % 2 == 0), "unescaped quote in {lit:?}");
                bs = 0;
            }
        }
    }

    #[test]
    fn backslash_is_escaped_before_quote() {
        // `\"` must become `\\\"`, not `\\"` (which would close the literal).
        assert_eq!(escape_typst_string_body("\\\""), "\\\\\\\"");
        let lit = to_typst_string("\\\"", MAX_SLOT_CHARS);
        assert!(validate_typst_string(&lit).is_ok());
    }

    #[test]
    fn trailing_backslash_cannot_escape_the_closing_quote() {
        let lit = to_typst_string("ends with backslash \\", MAX_SLOT_CHARS);
        assert!(validate_typst_string(&lit).is_ok());
        assert!(lit.ends_with("\\\\\""));
    }

    #[test]
    fn validate_rejects_hand_built_broken_literals() {
        assert!(!validate_typst_string("\"un\"escaped\"").is_ok());
        assert!(!validate_typst_string("\"trailing\\").is_ok());
        assert!(!validate_typst_string("not quoted").is_ok());
        assert!(!validate_typst_string("\"").is_ok());
        assert!(!validate_typst_string("").is_ok());
        assert!(validate_typst_string("\"\"").is_ok());
        assert!(validate_typst_string("\"ok \\\" ok\"").is_ok());
    }

    #[test]
    fn controls_bidi_and_zero_width_are_stripped() {
        let dirty = "a\u{0}b\u{7F}c\u{200B}d\u{202E}e\u{FEFF}f\u{AD}g";
        assert_eq!(normalize_typst_plain_text(dirty), "abcdefg");
    }

    #[test]
    fn line_breaks_fold_to_a_single_space() {
        assert_eq!(normalize_typst_plain_text("a\r\n\r\nb"), "a b");
        assert_eq!(normalize_typst_plain_text("a\t\tb"), "a b");
        assert_eq!(normalize_typst_plain_text("a\u{2028}\u{2029}b"), "a b");
        // A literal must never span lines.
        assert!(!to_typst_string("a\nb", MAX_SLOT_CHARS).contains('\n'));
    }

    #[test]
    fn clamp_is_char_safe_and_appends_ellipsis() {
        let s = "🚀".repeat(10);
        let out = clamp_slot_text(&s, 4);
        assert_eq!(out.chars().count(), 4);
        assert!(out.ends_with('…'));
        assert_eq!(clamp_slot_text("abc", 0), "");
        assert_eq!(clamp_slot_text("abc", 10), "abc");
    }

    #[test]
    fn oversized_input_is_clamped_not_dropped() {
        let huge = "x".repeat(MAX_SLOT_CHARS * 3);
        let lit = to_typst_string(&huge, MAX_SLOT_CHARS);
        assert!(validate_typst_string(&lit).is_ok());
        // Quotes plus exactly MAX_SLOT_CHARS of body.
        assert_eq!(lit.chars().count(), MAX_SLOT_CHARS + 2);
    }

    #[test]
    fn rich_parts_round_trip_without_dropping_characters() {
        for input in [
            "plain",
            "**bold**",
            "a **b** c",
            "**a** and **b**",
            "unmatched ** marker",
            "****",
            "",
            "**",
        ] {
            let parts = parse_rich_parts(input);
            let joined: String = parts.iter().map(|p| p.text.as_str()).collect();
            let expected = input.replace("**", "");
            // Only *matched* pairs are removed, so joined is between the two.
            assert!(
                joined == input || joined == expected || joined.len() >= expected.len(),
                "input {input:?} joined {joined:?}"
            );
            assert!(!parts.is_empty());
        }
    }

    #[test]
    fn rich_parts_are_capped() {
        let input = "**a** ".repeat(200);
        let parts = parse_rich_parts(&input);
        assert!(parts.len() <= MAX_RICH_PARTS, "got {}", parts.len());
    }

    #[test]
    fn rich_output_is_a_single_call_with_valid_literals() {
        let out = to_typst_rich("shipped **20+ kernels** at #panic()", None);
        assert!(out.starts_with("rich(("));
        assert!(out.ends_with("))"));
        assert!(out.contains("(true, "));
    }

    #[test]
    fn dangerous_url_schemes_are_neutralised() {
        assert_eq!(to_typst_url("javascript:alert(1)"), "\"\"");
        assert_eq!(to_typst_url("file:///etc/passwd"), "\"\"");
        assert_eq!(to_typst_url("data:text/html,<script>"), "\"\"");
        assert_eq!(to_typst_url("https://example.com"), "\"https://example.com\"");
        assert_eq!(to_typst_url("example.com"), "\"https://example.com\"");
        assert_eq!(to_typst_url("mailto:a@b.c"), "\"mailto:a@b.c\"");
        assert_eq!(to_typst_url(""), "\"\"");
        assert_eq!(to_typst_url("   "), "\"\"");
    }

    /// NFC parity with `String.prototype.normalize("NFC")`.
    #[test]
    fn nfc_is_applied() {
        // "e" + combining acute composes to U+00E9, as it does in JS.
        assert_eq!(normalize_typst_plain_text("e\u{301}"), "\u{e9}");
        // Already-composed input is unchanged (idempotent).
        assert_eq!(normalize_typst_plain_text("\u{e9}"), "\u{e9}");
        // Angstrom sign folds to the composed letter, matching JS.
        assert_eq!(normalize_typst_plain_text("\u{212B}"), "\u{c5}");
        // Safety is unaffected: the literal is still valid and closed.
        assert!(validate_typst_string(&to_typst_string("e\u{301}", MAX_SLOT_CHARS)).is_ok());
    }

    /// The clamp counts composed characters, so both ports truncate identically.
    #[test]
    fn nfc_runs_before_the_clamp() {
        // 5 decomposed pairs = 10 scalars raw, 5 after NFC.
        let decomposed = "e\u{301}".repeat(5);
        assert_eq!(normalize_typst_plain_text(&decomposed).chars().count(), 5);
        let lit = to_typst_string(&decomposed, 5);
        assert!(validate_typst_string(&lit).is_ok());
        // No ellipsis: it fits in 5 once composed.
        assert!(!lit.contains('…'), "clamped before composing: {lit}");
    }
}
