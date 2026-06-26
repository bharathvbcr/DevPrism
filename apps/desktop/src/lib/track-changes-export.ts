import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { compileLatex } from "@/lib/latex-compiler";
import {
  buildTrackedTexFile,
  buildTrackChangesReport,
  pickTrackedCompileTarget,
  toTexFileDiffs,
  type TexFileDiff,
  type TrackChangesGranularity,
  type TrackChangesMeta,
} from "@/lib/latex-track-changes";
import { writeTexFileContent, deleteFileFromDisk, join } from "@/lib/tauri/fs";
import { useSettingsStore } from "@/stores/settings-store";
import { useTrackChangesPreviewStore } from "@/stores/track-changes-preview-store";

function texDiffsOnly(diffs: TexFileDiff[]): TexFileDiff[] {
  return diffs.filter((d) => d.filePath.toLowerCase().endsWith(".tex"));
}

const STANDALONE_RE = /\\documentclass[\s{[]/;

/**
 * Build a tracked .tex for one file, preferring the system `latexdiff` (highest
 * fidelity: math/command-aware) for standalone modified documents and falling
 * back to the built-in markup generator when latexdiff isn't installed or
 * errors. Returns which engine produced the result for user feedback.
 */
async function buildTrackedTexFileAuto(
  diff: TexFileDiff,
  granularity: TrackChangesGranularity,
): Promise<{ tex: string; engine: "latexdiff" | "builtin" }> {
  if (
    diff.status === "modified" &&
    diff.oldContent &&
    diff.newContent &&
    STANDALONE_RE.test(diff.oldContent) &&
    STANDALONE_RE.test(diff.newContent)
  ) {
    try {
      const tex = await invoke<string>("latexdiff_generate", {
        oldContent: diff.oldContent,
        newContent: diff.newContent,
      });
      if (tex?.trim()) return { tex, engine: "latexdiff" };
    } catch {
      // latexdiff missing or failed — fall back to the built-in generator.
    }
  }
  return { tex: buildTrackedTexFile(diff, granularity), engine: "builtin" };
}

function defaultExportName(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? "document.tex";
  return base.replace(/\.tex$/i, "-tracked.tex");
}

/** Write tracked .tex to a user-chosen path (or report when multiple files). */
export async function exportTrackedTex(
  projectRoot: string,
  diffs: TexFileDiff[],
  meta: TrackChangesMeta,
  granularity: TrackChangesGranularity = "word",
): Promise<void> {
  const texDiffs = texDiffsOnly(diffs);
  if (texDiffs.length === 0) {
    throw new Error("No .tex files changed in this comparison.");
  }

  if (texDiffs.length === 1) {
    const diff = texDiffs[0];
    const { tex: content, engine } = await buildTrackedTexFileAuto(
      diff,
      granularity,
    );
    const outputPath = await save({
      defaultPath: `${projectRoot}/${defaultExportName(diff.filePath)}`,
      filters: [{ name: "LaTeX", extensions: ["tex"] }],
    });
    if (!outputPath) return;
    await writeTexFileContent(outputPath, content);
    toast.success(
      `Exported tracked changes to ${outputPath.split(/[/\\]/).pop()}`,
      {
        description: `Markup engine: ${engine === "latexdiff" ? "latexdiff" : "built-in"}`,
      },
    );
    return;
  }

  const content = buildTrackChangesReport(texDiffs, meta, granularity);
  const outputPath = await save({
    defaultPath: `${projectRoot}/tracked-changes-report.tex`,
    filters: [{ name: "LaTeX", extensions: ["tex"] }],
  });
  if (!outputPath) return;
  await writeTexFileContent(outputPath, content);
  toast.success("Exported tracked changes report");
}

/**
 * Compile tracked changes and show the PDF in the dedicated track-changes
 * dialog. The diff is rendered in its own viewer (not the live preview pane) so
 * it never overwrites the document's PDF, SyncTeX build info, or the
 * export/summarize state.
 */
export async function previewTrackedChangesPdf(
  projectRoot: string,
  diffs: TexFileDiff[],
  meta: TrackChangesMeta,
  granularity: TrackChangesGranularity = "word",
): Promise<void> {
  const texDiffs = texDiffsOnly(diffs);
  if (texDiffs.length === 0) {
    throw new Error("No .tex files changed in this comparison.");
  }

  const compileTarget = pickTrackedCompileTarget(texDiffs);
  const texContent = compileTarget
    ? (await buildTrackedTexFileAuto(compileTarget, granularity)).tex
    : buildTrackChangesReport(texDiffs, meta, granularity);

  // Unique per-invocation temp name (dotfile, never poisons SyncTeX) so two
  // concurrent previews can't clobber each other's source.
  const tempRelPath = `.devprism-track-changes-preview-${Date.now()}.tex`;
  const tempAbsPath = await join(projectRoot, tempRelPath);
  const useTexlive = useSettingsStore.getState().compilerBackend === "texlive";
  const toastId = toast.loading("Compiling tracked changes PDF…");

  try {
    await writeTexFileContent(tempAbsPath, texContent);
    const pdfBytes = await compileLatex(projectRoot, tempRelPath, useTexlive);
    useTrackChangesPreviewStore
      .getState()
      .show(pdfBytes, compileTarget ? meta.toLabel : "all changed files");
    toast.success(
      compileTarget
        ? "Showing document with tracked changes"
        : "Showing tracked changes report",
      { id: toastId },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    toast.error("Couldn't compile tracked changes PDF", {
      id: toastId,
      description: message,
      duration: 10000,
    });
    throw err;
  } finally {
    try {
      await deleteFileFromDisk(tempAbsPath);
    } catch {
      // Best-effort cleanup of the throwaway preview source.
    }
  }
}

export type { TexFileDiff, TrackChangesMeta, TrackChangesGranularity };
export { toTexFileDiffs };
