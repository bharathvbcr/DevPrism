import { describe, expect, it } from "vitest";
import {
  compileProfilesForKind,
  defaultCompileProfileForKind,
  detectCompileProfile,
} from "@/lib/compile-profiles";

describe("compileProfilesForKind", () => {
  it("puts moderncv first for resume spaces", () => {
    const ids = compileProfilesForKind("resume").map((p) => p.id);
    expect(ids[0]).toBe("moderncv");
    expect(ids).toContain("article");
  });

  it("puts ieee first for manuscript spaces", () => {
    const ids = compileProfilesForKind("manuscript").map((p) => p.id);
    expect(ids[0]).toBe("ieee");
  });

  it("includes statement profile for statement spaces", () => {
    const ids = compileProfilesForKind("statements").map((p) => p.id);
    expect(ids[0]).toBe("statement");
    expect(ids).toContain("letter");
  });

  it("defaults report spaces to report class", () => {
    expect(defaultCompileProfileForKind("report")).toBe("report");
  });
});

describe("detectCompileProfile", () => {
  it("detects statement layout", () => {
    const tex = [
      "\\documentclass[12pt]{article}",
      "\\usepackage{setspace}",
      "\\onehalfspacing",
      "\\begin{document}",
      "Hello",
      "\\end{document}",
    ].join("\n");
    expect(detectCompileProfile(tex)).toBe("statement");
  });
});
