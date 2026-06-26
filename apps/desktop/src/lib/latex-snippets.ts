import type { SpaceKind } from "@/lib/space-features";

export interface LatexSnippet {
  id: string;
  label: string;
  description: string;
  /** LaTeX text inserted at the cursor (selection is preserved inside placeholders). */
  insert: string;
  /** Space kinds where this snippet is surfaced first; empty = always available. */
  kinds?: SpaceKind[];
}

export const LATEX_SNIPPETS: LatexSnippet[] = [
  {
    id: "figure",
    label: "Figure",
    description: "Floating figure with caption",
    insert:
      "\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{figures/}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}\n",
    kinds: ["manuscript", "report", "general"],
  },
  {
    id: "table",
    label: "Table",
    description: "Booktabs table skeleton",
    insert:
      "\\begin{table}[htbp]\n  \\centering\n  \\caption{}\n  \\label{tab:}\n  \\begin{tabular}{lcc}\n    \\toprule\n    Header & A & B \\\\\n    \\midrule\n    Row &  &  \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n",
    kinds: ["manuscript", "report", "general"],
  },
  {
    id: "equation",
    label: "Numbered equation",
    description: "Display math with label",
    insert: "\\begin{equation}\n  \n  \\label{eq:}\n\\end{equation}\n",
    kinds: ["manuscript", "report", "general"],
  },
  {
    id: "abstract",
    label: "Abstract block",
    description: "Abstract environment",
    insert: "\\begin{abstract}\n  \n\\end{abstract}\n",
    kinds: ["manuscript", "report"],
  },
  {
    id: "resume-item",
    label: "Resume bullet",
    description: "Achievement bullet with metrics placeholder",
    insert:
      "\\item Led \\textbf{[project]} resulting in \\textbf{[metric]} improvement.\n",
    kinds: ["resume"],
  },
  {
    id: "resume-entry",
    label: "Experience entry",
    description: "Role heading + bullet list",
    insert:
      "\\textbf{Job Title} \\hfill \\textit{Company} \\hfill \\textit{Date}\\\\\n\\begin{itemize}[leftmargin=*]\n  \\item \n\\end{itemize}\n",
    kinds: ["resume"],
  },
  {
    id: "cover-letter",
    label: "Cover letter",
    description: "Formal letter skeleton (COVER_LETTER.tex)",
    insert:
      "\\documentclass[11pt]{letter}\n\\usepackage[margin=1in]{geometry}\n" +
      "\\signature{Your Name}\n\\address{Your Address \\\\ City, State ZIP}\n\n" +
      "\\begin{document}\n\n\\begin{letter}{Hiring Manager \\\\ Company Name \\\\ Company Address}\n\n" +
      "\\opening{Dear Hiring Manager,}\n\n" +
      "I am writing to express my interest in the \\textbf{[Role Title]} position at \\textbf{[Company]}. " +
      "\\textbf{[One sentence on your strongest relevant achievement.]}\n\n" +
      "\\textbf{[Body paragraph tying your experience to JOB\\_DESCRIPTION.md requirements.]}\n\n" +
      "\\closing{Sincerely,}\n\n\\end{letter}\n\n\\end{document}\n",
    kinds: ["resume"],
  },
  {
    id: "statement-paragraph",
    label: "Statement paragraph",
    description: "Thematic paragraph starter",
    insert:
      "My interest in \\textbf{[field]} began when \\textbf{[specific experience]}. " +
      "This experience shaped my goal to \\textbf{[goal aligned with program]}.\n\n",
    kinds: ["statements"],
  },
  {
    id: "report-section",
    label: "Report section",
    description: "Numbered section with intro sentence",
    insert:
      "\\section{}\n\nThis section covers \\textbf{[topic]} and its implications for \\textbf{[audience]}.\n\n",
    kinds: ["report", "general"],
  },
  {
    id: "executive-summary",
    label: "Executive summary",
    description: "Summary section for reports",
    insert:
      "\\section*{Executive Summary}\n\n" +
      "\\textbf{Purpose:} \\\\\n" +
      "\\textbf{Key findings:} \\\\\n" +
      "\\textbf{Recommendations:} \\\\\n\n",
    kinds: ["report"],
  },
  {
    id: "itemize",
    label: "Bullet list",
    description: "Compact itemize environment",
    insert: "\\begin{itemize}\n  \\item \n\\end{itemize}\n",
  },
  {
    id: "enumerate",
    label: "Numbered list",
    description: "Enumerate environment",
    insert: "\\begin{enumerate}\n  \\item \n\\end{enumerate}\n",
  },
  {
    id: "quote",
    label: "Block quote",
    description: "Quoted passage",
    insert: "\\begin{quote}\n  \n\\end{quote}\n",
    kinds: ["statements", "manuscript", "report"],
  },
];

/** Snippets for a space kind: kind-specific first, then universal. */
export function snippetsForKind(kind: SpaceKind): LatexSnippet[] {
  const specific = LATEX_SNIPPETS.filter((s) => s.kinds?.includes(kind));
  const universal = LATEX_SNIPPETS.filter(
    (s) => !s.kinds || s.kinds.length === 0,
  );
  const seen = new Set<string>();
  const out: LatexSnippet[] = [];
  for (const s of [...specific, ...universal]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** Raw insert text for a snippet id, if defined. */
export function getLatexSnippetInsert(id: string): string | undefined {
  return LATEX_SNIPPETS.find((s) => s.id === id)?.insert;
}
