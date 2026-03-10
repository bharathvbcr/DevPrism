import { invoke } from "@tauri-apps/api/core";
import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";

/** Resolve which file to compile and the root ID for caching. */
export function resolveCompileTarget(
  activeFileId: string,
  files: ProjectFile[],
): { rootId: string; targetPath: string } {
  const rootId = resolveTexRoot(activeFileId, files);
  const rootEntry = files.find((f) => f.id === rootId);
  const targetPath = rootEntry?.type === "tex"
    ? rootEntry.relativePath
    : (files.find((f) => f.name === "document.tex" || f.name === "main.tex")?.relativePath || "document.tex");
  return { rootId, targetPath };
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
