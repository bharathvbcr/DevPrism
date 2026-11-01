import {
  fileAffectsCompileRoot,
  hasPinnedCompileRoot,
  resolveActiveCompileTarget,
} from "@/lib/compile-root-preference";
import type { CompileEngineKind } from "@/lib/compile-targets";
import { createLogger } from "@/lib/debug/logger";
import { formatCompileError, isSupersededCompile } from "@/lib/latex-compiler";
import { compileTargetToPdf } from "@/lib/project-compile";
import {
  type DocumentState,
  flushPendingEditorEdits,
  getPdfBytes,
  useDocumentStore,
} from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useSettingsStore } from "@/stores/settings-store";
import { showWorkspaceError } from "@/stores/workspace-banner-store";

const log = createLogger("compile");

/**
 * Minimum time the spinner stays up, per engine.
 *
 * A LaTeX build takes seconds, so 500 ms of spinner reads as progress. Typst
 * compiles in about a millisecond, where the same floor would make the editor
 * feel hundreds of times slower than the engine actually is — it needs only
 * enough to stop the spinner strobing.
 */
const SPINNER_FLOOR_MS: Record<CompileEngineKind, number> = {
  latex: 500,
  typst: 150,
};

export type CompileReason = "manual" | "auto" | "initial" | "agent";

export interface RunCompileOptions {
  /** Skip the "nothing changed since the last build" guard. */
  force?: boolean;
  /** Which path asked for this build. Carried into the re-dispatch. */
  reason?: CompileReason;
  /** Take a pre-compile history snapshot (manual compiles only). */
  snapshot?: boolean;
  /** Also raise the workspace banner when the build fails. */
  banner?: boolean;
  /**
   * Run after a build that produced a PDF, for work owned by the calling
   * surface rather than by the compile (the preview pane's build report, say).
   * It must not throw: a failure here is not a compile failure.
   */
  afterSuccess?: (context: {
    rootId: string;
    engine: CompileEngineKind;
  }) => void | Promise<void>;
}

/**
 * True when this root has a build that already covers the current document, so
 * there is nothing to do. Only ever consulted for non-forced builds.
 */
function isUpToDate(state: DocumentState, rootId: string): boolean {
  const lastGeneration = state.lastCompiledGenerations.get(rootId);
  return (
    Boolean(getPdfBytes(rootId)) &&
    lastGeneration !== undefined &&
    state.contentGeneration === lastGeneration
  );
}

/**
 * True when the project pins a compile root and the file just edited cannot
 * reach it, so rebuilding that root would not show the edit anyway.
 */
function editCannotReachRoot(state: DocumentState, rootId: string): boolean {
  return (
    hasPinnedCompileRoot(state.projectRoot ?? "", state.files) &&
    Boolean(state.lastEditedFileId) &&
    !fileAffectsCompileRoot(
      state.lastEditedFileId as string,
      rootId,
      state.files,
    )
  );
}

/**
 * The one owner of a compile.
 *
 * Every path that builds the preview — the editor's Mod-Enter, the preview
 * pane's button and auto-compile timer, the project-level command and the
 * post-agent rebuild — goes through here, so the generation bookkeeping exists
 * once instead of in five near-copies that each got it slightly wrong.
 *
 * The invariant that matters: the generation recorded against a PDF is the one
 * captured *before* the source was written, never the one current when the
 * build finished. Stamping at the end records edits that the build never saw as
 * though they were included, which both skips the rebuild they need and tells
 * the agent a stale PDF is current.
 */
export async function runCompile(
  options: RunCompileOptions = {},
): Promise<void> {
  const {
    force = false,
    reason = "manual",
    snapshot = false,
    banner = false,
    afterSuccess,
  } = options;

  // Land debounced editor text before reading the generation, so the keystroke
  // the user just typed is part of the build we are about to attribute.
  flushPendingEditorEdits();

  const state = useDocumentStore.getState();
  if (!state.projectRoot) return;

  // One build at a time. A request that arrives mid-build is recorded here and
  // re-dispatched by the finally block of the build that is running — which is
  // why that re-dispatch must exist on every path, not just some.
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
    if (banner) {
      showWorkspaceError("Compilation failed", message, {
        dedupeKey: "compile-no-source",
      });
    }
    return;
  }

  const { rootId, targetPath, engine } = resolved;

  if (
    !force &&
    (isUpToDate(state, rootId) || editCannotReachRoot(state, rootId))
  ) {
    return;
  }

  useHistoryStore.getState().stopReview();
  state.setIsCompiling(true);
  state.setPendingRecompile(false);

  // The generation the bytes we are about to build correspond to.
  const startGeneration = state.contentGeneration;
  const startedAt = Date.now();
  let compiledGeneration: number | null = null;

  try {
    await state.saveAllFiles();

    // saveAllFiles swallows per-file write failures and leaves those files
    // dirty. If anything is still dirty, or the document moved while we were
    // writing, the build reads a mix of disk states and cannot be attributed
    // to any one generation — record nothing rather than record it wrongly.
    const afterSave = useDocumentStore.getState();
    const attributable =
      !afterSave.files.some((f) => f.isDirty) &&
      afterSave.contentGeneration === startGeneration;

    if (!attributable) {
      log.warn("compile cannot be attributed to a generation", {
        reason,
        rootId,
      });
    }

    if (snapshot && state.projectRoot) {
      useHistoryStore
        .getState()
        .createSnapshot(state.projectRoot, "[compile] Pre-compile")
        .catch(() => {});
    }

    const useTexlive =
      useSettingsStore.getState().compilerBackend === "texlive";
    const data = await compileTargetToPdf(
      state.projectRoot,
      targetPath,
      engine,
      useTexlive,
    );

    compiledGeneration = attributable ? startGeneration : null;
    useDocumentStore.getState().setPdfData(data, rootId, compiledGeneration);

    if (afterSuccess) {
      // A missing build report must never turn a successful compile into a
      // failed one.
      try {
        await afterSuccess({ rootId, engine });
      } catch (hookError) {
        log.warn("afterSuccess hook failed", { error: String(hookError) });
      }
    }
  } catch (error) {
    // A build cancelled because a newer one was requested is not a failure;
    // the newer build owns the preview now.
    if (!isSupersededCompile(error)) {
      const message = formatCompileError(error);
      useDocumentStore.getState().setCompileError(message, rootId);
      if (banner) {
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
    }
  } finally {
    const floor = SPINNER_FLOOR_MS[engine];
    const elapsed = Date.now() - startedAt;
    if (elapsed < floor) {
      await new Promise((r) => setTimeout(r, floor - elapsed));
    }

    useDocumentStore.getState().setIsCompiling(false);

    // Re-dispatch in exactly two cases, and from every path:
    //  - something asked for a build while this one was running, or
    //  - the document moved past the generation this build covered, which is
    //    the edit-made-during-a-compile case.
    // A failed build never re-dispatches itself, or a document that cannot
    // compile would spin. An unattributable build does not either: it left no
    // stamp, so the next request is not skipped.
    const after = useDocumentStore.getState();
    const movedOn =
      compiledGeneration !== null &&
      after.contentGeneration !== compiledGeneration;
    if (after.pendingRecompile || movedOn) {
      setTimeout(() => {
        void runCompile({ reason, banner, afterSuccess });
      }, 0);
    }
  }
}

/**
 * Compile the active project (manual or keyboard trigger).
 *
 * Forced by default: the user asked, so the up-to-date guard does not apply.
 */
export async function compileActiveProject(force = true): Promise<void> {
  await runCompile({ force, reason: "manual", snapshot: true, banner: true });
}
