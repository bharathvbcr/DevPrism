import {
  autocompletion,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { parseBibFile } from "@/lib/bibtex";

// ── Built-in Typst Functions & Snippets ────────────────────────────────────
export const TYPST_FUNCTIONS: Completion[] = [
  {
    label: "#align",
    type: "function",
    detail: "(alignment)[body]",
    apply: snippet("#align(${1:center})[${2}]"),
    boost: 90,
  },
  {
    label: "#block",
    type: "function",
    detail: "(width: ..., height: ...)[body]",
    apply: snippet("#block(width: ${1:100%})[\n  ${2}\n]"),
    boost: 85,
  },
  {
    label: "#box",
    type: "function",
    detail: "(baseline: ...)[body]",
    apply: snippet("#box(${1})[${2}]"),
    boost: 70,
  },
  {
    label: "#circle",
    type: "function",
    detail: "(radius: ...)",
    apply: snippet("#circle(radius: ${1:10pt})"),
    boost: 75,
  },
  {
    label: "#ellipse",
    type: "function",
    detail: "(width: ..., height: ...)",
    apply: snippet("#ellipse(width: ${1:20pt}, height: ${2:10pt})"),
    boost: 70,
  },
  {
    label: "#enum",
    type: "function",
    detail: "(item1, item2, ...)",
    apply: snippet("#enum[\n  + ${1:First item}\n  + ${2:Second item}\n]"),
    boost: 80,
  },
  {
    label: "#grid",
    type: "function",
    detail: "(columns: ..., gutter: ...)[cells]",
    apply: snippet(
      "#grid(\n  columns: (${1:1fr, 1fr}),\n  gutter: ${2:1em},\n  [${3}],\n  [${4}],\n)",
    ),
    boost: 95,
  },
  {
    label: "#heading",
    type: "function",
    detail: "(level: ...)[body]",
    apply: snippet("#heading(level: ${1:1})[${2:Title}]"),
    boost: 85,
  },
  {
    label: "#highlight",
    type: "function",
    detail: "(fill: ...)[body]",
    apply: snippet("#highlight(fill: ${1:yellow})[${2}]"),
    boost: 70,
  },
  {
    label: "#image",
    type: "function",
    detail: '("path", width: ...)',
    apply: snippet('#image("${1:path/to/image.png}", width: ${2:100%})'),
    boost: 90,
  },
  {
    label: "#line",
    type: "function",
    detail: "(start: ..., end: ...)",
    apply: snippet("#line(length: ${1:100%}, stroke: ${2:0.5pt})"),
    boost: 75,
  },
  {
    label: "#link",
    type: "function",
    detail: '("url")[label]',
    apply: snippet('#link("${1:https://}")[${2:label}]'),
    boost: 85,
  },
  {
    label: "#list",
    type: "function",
    detail: "(item1, item2, ...)",
    apply: snippet("#list[\n  - ${1:First item}\n  - ${2:Second item}\n]"),
    boost: 80,
  },
  {
    label: "#move",
    type: "function",
    detail: "(dx: ..., dy: ...)[body]",
    apply: snippet("#move(dx: ${1:0pt}, dy: ${2:0pt})[${3}]"),
    boost: 65,
  },
  {
    label: "#page",
    type: "function",
    detail: "(paper: ..., margin: ...)[body]",
    apply: snippet('#page(paper: "${1:a4}", margin: ${2:2.5cm})[\n  ${3}\n]'),
    boost: 85,
  },
  {
    label: "#pagebreak",
    type: "function",
    detail: "()",
    apply: "#pagebreak()",
    boost: 75,
  },
  {
    label: "#place",
    type: "function",
    detail: "(alignment)[body]",
    apply: snippet("#place(${1:top + right})[${2}]"),
    boost: 70,
  },
  {
    label: "#polygon",
    type: "function",
    detail: "(pt1, pt2, ...)",
    apply: snippet(
      "#polygon((${1:0pt, 0pt}), (${2:10pt, 0pt}), (${3:5pt, 10pt}))",
    ),
    boost: 60,
  },
  {
    label: "#rect",
    type: "function",
    detail: "(width: ..., height: ...)[body]",
    apply: snippet("#rect(width: ${1:100%}, height: ${2:auto})[${3}]"),
    boost: 85,
  },
  {
    label: "#rotate",
    type: "function",
    detail: "(angle)[body]",
    apply: snippet("#rotate(${1:45deg})[${2}]"),
    boost: 65,
  },
  {
    label: "#scale",
    type: "function",
    detail: "(x: ..., y: ...)[body]",
    apply: snippet("#scale(x: ${1:100%}, y: ${2:100%})[${3}]"),
    boost: 65,
  },
  {
    label: "#stack",
    type: "function",
    detail: "(dir: ..., spacing: ...)[elements]",
    apply: snippet("#stack(dir: ${1:ltr}, spacing: ${2:1em}, ${3})"),
    boost: 75,
  },
  {
    label: "#strike",
    type: "function",
    detail: "[body]",
    apply: snippet("#strike[${1}]"),
    boost: 65,
  },
  {
    label: "#table",
    type: "function",
    detail: "(columns: ..., align: ...)[cells]",
    apply: snippet(
      "#table(\n  columns: (${1:1fr, 1fr}),\n  align: ${2:center},\n  [${3:Header 1}], [${4:Header 2}],\n  [${5:Cell 1}], [${6:Cell 2}],\n)",
    ),
    boost: 95,
  },
  {
    label: "#text",
    type: "function",
    detail: "(font: ..., size: ..., fill: ...)[body]",
    apply: snippet("#text(size: ${1:10pt}, fill: ${2:black})[${3}]"),
    boost: 90,
  },
  {
    label: "#underline",
    type: "function",
    detail: "[body]",
    apply: snippet("#underline[${1}]"),
    boost: 70,
  },
];

// ── Typst Language Keywords ───────────────────────────────────────────────
export const TYPST_KEYWORDS: Completion[] = [
  {
    label: "#let",
    type: "keyword",
    detail: "name = value",
    apply: snippet("#let ${1:name} = ${2:value}"),
    boost: 100,
  },
  {
    label: "#set",
    type: "keyword",
    detail: "rule(property: value)",
    apply: snippet("#set ${1:text}(${2:size: 11pt})"),
    boost: 95,
  },
  {
    label: "#show",
    type: "keyword",
    detail: "selector: target",
    apply: snippet("#show ${1:heading}: ${2:set text(blue)}"),
    boost: 95,
  },
  {
    label: "#import",
    type: "keyword",
    detail: '"file.typ": items',
    apply: snippet('#import "${1:file.typ}": ${2:*}'),
    boost: 90,
  },
  {
    label: "#include",
    type: "keyword",
    detail: '"file.typ"',
    apply: snippet('#include "${1:file.typ}"'),
    boost: 90,
  },
  {
    label: "#if",
    type: "keyword",
    detail: "condition [body]",
    apply: snippet("#if ${1:condition} [\n  ${2}\n]"),
    boost: 85,
  },
  {
    label: "#else",
    type: "keyword",
    detail: "[body]",
    apply: snippet("#else [\n  ${1}\n]"),
    boost: 80,
  },
  {
    label: "#for",
    type: "keyword",
    detail: "item in collection [body]",
    apply: snippet("#for ${1:item} in ${2:items} [\n  ${3}\n]"),
    boost: 85,
  },
  {
    label: "#while",
    type: "keyword",
    detail: "condition [body]",
    apply: snippet("#while ${1:condition} [\n  ${2}\n]"),
    boost: 75,
  },
  {
    label: "#return",
    type: "keyword",
    detail: "value",
    apply: snippet("#return ${1:value}"),
    boost: 70,
  },
  {
    label: "#break",
    type: "keyword",
    detail: "break loop",
    apply: "#break",
    boost: 65,
  },
  {
    label: "#continue",
    type: "keyword",
    detail: "continue loop",
    apply: "#continue",
    boost: 65,
  },
  {
    label: "#context",
    type: "keyword",
    detail: "context expression",
    apply: snippet("#context ${1}"),
    boost: 80,
  },
];

// ── Typst Mathematical & Typographical Symbols ────────────────────────────
export const TYPST_SYMBOLS: Completion[] = [
  {
    label: "sym.arrow",
    type: "constant",
    detail: "→",
    apply: "sym.arrow",
    boost: 80,
  },
  {
    label: "sym.arrow.r",
    type: "constant",
    detail: "→",
    apply: "sym.arrow.r",
    boost: 80,
  },
  {
    label: "sym.arrow.l",
    type: "constant",
    detail: "←",
    apply: "sym.arrow.l",
    boost: 80,
  },
  {
    label: "sym.arrow.t",
    type: "constant",
    detail: "↑",
    apply: "sym.arrow.t",
    boost: 75,
  },
  {
    label: "sym.arrow.b",
    type: "constant",
    detail: "↓",
    apply: "sym.arrow.b",
    boost: 75,
  },
  {
    label: "sym.arrow.l.r",
    type: "constant",
    detail: "↔",
    apply: "sym.arrow.l.r",
    boost: 75,
  },
  {
    label: "sym.arrow.double",
    type: "constant",
    detail: "⇒",
    apply: "sym.arrow.double",
    boost: 80,
  },
  {
    label: "sym.times",
    type: "constant",
    detail: "×",
    apply: "sym.times",
    boost: 80,
  },
  {
    label: "sym.plus.minus",
    type: "constant",
    detail: "±",
    apply: "sym.plus.minus",
    boost: 80,
  },
  {
    label: "sym.checkmark",
    type: "constant",
    detail: "✓",
    apply: "sym.checkmark",
    boost: 85,
  },
  {
    label: "sym.crossmark",
    type: "constant",
    detail: "✗",
    apply: "sym.crossmark",
    boost: 80,
  },
  {
    label: "sym.star",
    type: "constant",
    detail: "★",
    apply: "sym.star",
    boost: 75,
  },
  {
    label: "sym.bullet",
    type: "constant",
    detail: "•",
    apply: "sym.bullet",
    boost: 85,
  },
  {
    label: "sym.dots",
    type: "constant",
    detail: "…",
    apply: "sym.dots",
    boost: 85,
  },
  {
    label: "sym.infinity",
    type: "constant",
    detail: "∞",
    apply: "sym.infinity",
    boost: 80,
  },
  {
    label: "sym.approx",
    type: "constant",
    detail: "≈",
    apply: "sym.approx",
    boost: 75,
  },
  {
    label: "sym.eq.not",
    type: "constant",
    detail: "≠",
    apply: "sym.eq.not",
    boost: 75,
  },
  {
    label: "sym.lt.eq",
    type: "constant",
    detail: "≤",
    apply: "sym.lt.eq",
    boost: 75,
  },
  {
    label: "sym.gt.eq",
    type: "constant",
    detail: "≥",
    apply: "sym.gt.eq",
    boost: 75,
  },
  {
    label: "sym.alpha",
    type: "constant",
    detail: "α",
    apply: "sym.alpha",
    boost: 70,
  },
  {
    label: "sym.beta",
    type: "constant",
    detail: "β",
    apply: "sym.beta",
    boost: 70,
  },
  {
    label: "sym.gamma",
    type: "constant",
    detail: "γ",
    apply: "sym.gamma",
    boost: 70,
  },
  {
    label: "sym.delta",
    type: "constant",
    detail: "δ",
    apply: "sym.delta",
    boost: 70,
  },
  {
    label: "sym.sum",
    type: "constant",
    detail: "∑",
    apply: "sym.sum",
    boost: 75,
  },
  {
    label: "sym.integral",
    type: "constant",
    detail: "∫",
    apply: "sym.integral",
    boost: 75,
  },
];

/**
 * Collect dynamic cross-reference labels from project files:
 * - `<label>` from all project .typ files
 * - BibTeX citation keys from all project .bib files
 */
function collectDynamicLabels(files: ProjectFile[]): Completion[] {
  const completions: Completion[] = [];
  const seenLabels = new Set<string>();

  for (const f of files) {
    if (!f.content) continue;

    // 1. Typst labels: <my-label>
    if (f.type === "typst" || f.name.endsWith(".typ")) {
      const labelRegex = /<([a-zA-Z0-9_\-:]+)>/g;
      let m: RegExpExecArray | null;
      while ((m = labelRegex.exec(f.content)) !== null) {
        const lbl = m[1];
        if (!seenLabels.has(lbl)) {
          seenLabels.add(lbl);
          completions.push({
            label: `@${lbl}`,
            type: "reference",
            detail: `Label in ${f.name}`,
            apply: `@${lbl}`,
            boost: 88,
          });
        }
      }
    }

    // 2. BibTeX citations from .bib files
    if (f.type === "bib" || f.name.endsWith(".bib")) {
      try {
        const entries = parseBibFile(f.content);
        for (const entry of entries) {
          if (!seenLabels.has(entry.key)) {
            seenLabels.add(entry.key);
            completions.push({
              label: `@${entry.key}`,
              type: "reference",
              detail: `${entry.title || "BibTeX reference"} (${entry.year || ""})`,
              apply: `@${entry.key}`,
              boost: 90,
            });
          }
        }
      } catch {
        // ignore parse errors in broken bib files
      }
    }
  }

  return completions;
}

/**
 * Pure completion matcher for testing and extension consumption.
 */
export function getTypstCompletions(
  prefix: string,
  files: ProjectFile[] = [],
): Completion[] {
  const norm = prefix.toLowerCase();
  const dynamic = collectDynamicLabels(files);
  const pool = [
    ...TYPST_FUNCTIONS,
    ...TYPST_KEYWORDS,
    ...TYPST_SYMBOLS,
    ...dynamic,
  ];

  return pool.filter((item) => item.label.toLowerCase().includes(norm));
}

/**
 * CodeMirror 6 completion source for Typst.
 */
export function typstCompletionSource(
  context: CompletionContext,
): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const textBefore = line.text.slice(0, context.pos - line.from);
  const docBeforeCursor = context.state.doc.sliceString(0, context.pos);

  // ── Context Guard 1: Suppress inside string literals (single or multiline) ──
  const totalQuotes = (docBeforeCursor.match(/(?<!\\)"/g) || []).length;
  if (totalQuotes % 2 === 1) {
    return null; // Inside an unclosed string literal
  }

  // ── Context Guard 2: Suppress inside line and block comments ──
  // Strip closed string literals from textBefore to avoid false comment detection on URLs
  const textWithoutStrings = textBefore.replace(/"(?:\\.|[^"\\])*"/g, "");
  if (textWithoutStrings.includes("//")) {
    return null; // After a line comment start
  }
  // Check for unclosed block comment on this line or before
  const lastOpenComment = docBeforeCursor.lastIndexOf("/*");
  const lastCloseComment = docBeforeCursor.lastIndexOf("*/");
  if (lastOpenComment > lastCloseComment) {
    return null; // Inside a block comment
  }

  // ── Match prefix patterns ──
  // 1. Function / Keyword: #...
  const hashMatch = context.matchBefore(/#[a-zA-Z0-9_]*/);
  if (hashMatch) {
    const query = hashMatch.text.toLowerCase();
    const options = [...TYPST_FUNCTIONS, ...TYPST_KEYWORDS].filter((c) =>
      c.label.toLowerCase().startsWith(query),
    );
    if (options.length === 0) return null;
    return {
      from: hashMatch.from,
      options,
      filter: true,
    };
  }

  // 2. Symbols: sym....
  const symMatch = context.matchBefore(/sym(\.[a-zA-Z0-9_]*)*/);
  if (symMatch) {
    const query = symMatch.text.toLowerCase();
    const options = TYPST_SYMBOLS.filter((c) =>
      c.label.toLowerCase().startsWith(query),
    );
    if (options.length === 0) return null;
    return {
      from: symMatch.from,
      options,
      filter: true,
    };
  }

  // 3. References / Citations: @...
  const refMatch = context.matchBefore(/@[a-zA-Z0-9_\-:]*/);
  if (refMatch) {
    const docFiles = useDocumentStore.getState().files;
    const dynamicLabels = collectDynamicLabels(docFiles);
    const query = refMatch.text.toLowerCase();
    const options = dynamicLabels.filter((c) =>
      c.label.toLowerCase().startsWith(query),
    );
    if (options.length === 0) return null;
    return {
      from: refMatch.from,
      options,
      filter: true,
    };
  }

  return null;
}

/**
 * Autocompletion extension configured for Typst documents.
 */
export function typstAutocomplete() {
  return autocompletion({
    override: [typstCompletionSource],
    defaultKeymap: true,
  });
}
