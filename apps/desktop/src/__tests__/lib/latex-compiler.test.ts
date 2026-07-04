import { describe, it, expect } from "vitest";
import {
  listCompileRoots,
  resolveCompileTarget,
  parseCompileErrors,
  formatCompileErrorsForPrompt,
} from "@/lib/latex-compiler";
import type { ProjectFile } from "@/stores/document-store";

function texFile(id: string, name: string, content: string): ProjectFile {
  return {
    id,
    name,
    relativePath: name,
    absolutePath: `/proj/${name}`,
    type: "tex",
    content,
    isDirty: false,
  };
}

describe("listCompileRoots", () => {
  it("lists every file with documentclass", () => {
    const files = [
      texFile("main.tex", "main.tex", "\\documentclass{article}\n"),
      texFile(
        "COVER_LETTER.tex",
        "COVER_LETTER.tex",
        "\\documentclass{letter}\n",
      ),
      texFile("chunk.tex", "chunk.tex", "\\section{Hi}\n"),
    ];
    const roots = listCompileRoots(files);
    expect(roots).toHaveLength(2);
    expect(roots.some((r) => r.label.startsWith("Cover letter"))).toBe(true);
  });
});

describe("resolveCompileTarget with preference", () => {
  it("uses preferred root when set", () => {
    const files = [
      texFile("main.tex", "main.tex", "\\documentclass{article}\n"),
      texFile(
        "COVER_LETTER.tex",
        "COVER_LETTER.tex",
        "\\documentclass{letter}\n",
      ),
    ];
    const target = resolveCompileTarget("main.tex", files, "COVER_LETTER.tex");
    expect(target).toEqual({
      rootId: "COVER_LETTER.tex",
      targetPath: "COVER_LETTER.tex",
    });
  });
});

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
