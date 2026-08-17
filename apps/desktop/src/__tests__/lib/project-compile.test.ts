/**
 * `project-compile.ts` is the single point where a resolved compile target is
 * turned into PDF bytes for the whole workspace — the toolbar, the preview, the
 * auto-recompile scheduler and the agent all funnel through it. It had no
 * tests; these pin the engine routing and the failure surfaces.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

// `compileLatex` reaches into stores for personalization telemetry; keep the
// unit under test focused on routing rather than dragging the whole app in.
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: { getState: () => ({ files: [] }) },
  getPdfBytes: () => null,
}));
vi.mock("@/stores/personalization-store", () => ({
  usePersonalizationStore: {
    getState: () => ({ incrementDocumentClass: () => {} }),
  },
}));
vi.mock("@/lib/personalization", () => ({
  recordPersonalizationEvent: () => {},
}));

import { compileTargetToPdf, formatTypstErrors } from "@/lib/project-compile";
import type { TypstCompileResult } from "@/lib/resume-synthesis/typst-compile";

function typstResult(
  over: Partial<TypstCompileResult> = {},
): TypstCompileResult {
  return {
    success: true,
    page_count: 1,
    errors: [],
    warnings: [],
    duration_ms: 1,
    pdf_bytes: [0x25, 0x50, 0x44, 0x46],
    ...over,
  };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("formatTypstErrors", () => {
  it("renders file:line — message, one per line", () => {
    const out = formatTypstErrors(
      typstResult({
        success: false,
        pdf_bytes: null,
        errors: [
          {
            severity: "error",
            message: "unclosed delimiter",
            file: "main.typ",
            line: 12,
            column: 3,
            hints: [],
          },
          {
            severity: "error",
            message: "unknown variable",
            file: "lib.typ",
            line: 4,
            column: 1,
            hints: ["did you mean `x`?"],
          },
        ],
      }),
    );
    expect(out).toBe(
      "main.typ:12 — unclosed delimiter\n" +
        "lib.typ:4 — unknown variable (did you mean `x`?)",
    );
  });

  it("degrades gracefully when a diagnostic has no location", () => {
    const out = formatTypstErrors(
      typstResult({
        success: false,
        pdf_bytes: null,
        errors: [
          {
            severity: "error",
            message: "page limit exceeded",
            file: null,
            line: null,
            column: null,
            hints: [],
          },
        ],
      }),
    );
    expect(out).toBe("page limit exceeded");
  });

  it("uses a bare line number when the file is unknown", () => {
    const out = formatTypstErrors(
      typstResult({
        success: false,
        pdf_bytes: null,
        errors: [
          {
            severity: "error",
            message: "boom",
            file: null,
            line: 7,
            column: null,
            hints: [],
          },
        ],
      }),
    );
    expect(out).toBe("line 7 — boom");
  });

  it("falls back to the summary when there are no error diagnostics", () => {
    // A failed compile with no diagnostics must still say something useful.
    const out = formatTypstErrors(
      typstResult({ success: false, pdf_bytes: null, errors: [] }),
    );
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("compileTargetToPdf routing", () => {
  it("sends a typst target to career_typst_compile_project", async () => {
    invoke.mockResolvedValueOnce(typstResult());
    const bytes = await compileTargetToPdf("/proj", "main.typ", "typst", false);

    expect(invoke).toHaveBeenCalledWith("career_typst_compile_project", {
      projectDir: "/proj",
      mainFile: "main.typ",
    });
    expect(Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("sends a latex target to compile_latex with the backend flag", async () => {
    invoke.mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer);
    const bytes = await compileTargetToPdf("/proj", "main.tex", "latex", true);

    expect(invoke).toHaveBeenCalledWith("compile_latex", {
      projectDir: "/proj",
      mainFile: "main.tex",
      useTexlive: true,
    });
    expect(bytes.byteLength).toBe(3);
  });

  it("throws formatted diagnostics when a typst compile fails", async () => {
    invoke.mockResolvedValueOnce(
      typstResult({
        success: false,
        pdf_bytes: null,
        errors: [
          {
            severity: "error",
            message: "unclosed delimiter",
            file: "main.typ",
            line: 9,
            column: 1,
            hints: [],
          },
        ],
      }),
    );
    await expect(
      compileTargetToPdf("/proj", "main.typ", "typst", false),
    ).rejects.toThrow("main.typ:9 — unclosed delimiter");
  });

  it("treats a success flag with no PDF bytes as a failure", async () => {
    // Defensive: success without bytes would otherwise hand the preview an
    // empty buffer and render a blank page.
    invoke.mockResolvedValueOnce(typstResult({ pdf_bytes: null }));
    await expect(
      compileTargetToPdf("/proj", "main.typ", "typst", false),
    ).rejects.toThrow();
  });

  it("treats an empty PDF byte array as a failure", async () => {
    invoke.mockResolvedValueOnce(typstResult({ pdf_bytes: [] }));
    await expect(
      compileTargetToPdf("/proj", "main.typ", "typst", false),
    ).rejects.toThrow();
  });

  it("propagates a host-side error (timeout, missing engine)", async () => {
    invoke.mockRejectedValueOnce(
      "Compilation did not finish within 180s and was stopped.",
    );
    await expect(
      compileTargetToPdf("/proj", "main.tex", "latex", false),
    ).rejects.toBeTruthy();
  });

  it("never routes a latex target to the typst command", async () => {
    invoke.mockResolvedValueOnce(new Uint8Array([1]).buffer);
    await compileTargetToPdf("/proj", "main.tex", "latex", false);
    const commands = invoke.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain("career_typst_compile_project");
    expect(commands).not.toContain("career_typst_compile");
  });

  it("never routes a typst target to the latex command", async () => {
    invoke.mockResolvedValueOnce(typstResult());
    await compileTargetToPdf("/proj", "main.typ", "typst", true);
    const commands = invoke.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain("compile_latex");
  });
});
