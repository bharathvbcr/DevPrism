/** One-click document-class presets for common LaTeX deliverable types. */

import type { SpaceKind } from "@/lib/space-features";

export interface CompileProfile {
  id: string;
  label: string;
  description: string;
  /** Full \\documentclass line (may include optional args). */
  documentclass: string;
  /** Optional lines inserted immediately after \\documentclass when switching. */
  followLines?: string[];
  /** Match if the current \\documentclass line contains any of these (case-insensitive). */
  matchHints: string[];
  /** When set, offered primarily in these space kinds (always includes universal profiles). */
  kinds?: SpaceKind[];
}

export const COMPILE_PROFILES: CompileProfile[] = [
  {
    id: "article",
    label: "Article",
    description: "General-purpose article layout",
    documentclass: "\\documentclass[11pt]{article}",
    matchHints: ["{article}"],
  },
  {
    id: "report",
    label: "Report",
    description: "Chaptered technical report",
    documentclass: "\\documentclass[11pt]{report}",
    matchHints: ["{report}"],
    kinds: ["report", "general"],
  },
  {
    id: "moderncv",
    label: "Modern CV",
    description: "Resume/CV with moderncv",
    documentclass: "\\documentclass[11pt,a4paper,sans]{moderncv}",
    followLines: ["\\moderncvstyle{casual}", "\\moderncvcolor{blue}"],
    matchHints: ["{moderncv}"],
    kinds: ["resume"],
  },
  {
    id: "ieee",
    label: "IEEE",
    description: "IEEE conference paper (IEEEtran)",
    documentclass: "\\documentclass[conference]{IEEEtran}",
    matchHints: ["{ieeetran}"],
    kinds: ["manuscript"],
  },
  {
    id: "statement",
    label: "Statement / SOP",
    description: "Personal statement with readable margins",
    documentclass: "\\documentclass[12pt]{article}",
    followLines: [
      "\\usepackage[margin=1in]{geometry}",
      "\\usepackage{setspace}",
      "\\onehalfspacing",
    ],
    matchHints: ["{article}"],
    kinds: ["statements"],
  },
  {
    id: "letter",
    label: "Letter",
    description: "Formal letter class",
    documentclass: "\\documentclass{letter}",
    matchHints: ["{letter}"],
    kinds: ["resume", "statements"],
  },
];

const DOCUMENTCLASS_RE =
  /^[ \t]*\\documentclass(\[[^\]]*\])?\{[^}]+\}[ \t]*(?:%.*)?$/m;

export function detectCompileProfile(tex: string): string | null {
  const line =
    tex.match(DOCUMENTCLASS_RE)?.[0]?.toLowerCase() ??
    tex
      .split("\n")
      .find((l) => l.trim().startsWith("\\documentclass"))
      ?.toLowerCase();
  if (!line) return null;

  // Statement layout: article + geometry + setspace (before generic article).
  if (
    line.includes("{article}") &&
    /\\usepackage\{setspace\}/.test(tex) &&
    /\\onehalfspacing/.test(tex)
  ) {
    return "statement";
  }

  for (const profile of COMPILE_PROFILES) {
    if (profile.id === "statement") continue;
    if (profile.matchHints.some((hint) => line.includes(hint.toLowerCase()))) {
      return profile.id;
    }
  }
  if (line.includes("{article}")) return "article";
  return null;
}

/** Profiles to show for a space kind — kind-specific presets first, then universal. */
export function compileProfilesForKind(kind: SpaceKind): CompileProfile[] {
  const specific = COMPILE_PROFILES.filter((p) => p.kinds?.includes(kind));
  const universal = COMPILE_PROFILES.filter((p) => !p.kinds);
  const seen = new Set<string>();
  const out: CompileProfile[] = [];
  for (const p of [...specific, ...universal]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out.length > 0 ? out : COMPILE_PROFILES;
}

export function defaultCompileProfileForKind(kind: SpaceKind): string {
  return compileProfilesForKind(kind)[0]?.id ?? "article";
}

export function applyCompileProfile(tex: string, profileId: string): string {
  const profile = COMPILE_PROFILES.find((p) => p.id === profileId);
  if (!profile) return tex;

  let lines = tex.split("\n");
  let dcIndex = lines.findIndex((l) => l.trim().startsWith("\\documentclass"));

  if (profile.id !== "moderncv") {
    lines = lines.filter((l) => !/\\moderncv(style|color)\b/.test(l));
    dcIndex = lines.findIndex((l) => l.trim().startsWith("\\documentclass"));
  }

  if (profile.id === "statement") {
    lines = lines.filter(
      (l) =>
        !/\\usepackage(\[[^\]]*\])?\{setspace\}/.test(l) &&
        !/\\onehalfspacing/.test(l) &&
        !/\\usepackage(\[[^\]]*\])?\{geometry\}/.test(l),
    );
    dcIndex = lines.findIndex((l) => l.trim().startsWith("\\documentclass"));
  }

  if (dcIndex === -1) {
    const prefix = [profile.documentclass, ...(profile.followLines ?? []), ""];
    return [...prefix, tex].join("\n");
  }

  lines[dcIndex] = profile.documentclass;
  if (profile.followLines?.length) {
    const existing = new Set(lines.map((l) => l.trim()));
    const toInsert = profile.followLines.filter((l) => !existing.has(l.trim()));
    lines.splice(dcIndex + 1, 0, ...toInsert);
  }

  return lines.join("\n");
}
