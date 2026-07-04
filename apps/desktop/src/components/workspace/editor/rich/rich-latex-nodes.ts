/**
 * Custom TipTap nodes for the ScholarDoc rich editor.
 *
 * These atomic nodes carry LaTeX the rich model does not natively edit:
 * - `inlineMath` / `displayMath` — rendered with KaTeX, edited via the
 *   math dialog (double-click or toolbar).
 * - `latexInline` — inline commands preserved verbatim (\cite, \ref, …),
 *   shown as a monospace chip.
 * - `latexRaw` — verbatim block LaTeX (figures, unknown environments,
 *   comment blocks) shown as a read-only source block.
 *
 * All four round-trip losslessly through `latex-rich-doc.ts`.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import katex from "katex";

function renderKatex(target: HTMLElement, latex: string, display: boolean) {
  try {
    katex.render(latex, target, {
      throwOnError: false,
      displayMode: display,
    });
  } catch {
    target.textContent = latex;
  }
}

export const InlineMath = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: { default: "" },
      delim: { default: "dollar" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-inline-math]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-inline-math": "" }),
      String(node.attrs.latex),
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "rich-math rich-math-inline";
      dom.title = String(node.attrs.latex);
      renderKatex(dom, String(node.attrs.latex), false);
      return { dom };
    };
  },
});

export const DisplayMath = Node.create({
  name: "displayMath",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: { default: "" },
      delim: { default: "bracket" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-display-math]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-display-math": "" }),
      String(node.attrs.latex),
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "rich-math rich-math-display";
      dom.title = String(node.attrs.latex);
      // Multi-line envs (align, gather) render line-by-line via aligned.
      const latex = String(node.attrs.latex);
      const delim = String(node.attrs.delim);
      const body =
        delim.startsWith("align") && !/\\begin{aligned}/.test(latex)
          ? `\\begin{aligned}${latex}\\end{aligned}`
          : latex;
      renderKatex(dom, body, true);
      return { dom };
    };
  },
});

export const LatexInline = Node.create({
  name: "latexInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { latex: { default: "" } };
  },

  parseHTML() {
    return [{ tag: "span[data-latex-inline]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-latex-inline": "" }),
      String(node.attrs.latex),
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "rich-latex-chip";
      dom.textContent = String(node.attrs.latex);
      dom.title = "LaTeX command (double-click to edit)";
      return { dom };
    };
  },
});

export const LatexRaw = Node.create({
  name: "latexRaw",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return { latex: { default: "" } };
  },

  parseHTML() {
    return [{ tag: "pre[data-latex-raw]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "pre",
      mergeAttributes(HTMLAttributes, { "data-latex-raw": "" }),
      String(node.attrs.latex),
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("pre");
      dom.className = "rich-latex-raw";
      dom.textContent = String(node.attrs.latex);
      dom.title = "Raw LaTeX block (double-click to edit)";
      return { dom };
    };
  },
});
