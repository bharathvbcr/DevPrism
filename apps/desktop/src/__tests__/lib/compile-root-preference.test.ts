import { describe, it, expect, beforeEach } from "vitest";
import type { ProjectFile } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  collectTransitiveTexInputs,
  fileAffectsCompileRoot,
  hasPinnedCompileRoot,
  resolvePreviewCompileRoot,
  setCompileRootPreference,
} from "@/lib/compile-root-preference";

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

describe("resolvePreviewCompileRoot", () => {
  beforeEach(() => {
    useSettingsStore.setState({ compileRootByProject: {} });
  });

  const files = [
    texFile("main.tex", "main.tex", "\\documentclass{article}\n\\input{ch1}"),
    texFile("ch1.tex", "ch1.tex", "% !TEX root = main.tex\n\\section{One}"),
    texFile(
      "cover.tex",
      "cover.tex",
      "\\documentclass{letter}\n\\begin{document}Hi\\end{document}",
    ),
  ];

  it("follows the active editor when no target is pinned", () => {
    expect(
      resolvePreviewCompileRoot("/proj", "ch1.tex", files),
    ).toBe("main.tex");
  });

  it("uses the pinned preview target instead of the active editor", () => {
    setCompileRootPreference("/proj", "cover.tex");
    expect(hasPinnedCompileRoot("/proj", files)).toBe(true);
    expect(
      resolvePreviewCompileRoot("/proj", "ch1.tex", files),
    ).toBe("cover.tex");
  });
});

describe("fileAffectsCompileRoot", () => {
  const files = [
    texFile(
      "main.tex",
      "main.tex",
      "\\documentclass{article}\n\\input{ch1}\n\\bibliography{refs}",
    ),
    texFile("ch1.tex", "ch1.tex", "\\section{One}"),
    texFile(
      "cover.tex",
      "cover.tex",
      "\\documentclass{letter}\n\\begin{document}Hi\\end{document}",
    ),
    {
      id: "refs.bib",
      name: "refs.bib",
      relativePath: "refs.bib",
      absolutePath: "/proj/refs.bib",
      type: "bib" as const,
      content: "@article{a,}",
      isDirty: false,
    },
  ];

  it("detects chapter edits that belong to the pinned main document", () => {
    expect(fileAffectsCompileRoot("ch1.tex", "main.tex", files)).toBe(true);
  });

  it("ignores chapter edits when preview is pinned to an unrelated root", () => {
    expect(fileAffectsCompileRoot("ch1.tex", "cover.tex", files)).toBe(false);
  });

  it("detects bibliography edits referenced by the pinned root", () => {
    expect(fileAffectsCompileRoot("refs.bib", "main.tex", files)).toBe(true);
    expect(fileAffectsCompileRoot("refs.bib", "cover.tex", files)).toBe(false);
  });

  it("collects transitive \\input files", () => {
    expect(collectTransitiveTexInputs("main.tex", files)).toEqual(
      new Set(["main.tex", "ch1.tex"]),
    );
  });
});
