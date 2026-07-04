/**
 * LaTeX ⇄ rich-document converter for the ScholarDoc rich (Word-like) editor.
 *
 * Parses a LaTeX source file into a ProseMirror/TipTap-compatible JSON
 * document and serializes it back. The conversion is intentionally
 * conservative and lossless-by-fallback:
 *
 * - The preamble (everything up to and including `\begin{document}`) and the
 *   trailing `\end{document}` are preserved verbatim and never editable.
 * - Constructs the rich editor understands (sections, text formatting, lists,
 *   simple tabulars, math) become native editable nodes.
 * - Everything else (figures, unknown environments, comment blocks, unknown
 *   commands) is preserved verbatim in atomic `latexRaw` / `latexInline`
 *   nodes, so a parse → serialize round trip never destroys content.
 *
 * This module is pure TypeScript with no dependencies so it can be unit
 * tested directly.
 */

// ─── Document model (TipTap-compatible JSON) ───

export interface RichMark {
  type: "bold" | "italic" | "underline" | "code";
}

export interface RichNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichNode[];
  text?: string;
  marks?: RichMark[];
}

export interface ParsedLatexDoc {
  /** Verbatim preamble incl. `\begin{document}` (empty for fragments). */
  preamble: string;
  /** Verbatim `\end{document}` + anything after it (empty for fragments). */
  postamble: string;
  /** TipTap-compatible document. */
  doc: RichNode;
}

const HEADING_COMMANDS: Record<string, number> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
};

const HEADING_BY_LEVEL: Record<number, string> = {
  1: "section",
  2: "subsection",
  3: "subsubsection",
  4: "paragraph",
};

const MARK_COMMANDS: Record<string, RichMark["type"]> = {
  textbf: "bold",
  textit: "italic",
  emph: "italic",
  underline: "underline",
  texttt: "code",
};

const MARK_TO_COMMAND: Record<RichMark["type"], string> = {
  bold: "textbf",
  italic: "textit",
  underline: "underline",
  code: "texttt",
};

const MATH_ENVS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "displaymath",
]);

// ─── Helpers ───

/** Returns the content of a `{...}` group starting at `start` (the `{`), plus the index just past the closing `}`. Returns null when unbalanced. */
function readBraceGroup(
  src: string,
  start: number,
): { content: string; end: number } | null {
  if (src[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++; // skip escaped char
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { content: src.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Reads a command name (letters) starting just after a backslash. */
function readCommandName(src: string, afterBackslash: number): string {
  let i = afterBackslash;
  while (i < src.length && /[a-zA-Z]/.test(src[i])) i++;
  let name = src.slice(afterBackslash, i);
  if (src[i] === "*") name += "*";
  return name;
}

/** Finds the matching `\end{env}` for a `\begin{env}` at `beginIdx`. Returns index of the `\end` backslash and the index just past `\end{env}`. */
function findMatchingEnd(
  src: string,
  env: string,
  searchFrom: number,
): { start: number; end: number } | null {
  const begin = `\\begin{${env}}`;
  const end = `\\end{${env}}`;
  let depth = 1;
  let i = searchFrom;
  while (i < src.length) {
    const nextBegin = src.indexOf(begin, i);
    const nextEnd = src.indexOf(end, i);
    if (nextEnd === -1) return null;
    if (nextBegin !== -1 && nextBegin < nextEnd) {
      depth++;
      i = nextBegin + begin.length;
    } else {
      depth--;
      if (depth === 0) return { start: nextEnd, end: nextEnd + end.length };
      i = nextEnd + end.length;
    }
  }
  return null;
}

function textNode(text: string, marks: RichMark[]): RichNode {
  const node: RichNode = { type: "text", text };
  if (marks.length > 0) node.marks = marks.map((m) => ({ ...m }));
  return node;
}

function paragraph(content: RichNode[]): RichNode {
  return content.length > 0
    ? { type: "paragraph", content }
    : { type: "paragraph" };
}

function rawBlock(latex: string): RichNode {
  return { type: "latexRaw", attrs: { latex } };
}

/** Unescape LaTeX special chars into plain text. */
function unescapeText(s: string): string {
  return s
    .replace(/\\([%&_#$ ])/g, "$1")
    .replace(/\\{/g, "{")
    .replace(/\\}/g, "}")
    .replace(/~/g, " ")
    .replace(/``/g, "“")
    .replace(/''/g, "”");
}

/** Escape plain text for LaTeX output. */
export function escapeLatexText(s: string): string {
  // Single pass for specials so replacement output is never re-escaped.
  return s
    .replace(/[\\{}%&_#$]/g, (ch) =>
      ch === "\\" ? "\\textbackslash{}" : `\\${ch}`,
    )
    .replace(/\u201c/g, "``")
    .replace(/\u201d/g, "''");
}

// ─── Inline parsing ───

/**
 * Parses inline LaTeX (paragraph or table-cell content) into rich inline
 * nodes: styled text, inline math, and `latexInline` chips for commands the
 * editor does not model (citations, refs, labels, …).
 */
export function parseInline(src: string, marks: RichMark[] = []): RichNode[] {
  const out: RichNode[] = [];
  let buf = "";

  const flush = () => {
    if (!buf) return;
    const text = unescapeText(buf).replace(/\s+/g, " ");
    if (text) out.push(textNode(text, marks));
    buf = "";
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Inline math: $...$ (not $$) or \( ... \)
    if (ch === "$" && src[i + 1] !== "$") {
      let j = i + 1;
      while (j < src.length && (src[j] !== "$" || src[j - 1] === "\\")) j++;
      if (j < src.length) {
        flush();
        out.push({
          type: "inlineMath",
          attrs: { latex: src.slice(i + 1, j), delim: "dollar" },
        });
        i = j + 1;
        continue;
      }
    }
    if (ch === "\\" && src[i + 1] === "(") {
      const close = src.indexOf("\\)", i + 2);
      if (close !== -1) {
        flush();
        out.push({
          type: "inlineMath",
          attrs: { latex: src.slice(i + 2, close), delim: "paren" },
        });
        i = close + 2;
        continue;
      }
    }

    if (ch === "\\") {
      const next = src[i + 1];
      // Escaped special character → literal text
      if (next && /[%&_#$ {}]/.test(next)) {
        buf += `\\${next}`;
        i += 2;
        continue;
      }
      // Line break \\ → treat as space
      if (next === "\\") {
        buf += " ";
        i += 2;
        continue;
      }
      const name = readCommandName(src, i + 1);
      if (name) {
        const markType = MARK_COMMANDS[name];
        const afterName = i + 1 + name.length;
        if (markType) {
          const group = readBraceGroup(src, afterName);
          if (group) {
            flush();
            const inner = marks.some((m) => m.type === markType)
              ? marks
              : [...marks, { type: markType } as RichMark];
            out.push(...parseInline(group.content, inner));
            i = group.end;
            continue;
          }
        }
        // Unknown command → preserve verbatim as an atomic inline chip,
        // consuming optional [..] and {..} argument groups.
        let end = afterName;
        while (end < src.length) {
          if (src[end] === "[") {
            const close = src.indexOf("]", end);
            if (close === -1) break;
            end = close + 1;
          } else if (src[end] === "{") {
            const group = readBraceGroup(src, end);
            if (!group) break;
            end = group.end;
          } else {
            break;
          }
        }
        flush();
        out.push({
          type: "latexInline",
          attrs: { latex: src.slice(i, end) },
        });
        i = end;
        continue;
      }
      // Lone backslash — keep as text.
      buf += ch;
      i++;
      continue;
    }

    // Comment: strip from % to end of line.
    if (ch === "%") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ─── Block parsing ───

function parseListEnv(env: "itemize" | "enumerate", body: string): RichNode {
  // Split top-level \item occurrences (ignore \item inside nested envs).
  const items: string[] = [];
  let depth = 0;
  let current: string | null = null;
  let i = 0;
  while (i < body.length) {
    if (body.startsWith("\\begin{", i)) depth++;
    else if (body.startsWith("\\end{", i)) depth--;
    if (
      depth === 0 &&
      body.startsWith("\\item", i) &&
      !/[a-zA-Z]/.test(body[i + 5] ?? "")
    ) {
      if (current !== null) items.push(current);
      current = "";
      i += 5;
      continue;
    }
    if (current !== null) current += body[i];
    i++;
  }
  if (current !== null) items.push(current);

  const listItems: RichNode[] = items.map((item) => ({
    type: "listItem",
    content: parseBlocks(item.trim()),
  }));
  return {
    type: env === "itemize" ? "bulletList" : "orderedList",
    content:
      listItems.length > 0
        ? listItems
        : [{ type: "listItem", content: [paragraph([])] }],
  };
}

/** Commands that disqualify a tabular from the simple editable-table model. */
const COMPLEX_TABLE_RE =
  /\\(multicolumn|multirow|begin|cline|cmidrule|resizebox|rotatebox)/;

function parseTabular(fullEnv: string): RichNode | null {
  const m = fullEnv.match(
    /^\\begin{tabular}\s*({[^}]*})?\s*([\s\S]*?)\\end{tabular}$/,
  );
  if (!m) return null;
  const colspec = m[1] ? m[1].slice(1, -1) : "";
  let body = m[2];
  if (COMPLEX_TABLE_RE.test(body)) return null;

  // Strip horizontal rules; remember whether any were present.
  const hadRules = /\\(hline|toprule|midrule|bottomrule)/.test(body);
  body = body.replace(/\\(hline|toprule|midrule|bottomrule)/g, "");

  const rows = body
    .split(/\\\\/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (rows.length === 0) return null;

  const tableRows: RichNode[] = rows.map((row, rowIdx) => {
    const cells = row.split(/(?<!\\)&/).map((c) => c.trim());
    return {
      type: "tableRow",
      content: cells.map((cell) => ({
        type: rowIdx === 0 ? "tableHeader" : "tableCell",
        content: [paragraph(parseInline(cell))],
      })),
    };
  });

  return {
    type: "table",
    attrs: { colspec, rules: hadRules },
    content: tableRows,
  };
}

/** True when the line (already trimmed) starts a block-level construct. */
function isBlockStart(line: string): boolean {
  return (
    /^\\(section|subsection|subsubsection|paragraph)\b/.test(line) ||
    line.startsWith("\\begin{") ||
    line.startsWith("\\[") ||
    line.startsWith("%")
  );
}

/** Parses a LaTeX body (no preamble) into block nodes. */
export function parseBlocks(body: string): RichNode[] {
  const blocks: RichNode[] = [];
  const lines = body.split("\n");
  let i = 0;

  const pushParagraphText = (text: string) => {
    const inline = parseInline(text.trim());
    if (inline.length > 0) blocks.push(paragraph(inline));
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      i++;
      continue;
    }

    // Comment block: consecutive %-only lines preserved verbatim.
    if (trimmed.startsWith("%")) {
      const start = i;
      while (i < lines.length && lines[i].trim().startsWith("%")) i++;
      blocks.push(rawBlock(lines.slice(start, i).join("\n")));
      continue;
    }

    // Heading command at line start.
    const headMatch = trimmed.match(
      /^\\(section|subsection|subsubsection|paragraph)\*?\s*/,
    );
    if (headMatch) {
      const braceIdx = line.indexOf("{", line.indexOf(`\\${headMatch[1]}`));
      const group = braceIdx !== -1 ? readBraceGroup(line, braceIdx) : null;
      if (group) {
        blocks.push({
          type: "heading",
          attrs: { level: HEADING_COMMANDS[headMatch[1]] },
          content: parseInline(group.content),
        });
        const rest = line.slice(group.end).trim();
        if (rest) pushParagraphText(rest);
        i++;
        continue;
      }
      // Malformed heading → raw
      blocks.push(rawBlock(line));
      i++;
      continue;
    }

    // Display math: \[ ... \]
    if (trimmed.startsWith("\\[")) {
      const joinedFrom = lines.slice(i).join("\n");
      const relStart = joinedFrom.indexOf("\\[");
      const relEnd = joinedFrom.indexOf("\\]", relStart);
      if (relEnd !== -1) {
        const latex = joinedFrom.slice(relStart + 2, relEnd).trim();
        blocks.push({
          type: "displayMath",
          attrs: { latex, delim: "bracket" },
        });
        // Preserve any trailing text on the closing line, then advance.
        const nlAfter = joinedFrom.indexOf("\n", relEnd + 2);
        const rest = joinedFrom
          .slice(relEnd + 2, nlAfter === -1 ? undefined : nlAfter)
          .trim();
        if (rest) pushParagraphText(rest);
        const consumed = joinedFrom.slice(0, relEnd + 2).split("\n").length;
        i += consumed;
        continue;
      }
      blocks.push(rawBlock(line));
      i++;
      continue;
    }

    // Environment.
    if (trimmed.startsWith("\\begin{")) {
      const envMatch = trimmed.match(/^\\begin{([^}]+)}/);
      if (envMatch) {
        const env = envMatch[1];
        const joinedFrom = lines.slice(i).join("\n");
        const beginLen = `\\begin{${env}}`.length;
        const startIdx = joinedFrom.indexOf(`\\begin{${env}}`);
        const match = findMatchingEnd(joinedFrom, env, startIdx + beginLen);
        if (match) {
          const fullEnv = joinedFrom.slice(startIdx, match.end);
          const inner = joinedFrom.slice(startIdx + beginLen, match.start);
          const consumed = joinedFrom.slice(0, match.end).split("\n").length;

          if (env === "itemize" || env === "enumerate") {
            blocks.push(parseListEnv(env, inner));
          } else if (MATH_ENVS.has(env)) {
            blocks.push({
              type: "displayMath",
              attrs: { latex: inner.trim(), delim: env },
            });
          } else if (env === "tabular") {
            const table = parseTabular(fullEnv);
            blocks.push(table ?? rawBlock(fullEnv));
          } else if (env === "center") {
            // Transparent: parse the inner content (may hold a tabular).
            blocks.push(...parseBlocks(inner));
          } else {
            blocks.push(rawBlock(fullEnv));
          }

          // Trailing text on the \end line becomes a paragraph.
          const endLineRest = joinedFrom
            .slice(
              match.end,
              joinedFrom.indexOf("\n", match.end) === -1
                ? undefined
                : joinedFrom.indexOf("\n", match.end),
            )
            .trim();
          if (endLineRest) pushParagraphText(endLineRest);
          i += consumed;
          continue;
        }
      }
      // Unterminated env → raw remainder, stop scanning it.
      blocks.push(rawBlock(lines.slice(i).join("\n")));
      break;
    }

    // Plain paragraph: gather until blank line or block construct.
    const start = i;
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      (i === start || !isBlockStart(lines[i].trim()))
    ) {
      i++;
    }
    pushParagraphText(lines.slice(start, i).join("\n"));
  }

  return blocks;
}

// ─── Top-level parse ───

export function latexToRichDoc(source: string): ParsedLatexDoc {
  const beginDoc = source.indexOf("\\begin{document}");
  let preamble = "";
  let postamble = "";
  let body = source;

  if (beginDoc !== -1) {
    const bodyStart = beginDoc + "\\begin{document}".length;
    const endDoc = source.indexOf("\\end{document}", bodyStart);
    preamble = source.slice(0, bodyStart);
    if (endDoc !== -1) {
      body = source.slice(bodyStart, endDoc);
      postamble = source.slice(endDoc);
    } else {
      body = source.slice(bodyStart);
    }
  }

  const content = parseBlocks(body);
  return {
    preamble,
    postamble,
    doc: {
      type: "doc",
      content: content.length > 0 ? content : [paragraph([])],
    },
  };
}

// ─── Serialization ───

function serializeMarkedText(node: RichNode): string {
  let text = escapeLatexText(node.text ?? "");
  const order: RichMark["type"][] = ["code", "underline", "italic", "bold"];
  const marks = (node.marks ?? [])
    .map((m) => m.type)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const mark of marks) {
    text = `\\${MARK_TO_COMMAND[mark]}{${text}}`;
  }
  return text;
}

export function serializeInline(content: RichNode[] | undefined): string {
  if (!content) return "";
  let out = "";
  for (const node of content) {
    switch (node.type) {
      case "text":
        out += serializeMarkedText(node);
        break;
      case "inlineMath": {
        const latex = String(node.attrs?.latex ?? "");
        out += node.attrs?.delim === "paren" ? `\\(${latex}\\)` : `$${latex}$`;
        break;
      }
      case "latexInline":
        out += String(node.attrs?.latex ?? "");
        break;
      case "hardBreak":
        out += " \\\\\n";
        break;
      default:
        out += serializeInline(node.content);
    }
  }
  return out;
}

function serializeTable(node: RichNode): string {
  const rows = node.content ?? [];
  const nCols = Math.max(1, ...rows.map((r) => r.content?.length ?? 0));
  const colspec =
    typeof node.attrs?.colspec === "string" && node.attrs.colspec
      ? (node.attrs.colspec as string)
      : "l".repeat(nCols);
  const rules = node.attrs?.rules === true;

  const lines: string[] = [`\\begin{tabular}{${colspec}}`];
  if (rules) lines.push("\\hline");
  rows.forEach((row, idx) => {
    const cells = (row.content ?? []).map((cell) =>
      // Cell content is a list of blocks (usually one paragraph).
      (cell.content ?? [])
        .map((block) => serializeInline(block.content).trim())
        .filter(Boolean)
        .join(" "),
    );
    lines.push(`${cells.join(" & ")} \\\\`);
    if (rules && idx === 0) lines.push("\\hline");
  });
  if (rules) lines.push("\\hline");
  lines.push("\\end{tabular}");
  return lines.join("\n");
}

function serializeList(node: RichNode, env: "itemize" | "enumerate"): string {
  const items = (node.content ?? []).map((item) => {
    const inner = serializeBlocks(item.content ?? [])
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n")
      .trim();
    return `  \\item ${inner}`;
  });
  return `\\begin{${env}}\n${items.join("\n")}\n\\end{${env}}`;
}

export function serializeBlocks(blocks: RichNode[]): string {
  const parts: string[] = [];
  for (const node of blocks) {
    switch (node.type) {
      case "paragraph": {
        const text = serializeInline(node.content).trim();
        if (text) parts.push(text);
        break;
      }
      case "heading": {
        const level = Number(node.attrs?.level ?? 1);
        const cmd = HEADING_BY_LEVEL[level] ?? "section";
        parts.push(`\\${cmd}{${serializeInline(node.content).trim()}}`);
        break;
      }
      case "bulletList":
        parts.push(serializeList(node, "itemize"));
        break;
      case "orderedList":
        parts.push(serializeList(node, "enumerate"));
        break;
      case "displayMath": {
        const latex = String(node.attrs?.latex ?? "");
        const delim = String(node.attrs?.delim ?? "bracket");
        parts.push(
          delim === "bracket"
            ? `\\[\n${latex}\n\\]`
            : `\\begin{${delim}}\n${latex}\n\\end{${delim}}`,
        );
        break;
      }
      case "table":
        parts.push(serializeTable(node));
        break;
      case "latexRaw":
        parts.push(String(node.attrs?.latex ?? ""));
        break;
      default:
        if (node.content) parts.push(serializeBlocks(node.content));
    }
  }
  return parts.join("\n\n");
}

export function richDocToLatex(parsed: ParsedLatexDoc): string {
  const body = serializeBlocks(parsed.doc.content ?? []);
  if (!parsed.preamble && !parsed.postamble) return `${body}\n`;
  return `${parsed.preamble}\n\n${body}\n\n${parsed.postamble}`;
}
