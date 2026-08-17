import { describe, it, expect } from "vitest";
import {
  parseCompileErrors,
  formatCompileErrorsForPrompt,
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
