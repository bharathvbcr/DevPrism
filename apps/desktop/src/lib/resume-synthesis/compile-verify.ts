import { invoke } from "@tauri-apps/api/core";
import {
  getResumeTemplate,
  renderTemplate,
  setSlotPlainText,
  type ResumeContent,
  type ResumeTemplate,
  type SectionKind,
  type SlotLineRange,
} from "@/lib/resume-templates";

/** Mirrors Rust `LatexCompileErrorItem`. */
export interface LatexCompileErrorItem {
  file: string | null;
  line: number | null;
  message: string;
}

/** Mirrors Rust `AgentCompileResult` / `CareerCompileResult`. */
export interface AgentCompileResult {
  success: boolean;
  main_file: string;
  errors: LatexCompileErrorItem[];
  summary: string;
  /** Present on successful `career_verify_compile` when the engine wrote a PDF. */
  pdf_bytes?: number[] | null;
}

export type CompileEngine = "tectonic" | "texlive";

export interface CompileVerifyOptions {
  engine?: CompileEngine;
  maxRetries?: number;
  sectionOrder?: SectionKind[];
  /** Injected for tests — defaults to Tauri `career_verify_compile`. */
  compile?: (
    texSource: string,
    engine?: CompileEngine,
  ) => Promise<AgentCompileResult>;
  /** Fired before each compile attempt (0-based). */
  onAttempt?: (detail: string, attempt: number) => void;
}

export class SynthesisCompileError extends Error {
  readonly result: AgentCompileResult;
  readonly attempts: number;

  constructor(message: string, result: AgentCompileResult, attempts: number) {
    super(message);
    this.name = "SynthesisCompileError";
    this.result = result;
    this.attempts = attempts;
  }
}

/** Call the Tauri temp-dir compile verifier. */
export async function careerVerifyCompile(
  texSource: string,
  engine?: CompileEngine,
): Promise<AgentCompileResult> {
  return invoke<AgentCompileResult>("career_verify_compile", {
    texSource,
    engine: engine ?? null,
  });
}

/**
 * Map the first error with a line number onto a slot whose range covers it.
 * Returns null when no error carries a usable line.
 */
export function mapErrorLineToSlot(
  errors: LatexCompileErrorItem[],
  slots: SlotLineRange[],
): SlotLineRange | null {
  for (const err of errors) {
    if (err.line == null || err.line <= 0) continue;
    const hit = slots.find(
      (s) => err.line! >= s.startLine && err.line! <= s.endLine,
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * Binary-search which AI slot is breaking compile by reverting half the
 * candidate slots to their canonical text and recompiling.
 */
export async function bisectSlots(
  template: ResumeTemplate,
  content: ResumeContent,
  slots: SlotLineRange[],
  compile: (
    texSource: string,
    engine?: CompileEngine,
  ) => Promise<AgentCompileResult>,
  engine?: CompileEngine,
  sectionOrder?: SectionKind[],
): Promise<SlotLineRange | null> {
  // Prefer bullet / summary / skills slots — skip static header entry shells if possible.
  let candidates = slots.filter(
    (s) =>
      s.slotId.includes(":bullet:") ||
      s.slotId === "summary" ||
      s.slotId.startsWith("skills:"),
  );
  if (candidates.length === 0) candidates = [...slots];
  if (candidates.length === 0) return null;

  while (candidates.length > 1) {
    const mid = Math.ceil(candidates.length / 2);
    const revertSet = new Set(candidates.slice(0, mid).map((s) => s.slotId));
    let trial = structuredClone(content) as ResumeContent;
    for (const s of slots) {
      if (revertSet.has(s.slotId)) {
        trial = setSlotPlainText(trial, s.slotId, s.canonical);
      }
    }
    const { tex } = renderTemplate(template, trial, sectionOrder);
    const result = await compile(tex, engine);
    if (result.success) {
      // Culprit is in the reverted half.
      candidates = candidates.slice(0, mid);
    } else {
      // Still broken → culprit in the untouched half.
      candidates = candidates.slice(mid);
    }
  }

  return candidates[0] ?? null;
}

export interface CompileRepairSuccess {
  tex: string;
  content: ResumeContent;
  slots: SlotLineRange[];
  result: AgentCompileResult;
  repairs: string[];
  /** PDF bytes from the successful compile, when available. */
  pdfBytes?: Uint8Array | null;
}

function pdfBytesFromResult(result: AgentCompileResult): Uint8Array | null {
  if (!result.pdf_bytes || result.pdf_bytes.length === 0) return null;
  return Uint8Array.from(result.pdf_bytes);
}

/**
 * Compile-verify loop (plan §4.4):
 * render → verify → map error to slot (or bisect) → canonical fallback → retry.
 */
export async function compileWithRepairLoop(
  template: ResumeTemplate | string,
  content: ResumeContent,
  options: CompileVerifyOptions = {},
): Promise<CompileRepairSuccess> {
  const tmpl =
    typeof template === "string" ? getResumeTemplate(template) : template;
  if (!tmpl) {
    throw new Error(`Unknown resume template: ${String(template)}`);
  }

  const maxRetries = options.maxRetries ?? 2;
  const compile = options.compile ?? careerVerifyCompile;
  const repairs: string[] = [];
  let current = structuredClone(content) as ResumeContent;
  let lastResult: AgentCompileResult | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    options.onAttempt?.(
      attempt === 0
        ? "Compiling resume…"
        : `Compile retry ${attempt}/${maxRetries}…`,
      attempt,
    );
    const rendered = renderTemplate(tmpl, current, options.sectionOrder);
    const result = await compile(rendered.tex, options.engine);
    lastResult = result;
    if (result.success) {
      return {
        tex: rendered.tex,
        content: current,
        slots: rendered.slots,
        result,
        repairs,
        pdfBytes: pdfBytesFromResult(result),
      };
    }

    if (attempt === maxRetries) break;

    let culprit = mapErrorLineToSlot(result.errors, rendered.slots);
    if (!culprit) {
      culprit = await bisectSlots(
        tmpl,
        current,
        rendered.slots,
        compile,
        options.engine,
        options.sectionOrder,
      );
    }
    if (!culprit) {
      // Soft-fail: return the last rendered tex for review instead of throwing
      // so the orchestrator can surface "Compile needs review".
      repairs.push(`unmapped:${result.summary}`);
      return {
        tex: rendered.tex,
        content: current,
        slots: rendered.slots,
        result,
        repairs,
        pdfBytes: null,
      };
    }

    repairs.push(culprit.slotId);
    current = setSlotPlainText(current, culprit.slotId, culprit.canonical);
  }

  // Exhausted retries — still return a reviewable draft (done-state soft-fail).
  const finalRendered = renderTemplate(tmpl, current, options.sectionOrder);
  const failed = lastResult ?? {
    success: false,
    main_file: "resume.tex",
    errors: [],
    summary: "unknown",
  };
  return {
    tex: finalRendered.tex,
    content: current,
    slots: finalRendered.slots,
    result: { ...failed, success: false },
    repairs,
    pdfBytes: null,
  };
}
