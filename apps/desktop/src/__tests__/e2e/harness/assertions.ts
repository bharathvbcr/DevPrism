/**
 * Domain-specific E2E test assertion utilities.
 * Enforces authentic specifications without facade matching.
 */

import { expect } from "vitest";

/**
 * Validates that a buffer is an authentic, non-corrupted PDF.
 * Checks magic header (%PDF-1.x) and EOF marker (%%EOF).
 */
export function assertPdfBuffer(buffer: ArrayBuffer | Uint8Array): void {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  expect(bytes.length).toBeGreaterThan(32);

  // Magic header: %PDF-1.
  const header = String.fromCharCode(...bytes.slice(0, 8));
  expect(header.startsWith("%PDF-1.")).toBe(true);

  // EOF marker: %%EOF
  const tail = String.fromCharCode(...bytes.slice(-32));
  expect(tail.includes("%%EOF")).toBe(true);
}

/**
 * Validates the Vani checkSafe invariant:
 * Quantified metrics (percentages, dollar amounts, multipliers, integers with units)
 * present in the source MUST be strictly preserved in the rewritten bullet.
 */
export function assertMetricPreservation(
  originalText: string,
  rewrittenText: string,
): void {
  // Regex extracts metric patterns: e.g. "40%", "$2M", "50M", "10x", "30ms"
  const metricPattern =
    /(\$\d+(?:\.\d+)?[kKmMbB]?|\d+(?:\.\d+)?%|\d+(?:\.\d+)?[xX]|\d+(?:\.\d+)?(?:ms|s|min|h)|\b\d+\s*(?:users|events|qps|rps|req\/s))/gi;
  const originalMetrics = originalText.match(metricPattern) || [];

  for (const metric of originalMetrics) {
    const normalized = metric.toLowerCase().replace(/\s+/g, "");
    const rewrittenNormalized = rewrittenText.toLowerCase().replace(/\s+/g, "");
    expect(
      rewrittenNormalized.includes(normalized),
      `checkSafe invariant violation: metric "${metric}" found in master bullet was omitted or altered in rewritten bullet.`,
    ).toBe(true);
  }
}

/**
 * Validates outline tree depth, ordering, and line numbers.
 */
export interface OutlineNode {
  id: string;
  title: string;
  level: number;
  line: number;
  type: "typst" | "latex";
  children?: OutlineNode[];
}

export function assertOutlineTree(nodes: OutlineNode[]): void {
  expect(Array.isArray(nodes)).toBe(true);
  let lastLine = 0;
  for (const node of nodes) {
    expect(node.title.trim().length).toBeGreaterThan(0);
    expect(node.level).toBeGreaterThanOrEqual(1);
    expect(node.line).toBeGreaterThanOrEqual(lastLine);
    lastLine = node.line;
  }
}
