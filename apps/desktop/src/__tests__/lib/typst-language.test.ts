import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { syntaxTree } from "@codemirror/language";
import { typstStreamLanguage } from "@/lib/editor/typst-language";

/**
 * Tokenize `src` and return `[text, cssClasses]` pairs for the spans the
 * highlighter actually emits. Drives the real CodeMirror pipeline rather than
 * poking the parser directly, so this covers state handling too.
 */
/**
 * Explicit tag→name map. `classHighlighter` has no entry for modifiers like
 * `function(variableName)`, so it would silently report the base tag and hide
 * whether the tokenTable mapping actually took effect.
 */
const highlighter = tagHighlighter([
  { tag: tags.comment, class: "comment" },
  { tag: tags.string, class: "string" },
  { tag: tags.special(tags.string), class: "string-special" },
  { tag: tags.heading, class: "heading" },
  { tag: tags.list, class: "list" },
  { tag: tags.strong, class: "strong" },
  { tag: tags.emphasis, class: "emphasis" },
  { tag: tags.labelName, class: "labelName" },
  { tag: tags.escape, class: "escape" },
  { tag: tags.keyword, class: "keyword" },
  { tag: tags.function(tags.variableName), class: "function" },
  { tag: tags.variableName, class: "variableName" },
  { tag: tags.number, class: "number" },
  { tag: tags.bracket, class: "bracket" },
  { tag: tags.operator, class: "operator" },
]);

function tokens(src: string): Array<[string, string]> {
  const state = EditorState.create({
    doc: src,
    extensions: [typstStreamLanguage],
  });
  const tree = syntaxTree(state);
  const out: Array<[string, string]> = [];
  highlightTree(tree, highlighter, (from, to, classes) => {
    out.push([src.slice(from, to), classes]);
  });
  return out;
}

function classesFor(src: string, text: string): string {
  return (
    tokens(src)
      .filter(([t]) => t === text)
      .map(([, c]) => c)
      .join(" ") || ""
  );
}

describe("typst stream language", () => {
  it("highlights line and block comments", () => {
    expect(classesFor("// note\n", "// note")).toContain("comment");
    expect(classesFor("/* note */\n", "/* note */")).toContain("comment");
  });

  it("handles nested block comments without leaking", () => {
    const src = "/* a /* b */ c */\n= Heading\n";
    // The heading after a correctly-closed nested comment must still parse.
    expect(classesFor(src, "= ")).toContain("heading");
  });

  it("highlights headings only at line start", () => {
    expect(classesFor("= Title\n", "= ")).toContain("heading");
    expect(classesFor("a = b\n", "= ")).toBe("");
  });

  it("highlights strong and emphasis in markup", () => {
    expect(classesFor("*bold*\n", "*bold*")).toContain("strong");
    expect(classesFor("_em_\n", "_em_")).toContain("emphasis");
  });

  it("treats a raw block as a string and suppresses markup inside", () => {
    const src = "```\n= not a heading\n```\n";
    expect(classesFor(src, "= not a heading")).toContain("string");
  });

  it("highlights keywords and function calls in code mode", () => {
    expect(classesFor("#let x = 1\n", "#let")).toContain("keyword");
    expect(classesFor('#strong("hi")\n', "#strong")).toContain("function");
  });

  it("treats a quoted argument as a string", () => {
    expect(classesFor('#strong("hi")\n', '"hi"')).toContain("string");
  });

  it("does not treat markup specials inside a string as markup", () => {
    // The whole literal is one string token — no strong/emphasis inside.
    const src = '#text("*not bold* _not em_")\n';
    const stringTokens = tokens(src).filter(([, c]) => c.includes("string"));
    expect(stringTokens.some(([t]) => t.includes("*not bold*"))).toBe(true);
    expect(classesFor(src, "*not bold*")).toBe("");
  });

  it("highlights lengths as numbers", () => {
    expect(classesFor("#set page(margin: 0.7in)\n", "0.7in")).toContain(
      "number",
    );
  });

  it("recovers to markup mode after a blank line", () => {
    const src = "#let x = 1\n\n*bold*\n";
    expect(classesFor(src, "*bold*")).toContain("strong");
  });

  it("does not throw on an empty or pathological document", () => {
    expect(() => tokens("")).not.toThrow();
    expect(() => tokens("#".repeat(500))).not.toThrow();
    expect(() => tokens("/*".repeat(200))).not.toThrow();
    expect(() => tokens("`".repeat(200))).not.toThrow();
  });

  it("always advances the stream so tokenizing terminates", () => {
    // A parser that returns without consuming input hangs CodeMirror.
    for (const src of ["@", "<", "$", "\\", "#", "}", ")", "]"]) {
      expect(() => tokens(`${src}\n`)).not.toThrow();
    }
  });
});
