import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PdfPreview } from "@/components/workspace/preview/pdf-preview";
import { useDocumentStore, clearPdfBytesCache } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";

// Mock Tauri modules
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  exists: vi.fn(async () => true),
}));

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

// Mock PdfViewer component to inspect its mounting
vi.mock("@/components/workspace/preview/pdf-viewer", () => ({
  PdfViewer: ({ rootFileId }: { rootFileId: string }) => (
    <div data-testid="mocked-pdf-viewer-canvas" data-root-id={rootFileId}>
      Mocked PDF Canvas Content
    </div>
  ),
}));

// Mock MuPDF
vi.mock("@/lib/mupdf/mupdf-client", () => ({
  getMupdfClient: vi.fn(() => ({
    loadDocument: vi.fn(),
    renderPage: vi.fn(),
  })),
}));

vi.mock("@/lib/mupdf/pdf-doc-cache", () => ({
  getOrOpenDocument: vi.fn(),
}));

describe("Feature 12: Stale PDF Preservation in PdfPreview", () => {
  const dummyPdfBytes = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
  ]); // %PDF-1.7

  beforeEach(() => {
    vi.clearAllMocks();
    clearPdfBytesCache();

    useSettingsStore.setState({
      compilerBackend: "tectonic",
      autoCompile: true,
      pdfDarkMode: false,
      aiCompileAssist: false,
      nativeAgentEnabled: false,
    });

    useDocumentStore.setState({
      projectRoot: "/mock/project",
      activeFileId: "root_typ",
      files: [
        {
          id: "root_typ",
          name: "main.typ",
          relativePath: "main.typ",
          absolutePath: "/mock/project/main.typ",
          type: "typst",
          isDirty: false,
          content: "= Main Typst File",
        },
      ],
      compileError: null,
      isCompiling: false,
      pdfRevision: 0,
    });
  });

  it("renders full-screen error when compileError is present and no previous PDF data exists", () => {
    // pdfData is null initially
    useDocumentStore.setState({
      compileError: "Syntax error on line 1",
    });

    render(<PdfPreview />);

    // Must show full-screen error state
    expect(screen.getByText("Compilation Failed")).toBeInTheDocument();
    expect(screen.getByText("Syntax error on line 1")).toBeInTheDocument();

    // Canvas must NOT be mounted
    expect(
      screen.queryByTestId("mocked-pdf-viewer-canvas"),
    ).not.toBeInTheDocument();
    // Stale overlay badge must NOT be shown
    expect(
      screen.queryByTestId("stale-pdf-compile-error-overlay"),
    ).not.toBeInTheDocument();
  });

  it("renders canvas and NO error overlay on successful compilation", () => {
    // Populate valid PDF data
    useDocumentStore.getState().setPdfData(dummyPdfBytes, "root_typ");

    render(<PdfPreview />);

    // Canvas must be mounted
    expect(screen.getByTestId("mocked-pdf-viewer-canvas")).toBeInTheDocument();

    // No error overlay or full-screen error
    expect(
      screen.queryByTestId("stale-pdf-compile-error-overlay"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Compilation Failed")).not.toBeInTheDocument();
  });

  it("CRITICAL: preserves canvas and renders non-blocking floating overlay when compileError occurs with existing PDF data", () => {
    // 1. Initial successful compile: PDF bytes stored in cache
    useDocumentStore.getState().setPdfData(dummyPdfBytes, "root_typ");

    // 2. Subsequent compile error occurs (user typed syntax error in editor)
    useDocumentStore.setState({
      compileError: "Syntax error at line 5: expected semicolon",
    });

    render(<PdfPreview />);

    // VERIFICATION 1: Canvas is NOT unmounted or cleared!
    const canvas = screen.getByTestId("mocked-pdf-viewer-canvas");
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveAttribute("data-root-id", "root_typ");

    // VERIFICATION 2: Full-screen error is NOT rendered!
    expect(
      screen.queryByRole("heading", { name: "Compilation Failed", level: 2 }),
    ).not.toBeInTheDocument();

    // VERIFICATION 3: Floating non-blocking stale PDF overlay banner IS rendered!
    const staleOverlay = screen.getByTestId("stale-pdf-compile-error-overlay");
    expect(staleOverlay).toBeInTheDocument();
    expect(staleOverlay).toHaveTextContent(
      "Compilation Failed (Showing Previous PDF)",
    );
    expect(staleOverlay).toHaveTextContent(
      "Syntax error at line 5: expected semicolon",
    );
  });

  it("recovers cleanly from stale state when compilation succeeds again", () => {
    // Set initial PDF and compile error
    useDocumentStore.getState().setPdfData(dummyPdfBytes, "root_typ");
    useDocumentStore.setState({
      compileError: "Temporary syntax error",
    });

    const { rerender } = render(<PdfPreview />);

    expect(
      screen.getByTestId("stale-pdf-compile-error-overlay"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("mocked-pdf-viewer-canvas")).toBeInTheDocument();

    // Error resolves on next compile
    const updatedPdfBytes = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x38,
    ]);
    useDocumentStore.getState().setPdfData(updatedPdfBytes, "root_typ");
    useDocumentStore.setState({
      compileError: null,
    });

    rerender(<PdfPreview />);

    // Stale overlay removed, canvas still mounted
    expect(
      screen.queryByTestId("stale-pdf-compile-error-overlay"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("mocked-pdf-viewer-canvas")).toBeInTheDocument();
  });
});
