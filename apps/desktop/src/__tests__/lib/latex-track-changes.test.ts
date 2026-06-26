import { describe, it, expect } from "vitest";
import { wordDiff } from "@/lib/word-diff";
import {
  applyTrackChangesMarkup,
  applyWordTrackChangesLine,
  buildTrackedFragment,
  buildTrackedTexFile,
  buildTrackChangesReport,
  injectTrackChangesPackages,
  isPlainLatexText,
  pickTrackedCompileTarget,
  wrapAddedLine,
  wrapDeletedLine,
} from "@/lib/latex-track-changes";

/** Count unescaped `{` minus `}` ignoring everything after an unescaped `%`
 * (a comment) per line — a quick proxy for "would TeX see balanced braces". */
function braceBalance(tex: string): number {
  let balance = 0;
  for (const line of tex.split("\n")) {
    const code = line.replace(/(?<!\\)%.*$/, "");
    for (let i = 0; i < code.length; i++) {
      const c = code[i];
      if (c === "\\") {
        i++; // skip the escaped next char
        continue;
      }
      if (c === "{") balance++;
      else if (c === "}") balance--;
    }
  }
  return balance;
}

describe("wordDiff", () => {
  it("marks changed words inline while preserving spaces", () => {
    const parts = wordDiff("Hello world", "Hello brave world");
    expect(parts.some((p) => p.type === "add" && p.text === "brave")).toBe(
      true,
    );
    expect(parts.some((p) => p.type === "context" && p.text === "Hello")).toBe(
      true,
    );
  });
});

describe("latex-track-changes", () => {
  it("wraps deleted and added lines for PDF markup", () => {
    expect(wrapDeletedLine("old text")).toBe(
      "\\textcolor{trackdel}{\\sout{old text}}",
    );
    expect(wrapAddedLine("new text")).toBe("\\textcolor{trackadd}{new text}");
  });

  it("applies word-level markup within a single edited line", () => {
    const out = applyWordTrackChangesLine(
      "The quick brown fox",
      "The very quick brown fox",
    );
    expect(out).toContain("\\textcolor{trackadd}{very}");
    expect(out).toContain("quick brown fox");
  });

  it("uses word-level markup by default for modified files", () => {
    const out = applyTrackChangesMarkup("a\nb\nc", "a\nB\nc");
    expect(out).toContain("\\sout{b}");
    expect(out).toContain("\\textcolor{trackadd}{B}");
    expect(out.split("\n").length).toBe(3);
  });

  it("falls back to line-level markup when requested", () => {
    const out = applyTrackChangesMarkup("a\nb\nc", "a\nB\nc", "line");
    expect(out).toContain("\\sout{b}");
    expect(out).toContain("\\textcolor{trackadd}{B}");
    expect(out.split("\n").length).toBe(4);
  });

  it("injects ulem and xcolor after documentclass", () => {
    const src = "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n";
    const out = injectTrackChangesPackages(src);
    expect(out).toContain("\\usepackage[normalem]{ulem}");
    expect(out).toContain("\\definecolor{trackdel}");
    expect(out.indexOf("\\documentclass")).toBeLessThan(
      out.indexOf("\\usepackage[normalem]{ulem}"),
    );
  });

  it("builds a tracked standalone tex file", () => {
    const diff = {
      filePath: "main.tex",
      status: "modified" as const,
      oldContent:
        "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
      newContent:
        "\\documentclass{article}\n\\begin{document}\nHello world\n\\end{document}\n",
    };
    const out = buildTrackedTexFile(diff);
    expect(out).toContain("\\usepackage[normalem]{ulem}");
    expect(out).toContain("\\textcolor{trackadd}{world}");
  });

  it("marks all lines added for new files", () => {
    const out = buildTrackedFragment({
      filePath: "new.tex",
      status: "added",
      oldContent: null,
      newContent: "line one\nline two",
    });
    expect(out).toContain("\\textcolor{trackadd}{line one}");
    expect(out).toContain("\\textcolor{trackadd}{line two}");
  });

  it("builds a multi-file report", () => {
    const report = buildTrackChangesReport(
      [
        {
          filePath: "main.tex",
          status: "modified",
          oldContent: "a",
          newContent: "b",
        },
      ],
      { fromLabel: "v1", toLabel: "v2" },
    );
    expect(report).toContain("\\documentclass{article}");
    expect(report).toContain("Comparing");
    expect(report).toContain("main.tex");
    expect(report).toContain("\\textcolor{trackadd}{b}");
  });

  // --- LaTeX compile-safety regressions (adversarial-review findings 1-6) ---

  it("isPlainLatexText flags LaTeX specials", () => {
    expect(isPlainLatexText("just words and, punctuation!")).toBe(true);
    for (const s of ["a%b", "\\textbf{x}", "$x$", "a&b", "a_b", "a^b", "a#b", "a~b", "{x}"]) {
      expect(isPlainLatexText(s)).toBe(false);
    }
  });

  it("keeps braces balanced when an edit touches part of a \\textbf{...} group", () => {
    // Finding #1: whitespace tokenization used to split \textbf{quick brown}.
    const out = applyTrackChangesMarkup(
      "the \\textbf{quick brown} fox",
      "the \\textbf{quick lazy} fox",
    );
    expect(braceBalance(out)).toBe(0);
    // The fragile command line is emitted verbatim, never split into \sout{\textbf...}.
    expect(out).toContain("\\textbf{quick lazy}");
    expect(out).not.toMatch(/\\sout\{[^}]*\\textbf/);
  });

  it("does not let a % comment swallow the wrapper's closing braces", () => {
    // Finding #2: `draft % todo` must not become \sout{draft % todo}} (}} commented out).
    const out = applyTrackChangesMarkup("draft text", "draft text % todo");
    expect(braceBalance(out)).toBe(0);
    expect(out).not.toMatch(/\\sout\{[^\n]*%/);
    expect(out).not.toMatch(/\\textcolor\{trackadd\}\{[^\n]*%/);
  });

  it("does not wrap inline math in \\sout / split $...$ across spans", () => {
    // Findings #3/#4: `$a + b$` -> `$a + c$` must stay brace/`$`-balanced.
    const out = applyTrackChangesMarkup("value $a + b$ end", "value $a + c$ end");
    expect(braceBalance(out)).toBe(0);
    expect(out).not.toMatch(/\\sout\{[^}]*\$/);
    expect(out).toContain("$a + c$");
  });

  it("never wraps a deleted structural/tabular line in \\sout", () => {
    // Finding #3: a deleted `a & b \\\\` row inside \sout breaks compilation.
    const out = buildTrackedFragment({
      filePath: "t.tex",
      status: "deleted",
      oldContent: "row one & two \\\\\nplain removed line",
      newContent: null,
    });
    expect(braceBalance(out)).toBe(0);
    // Structural line is preserved as a comment, not struck.
    expect(out).not.toMatch(/\\sout\{[^}]*&/);
    expect(out).toContain("% [deleted] row one & two");
    // Plain deleted line still gets struck through.
    expect(out).toContain("\\sout{plain removed line}");
  });

  it("merges file-local preamble macros into the multi-file report", () => {
    // Finding #5: a body macro defined in a file's own preamble must resolve.
    const report = buildTrackChangesReport(
      [
        {
          filePath: "a.tex",
          status: "modified",
          oldContent:
            "\\documentclass{article}\n\\newcommand{\\foo}{bar}\n\\begin{document}\nold\n\\end{document}",
          newContent:
            "\\documentclass{article}\n\\newcommand{\\foo}{bar}\n\\begin{document}\nnew \\foo\n\\end{document}",
        },
      ],
      { fromLabel: "v1", toLabel: "v2" },
    );
    expect(report).toContain("\\newcommand{\\foo}{bar}");
    // The macro line is in the preamble (before \begin{document}).
    expect(report.indexOf("\\newcommand{\\foo}{bar}")).toBeLessThan(
      report.indexOf("\\begin{document}"),
    );
  });

  // --- Pass-2 regression fixes ---

  it("keeps a deletion trace when a modified command line isn't plain (word mode)", () => {
    // Pass-2 #1: word path used to emit only the new line verbatim, losing the deletion.
    const out = applyTrackChangesMarkup("\\section{Old}", "\\section{New}");
    expect(out).toContain("% [deleted] \\section{Old}");
    expect(out).toContain("\\section{New}");
    expect(braceBalance(out)).toBe(0);
  });

  it("does not re-load ulem/xcolor when the document's preamble already has them", () => {
    // Pass-2 #2: avoid 'Option clash for package ulem'.
    const diff = {
      filePath: "main.tex",
      status: "modified" as const,
      oldContent:
        "\\documentclass{article}\n\\usepackage{ulem}\n\\usepackage[table]{xcolor}\n\\begin{document}\nHello\n\\end{document}",
      newContent:
        "\\documentclass{article}\n\\usepackage{ulem}\n\\usepackage[table]{xcolor}\n\\begin{document}\nHello world\n\\end{document}",
    };
    const out = buildTrackedTexFile(diff);
    // ulem/xcolor each loaded exactly once (the document's own load).
    expect(out.match(/\\usepackage(\[[^\]]*\])?\{ulem\}/g)?.length).toBe(1);
    expect(out.match(/\\usepackage(\[[^\]]*\])?\{xcolor\}/g)?.length).toBe(1);
    // track colors are still defined.
    expect(out).toContain("\\definecolor{trackdel}");
  });

  it("still loads ulem/xcolor when the source only COMMENTS them out (pass-3)", () => {
    // A commented '% \usepackage{ulem}' must not suppress the real load, or
    // \sout becomes undefined and the tracked file won't compile.
    const diff = {
      filePath: "main.tex",
      status: "modified" as const,
      oldContent:
        "\\documentclass{article}\n% \\usepackage{ulem}\n%\\usepackage{xcolor}\n\\begin{document}\nHello\n\\end{document}",
      newContent:
        "\\documentclass{article}\n% \\usepackage{ulem}\n%\\usepackage{xcolor}\n\\begin{document}\nHello world\n\\end{document}",
    };
    const out = buildTrackedTexFile(diff);
    expect(out).toContain("\\usepackage[normalem]{ulem}");
    expect(out).toContain("\\usepackage{xcolor}");
  });

  it("dedupes report macros by name (no duplicate \\newcommand of the same name)", () => {
    // Pass-2 #4: two files defining \note differently must not double-define it.
    const report = buildTrackChangesReport(
      [
        {
          filePath: "a.tex",
          status: "modified",
          oldContent:
            "\\documentclass{article}\n\\newcommand{\\note}[1]{\\textbf{#1}}\n\\begin{document}\nA\n\\end{document}",
          newContent:
            "\\documentclass{article}\n\\newcommand{\\note}[1]{\\textbf{#1}}\n\\begin{document}\nA1\n\\end{document}",
        },
        {
          filePath: "b.tex",
          status: "modified",
          oldContent:
            "\\documentclass{article}\n\\newcommand{\\note}[1]{\\emph{#1}}\n\\begin{document}\nB\n\\end{document}",
          newContent:
            "\\documentclass{article}\n\\newcommand{\\note}[1]{\\emph{#1}}\n\\begin{document}\nB1\n\\end{document}",
        },
      ],
      { fromLabel: "v1", toLabel: "v2" },
    );
    expect(report.match(/\\newcommand\{\\note\}/g)?.length).toBe(1);
  });

  it("escapes a backslash in a report label without mangling it into \\{}", () => {
    // Pass-2 #3: escapeLatexText must not double-escape its own braces.
    const report = buildTrackChangesReport(
      [{ filePath: "a.tex", status: "modified", oldContent: "x", newContent: "y" }],
      { fromLabel: "C:\\Users\\me", toLabel: "v2" },
    );
    expect(report).toContain("\\textbackslash{}");
    expect(report).not.toContain("\\textbackslash\\{\\}");
  });

  it("prefers main.tex as compile target", () => {
    const target = pickTrackedCompileTarget([
      {
        filePath: "chapter.tex",
        status: "modified",
        oldContent: "\\documentclass{article}\n",
        newContent: "\\documentclass{article}\n\\begin{document}\nx\\end{document}",
      },
      {
        filePath: "main.tex",
        status: "modified",
        oldContent: "\\documentclass{article}\n",
        newContent: "\\documentclass{article}\n\\begin{document}\ny\\end{document}",
      },
    ]);
    expect(target?.filePath).toBe("main.tex");
  });
});
