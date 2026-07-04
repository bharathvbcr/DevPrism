import { describe, it, expect, beforeEach, vi } from "vitest";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { useDocumentStore } from "@/stores/document-store";
import { writeTexFileContent } from "@/lib/tauri/fs";
import { invoke } from "@tauri-apps/api/core";

// Mock the document store (used by keepChange/undoChange)
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: {
    getState: vi.fn(() => ({
      files: [],
      reloadFile: vi.fn(),
    })),
  },
}));

// Mock writeTexFileContent
vi.mock("@/lib/tauri/fs", () => ({
  writeTexFileContent: vi.fn(() => Promise.resolve()),
}));

type DocFile = { relativePath: string; content: string | null };

function setDocFiles(
  files: DocFile[],
  reloadFile = vi.fn(() => Promise.resolve()),
) {
  vi.mocked(useDocumentStore.getState).mockReturnValue({
    files,
    reloadFile,
  } as never);
  return reloadFile;
}

describe("useProposedChangesStore", () => {
  beforeEach(() => {
    useProposedChangesStore.setState({ changes: [] });
    vi.mocked(writeTexFileContent).mockReset();
    vi.mocked(writeTexFileContent).mockResolvedValue(undefined);
    // The logger routes error/warn to invoke("js_log"); keep it a resolved promise.
    vi.mocked(invoke).mockResolvedValue(undefined);
    setDocFiles([]);
  });

  describe("addChange", () => {
    it("adds a new change", () => {
      useProposedChangesStore.getState().addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });
      const { changes } = useProposedChangesStore.getState();
      expect(changes).toHaveLength(1);
      expect(changes[0].id).toBe("tool-1");
      expect(changes[0].oldContent).toBe("old");
      expect(changes[0].newContent).toBe("new");
      expect(changes[0].timestamp).toBeGreaterThan(0);
    });

    it("merges changes for the same file, preserving original oldContent", () => {
      const store = useProposedChangesStore.getState();
      store.addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "original",
        newContent: "first-edit",
        toolName: "Edit",
      });
      store.addChange({
        id: "tool-2",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "first-edit",
        newContent: "second-edit",
        toolName: "Edit",
      });
      const { changes } = useProposedChangesStore.getState();
      expect(changes).toHaveLength(1);
      expect(changes[0].id).toBe("tool-2");
      expect(changes[0].oldContent).toBe("original"); // preserved baseline
      expect(changes[0].newContent).toBe("second-edit");
    });

    it("keeps changes for different files separate", () => {
      const store = useProposedChangesStore.getState();
      store.addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "a",
        newContent: "b",
        toolName: "Edit",
      });
      store.addChange({
        id: "tool-2",
        filePath: "refs.bib",
        absolutePath: "/project/refs.bib",
        oldContent: "c",
        newContent: "d",
        toolName: "Write",
      });
      expect(useProposedChangesStore.getState().changes).toHaveLength(2);
    });
  });

  describe("resolveChange", () => {
    it("removes a change by id", () => {
      useProposedChangesStore.getState().addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "a",
        newContent: "b",
        toolName: "Edit",
      });
      useProposedChangesStore.getState().resolveChange("tool-1");
      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
    });
  });

  describe("getChangeForFile", () => {
    it("returns the change for a given file path", () => {
      useProposedChangesStore.getState().addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "a",
        newContent: "b",
        toolName: "Edit",
      });
      const change = useProposedChangesStore
        .getState()
        .getChangeForFile("main.tex");
      expect(change).toBeDefined();
      expect(change!.id).toBe("tool-1");
    });

    it("returns undefined for unknown file", () => {
      const change = useProposedChangesStore
        .getState()
        .getChangeForFile("nonexistent.tex");
      expect(change).toBeUndefined();
    });
  });

  const seed = (
    over: Partial<
      Parameters<
        ReturnType<typeof useProposedChangesStore.getState>["addChange"]
      >[0]
    > = {},
  ) =>
    useProposedChangesStore.getState().addChange({
      id: "t1",
      filePath: "main.tex",
      absolutePath: "/project/main.tex",
      oldContent: "old",
      newContent: "new",
      toolName: "Edit",
      ...over,
    });

  describe("keepChange", () => {
    it("writes the document-store content (incl. inline edits) to disk, then clears", async () => {
      setDocFiles([{ relativePath: "main.tex", content: "inline-edited" }]);
      seed();
      await useProposedChangesStore.getState().keepChange("t1");
      expect(writeTexFileContent).toHaveBeenCalledWith(
        "/project/main.tex",
        "inline-edited",
      );
      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
    });

    it("leaves the change pending when the write fails", async () => {
      setDocFiles([{ relativePath: "main.tex", content: "x" }]);
      vi.mocked(writeTexFileContent).mockRejectedValueOnce(
        new Error("disk full"),
      );
      seed();
      await useProposedChangesStore.getState().keepChange("t1");
      expect(useProposedChangesStore.getState().changes).toHaveLength(1);
    });
  });

  describe("keepAll", () => {
    it("persists each file's content and does NOT revert via reloadFile", async () => {
      const reloadFile = setDocFiles([
        { relativePath: "a.tex", content: "A-inline" },
        { relativePath: "b.tex", content: "B-inline" },
      ]);
      seed({ id: "a", filePath: "a.tex", absolutePath: "/project/a.tex" });
      seed({ id: "b", filePath: "b.tex", absolutePath: "/project/b.tex" });
      await useProposedChangesStore.getState().keepAll();
      expect(writeTexFileContent).toHaveBeenCalledWith(
        "/project/a.tex",
        "A-inline",
      );
      expect(writeTexFileContent).toHaveBeenCalledWith(
        "/project/b.tex",
        "B-inline",
      );
      // The old bug reloaded from disk (reverting inline edits) instead of writing.
      expect(reloadFile).not.toHaveBeenCalled();
      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
    });

    it("keeps only the file whose write failed pending", async () => {
      setDocFiles([
        { relativePath: "a.tex", content: "A" },
        { relativePath: "b.tex", content: "B" },
      ]);
      vi.mocked(writeTexFileContent)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("readonly"));
      seed({ id: "a", filePath: "a.tex", absolutePath: "/project/a.tex" });
      seed({ id: "b", filePath: "b.tex", absolutePath: "/project/b.tex" });
      await useProposedChangesStore.getState().keepAll();
      const remaining = useProposedChangesStore.getState().changes;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].filePath).toBe("b.tex");
    });
  });

  describe("undoChange", () => {
    it("restores oldContent, reloads, and clears on success", async () => {
      const reloadFile = setDocFiles([
        { relativePath: "main.tex", content: "new" },
      ]);
      seed();
      await useProposedChangesStore.getState().undoChange("t1");
      expect(writeTexFileContent).toHaveBeenCalledWith(
        "/project/main.tex",
        "old",
      );
      expect(reloadFile).toHaveBeenCalledWith("main.tex");
      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
    });

    it("leaves the change pending when the undo write fails", async () => {
      setDocFiles([{ relativePath: "main.tex", content: "new" }]);
      vi.mocked(writeTexFileContent).mockRejectedValueOnce(
        new Error("readonly"),
      );
      seed();
      await useProposedChangesStore.getState().undoChange("t1");
      expect(useProposedChangesStore.getState().changes).toHaveLength(1);
    });
  });
});
