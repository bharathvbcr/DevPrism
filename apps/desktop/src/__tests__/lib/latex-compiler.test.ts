import { describe, it, expect } from "vitest";
import { listCompileRoots, resolveCompileTarget } from "@/lib/latex-compiler";
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
