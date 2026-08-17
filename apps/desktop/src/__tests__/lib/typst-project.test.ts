import { describe, expect, it } from "vitest";
import {
  listTypstRoots,
  normalizeRelativePath,
  parseTypstHeadings,
  parseTypstImports,
  resolveTypstImport,
  resolveTypstRoot,
  typstImportedPaths,
} from "@/lib/typst-project";
import type { ProjectFile } from "@/stores/document-store";

function typFile(relativePath: string, content: string): ProjectFile {
  return {
    id: relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
    relativePath,
    absolutePath: `/proj/${relativePath}`,
    type: "typst",
    content,
    isDirty: false,
    fileSize: content.length,
  } as ProjectFile;
}

describe("parseTypstImports", () => {
  it("finds import and include paths", () => {
    const src = `#import "lib.typ": a\n#include "parts/x.typ"\n`;
    expect(parseTypstImports(src)).toEqual(["lib.typ", "parts/x.typ"]);
  });

  it("skips package imports", () => {
    expect(parseTypstImports('#import "@preview/cetz:0.2.2": *')).toEqual([]);
  });

  it("handles escaped quotes in a path", () => {
    expect(parseTypstImports('#import "we\\"ird.typ": x')).toEqual([
      'we"ird.typ',
    ]);
  });

  it("ignores non-import hashes and text mentioning import", () => {
    expect(parseTypstImports('Text about #strong("import") here')).toEqual([]);
    expect(parseTypstImports("")).toEqual([]);
  });
});

describe("normalizeRelativePath", () => {
  it("collapses . and ..", () => {
    expect(normalizeRelativePath("a/./b/../c.typ")).toBe("a/c.typ");
    expect(normalizeRelativePath("./x.typ")).toBe("x.typ");
  });

  it("refuses to escape the project root", () => {
    expect(normalizeRelativePath("../secret.typ")).toBeNull();
    expect(normalizeRelativePath("a/../../secret.typ")).toBeNull();
  });

  it("returns null for an empty result", () => {
    expect(normalizeRelativePath("")).toBeNull();
    expect(normalizeRelativePath("./")).toBeNull();
  });
});

describe("resolveTypstImport", () => {
  it("resolves relative to the importing file's directory", () => {
    expect(resolveTypstImport("parts/main.typ", "helper.typ")).toBe(
      "parts/helper.typ",
    );
    expect(resolveTypstImport("parts/main.typ", "../top.typ")).toBe("top.typ");
  });

  it("resolves a leading slash against the project root", () => {
    expect(resolveTypstImport("deep/nested/main.typ", "/lib.typ")).toBe(
      "lib.typ",
    );
  });

  it("returns null when the path escapes the root", () => {
    expect(resolveTypstImport("main.typ", "../../etc/passwd")).toBeNull();
  });
});

describe("listTypstRoots", () => {
  it("treats an un-imported file as the root", () => {
    const files = [
      typFile("main.typ", '#import "lib.typ": greet\n#greet()'),
      typFile("lib.typ", "#let greet() = [hi]"),
    ];
    expect(listTypstRoots(files).map((r) => r.targetPath)).toEqual([
      "main.typ",
    ]);
  });

  it("prefers well-known entry names when several roots exist", () => {
    const files = [
      typFile("zeta.typ", "= Z"),
      typFile("main.typ", "= M"),
      typFile("alpha.typ", "= A"),
    ];
    expect(listTypstRoots(files).map((r) => r.targetPath)).toEqual([
      "main.typ",
      "alpha.typ",
      "zeta.typ",
    ]);
  });

  it("falls back to every file when imports form a cycle", () => {
    const files = [
      typFile("a.typ", '#import "b.typ": x'),
      typFile("b.typ", '#import "a.typ": y'),
    ];
    // Neither is un-imported; returning nothing would leave the UI empty.
    expect(listTypstRoots(files)).toHaveLength(2);
  });

  it("returns nothing for a project with no typst files", () => {
    expect(listTypstRoots([])).toEqual([]);
  });

  it("resolves nested imports so a child is not listed as a root", () => {
    const files = [
      typFile("main.typ", '#import "parts/intro.typ": intro'),
      typFile("parts/intro.typ", "#let intro = [x]"),
    ];
    expect(listTypstRoots(files).map((r) => r.targetPath)).toEqual([
      "main.typ",
    ]);
  });
});

describe("typstImportedPaths", () => {
  it("collects every imported path", () => {
    const files = [
      typFile("main.typ", '#import "a.typ": x\n#include "b/c.typ"'),
      typFile("a.typ", ""),
      typFile("b/c.typ", ""),
    ];
    const imported = typstImportedPaths(files);
    expect(imported.has("a.typ")).toBe(true);
    expect(imported.has("b/c.typ")).toBe(true);
  });
});

describe("resolveTypstRoot", () => {
  it("returns the importing root for a child file", () => {
    const files = [
      typFile("main.typ", '#import "lib.typ": greet'),
      typFile("lib.typ", "#let greet() = [hi]"),
    ];
    expect(resolveTypstRoot("lib.typ", files)).toBe("main.typ");
  });

  it("returns the file itself when it is a root", () => {
    const files = [typFile("main.typ", "= Title")];
    expect(resolveTypstRoot("main.typ", files)).toBe("main.typ");
  });

  it("follows a transitive import chain", () => {
    const files = [
      typFile("main.typ", '#import "mid.typ": a'),
      typFile("mid.typ", '#import "leaf.typ": b'),
      typFile("leaf.typ", "#let b = 1"),
    ];
    expect(resolveTypstRoot("leaf.typ", files)).toBe("main.typ");
  });

  it("terminates on a cyclic import graph", () => {
    const files = [
      typFile("a.typ", '#import "b.typ": x'),
      typFile("b.typ", '#import "a.typ": y'),
    ];
    // Must not hang; any answer is acceptable as long as it returns.
    expect(typeof resolveTypstRoot("a.typ", files)).toBe("string");
  });

  it("leaves non-typst files alone", () => {
    const files = [{ ...typFile("main.tex", ""), type: "tex" } as ProjectFile];
    expect(resolveTypstRoot("main.tex", files)).toBe("main.tex");
  });
});

describe("parseTypstHeadings", () => {
  it("extracts headings with level and 1-based line", () => {
    const src = "intro\n= Top\ntext\n== Sub\n";
    expect(parseTypstHeadings(src)).toEqual([
      { level: 1, title: "Top", line: 2 },
      { level: 2, title: "Sub", line: 4 },
    ]);
  });

  it("ignores headings inside raw blocks", () => {
    const src = "```\n= Not a heading\n```\n= Real\n";
    expect(parseTypstHeadings(src)).toEqual([
      { level: 1, title: "Real", line: 4 },
    ]);
  });

  it("requires whitespace after the equals run", () => {
    expect(parseTypstHeadings("=NoSpace\n")).toEqual([]);
    expect(parseTypstHeadings("a = b\n")).toEqual([]);
  });

  it("handles an empty document", () => {
    expect(parseTypstHeadings("")).toEqual([]);
  });
});
