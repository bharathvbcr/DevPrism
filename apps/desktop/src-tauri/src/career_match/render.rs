//! Minimal, injection-safe Typst rendering for headless MCP synthesis.
//!
//! # Scope, and what owns what
//!
//! The rich, template-driven renderer is TypeScript
//! (`src/lib/resume-templates/typst-ats.ts`) and stays the canonical owner of
//! resume *design*. This module exists only so an agent driving the MCP server
//! headlessly can get a compilable document instead of nothing, and it renders
//! a single plain layout rather than reimplementing the template registry.
//!
//! # The safety contract
//!
//! Every piece of candidate text reaches the document as a **code-mode string
//! literal** passed to a preamble helper, never spliced into markup. This is
//! the contract `career_typst::engine`'s own tests pin
//! (`code_injection_payloads_stay_inert` vs `markup_splicing_is_unsafe_...`):
//! correct escaping alone is not enough, because `#` reopens code mode inside
//! markup. The renderer this replaced did exactly that, with
//! `format!("- {}\n", bullet.canonical)`.
//!
//! Defence in depth: the Typst world used by `compile_resume_pdf` denies all
//! file and package access, and rejects documents over `MAX_PAGES`.

use crate::career_db::ExperienceBlock;

use super::typst_escape::{to_typst_rich, to_typst_string, to_typst_url, validate_typst_string};

/// Preamble defining the helpers every value position flows through.
///
/// `rich` renders `(bold, text)` pairs; `entry` and `sect` take literals only.
pub const PREAMBLE: &str = r#"#set page(paper: "us-letter", margin: 0.6in)
#set text(size: 10pt)
#let rich(parts) = parts.map(p => if p.at(0) { strong(p.at(1)) } else { p.at(1) }).join()
#let sect(title) = [#v(6pt) #strong(upper(title)) #v(2pt) #line(length: 100%) ]
#let entry(title, org, when) = [#strong(title) #h(1fr) #when \ #emph(org) ]
#let entrylink(title, org, when, url, label) = [#strong(title) #h(1fr) #when \ #emph(org) #h(4pt) #link(url)[#label] ]
"#;

/// Render selected blocks into a compilable, injection-safe Typst document.
///
/// `bullet_ids_by_block` optionally restricts which bullets are emitted (the
/// output of `selection::trim_selected_bullets`).
pub fn render_resume(
    header_name: &str,
    contact_lines: &[String],
    blocks: &[ExperienceBlock],
    bullet_ids_by_block: Option<&std::collections::HashMap<String, Vec<String>>>,
) -> String {
    let mut out = String::with_capacity(2048);
    out.push_str(PREAMBLE);

    out.push_str(&format!(
        "#align(center)[#text(size: 16pt)[#strong({})]]\n",
        to_typst_string(header_name, 200)
    ));
    for line in contact_lines.iter().take(4) {
        // `[...]` is markup, so the helper call needs its own `#` to re-enter
        // code mode. Without it Typst parses the raw call as text and an
        // address like "a@b.com" becomes a label reference.
        out.push_str(&format!(
            "#align(center)[#{}]\n",
            to_typst_rich(line, None)
        ));
    }

    // Group by section so headings appear once, in a fixed order.
    for (section, label) in [
        ("experience", "Experience"),
        ("projects", "Projects"),
        ("education", "Education"),
        ("publications", "Publications"),
        ("leadership", "Leadership"),
        ("certifications", "Certifications"),
        ("awards", "Awards"),
        ("volunteer", "Volunteer"),
        ("skills", "Skills"),
    ] {
        let in_section: Vec<&ExperienceBlock> = blocks
            .iter()
            .filter(|b| super::selection::section_for_block(b) == section)
            .collect();
        if in_section.is_empty() {
            continue;
        }
        out.push_str(&format!("#sect({})\n", to_typst_string(label, 64)));

        for b in in_section {
            let when = match (&b.date_range.start, &b.date_range.end) {
                (s, Some(e)) => format!("{s} - {e}"),
                (s, None) => format!("{s} - Present"),
            };
            // A block URL goes through `to_typst_url`, which forces a safe
            // scheme. A rejected scheme (`javascript:`, `file:`) and a URL made
            // only of characters that normalize away both yield the empty
            // literal, and Typst's `link("")` fails the WHOLE document, so an
            // unusable URL must degrade to the plain entry rather than take the
            // resume down with it.
            let safe_url = b
                .url
                .as_deref()
                .filter(|u| !u.trim().is_empty())
                .map(|u| (u, to_typst_url(u)))
                .filter(|(_, lit)| lit != "\"\"");
            match safe_url {
                Some((url, url_lit)) => {
                    let label = b
                        .url_label
                        .as_deref()
                        .filter(|l| !l.trim().is_empty())
                        .unwrap_or(url);
                    out.push_str(&format!(
                        "#entrylink({}, {}, {}, {}, {})\n",
                        to_typst_string(&b.title, 200),
                        to_typst_string(&b.org, 200),
                        to_typst_string(&when, 64),
                        url_lit,
                        to_typst_string(label, 120)
                    ));
                }
                None => {
                    out.push_str(&format!(
                        "#entry({}, {}, {})\n",
                        to_typst_string(&b.title, 200),
                        to_typst_string(&b.org, 200),
                        to_typst_string(&when, 64)
                    ));
                }
            }

            let allowed = bullet_ids_by_block.and_then(|m| m.get(&b.id));
            for bullet in &b.bullets {
                if let Some(ids) = allowed {
                    if !ids.contains(&bullet.id) {
                        continue;
                    }
                }
                if bullet.canonical.trim().is_empty() {
                    continue;
                }
                // The one shape that is safe: a literal in a code-mode argument.
                out.push_str(&format!("- #{}\n", to_typst_rich(&bullet.canonical, None)));
            }
        }
    }

    out
}

/// Assert that a rendered document contains no unbalanced string literal.
///
/// `render_resume` is total, so a failure means a caller hand-built source.
/// Returns the offending literal when one is found.
pub fn audit_rendered_literals(source: &str) -> Option<String> {
    for raw in source.split('\n') {
        let mut rest = raw;
        while let Some(start) = rest.find('"') {
            let after = &rest[start..];
            // Walk to the matching unescaped quote.
            let mut end = None;
            let mut backslashes = 0usize;
            for (i, c) in after.char_indices().skip(1) {
                if c == '\\' {
                    backslashes += 1;
                    continue;
                }
                if c == '"' && backslashes % 2 == 0 {
                    end = Some(i);
                    break;
                }
                backslashes = 0;
            }
            let Some(e) = end else {
                return Some(after.chars().take(80).collect());
            };
            let literal = &after[..=e];
            if !validate_typst_string(literal).is_ok() {
                return Some(literal.to_string());
            }
            rest = &after[e + 1..];
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::career_db::{Bullet, DateRange, ExperienceBlock, SkillTag};
    use crate::career_typst::engine;
    use super::super::typst_escape::MAX_SLOT_CHARS;

    fn block_with(title: &str, org: &str, bullets: &[&str]) -> ExperienceBlock {
        ExperienceBlock {
            id: "b1".into(),
            kind: "experience".into(),
            title: title.into(),
            org: org.into(),
            date_range: DateRange { start: "2023-01".into(), end: None },
            personas: vec![],
            domains: vec![],
            skills: vec![SkillTag { name: "Rust".into(), level: 4, years: None }],
            seniority_level: "senior".into(),
            location: None,
            url: None,
            url_label: None,
            extra: None,
            bullets: bullets
                .iter()
                .enumerate()
                .map(|(i, t)| Bullet {
                    id: format!("x{i}"),
                    canonical: (*t).to_string(),
                    variants: serde_json::Map::new(),
                    metrics: vec![],
                    evidence_refs: vec![],
                    locked: false,
                })
                .collect(),
            facts: vec![],
            notes: None,
            embedding_text: None,
            updated_at: "0".into(),
        }
    }

    /// The payloads that would be catastrophic if they reached code mode.
    const HOSTILE: &[&str] = &[
        "#read(\"/etc/passwd\")",
        "#eval(\"1+1\", mode: \"code\")",
        "#import \"@preview/evil:1.0.0\": *",
        "#include \"/etc/hosts\"",
        "\" + read(\"/etc/passwd\") + \"",
        "#show heading: it => [pwned]",
        "#set page(width: 100000pt)",
        "*/ #read(\"/x\") /*",
        "// comment\n#read(\"/x\")",
        "```typ #read(\"/x\") ```",
        "\\",
        "\"",
        "\\\"",
        "#panic(\"pwned\")",
    ];

    #[test]
    fn renders_a_compilable_document() {
        let b = block_with("Engineer", "Acme", &["Shipped a thing with 25% gain."]);
        let src = render_resume("Jane Doe", &["jane@example.com".into()], &[b], None);
        let r = engine::compile_resume_pdf(&src);
        assert!(r.success, "compile failed: {:?}", r.errors);
        assert!(r.page_count >= 1);
        let pdf = r.pdf_bytes.unwrap_or_default();
        assert!(pdf.starts_with(b"%PDF-"), "not a pdf");
    }

    /// The property that matters: hostile text renders inertly and the
    /// document still compiles to exactly the expected size.
    #[test]
    fn hostile_payloads_stay_inert_in_every_slot() {
        for payload in HOSTILE {
            let b = block_with(payload, payload, &[payload]);
            let src = render_resume(payload, &[(*payload).to_string()], &[b], None);
            assert!(
                audit_rendered_literals(&src).is_none(),
                "unbalanced literal for payload {payload:?}"
            );
            let r = engine::compile_resume_pdf(&src);
            assert!(r.success, "payload {payload:?} broke compile: {:?}", r.errors);
            assert_eq!(r.page_count, 1, "payload {payload:?} changed page count");
        }
    }

    #[test]
    fn a_page_width_attack_cannot_change_the_layout() {
        let b = block_with("t", "o", &["#set page(width: 100000pt)"]);
        let src = render_resume("N", &[], &[b], None);
        let r = engine::compile_resume_pdf(&src);
        assert!(r.success);
        assert_eq!(r.page_count, 1);
    }

    #[test]
    fn bullet_filter_is_respected() {
        let b = block_with("Engineer", "Acme", &["keep me", "drop me"]);
        let mut m = std::collections::HashMap::new();
        m.insert("b1".to_string(), vec!["x0".to_string()]);
        let src = render_resume("N", &[], &[b], Some(&m));
        assert!(src.contains("keep me"));
        assert!(!src.contains("drop me"));
    }

    #[test]
    fn empty_input_still_compiles() {
        let src = render_resume("", &[], &[], None);
        let r = engine::compile_resume_pdf(&src);
        assert!(r.success, "errors: {:?}", r.errors);
    }

    #[test]
    fn oversized_text_is_clamped_and_still_compiles() {
        let huge = "x".repeat(MAX_SLOT_CHARS * 4);
        let b = block_with(&huge, &huge, &[&huge]);
        let src = render_resume(&huge, &[huge.clone()], &[b], None);
        assert!(audit_rendered_literals(&src).is_none());
        let r = engine::compile_resume_pdf(&src);
        assert!(r.success, "errors: {:?}", r.errors);
    }

    #[test]
    fn unicode_and_bidi_survive_without_breaking_the_document() {
        let b = block_with(
            "エンジニア",
            "Acme \u{202E}reversed",
            &["shipped 🚀 with \u{200B}zero-width"],
        );
        let src = render_resume("Ünïcodé", &[], &[b], None);
        assert!(audit_rendered_literals(&src).is_none());
        // Bidi override must have been stripped, not merely escaped.
        assert!(!src.contains('\u{202E}'));
        assert!(!src.contains('\u{200B}'));
        let r = engine::compile_resume_pdf(&src);
        assert!(r.success, "errors: {:?}", r.errors);
    }

    #[test]
    fn audit_catches_a_hand_built_broken_literal() {
        let bad = "#entry(\"un\"escaped\", \"o\", \"w\")\n";
        assert!(audit_rendered_literals(bad).is_some());
    }

    /// Regression: a rejected URL scheme used to emit `link("")`, which fails
    /// the entire document rather than just dropping the link.
    #[test]
    fn an_unusable_url_degrades_instead_of_breaking_the_document() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>",
            "\u{200B}\u{200B}\u{200B}",
            "\u{202E}",
        ] {
            let mut b = block_with("Engineer", "Acme", &["did work"]);
            b.url = Some(url.to_string());
            b.url_label = Some("site".into());
            let src = render_resume("N", &[], &[b], None);
            assert!(!src.contains("#entrylink"), "emitted a link for {url:?}");
            assert!(audit_rendered_literals(&src).is_none());
            let r = engine::compile_resume_pdf(&src);
            assert!(r.success, "url {url:?} broke compile: {:?}", r.errors);
        }
    }

    #[test]
    fn a_safe_url_is_rendered_as_a_link() {
        let mut b = block_with("Engineer", "Acme", &["did work"]);
        b.url = Some("https://example.com".into());
        b.url_label = Some("portfolio".into());
        let src = render_resume("N", &[], &[b], None);
        assert!(src.contains("#entrylink"));
        assert!(src.contains("https://example.com"));
        let r = engine::compile_resume_pdf(&src);
        assert!(r.success, "errors: {:?}", r.errors);
    }

    #[test]
    fn a_schemeless_url_is_upgraded_and_still_compiles() {
        let mut b = block_with("Engineer", "Acme", &["did work"]);
        b.url = Some("example.com/me".into());
        b.url_label = None;
        let src = render_resume("N", &[], &[b], None);
        assert!(src.contains("https://example.com/me"));
        let r = engine::compile_resume_pdf(&src);
        assert!(r.success, "errors: {:?}", r.errors);
    }

    #[test]
    fn a_blank_url_label_falls_back_to_the_url() {
        let mut b = block_with("Engineer", "Acme", &["did work"]);
        b.url = Some("https://example.com".into());
        b.url_label = Some("   ".into());
        let src = render_resume("N", &[], &[b], None);
        let r = engine::compile_resume_pdf(&src);
        assert!(r.success, "errors: {:?}", r.errors);
        assert!(src.contains("https://example.com"));
    }
}
