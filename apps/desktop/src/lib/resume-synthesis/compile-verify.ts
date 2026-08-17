/**
 * Assemble and compile a synthesized resume.
 *
 * Typst is the only resume engine. Because every AI value is emitted as a
 * code-mode string literal (see `typst-escape.ts` and `typst-ats.ts`), slot
 * text cannot produce a syntax error — so unlike the LaTeX path this replaced,
 * there is no bisect/repair loop. A failure here means a template or engine
 * defect and is reported as such rather than papered over by silently
 * reverting the user's content.
 */

import {
  getResumeTemplate,
  renderResume,
  templateEngine,
  type ResumeContent,
  type ResumeTemplate,
  type SectionKind,
  type SlotLineRange,
} from "@/lib/resume-templates";
import {
  summarizeTypstResult,
  typstCompile,
  typstPdfBytes,
  type TypstCompileResult,
} from "./typst-compile";

/** Engine-neutral result of assembling and compiling a resume. */
export interface ResumeCompileOutcome {
  /** Assembled Typst document source. */
  source: string;
  content: ResumeContent;
  slots: SlotLineRange[];
  result: { success: boolean; summary: string };
  pdfBytes: Uint8Array | null;
  /** Page count as reported by the engine. */
  pageCount: number | null;
  /** Structured diagnostics, most severe first. */
  diagnostics: TypstCompileResult["errors"];
  /** Non-fatal engine warnings (overfull lines, font fallback, …). */
  warnings: TypstCompileResult["warnings"];
}

export interface ResumeCompileOptions {
  sectionOrder?: SectionKind[];
  onAttempt?: (detail: string, attempt: number) => void;
  signal?: AbortSignal;
  /** Injected for tests; defaults to the Tauri `career_typst_compile` command. */
  typstCompileFn?: (source: string) => Promise<TypstCompileResult>;
}

/** Map a compile diagnostic back to the content slot whose line it falls on. */
export function mapDiagnosticToSlot(
  diagnostics: TypstCompileResult["errors"],
  slots: SlotLineRange[],
): SlotLineRange | null {
  for (const d of diagnostics) {
    if (d.line == null || d.line <= 0) continue;
    const hit = slots.find(
      (s) => d.line! >= s.startLine && d.line! <= s.endLine,
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * Assemble and compile a resume using the template's engine.
 *
 * Throws `DOMException("AbortError")` when cancelled, and for a template whose
 * engine is not Typst — that would mean a stale registry entry, and silently
 * producing a wrong-format document is worse than failing loudly.
 */
export async function compileResumeDocument(
  template: ResumeTemplate | string,
  content: ResumeContent,
  options: ResumeCompileOptions = {},
): Promise<ResumeCompileOutcome> {
  const tmpl =
    typeof template === "string" ? getResumeTemplate(template) : template;
  if (!tmpl) {
    throw new Error(`Unknown resume template: ${String(template)}`);
  }

  const engine = templateEngine(tmpl);
  if (engine !== "typst") {
    throw new Error(
      `Resume template "${tmpl.id}" declares engine "${engine}", but Typst is ` +
        `the only supported resume engine.`,
    );
  }

  if (options.signal?.aborted) {
    throw new DOMException("Synthesis cancelled", "AbortError");
  }
  options.onAttempt?.("Rendering and compiling resume…", 0);

  const rendered = renderResume(tmpl, content, options.sectionOrder);
  const compileFn = options.typstCompileFn ?? typstCompile;
  const result = await compileFn(rendered.source);

  if (options.signal?.aborted) {
    throw new DOMException("Synthesis cancelled", "AbortError");
  }

  return {
    source: rendered.source,
    content,
    slots: rendered.slots,
    result: {
      success: result.success,
      summary: summarizeTypstResult(result),
    },
    pdfBytes: typstPdfBytes(result),
    pageCount: result.page_count,
    diagnostics: result.errors,
    warnings: result.warnings,
  };
}
