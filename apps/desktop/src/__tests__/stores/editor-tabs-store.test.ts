import { describe, it, expect, beforeEach } from "vitest";
import {
  useEditorTabsStore,
  EditorTabsStore,
  buildMultiTabCompileOverlay,
} from "@/stores/editor-tabs-store";
import { useDocumentStore } from "@/stores/document-store";

describe("editor-tabs-store", () => {
  beforeEach(() => {
    useEditorTabsStore.getState().resetTabs();
    useDocumentStore.setState({
      files: [],
      activeFileId: undefined,
    });
  });

  describe("useEditorTabsStore", () => {
    it("opens tabs and derives titles accurately", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "file1", path: "src/main.typ" });
      store.openTab({
        id: "file2",
        path: "sections/intro.typ",
        title: "Introduction",
      });

      const state = useEditorTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.tabs[0].title).toBe("main.typ");
      expect(state.tabs[1].title).toBe("Introduction");
      expect(state.activeTabId).toBe("file2");
    });

    it("deduplicates tabs when opening an already open tab", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "file1", path: "main.typ" });
      store.openTab({ id: "file2", path: "intro.typ" });
      store.openTab({ id: "file1", path: "main.typ" });

      const state = useEditorTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe("file1");
    });

    it("respects activate: false when opening a background tab", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "file1", path: "main.typ" });
      store.openTab({ id: "file2", path: "ref.bib" }, { activate: false });

      const state = useEditorTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe("file1");
    });

    it("guards dirty tab closure unless force: true", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "file1", path: "main.typ" });
      store.setDirty("file1", true);

      expect(useEditorTabsStore.getState().dirtyTabIds).toContain("file1");

      const promptRes = store.closeTab("file1", false);
      expect(promptRes).toBe("prompt");
      expect(useEditorTabsStore.getState().tabs).toHaveLength(1);

      const forceRes = store.closeTab("file1", true);
      expect(forceRes).toBe("closed");
      expect(useEditorTabsStore.getState().tabs).toHaveLength(0);
    });

    it("activates adjacent tab when the active tab is closed", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "tab1", path: "1.typ" });
      store.openTab({ id: "tab2", path: "2.typ" });
      store.openTab({ id: "tab3", path: "3.typ" });

      expect(useEditorTabsStore.getState().activeTabId).toBe("tab3");

      // Closing tab 3 activates tab 2
      store.closeTab("tab3");
      expect(useEditorTabsStore.getState().activeTabId).toBe("tab2");

      // Closing tab 2 activates tab 1
      store.closeTab("tab2");
      expect(useEditorTabsStore.getState().activeTabId).toBe("tab1");

      // Closing tab 1 leaves null
      store.closeTab("tab1");
      expect(useEditorTabsStore.getState().activeTabId).toBeNull();
    });

    it("handles pin and unpin, keeping pinned tabs grouped first", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "tab1", path: "1.typ" });
      store.openTab({ id: "tab2", path: "2.typ" });
      store.openTab({ id: "tab3", path: "3.typ" });

      store.pinTab("tab3");

      const state = useEditorTabsStore.getState();
      expect(state.pinnedTabIds).toContain("tab3");
      expect(state.tabs[0].id).toBe("tab3");
      expect(state.tabs[0].isPinned).toBe(true);

      store.unpinTab("tab3");
      expect(useEditorTabsStore.getState().pinnedTabIds).not.toContain("tab3");
      expect(
        useEditorTabsStore.getState().tabs.find((t) => t.id === "tab3")
          ?.isPinned,
      ).toBe(false);
    });

    it("closeOtherTabs preserves pinned tabs and active tab", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "pinned1", path: "p1.typ" }, { pinned: true });
      store.openTab({ id: "tab2", path: "2.typ" });
      store.openTab({ id: "tab3", path: "3.typ" });
      store.openTab({ id: "tab4", path: "4.typ" });

      store.closeOtherTabs("tab3");

      const state = useEditorTabsStore.getState();
      expect(state.tabs.map((t) => t.id)).toEqual(["pinned1", "tab3"]);
      expect(state.activeTabId).toBe("tab3");
    });

    it("closeTabsToRight closes tabs to the right while preserving pinned tabs", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "tab1", path: "1.typ" });
      store.openTab({ id: "tab2", path: "2.typ" });
      store.openTab({ id: "tab3", path: "3.typ" });
      store.openTab({ id: "tab4", path: "4.typ" });

      store.closeTabsToRight("tab2");

      const state = useEditorTabsStore.getState();
      expect(state.tabs.map((t) => t.id)).toEqual(["tab1", "tab2"]);
    });

    it("closeAgentTabs closes all agent-opened tabs", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "user1", path: "user1.typ" });
      store.openTab(
        { id: "agent1", path: "agent1.typ" },
        { agentOpened: true },
      );
      store.openTab(
        { id: "agent2", path: "agent2.typ" },
        { agentOpened: true },
      );

      expect(useEditorTabsStore.getState().tabs).toHaveLength(3);

      store.closeAgentTabs();

      const state = useEditorTabsStore.getState();
      expect(state.tabs.map((t) => t.id)).toEqual(["user1"]);
      expect(state.agentTabIds).toHaveLength(0);
    });

    it("reorders tabs safely with boundary guards", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "tab1", path: "1.typ" });
      store.openTab({ id: "tab2", path: "2.typ" });
      store.openTab({ id: "tab3", path: "3.typ" });

      // Out of bounds: should be no-op
      store.reorderTabs(-1, 2);
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual([
        "tab1",
        "tab2",
        "tab3",
      ]);

      store.reorderTabs(0, 5);
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual([
        "tab1",
        "tab2",
        "tab3",
      ]);

      // Valid reorder: move 0 to 2
      store.reorderTabs(0, 2);
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual([
        "tab2",
        "tab3",
        "tab1",
      ]);
    });

    it("renames tab cleanly", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "old.typ", path: "old.typ" });
      store.renameTab("old.typ", "new.typ", "Renamed Title");

      const state = useEditorTabsStore.getState();
      expect(state.tabs[0].id).toBe("new.typ");
      expect(state.tabs[0].title).toBe("Renamed Title");
      expect(state.activeTabId).toBe("new.typ");
    });
  });

  describe("EditorTabsStore standalone class", () => {
    it("handles tab lifecycle in class instance", () => {
      const store = new EditorTabsStore();
      store.openTab({ path: "main.typ" });
      store.openTab({ path: "intro.typ" });

      expect(store.tabs).toHaveLength(2);
      expect(store.activeTabId).toBe(store.tabs[1].id);

      store.setDirty(store.tabs[0].id, true);
      expect(store.closeTab(store.tabs[0].id, false)).toBe("prompt");
      expect(store.closeTab(store.tabs[0].id, true)).toBe("closed");
      expect(store.tabs).toHaveLength(1);
    });
  });

  describe("buildMultiTabCompileOverlay", () => {
    it("aggregates dirty document store files into an overlay record", () => {
      useDocumentStore.setState({
        files: [
          {
            id: "f1",
            name: "main.typ",
            relativePath: "main.typ",
            absolutePath: "/workspace/main.typ",
            content: "= Clean Content",
            type: "typst",
            isDirty: false,
          },
          {
            id: "f2",
            name: "chapter1.typ",
            relativePath: "chapter1.typ",
            absolutePath: "/workspace/chapter1.typ",
            content: "= Unsaved Edits",
            type: "typst",
            isDirty: true,
          },
        ],
        activeFileId: "f2",
      });

      const overlay = buildMultiTabCompileOverlay();
      expect(overlay).toEqual({
        "chapter1.typ": "= Unsaved Edits",
      });
    });
  });
});
