import { describe, expect, it } from "vitest";
import {
  analyzeSelectionBullets,
  buildBulletCountInstruction,
  bulletAdjustSummary,
  bulletCountSuccessMessage,
  bulletTargetLabel,
  clampResumeBulletCount,
  countLatexItems,
  findEnclosingBulletList,
  findRoleContextBefore,
  isResumeBulletSelection,
  suggestedBulletTargets,
} from "@/lib/resume-bullets";

const SAMPLE = `\\section{Experience}
\\entry{Engineer}{2022 -- Present}{Acme}{Remote}
\\begin{bullets}
  \\item Built APIs serving 2M users/day
  \\item Cut deploy time 40\\% with CI/CD
  \\item Mentored 3 junior engineers
\\end{bullets}`;

describe("countLatexItems", () => {
  it("counts item markers in a list", () => {
    const text = `\\begin{itemize}
  \\item First
  \\item Second
  \\item Third
\\end{itemize}`;
    expect(countLatexItems(text)).toBe(3);
  });

  it("returns 0 when no items", () => {
    expect(countLatexItems("\\section{Experience}")).toBe(0);
  });
});

describe("findEnclosingBulletList", () => {
  it("finds a custom bullets environment", () => {
    const block = findEnclosingBulletList(SAMPLE, SAMPLE.indexOf("Built"));
    expect(block).not.toBeNull();
    expect(block?.env).toBe("bullets");
    expect(block?.itemCount).toBe(3);
  });

  it("finds itemize blocks in cv templates", () => {
    const cv = `\\cventry{Role}{2020}{Co}{City}
\\begin{itemize}[leftmargin=1.5em]
  \\item One
  \\item Two
\\end{itemize}`;
    const block = findEnclosingBulletList(cv, cv.indexOf("One"));
    expect(block?.env).toBe("itemize");
    expect(block?.itemCount).toBe(2);
  });
});

describe("analyzeSelectionBullets", () => {
  it("detects partial selection inside a block", () => {
    const from = SAMPLE.indexOf("\\item Built");
    const to = SAMPLE.indexOf("CI/CD") + "CI/CD".length;
    const stats = analyzeSelectionBullets(SAMPLE, from, to);
    expect(stats.selectedCount).toBe(2);
    expect(stats.block?.itemCount).toBe(3);
    expect(stats.isPartialBlock).toBe(true);
  });

  it("is not partial when the full block is selected", () => {
    const block = findEnclosingBulletList(SAMPLE, SAMPLE.indexOf("Built"));
    expect(block).not.toBeNull();
    const stats = analyzeSelectionBullets(SAMPLE, block!.start, block!.end);
    expect(stats.selectedCount).toBe(3);
    expect(stats.isPartialBlock).toBe(false);
  });
});

describe("isResumeBulletSelection", () => {
  it("is true when selection contains items", () => {
    expect(isResumeBulletSelection("  \\item Did things")).toBe(true);
  });
});

describe("suggestedBulletTargets", () => {
  it("excludes the current count", () => {
    const targets = suggestedBulletTargets(3);
    expect(targets).not.toContain(3);
    expect(targets.length).toBeGreaterThan(0);
  });

  it("includes merge-to-1 for multi-bullet selections", () => {
    expect(suggestedBulletTargets(3)).toContain(1);
  });
});

describe("clampResumeBulletCount", () => {
  it("clamps to allowed range", () => {
    expect(clampResumeBulletCount(0)).toBe(1);
    expect(clampResumeBulletCount(9)).toBe(6);
    expect(clampResumeBulletCount(4)).toBe(4);
  });
});

describe("buildBulletCountInstruction", () => {
  it("asks to merge when reducing count", () => {
    const prompt = buildBulletCountInstruction(3, 1);
    expect(prompt).toContain("Merge");
    expect(prompt).toContain("exactly 1");
    expect(prompt).toContain("\\item");
  });

  it("asks to split when increasing count", () => {
    const prompt = buildBulletCountInstruction(2, 4);
    expect(prompt).toContain("Split");
    expect(prompt).toContain("exactly 4");
  });

  it("mentions the list environment when provided", () => {
    const prompt = buildBulletCountInstruction(3, 2, { env: "bullets" });
    expect(prompt).toContain("\\begin{bullets}");
  });
});

describe("labels", () => {
  it("uses merge wording for a single bullet", () => {
    expect(bulletTargetLabel(1)).toBe("Merge to 1");
    expect(bulletAdjustSummary(3, 1)).toBe("Merge 3 → 1");
    expect(bulletAdjustSummary(3, 4)).toBe("Split 3 → 4");
    expect(bulletCountSuccessMessage(3, 1)).toContain("Merged");
    expect(bulletCountSuccessMessage(2, 4)).toContain("Split");
  });
});

describe("findRoleContextBefore", () => {
  it("reads entry heading above bullets", () => {
    const content = `\\entry{Senior Engineer}{2022 -- Present}{Acme Corp}{Remote}
\\begin{bullets}
  \\item Built things
\\end{bullets}`;
    const block = content.indexOf("\\begin{bullets}");
    const role = findRoleContextBefore(content, block);
    expect(role?.label).toContain("Acme Corp");
    expect(role?.label).toContain("Senior Engineer");
  });
});
