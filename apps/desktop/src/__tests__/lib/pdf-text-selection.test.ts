import { describe, expect, it } from "vitest";
import {
  mergeClientRectsToQuads,
  quadsFromStructuredText,
  isSelectionInPdfTextLayer,
} from "@/lib/pdf-text-selection";
import type { StructuredTextData } from "@/lib/mupdf/types";

describe("mergeClientRectsToQuads", () => {
  const pageRect = new DOMRect(100, 200, 400, 600);

  it("merges overlapping rects on the same line into one quad", () => {
    const rects = [
      new DOMRect(110, 220, 50, 16),
      new DOMRect(160, 220, 40, 16),
    ];
    const quads = mergeClientRectsToQuads(rects, pageRect, 2);
    expect(quads).toHaveLength(1);
    expect(quads[0][0]).toBeCloseTo(5);
    expect(quads[0][2]).toBeCloseTo(50);
  });

  it("skips rects outside the page bounds", () => {
    const rects = [new DOMRect(110, 900, 50, 16)];
    expect(mergeClientRectsToQuads(rects, pageRect, 1)).toHaveLength(0);
  });
});

describe("quadsFromStructuredText", () => {
  const textData: StructuredTextData = {
    blocks: [
      {
        type: "text",
        bbox: { x: 0, y: 0, w: 400, h: 20 },
        lines: [
          {
            bbox: { x: 72, y: 100, w: 200, h: 12 },
            wmode: 0,
            x: 72,
            y: 112,
            text: "Hello world from MuPDF",
            font: {
              name: "Serif",
              family: "serif",
              size: 12,
              weight: "normal",
              style: "normal",
            },
          },
        ],
      },
    ],
  };

  it("returns line-bbox quads for a matching substring", () => {
    const quads = quadsFromStructuredText(textData, "world");
    expect(quads).toHaveLength(1);
    expect(quads[0][0]).toBeGreaterThan(72);
    expect(quads[0][0]).toBeLessThan(160);
  });

  it("returns empty for non-matching text", () => {
    expect(quadsFromStructuredText(textData, "missing")).toEqual([]);
  });

  it("returns one quad per line for multi-line selections", () => {
    const multiLineData: StructuredTextData = {
      blocks: [
        {
          type: "text",
          bbox: { x: 0, y: 0, w: 400, h: 40 },
          lines: [
            {
              bbox: { x: 72, y: 100, w: 200, h: 12 },
              wmode: 0,
              x: 72,
              y: 112,
              text: "First line of text",
              font: {
                name: "Serif",
                family: "serif",
                size: 12,
                weight: "normal",
                style: "normal",
              },
            },
            {
              bbox: { x: 72, y: 120, w: 200, h: 12 },
              wmode: 0,
              x: 72,
              y: 132,
              text: "Second line here",
              font: {
                name: "Serif",
                family: "serif",
                size: 12,
                weight: "normal",
                style: "normal",
              },
            },
          ],
        },
      ],
    };
    const quads = quadsFromStructuredText(
      multiLineData,
      "First line\nSecond line",
    );
    expect(quads).toHaveLength(2);
    expect(quads[0][1]).not.toBeCloseTo(quads[1][1]);
  });

  it("matches partial text on each line for multi-line selections", () => {
    const multiLineData: StructuredTextData = {
      blocks: [
        {
          type: "text",
          bbox: { x: 0, y: 0, w: 400, h: 40 },
          lines: [
            {
              bbox: { x: 72, y: 100, w: 200, h: 12 },
              wmode: 0,
              x: 72,
              y: 112,
              text: "First line of text",
              font: {
                name: "Serif",
                family: "serif",
                size: 12,
                weight: "normal",
                style: "normal",
              },
            },
            {
              bbox: { x: 72, y: 120, w: 200, h: 12 },
              wmode: 0,
              x: 72,
              y: 132,
              text: "Second line here",
              font: {
                name: "Serif",
                family: "serif",
                size: 12,
                weight: "normal",
                style: "normal",
              },
            },
          ],
        },
      ],
    };
    const quads = quadsFromStructuredText(
      multiLineData,
      "line of text\nSecond line",
    );
    expect(quads).toHaveLength(2);
    expect(quads[0][0]).toBeGreaterThan(72);
    expect(quads[1][0]).toBeCloseTo(72, 0);
  });
});

describe("isSelectionInPdfTextLayer", () => {
  it("detects anchor inside the text layer", () => {
    document.body.innerHTML = `
      <svg class="mupdf-text-layer">
        <text id="t">Sample</text>
      </svg>
    `;
    const text = document.getElementById("t")!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(isSelectionInPdfTextLayer(sel)).toBe(true);
    sel.removeAllRanges();
    document.body.innerHTML = "";
  });
});
