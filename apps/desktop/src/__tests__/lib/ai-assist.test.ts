import { describe, it, expect } from "vitest";
import {
  extractGrammarSpan,
  extractProseContext,
  parseCompileErrorLine,
  lineOffsets,
} from "@/lib/ai-assist";

describe("extractProseContext", () => {
  it("returns prose prefix when cursor is in body text", () => {
    const doc = "\\section{Intro}\nWe built a system that ";
    const { prefix, inProse } = extractProseContext(doc, doc.length);
    expect(inProse).toBe(true);
    expect(prefix).toContain("We built a system that");
  });

  it("skips when cursor is inside a command name", () => {
    const doc = "Hello \\textbf";
    const { inProse } = extractProseContext(doc, doc.length);
    expect(inProse).toBe(false);
  });
});

describe("extractGrammarSpan", () => {
  it("returns the current line for prose", () => {
    const doc = "Line one\nThis sentance has a typo\nLine three";
    const pos = doc.indexOf("sentance");
    const span = extractGrammarSpan(doc, pos);
    expect(span?.text).toContain("sentance");
    expect(span?.from).toBe(doc.indexOf("This"));
  });

  it("ignores LaTeX structure lines", () => {
    const doc = "\\section{Methods}\n";
    const span = extractGrammarSpan(doc, 5);
    expect(span).toBeNull();
  });
});

describe("parseCompileErrorLine", () => {
  it("parses l.NN from LaTeX logs", () => {
    expect(parseCompileErrorLine("! Undefined control sequence. l.42 \\foo")).toBe(
      42,
    );
    expect(parseCompileErrorLine("no line here")).toBeNull();
  });
});

describe("lineOffsets", () => {
  it("returns character range for a 1-based line", () => {
    const doc = "one\ntwo\nthree";
    const span = lineOffsets(doc, 2);
    expect(span?.text).toBe("two");
    expect(doc.slice(span!.from, span!.to)).toBe("two");
  });
});
