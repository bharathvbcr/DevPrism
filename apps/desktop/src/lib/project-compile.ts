import type { CompileEngineKind } from "@/lib/compile-targets";
import { compileLatex } from "@/lib/latex-compiler";
import {
  summarizeTypstResult,
  typstPdfBytes,
} from "@/lib/resume-synthesis/typst-compile";
import { compileTypstProject } from "@/lib/typst-project";

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
