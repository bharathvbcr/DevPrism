import { describe, it, expect } from "vitest";
import {
  parseLimitsFromTarget,
  resolveDocumentGoal,
  defaultGoalForKind,
} from "@/lib/document-goals";
import { inferSpaceKind, isSpaceKind } from "@/lib/space-features";
import { snippetsForKind } from "@/lib/latex-snippets";

describe("parseLimitsFromTarget", () => {
  it("parses explicit word limits", () => {
    expect(
      parseLimitsFromTarget("Please write a 750-word personal statement."),
    ).toEqual({ wordLimit: 750 });
  });

  it("parses word limit phrasing variants", () => {
    expect(parseLimitsFromTarget("Maximum 500 words. No exceptions.")).toEqual({
      wordLimit: 500,
    });
  });

  it("parses character limits", () => {
    expect(
      parseLimitsFromTarget(
        "Character limit: 4,000 characters including spaces.",
      ),
    ).toEqual({ charLimit: 4000 });
  });

  it("returns empty for text without limits", () => {
    expect(parseLimitsFromTarget("Describe your research interests.")).toEqual(
      {},
    );
  });
});

describe("resolveDocumentGoal", () => {
  it("prefers parsed limits over defaults", () => {
    expect(
      resolveDocumentGoal("statements", "Limit: 650 words", {
        activeFileName: "statement.tex",
      }),
    ).toEqual({ label: "Target limit", wordLimit: 650 });
  });

  it("uses statement default when no target limit", () => {
    expect(
      resolveDocumentGoal("statements", null, {
        activeFileName: "statement.tex",
      }),
    ).toEqual({ label: "Statement", wordLimit: 1000 });
  });

  it("skips manuscript abstract default on main tex files", () => {
    expect(
      resolveDocumentGoal("manuscript", null, { activeFileName: "main.tex" }),
    ).toBeNull();
  });

  it("shows manuscript abstract default on abstract files", () => {
    expect(
      resolveDocumentGoal("manuscript", null, {
        activeFileName: "abstract.tex",
      }),
    ).toEqual({ label: "Abstract", wordLimit: 250 });
  });
});

describe("inferSpaceKind", () => {
  it("recognizes report spaces by name", () => {
    expect(
      inferSpaceKind({ name: "Q4 Reports", description: "", icon: null }),
    ).toBe("report");
  });

  it("accepts the report kind explicitly", () => {
    expect(isSpaceKind("report")).toBe(true);
  });
});

describe("snippetsForKind", () => {
  it("prioritizes resume snippets for resume spaces", () => {
    const ids = snippetsForKind("resume").map((s) => s.id);
    expect(ids[0]).toBe("resume-item");
    expect(ids).toContain("itemize");
  });

  it("includes report-specific snippets", () => {
    const ids = snippetsForKind("report").map((s) => s.id);
    expect(ids).toContain("executive-summary");
    expect(ids).toContain("abstract");
  });
});

describe("defaultGoalForKind", () => {
  it("returns null for general projects", () => {
    expect(defaultGoalForKind("general")).toBeNull();
  });
});
