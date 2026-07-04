import { describe, expect, it } from "vitest";
import {
  escapeLatexText,
  latexToRichDoc,
  richDocToLatex,
  type RichNode,
} from "@/lib/rich-editor/latex-rich-doc";

const DOC = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}

\section{Introduction}

This is \textbf{bold} and \textit{italic} text with math $E = mc^2$ inline.

\subsection{Methods}

We cite \cite{smith2020} here.

\begin{itemize}
  \item First point
  \item Second \textbf{important} point
\end{itemize}

\[
\alpha + \beta = \gamma
\]

\begin{tabular}{ll}
Name & Value \\
Alpha & 1 \\
\end{tabular}

\begin{figure}
  \includegraphics{plot.png}
\end{figure}

\end{document}
`;

function findAll(node: RichNode, type: string): RichNode[] {
  const out: RichNode[] = [];
  if (node.type === type) out.push(node);
  for (const child of node.content ?? []) out.push(...findAll(child, type));
  return out;
}

describe("latexToRichDoc", () => {
  const parsed = latexToRichDoc(DOC);

  it("splits preamble and postamble verbatim", () => {
    expect(parsed.preamble).toContain("\\documentclass{article}");
    expect(parsed.preamble.endsWith("\\begin{document}")).toBe(true);
    expect(parsed.postamble.startsWith("\\end{document}")).toBe(true);
  });

  it("parses headings with levels", () => {
    const headings = findAll(parsed.doc, "heading");
    expect(headings).toHaveLength(2);
    expect(headings[0].attrs?.level).toBe(1);
    expect(headings[0].content?.[0].text).toBe("Introduction");
    expect(headings[1].attrs?.level).toBe(2);
  });

  it("parses bold/italic marks and inline math", () => {
    const texts = findAll(parsed.doc, "text");
    const bold = texts.find((t) => t.text === "bold");
    expect(bold?.marks?.[0].type).toBe("bold");
    const italic = texts.find((t) => t.text === "italic");
    expect(italic?.marks?.[0].type).toBe("italic");
    const math = findAll(parsed.doc, "inlineMath");
    expect(math[0].attrs?.latex).toBe("E = mc^2");
  });

  it("preserves unknown commands as inline chips", () => {
    const chips = findAll(parsed.doc, "latexInline");
    expect(chips.some((c) => c.attrs?.latex === "\\cite{smith2020}")).toBe(
      true,
    );
  });

  it("parses itemize into bulletList", () => {
    const lists = findAll(parsed.doc, "bulletList");
    expect(lists).toHaveLength(1);
    expect(lists[0].content).toHaveLength(2);
  });

  it("parses display math", () => {
    const math = findAll(parsed.doc, "displayMath");
    expect(math).toHaveLength(1);
    expect(math[0].attrs?.latex).toContain("\\alpha + \\beta");
  });

  it("parses simple tabular into a table with header row", () => {
    const tables = findAll(parsed.doc, "table");
    expect(tables).toHaveLength(1);
    expect(findAll(tables[0], "tableHeader")).toHaveLength(2);
    expect(findAll(tables[0], "tableCell")).toHaveLength(2);
  });

  it("keeps unknown environments as raw blocks", () => {
    const raw = findAll(parsed.doc, "latexRaw");
    expect(
      raw.some((r) => String(r.attrs?.latex).includes("\\begin{figure}")),
    ).toBe(true);
    expect(
      raw.some((r) => String(r.attrs?.latex).includes("\\end{figure}")),
    ).toBe(true);
  });

  it("handles fragment files without a document environment", () => {
    const frag = latexToRichDoc("Just a \\textbf{fragment}.");
    expect(frag.preamble).toBe("");
    expect(frag.postamble).toBe("");
    expect(findAll(frag.doc, "paragraph")).toHaveLength(1);
  });
});

describe("richDocToLatex round trip", () => {
  it("round-trips semantically: reparse of serialized output matches", () => {
    const parsed = latexToRichDoc(DOC);
    const serialized = richDocToLatex(parsed);
    const reparsed = latexToRichDoc(serialized);
    // Stable fixpoint: serialize(parse(x)) == serialize(parse(serialize(parse(x))))
    expect(richDocToLatex(reparsed)).toBe(serialized);
  });

  it("preserves key constructs through the round trip", () => {
    const out = richDocToLatex(latexToRichDoc(DOC));
    expect(out).toContain("\\section{Introduction}");
    expect(out).toContain("\\textbf{bold}");
    expect(out).toContain("$E = mc^2$");
    expect(out).toContain("\\cite{smith2020}");
    expect(out).toContain("\\begin{itemize}");
    expect(out).toContain("\\begin{tabular}");
    expect(out).toContain("\\includegraphics{plot.png}");
    expect(out).toContain("\\end{document}");
  });

  it("serializes math env delimiters back to their environment", () => {
    const src = "\\begin{align}\na &= b\n\\end{align}";
    const out = richDocToLatex(latexToRichDoc(src));
    expect(out).toContain("\\begin{align}");
    expect(out).toContain("\\end{align}");
  });
});

describe("escapeLatexText", () => {
  it("escapes LaTeX specials without double-escaping", () => {
    expect(escapeLatexText("50% & more_fun #1 $5")).toBe(
      "50\\% \\& more\\_fun \\#1 \\$5",
    );
    expect(escapeLatexText("a\\b")).toBe("a\\textbackslash{}b");
    expect(escapeLatexText("{x}")).toBe("\\{x\\}");
  });
});
