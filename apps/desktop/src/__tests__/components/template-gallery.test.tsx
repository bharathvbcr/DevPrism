import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateGallery } from "@/components/template-gallery";
import { useTemplateStore } from "@/stores/template-store";

vi.mock("@/lib/template-preview-cache", () => ({
  getThumbnail: vi.fn(() => undefined),
  isThumbnailFailed: vi.fn(() => true),
  subscribeThumbnails: vi.fn(() => () => {}),
  generateThumbnail: vi.fn(() => Promise.resolve(null)),
  getTemplatePdfUrl: vi.fn(
    (templateId: string) => `/examples/${templateId}/main.pdf`,
  ),
}));

describe("TemplateGallery keyboard navigation", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("640px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    useTemplateStore.getState().reset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("moves template selection with arrows and opens preview with Enter", async () => {
    await act(async () => {
      root.render(<TemplateGallery />);
    });

    const initial = useTemplateStore.getState().selectedTemplateId;
    expect(initial).toBe("paper-standard");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(useTemplateStore.getState().selectedTemplateId).toBe("paper-ieee");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(useTemplateStore.getState().previewTemplateId).toBe("paper-ieee");
  });
});
