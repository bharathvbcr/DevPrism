/** OPML / FreeMind mind-map flatteners → path strings → chunks. */

import { chunkPlainText } from "./chunking";
import type { PreparedChunk } from "../types";

export interface MindmapChunkOptions {
  sourceTitle: string;
  date?: string;
}

/**
 * Detect OPML vs FreeMind XML and flatten hierarchy to
 * `parent > child > leaf` lines, then chunk.
 */
export function chunkMindmap(
  xml: string,
  options: MindmapChunkOptions,
): PreparedChunk[] {
  const trimmed = xml.trim();
  const paths =
    trimmed.includes("<map") || trimmed.includes("<node")
      ? flattenFreemind(trimmed)
      : flattenOpml(trimmed);
  const text = paths.join("\n");
  return chunkPlainText(text, {
    sourceTitle: options.sourceTitle,
    date: options.date,
  });
}

/** OPML `<outline text="…">` nested → path lines. */
export function flattenOpml(xml: string): string[] {
  const paths: string[] = [];
  // Lightweight tag walk — good enough for FreeMind/OPML exports.
  const stack: string[] = [];
  const tagRe = /<outline\b([^>]*)>|<\/outline>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    if (m[0].startsWith("</")) {
      stack.pop();
      continue;
    }
    const attrs = m[1] ?? "";
    const text =
      attr(attrs, "text") ?? attr(attrs, "title") ?? attr(attrs, "_note") ?? "";
    const label = decodeXml(text).trim();
    if (!label) continue;
    stack.push(label);
    paths.push(stack.join(" > "));
    if (/\/>\s*$/.test(m[0])) {
      // Self-closing
      stack.pop();
    }
  }
  return paths;
}

/** FreeMind `<node TEXT="…">` nested → path lines. */
export function flattenFreemind(xml: string): string[] {
  const paths: string[] = [];
  const stack: string[] = [];
  const tagRe = /<node\b([^>]*)>|<\/node>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    if (m[0].startsWith("</")) {
      stack.pop();
      continue;
    }
    const attrs = m[1] ?? "";
    const text = attr(attrs, "TEXT") ?? attr(attrs, "text") ?? "";
    const label = decodeXml(text).trim();
    if (!label) continue;
    stack.push(label);
    paths.push(stack.join(" > "));
    if (/\/>\s*$/.test(m[0])) {
      stack.pop();
    }
  }
  return paths;
}

function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i");
  const m = attrs.match(re);
  if (m) return m[1];
  const re2 = new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i");
  const m2 = attrs.match(re2);
  return m2?.[1];
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
