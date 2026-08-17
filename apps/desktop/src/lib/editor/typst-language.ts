/**
 * CodeMirror syntax highlighting for Typst.
 *
 * Hand-written as a `StreamLanguage` rather than pulling in a grammar package:
 * no maintained CodeMirror 6 Typst grammar exists on npm, and a tokenizer is
 * enough for highlighting (we do not need a parse tree — Typst diagnostics
 * come from the real compiler, not from the editor).
 *
 * Deliberately approximate: it distinguishes code mode from markup mode, which
 * is the distinction that actually matters when reading Typst.
 */

import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { LanguageSupport } from "@codemirror/language";

interface TypstState {
  /** Nesting depth of `#…( … )` / `{ … }` code context. 0 = markup mode. */
  codeDepth: number;
  /** Inside a ``` raw block. */
  inRaw: boolean;
  /** Inside a block comment (Typst nests them). */
  commentDepth: number;
}

const KEYWORDS = new Set([
  "let",
  "set",
  "show",
  "import",
  "include",
  "if",
  "else",
  "for",
  "while",
  "in",
  "return",
  "break",
  "continue",
  "context",
  "as",
  "not",
  "and",
  "or",
  "none",
  "auto",
  "true",
  "false",
]);

const parser: StreamParser<TypstState> = {
  name: "typst",

  startState(): TypstState {
    return { codeDepth: 0, inRaw: false, commentDepth: 0 };
  },

  // StreamLanguage keeps snapshots of state for incremental reparsing, so an
  // object state must be copied explicitly or edits corrupt earlier lines.
  copyState(state): TypstState {
    return { ...state };
  },

  token(stream, state) {
    // --- raw blocks -------------------------------------------------------
    if (state.inRaw) {
      if (stream.match(/^```/)) {
        state.inRaw = false;
        return "string";
      }
      stream.skipToEnd();
      return "string";
    }
    if (stream.match(/^```/)) {
      state.inRaw = true;
      return "string";
    }

    // --- comments ---------------------------------------------------------
    if (state.commentDepth > 0) {
      while (!stream.eol()) {
        if (stream.match(/^\*\//)) {
          state.commentDepth -= 1;
          if (state.commentDepth === 0) return "comment";
          continue;
        }
        if (stream.match(/^\/\*/)) {
          state.commentDepth += 1;
          continue;
        }
        stream.next();
      }
      return "comment";
    }
    if (stream.match(/^\/\*/)) {
      state.commentDepth = 1;
      return "comment";
    }
    if (stream.match(/^\/\//)) {
      stream.skipToEnd();
      return "comment";
    }

    const atLineStart = stream.sol();
    if (stream.eatSpace()) return null;

    // --- markup-mode constructs ------------------------------------------
    if (state.codeDepth === 0) {
      if (atLineStart && stream.match(/^=+\s/)) return "heading";
      if (atLineStart && stream.match(/^[-+]\s/)) return "list";
      if (stream.match(/^\*[^*\n]+\*/)) return "strong";
      if (stream.match(/^_[^_\n]+_/)) return "emphasis";
      if (stream.match(/^`[^`\n]*`/)) return "string";
      if (stream.match(/^@[\w:-]+/)) return "labelName";
      if (stream.match(/^<[\w:-]+>/)) return "labelName";
      if (stream.match(/^\$/)) return "string.special";
      if (stream.match(/^\\[^\s]/)) return "escape";
    }

    // --- entering code mode ----------------------------------------------
    if (stream.match(/^#[a-zA-Z_][\w-]*/)) {
      const word = stream.current().slice(1);
      // `#let`, `#show`, … keep code context open until the line/args end.
      state.codeDepth = Math.max(state.codeDepth, 1);
      return KEYWORDS.has(word) ? "keyword" : "variableName.function";
    }
    if (stream.match(/^#\{/)) {
      state.codeDepth += 1;
      return "bracket";
    }
    if (stream.match(/^#\[/)) {
      return "bracket";
    }
    if (stream.match(/^#/)) return "operator";

    // --- code-mode tokens -------------------------------------------------
    if (state.codeDepth > 0) {
      if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
      if (stream.match(/^-?\d+(?:\.\d+)?(?:pt|em|cm|mm|in|deg|fr|%)?/)) {
        return "number";
      }
      if (stream.match(/^[a-zA-Z_][\w-]*/)) {
        const word = stream.current();
        if (KEYWORDS.has(word)) return "keyword";
        return stream.peek() === "(" ? "variableName.function" : "variableName";
      }
      if (stream.match(/^[{([]/)) {
        state.codeDepth += 1;
        return "bracket";
      }
      if (stream.match(/^[})\]]/)) {
        state.codeDepth = Math.max(0, state.codeDepth - 1);
        return "bracket";
      }
      if (stream.match(/^(?:=>|==|!=|<=|>=|\+=|-=|\*=|\/=|[+\-*/=<>.,:;])/)) {
        return "operator";
      }
    }

    stream.next();
    return null;
  },

  blankLine(state) {
    // A blank line ends any implicit single-line code context (`#let x = 1`).
    if (state.commentDepth === 0 && !state.inRaw) state.codeDepth = 0;
  },

  // `variableName.function` / `string.special` are not in StreamLanguage's
  // default token-name table, so map them to real highlight tags explicitly.
  tokenTable: {
    "variableName.function": tags.function(tags.variableName),
    "string.special": tags.special(tags.string),
  },

  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", '"', "$"] },
    indentOnInput: /^\s*[}\])]$/,
  },
};

export const typstStreamLanguage = StreamLanguage.define(parser);

/** CodeMirror extension enabling Typst highlighting. */
export function typst(): LanguageSupport {
  return new LanguageSupport(typstStreamLanguage);
}
