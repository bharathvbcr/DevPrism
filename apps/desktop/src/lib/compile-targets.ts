/**
 * Engine-agnostic compile-root resolution.
 *
 * Single owner for "which document does the Compile button build, and with
 * which engine". LaTeX roots are found by `\documentclass`; Typst roots are
 * found structurally (see `typst-project.ts`). Everything that needs a compile
 * target — the toolbar, the PDF preview, the AI compile-status context —
 * should come through here rather than re-deciding per call site.
 */

import { engineForFileType } from "@/lib/tauri/fs-shared";
import { listTypstRoots, resolveTypstRoot } from "@/lib/typst-project";
import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";

export type CompileEngineKind = "latex" | "typst";

export interface CompileRootOption {
  rootId: string;
  targetPath: string;
  label: string;
  engine: CompileEngineKind;
}

export interface CompileTarget {
  rootId: string;
  targetPath: string;
  engine: CompileEngineKind;
}

const COVER_LETTER_NAMES = new Set([
  "cover_letter.tex",
  "cover-letter.tex",
  "coverletter.tex",
]);

/** LaTeX roots: `.tex` files containing `\documentclass`. */
function listLatexRoots(files: ProjectFile[]): CompileRootOption[] {
  return files
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
        engine: "latex" as const,
      };
    });
}

/** All compile roots across both engines, cover letters last. */
export function listCompileRoots(files: ProjectFile[]): CompileRootOption[] {
  const roots: CompileRootOption[] = [
    ...listLatexRoots(files),
    ...listTypstRoots(files).map((r) => ({ ...r, engine: "typst" as const })),
  ];

  return roots.sort((a, b) => {
    const aCover = a.label.startsWith("Cover letter");
    const bCover = b.label.startsWith("Cover letter");
    if (aCover !== bCover) return aCover ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
}

/**
 * Resolve which file to compile, and with which engine.
 *
 * A pinned `preferredRootId` wins when it is still a valid root. Otherwise the
 * active file's own engine decides: Typst files resolve through the import
 * graph, LaTeX files through `\documentclass`.
 */
export function resolveCompileTarget(
  activeFileId: string,
  files: ProjectFile[],
  preferredRootId?: string | null,
): CompileTarget | null {
  if (preferredRootId) {
    const preferred = listCompileRoots(files).find(
      (r) => r.rootId === preferredRootId,
    );
    if (preferred) {
      return {
        rootId: preferred.rootId,
        targetPath: preferred.targetPath,
        engine: preferred.engine,
      };
    }
  }

  const active = files.find((f) => f.id === activeFileId);

  if (active?.type === "typst") {
    const rootId = resolveTypstRoot(activeFileId, files);
    const entry = files.find((f) => f.id === rootId);
    if (entry) {
      return {
        rootId,
        targetPath: entry.relativePath,
        engine: "typst",
      };
    }
  }

  if (active?.type === "tex") {
    const rootId = resolveTexRoot(activeFileId, files);
    const entry = files.find((f) => f.id === rootId);
    if (entry?.type === "tex") {
      return { rootId, targetPath: entry.relativePath, engine: "latex" };
    }
  }

  // Active file is not a source document (or was not found): fall back to any
  // root in the project, preferring LaTeX to preserve prior behaviour.
  const roots = listCompileRoots(files);
  const fallbackRoot =
    roots.find((r) => r.engine === "latex") ?? roots[0] ?? null;
  if (fallbackRoot) {
    return {
      rootId: fallbackRoot.rootId,
      targetPath: fallbackRoot.targetPath,
      engine: fallbackRoot.engine,
    };
  }

  // No root at all — fall back to any compilable source so the user gets a
  // real engine error rather than a silent no-op.
  const anySource = files.find((f) => engineForFileType(f.type) !== null);
  if (anySource) {
    return {
      rootId: anySource.id,
      targetPath: anySource.relativePath,
      engine: engineForFileType(anySource.type) === "typst" ? "typst" : "latex",
    };
  }
  return null;
}
