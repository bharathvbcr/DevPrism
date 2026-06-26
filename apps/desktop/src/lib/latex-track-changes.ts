import { lineDiff, type DiffLine } from "@/lib/line-diff";
import { wordDiff } from "@/lib/word-diff";

export type TrackChangesGranularity = "line" | "word";

/** Shared preamble injected into documents that render tracked changes. */
export const TRACK_CHANGES_PREAMBLE = `% DevPrism tracked changes
\\usepackage[normalem]{ulem}
\\usepackage{xcolor}
\\definecolor{trackdel}{RGB}{180,0,0}
\\definecolor{trackadd}{RGB}{0,110,0}
`;

const ULEM_LOADED_RE =
  /\\(usepackage|RequirePackage)(\[[^\]]*\])?\{[^}]*\bulem\b[^}]*\}/;
const COLOR_LOADED_RE =
  /\\(usepackage|RequirePackage)(\[[^\]]*\])?\{[^}]*\b(xcolor|color)\b[^}]*\}/;

/** Remove TeX comments (unescaped % to end of line) so commented-out package
 * loads aren't mistaken for real ones. */
function stripTexComments(tex: string): string {
  return tex.replace(/(?<!\\)%.*$/gm, "");
}

/**
 * Track-changes preamble additions safe to append AFTER a document's own,
 * verbatim preamble: skip ulem/xcolor if the document ACTUALLY loads them (not
 * a commented-out line) so a second `\usepackage[normalem]{ulem}` doesn't raise
 * an option clash, while a commented `% \usepackage{ulem}` doesn't suppress the
 * real load. \definecolor is idempotent, so the track colors are always
 * (re)declared.
 */
function trackChangesPreambleAdditions(existingPreamble: string): string {
  const code = stripTexComments(existingPreamble);
  const lines = ["% DevPrism tracked changes"];
  if (!ULEM_LOADED_RE.test(code)) {
    lines.push("\\usepackage[normalem]{ulem}");
  }
  if (!COLOR_LOADED_RE.test(code)) {
    lines.push("\\usepackage{xcolor}");
  }
  lines.push("\\definecolor{trackdel}{RGB}{180,0,0}");
  lines.push("\\definecolor{trackadd}{RGB}{0,110,0}");
  return `${lines.join("\n")}\n`;
}

export interface TrackChangesMeta {
  fromLabel: string;
  toLabel: string;
}

export interface TexFileDiff {
  filePath: string;
  status: "added" | "modified" | "deleted";
  oldContent: string | null;
  newContent: string | null;
}

/** Wrap a deleted line: red + strikethrough in PDF. */
export function wrapDeletedLine(line: string): string {
  if (!line) return "\\textcolor{trackdel}{\\sout{~}}";
  return `\\textcolor{trackdel}{\\sout{${line}}}`;
}

/** Wrap an added line: green in PDF. */
export function wrapAddedLine(line: string): string {
  if (!line) return "\\textcolor{trackadd}{~}";
  return `\\textcolor{trackadd}{${line}}`;
}

/** Wrap a deleted word/token: red + strikethrough. */
export function wrapDeletedPart(text: string): string {
  if (!text) return "";
  return `\\textcolor{trackdel}{\\sout{${text}}}`;
}

/** Wrap an added word/token: green. */
export function wrapAddedPart(text: string): string {
  if (!text) return "";
  return `\\textcolor{trackadd}{${text}}`;
}

// LaTeX special characters that make a span unsafe to place inside
// \textcolor{}/\sout{}: backslash and braces (commands/groups), $ (math),
// and the text-mode actives & # % ^ _ ~. Wrapping any of these can split a
// command, unbalance braces, comment out the closing brace (%), or break out of
// the wrapper — so content containing them is emitted verbatim instead of
// marked. The built-in generator is a safe-but-approximate fallback; install
// latexdiff for full-fidelity markup of command/math/table edits.
const LATEX_SPECIAL_RE = /[\\{}$&#%^_~]/;

/** True when `text` is plain enough to wrap in \textcolor/\sout safely. */
export function isPlainLatexText(text: string): boolean {
  return !LATEX_SPECIAL_RE.test(text);
}

/** A deleted line, safely: struck through if plain, else preserved as a LaTeX
 * comment (so it never breaks compilation but the removal is still visible in
 * the source). */
function safeDeletedLine(line: string): string {
  if (isPlainLatexText(line)) return wrapDeletedLine(line);
  return `% [deleted] ${line}`;
}

/** An added line, safely: colored if plain, else emitted verbatim so any
 * commands/math render correctly (just without the add color). */
function safeAddedLine(line: string): string {
  if (isPlainLatexText(line)) return wrapAddedLine(line);
  return line;
}

/** Inline word-level markup for a single edited line pair. Per-word wrapping is
 * only safe when BOTH sides are plain text; otherwise the new line is emitted
 * verbatim (compiles and shows current content) rather than risking a split
 * command or unbalanced brace. */
export function applyWordTrackChangesLine(
  oldLine: string,
  newLine: string,
): string {
  if (!isPlainLatexText(oldLine) || !isPlainLatexText(newLine)) {
    return newLine;
  }
  return wordDiff(oldLine, newLine)
    .map((part) => {
      if (part.type === "context") return part.text;
      if (part.type === "del") return wrapDeletedPart(part.text);
      return wrapAddedPart(part.text);
    })
    .join("");
}

/** Mark one deleted/added line pair. When both sides are plain text, produce a
 * single inline word-diffed line; otherwise fall back to the safe line pair
 * (struck/commented deletion + added line) so the removal is never silently
 * dropped — matching the line-mode and deleted-file paths. */
function markChangedPair(del: string, add: string): string[] {
  if (isPlainLatexText(del) && isPlainLatexText(add)) {
    return [applyWordTrackChangesLine(del, add)];
  }
  return [safeDeletedLine(del), safeAddedLine(add)];
}

function mergeChangedLines(
  dels: string[],
  adds: string[],
  granularity: TrackChangesGranularity,
): string[] {
  if (granularity === "line" || dels.length !== adds.length) {
    return [
      ...dels.map((line) => safeDeletedLine(line)),
      ...adds.map((line) => safeAddedLine(line)),
    ];
  }
  return dels.flatMap((del, idx) => markChangedPair(del, adds[idx]));
}

function applyLineDiffMarkup(
  lines: DiffLine[],
  granularity: TrackChangesGranularity,
): string {
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "context") {
      result.push(line.text);
      i++;
      continue;
    }

    const dels: string[] = [];
    const adds: string[] = [];
    while (i < lines.length && lines[i].type === "del") {
      dels.push(lines[i].text);
      i++;
    }
    while (i < lines.length && lines[i].type === "add") {
      adds.push(lines[i].text);
      i++;
    }

    if (dels.length > 0 || adds.length > 0) {
      result.push(...mergeChangedLines(dels, adds, granularity));
      continue;
    }

    if (line.type === "add") {
      result.push(safeAddedLine(line.text));
    } else {
      result.push(safeDeletedLine(line.text));
    }
    i++;
  }
  return result.join("\n");
}

/**
 * Build a review-oriented .tex body where deletions are struck through and
 * additions are colored. Context lines are left unchanged.
 */
export function applyTrackChangesMarkup(
  oldText: string,
  newText: string,
  granularity: TrackChangesGranularity = "word",
): string {
  return applyLineDiffMarkup(lineDiff(oldText, newText), granularity);
}

/** Insert track-change packages after \\documentclass when missing. */
export function injectTrackChangesPackages(tex: string): string {
  if (
    tex.includes("\\usepackage") &&
    tex.includes("ulem") &&
    tex.includes("trackdel")
  ) {
    return tex;
  }

  const docClass = tex.match(/\\documentclass[^\n]*\n/);
  if (docClass && docClass.index != null) {
    const insertAt = docClass.index + docClass[0].length;
    return (
      tex.slice(0, insertAt) + TRACK_CHANGES_PREAMBLE + tex.slice(insertAt)
    );
  }

  return TRACK_CHANGES_PREAMBLE + tex;
}

function isStandaloneDocument(tex: string): boolean {
  return /\\documentclass[\s{[]/.test(tex);
}

const BEGIN_DOC_RE = /\\begin\{document\}/;
const END_DOC_RE = /\\end\{document\}/;

/**
 * Extract just the document body (between \begin{document} and \end{document}).
 * Returns the whole input for fragments that have no \begin{document}. Marking
 * only the body keeps preamble lines (\usepackage, \definecolor, …) from being
 * wrapped in \textcolor/\sout, which would otherwise break compilation when the
 * preamble itself changed between versions.
 */
function extractBody(tex: string): string {
  const begin = BEGIN_DOC_RE.exec(tex);
  if (!begin) return tex;
  const afterBegin = begin.index + begin[0].length;
  const end = END_DOC_RE.exec(tex.slice(afterBegin));
  return tex.slice(afterBegin, end ? afterBegin + end.index : undefined);
}

/** Everything before \begin{document}; null for a fragment. */
function extractPreamble(tex: string): string | null {
  const begin = BEGIN_DOC_RE.exec(tex);
  return begin ? tex.slice(0, begin.index) : null;
}

/**
 * Marked-up document BODY (no preamble, no \begin{document}) for one file diff.
 * Safe to embed inside another document (e.g. the multi-file report) and the
 * basis for the standalone tracked file below.
 */
export function buildTrackedFragment(
  diff: TexFileDiff,
  granularity: TrackChangesGranularity = "word",
): string {
  const oldBody = extractBody(diff.oldContent ?? "");
  const newBody = extractBody(diff.newContent ?? "");

  if (diff.status === "added") {
    return applyLineDiffMarkup(lineDiff("", newBody), granularity);
  }
  if (diff.status === "deleted") {
    return applyLineDiffMarkup(lineDiff(oldBody, ""), granularity);
  }
  return applyTrackChangesMarkup(oldBody, newBody, granularity);
}

/**
 * Produce a shareable tracked .tex for one file. Standalone documents are
 * rebuilt as: the new version's verbatim preamble (untouched, so it always
 * compiles) + the track-changes packages + the marked-up body. Fragments are
 * returned as marked-up body text.
 */
export function buildTrackedTexFile(
  diff: TexFileDiff,
  granularity: TrackChangesGranularity = "word",
): string {
  const body = buildTrackedFragment(diff, granularity);
  const reference = diff.newContent ?? diff.oldContent ?? "";
  if (isStandaloneDocument(reference)) {
    const preamble = extractPreamble(reference) ?? "\\documentclass{article}\n";
    return `${preamble}${trackChangesPreambleAdditions(preamble)}\\begin{document}\n${body}\n\\end{document}\n`;
  }
  return body;
}

// Preamble lines worth carrying into the shared report so body macros resolve.
const PREAMBLE_MACRO_RE =
  /^\s*\\(usepackage|RequirePackage|newcommand|renewcommand|providecommand|def|DeclareMathOperator\*?|definecolor|newenvironment|newtheorem)\b/;
// Packages the report already loads — re-loading risks an option clash.
const REPORT_OWNED_PACKAGE_RE =
  /\\(usepackage|RequirePackage)(\[[^\]]*\])?\{[^}]*\b(xcolor|color|ulem|parskip)\b[^}]*\}/;

/**
 * The macro/environment name a preamble line defines, for name-level dedup: two
 * files defining the same name with DIFFERENT bodies must not both be emitted
 * (\newcommand twice → "Command already defined"). Returns null for lines that
 * don't bind a name (e.g. \usepackage), which fall back to whole-line dedup.
 */
function definedName(line: string): string | null {
  const cmd =
    line.match(/\\(?:new|renew|provide)command\*?\s*\{?\s*\\([A-Za-z@]+)/) ??
    line.match(/\\def\s*\\([A-Za-z@]+)/) ??
    line.match(/\\DeclareMathOperator\*?\s*\{?\s*\\([A-Za-z@]+)/);
  if (cmd) return `cmd:\\${cmd[1]}`;
  const env = line.match(/\\(?:newenvironment|newtheorem)\s*\{([^}]+)\}/);
  if (env) return `env:${env[1]}`;
  return null;
}

/**
 * Collect single-line \usepackage/\newcommand/\def-style declarations from each
 * compared file's own preamble (which extractBody discards), de-duplicated, so a
 * body that uses a file-local macro doesn't hit "Undefined control sequence" in
 * the shared report. De-dup is by defined NAME (first definition wins) so two
 * files defining the same macro with different bodies don't double-define it.
 * Best-effort: multi-line macro definitions are not merged.
 */
function collectSharedPreamble(diffs: TexFileDiff[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const d of diffs) {
    const preamble = extractPreamble(d.newContent ?? d.oldContent ?? "");
    if (!preamble) continue;
    for (const raw of preamble.split("\n")) {
      const line = raw.trimEnd();
      if (!PREAMBLE_MACRO_RE.test(line)) continue;
      if (REPORT_OWNED_PACKAGE_RE.test(line)) continue;
      const key = definedName(line) ?? `line:${line.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  return lines.length
    ? `% Macros carried over from the compared files\n${lines.join("\n")}\n`
    : "";
}

/** Multi-file report suitable for sharing or PDF preview. */
export function buildTrackChangesReport(
  diffs: TexFileDiff[],
  meta: TrackChangesMeta,
  granularity: TrackChangesGranularity = "word",
): string {
  const texDiffs = diffs.filter((d) =>
    d.filePath.toLowerCase().endsWith(".tex"),
  );
  const sharedPreamble = collectSharedPreamble(texDiffs);
  const sections = texDiffs.map((d) => {
    const statusLabel =
      d.status === "added"
        ? "added"
        : d.status === "deleted"
          ? "deleted"
          : "modified";
    const tracked = buildTrackedFragment(d, granularity);
    return `\\subsection*{${escapeLatexText(d.filePath)} (${statusLabel})}
\\small
${tracked}
`;
  });

  const safeFrom = escapeLatexText(meta.fromLabel);
  const safeTo = escapeLatexText(meta.toLabel);

  return `\\documentclass{article}
${TRACK_CHANGES_PREAMBLE}
\\usepackage{parskip}
${sharedPreamble}\\title{Tracked Changes}
\\date{\\today}
\\begin{document}
\\maketitle
\\noindent Comparing \\textbf{${safeFrom}} to \\textbf{${safeTo}}.

${sections.join("\n")}
\\end{document}
`;
}

function escapeLatexText(text: string): string {
  // Escape braces/specials FIRST, then backslash via a placeholder, so the
  // braces in \textbackslash{} aren't themselves re-escaped (which turned a
  // backslash into the literal text "\{}"). Order matters.
  const PLACEHOLDER = " BSLASH ";
  return text
    .replace(/\\/g, PLACEHOLDER)
    .replace(/([%$&#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(new RegExp(PLACEHOLDER, "g"), "\\textbackslash{}");
}

/** Pick the best compile target among changed standalone .tex roots. */
export function pickTrackedCompileTarget(
  diffs: TexFileDiff[],
): TexFileDiff | null {
  const candidates = diffs.filter(
    (d) =>
      d.filePath.toLowerCase().endsWith(".tex") &&
      d.status !== "deleted" &&
      d.newContent &&
      isStandaloneDocument(d.newContent),
  );
  const main = candidates.find((d) =>
    d.filePath.toLowerCase().endsWith("main.tex"),
  );
  if (main) return main;
  if (candidates.length === 1) return candidates[0];
  return null;
}

/** Normalize history/variant diff records into TexFileDiff. */
export function toTexFileDiffs<
  T extends {
    file_path?: string;
    filePath?: string;
    status: string;
    old_content?: string | null;
    oldContent?: string | null;
    new_content?: string | null;
    newContent?: string | null;
  },
>(diffs: T[]): TexFileDiff[] {
  return diffs.map((d) => ({
    filePath: d.file_path ?? d.filePath ?? "",
    status: d.status as TexFileDiff["status"],
    oldContent: d.old_content ?? d.oldContent ?? null,
    newContent: d.new_content ?? d.newContent ?? null,
  }));
}
