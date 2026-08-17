import { describe, expect, it } from "vitest";
import { listCompileRoots, resolveCompileTarget } from "@/lib/compile-targets";
import {
  engineForFileType,
  getProjectFileType,
  isCompilableSource,
  isTextContent,
} from "@/lib/tauri/fs-shared";
import type { ProjectFile } from "@/stores/document-store";

function file(
  relativePath: string,
  type: ProjectFile["type"],
  content = "",
): ProjectFile {
  return {
    id: relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
    relativePath,
    absolutePath: `/proj/${relativePath}`,
    type,
    content,
    isDirty: false,
    fileSize: content.length,
  } as ProjectFile;
}

const LATEX_ROOT = "\\documentclass{article}\\begin{document}x\\end{document}";

describe("file type classification", () => {
  it("classifies .typ as its own type, not tex", () => {
    expect(getProjectFileType("resume.typ")).toBe("typst");
    expect(getProjectFileType("main.tex")).toBe("tex");
    expect(getProjectFileType("refs.bib")).toBe("bib");
  });

  it("treats both source kinds as compilable and editable", () => {
    for (const t of ["tex", "typst"] as const) {
      expect(isCompilableSource(t)).toBe(true);
      expect(isTextContent(t)).toBe(true);
    }
    expect(isCompilableSource("pdf")).toBe(false);
    expect(isCompilableSource("image")).toBe(false);
  });

  it("maps file types to engines", () => {
    expect(engineForFileType("typst")).toBe("typst");
    expect(engineForFileType("tex")).toBe("latex");
    expect(engineForFileType("bib")).toBeNull();
  });
});

describe("listCompileRoots", () => {
  it("lists roots from both engines", () => {
    const files = [
      file("main.tex", "tex", LATEX_ROOT),
      file("resume.typ", "typst", "= Hi"),
      file("helper.tex", "tex", "no documentclass here"),
    ];
    const roots = listCompileRoots(files);
    expect(roots.map((r) => r.targetPath).sort()).toEqual([
      "main.tex",
      "resume.typ",
    ]);
    expect(roots.find((r) => r.targetPath === "resume.typ")?.engine).toBe(
      "typst",
    );
    expect(roots.find((r) => r.targetPath === "main.tex")?.engine).toBe(
      "latex",
    );
  });

  it("excludes an imported typst file from the root list", () => {
    const files = [
      file("main.typ", "typst", '#import "lib.typ": a'),
      file("lib.typ", "typst", "#let a = 1"),
    ];
    expect(listCompileRoots(files).map((r) => r.targetPath)).toEqual([
      "main.typ",
    ]);
  });

  it("excludes a .tex fragment with no documentclass", () => {
    const files = [
      file("main.tex", "tex", LATEX_ROOT),
      file("chunk.tex", "tex", "\\section{Hi}"),
    ];
    expect(listCompileRoots(files).map((r) => r.targetPath)).toEqual([
      "main.tex",
    ]);
  });

  it("sorts cover letters last", () => {
    const files = [
      file("cover_letter.tex", "tex", LATEX_ROOT),
      file("main.tex", "tex", LATEX_ROOT),
    ];
    const labels = listCompileRoots(files).map((r) => r.label);
    expect(labels[labels.length - 1]).toContain("Cover letter");
  });
});

describe("resolveCompileTarget", () => {
  it("routes a typst file to the typst engine", () => {
    const files = [file("resume.typ", "typst", "= Hi")];
    expect(resolveCompileTarget("resume.typ", files)).toEqual({
      rootId: "resume.typ",
      targetPath: "resume.typ",
      engine: "typst",
    });
  });

  it("routes a tex file to the latex engine", () => {
    const files = [file("main.tex", "tex", LATEX_ROOT)];
    expect(resolveCompileTarget("main.tex", files)).toEqual({
      rootId: "main.tex",
      targetPath: "main.tex",
      engine: "latex",
    });
  });

  it("resolves an imported typst child to its root", () => {
    const files = [
      file("main.typ", "typst", '#import "lib.typ": a'),
      file("lib.typ", "typst", "#let a = 1"),
    ];
    expect(resolveCompileTarget("lib.typ", files)).toMatchObject({
      rootId: "main.typ",
      engine: "typst",
    });
  });

  it("uses the pinned root over the active file", () => {
    const files = [
      file("main.tex", "tex", LATEX_ROOT),
      file("COVER_LETTER.tex", "tex", "\\documentclass{letter}"),
    ];
    expect(resolveCompileTarget("main.tex", files, "COVER_LETTER.tex")).toEqual(
      {
        rootId: "COVER_LETTER.tex",
        targetPath: "COVER_LETTER.tex",
        engine: "latex",
      },
    );
  });

  it("honours a pinned root across engines", () => {
    const files = [
      file("main.tex", "tex", LATEX_ROOT),
      file("resume.typ", "typst", "= Hi"),
    ];
    expect(resolveCompileTarget("main.tex", files, "resume.typ")).toMatchObject(
      { targetPath: "resume.typ", engine: "typst" },
    );
  });

  it("ignores a pinned root that is no longer valid", () => {
    const files = [file("main.tex", "tex", LATEX_ROOT)];
    expect(
      resolveCompileTarget("main.tex", files, "deleted.typ"),
    ).toMatchObject({ targetPath: "main.tex", engine: "latex" });
  });

  it("falls back to a project root when a bib file is active", () => {
    const files = [
      file("refs.bib", "bib", "@article{x}"),
      file("resume.typ", "typst", "= Hi"),
    ];
    expect(resolveCompileTarget("refs.bib", files)).toMatchObject({
      targetPath: "resume.typ",
      engine: "typst",
    });
  });

  it("prefers a latex root over typst when neither is active", () => {
    const files = [
      file("refs.bib", "bib", ""),
      file("resume.typ", "typst", "= Hi"),
      file("main.tex", "tex", LATEX_ROOT),
    ];
    expect(resolveCompileTarget("refs.bib", files)).toMatchObject({
      engine: "latex",
    });
  });

  it("returns null when the project has no source files", () => {
    expect(resolveCompileTarget("a.png", [file("a.png", "image")])).toBeNull();
  });

  it("still targets a typst file that declares no root marker", () => {
    // Every .typ is a valid entry point; there is no `\documentclass` analogue.
    const files = [file("notes.typ", "typst", "just text")];
    expect(resolveCompileTarget("notes.typ", files)).toMatchObject({
      engine: "typst",
    });
  });
});
