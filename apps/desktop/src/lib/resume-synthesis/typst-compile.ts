import { invoke } from "@tauri-apps/api/core";

/** Mirrors Rust `TypstDiagnostic`. Line/column are 1-based. */
export interface TypstDiagnostic {
  severity: "error" | "warning";
  message: string;
  /** Project-relative path of the offending file; null for detached spans. */
  file: string | null;
  line: number | null;
  column: number | null;
  hints: string[];
}

/** Mirrors Rust `TypstCompileResult`. */
export interface TypstCompileResult {
  success: boolean;
  page_count: number;
  errors: TypstDiagnostic[];
  warnings: TypstDiagnostic[];
  duration_ms: number;
  pdf_bytes?: number[] | null;
}

/** Compile Typst source in-process via the Tauri host. */
export async function typstCompile(
  source: string,
): Promise<TypstCompileResult> {
  return invoke<TypstCompileResult>("career_typst_compile", { source });
}

/** Font families the Typst engine can resolve on this machine. */
export async function typstFontFamilies(): Promise<string[]> {
  return invoke<string[]>("career_typst_fonts");
}

export function typstPdfBytes(result: TypstCompileResult): Uint8Array | null {
  if (!result.pdf_bytes || result.pdf_bytes.length === 0) return null;
  return Uint8Array.from(result.pdf_bytes);
}

/**
 * Human-readable one-line summary of a compile outcome, for the pipeline UI.
 */
export function summarizeTypstResult(result: TypstCompileResult): string {
  if (result.success) {
    const pages =
      result.page_count === 1 ? "1 page" : `${result.page_count} pages`;
    const warn =
      result.warnings.length > 0
        ? `, ${result.warnings.length} warning(s)`
        : "";
    return `Compiled ${pages} in ${result.duration_ms}ms${warn}`;
  }
  const first = result.errors[0];
  if (!first) return "Compile failed";
  const at = first.line != null ? ` (line ${first.line})` : "";
  return `${first.message}${at}`;
}
