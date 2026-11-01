import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseDocumentOutline } from "@/lib/outline-parser";
import {
  getTypstCompletions,
  typstCompletionSource,
} from "@/components/workspace/editor/typst-autocomplete";
import {
  createAutoCompileScheduler,
  getAutoCompileDebounceMs,
} from "@/lib/auto-compile";
import type { ProjectFile } from "@/stores/document-store";
import type { CompletionContext } from "@codemirror/autocomplete";

describe("Milestone 2 Adversarial Stress Testing", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. Adversarial Outline Parsing (outline-parser.ts)
  // ──────────────────────────────────────────────────────────────────────────
  describe("1. Adversarial Outline Parsing", () => {
    it("handles deeply nested LaTeX braces: \\section{A \\textbf{B \\emph{C {D} E}} F}", () => {
      const source = "\\section{A \\textbf{B \\emph{C {D} E}} F}";
      const items = parseDocumentOutline(source, "latex");
      expect(items).toHaveLength(1);
      expect(items[0].level).toBe(2);
      // Log title to inspect cleaning
      console.log("DEEPLY NESTED TITLE:", JSON.stringify(items[0].title));
      expect(items[0].title).toContain("A");
      expect(items[0].title).toContain("F");
    });

    it("handles unclosed LaTeX braces at end of file: \\section{Broken heading", () => {
      const source = "\\section{Broken heading";
      const items = parseDocumentOutline(source, "latex");
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe("Broken heading");
      expect(items[0].level).toBe(2);
    });

    it("handles unclosed LaTeX braces followed by valid heading on next line", () => {
      const source = [
        "\\section{Unclosed line without brace",
        "\\section{Valid Next Section}",
      ].join("\n");
      const items = parseDocumentOutline(source, "latex");
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(items[0].title).toContain("Unclosed line");
      expect(items[1].title).toBe("Valid Next Section");
    });

    it("strictly respects LaTeX comment immunity: % \\section{Fake}", () => {
      const source = [
        "% \\section{Fake Heading}",
        "  % \\subsection{Another Fake}",
        "\\section{Real Heading}",
      ].join("\n");
      const items = parseDocumentOutline(source, "latex");
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe("Real Heading");
    });

    it("ignores LaTeX headings preceded by inline comment: text % \\section{Fake}", () => {
      const source = "Normal text % \\section{Fake Section}";
      const items = parseDocumentOutline(source, "latex");
      expect(items).toHaveLength(0);
    });

    it("respects LaTeX verbatim immunity: \\begin{verbatim}\\section{Code}\\end{verbatim}", () => {
      const source = [
        "\\begin{verbatim}",
        "\\section{Code}",
        "\\end{verbatim}",
        "\\section{Real Section}",
      ].join("\n");
      const items = parseDocumentOutline(source, "latex");
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe("Real Section");
    });

    it("checks single-line verbatim immunity: \\begin{verbatim}\\section{Code}\\end{verbatim}", () => {
      const source = [
        "\\begin{verbatim}\\section{Code}\\end{verbatim}",
        "\\section{Real Section After Verbatim}",
      ].join("\n");
      const items = parseDocumentOutline(source, "latex");
      // Does it recover or does inVerbatim stay true?
      expect(items.some((i) => i.title === "Real Section After Verbatim")).toBe(
        true,
      );
    });

    it("handles Typst syntax extremes: = Heading <label> and == Subheading *bold*", () => {
      const source = [
        "= Heading <label>",
        "== Subheading *bold*",
        "=== Sub-subheading [link](https://typst.app)",
      ].join("\n");
      const items = parseDocumentOutline(source, "typst");
      expect(items).toHaveLength(3);
      expect(items[0].title).toBe("Heading");
      expect(items[0].level).toBe(1);
      expect(items[1].title).toBe("Subheading *bold*");
      expect(items[1].level).toBe(2);
      expect(items[2].level).toBe(3);
    });

    it("ignores Typst headings inside block comments and line comments", () => {
      const source = [
        "// = Line Commented Heading",
        "/* = Block Commented Heading */",
        "/*",
        "= Multi-line block commented heading",
        "*/",
        "= Genuine Heading",
      ].join("\n");
      const items = parseDocumentOutline(source, "typst");
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe("Genuine Heading");
    });

    it("handles Markdown #, ##, and ignores headings inside code fences", () => {
      const source = [
        "# Top Level Markdown",
        "```",
        "# Not a heading",
        "## Also not a heading",
        "```",
        "## Subheading Markdown",
      ].join("\n");
      const items = parseDocumentOutline(source, "markdown");
      expect(items).toHaveLength(2);
      expect(items[0].title).toBe("Top Level Markdown");
      expect(items[0].level).toBe(1);
      expect(items[1].title).toBe("Subheading Markdown");
      expect(items[1].level).toBe(2);
    });

    it("tests single-line code fence: ```# Not a heading```", () => {
      const source = [
        "```# Not a heading```",
        "# Real Markdown Heading After Fence",
      ].join("\n");
      const items = parseDocumentOutline(source, "markdown");
      expect(
        items.some((i) => i.title === "Real Markdown Heading After Fence"),
      ).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Adversarial Typst Autocomplete Context Guards (typst-autocomplete.ts)
  // ──────────────────────────────────────────────────────────────────────────
  describe("2. Adversarial Typst Autocomplete Context Guards", () => {
    function createMockContext(
      fullDoc: string,
      cursorOffset: number,
      lineText: string,
    ): CompletionContext {
      return {
        pos: cursorOffset,
        state: {
          doc: {
            lineAt: () => ({
              from: fullDoc.lastIndexOf("\n", cursorOffset - 1) + 1,
              to: cursorOffset,
              text: lineText,
            }),
            sliceString: (from: number, to: number) => fullDoc.slice(from, to),
          },
        },
        matchBefore: (re: RegExp) => {
          const before = lineText.slice(0, cursorOffset);
          const match = before.match(new RegExp(`${re.source}$`));
          if (!match) return null;
          return {
            from: cursorOffset - match[0].length,
            to: cursorOffset,
            text: match[0],
          };
        },
      } as unknown as CompletionContext;
    }

    it("suppresses autocomplete inside double quotes", () => {
      const doc = 'let str = "Hello #ali';
      const ctx = createMockContext(doc, doc.length, doc);
      expect(typstCompletionSource(ctx)).toBeNull();
    });

    it("suppresses autocomplete inside single-line comment: // #ali", () => {
      const doc = "// #align(center)";
      const ctx = createMockContext(doc, doc.length, doc);
      expect(typstCompletionSource(ctx)).toBeNull();
    });

    it("suppresses autocomplete inside multi-line block comment /* ... */", () => {
      const doc = "/*\n Some comment\n #grid\n";
      const line = " #grid";
      const ctx = createMockContext(doc, doc.length, line);
      expect(typstCompletionSource(ctx)).toBeNull();
    });

    it("allows autocomplete outside strings on the same line", () => {
      const doc = 'let s = "closed string"; #ali';
      const ctx = createMockContext(doc, doc.length, doc);
      const res = typstCompletionSource(ctx);
      expect(res).not.toBeNull();
      expect(res?.options.some((o) => o.label === "#align")).toBe(true);
    });

    it("evaluates whether autocomplete is falsely suppressed after a URL string containing //", () => {
      const doc = 'let url = "https://typst.app/"; #ali';
      const ctx = createMockContext(doc, doc.length, doc);
      const res = typstCompletionSource(ctx);
      // Because "https://typst.app/" has //, does textBefore.includes("//") trigger?
      // A naive textBefore.includes("//") triggers even if // is inside a closed string!
      expect(res).not.toBeNull();
      expect(res?.options.some((o) => o.label === "#align")).toBe(true);
    });

    it("evaluates whether autocomplete is suppressed on second line of multiline string", () => {
      const doc = 'let multiline = "first line\n#ali';
      const line = "#ali";
      const ctx = createMockContext(doc, doc.length, line);
      const res = typstCompletionSource(ctx);
      // Inside an unclosed multiline string literal
      expect(res).toBeNull();
    });

    it("extracts dynamic <label> completions from .typ files", () => {
      const files: ProjectFile[] = [
        {
          id: "f1",
          name: "chapter1.typ",
          relativePath: "chapter1.typ",
          absolutePath: "/project/chapter1.typ",
          type: "typst",
          isDirty: false,
          content: [
            "= Introduction <intro>",
            "== Background <sec:background_2024>",
            "Refer to <eq:euler-formula>.",
          ].join("\n"),
        },
      ];

      const completions = getTypstCompletions("@", files);
      expect(completions.some((c) => c.label === "@intro")).toBe(true);
      expect(completions.some((c) => c.label === "@sec:background_2024")).toBe(
        true,
      );
      expect(completions.some((c) => c.label === "@eq:euler-formula")).toBe(
        true,
      );
    });

    it("extracts @cite completions from .bib files", () => {
      const files: ProjectFile[] = [
        {
          id: "b1",
          name: "refs.bib",
          relativePath: "refs.bib",
          absolutePath: "/project/refs.bib",
          type: "bib",
          isDirty: false,
          content: [
            "@article{knuth1984tex,",
            "  author = {Donald E. Knuth},",
            "  title = {The TeXbook},",
            "  year = {1984}",
            "}",
            "@book{lamport1994latex,",
            "  author = {Leslie Lamport},",
            "  title = {LaTeX: A Document Preparation System},",
            "  year = {1994}",
            "}",
          ].join("\n"),
        },
      ];

      const knuthHits = getTypstCompletions("@knuth", files);
      expect(knuthHits.some((c) => c.label === "@knuth1984tex")).toBe(true);

      const lamportHits = getTypstCompletions("@lamport", files);
      expect(lamportHits.some((c) => c.label === "@lamport1994latex")).toBe(
        true,
      );
    });

    it("ignores malformed bib entries gracefully without crashing", () => {
      const files: ProjectFile[] = [
        {
          id: "b2",
          name: "broken.bib",
          relativePath: "broken.bib",
          absolutePath: "/project/broken.bib",
          type: "bib",
          isDirty: false,
          content: "@article{broken-entry\nno closing brace or comma",
        },
      ];

      expect(() => getTypstCompletions("@", files)).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Adaptive Debounce Stress (auto-compile.ts)
  // ──────────────────────────────────────────────────────────────────────────
  describe("3. Adaptive Debounce Stress", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("strictly verifies getAutoCompileDebounceMs resolution and bounds", () => {
      expect(getAutoCompileDebounceMs("typst")).toBe(120);
      expect(getAutoCompileDebounceMs("latex")).toBe(1200);
      expect(getAutoCompileDebounceMs(null)).toBe(1200);
      expect(getAutoCompileDebounceMs(undefined)).toBe(1200);

      // Floor clamping to 50ms
      expect(getAutoCompileDebounceMs("typst", 20)).toBe(50);
      expect(getAutoCompileDebounceMs("latex", -100)).toBe(50);
      expect(getAutoCompileDebounceMs("typst", 0)).toBe(50);
      expect(getAutoCompileDebounceMs("typst", 200)).toBe(200);
    });

    it("adapts dynamically to 120ms when switching from latex to typst", () => {
      const compile = vi.fn();
      const scheduler = createAutoCompileScheduler(compile);

      // Start with LaTeX (1200ms)
      scheduler.sync({
        enabled: true,
        ready: true,
        generation: 0,
        engine: "latex",
      });
      scheduler.sync({
        enabled: true,
        ready: true,
        generation: 1,
        engine: "latex",
      });

      vi.advanceTimersByTime(119);
      expect(compile).not.toHaveBeenCalled();

      // Switch to Typst (120ms) mid-stream on next edit
      scheduler.sync({
        enabled: true,
        ready: true,
        generation: 2,
        engine: "typst",
      });

      // After 119ms on Typst, still not fired
      vi.advanceTimersByTime(119);
      expect(compile).not.toHaveBeenCalled();

      // At 120ms, Typst debounce fires!
      vi.advanceTimersByTime(1);
      expect(compile).toHaveBeenCalledTimes(1);
    });

    it("prevents debounce jitter under rapid keystroke barrage (50 keystrokes @ 10ms intervals)", () => {
      const compile = vi.fn();
      const scheduler = createAutoCompileScheduler(compile);

      scheduler.sync({
        enabled: true,
        ready: true,
        generation: 0,
        engine: "typst",
      });

      // 50 rapid edits every 10ms (total 500ms elapsed)
      for (let g = 1; g <= 50; g++) {
        scheduler.sync({
          enabled: true,
          ready: true,
          generation: g,
          engine: "typst",
        });
        vi.advanceTimersByTime(10);
        // During the burst, compile MUST NEVER fire
        expect(compile).not.toHaveBeenCalled();
      }

      // After burst ends: 10ms have already elapsed since generation 50.
      // Wait another 109ms (total 119ms since last keystroke): still not fired
      vi.advanceTimersByTime(109);
      expect(compile).not.toHaveBeenCalled();

      // At 120ms after the last keystroke (1ms more): exactly 1 compile!
      vi.advanceTimersByTime(1);
      expect(compile).toHaveBeenCalledTimes(1);

      // Advance further: no additional spurious compiles
      vi.advanceTimersByTime(1000);
      expect(compile).toHaveBeenCalledTimes(1);
    });

    it("enforces 50ms floor even under aggressive override (e.g. overrideMs = 5)", () => {
      const compile = vi.fn();
      const scheduler = createAutoCompileScheduler(compile);

      scheduler.sync({
        enabled: true,
        ready: true,
        generation: 0,
        engine: "typst",
        debounceMs: 5, // Attempting sub-floor override
      });

      scheduler.sync({
        enabled: true,
        ready: true,
        generation: 1,
        engine: "typst",
        debounceMs: 5,
      });

      // At 49ms, must NOT have fired because floor is 50ms
      vi.advanceTimersByTime(49);
      expect(compile).not.toHaveBeenCalled();

      // At 50ms, fires!
      vi.advanceTimersByTime(1);
      expect(compile).toHaveBeenCalledTimes(1);
    });
  });
});
