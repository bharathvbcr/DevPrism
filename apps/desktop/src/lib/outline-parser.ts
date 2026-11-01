export type DocumentLanguage = "typst" | "latex" | "markdown";

export interface OutlineItem {
  id: string;
  title: string;
  level: number;
  line: number;
  pos: number;
  type: DocumentLanguage;
}

export interface OutlineNode extends OutlineItem {
  children: OutlineNode[];
}

const LATEX_LEVEL_MAP: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

function cleanLatexTitle(raw: string): string {
  let cleaned = raw;
  let prev = "";
  let iterations = 0;
  while (cleaned !== prev && iterations < 10) {
    prev = cleaned;
    iterations++;
    // Unwrap innermost macros with an argument: \foo{bar} -> bar
    cleaned = cleaned.replace(
      /\\[a-zA-Z]+\*?\{([^{}]*)\}/g,
      (_m, inner) => ` ${inner} `,
    );
    // Unwrap unescaped innermost plain grouping braces: {bar} -> bar
    cleaned = cleaned.replace(/(?<!\\[a-zA-Z]*)(?<!\\)\{([^{}]*)\}/g, " $1 ");
  }
  // Remove remaining parameterless macros: \foo* or \foo
  cleaned = cleaned.replace(/\\[a-zA-Z]+\*?/g, "");
  return cleaned.replace(/\s+/g, " ").trim();
}

function stripLatexComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "%") {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && line[j] === "\\") {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

/**
 * Extract LaTeX heading title with balanced brace matching.
 * Handles nested formatting like \section{Title with \textbf{bold} text}
 * and gracefully recovers on unclosed braces.
 */
function extractBalancedLatexTitle(str: string): {
  title: string;
  length: number;
} {
  let depth = 0;
  let title = "";
  let started = false;
  let i = 0;

  for (; i < str.length; i++) {
    const char = str[i];
    let backslashCount = 0;
    let j = i - 1;
    while (j >= 0 && str[j] === "\\") {
      backslashCount++;
      j--;
    }
    const isEscaped = backslashCount % 2 === 1;

    if (char === "{" && !isEscaped && !started) {
      started = true;
      depth = 1;
      continue;
    }
    if (!started) continue;

    if (char === "{" && !isEscaped) {
      depth++;
      title += char;
    } else if (char === "}" && !isEscaped) {
      depth--;
      if (depth === 0) {
        break;
      }
      title += char;
    } else {
      title += char;
    }
  }

  // Clean common LaTeX macros from heading title for display
  const cleaned = cleanLatexTitle(title);

  return { title: cleaned || title.trim(), length: i + 1 };
}

/**
 * Pure parser for Typst, LaTeX, and Markdown document outlines.
 */
export function parseDocumentOutline(
  source: string,
  type: DocumentLanguage = "latex",
): OutlineItem[] {
  if (!source || !source.trim()) {
    return [];
  }

  const lines = source.split("\n");
  const items: OutlineItem[] = [];
  let inCodeBlock = false;
  let inBlockComment = false;
  let inVerbatim = false;
  let currentOffset = 0;

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const lineOffset = currentOffset;
    currentOffset += line.length + 1; // +1 for \n

    const trimmed = line.trim();

    // 1. Handle code blocks (Typst / Markdown)
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const fence = trimmed.startsWith("```") ? "```" : "~~~";
      if (!inCodeBlock && trimmed.slice(3).includes(fence)) {
        return;
      }
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (inCodeBlock) return;

    // 2. Handle block comments (Typst /* ... */)
    if (type === "typst") {
      if (trimmed.includes("/*") && !trimmed.includes("*/")) {
        inBlockComment = true;
        return;
      }
      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith("//")) return; // line comment
    }

    // 3. Handle LaTeX comments & environments
    if (type === "latex") {
      const hasBegin = /\\begin\{(verbatim|lstlisting|minted)\}/.test(line);
      const hasEnd = /\\end\{(verbatim|lstlisting|minted)\}/.test(line);
      if (hasBegin && hasEnd) {
        return;
      }
      if (hasBegin) {
        inVerbatim = true;
        return;
      }
      if (hasEnd) {
        inVerbatim = false;
        return;
      }
      if (inVerbatim) return;
    }

    // ── Engine-Specific Parsing ──

    if (type === "typst") {
      // Typst headings: = Title, == Subtitle, etc.
      let headingLine = line;
      const commentMatch = headingLine.match(/(?<!:)\/\/.*/);
      if (commentMatch && commentMatch.index !== undefined) {
        headingLine = headingLine.slice(0, commentMatch.index);
      }
      const match = headingLine.match(/^(=+)\s+(.+)$/);
      if (match) {
        const level = match[1].length;
        let rawTitle = match[2].trim();
        // Remove trailing Typst labels: <label>
        rawTitle = rawTitle.replace(/\s*<[^>]+>\s*$/, "");

        items.push({
          id: `typ_${lineNum}_${lineOffset}`,
          title: rawTitle,
          level,
          line: lineNum,
          pos: lineOffset,
          type: "typst",
        });
      }
    } else if (type === "latex") {
      const activeLine = stripLatexComment(line);
      if (!activeLine.trim()) return;

      // LaTeX headings: \section{...}, \subsection*{...}, etc.
      const headingRegex =
        /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{/g;
      let match: RegExpExecArray | null;

      while ((match = headingRegex.exec(activeLine)) !== null) {
        const headingCmd = match[1];
        const level = LATEX_LEVEL_MAP[headingCmd] ?? 2;
        const startIndex = match.index + match[0].length - 1; // start of '{'
        const restOfLine = activeLine.slice(startIndex);
        const { title } = extractBalancedLatexTitle(restOfLine);

        // Fallback for unclosed heading on line
        const finalTitle = title || restOfLine.slice(1).split("}")[0].trim();

        items.push({
          id: `tex_${lineNum}_${lineOffset + match.index}`,
          title: finalTitle,
          level,
          line: lineNum,
          pos: lineOffset + match.index,
          type: "latex",
        });
      }
    } else if (type === "markdown") {
      // Markdown headings: # Title, ## Subtitle, etc.
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        const level = match[1].length;
        const rawTitle = match[2].trim().replace(/^\[(.*?)\]\(.*?\)$/, "$1");

        items.push({
          id: `md_${lineNum}_${lineOffset}`,
          title: rawTitle,
          level,
          line: lineNum,
          pos: lineOffset,
          type: "markdown",
        });
      }
    }
  });

  return items;
}

/**
 * Builds a hierarchical tree from a flat list of OutlineItems.
 */
export function buildOutlineTree(items: OutlineItem[]): OutlineNode[] {
  const rootNodes: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  for (const item of items) {
    const node: OutlineNode = { ...item, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      rootNodes.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }

  return rootNodes;
}
