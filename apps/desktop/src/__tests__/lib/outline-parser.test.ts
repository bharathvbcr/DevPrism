import { describe, it, expect } from "vitest";
import {
  parseDocumentOutline,
  buildOutlineTree,
  type OutlineItem,
} from "@/lib/outline-parser";

describe("parseDocumentOutline", () => {
  describe("Typst outline parsing", () => {
    it("parses headings at various levels", () => {
      const source = [
        "= Document Title",
        "Some introductory text.",
        "== Section One",
        "Content in section one.",
        "=== Subsection 1.1",
        "Deep content.",
        "== Section Two",
        "= Another Top Level",
      ].join("\n");

      const items = parseDocumentOutline(source, "typst");
      expect(items).toHaveLength(5);

      expect(items[0]).toMatchObject({
        title: "Document Title",
        level: 1,
        line: 1,
        type: "typst",
      });
      expect(items[1]).toMatchObject({
        title: "Section One",
        level: 2,
        line: 3,
        type: "typst",
      });
      expect(items[2]).toMatchObject({
        title: "Subsection 1.1",
        level: 3,
        line: 5,
        type: "typst",
      });
      expect(items[3]).toMatchObject({
        title: "Section Two",
        level: 2,
        line: 7,
        type: "typst",
      });
      expect(items[4]).toMatchObject({
        title: "Another Top Level",
        level: 1,
        line: 8,
        type: "typst",
      });
    });

    it("strips trailing Typst labels (<label>)", () => {
      const source =
        "= Chapter Introduction <sec:intro>\n== Background <sec:bg>";
      const items = parseDocumentOutline(source, "typst");
      expect(items).toHaveLength(2);
      expect(items[0].title).toBe("Chapter Introduction");
      expect(items[1].title).toBe("Background");
    });

    it("ignores headings inside code blocks and comments", () => {
      const source = [
        "// = Commented Heading",
        "= Real Heading",
        "```typst",
        "= Heading in code block",
        "```",
        "/*",
        "= Heading in block comment",
        "*/",
        "== Another Real Heading",
      ].join("\n");

      const items = parseDocumentOutline(source, "typst");
      expect(items).toHaveLength(2);
      expect(items[0].title).toBe("Real Heading");
      expect(items[1].title).toBe("Another Real Heading");
    });
  });

  describe("LaTeX outline parsing", () => {
    it("parses LaTeX sections, subsections, and chapters", () => {
      const source = [
        "\\chapter{Overview}",
        "\\section{Introduction}",
        "Some text...",
        "\\subsection{Background}",
        "More details...",
        "\\subsubsection{Specific Detail}",
        "\\section*{Unnumbered Section}",
      ].join("\n");

      const items = parseDocumentOutline(source, "latex");
      expect(items).toHaveLength(5);
      expect(items[0].title).toBe("Overview");
      expect(items[0].level).toBe(1); // chapter is level 1
      expect(items[1].title).toBe("Introduction");
      expect(items[1].level).toBe(2); // section is level 2
      expect(items[2].title).toBe("Background");
      expect(items[2].level).toBe(3); // subsection is level 3
      expect(items[3].title).toBe("Specific Detail");
      expect(items[3].level).toBe(4); // subsubsection is level 4
      expect(items[4].title).toBe("Unnumbered Section");
      expect(items[4].level).toBe(2);
    });

    it("handles balanced nested braces in LaTeX headings", () => {
      const source =
        "\\section{Analysis of \\textbf{Important} Results and \\emph{Trends}}";
      const items = parseDocumentOutline(source, "latex");
      expect(items).toHaveLength(1);
      expect(items[0].title).toContain("Important");
      expect(items[0].title).toContain("Results and");
      expect(items[0].title).toContain("Trends");
    });

    it("ignores headings in LaTeX comments and verbatim blocks", () => {
      const source = [
        "% \\section{Commented Out}",
        "\\section{Active Section}",
        "\\begin{verbatim}",
        "\\section{Verbatim Code}",
        "\\end{verbatim}",
        "\\subsection{Valid Subsection}",
      ].join("\n");

      const items = parseDocumentOutline(source, "latex");
      expect(items).toHaveLength(2);
      expect(items[0].title).toBe("Active Section");
      expect(items[1].title).toBe("Valid Subsection");
    });

    it("recovers gracefully on unclosed LaTeX braces", () => {
      const source =
        "\\section{Unfinished Title without closing brace\n\\section{Next Title}";
      const items = parseDocumentOutline(source, "latex");
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.some((i) => i.title.includes("Unfinished Title"))).toBe(
        true,
      );
    });
  });

  describe("Markdown outline parsing", () => {
    it("parses markdown # to ###### levels", () => {
      const source = [
        "# Top Level",
        "## Second Level",
        "### Third Level",
        "#### Fourth Level",
        "##### Fifth Level",
        "###### Sixth Level",
      ].join("\n");

      const items = parseDocumentOutline(source, "markdown");
      expect(items).toHaveLength(6);
      expect(items.map((i) => i.level)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(items[0].title).toBe("Top Level");
    });

    it("ignores headings inside markdown fenced code blocks", () => {
      const source = [
        "# Main Title",
        "```markdown",
        "# Hidden Heading",
        "```",
        "## Sub Title",
      ].join("\n");

      const items = parseDocumentOutline(source, "markdown");
      expect(items).toHaveLength(2);
      expect(items[0].title).toBe("Main Title");
      expect(items[1].title).toBe("Sub Title");
    });
  });

  describe("Edge cases", () => {
    it("returns empty array for empty or whitespace string", () => {
      expect(parseDocumentOutline("")).toEqual([]);
      expect(parseDocumentOutline("   \n\n  \t")).toEqual([]);
    });
  });
});

describe("buildOutlineTree", () => {
  it("builds a hierarchical tree from flat outline items", () => {
    const flatItems: OutlineItem[] = [
      { id: "1", title: "Chapter 1", level: 1, line: 1, pos: 0, type: "latex" },
      {
        id: "2",
        title: "Section 1.1",
        level: 2,
        line: 5,
        pos: 50,
        type: "latex",
      },
      {
        id: "3",
        title: "Subsection 1.1.1",
        level: 3,
        line: 10,
        pos: 100,
        type: "latex",
      },
      {
        id: "4",
        title: "Section 1.2",
        level: 2,
        line: 15,
        pos: 150,
        type: "latex",
      },
      {
        id: "5",
        title: "Chapter 2",
        level: 1,
        line: 20,
        pos: 200,
        type: "latex",
      },
    ];

    const tree = buildOutlineTree(flatItems);

    expect(tree).toHaveLength(2); // Chapter 1 and Chapter 2
    expect(tree[0].title).toBe("Chapter 1");
    expect(tree[0].children).toHaveLength(2); // Section 1.1 and Section 1.2

    expect(tree[0].children[0].title).toBe("Section 1.1");
    expect(tree[0].children[0].children).toHaveLength(1); // Subsection 1.1.1
    expect(tree[0].children[0].children[0].title).toBe("Subsection 1.1.1");

    expect(tree[0].children[1].title).toBe("Section 1.2");
    expect(tree[0].children[1].children).toHaveLength(0);

    expect(tree[1].title).toBe("Chapter 2");
    expect(tree[1].children).toHaveLength(0);
  });

  it("handles empty items gracefully", () => {
    expect(buildOutlineTree([])).toEqual([]);
  });
});
