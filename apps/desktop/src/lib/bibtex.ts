/** Shared BibTeX parsing and serialization for autocomplete and the bibliography panel. */

export interface BibEntry {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
  journal?: string;
  /** Full entry source text (from `@` through closing `}`). */
  raw: string;
  /** Character offset of `raw` in the parent .bib file. */
  start: number;
  end: number;
}

export interface BibEntryFields {
  key: string;
  type: string;
  fields: Record<string, string>;
}

const DISPLAY_FIELDS = [
  "title",
  "author",
  "year",
  "journal",
  "booktitle",
  "publisher",
  "doi",
] as const;

function readBalancedBraces(text: string, open: number): number {
  if (text[open] !== "{") return open;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function parseFieldValue(window: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*`, "i");
  const m = window.match(re);
  if (!m || m.index === undefined) return undefined;
  let i = m.index + m[0].length;
  while (i < window.length && /\s/.test(window[i])) i++;
  if (window[i] === "{") {
    const end = readBalancedBraces(window, i);
    return window
      .slice(i + 1, end - 1)
      .replace(/[{}]/g, "")
      .trim();
  }
  if (window[i] === '"') {
    const end = window.indexOf('"', i + 1);
    if (end === -1) return undefined;
    return window.slice(i + 1, end).trim();
  }
  const plain = window.slice(i).match(/^([^,\n]+)/);
  return plain ? plain[1].trim() : undefined;
}

/** Parse all `@type{key, …}` entries from a .bib file body. */
export function parseBibFile(bib: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const headerRe = /@(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(bib)) !== null) {
    const type = m[1].toLowerCase();
    if (type === "comment" || type === "preamble" || type === "string")
      continue;

    const bodyStart = m.index + m[0].length - 1;
    const bodyEnd = readBalancedBraces(bib, bodyStart);
    const body = bib.slice(bodyStart + 1, bodyEnd - 1);
    const keyMatch = body.match(/^\s*([^,\s}]+)\s*,/);
    if (!keyMatch) continue;
    const key = keyMatch[1].trim();
    const window = body.slice(keyMatch[0].length);

    const entry: BibEntry = {
      key,
      type,
      raw: bib.slice(m.index, bodyEnd),
      start: m.index,
      end: bodyEnd,
    };
    for (const field of DISPLAY_FIELDS) {
      const value = parseFieldValue(window, field);
      if (value) (entry as unknown as Record<string, string>)[field] = value;
    }
    entries.push(entry);
  }
  return entries;
}

/** Extract editable fields from a parsed entry's body. */
export function entryToFields(entry: BibEntry): BibEntryFields {
  const inner = entry.raw.replace(/^@\w+\s*\{/, "").replace(/\}\s*$/, "");
  const keyMatch = inner.match(/^\s*([^,\s}]+)\s*,([\s\S]*)$/);
  const fields: Record<string, string> = {};
  if (!keyMatch) {
    return { key: entry.key, type: entry.type, fields };
  }
  const rest = keyMatch[2];
  const fieldRe = /(\w+)\s*=\s*(\{[^{}]*\}|"[^"]*"|[^,\n]+)\s*,?/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(rest)) !== null) {
    const name = fm[1].toLowerCase();
    let value = fm[2].trim();
    if (value.startsWith("{") && value.endsWith("}")) {
      value = value.slice(1, -1);
    } else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    fields[name] = value;
  }
  return { key: entry.key, type: entry.type, fields };
}

export function serializeBibEntry({
  key,
  type,
  fields,
}: BibEntryFields): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v.trim().length > 0)
    .map(([name, value]) => `  ${name} = {${value}},`);
  return `@${type}{${key},\n${lines.join("\n")}\n}`;
}

/** Replace one entry inside a .bib file body; returns updated file content. */
export function replaceBibEntry(
  bib: string,
  entry: BibEntry,
  updated: BibEntryFields,
): string {
  const serialized = serializeBibEntry(updated);
  return bib.slice(0, entry.start) + serialized + bib.slice(entry.end);
}

/** Remove one entry from a .bib file body. */
export function removeBibEntry(bib: string, entry: BibEntry): string {
  let out = bib.slice(0, entry.start) + bib.slice(entry.end);
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trimEnd() + (out.endsWith("\n") ? "" : "\n");
}

/** Append a new entry to a .bib file body. */
export function appendBibEntry(bib: string, entry: BibEntryFields): string {
  const serialized = serializeBibEntry(entry);
  const trimmed = bib.trimEnd();
  if (!trimmed) return `${serialized}\n`;
  return `${trimmed}\n\n${serialized}\n`;
}

/** Merge pasted BibTeX into an existing .bib file, skipping duplicate keys. */
export function importBibEntries(
  bib: string,
  pasted: string,
): { content: string; added: number; skipped: number } {
  const existing = new Set(parseBibFile(bib).map((e) => e.key.toLowerCase()));
  let content = bib;
  let added = 0;
  let skipped = 0;

  for (const entry of parseBibFile(pasted)) {
    if (existing.has(entry.key.toLowerCase())) {
      skipped++;
      continue;
    }
    const { key, type, fields } = entryToFields(entry);
    content = appendBibEntry(content, { key, type, fields });
    existing.add(key.toLowerCase());
    added++;
  }

  return { content, added, skipped };
}
