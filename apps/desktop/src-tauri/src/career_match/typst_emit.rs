//! Plain text → Typst, and a complete single-column résumé document.
//!
//! Port of `resume-synthesis/typst-escape.ts` plus a minimal ATS template.
//!
//! ## Why every string becomes a literal
//!
//! The MCP server previously built its Typst by interpolating bullet text
//! straight into markup (`out.push_str(&format!("- {}\n", bullet.canonical))`).
//! In Typst markup `#` opens code mode, so a bullet reading
//! `#set page(width: 100000pt)` was executable input — the exact shape
//! `career_typst::engine`'s `markup_splicing_is_unsafe_which_is_why_we_use_code_mode`
//! test exists to forbid. The sandbox blocked filesystem and network reach, so
//! the blast radius was document corruption and wasted compute rather than
//! exfiltration, but it was still arbitrary evaluation of user- and
//! model-supplied text.
//!
//! Here, every résumé string is emitted as a **Typst string literal**, which is
//! lexically terminated only by an unescaped `"`. Escaping `\` and `"` is
//! therefore complete rather than best-effort: `#`, `*`, `_`, `$`, `@`, `<`,
//! `=`, backtick and `//` carry no meaning inside a literal. Document structure
//! is fixed by this module; model text can only ever land in a value position.
//!
//! ## Deliberate divergence from TypeScript
//!
//! `normalizeTypstPlainText` begins with `String.prototype.normalize("NFC")`.
//! This crate has no Unicode-normalization dependency and adding one is not
//! warranted for the benefit, so the NFC pass is **omitted**. Consequences: a
//! decomposed `e` + combining acute still renders correctly (Typst shapes
//! combining marks), but a decomposed and a precomposed spelling of the same
//! word produce different bytes. That is a fidelity difference, not a safety
//! one — the escape rules below are what make injection impossible, and they
//! are ported completely. Pinned by `unicode_is_preserved_without_nfc`.

use crate::career_db::ExperienceBlock;

use super::language::RewrittenBullet;

/// Hard cap for a single slot's text. Longer input is truncated, never dropped.
pub const MAX_SLOT_CHARS: usize = 4000;

/// Hard cap on rich-text segments per slot (bold parsing fan-out).
pub const MAX_RICH_PARTS: usize = 64;

/// C0 controls and DEL, excluding `\t`, `\n`, `\r` which the line-break pass
/// folds to a space.
fn is_c0_control(c: char) -> bool {
    let u = c as u32;
    (u <= 0x08) || u == 0x0B || u == 0x0C || (0x0E..=0x1F).contains(&u) || u == 0x7F
}

/// Bidi isolates/embeds/overrides and zero-width / soft-hyphen vectors.
fn is_bidi_or_zero_width(c: char) -> bool {
    let u = c as u32;
    (0x200B..=0x200F).contains(&u)
        || (0x202A..=0x202E).contains(&u)
        || (0x2060..=0x2064).contains(&u)
        || (0x2066..=0x2069).contains(&u)
        || u == 0xFEFF
        || u == 0x00AD
}

/// Separators that would otherwise break a single-line literal.
fn is_line_break(c: char) -> bool {
    matches!(c, '\r' | '\n' | '\t' | '\u{0B}' | '\u{0C}' | '\u{2028}' | '\u{2029}')
}

/// Strip controls and fold line breaks to single spaces.
pub fn normalize_plain_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_space = false;
    for c in input.chars() {
        if is_c0_control(c) || is_bidi_or_zero_width(c) {
            continue;
        }
        if is_line_break(c) {
            // The TS regex collapses runs of breaks into one space.
            pending_space = true;
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(c);
    }
    if pending_space {
        out.push(' ');
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
    let mut s: String = chars[..max.saturating_sub(1)].iter().collect();
    s.push('…');
    s
}

/// Escape into the body of a Typst string literal. Backslash first, so the
/// backslashes introduced by the quote rule are not re-escaped.
pub fn escape_string_body(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Full pipeline: plain text → a complete, quoted Typst string literal.
pub fn to_typst_string(input: &str, max: usize) -> String {
    let clean = clamp_slot_text(&normalize_plain_text(input), max);
    format!("\"{}\"", escape_string_body(&clean))
}

/// Verify a rendered literal really is a single closed Typst string.
///
/// Defence in depth: `to_typst_string` is total, so a failure here means a
/// caller hand-built a literal.
pub fn validate_typst_string(literal: &str) -> Result<(), &'static str> {
    let chars: Vec<char> = literal.chars().collect();
    if chars.len() < 2 || chars[0] != '"' || chars[chars.len() - 1] != '"' {
        return Err("not a quoted literal");
    }
    let body = &chars[1..chars.len() - 1];
    let mut backslashes = 0usize;
    for &ch in body {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' && backslashes.is_multiple_of(2) {
            return Err("unescaped quote");
        }
        backslashes = 0;
    }
    if !backslashes.is_multiple_of(2) {
        return Err("trailing escape");
    }
    Ok(())
}

/// Build a validated literal, falling back to a hard-sanitized form.
pub fn typst_string_or_sanitized(input: &str) -> String {
    let primary = to_typst_string(input, MAX_SLOT_CHARS);
    if validate_typst_string(&primary).is_ok() {
        return primary;
    }
    let stripped: String = clamp_slot_text(&normalize_plain_text(input), MAX_SLOT_CHARS)
        .chars()
        .filter(|c| *c != '"' && *c != '\\')
        .collect();
    format!("\"{stripped}\"")
}

/// One run of text with a bold flag, derived from `**markdown**` markers.
pub struct RichPart {
    pub bold: bool,
    pub text: String,
}

/// Split `**bold**` runs out of plain text. Unmatched or empty markers stay
/// literal; never drops characters.
pub fn parse_rich_parts(input: &str) -> Vec<RichPart> {
    let chars: Vec<char> = input.chars().collect();
    let mut parts: Vec<RichPart> = Vec::new();
    let mut last = 0usize;
    let mut i = 0usize;
    while i + 3 < chars.len() {
        if parts.len() >= MAX_RICH_PARTS - 1 {
            break;
        }
        if chars[i] == '*' && chars[i + 1] == '*' {
            // Find the closing `**` with no `*` in between (TS: `[^*]+`).
            let mut j = i + 2;
            let start_inner = j;
            while j < chars.len() && chars[j] != '*' {
                j += 1;
            }
            let has_content = j > start_inner;
            if has_content && j + 1 < chars.len() && chars[j] == '*' && chars[j + 1] == '*' {
                if i > last {
                    parts.push(RichPart {
                        bold: false,
                        text: chars[last..i].iter().collect(),
                    });
                }
                parts.push(RichPart {
                    bold: true,
                    text: chars[start_inner..j].iter().collect(),
                });
                i = j + 2;
                last = i;
                continue;
            }
        }
        i += 1;
    }
    if last < chars.len() {
        parts.push(RichPart {
            bold: false,
            text: chars[last..].iter().collect(),
        });
    }
    if parts.is_empty() {
        parts.push(RichPart { bold: false, text: String::new() });
    }
    parts
}

/// Render plain text as a call to the preamble's `rich` helper.
pub fn to_typst_rich(input: &str) -> String {
    let clamped = clamp_slot_text(&normalize_plain_text(input), MAX_SLOT_CHARS);
    let parts = parse_rich_parts(&clamped);
    let single = parts.len() == 1;
    let rendered: Vec<String> = parts
        .iter()
        .map(|p| {
            format!(
                "({}, {})",
                if p.bold { "true" } else { "false" },
                typst_string_or_sanitized(&p.text)
            )
        })
        .collect();
    // Trailing comma keeps a single-element Typst array from collapsing into a
    // parenthesized group.
    format!(
        "rich(({}{}))",
        rendered.join(", "),
        if single { "," } else { "" }
    )
}

/// Schemes a résumé link may use.
fn is_safe_scheme(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.starts_with("https:") || l.starts_with("http:") || l.starts_with("mailto:") || l.starts_with("tel:")
}

fn has_scheme(s: &str) -> bool {
    match s.find(':') {
        None => false,
        Some(i) => {
            let head = &s[..i];
            !head.is_empty()
                && head.starts_with(|c: char| c.is_ascii_alphabetic())
                && head
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
        }
    }
}

/// Escape a URL for `link("…")`, rejecting schemes that could execute on click.
pub fn to_typst_url(input: &str) -> String {
    let clean = normalize_plain_text(input).trim().to_string();
    if clean.is_empty() {
        return "\"\"".to_string();
    }
    let safe = if !has_scheme(&clean) {
        format!("https://{clean}")
    } else if is_safe_scheme(&clean) {
        clean
    } else {
        // javascript:, data:, file: … → drop entirely rather than emit.
        String::new()
    };
    to_typst_string(&safe, 2048)
}

// --- Document ------------------------------------------------------------

/// Header fields for the rendered résumé.
#[derive(Debug, Clone, Default)]
pub struct HeaderFields {
    pub name: String,
    pub email: String,
    pub phone: String,
    pub location: String,
    pub links: Vec<String>,
}

/// One selected block plus its post-rewrite bullets.
pub struct RenderBlock<'a> {
    pub block: &'a ExperienceBlock,
    pub bullets: &'a [RewrittenBullet],
}

/// Preamble: page setup plus the three helpers every slot flows through.
///
/// `rich` is the only path model text takes into the document.
const PREAMBLE: &str = r#"#set page(paper: "us-letter", margin: 0.55in)
#set text(font: ("Libertinus Serif", "New Computer Modern"), size: 10.5pt)
#set par(justify: false, leading: 0.55em)
#show link: it => underline(it)
#let rich(parts) = parts.map(p => if p.at(0) { strong(p.at(1)) } else { p.at(1) }).join()
#let sect(title) = block(above: 0.85em, below: 0.35em)[
  #text(size: 10.5pt, weight: "bold", tracking: 0.06em)[#upper(title)]
  #v(-0.45em)
  #line(length: 100%, stroke: 0.6pt)
]
#let entry(title, org, dates) = block(above: 0.5em, below: 0.15em)[
  #grid(
    columns: (1fr, auto),
    align: (left, right),
    [#strong(title)#if org != none [ \u{2014} #emph(org)]],
    [#text(size: 9.5pt)[#dates]],
  )
]
"#;

fn format_dates(block: &ExperienceBlock) -> String {
    let start = block.date_range.start.trim();
    match block.date_range.end.as_deref().map(str::trim) {
        Some(end) if !end.is_empty() => format!("{start} – {end}"),
        _ if start.is_empty() => String::new(),
        _ => format!("{start} – Present"),
    }
}

/// Section display order and title.
const SECTION_ORDER: &[(&str, &str)] = &[
    ("experience", "Experience"),
    ("projects", "Projects"),
    ("publications", "Publications"),
    ("education", "Education"),
    ("leadership", "Leadership"),
];

/// Render a complete, compilable résumé document.
///
/// Every caller-supplied string passes through `to_typst_rich` /
/// `to_typst_string` / `to_typst_url`; nothing is interpolated into markup.
pub fn render_resume(
    header: &HeaderFields,
    summary: Option<&str>,
    skills: &[String],
    blocks: &[RenderBlock<'_>],
) -> String {
    let mut out = String::from(PREAMBLE);

    // Header.
    out.push_str("\n#align(center)[\n");
    out.push_str(&format!(
        "  #text(size: 17pt, weight: \"bold\")[#{}]\n",
        to_typst_rich(&header.name)
    ));
    let mut contact: Vec<String> = Vec::new();
    for field in [&header.email, &header.phone, &header.location] {
        if !field.trim().is_empty() {
            contact.push(field.trim().to_string());
        }
    }
    for l in &header.links {
        if !l.trim().is_empty() {
            contact.push(l.trim().to_string());
        }
    }
    if !contact.is_empty() {
        out.push_str("  #v(0.25em)\n");
        out.push_str(&format!(
            "  #text(size: 9.5pt)[#{}]\n",
            to_typst_rich(&contact.join("  ·  "))
        ));
    }
    out.push_str("]\n\n");

    if let Some(s) = summary.map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str("#sect(\"Summary\")\n");
        out.push_str(&format!("#{}\n\n", to_typst_rich(s)));
    }

    if !skills.is_empty() {
        out.push_str("#sect(\"Skills\")\n");
        out.push_str(&format!("#{}\n\n", to_typst_rich(&skills.join(" · "))));
    }

    for (kind_section, title) in SECTION_ORDER {
        let in_section: Vec<&RenderBlock<'_>> = blocks
            .iter()
            .filter(|rb| super::selection::section_for_block(rb.block) == *kind_section)
            .collect();
        if in_section.is_empty() {
            continue;
        }
        out.push_str(&format!("#sect({})\n", to_typst_string(title, 64)));
        for rb in in_section {
            let org = rb.block.org.trim();
            let org_arg = if org.is_empty() {
                "none".to_string()
            } else {
                to_typst_rich(org)
            };
            out.push_str(&format!(
                "#entry({}, {}, {})\n",
                to_typst_rich(&rb.block.title),
                org_arg,
                to_typst_string(&format_dates(rb.block), 64)
            ));
            for b in rb.bullets {
                // `text` is already verified — either the model's accepted
                // rewrite or the canonical fallback.
                out.push_str(&format!("- #{}\n", to_typst_rich(&b.text)));
            }
        }
        out.push('\n');
    }

    out
}
