/**
 * Hardened plain-text → Typst conversion for resume synthesis slots.
 *
 * ## Why this is structurally different from escaping into markup
 *
 * The LaTeX path this replaced escaped text *into markup*, so safety depended
 * on enumerating every character TeX treats as special and getting all of them
 * right. A single missed character was a compile break — or worse, an injected
 * control sequence.
 *
 * This module never emits markup. Every AI- or user-derived string is emitted
 * as a **Typst string literal**, which is lexically terminated only by an
 * unescaped `"`. Escaping `\` and `"` is therefore *complete*, not
 * best-effort — Typst's markup specials (`#`, `*`, `_`, backtick, `$`, `@`,
 * `<`, `=`, `-`, `/`, `[`, `]`, `//`) carry no meaning inside a string literal,
 * so code-mode injection is impossible by construction rather than by
 * blocklist.
 *
 * Templates consume these literals through helper functions declared in the
 * preamble (`rich`, `entry`, `sect`), so the document structure is fixed and
 * AI text can only ever land in a value position.
 *
 * Order of operations:
 *   1. NFC normalize
 *   2. Strip C0 / DEL / bidi / zero-width controls
 *   3. Fold newlines & tabs to spaces (a literal may not span lines)
 *   4. Clamp length
 *   5. Escape `\` then `"`
 */

/** Hard cap for a single slot's text. Longer input is truncated, never dropped. */
export const MAX_SLOT_CHARS = 4000;

/** Hard cap on rich-text segments per slot (bold parsing fan-out). */
export const MAX_RICH_PARTS = 64;

const C0_AND_CONTROLS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional C0 strip
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Bidi isolates/embeds/overrides and zero-width / soft-hyphen injection vectors. */
const BIDI_AND_ZERO_WIDTH =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/g;

/** Line/paragraph separators that would otherwise break a single-line literal. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: vertical tab and form feed are folded to a space on purpose
const LINE_BREAKS = /[\r\n\t\u000B\u000C\u2028\u2029]+/g;

/**
 * Normalize plain text before it becomes a Typst literal.
 *
 * Unlike the LaTeX path this deliberately does *not* fold smart quotes or
 * dashes to ASCII — Typst is Unicode-native, so “ ” ‘ ’ – — … all typeset
 * correctly and keeping them yields better output than `` `` ''`` digraphs.
 */
export function normalizeTypstPlainText(input: string): string {
  return input
    .normalize("NFC")
    .replace(C0_AND_CONTROLS, "")
    .replace(BIDI_AND_ZERO_WIDTH, "")
    .replace(LINE_BREAKS, " ");
}

/** Truncate on a grapheme-safe boundary, appending an ellipsis when cut. */
export function clampSlotText(
  input: string,
  max: number = MAX_SLOT_CHARS,
): string {
  if (max <= 0) return "";
  const chars = Array.from(input);
  if (chars.length <= max) return input;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/**
 * Escape a normalized string into the *body* of a Typst string literal.
 *
 * Backslash must be replaced first so the backslashes introduced by the quote
 * rule are not themselves re-escaped.
 */
export function escapeTypstStringBody(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Full pipeline: plain text → a complete, quoted Typst string literal. */
export function toTypstString(
  input: string,
  max: number = MAX_SLOT_CHARS,
): string {
  const clean = clampSlotText(normalizeTypstPlainText(input), max);
  return `"${escapeTypstStringBody(clean)}"`;
}

export type SlotValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify a rendered literal really is a single closed Typst string.
 *
 * Defense in depth: `toTypstString` is total, so a failure here means an
 * upstream caller hand-built a literal. Scans for a `"` that is preceded by an
 * even number of backslashes (i.e. an unescaped terminator) before the end.
 */
export function validateTypstString(literal: string): SlotValidationResult {
  if (
    literal.length < 2 ||
    !literal.startsWith('"') ||
    !literal.endsWith('"')
  ) {
    return { ok: false, reason: "not a quoted literal" };
  }
  const body = literal.slice(1, -1);
  let backslashes = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"' && backslashes % 2 === 0) {
      return { ok: false, reason: "unescaped quote" };
    }
    backslashes = 0;
  }
  // A trailing odd run of backslashes would escape the closing quote.
  if (backslashes % 2 !== 0) {
    return { ok: false, reason: "trailing escape" };
  }
  return { ok: true };
}

/**
 * Build a validated literal, falling back to the canonical text and finally to
 * a hard-sanitized form. Mirrors `escapeAndValidateSlot` from the LaTeX path so
 * callers keep the same canonical-fallback contract.
 */
export function typstStringOrCanonical(
  input: string,
  canonicalFallback?: string,
): string {
  const primary = toTypstString(input);
  if (validateTypstString(primary).ok) return primary;
  if (canonicalFallback != null && canonicalFallback !== input) {
    const fallback = toTypstString(canonicalFallback);
    if (validateTypstString(fallback).ok) return fallback;
  }
  const stripped = clampSlotText(
    normalizeTypstPlainText(canonicalFallback ?? input).replace(/["\\]/g, ""),
  );
  return `"${stripped}"`;
}

/** One run of text with a bold flag, derived from `**markdown**` markers. */
export interface RichPart {
  bold: boolean;
  text: string;
}

/**
 * Split `**bold**` runs out of plain text.
 *
 * Unmatched or empty markers stay literal — this never throws and never drops
 * characters, so the round-trip `parts.map(p => p.text).join("")` equals the
 * input with only its matched `**` pairs removed.
 */
export function parseRichParts(input: string): RichPart[] {
  const parts: RichPart[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (parts.length >= MAX_RICH_PARTS - 1) break;
    if (m.index > last) {
      parts.push({ bold: false, text: input.slice(last, m.index) });
    }
    parts.push({ bold: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < input.length) {
    parts.push({ bold: false, text: input.slice(last) });
  }
  if (parts.length === 0) parts.push({ bold: false, text: "" });
  return parts;
}

/**
 * Render plain text as a call to the preamble's `rich` helper:
 * `rich(((false, "a"), (true, "b")))`.
 *
 * The total text is clamped across all parts so a slot cannot exceed
 * `MAX_SLOT_CHARS` by splitting itself into many bold runs.
 */
export function toTypstRich(input: string, canonicalFallback?: string): string {
  const source = (() => {
    const primary = normalizeTypstPlainText(input);
    if (primary.trim().length > 0 || canonicalFallback == null) return primary;
    return normalizeTypstPlainText(canonicalFallback);
  })();

  const clamped = clampSlotText(source);
  const parts = parseRichParts(clamped);
  const rendered = parts
    .map((p) => {
      const lit = typstStringOrCanonical(p.text);
      return `(${p.bold ? "true" : "false"}, ${lit})`;
    })
    .join(", ");
  // Trailing comma keeps a single-element Typst array from collapsing to a
  // parenthesized group.
  return `rich((${rendered}${parts.length === 1 ? "," : ""}))`;
}

/**
 * Escape a URL for `link("...")`. Same literal rules; additionally rejects
 * schemes that would let a resume link execute something on click.
 */
const SAFE_URL_SCHEME = /^(https?:|mailto:|tel:)/i;

export function toTypstUrl(input: string): string {
  const clean = normalizeTypstPlainText(input).trim();
  if (!clean) return '""';
  const looksSchemeless = !/^[a-z][a-z0-9+.-]*:/i.test(clean);
  const safe = looksSchemeless
    ? `https://${clean}`
    : SAFE_URL_SCHEME.test(clean)
      ? clean
      : "";
  return toTypstString(safe, 2048);
}
