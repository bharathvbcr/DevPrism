import type { DiffLine } from "@/lib/line-diff";

export type DisplayDiffRow =
  | { kind: "context"; text: string }
  | { kind: "del"; text: string }
  | { kind: "add"; text: string }
  | { kind: "word"; oldText: string; newText: string };

/** Merge a LONE del+add pair into one inline word-level row. Only a genuine
 * 1:1 change region qualifies: lineDiff emits a multi-line changed block as a
 * run of dels followed by a run of adds, so pairing the last del with the first
 * add would word-diff two unrelated lines and misalign the rest. We therefore
 * only pair a del that is neither preceded by another del nor whose following
 * add is itself followed by another add. */
export function toDisplayDiffRows(lines: DiffLine[]): DisplayDiffRow[] {
  const rows: DisplayDiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isLonePair =
      line.type === "del" &&
      lines[i + 1]?.type === "add" &&
      lines[i - 1]?.type !== "del" &&
      lines[i + 2]?.type !== "add";
    if (line.type === "context") {
      rows.push({ kind: "context", text: line.text });
      i++;
    } else if (isLonePair) {
      rows.push({
        kind: "word",
        oldText: line.text,
        newText: lines[i + 1].text,
      });
      i += 2;
    } else if (line.type === "del") {
      rows.push({ kind: "del", text: line.text });
      i++;
    } else {
      rows.push({ kind: "add", text: line.text });
      i++;
    }
  }
  return rows;
}
