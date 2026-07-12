import {
  escapeAndValidateSlot,
  escapeHrefUrl,
} from "@/lib/resume-synthesis/latex-escape";
import type {
  HeaderFields,
  RenderedBlock,
  RenderResult,
  ResumeContent,
  ResumeTemplate,
  SectionKind,
  SectionSlot,
  SkillGroup,
  SlotLineRange,
} from "./types";

/** Audited preamble from the bundled ATS resume skill template. */
export const ATS_RESUME_PREAMBLE = String.raw`\documentclass[letterpaper,11pt]{article}

% --- Lightweight, common TeX Live packages only ---
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
% Margin lever for fitting to one page: 0.5in (tight) .. 0.85in (roomy)
\usepackage[margin=0.7in]{geometry}
\usepackage{enumitem}
\usepackage{titlesec}
\usepackage{xcolor}
\usepackage[hidelinks]{hyperref}

% --- Look & feel -----------------------------------------------------
\definecolor{rulegray}{gray}{0.55}
\pagestyle{empty}                 % no page numbers (cleaner for ATS)
\setlength{\parindent}{0pt}
\setlength{\tabcolsep}{0pt}

% Section headings: bold, uppercase, with a thin rule underneath.
\titleformat{\section}
  {\large\bfseries}
  {}{0pt}{\MakeUppercase}[\vspace{1pt}{\color{rulegray}\titlerule}\vspace{-2pt}]
\titlespacing{\section}{0pt}{8pt}{4pt}

% Tight bullet list used for experience / projects
\newlist{bullets}{itemize}{1}
\setlist[bullets]{leftmargin=1.4em, topsep=2pt, itemsep=1.5pt,
                  parsep=0pt, label=\textbullet}

% --- Helper macros ---------------------------------------------------
\newcommand{\entry}[4]{%
  \noindent\textbf{#1}\hfill\textbf{#2}\\[1pt]%
  \textit{#3}\hfill\textit{#4}\par\vspace{2pt}%
}
`;

function slot(
  kind: SectionKind,
  render: (blocks: RenderedBlock[]) => string,
): SectionSlot {
  return { kind, render };
}

function esc(text: string, canonical?: string): string {
  return escapeAndValidateSlot(text, canonical ?? text);
}

function renderHref(url: string, label: string): string {
  const safeUrl = escapeHrefUrl(url);
  const safeLabel = esc(label);
  return `\\href{${safeUrl}}{${safeLabel}}`;
}

function renderHeader(header: HeaderFields, slots: SlotLineRange[]): string {
  const lines: string[] = [];
  const pushSlot = (
    slotId: string,
    kind: SectionKind,
    plain: string,
    latexLine: string,
  ) => {
    const start = lines.length + 1;
    lines.push(latexLine);
    slots.push({
      slotId,
      kind,
      startLine: start,
      endLine: lines.length,
      canonical: plain,
      current: plain,
    });
  };

  lines.push("\\begin{center}");
  pushSlot(
    "header:fullName",
    "header",
    header.fullName,
    `  {\\huge\\bfseries ${esc(header.fullName)}}\\\\[4pt]`,
  );

  const contactParts: string[] = [];
  if (header.cityRegion.trim()) {
    contactParts.push(esc(header.cityRegion));
  }
  if (header.email.trim()) {
    contactParts.push(
      `\\href{mailto:${escapeHrefUrl(header.email)}}{${esc(header.email)}}`,
    );
  }
  if (header.phone.trim()) {
    contactParts.push(esc(header.phone));
  }
  if (contactParts.length > 0) {
    const plain = [header.cityRegion, header.email, header.phone]
      .filter((s) => s.trim())
      .join(" · ");
    pushSlot(
      "header:contact",
      "header",
      plain,
      `  ${contactParts.join(" $\\cdot$ ")}\\\\[2pt]`,
    );
  }

  const linkParts: string[] = [];
  if (header.linkedinUrl?.trim()) {
    linkParts.push(
      renderHref(
        header.linkedinUrl,
        header.linkedinLabel?.trim() || header.linkedinUrl,
      ),
    );
  }
  if (header.githubUrl?.trim()) {
    linkParts.push(
      renderHref(
        header.githubUrl,
        header.githubLabel?.trim() || header.githubUrl,
      ),
    );
  }
  if (header.portfolioUrl?.trim()) {
    linkParts.push(
      renderHref(
        header.portfolioUrl,
        header.portfolioLabel?.trim() || header.portfolioUrl,
      ),
    );
  }
  if (linkParts.length > 0) {
    const plain = [
      header.linkedinLabel || header.linkedinUrl,
      header.githubLabel || header.githubUrl,
      header.portfolioLabel || header.portfolioUrl,
    ]
      .filter(Boolean)
      .join(" · ");
    pushSlot(
      "header:links",
      "header",
      plain,
      `  ${linkParts.join(" $\\cdot$ ")}`,
    );
  }

  lines.push("\\end{center}");
  return lines.join("\n");
}

function renderSummary(
  summary: string,
  slots: SlotLineRange[],
  lineOffset: number,
): string {
  const body = esc(summary);
  const start = lineOffset + 1;
  // `summary` here is the current text; caller may pass canonical via content.canonicalSummary
  // — renderSummary only sees the current string, so canonical defaults to current.
  // renderTemplate patches canonical from content after this call when needed.
  slots.push({
    slotId: "summary",
    kind: "summary",
    startLine: start + 1, // after \section
    endLine: start + 1,
    canonical: summary,
    current: summary,
  });
  return `\\section{Summary}\n${body}`;
}

function renderSkills(
  groups: SkillGroup[],
  slots: SlotLineRange[],
  lineOffset: number,
): string {
  const lines: string[] = ["\\section{Skills}"];
  let line = lineOffset + 1;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const latex = `\\textbf{${esc(g.label)}:} ${esc(g.items)}${i < groups.length - 1 ? "\\\\" : ""}`;
    line += 1;
    lines.push(latex);
    slots.push({
      slotId: `skills:${i}`,
      kind: "skills",
      startLine: line,
      endLine: line,
      canonical: `${g.label}: ${g.items}`,
      current: `${g.label}: ${g.items}`,
    });
  }
  return lines.join("\n");
}

function renderEntryBlock(
  block: RenderedBlock,
  kind: SectionKind,
  slots: SlotLineRange[],
  startLine: number,
): { latex: string; endLine: number } {
  const lines: string[] = [];
  let line = startLine;

  const orgField = block.url?.trim()
    ? renderHref(block.url, block.urlLabel?.trim() || block.url)
    : esc(block.org);

  const entryLine = `\\entry{${esc(block.title)}}{${esc(block.dateRange)}}{${orgField}}{${esc(block.location ?? "")}}`;
  line += 1;
  lines.push(entryLine);
  slots.push({
    slotId: `${kind}:${block.id}:entry`,
    kind,
    startLine: line,
    endLine: line,
    canonical: `${block.title} | ${block.dateRange} | ${block.org}`,
    current: `${block.title} | ${block.dateRange} | ${block.org}`,
  });

  if (block.bullets.length > 0) {
    line += 1;
    lines.push("\\begin{bullets}");
    for (let i = 0; i < block.bullets.length; i++) {
      const bullet = block.bullets[i];
      line += 1;
      lines.push(
        `  \\item ${esc(bullet, block.canonicalBullets?.[i] ?? bullet)}`,
      );
      slots.push({
        slotId: `${kind}:${block.id}:bullet:${i}`,
        kind,
        startLine: line,
        endLine: line,
        canonical: block.canonicalBullets?.[i] ?? bullet,
        current: bullet,
      });
    }
    line += 1;
    lines.push("\\end{bullets}");
  }

  if (block.extra?.trim()) {
    const extraCanonical = block.canonicalExtra ?? block.extra;
    line += 1;
    lines.push("\\vspace{1pt}");
    line += 1;
    lines.push(esc(block.extra, extraCanonical));
    slots.push({
      slotId: `${kind}:${block.id}:extra`,
      kind,
      startLine: line,
      endLine: line,
      canonical: extraCanonical,
      current: block.extra,
    });
  }

  line += 1;
  lines.push("\\vspace{4pt}");

  return { latex: lines.join("\n"), endLine: line };
}

function renderBlockSection(
  kind: SectionKind,
  title: string,
  blocks: RenderedBlock[],
  slots: SlotLineRange[],
  lineOffset: number,
): string {
  const parts: string[] = [`\\section{${title}}`, ""];
  let line = lineOffset + 2; // section + blank
  for (const block of blocks) {
    const { latex, endLine } = renderEntryBlock(block, kind, slots, line);
    parts.push(latex);
    line = endLine;
  }
  return parts.join("\n");
}

function experienceSlot(): SectionSlot {
  return slot("experience", (blocks) => {
    // Standalone section renderers are used for budget previews; full docs use renderTemplate.
    const slots: SlotLineRange[] = [];
    return renderBlockSection("experience", "Experience", blocks, slots, 0);
  });
}

function projectsSlot(): SectionSlot {
  return slot("projects", (blocks) => {
    const slots: SlotLineRange[] = [];
    return renderBlockSection("projects", "Projects", blocks, slots, 0);
  });
}

function educationSlot(): SectionSlot {
  return slot("education", (blocks) => {
    const slots: SlotLineRange[] = [];
    return renderBlockSection("education", "Education", blocks, slots, 0);
  });
}

/** ATS-friendly single-column resume (from resume-cv skill template). */
export const ATS_RESUME_TEMPLATE: ResumeTemplate = {
  id: "ats-single-column",
  preamble: ATS_RESUME_PREAMBLE,
  sections: [experienceSlot(), projectsSlot(), educationSlot()],
  budget: {
    totalLines: 55,
    perBullet: 140,
    blocksPerSection: {
      experience: 3,
      projects: 2,
      education: 2,
      skills: 1,
      summary: 1,
    },
  },
};

/** Sidebar kinds for `layout: "two-column"` (narrow left minipage). */
const TWO_COLUMN_LEFT = new Set<SectionKind>([
  "skills",
  "education",
  "leadership",
]);

/** Main column kinds for `layout: "two-column"`. */
const TWO_COLUMN_RIGHT = new Set<SectionKind>([
  "summary",
  "experience",
  "projects",
  "publications",
]);

const DEFAULT_SECTION_ORDER: SectionKind[] = [
  "summary",
  "skills",
  "experience",
  "projects",
  "education",
  "publications",
  "leadership",
];

/**
 * Render ordered body sections into a latex chunk + relative slot ranges.
 * `lineBase` is the 0-based line count before this chunk (for slot offsets).
 * When `kindFilter` is set, only matching kinds are emitted.
 */
function renderBodySections(
  content: ResumeContent,
  order: SectionKind[],
  lineBase: number,
  kindFilter?: Set<SectionKind>,
): { latex: string; slots: SlotLineRange[] } {
  const slots: SlotLineRange[] = [];
  const parts: string[] = [];
  let lineCount = lineBase;

  const append = (chunk: string) => {
    if (!chunk) return;
    parts.push(chunk);
    lineCount += chunk.split("\n").length;
  };

  const allow = (kind: SectionKind) => !kindFilter || kindFilter.has(kind);

  for (const kind of order) {
    if (!allow(kind)) continue;
    switch (kind) {
      case "summary":
        if (content.summary?.trim()) {
          append("");
          const before = slots.length;
          append(renderSummary(content.summary, slots, lineCount));
          if (content.canonicalSummary != null) {
            for (let i = before; i < slots.length; i++) {
              if (slots[i].slotId === "summary") {
                slots[i].canonical = content.canonicalSummary;
              }
            }
          }
        }
        break;
      case "skills":
        if (content.skills && content.skills.length > 0) {
          append("");
          append(renderSkills(content.skills, slots, lineCount));
        }
        break;
      case "experience":
        if (content.experience.length > 0) {
          append("");
          append(
            renderBlockSection(
              "experience",
              "Experience",
              content.experience,
              slots,
              lineCount,
            ),
          );
        }
        break;
      case "projects":
        if (content.projects && content.projects.length > 0) {
          append("");
          append(
            renderBlockSection(
              "projects",
              "Projects",
              content.projects,
              slots,
              lineCount,
            ),
          );
        }
        break;
      case "education":
        if (content.education && content.education.length > 0) {
          append("");
          append(
            renderBlockSection(
              "education",
              "Education",
              content.education,
              slots,
              lineCount,
            ),
          );
        }
        break;
      case "publications":
        if (content.publications && content.publications.length > 0) {
          append("");
          append(
            renderBlockSection(
              "publications",
              "Publications",
              content.publications,
              slots,
              lineCount,
            ),
          );
        }
        break;
      case "leadership":
        if (content.leadership && content.leadership.length > 0) {
          append("");
          append(
            renderBlockSection(
              "leadership",
              "Leadership",
              content.leadership,
              slots,
              lineCount,
            ),
          );
        }
        break;
      default:
        break;
    }
  }

  return { latex: parts.join("\n"), slots };
}

/**
 * Assemble a full `.tex` document from template + content.
 * Every AI-facing string is escaped via `escapeAndValidateSlot`.
 * Records slot → line ranges for the compile-verify repair loop.
 *
 * When `template.layout === "two-column"`, body sections are split into a
 * narrow left minipage (skills / education / leadership) and a main right
 * minipage (summary / experience / projects / publications). Header stays
 * full-width. AI never touches the preamble or minipage scaffolding.
 */
export function renderTemplate(
  template: ResumeTemplate,
  content: ResumeContent,
  sectionOrder?: SectionKind[],
): RenderResult {
  const slots: SlotLineRange[] = [];
  const bodyParts: string[] = [];
  let lineCount = 0;

  const append = (chunk: string) => {
    if (!chunk) return;
    bodyParts.push(chunk);
    lineCount += chunk.split("\n").length;
  };

  append(renderHeader(content.header, slots));

  const order =
    sectionOrder?.filter((k) => k !== "header") ?? DEFAULT_SECTION_ORDER;

  if (template.layout === "two-column") {
    // Full-width header above; columns below. Scaffolding is static (not AI).
    append("");
    const leftOpen = [
      "\\noindent",
      "\\begin{minipage}[t]{0.30\\textwidth}",
      "\\raggedright",
      "\\small",
    ].join("\n");
    append(leftOpen);

    const left = renderBodySections(content, order, lineCount, TWO_COLUMN_LEFT);
    if (left.latex) {
      append(left.latex);
      slots.push(...left.slots);
    } else {
      append("\\vspace{0pt}");
    }

    const mid = [
      "\\end{minipage}%",
      "\\hfill",
      "\\begin{minipage}[t]{0.66\\textwidth}",
    ].join("\n");
    append(mid);

    const right = renderBodySections(
      content,
      order,
      lineCount,
      TWO_COLUMN_RIGHT,
    );
    if (right.latex) {
      append(right.latex);
      slots.push(...right.slots);
    } else {
      append("\\vspace{0pt}");
    }

    append("\\end{minipage}");
  } else {
    const body = renderBodySections(content, order, lineCount);
    if (body.latex) {
      append(body.latex);
      slots.push(...body.slots);
    }
  }

  const prefix = [
    template.preamble.replace(/\s+$/, ""),
    "",
    "\\begin{document}",
    "",
  ].join("\n");
  const bodyOffset = prefix.split("\n").length;
  for (const s of slots) {
    s.startLine += bodyOffset;
    s.endLine += bodyOffset;
  }

  const tex = [prefix, bodyParts.join("\n"), "", "\\end{document}", ""].join(
    "\n",
  );

  return { tex, slots };
}

function blocksForKind(
  content: ResumeContent,
  kind: SectionKind,
): RenderedBlock[] | undefined {
  switch (kind) {
    case "experience":
      return content.experience;
    case "projects":
      return content.projects;
    case "education":
      return content.education;
    case "publications":
      return content.publications;
    case "leadership":
      return content.leadership;
    default:
      return undefined;
  }
}

/**
 * Set a slot's plain-text value on a content tree (mutates a clone).
 * Used by the repair loop when reverting a culprit slot to canonical.
 */
export function setSlotPlainText(
  content: ResumeContent,
  slotId: string,
  plain: string,
): ResumeContent {
  const next = structuredClone(content) as ResumeContent;
  if (slotId === "summary") {
    next.summary = plain;
    return next;
  }
  if (slotId === "header:fullName") {
    next.header.fullName = plain;
    return next;
  }
  if (slotId === "header:contact") {
    // Canonical plain is "city · email · phone" (any subset). Re-parse
    // heuristically so compile-repair can restore the slot.
    const parts = plain
      .split(/\s*[·•|]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    let cityRegion = "";
    let email = "";
    let phone = "";
    for (const p of parts) {
      if (p.includes("@")) email = p;
      else if (/^[\d\s.+()-]+$/.test(p) || /^\+?\d/.test(p.replace(/\s/g, "")))
        phone = p;
      else if (!cityRegion) cityRegion = p;
      else if (!phone) phone = p;
    }
    next.header.cityRegion = cityRegion;
    next.header.email = email;
    next.header.phone = phone;
    return next;
  }
  if (slotId === "header:links") {
    // Canonical plain is "label-or-url · …" for linkedin/github/portfolio.
    // Restore labels (and URLs when a part looks like a URL) in slot order.
    const parts = plain
      .split(/\s*[·•|]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    const slots: Array<{
      urlKey: "linkedinUrl" | "githubUrl" | "portfolioUrl";
      labelKey: "linkedinLabel" | "githubLabel" | "portfolioLabel";
    }> = [
      { urlKey: "linkedinUrl", labelKey: "linkedinLabel" },
      { urlKey: "githubUrl", labelKey: "githubLabel" },
      { urlKey: "portfolioUrl", labelKey: "portfolioLabel" },
    ];
    let i = 0;
    for (const { urlKey, labelKey } of slots) {
      const existing = next.header[urlKey]?.trim();
      if (!existing && i >= parts.length) continue;
      const part = parts[i++];
      if (!part) continue;
      if (
        /^https?:\/\//i.test(part) ||
        /linkedin\.com|github\.com/i.test(part)
      ) {
        next.header[urlKey] = part;
        next.header[labelKey] = undefined;
      } else if (existing) {
        next.header[labelKey] = part;
      } else {
        next.header[urlKey] = part;
      }
    }
    return next;
  }
  const skillMatch = /^skills:(\d+)$/.exec(slotId);
  if (skillMatch && next.skills) {
    const i = Number(skillMatch[1]);
    const colon = plain.indexOf(":");
    if (colon >= 0 && next.skills[i]) {
      next.skills[i] = {
        label: plain.slice(0, colon).trim(),
        items: plain.slice(colon + 1).trim(),
      };
    }
    return next;
  }
  const bulletMatch = /^(\w+):([^:]+):bullet:(\d+)$/.exec(slotId);
  if (bulletMatch) {
    const kind = bulletMatch[1] as SectionKind;
    const blockId = bulletMatch[2];
    const idx = Number(bulletMatch[3]);
    const list = blocksForKind(next, kind);
    const block = list?.find((b) => b.id === blockId);
    if (block && block.bullets[idx] != null) {
      block.bullets[idx] = plain;
    }
    return next;
  }
  const extraMatch = /^(\w+):([^:]+):extra$/.exec(slotId);
  if (extraMatch) {
    const kind = extraMatch[1] as SectionKind;
    const blockId = extraMatch[2];
    const list = blocksForKind(next, kind);
    const block = list?.find((b) => b.id === blockId);
    if (block) block.extra = plain;
    return next;
  }
  return next;
}
