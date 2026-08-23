/**
 * Typst ATS resume templates.
 *
 * ## The one invariant
 *
 * **Every value derived from AI or user input is emitted as a code-mode
 * argument to a preamble helper — never spliced into markup.**
 *
 * Typst string literals are only string literals in code mode. In markup,
 * `#` still opens code mode, so `- "#read(...)"` would *execute*. The whole
 * document body is therefore wrapped in a single `#{ … }` block and emitted
 * as statements (`bullets((rich(((false, "…"),)),))`), which keeps every
 * literal in a value position where markup specials carry no meaning.
 *
 * Enforced by `assertCodeModeOnly` below and pinned by two Rust tests:
 * `markup_splicing_is_unsafe_which_is_why_we_use_code_mode` (why the contract
 * exists) and `rendered_fixtures_compile` (that this renderer honours it).
 *
 * Consequently a slot value cannot break compilation, so this path needs no
 * bisect/repair loop — unlike `ats-single-column.ts`.
 */

import {
  toTypstRich,
  toTypstString,
  toTypstUrl,
} from "@/lib/resume-synthesis/typst-escape";
import {
  TWO_COLUMN_LEFT_SECTIONS,
  SECTION_DISPLAY,
  resolveSectionOrder,
  type PersonaSectionId,
} from "../resume-sections";
import type {
  HeaderFields,
  RenderedBlock,
  RenderResult,
  ResumeContent,
  ResumeTemplate,
  SectionKind,
  SkillGroup,
  SlotLineRange,
} from "./types";

/**
 * Static scaffolding. Never contains interpolated content — every helper
 * receives its text as a parameter, so this string is a constant.
 */
export const TYPST_ATS_PREAMBLE = `// DevPrism ATS resume — static scaffolding. Never AI-authored.
#let accent = luma(140)

// Renders (bold, text) pairs produced by the escaper's markdown pass.
#let rich(parts) = parts.map(p => if p.at(0) { strong(p.at(1)) } else { p.at(1) }).join()

#let sect(name) = block(above: 9pt, below: 3pt, width: 100%)[
  #text(weight: "bold", size: 1.02em, tracking: 0.4pt)[#upper(name)]
  #v(-5pt)
  #line(length: 100%, stroke: 0.5pt + accent)
]

#let para(body) = block(below: 3pt, width: 100%)[#body]

#let skill-line(label, items) = block(below: 2pt, width: 100%)[
  #strong[#label:] #items
]

// A link that degrades to plain text when no URL is known.
#let maybe-link(url, label) = if url == "" { label } else { link(url)[#label] }

#let dotted(parts) = parts.filter(p => p != none).join([ #sym.dot.c ])

#let doc-header(name, contact, links) = block(width: 100%)[
  #align(center)[
    #text(size: 1.85em, weight: "bold")[#name]
    #if contact.len() > 0 [ #v(3pt) #dotted(contact) ]
    #if links.len() > 0 [ #v(2pt) #dotted(links.map(l => maybe-link(l.at(0), l.at(1)))) ]
  ]
]

#let entry(title, date, org, loc, url) = block(above: 5pt, below: 1pt, width: 100%)[
  #grid(
    columns: (1fr, auto),
    align: (left, right),
    row-gutter: 1pt,
    strong[#title], strong[#date],
    emph[#maybe-link(url, org)], emph[#loc],
  )
]

#let bullets(items) = if items.len() > 0 {
  block(above: 2pt, below: 2pt, width: 100%)[
    #list(indent: 0pt, body-indent: 0.5em, spacing: 3.5pt, ..items)
  ]
}

#let extra(body) = block(above: 1pt, below: 2pt, width: 100%)[#body]

// left/right arrive as content from code blocks, already joined.
#let two-col(left, right) = grid(
  columns: (0.31fr, 0.62fr),
  gutter: 1fr,
  align: (top, top),
  block(width: 100%)[#text(size: 0.94em)[#left]],
  block(width: 100%)[#right],
)
`;

/** Sidebar kinds for the two-column layout. Everything else falls through to the right. */
const TWO_COLUMN_LEFT = TWO_COLUMN_LEFT_SECTIONS;

const SECTION_TITLES: Record<SectionKind, string> = {
  header: "",
  summary: SECTION_DISPLAY.summary,
  skills: SECTION_DISPLAY.skills,
  experience: SECTION_DISPLAY.experience,
  projects: SECTION_DISPLAY.projects,
  education: SECTION_DISPLAY.education,
  publications: SECTION_DISPLAY.publications,
  leadership: SECTION_DISPLAY.leadership,
  certifications: SECTION_DISPLAY.certifications,
  awards: SECTION_DISPLAY.awards,
  volunteer: SECTION_DISPLAY.volunteer,
};

/**
 * Accumulates document lines and the slot ranges that point at them.
 * Line numbers are 1-based within the body and offset once at assembly.
 */
class Body {
  readonly lines: string[] = [];
  readonly slots: SlotLineRange[] = [];

  /** Append a line that carries no editable slot. */
  push(line: string): void {
    this.lines.push(line);
  }

  /** Append a line and record the slot that owns it. */
  pushSlot(
    slotId: string,
    kind: SectionKind,
    line: string,
    canonical: string,
    current: string,
  ): void {
    this.lines.push(line);
    this.slots.push({
      slotId,
      kind,
      startLine: this.lines.length,
      endLine: this.lines.length,
      canonical,
      current,
    });
  }
}

function headerLines(header: HeaderFields, body: Body): void {
  const contact = [header.cityRegion, header.email, header.phone]
    .map((v) => v?.trim() ?? "")
    .filter(Boolean);

  const links: Array<[url: string, label: string]> = [];
  const pushLink = (url?: string, label?: string) => {
    const u = url?.trim();
    if (!u) return;
    links.push([u, label?.trim() || u]);
  };
  pushLink(header.linkedinUrl, header.linkedinLabel);
  pushLink(header.githubUrl, header.githubLabel);
  pushLink(header.portfolioUrl, header.portfolioLabel);

  const contactArg = `(${contact.map((c) => toTypstString(c)).join(", ")}${
    contact.length === 1 ? "," : ""
  })`;
  const linksArg = `(${links
    .map(([u, l]) => `(${toTypstUrl(u)}, ${toTypstString(l)})`)
    .join(", ")}${links.length === 1 ? "," : ""})`;

  body.pushSlot(
    "header:fullName",
    "header",
    `doc-header(${toTypstString(header.fullName)}, ${contactArg}, ${linksArg})`,
    header.fullName,
    header.fullName,
  );
}

function sectionHeading(kind: SectionKind, body: Body): void {
  body.push(`sect(${toTypstString(SECTION_TITLES[kind])})`);
}

function summaryLines(content: ResumeContent, body: Body): void {
  const text = content.summary?.trim();
  if (!text) return;
  sectionHeading("summary", body);
  body.pushSlot(
    "summary",
    "summary",
    `para(${toTypstRich(text, content.canonicalSummary)})`,
    content.canonicalSummary ?? text,
    text,
  );
}

function skillsLines(groups: SkillGroup[], body: Body): void {
  if (groups.length === 0) return;
  sectionHeading("skills", body);
  groups.forEach((g, i) => {
    body.pushSlot(
      `skills:${i}`,
      "skills",
      `skill-line(${toTypstString(g.label)}, ${toTypstString(g.items)})`,
      `${g.label}: ${g.items}`,
      `${g.label}: ${g.items}`,
    );
  });
}

function blockLines(block: RenderedBlock, kind: SectionKind, body: Body): void {
  const entryCanonical = `${block.title} | ${block.dateRange} | ${block.org}`;
  body.pushSlot(
    `${kind}:${block.id}:entry`,
    kind,
    `entry(${toTypstString(block.title)}, ${toTypstString(block.dateRange)}, ` +
      `${toTypstString(block.org)}, ${toTypstString(block.location ?? "")}, ` +
      `${toTypstUrl(block.url ?? "")})`,
    entryCanonical,
    entryCanonical,
  );

  if (block.bullets.length > 0) {
    body.push("bullets((");
    block.bullets.forEach((bullet, i) => {
      const canonical = block.canonicalBullets?.[i] ?? bullet;
      body.pushSlot(
        `${kind}:${block.id}:bullet:${i}`,
        kind,
        `  ${toTypstRich(bullet, canonical)},`,
        canonical,
        bullet,
      );
    });
    body.push("))");
  }

  const extraText = block.extra?.trim();
  if (extraText) {
    const canonical = block.canonicalExtra ?? extraText;
    body.pushSlot(
      `${kind}:${block.id}:extra`,
      kind,
      `extra(${toTypstRich(extraText, canonical)})`,
      canonical,
      extraText,
    );
  }
}

function blocksForKind(
  content: ResumeContent,
  kind: SectionKind,
): RenderedBlock[] {
  switch (kind) {
    case "experience":
      return content.experience ?? [];
    case "projects":
      return content.projects ?? [];
    case "education":
      return content.education ?? [];
    case "publications":
      return content.publications ?? [];
    case "leadership":
      return content.leadership ?? [];
    case "certifications":
      return content.certifications ?? [];
    case "awards":
      return content.awards ?? [];
    case "volunteer":
      return content.volunteer ?? [];
    default:
      return [];
  }
}

function sectionHasContent(
  content: ResumeContent,
  kind: PersonaSectionId,
): boolean {
  if (kind === "summary") return Boolean(content.summary?.trim());
  if (kind === "skills") return (content.skills?.length ?? 0) > 0;
  return blocksForKind(content, kind).length > 0;
}

/** Emit one section's lines into `body`. Returns whether anything was written. */
function sectionLines(
  content: ResumeContent,
  kind: SectionKind,
  body: Body,
): void {
  if (kind === "summary") {
    summaryLines(content, body);
    return;
  }
  if (kind === "skills") {
    skillsLines(content.skills ?? [], body);
    return;
  }
  const blocks = blocksForKind(content, kind);
  if (blocks.length === 0) return;
  sectionHeading(kind, body);
  for (const block of blocks) {
    blockLines(block, kind, body);
  }
}

/**
 * Extract the statements inside the document's `#{ … }` body block.
 *
 * The preamble legitimately uses `#let`; only the body is pure code mode, so
 * callers validating the invariant must look at the body alone.
 */
export function typstBodyLines(source: string): string[] {
  const lines = source.split("\n");
  const open = lines.indexOf("#{");
  if (open === -1) return [];
  let close = lines.length - 1;
  while (close > open && lines[close].trim() !== "}") close -= 1;
  return lines.slice(open + 1, close);
}

/**
 * Verify every body line is a statement inside the document's code block.
 *
 * The body is wrapped in a single `#{ … }`, so it is code mode throughout and
 * a leading `#` is a syntax error ("you are already in code mode") — the exact
 * defect the cross-language fixture test caught in the two-column layout. It
 * would also mean the line escaped to markup, where a string literal stops
 * being inert.
 */
export function assertCodeModeOnly(lines: string[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) {
      throw new Error(
        `Typst render emitted a markup-mode line inside the document code ` +
          `block (line ${i + 1}): ${line.slice(0, 120)}`,
      );
    }
  }
}

/**
 * Assemble a full `.typ` document from template + content.
 * Records slot → line ranges so diagnostics and the UI can point at content.
 */
export function renderTypstTemplate(
  template: ResumeTemplate,
  content: ResumeContent,
  sectionOrder?: SectionKind[],
): RenderResult {
  const order = resolveSectionOrder(sectionOrder, (id) =>
    sectionHasContent(content, id),
  );

  const body = new Body();
  headerLines(content.header, body);

  if (template.layout === "two-column") {
    // Each column is its own code block, so its statements join to content
    // while every literal stays in a code-mode value position.
    body.push("two-col({");
    for (const kind of order) {
      if (TWO_COLUMN_LEFT.has(kind)) sectionLines(content, kind, body);
    }
    body.push("}, {");
    for (const kind of order) {
      if (!TWO_COLUMN_LEFT.has(kind)) sectionLines(content, kind, body);
    }
    body.push("})");
  } else {
    for (const kind of order) {
      sectionLines(content, kind, body);
    }
  }

  assertCodeModeOnly(body.lines);

  const fontStack = template.fontStack ?? ["Libertinus Serif"];
  const setup = [
    TYPST_ATS_PREAMBLE.replace(/\s+$/, ""),
    "",
    `#set document(title: ${toTypstString(
      `${content.header.fullName} — Resume`,
    )}, author: ${toTypstString(content.header.fullName)})`,
    `#set page(paper: "us-letter", margin: ${template.pageMargin ?? "0.7in"})`,
    `#set text(font: (${fontStack
      .map((f) => toTypstString(f))
      .join(", ")}), size: ${template.baseFontSize ?? "11pt"}, lang: "en")`,
    "#set par(justify: false, leading: 0.58em, spacing: 0.62em)",
    "#show link: set text(fill: black)",
    "",
    // One code block for the whole body: every statement below is code mode,
    // so no user literal is ever adjacent to markup.
    "#{",
  ];

  // Count *lines*, not array entries — the preamble is a single entry
  // spanning many lines, so `setup.length` would undercount the offset.
  const setupText = setup.join("\n");
  const offset = setupText.split("\n").length;
  for (const s of body.slots) {
    s.startLine += offset;
    s.endLine += offset;
  }

  const source = [setupText, ...body.lines, "}", ""].join("\n");
  return { source, slots: body.slots };
}

/** ATS-friendly single-column resume rendered by the in-process Typst engine. */
export const TYPST_ATS_SINGLE_TEMPLATE: ResumeTemplate = {
  id: "typst-ats-single-column",
  engine: "typst",
  preamble: TYPST_ATS_PREAMBLE,
  sections: [],
  fontStack: ["Libertinus Serif"],
  pageMargin: "0.7in",
  baseFontSize: "11pt",
  render: (content, order) =>
    renderTypstTemplate(TYPST_ATS_SINGLE_TEMPLATE, content, order),
  budget: {
    totalLines: 55,
    perBullet: 140,
    blocksPerSection: {
      experience: 3,
      projects: 2,
      education: 2,
      skills: 1,
      summary: 1,
      publications: 2,
      leadership: 1,
      certifications: 2,
      awards: 2,
      volunteer: 1,
    },
  },
};

/** Compact two-column variant: sidebar for skills/education/leadership. */
export const TYPST_ATS_TWO_COLUMN_TEMPLATE: ResumeTemplate = {
  id: "typst-ats-two-column",
  engine: "typst",
  preamble: TYPST_ATS_PREAMBLE,
  sections: [],
  layout: "two-column",
  fontStack: ["Libertinus Serif"],
  pageMargin: "0.55in",
  baseFontSize: "10pt",
  render: (content, order) =>
    renderTypstTemplate(TYPST_ATS_TWO_COLUMN_TEMPLATE, content, order),
  budget: {
    totalLines: 48,
    perBullet: 120,
    blocksPerSection: {
      experience: 4,
      projects: 2,
      education: 2,
      skills: 1,
      summary: 1,
      leadership: 1,
      publications: 2,
      certifications: 2,
      awards: 2,
      volunteer: 1,
    },
  },
};
