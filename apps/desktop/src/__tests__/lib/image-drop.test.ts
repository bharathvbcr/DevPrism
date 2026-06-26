import { describe, it, expect } from "vitest";
import {
  buildFigureSnippet,
  filterImagePaths,
  graphicsPackageChange,
  isDroppableImage,
  svgPackageChange,
} from "@/components/workspace/editor/image-drop";

describe("image-drop helpers", () => {
  describe("isDroppableImage / filterImagePaths", () => {
    it("accepts includable graphics extensions (case-insensitive)", () => {
      for (const p of [
        "a.png",
        "a.JPG",
        "a.jpeg",
        "a.gif",
        "a.svg",
        "a.bmp",
        "a.webp",
        "a.eps",
      ]) {
        expect(isDroppableImage(p)).toBe(true);
      }
    });

    it("rejects PDF and other non-image files", () => {
      // PDF is excluded — a dropped PDF is more likely a document to open.
      expect(isDroppableImage("paper.pdf")).toBe(false);
      expect(isDroppableImage("main.tex")).toBe(false);
      expect(isDroppableImage("refs.bib")).toBe(false);
      expect(isDroppableImage("notes")).toBe(false);
    });

    it("handles Windows and POSIX paths", () => {
      expect(isDroppableImage("C:\\Users\\me\\fig.PNG")).toBe(true);
      expect(isDroppableImage("/home/me/fig.png")).toBe(true);
    });

    it("filters a mixed list down to images, excluding pdf", () => {
      expect(
        filterImagePaths(["a.png", "b.tex", "c.pdf", "d.eps", "e.txt"]),
      ).toEqual(["a.png", "d.eps"]);
    });
  });

  describe("buildFigureSnippet", () => {
    it("emits a centered figure with caption/label derived from the name", () => {
      const snippet = buildFigureSnippet("images/my_cool-plot.png");
      expect(snippet).toContain(
        "\\includegraphics[width=0.8\\linewidth]{images/my_cool-plot.png}",
      );
      expect(snippet).toContain("\\caption{my cool plot}");
      expect(snippet).toContain("\\label{fig:my-cool-plot}");
      expect(snippet).toContain("\\centering");
      expect(snippet.startsWith("\\begin{figure}")).toBe(true);
      expect(snippet.trimEnd().endsWith("\\end{figure}")).toBe(true);
    });

    it("normalizes backslash separators to forward slashes for the path", () => {
      const snippet = buildFigureSnippet("images\\diagram.eps");
      expect(snippet).toContain("{images/diagram.eps}");
    });

    it("uses \\includesvg for svg files (not \\includegraphics)", () => {
      const snippet = buildFigureSnippet("images/logo.svg");
      expect(snippet).toContain(
        "\\includesvg[width=0.8\\linewidth]{images/logo.svg}",
      );
      expect(snippet).not.toContain("\\includegraphics");
    });

    it("falls back to a generic label when the name has no usable chars", () => {
      const snippet = buildFigureSnippet("images/___.png");
      expect(snippet).toContain("\\label{fig:figure}");
    });
  });

  describe("graphicsPackageChange", () => {
    it("inserts graphicx after \\documentclass when missing", () => {
      const src =
        "\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n";
      const change = graphicsPackageChange(src);
      expect(change).not.toBeNull();
      expect(change?.insert).toBe("\\usepackage{graphicx}\n");
      // Inserts right after the documentclass line.
      expect(change?.from).toBe("\\documentclass{article}\n".length);
    });

    it("returns null when graphicx is already loaded", () => {
      const src =
        "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\end{document}\n";
      expect(graphicsPackageChange(src)).toBeNull();
    });

    it("returns null when graphics is bundled with other packages", () => {
      const src =
        "\\documentclass{article}\n\\usepackage{amsmath,graphicx}\n\\begin{document}\n\\end{document}\n";
      expect(graphicsPackageChange(src)).toBeNull();
    });

    it("returns null for a sub-file with no local preamble", () => {
      const src = "\\section{Intro}\nSome body text without a documentclass.\n";
      expect(graphicsPackageChange(src)).toBeNull();
    });
  });

  describe("svgPackageChange", () => {
    it("inserts the svg package after \\documentclass when missing", () => {
      const src =
        "\\documentclass{article}\n\\begin{document}\n\\end{document}\n";
      const change = svgPackageChange(src);
      expect(change?.insert).toBe("\\usepackage{svg}\n");
      expect(change?.from).toBe("\\documentclass{article}\n".length);
    });

    it("returns null when the svg package is already loaded", () => {
      const src =
        "\\documentclass{article}\n\\usepackage{svg}\n\\begin{document}\n\\end{document}\n";
      expect(svgPackageChange(src)).toBeNull();
    });

    it("does not confuse graphicx for the svg package", () => {
      const src =
        "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\end{document}\n";
      expect(svgPackageChange(src)).not.toBeNull();
    });

    it("returns null for a sub-file with no local preamble", () => {
      const src = "\\section{Intro}\nbody\n";
      expect(svgPackageChange(src)).toBeNull();
    });
  });
});
