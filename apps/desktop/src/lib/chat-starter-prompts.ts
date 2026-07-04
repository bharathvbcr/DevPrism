import { parseBibFile } from "@/lib/bibtex";
import { parseCompileErrors } from "@/lib/latex-compiler";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";

const FALLBACK_PROMPTS = [
  "Summarize the open document",
  "Fix grammar in the current selection",
  "List files in this project",
] as const;

const MAX_STARTER_PROMPTS = 4;

const SECTION_RE =
  /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\]\s*)?\{/g;

const CITE_RE =
  /\\(?:cite|citep|citet|Cite|parencite|textcite|footcite)(?:\*)?(?:\[[^\]]*\])*\{([^}]+)\}/g;

function readBraceArg(
  text: string,
  open: number,
): { value: string; end: number } {
  let depth = 0;
  let out = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return { value: out, end: i + 1 };
    }
    out += ch;
  }
  return { value: out, end: text.length };
}

function cleanSectionTitle(raw: string): string {
  return raw
    .replace(/\\[a-zA-Z@]+\*?/g, "")
    .replace(/[{}$]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Last section title in a LaTeX document (for "Summarize chapter 2" style prompts). */
export function lastOutlineSectionTitle(content: string): string | null {
  SECTION_RE.lastIndex = 0;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = SECTION_RE.exec(content)) !== null) {
    const bracePos = m.index + m[0].length - 1;
    const { value } = readBraceArg(content, bracePos);
    const title = cleanSectionTitle(value);
    if (title) last = title;
  }
  return last;
}

function collectBibKeys(files: ProjectFile[]): Set<string> {
  const keys = new Set<string>();
  const bibitemRe = /\\bibitem(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
  for (const f of files) {
    if (f.type === "bib" && f.content) {
      for (const e of parseBibFile(f.content)) {
        keys.add(e.key);
      }
    }
    if (f.type === "tex" && f.content) {
      bibitemRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = bibitemRe.exec(f.content)) !== null) {
        keys.add(m[1].trim());
      }
    }
  }
  return keys;
}

function collectCiteKeys(files: ProjectFile[]): Set<string> {
  const keys = new Set<string>();
  for (const f of files) {
    if (f.type !== "tex" || !f.content) continue;
    CITE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITE_RE.exec(f.content)) !== null) {
      for (const part of m[1].split(",")) {
        const key = part.trim();
        if (key) keys.add(key);
      }
    }
  }
  return keys;
}

export function countUnresolvedCitations(files: ProjectFile[]): number {
  const bibKeys = collectBibKeys(files);
  if (bibKeys.size === 0) return 0;
  let unresolved = 0;
  for (const key of collectCiteKeys(files)) {
    if (!bibKeys.has(key)) unresolved++;
  }
  return unresolved;
}

export interface ChatStarterPromptContext {
  activeFileName: string | null;
  activeFileContent: string | null;
  compileError: string | null;
  files: ProjectFile[];
}

/** Gather project-aware context from the document store. */
export function gatherChatStarterContext(): ChatStarterPromptContext {
  const doc = useDocumentStore.getState();
  const active = doc.files.find((f) => f.id === doc.activeFileId);
  return {
    activeFileName: active?.name ?? null,
    activeFileContent: active?.content ?? null,
    compileError: doc.compileError,
    files: doc.files,
  };
}

/** Starter prompts derived from project state, with sensible fallbacks. */
export function buildChatStarterPrompts(
  args: ChatStarterPromptContext,
): string[] {
  const prompts: string[] = [];
  const hasBib = args.files.some((f) => f.name.toLowerCase().endsWith(".bib"));

  if (args.compileError) {
    const errors = parseCompileErrors(args.compileError);
    if (errors.length > 1) {
      prompts.push(`Fix the ${errors.length} LaTeX compile errors`);
    } else {
      prompts.push("Fix the LaTeX compile errors");
    }
  }

  const sectionTitle =
    args.activeFileContent &&
    args.activeFileName?.toLowerCase().endsWith(".tex")
      ? lastOutlineSectionTitle(args.activeFileContent)
      : null;
  if (sectionTitle) {
    prompts.push(`Summarize "${sectionTitle}"`);
  } else if (args.activeFileName) {
    prompts.push(`Summarize ${args.activeFileName}`);
  }

  const unresolved = hasBib ? countUnresolvedCitations(args.files) : 0;
  if (unresolved > 0) {
    prompts.push(
      unresolved === 1
        ? "Fix the unresolved citation"
        : `Fix the ${unresolved} unresolved citations`,
    );
  } else if (hasBib) {
    prompts.push("Check for unresolved or unused citations");
  }

  for (const p of FALLBACK_PROMPTS) {
    if (prompts.length >= MAX_STARTER_PROMPTS) break;
    if (args.activeFileName && p === "Summarize the open document") continue;
    if (
      sectionTitle &&
      p.startsWith("Summarize") &&
      prompts.some((x) => x.startsWith("Summarize"))
    ) {
      continue;
    }
    if (!prompts.includes(p)) prompts.push(p);
  }
  return prompts.slice(0, MAX_STARTER_PROMPTS);
}

/** Convenience wrapper that reads live document store state. */
export function buildChatStarterPromptsFromStore(): string[] {
  return buildChatStarterPrompts(gatherChatStarterContext());
}
