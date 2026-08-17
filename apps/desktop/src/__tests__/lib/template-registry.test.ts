import { describe, it, expect } from "vitest";
import {
  searchTemplates,
  getTemplateById,
  getTemplatesByCategory,
  getTemplateSkeleton,
  getAllTemplates,
} from "@/lib/template-registry";

describe("template-registry", () => {
  describe("getAllTemplates", () => {
    it("returns a non-empty array", () => {
      const all = getAllTemplates();
      expect(all.length).toBeGreaterThan(0);
    });

    it("each template has required fields", () => {
      for (const t of getAllTemplates()) {
        expect(t.id).toBeTruthy();
        expect(t.name).toBeTruthy();
        expect(t.category).toBeTruthy();
        expect(t.content).toBeTruthy();
      }
    });
  });

  describe("searchTemplates", () => {
    it("returns all templates for empty query", () => {
      expect(searchTemplates("")).toHaveLength(getAllTemplates().length);
      expect(searchTemplates("  ")).toHaveLength(getAllTemplates().length);
    });

    it("filters by keyword (case insensitive)", () => {
      const results = searchTemplates("PAPER");
      expect(results.length).toBeGreaterThan(0);
      // All results should mention paper in name, description, tags, etc.
    });

    it("supports multi-word search", () => {
      const results = searchTemplates("research paper");
      expect(results.length).toBeGreaterThan(0);
    });

    it("returns empty for nonsense query", () => {
      const results = searchTemplates("xyznonexistent123");
      expect(results).toHaveLength(0);
    });
  });

  describe("getTemplateById", () => {
    it("returns a template for a known id", () => {
      const t = getTemplateById("paper-standard");
      expect(t).toBeDefined();
      expect(t!.name).toBe("Research Paper");
    });

    it("returns undefined for unknown id", () => {
      expect(getTemplateById("nonexistent-id")).toBeUndefined();
    });
  });

  describe("getTemplatesByCategory", () => {
    it("returns only templates of the given category", () => {
      const academic = getTemplatesByCategory("academic");
      expect(academic.length).toBeGreaterThan(0);
      expect(academic.every((t) => t.category === "academic")).toBe(true);
    });

    it("returns templates for each category", () => {
      for (const cat of [
        "academic",
        "professional",
        "creative",
        "starter",
      ] as const) {
        expect(getTemplatesByCategory(cat).length).toBeGreaterThan(0);
      }
    });
  });

  describe("getTemplateSkeleton", () => {
    it("returns preamble + empty document body", () => {
      const t = getTemplateById("paper-standard")!;
      const skeleton = getTemplateSkeleton(t);
      expect(skeleton).toContain("\\documentclass");
      expect(skeleton).toContain("\\begin{document}");
      expect(skeleton).toContain("\\end{document}");
      expect(skeleton).toContain("\\mbox{}");
      // Should NOT contain the full body content from template
      expect(skeleton).not.toContain("\\maketitle");
    });

    it("returns full content if no \\begin{document} marker", () => {
      const fakeTemplate = {
        ...getTemplateById("paper-standard")!,
        content: "just some preamble without document begin",
      };
      expect(getTemplateSkeleton(fakeTemplate)).toBe(fakeTemplate.content);
    });
  });

  // Templates were authored with `\\` (a line break) where `\` (an escape) was
  // meant. The compile-time damage ranges from a stray break mid-sentence to a
  // hard error, so pin the two shapes that are never intentional. Compile
  // coverage itself lives in scripts/generate-previews.ts, which builds every
  // template with the app's own engine.
  describe("template content escaping", () => {
    it("never breaks a line straight into a comment", () => {
      // `\\%` = line break, then `%` comments out the rest of the source line.
      for (const t of getAllTemplates()) {
        expect(t.content, `${t.id} contains \\\\%`).not.toMatch(/\\\\%/);
      }
    });

    it("uses an interword space, not a break, after an abbreviation", () => {
      // `Dr.\\ Alexandra` should be `Dr.\ Alexandra`; inside a tabular cell or a
      // group the break is fatal rather than merely ugly.
      for (const t of getAllTemplates()) {
        expect(t.content, `${t.id} contains .\\\\ `).not.toMatch(
          /\.\\\\ [A-Za-z]/,
        );
      }
    });
  });
});
