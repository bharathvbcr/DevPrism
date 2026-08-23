import { resolveActiveCompileTarget } from "@/lib/compile-root-preference";
import type { CompileEngineKind } from "@/lib/compile-targets";
import {
  compileLatex,
  formatCompileError,
  isSupersededCompile,
} from "@/lib/latex-compiler";
import {
  summarizeTypstResult,
  typstPdfBytes,
} from "@/lib/resume-synthesis/typst-compile";
import { compileTypstProject } from "@/lib/typst-project";
import { useDocumentStore } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useSettingsStore } from "@/stores/settings-store";
import { showWorkspaceError } from "@/stores/workspace-banner-store";

/**
 * Format Typst diagnostics the way the error banner and the AI "fix this"
 * prompt expect: `file:line — message`, most important first.
 */
export function formatTypstErrors(
  result: Awaited<ReturnType<typeof compileTypstProject>>,
): string {
  if (result.errors.length === 0) return summarizeTypstResult(result);
  return result.errors
    .map((e) => {
      const where = e.file
        ? e.line != null
          ? `${e.file}:${e.line}`
          : e.file
        : e.line != null
          ? `line ${e.line}`
          : null;
      const hint = e.hints.length > 0 ? ` (${e.hints[0]})` : "";
      return where ? `${where} — ${e.message}${hint}` : `${e.message}${hint}`;
    })
    .join("\n");
}

/**
 * Compile a resolved target with whichever engine it declares, returning PDF
 * bytes or throwing with an engine-appropriate message.
 *
 * Single entry point so no call site has to re-decide LaTeX vs Typst — pass
 * the `engine` from `resolveCompileTarget` and it does the right thing.
 */
export async function compileTargetToPdf(
  projectRoot: string,
  targetPath: string,
  engine: CompileEngineKind,
  useTexlive: boolean,
): Promise<Uint8Array> {
  if (engine === "typst") {
    const result = await compileTypstProject(projectRoot, targetPath);
    const bytes = typstPdfBytes(result);
    if (!result.success || !bytes) {
      throw new Error(formatTypstErrors(result));
    }
    return bytes;
  }
  return compileLatex(projectRoot, targetPath, useTexlive);
}

/**
 * Compile the active project's target (manual / keyboard trigger).
 *
 * Routes to the engine the resolved root declares — Tectonic for `.tex`,
 * the in-process Typst compiler for `.typ`.
 */
export async function compileActiveProject(force = true): Promise<void> {
  const state = useDocumentStore.getState();
  if (!state.projectRoot) return;
  if (state.isCompiling) {
    state.setPendingRecompile(true);
    return;
  }

  const resolved = resolveActiveCompileTarget(
    state.projectRoot,
    state.activeFileId,
    state.files,
  );
  if (!resolved) {
    const message =
      "No .tex or .typ file found in this project. Create a main.tex or main.typ file to compile.";
    state.setCompileError(message);
    showWorkspaceError("Compilation failed", message, {
      dedupeKey: "compile-no-source",
    });
    return;
  }

  const { rootId, targetPath, engine } = resolved;
  useHistoryStore.getState().stopReview();
  state.setIsCompiling(true);
  state.setPendingRecompile(false);
  const compileStart = Date.now();

  try {
    await state.saveAllFiles();
    useHistoryStore
      .getState()
      .createSnapshot(state.projectRoot, "[compile] Pre-compile")
      .catch(() => {});

    const useTexlive =
      useSettingsStore.getState().compilerBackend === "texlive";
    const data = await compileTargetToPdf(
      state.projectRoot,
      targetPath,
      engine,
      useTexlive,
    );
    state.setPdfData(data, rootId);
  } catch (error) {
    // A build cancelled by a newer edit is not a failure — the newer
    // compile (already scheduled) owns the preview now.
    if (!isSupersededCompile(error)) {
      const message = formatCompileError(error);
      state.setCompileError(message, rootId);
      const firstLine =
        message
          .split(/\s*[!\n]\s*/)
          .map((s) => s.trim())
          .find((s) => s.length > 0 && s !== "Compilation failed") ?? message;
      showWorkspaceError(
        "Compilation failed",
        firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine,
        { dedupeKey: "compile-error" },
      );
    }
  } finally {
    const elapsed = Date.now() - compileStart;
    // Typst compiles in ~1ms; without a floor the spinner would strobe.
    if (elapsed < 500) {
      await new Promise((r) => setTimeout(r, 500 - elapsed));
    }
    state.setIsCompiling(false);
    if (useDocumentStore.getState().pendingRecompile) {
      setTimeout(() => void compileActiveProject(force), 0);
    }
  }
}
