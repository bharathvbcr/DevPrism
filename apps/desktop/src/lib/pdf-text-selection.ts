import type { StructuredTextData } from "@/lib/mupdf/types";

/** Axis-aligned quad in PDF page points: [ulx, uly, urx, ury, llx, lly, lrx, lry]. */
export type PdfTextQuad = number[];

interface ClientLineRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Merge DOM client rects into one bar per visual line, then convert to PDF quads. */
export function mergeClientRectsToQuads(
  clientRects: DOMRectList | DOMRect[],
  pageRect: DOMRect,
  scale: number,
): PdfTextQuad[] {
  if (scale <= 0) return [];

  const lines: ClientLineRect[] = [];
  for (const r of Array.from(clientRects)) {
    if (r.width < 1 || r.height < 1) continue;
    const cy = r.top + r.height / 2;
    if (cy < pageRect.top - 1 || cy > pageRect.bottom + 1) continue;
    const tol = r.height * 0.5;
    const sameLine = lines.find(
      (l) =>
        Math.abs(l.top - r.top) < tol && Math.abs(l.bottom - r.bottom) < tol,
    );
    if (sameLine) {
      sameLine.top = Math.min(sameLine.top, r.top);
      sameLine.bottom = Math.max(sameLine.bottom, r.bottom);
      sameLine.left = Math.min(sameLine.left, r.left);
      sameLine.right = Math.max(sameLine.right, r.right);
    } else {
      lines.push({
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
      });
    }
  }

  const quads: PdfTextQuad[] = [];
  for (const l of lines) {
    const x = (l.left - pageRect.left) / scale;
    const y = (l.top - pageRect.top) / scale;
    const w = (l.right - l.left) / scale;
    const h = (l.bottom - l.top) / scale;
    if (w > 0 && h > 0) {
      quads.push([x, y, x + w, y, x, y + h, x + w, y + h]);
    }
  }
  return quads;
}

function rectToQuad(x: number, y: number, w: number, h: number): PdfTextQuad {
  return [x, y, x + w, y, x, y + h, x + w, y + h];
}

/** Fallback when DOM selection rects are empty (common in some WebViews). Uses
 *  MuPDF line bounding boxes that contain the selected substring. */
export function quadsFromStructuredText(
  textData: StructuredTextData,
  selectedText: string,
): PdfTextQuad[] {
  const needle = selectedText.trim();
  if (!needle) return [];

  const lineSegments = needle
    .split(/\r?\n/)
    .filter((segment) => segment.length > 0);
  if (lineSegments.length <= 1) {
    return quadsForLineSegment(textData, needle);
  }

  const quads: PdfTextQuad[] = [];
  let segmentIdx = 0;

  for (const block of textData.blocks) {
    if (block.type !== "text") continue;
    for (const line of block.lines) {
      const lineText = line.text ?? "";
      if (!lineText) continue;
      const segment = lineSegments[segmentIdx];
      const idx = lineText.toLowerCase().indexOf(segment.toLowerCase());
      if (idx < 0) continue;
      const quad = quadForLineMatch(line, lineText, idx, segment.length);
      if (quad) {
        quads.push(quad);
        segmentIdx++;
        if (segmentIdx >= lineSegments.length) return quads;
      }
    }
  }

  return quads;
}

function quadForLineMatch(
  line: { bbox: { x: number; y: number; w: number; h: number }; text?: string },
  lineText: string,
  matchIndex: number,
  matchLength: number,
): PdfTextQuad | null {
  const { x, y, w, h } = line.bbox;
  if (w <= 0 || h <= 0) return null;
  const startFrac = matchIndex / lineText.length;
  const endFrac = (matchIndex + matchLength) / lineText.length;
  const selX = x + w * startFrac;
  const selW = Math.max(w * (endFrac - startFrac), w * 0.05);
  return rectToQuad(selX, y, selW, h);
}

function quadsForLineSegment(
  textData: StructuredTextData,
  segment: string,
): PdfTextQuad[] {
  const quads: PdfTextQuad[] = [];
  const needleLower = segment.toLowerCase();

  for (const block of textData.blocks) {
    if (block.type !== "text") continue;
    for (const line of block.lines) {
      const lineText = line.text ?? "";
      if (!lineText) continue;
      const idx = lineText.toLowerCase().indexOf(needleLower);
      if (idx < 0) continue;
      const quad = quadForLineMatch(line, lineText, idx, segment.length);
      if (quad) quads.push(quad);
    }
  }

  return quads;
}

/** True when either selection endpoint sits inside the PDF text layer. */
export function isSelectionInPdfTextLayer(sel: Selection): boolean {
  const inLayer = (node: Node | null | undefined) =>
    node instanceof Element
      ? node.closest(".mupdf-text-layer") != null
      : node?.parentElement?.closest(".mupdf-text-layer") != null;

  return inLayer(sel.anchorNode) || inLayer(sel.focusNode);
}
