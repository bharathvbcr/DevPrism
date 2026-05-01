import { beforeEach, describe, expect, it, vi } from "vitest";

describe("template preview cache", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("closes the MuPDF document when thumbnail rendering fails", async () => {
    const closeDocument = vi.fn(() => Promise.resolve());
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: vi.fn(() => Promise.resolve()),
      convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
    }));
    vi.doMock("@/lib/mupdf/mupdf-client", () => ({
      getMupdfClient: vi.fn(() => ({
        openDocument: vi.fn(() => Promise.resolve(42)),
        renderThumbnail: vi.fn(() =>
          Promise.reject(new Error("render failed")),
        ),
        closeDocument,
      })),
    }));

    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      } as Response),
    );

    const { generateThumbnail, isThumbnailFailed } = await import(
      "@/lib/template-preview-cache"
    );

    await expect(generateThumbnail("paper-standard")).resolves.toBeNull();
    expect(closeDocument).toHaveBeenCalledWith(42);
    expect(isThumbnailFailed("paper-standard")).toBe(true);
  });
});
