import { invoke } from "@tauri-apps/api/core";
import {
  resolveTexRoot,
  type ProjectFile,
  useDocumentStore,
  getPdfBytes,
} from "@/stores/document-store";
import { usePersonalizationStore } from "@/stores/personalization-store";
import { useSettingsStore } from "@/stores/settings-store";
import { recordPersonalizationEvent } from "@/lib/personalization";
import { createLogger } from "@/lib/debug/logger";
import { parseCompileErrorLine } from "@/lib/ai-assist";

const log = createLogger("latex");

export interface CompileRootOption {
  rootId: string;
  targetPath: string;
  label: string;
}

const COVER_LETTER_NAMES = new Set([
  "cover_letter.tex",
  "cover-letter.tex",
  "coverletter.tex",
]);

/** All standalone .tex roots (files with \\documentclass) in the project. */
export function listCompileRoots(files: ProjectFile[]): CompileRootOption[] {
  const roots = files
    .filter(
      (f) =>
        f.type === "tex" &&
        f.content &&
        /\\documentclass[\s{[]/.test(f.content),
    )
    .map((f) => {
      const lower = f.name.toLowerCase();
      let label = f.name;
      if (COVER_LETTER_NAMES.has(lower)) {
        label = `Cover letter (${f.name})`;
      } else if (lower === "main.tex") {
        label = `Main (${f.name})`;
      }
      return {
        rootId: f.id,
        targetPath: f.relativePath,
        label,
      };
    });

  return roots.sort((a, b) => {
    const aCover = a.label.startsWith("Cover letter");
    const bCover = b.label.startsWith("Cover letter");
    if (aCover !== bCover) return aCover ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
}

export function isStandaloneCompileRoot(
  fileId: string,
  files: ProjectFile[],
): boolean {
  const file = files.find((f) => f.id === fileId);
  if (!file?.content || file.type !== "tex") return false;
  if (!/\\documentclass[\s{[]/.test(file.content)) return false;
  return resolveTexRoot(fileId, files) === fileId;
}

/** Resolve which file to compile and the root ID for caching. */
export function resolveCompileTarget(
  activeFileId: string,
  files: ProjectFile[],
  preferredRootId?: string | null,
): { rootId: string; targetPath: string } | null {
  if (preferredRootId) {
    const preferred = files.find((f) => f.id === preferredRootId);
    if (
      preferred?.type === "tex" &&
      preferred.content &&
      /\\documentclass[\s{[]/.test(preferred.content)
    ) {
      return { rootId: preferred.id, targetPath: preferred.relativePath };
    }
  }

  const rootId = resolveTexRoot(activeFileId, files);
  const rootEntry = files.find((f) => f.id === rootId);
  if (rootEntry?.type === "tex") {
    return { rootId, targetPath: rootEntry.relativePath };
  }
  const anyTex = files.find((f) => f.type === "tex");
  if (anyTex) {
    return { rootId: anyTex.id, targetPath: anyTex.relativePath };
  }
  return null;
}

/** Extract a human-readable error message from an unknown catch value. */
export function formatCompileError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Compilation failed";
}

export interface ParsedCompileError {
  message: string;
  file?: string;
  line?: number | null;
}

/** Split a formatted compile error string into individual error messages. */
export function splitCompileErrorMessages(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/\s*!\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s !== "Compilation failed"),
    ),
  ];
}

/** Split a compile log into structured errors (file, line, message). */
export function parseCompileErrors(
  errorText: string,
  defaultFile?: string,
): ParsedCompileError[] {
  const chunks = [
    ...new Set(
      errorText
        .split(/\s*!\s*/)
        .map((s) => s.trim())
        .filter(
          (s) =>
            s.length > 0 &&
            !/^Compilation failed/i.test(s) &&
            s !== "Compilation failed",
        ),
    ),
  ];
  if (chunks.length === 0 && errorText.trim()) {
    chunks.push(errorText.trim());
  }
  return chunks.map((chunk) => {
    const fileRef = chunk.match(/(?:^|\n)\.?\/?([\w./-]+\.tex):(\d+):/m);
    const file = fileRef?.[1] ?? defaultFile;
    const fileLine = fileRef ? Number.parseInt(fileRef[2], 10) : null;
    const lineFromL = parseCompileErrorLine(chunk);
    const line =
      fileLine && Number.isFinite(fileLine) ? fileLine : (lineFromL ?? null);
    const firstLine = chunk
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !/^l\.\d+/.test(l));
    const message =
      firstLine?.replace(/^LaTeX Error:\s*/i, "").trim() ||
      chunk.split("\n")[0]?.trim() ||
      chunk.trim();
    return { message, file, line };
  });
}

/** Format parsed compile errors for agent handoff (Fix with AI). */
export function formatCompileErrorsForPrompt(
  errors: ParsedCompileError[],
  mainFile?: string,
): string {
  const header = mainFile
    ? `[Compilation errors in ${mainFile}]`
    : `[Compilation errors]`;
  const lines = errors.map((e) => {
    if (e.file && e.line) return `- ${e.file}:${e.line} — ${e.message}`;
    if (e.line) return `- line ${e.line} — ${e.message}`;
    return `- ${e.message}`;
  });
  return `${header}\n${lines.join("\n")}\n\nFix these LaTeX compilation errors. Read the failing lines with offset/limit, then apply edits.`;
}

/** Build a Fix-with-AI prompt from the current compile error state. */
export function buildCompileFixPrompt(): string | null {
  const doc = useDocumentStore.getState();
  if (!doc.compileError || !doc.projectRoot) return null;

  const pinnedRoot =
    useSettingsStore.getState().compileRootByProject[doc.projectRoot];
  const target = resolveCompileTarget(doc.activeFileId, doc.files, pinnedRoot);
  const mainFile = target?.targetPath;
  const parsed = parseCompileErrors(doc.compileError, mainFile);
  if (parsed.length === 0) return null;
  return formatCompileErrorsForPrompt(parsed, mainFile);
}

/** Build a compile-status block for agent system prompts. */
export function buildCompileStateContext(): string | null {
  const doc = useDocumentStore.getState();
  if (!doc.projectRoot || doc.files.length === 0) return null;

  const pinnedRoot =
    useSettingsStore.getState().compileRootByProject[doc.projectRoot];
  const target = resolveCompileTarget(doc.activeFileId, doc.files, pinnedRoot);
  if (!target) return null;

  const { rootId, targetPath } = target;

  if (doc.isCompiling) {
    return `## COMPILE STATUS\nA compile is currently running for \`${targetPath}\`.`;
  }

  const cachedError = doc.compileErrorCache.get(rootId) ?? doc.compileError;
  const hasPdf = Boolean(getPdfBytes(rootId));
  const lastGen = doc.lastCompiledGenerations.get(rootId);
  const stale =
    hasPdf && lastGen !== undefined && doc.contentGeneration !== lastGen;

  if (cachedError) {
    const parsed = parseCompileErrors(cachedError, targetPath);
    const summary =
      parsed[0]?.file && parsed[0]?.line
        ? `${parsed[0].file}:${parsed[0].line} — ${parsed[0].message}`
        : (parsed[0]?.message ?? cachedError.split("\n")[0]?.slice(0, 240));
    const extra = parsed.length > 1 ? ` (+${parsed.length - 1} more)` : "";
    return `## COMPILE STATUS\nLast compile of \`${targetPath}\` **failed**.\nPrimary error: ${summary}${extra}\nUse Compile or Read the cited file/line before editing.`;
  }

  if (hasPdf && !stale) {
    const pages = doc.compiledPageCounts.get(rootId);
    const pageNote = pages ? ` (${pages} pages)` : "";
    return `## COMPILE STATUS\nLast compile of \`${targetPath}\` **succeeded**${pageNote}.`;
  }

  if (hasPdf && stale) {
    return `## COMPILE STATUS\n\`${targetPath}\` compiled earlier but the project has **edits not yet recompiled**. Run Compile to verify.`;
  }

  return `## COMPILE STATUS\nNo successful compile recorded yet for \`${targetPath}\`.`;
}

export async function compileLatex(
  projectDir: string,
  mainFile: string = "main.tex",
  useTexlive: boolean = false,
): Promise<Uint8Array> {
  log.info(
    `Compiling ${mainFile} (backend: ${useTexlive ? "texlive" : "tectonic"})`,
  );
  const start = performance.now();
  const buffer = await invoke<ArrayBuffer>("compile_latex", {
    projectDir,
    mainFile,
    useTexlive,
  });

  const result = new Uint8Array(buffer);
  log.info(
    `Compiled ${mainFile} in ${(performance.now() - start).toFixed(0)}ms (${(result.byteLength / 1024).toFixed(0)} KB)`,
  );

  // Hook into personalization store to increment compiled document class
  try {
    const docState = useDocumentStore.getState();
    const file = docState.files.find((f) => f.relativePath === mainFile);
    if (file?.content) {
      const match = file.content.match(
        /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/,
      );
      if (match?.[1]) {
        const personalizationState = usePersonalizationStore.getState();
        personalizationState.incrementDocumentClass(match[1]);
        recordPersonalizationEvent("document_class_compiled", {
          docClass: match[1],
        });
      }
    }
  } catch (_e) {
    // Ignore any error in personalization hook
  }

  return result;
}

export interface TexliveStatus {
  available: boolean;
  engines: string[];
  version: string | null;
}

export async function detectTexlive(): Promise<TexliveStatus> {
  return invoke<TexliveStatus>("detect_texlive");
}

export interface SynctexResult {
  file: string;
  line: number;
  column: number;
}

export interface SynctexForwardResult {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function synctexEdit(
  projectDir: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexResult | null> {
  try {
    const result = await invoke<SynctexResult>("synctex_edit", {
      projectDir,
      page,
      x,
      y,
    });
    if (result)
      log.debug(`SyncTeX: page ${page} → ${result.file}:${result.line}`);
    return result;
  } catch (err) {
    log.debug("SyncTeX lookup failed", { page, error: String(err) });
    return null;
  }
}

export async function synctexForward(
  projectDir: string,
  file: string,
  line: number,
  column: number = 0,
): Promise<SynctexForwardResult | null> {
  try {
    const result = await invoke<SynctexForwardResult>("synctex_forward", {
      projectDir,
      file,
      line,
      column,
    });
    if (result) {
      log.debug(
        `SyncTeX forward: ${file}:${line} → page ${result.page} (${result.x}, ${result.y})`,
      );
    }
    return result;
  } catch (err) {
    log.debug("SyncTeX forward failed", { file, line, error: String(err) });
    return null;
  }
}
