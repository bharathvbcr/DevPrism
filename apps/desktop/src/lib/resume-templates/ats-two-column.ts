import type { ResumeTemplate, SectionKind, SectionSlot } from "./types";

/**
 * Compact two-column ATS-oriented preamble.
 * Same package set as the single-column template; tighter margins + 10pt
 * for denser packing. Column split is applied at assemble time via minipages
 * (see `renderTemplate` when `layout: "two-column"`).
 */
export const ATS_TWO_COLUMN_PREAMBLE = String.raw`\documentclass[letterpaper,10pt]{article}

% --- Lightweight, common TeX Live packages only ---
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
% Slightly tighter than single-column to fit two columns on one page
\usepackage[margin=0.55in]{geometry}
\usepackage{enumitem}
\usepackage{titlesec}
\usepackage{xcolor}
\usepackage[hidelinks]{hyperref}

% --- Look & feel -----------------------------------------------------
\definecolor{rulegray}{gray}{0.55}
\pagestyle{empty}
\setlength{\parindent}{0pt}
\setlength{\tabcolsep}{0pt}

% Section headings: bold, uppercase, thin rule (works in both columns)
\titleformat{\section}
  {\normalsize\bfseries}
  {}{0pt}{\MakeUppercase}[\vspace{1pt}{\color{rulegray}\titlerule}\vspace{-2pt}]
\titlespacing{\section}{0pt}{6pt}{3pt}

% Tight bullet list
\newlist{bullets}{itemize}{1}
\setlist[bullets]{leftmargin=1.2em, topsep=1pt, itemsep=1pt,
                  parsep=0pt, label=\textbullet}

% --- Helper macros ---------------------------------------------------
\newcommand{\entry}[4]{%
  \noindent\textbf{#1}\hfill\textbf{#2}\\[1pt]%
  \textit{#3}\hfill\textit{#4}\par\vspace{1pt}%
}
`;

function stub(kind: SectionKind): SectionSlot {
  return { kind, render: () => "" };
}

/**
 * Compact two-column resume: full-width header, then sidebar (skills /
 * education / leadership) + main column (summary / experience / projects /
 * publications). Same slot/escape contract as `ats-single-column`.
 */
export const ATS_TWO_COLUMN_TEMPLATE: ResumeTemplate = {
  id: "ats-two-column",
  preamble: ATS_TWO_COLUMN_PREAMBLE,
  layout: "two-column",
  sections: [stub("experience"), stub("projects"), stub("education")],
  budget: {
    // Denser page: more blocks, shorter bullets
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
    },
  },
};
