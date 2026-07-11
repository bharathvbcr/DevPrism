/** Markdown / Obsidian wiki chunker (heading-aware). */

import { chunkSections, type TextSection } from "./chunking";
import type { PreparedChunk } from "../types";

export interface MarkdownChunkOptions {
  sourceTitle: string;
  date?: string;
  /** When true (default), strip YAML frontmatter and simplify wikilinks. */
  obsidian?: boolean;
}

/**
 * Split markdown into heading-scoped sections, then pack into ~200–400 token
 * overlapping chunks. `meta.headingPath` mirrors the ATX heading stack.
 */
export function chunkMarkdown(
  markdown: string,
  options: MarkdownChunkOptions,
): PreparedChunk[] {
  const obsidian = options.obsidian !== false;
  let body = markdown;
  let date = options.date;

  if (obsidian) {
    const fm = stripFrontmatter(body);
    body = fm.body;
    if (!date && fm.date) date = fm.date;
    body = simplifyObsidian(body);
  }

  const sections = splitByHeadings(body);
  return chunkSections(sections, {
    sourceTitle: options.sourceTitle,
    date,
  });
}

/** Remove YAML frontmatter; pull `date` / `updated` when present. */
export function stripFrontmatter(text: string): {
  body: string;
  date?: string;
} {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: text };
  const yaml = m[1] ?? "";
  const dateMatch = yaml.match(
    /^(?:date|updated|created)\s*:\s*["']?([^\n"']+)/m,
  );
  return {
    body: text.slice(m[0].length),
    date: dateMatch?.[1]?.trim(),
  };
}

/** `[[page|alias]]` → alias; `[[page]]` → page; strip `#tags` lightly. */
export function simplifyObsidian(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/(^|\s)#[\w/-]+/g, "$1");
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

export function splitByHeadings(markdown: string): TextSection[] {
  const lines = markdown.split(/\r?\n/);
  const stack: { level: number; title: string }[] = [];
  const sections: TextSection[] = [];
  let buf: string[] = [];
  let currentPath: string[] = [];

  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (!text) return;
    sections.push({ headingPath: [...currentPath], text });
  };

  for (const line of lines) {
    const hm = line.match(HEADING_RE);
    if (hm) {
      flush();
      const level = hm[1]!.length;
      const title = hm[2]!.replace(/#+$/, "").trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }
      stack.push({ level, title });
      currentPath = stack.map((s) => s.title);
      continue;
    }
    buf.push(line);
  }
  flush();

  // Preamble with no headings
  if (sections.length === 0 && markdown.trim()) {
    sections.push({ headingPath: [], text: markdown.trim() });
  }
  return sections;
}
