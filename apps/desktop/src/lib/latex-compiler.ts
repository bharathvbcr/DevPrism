import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";

interface CompileResult {
  pdf_path: string;
}

export async function compileLatex(
  projectDir: string,
  mainFile: string = "document.tex",
  compiler?: string,
): Promise<Uint8Array> {
  const result = await invoke<CompileResult>("compile_latex", {
    projectDir,
    mainFile,
    compiler: compiler ?? null,
  });

  return readFile(result.pdf_path);
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
