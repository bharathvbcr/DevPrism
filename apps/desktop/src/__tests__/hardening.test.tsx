import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DocumentOutline } from "@/components/workspace/editor/document-outline";
import { ExportMenu } from "@/components/workspace/editor/export-menu";
import { SettingsDialog } from "@/components/settings-dialog";
import { usePersonalizationStore } from "@/stores/personalization-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "list_ollama_models") return undefined; // stress test undefined response
    if (cmd === "ollama_status")
      return { connected: false, base_url: "http://localhost:11434" };
    if (cmd === "list_claude_sessions") return [];
    return undefined;
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => "/tmp/export-test.pdf"),
}));

describe("Hardening & Ref Composition Suite", () => {
  beforeEach(() => {
    useDocumentStore.setState({
      projectRoot: "/test/project",
      initialized: true,
      activeFileId: "file1",
      files: [
        {
          id: "file1",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/test/project/main.tex",
          type: "tex",
          isDirty: false,
          content:
            "\\section{Introduction}\nSome intro text\n\\section{Methods}\nSome methods",
        },
      ],
    });
    useSettingsStore.setState({
      aiSummarize: true,
    });
  });

  it("renders DocumentOutline and opens popover without React Error #185", async () => {
    const editorViewRef = { current: null };
    render(
      <TooltipProvider>
        <DocumentOutline editorView={editorViewRef} />
      </TooltipProvider>,
    );

    const outlineTrigger = screen.getByRole("button", {
      name: "Document outline",
    });
    expect(outlineTrigger).toBeInTheDocument();

    // Click trigger to open Popover
    fireEvent.click(outlineTrigger);

    await waitFor(() => {
      expect(screen.getByText("Outline")).toBeInTheDocument();
      expect(screen.getByText("Introduction")).toBeInTheDocument();
      expect(screen.getByText("Methods")).toBeInTheDocument();
    });

    // Close and reopen to stress ref attach/detach cycle
    fireEvent.click(outlineTrigger); // close
    fireEvent.click(outlineTrigger); // reopen

    await waitFor(() => {
      expect(screen.getByText("Outline")).toBeInTheDocument();
    });
  });

  it("renders ExportMenu and opens dropdown without React Error #185", async () => {
    render(
      <TooltipProvider>
        <ExportMenu />
      </TooltipProvider>,
    );

    const exportTrigger = screen.getByRole("button", {
      name: "Export document",
    });
    expect(exportTrigger).toBeInTheDocument();

    // Trigger open
    fireEvent.pointerDown(exportTrigger);
    fireEvent.keyDown(exportTrigger, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("Export as")).toBeInTheDocument();
      expect(screen.getByText("Word (.docx)")).toBeInTheDocument();
      expect(screen.getByText("HTML (.html)")).toBeInTheDocument();
      expect(screen.getByText("Markdown (.md)")).toBeInTheDocument();
    });
  });

  it("renders SettingsDialog safely when Ollama models returns undefined", async () => {
    render(
      <TooltipProvider>
        <SettingsDialog open={true} appVersion="1.4.0" />
      </TooltipProvider>,
    );

    // Settings dialog renders without throwing TypeError: Cannot read properties of undefined (reading 'filter')
    expect(screen.getByText(/General/i)).toBeInTheDocument();
  });

  it("handles null / non-string responses safely in PersonalizationStore", async () => {
    const store = usePersonalizationStore.getState();
    expect(store.profile).toBeDefined();

    // Trigger AI refinement with null response
    await expect(
      store.triggerAiRefinement(
        "Some user experience text here",
        "resume distillation",
      ),
    ).resolves.not.toThrow();
  });
});
