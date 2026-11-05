import { readFile } from "node:fs/promises";
import * as mupdf from "mupdf";
import {
  MAX_PAGE_BITMAP_BYTES,
  clearPageBitmaps,
  pageBitmapCacheBytesForTest,
  putPageBitmap,
} from "../../src/lib/mupdf/page-bitmap-cache";
import { collectSamples, measured, notMeasured } from "./stats";

/** renderScale 1 × 72 × MIN_RENDER_DPR (2). See mupdf-page.tsx. */
const DPI = 144;
const PAGES = 30;

class HeldBitmap {
  closed = false;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly pixels: Uint8Array,
  ) {}
  close(): void {
    this.closed = true;
  }
}

type Opened = {
  doc: mupdf.Document;
  fixture: string;
  pdfBytes: number;
};

function drawPage(doc: mupdf.Document, pageIndex: number): HeldBitmap {
  const page = doc.loadPage(pageIndex);
  const matrix = mupdf.Matrix.scale(DPI / 72, DPI / 72);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const rgb = pixmap.getPixels();
  if (rgb.length !== width * height * 3) {
    pixmap.destroy();
    throw new Error(`rgb length ${rgb.length} is not ${width}*${height}*3`);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  pixmap.destroy();
  return new HeldBitmap(width, height, rgba);
}

function drawAll(doc: mupdf.Document, pages: number): number {
  let pixels = 0;
  for (let i = 0; i < pages; i++) {
    const bitmap = drawPage(doc, i);
    pixels += bitmap.pixels.length;
  }
  if (pixels <= 0) throw new Error("full raster produced no pixels");
  return pixels;
}

async function openFixture(
  pdfPath: string,
  allowSynthetic: boolean,
): Promise<Opened> {
  try {
    const bytes = await readFile(pdfPath);
    if (
      bytes.length < 5 ||
      bytes[0] !== 0x25 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x44 ||
      bytes[3] !== 0x46 ||
      bytes[4] !== 0x2d
    ) {
      throw new Error(`${pdfPath} does not start with %PDF-`);
    }
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    if (doc.countPages() !== PAGES) {
      throw new Error(
        `${pdfPath} has ${doc.countPages()} pages, expected ${PAGES}`,
      );
    }
    return { doc, fixture: pdfPath, pdfBytes: bytes.length };
  } catch (error) {
    if (!allowSynthetic) throw error;
    const doc = new mupdf.PDFDocument();
    for (let i = 0; i < PAGES; i++) {
      const page = doc.addPage(
        [0, 0, 595, 842],
        0,
        {},
        `BT /F1 24 Tf 72 720 Td (bench page ${i + 1}) Tj ET`,
      );
      doc.insertPage(-1, page);
    }
    const saved = doc.saveToBuffer();
    const bytes = saved.asUint8Array();
    const opened = mupdf.Document.openDocument(bytes, "application/pdf");
    if (opened.countPages() !== PAGES) {
      throw new Error(`synthetic pdf has ${opened.countPages()} pages`);
    }
    return {
      doc: opened,
      fixture: "mupdf-synthetic-30-page (smoke only, not the typst fixture)",
      pdfBytes: bytes.length,
    };
  }
}

function scrollRetainedBytes(doc: mupdf.Document): number {
  clearPageBitmaps();
  if (pageBitmapCacheBytesForTest() !== 0) {
    throw new Error("bitmap cache did not clear");
  }
  for (let i = 0; i < PAGES; i++) {
    const bitmap = drawPage(doc, i);
    putPageBitmap(1, i, DPI, bitmap as unknown as ImageBitmap);
  }
  return pageBitmapCacheBytesForTest();
}

export async function measureRaster(pdfPath: string, allowSynthetic: boolean) {
  let opened: Opened;
  try {
    opened = await openFixture(pdfPath, allowSynthetic);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const missing = notMeasured(reason, {
      pdf_path: pdfPath,
      dpi: DPI,
      pages: PAGES,
    });
    return {
      first_page: missing,
      full_reraster: missing,
      retained_canvas_bytes: missing,
    };
  }

  const meta = {
    fixture: opened.fixture,
    pdf_byte_length: opened.pdfBytes,
    dpi: DPI,
    pages: PAGES,
    dpi_source: "renderScale 1 * 72 * MIN_RENDER_DPR 2",
    rgb_to_rgba: "same loop as mupdf-worker methods.drawPage",
  };

  try {
    drawPage(opened.doc, 0);
    drawAll(opened.doc, PAGES);
    const first = await collectSamples(() => {
      const started = performance.now();
      const bitmap = drawPage(opened.doc, 0);
      const ms = performance.now() - started;
      if (bitmap.pixels.length !== bitmap.width * bitmap.height * 4) {
        throw new Error("first page rgba length");
      }
      return ms;
    });
    const full = await collectSamples(() => {
      const started = performance.now();
      drawAll(opened.doc, PAGES);
      return performance.now() - started;
    });
    const retained = await collectSamples(() =>
      scrollRetainedBytes(opened.doc),
    );
    clearPageBitmaps();
    return {
      first_page: measured(first.summary, first.warmup, {
        ...meta,
        smoke: first.smoke,
        unit: "ms",
        what: "raster page 0 of the 30-page PDF at 144 DPI. compile_resume_pdf does not return after the first page; this is the raster, not a partial compile.",
      }),
      full_reraster: measured(full.summary, full.warmup, {
        ...meta,
        smoke: full.smoke,
        unit: "ms",
        what: "raster all 30 pages at 144 DPI, document already open",
      }),
      retained_canvas_bytes: measured(retained.summary, retained.warmup, {
        ...meta,
        smoke: retained.smoke,
        unit: "bytes",
        cap_bytes: MAX_PAGE_BITMAP_BYTES,
        what: "pageBitmapCacheBytesForTest after putPageBitmap of pages 0..29 in order. The cache evicts while total bytes exceed the cap and more than one page remains.",
      }),
    };
  } catch (error) {
    clearPageBitmaps();
    const reason = error instanceof Error ? error.message : String(error);
    const failed = notMeasured(reason, meta);
    return {
      first_page: failed,
      full_reraster: failed,
      retained_canvas_bytes: failed,
    };
  }
}
