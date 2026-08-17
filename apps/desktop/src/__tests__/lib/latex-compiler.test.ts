import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  parseCompileErrors,
  formatCompileErrorsForPrompt,
  getLatexBuildReport,
} from "@/lib/latex-compiler";
describe("parseCompileErrors", () => {
  it("extracts line numbers from LaTeX log chunks", () => {
    const errs = parseCompileErrors(
      "! Undefined control sequence.\nl.42 \\foo",
      "main.tex",
    );
    expect(errs[0]?.line).toBe(42);
    expect(errs[0]?.file).toBe("main.tex");
    expect(errs[0]?.message).toContain("Undefined control sequence");
  });

  it("formats structured handoff prompts", () => {
    const prompt = formatCompileErrorsForPrompt(
      [{ message: "Undefined control sequence", file: "main.tex", line: 42 }],
      "main.tex",
    );
    expect(prompt).toContain("[Compilation errors in main.tex]");
    expect(prompt).toContain("- main.tex:42 — Undefined control sequence");
    expect(prompt).toContain("Fix these LaTeX compilation errors");
  });
});

describe("getLatexBuildReport", () => {
  // `mockClear`, not `mockReset`: resetting the implementation makes vitest
  // report a mocked rejection as unhandled even when the code under test awaits
  // it inside a try/catch. Every test below sets its own implementation.
  beforeEach(() => invoke.mockClear());

  it("maps the Rust snake_case payload onto the client shape", async () => {
    invoke.mockResolvedValue({
      engine: "Tectonic (XeTeX)",
      requested_engine: "pdflatex",
      pages: 4,
      fidelity: [
        { code: "engine-substituted", message: "typeset with XeTeX" },
        { code: "microtype-expansion-unavailable", message: "no expansion" },
      ],
    });

    const report = await getLatexBuildReport("/p");

    expect(invoke).toHaveBeenCalledWith("latex_build_report", {
      projectDir: "/p",
    });
    expect(report).toEqual({
      engine: "Tectonic (XeTeX)",
      requestedEngine: "pdflatex",
      pages: 4,
      fidelity: [
        { code: "engine-substituted", message: "typeset with XeTeX" },
        { code: "microtype-expansion-unavailable", message: "no expansion" },
      ],
    });
  });

  it("returns null when the project has never been compiled", async () => {
    invoke.mockResolvedValue(null);
    expect(await getLatexBuildReport("/p")).toBeNull();
  });

  it("never lets a diagnostics failure break a successful compile", async () => {
    // Only the command under test fails. The failure path logs, and the logger
    // forwards warnings through `invoke("js_log")` — failing every command
    // would break the logger rather than exercise this guarantee.
    invoke.mockImplementation((cmd: string) =>
      cmd === "latex_build_report"
        ? Promise.reject(new Error("command not found"))
        : Promise.resolve(undefined),
    );
    expect(await getLatexBuildReport("/p")).toBeNull();
  });

  it("tolerates a payload with no fidelity array", async () => {
    invoke.mockResolvedValue({
      engine: "TeX Live pdfLaTeX",
      requested_engine: null,
      pages: 3,
    });
    const report = await getLatexBuildReport("/p");
    expect(report?.fidelity).toEqual([]);
    expect(report?.requestedEngine).toBeNull();
  });
});
