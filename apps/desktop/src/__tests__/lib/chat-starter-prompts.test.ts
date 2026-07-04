import { describe, expect, it } from "vitest";
import {
  buildChatStarterPrompts,
  countUnresolvedCitations,
  lastOutlineSectionTitle,
} from "@/lib/chat-starter-prompts";
import type { ProjectFile } from "@/stores/document-store";

function texFile(name: string, content: string): ProjectFile {
  return {
    id: name,
    name,
    relativePath: name,
    absolutePath: `/proj/${name}`,
    type: "tex",
    content,
    isDirty: false,
  };
}

function bibFile(name: string, content: string): ProjectFile {
  return {
    id: name,
    name,
    relativePath: name,
    absolutePath: `/proj/${name}`,
    type: "bib",
    content,
    isDirty: false,
  };
}

describe("lastOutlineSectionTitle", () => {
  it("returns the last section heading title", () => {
    const content = String.raw`\section{Intro}
Some text.
\subsection{Methods}
More text.`;
    expect(lastOutlineSectionTitle(content)).toBe("Methods");
  });
});

describe("countUnresolvedCitations", () => {
  it("counts cite keys missing from bib files", () => {
    const files = [
      texFile("main.tex", String.raw`\cite{known, missing}`),
      bibFile("refs.bib", "@article{known,\n  title={X}\n}"),
    ];
    expect(countUnresolvedCitations(files)).toBe(1);
  });
});

describe("buildChatStarterPrompts", () => {
  it("prioritizes compile errors and section-aware summarize", () => {
    const prompts = buildChatStarterPrompts({
      activeFileName: "chapter2.tex",
      activeFileContent: String.raw`\section{Results}`,
      compileError: "! Undefined control sequence.\n! Missing $ inserted.",
      files: [texFile("chapter2.tex", ""), bibFile("refs.bib", "")],
    });
    expect(prompts[0]).toMatch(/compile errors/i);
    expect(prompts.some((p) => p.includes("Results"))).toBe(true);
  });

  it("suggests fixing unresolved citations when count is known", () => {
    const files = [
      texFile("main.tex", String.raw`\cite{bad}`),
      bibFile("refs.bib", "@article{good,\n  title={X}\n}"),
    ];
    const prompts = buildChatStarterPrompts({
      activeFileName: "main.tex",
      activeFileContent: files[0].content ?? "",
      compileError: null,
      files,
    });
    expect(prompts.some((p) => p.includes("unresolved citation"))).toBe(true);
  });
});
