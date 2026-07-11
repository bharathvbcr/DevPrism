/**
 * Hardened LaTeX escaping for resume synthesis slots.
 *
 * AI never emits LaTeX — this module is the only path from plain text into
 * template interpolation. Order of operations:
 *   1. NFC normalize
 *   2. Strip C0 / bidi / zero-width controls
 *   3. Map smart quotes & dashes to TeX idioms
 *   4. Escape `\ { } $ & % # _ ^ ~`
 *   5. Post-escape markdown: `**x**` → `\textbf{x}`
 */

/** Commands we ourselves emit after escaping — anything else matching \\[a-zA-Z]+ is rejected. */
const ALLOWED_COMMANDS = new Set(["textbackslash", "textbf"]);

const C0_AND_CONTROLS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional C0 strip
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Bidi isolates/embeds/overrides and zero-width / soft-hyphen injection vectors. */
const BIDI_AND_ZERO_WIDTH =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/g;

export function normalizeResumePlainText(input: string): string {
  return input
    .normalize("NFC")
    .replace(C0_AND_CONTROLS, "")
    .replace(BIDI_AND_ZERO_WIDTH, "");
}

/** Map typographic punctuation to TeX-friendly ASCII / idioms (pre-escape). */
export function mapSmartPunctuation(input: string): string {
  return input
    .replace(/\u201C/g, "``") // “
    .replace(/\u201D/g, "''") // ”
    .replace(/\u2018/g, "`") // ‘
    .replace(/\u2019/g, "'") // ’
    .replace(/\u2013/g, "--") // –
    .replace(/\u2014/g, "---") // —
    .replace(/\u2026/g, "...");
}

/**
 * Escape LaTeX specials. Replacement output is never re-scanned, so
 * `\textbackslash{}` braces are safe.
 */
export function escapeLatexSpecials(input: string): string {
  let out = "";
  for (const ch of input) {
    switch (ch) {
      case "\\":
        out += "\\textbackslash{}";
        break;
      case "{":
        out += "\\{";
        break;
      case "}":
        out += "\\}";
        break;
      case "$":
        out += "\\$";
        break;
      case "&":
        out += "\\&";
        break;
      case "%":
        out += "\\%";
        break;
      case "#":
        out += "\\#";
        break;
      case "_":
        out += "\\_";
        break;
      case "^":
        out += "\\^{}";
        break;
      case "~":
        out += "\\~{}";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/**
 * Convert markdown bold markers on already-escaped text.
 * Interior may include escape sequences (`\%`, `\_`, …) but not `*`.
 */
export function applyBoldMarkdown(escaped: string): string {
  return escaped.replace(/\*\*([^*]+)\*\*/g, "\\textbf{$1}");
}

/** Full escape pipeline for a resume slot value. */
export function escapeResumeText(input: string): string {
  const normalized = mapSmartPunctuation(normalizeResumePlainText(input));
  return applyBoldMarkdown(escapeLatexSpecials(normalized));
}

export type SlotValidationResult = { ok: true } | { ok: false; reason: string };

function bracesBalanced(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      // Skip escaped brace literals `\{` `\}` and command starters we emit.
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * Reject slot values that still contain unexpected control sequences or
 * unbalanced braces after escaping. Allowed letter-commands: textbackslash, textbf.
 */
export function validateEscapedSlot(escaped: string): SlotValidationResult {
  if (!bracesBalanced(escaped)) {
    return { ok: false, reason: "unbalanced braces" };
  }
  const cmdRe = /\\([a-zA-Z]+)/g;
  let m: RegExpExecArray | null;
  while ((m = cmdRe.exec(escaped)) !== null) {
    if (!ALLOWED_COMMANDS.has(m[1])) {
      return {
        ok: false,
        reason: `unexpected command \\${m[1]}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Escape then validate. On validation failure, fall back to escaping
 * `canonicalFallback` (typically the locked canonical bullet).
 */
export function escapeAndValidateSlot(
  input: string,
  canonicalFallback?: string,
): string {
  const escaped = escapeResumeText(input);
  const check = validateEscapedSlot(escaped);
  if (check.ok) return escaped;
  if (canonicalFallback != null && canonicalFallback !== input) {
    const fallback = escapeResumeText(canonicalFallback);
    if (validateEscapedSlot(fallback).ok) return fallback;
  }
  // Last resort: strip anything that looks like a command after escape
  // by re-escaping a sanitized plain version (no backslashes / stars).
  const sanitized = normalizeResumePlainText(canonicalFallback ?? input)
    .replace(/\\/g, "")
    .replace(/\*/g, "");
  return escapeLatexSpecials(mapSmartPunctuation(sanitized));
}
