import { resolveActiveCompileTarget } from "@/lib/compile-root-preference";
import { compileLatex, formatCompileError } from "@/lib/latex-compiler";
import { useDocumentStore } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useSettingsStore } from "@/stores/settings-store";
import { showWorkspaceError } from "@/stores/workspace-banner-store";

/** Compile the active project's LaTeX target (manual / keyboard trigger). */
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
      "No .tex file found in this project. Create a main.tex file to compile.";
    state.setCompileError(message);
    showWorkspaceError("Compilation failed", message, {
      dedupeKey: "compile-no-tex",
    });
    return;
  }

  const { rootId, targetPath } = resolved;
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
    const data = await compileLatex(state.projectRoot, targetPath, useTexlive);
    state.setPdfData(data, rootId);
  } catch (error) {
    const message = formatCompileError(error);
    state.setCompileError(message, rootId);
    const firstLine =
      message
        .split(/\s*!\s*/)
        .map((s) => s.trim())
        .find((s) => s.length > 0 && s !== "Compilation failed") ?? message;
    showWorkspaceError(
      "Compilation failed",
      firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine,
      { dedupeKey: "compile-error" },
    );
  } finally {
    const elapsed = Date.now() - compileStart;
    if (elapsed < 500) {
      await new Promise((r) => setTimeout(r, 500 - elapsed));
    }
    state.setIsCompiling(false);
    if (useDocumentStore.getState().pendingRecompile) {
      setTimeout(() => void compileActiveProject(force), 0);
    }
  }
}
