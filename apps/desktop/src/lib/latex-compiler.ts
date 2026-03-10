import { invoke } from "@tauri-apps/api/core";
import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";

/** Resolve which file to compile and the root ID for caching.
 *  Returns `null` when the project has no compilable .tex file. */
export function resolveCompileTarget(
  activeFileId: string,
  files: ProjectFile[],
): { rootId: string; targetPath: string } | null {
  const rootId = resolveTexRoot(activeFileId, files);
  const rootEntry = files.find((f) => f.id === rootId);
  if (rootEntry?.type === "tex") {
    return { rootId, targetPath: rootEntry.relativePath };
  }
  // Fallback: look for any well-known root tex file
  const fallback = files.find((f) => f.name === "document.tex" || f.name === "main.tex");
  if (fallback) {
    return { rootId: fallback.id, targetPath: fallback.relativePath };
  }
  // Final fallback: use the first available .tex file in the project
  const anyTex = files.find((f) => f.type === "tex");
  if (anyTex) {
    return { rootId: anyTex.id, targetPath: anyTex.relativePath };
  }
  // No .tex file exists — cannot compile
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

export async function compileLatex(
  projectDir: string,
  mainFile: string = "document.tex",
): Promise<Uint8Array> {
  // compile_latex returns raw PDF bytes via Tauri IPC Response
  const buffer = await invoke<ArrayBuffer>("compile_latex", {
    projectDir,
    mainFile,
  });

  return new Uint8Array(buffer);
}

export interface SynctexResult {
  file: string;
  line: number;
  column: number;
}

export async function synctexEdit(
  projectDir: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexResult | null> {
  try {
    return await invoke<SynctexResult>("synctex_edit", {
      projectDir,
      page,
      x,
      y,
    });
  } catch {
    return null;
  }
}
