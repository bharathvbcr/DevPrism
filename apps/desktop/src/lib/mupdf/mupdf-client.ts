import type {
  StructuredTextData,
  LinkData,
  PageSize,
  Rect,
  WorkerResponse,
} from "./types";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("mupdf-worker");

export interface MupdfClient {
  openDocument(buffer: ArrayBuffer, magic?: string): Promise<number>;
  closeDocument(docId: number): Promise<void>;
  countPages(docId: number): Promise<number>;
  getPageSize(docId: number, pageIndex: number): Promise<PageSize>;
  getAllPageSizes(docId: number): Promise<PageSize[]>;
  drawPage(docId: number, pageIndex: number, dpi: number): Promise<ImageData>;
  getPageText(docId: number, pageIndex: number): Promise<StructuredTextData>;
  getPageLinks(docId: number, pageIndex: number): Promise<LinkData[]>;
  /** Find `needle` on a page, returning match rects in PDF point coordinates. */
  searchPage(docId: number, pageIndex: number, needle: string): Promise<Rect[]>;
  renderThumbnail(
    docId: number,
    pageIndex: number,
    targetWidth: number,
  ): Promise<ArrayBuffer>;
  /** Apply Highlight annotations to a copy of `buffer` and return saved PDF bytes. */
  exportAnnotatedPdf(
    buffer: ArrayBuffer,
    highlights: HighlightInput[],
  ): Promise<ArrayBuffer>;
  destroy(): void;
}

export interface HighlightInput {
  pageIndex: number;
  /** RGB 0..1. */
  color: [number, number, number];
  opacity?: number;
  /** Quads in page-space points: [ulx, uly, urx, ury, llx, lly, lrx, lry]. */
  quads: number[][];
  note?: string;
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

function createClient(): MupdfClient {
  const worker = new Worker(new URL("./mupdf-worker.ts", import.meta.url), {
    type: "module",
  });

  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let ready: Promise<void>;
  let resolveReady: () => void;

  ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as WorkerResponse;
    const [type, id, payload] = data;

    if (type === "INIT") {
      log.info("Worker initialized");
      resolveReady();
      return;
    }

    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);

    if (type === "RESULT") {
      request.resolve(payload);
    } else if (type === "ERROR") {
      const err = payload as { name: string; message: string };
      request.reject(new Error(`${err.name}: ${err.message}`));
    }
  };

  worker.onerror = (event) => {
    log.error("Worker fatal error", { message: event.message });
    // Nullify singleton so next getMupdfClient() creates a fresh worker
    instance = null;
  };

  const CALL_TIMEOUT_MS = 30_000;

  function call(method: string, ...args: unknown[]): Promise<any> {
    return ready.then(() => {
      return new Promise((resolve, reject) => {
        const id = nextId++;

        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(
              new Error(
                `MuPDF worker timeout: ${method} took longer than ${CALL_TIMEOUT_MS}ms`,
              ),
            );
          }
        }, CALL_TIMEOUT_MS);

        pending.set(id, {
          resolve: (value: any) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        });

        const transferables: Transferable[] = [];
        for (const arg of args) {
          if (arg instanceof ArrayBuffer) {
            transferables.push(arg);
          }
        }

        worker.postMessage([method, id, args], { transfer: transferables });
      });
    });
  }

  return {
    openDocument: (buffer, magic = "application/pdf") =>
      call("openDocument", buffer, magic),
    closeDocument: (docId) => call("closeDocument", docId),
    countPages: (docId) => call("countPages", docId),
    getPageSize: (docId, pageIndex) => call("getPageSize", docId, pageIndex),
    getAllPageSizes: (docId) => call("getAllPageSizes", docId),
    drawPage: (docId, pageIndex, dpi) =>
      call("drawPage", docId, pageIndex, dpi),
    getPageText: (docId, pageIndex) => call("getPageText", docId, pageIndex),
    getPageLinks: (docId, pageIndex) => call("getPageLinks", docId, pageIndex),
    searchPage: (docId, pageIndex, needle) =>
      call("searchPage", docId, pageIndex, needle),
    renderThumbnail: (docId, pageIndex, targetWidth) =>
      call("renderThumbnail", docId, pageIndex, targetWidth),
    exportAnnotatedPdf: (buffer, highlights) =>
      call("exportAnnotatedPdf", buffer, highlights),
    destroy: () => worker.terminate(),
  };
}

let instance: MupdfClient | null = null;

export function getMupdfClient(): MupdfClient {
  if (!instance) {
    instance = createClient();
  }
  return instance;
}

/** Terminate the current worker and clear the singleton, forcing recreation on next use. */
export function resetMupdfClient(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}
