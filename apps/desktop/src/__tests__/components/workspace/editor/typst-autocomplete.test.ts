import { describe, it, expect } from "vitest";
import {
  TYPST_FUNCTIONS,
  TYPST_KEYWORDS,
  TYPST_SYMBOLS,
  getTypstCompletions,
  typstCompletionSource,
} from "@/components/workspace/editor/typst-autocomplete";
import type { ProjectFile } from "@/stores/document-store";
import type { CompletionContext } from "@codemirror/autocomplete";

describe("typst-autocomplete", () => {
  describe("Built-in definitions", () => {
    it("contains essential Typst built-in functions and keywords", () => {
      const funcLabels = TYPST_FUNCTIONS.map((f) => f.label);
      expect(funcLabels).toContain("#align");
      expect(funcLabels).toContain("#grid");
      expect(funcLabels).toContain("#table");
      expect(funcLabels).toContain("#image");
      expect(funcLabels).toContain("#rect");

      const kwLabels = TYPST_KEYWORDS.map((k) => k.label);
      expect(kwLabels).toContain("#let");
      expect(kwLabels).toContain("#set");
      expect(kwLabels).toContain("#show");
      expect(kwLabels).toContain("#import");
      expect(kwLabels).toContain("#include");
    });

    it("contains mathematical and typographical symbols", () => {
      const symLabels = TYPST_SYMBOLS.map((s) => s.label);
      expect(symLabels).toContain("sym.arrow");
      expect(symLabels).toContain("sym.checkmark");
      expect(symLabels).toContain("sym.crossmark");
      expect(symLabels).toContain("sym.dots");
      expect(symLabels).toContain("sym.times");
    });
  });

  describe("getTypstCompletions with dynamic project labels", () => {
    it("filters built-in completions by query prefix", () => {
      const alignHits = getTypstCompletions("#ali");
      expect(alignHits.some((h) => h.label === "#align")).toBe(true);

      const arrowHits = getTypstCompletions("sym.arr");
      expect(arrowHits.some((h) => h.label === "sym.arrow")).toBe(true);
    });

    it("extracts dynamic Typst labels (<label>) as @label completions", () => {
      const files: ProjectFile[] = [
        {
          id: "1",
          name: "main.typ",
          relativePath: "main.typ",
          absolutePath: "/workspace/main.typ",
          type: "typst",
          isDirty: false,
          content: "= Chapter 1 <ch:one>\nSee details in <sec:details>.",
        },
      ];

      const hits = getTypstCompletions("@", files);
      expect(hits.some((h) => h.label === "@ch:one")).toBe(true);
      expect(hits.some((h) => h.label === "@sec:details")).toBe(true);
    });

    it("extracts BibTeX keys from .bib files as @bibkey completions", () => {
      const files: ProjectFile[] = [
        {
          id: "bib1",
          name: "references.bib",
          relativePath: "references.bib",
          absolutePath: "/workspace/references.bib",
          type: "bib",
          isDirty: false,
          content: [
            "@article{vaswani2017attention,",
            "  author = {Vaswani, Ashish},",
            "  title = {Attention Is All You Need},",
            "  year = {2017}",
            "}",
          ].join("\n"),
        },
      ];

      const hits = getTypstCompletions("@vas", files);
      expect(hits.some((h) => h.label === "@vaswani2017attention")).toBe(true);
    });
  });

  describe("typstCompletionSource context guards", () => {
    function createMockContext(
      fullDoc: string,
      cursorOffset: number,
      lineText: string,
      matchBeforeRegex?: (
        re: RegExp,
      ) => { from: number; to: number; text: string } | null,
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
          if (matchBeforeRegex) return matchBeforeRegex(re);
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

    it("suppresses completions inside string literals", () => {
      const line = 'let x = "#ali';
      const ctx = createMockContext(line, line.length, line);
      const result = typstCompletionSource(ctx);
      expect(result).toBeNull();
    });

    it("suppresses completions inside single-line comments", () => {
      const line = "// #ali";
      const ctx = createMockContext(line, line.length, line);
      const result = typstCompletionSource(ctx);
      expect(result).toBeNull();
    });

    it("suppresses completions inside block comments", () => {
      const doc = "/*\n #ali\n";
      const line = " #ali";
      const ctx = createMockContext(doc, doc.length, line);
      const result = typstCompletionSource(ctx);
      expect(result).toBeNull();
    });

    it("returns completions when typing #ali in valid code context", () => {
      const line = "#ali";
      const ctx = createMockContext(line, line.length, line);
      const result = typstCompletionSource(ctx);
      expect(result).not.toBeNull();
      expect(result?.options.some((o) => o.label === "#align")).toBe(true);
    });
  });
});
