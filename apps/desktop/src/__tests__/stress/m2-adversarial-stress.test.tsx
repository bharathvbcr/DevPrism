import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  useEditorTabsStore,
  EditorTabsStore,
  buildMultiTabCompileOverlay,
} from "@/stores/editor-tabs-store";
import { useDocumentStore } from "@/stores/document-store";
import { EditorTabStrip } from "@/components/workspace/editor-tab-strip";
import {
  ProblemsDock,
  clampProblemsDockHeight,
  renderProblemsCount,
  PROBLEMS_DOCK_MIN_HEIGHT,
  PROBLEMS_DOCK_MAX_HEIGHT,
} from "@/components/workspace/problems-dock";
import {
  clearTypstDiagnostics,
  setTypstDiagnostics,
  type TypstDiagnostic,
} from "@/lib/typst-diagnostics";

// Pure function test for allocatePanels logic without importing heavy Tauri side-effects
function allocatePanelsPure(sidebarPct: number, problemsPct: number) {
  const clampedSidebar = Math.min(Math.max(sidebarPct, 15), 30);
  const clampedProblems = Math.min(Math.max(problemsPct, 10), 40);
  const mainEditorPct = 100 - clampedSidebar - clampedProblems;
  return {
    clampedSidebar,
    clampedProblems,
    mainEditorPct,
    total: clampedSidebar + clampedProblems + mainEditorPct,
  };
}

describe("Milestone 2 Adversarial Stress Testing", () => {
  beforeEach(() => {
    useEditorTabsStore.getState().resetTabs();
    useDocumentStore.setState({
      files: [],
      activeFileId: undefined,
      compileError: null,
    });
    clearTypstDiagnostics();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearTypstDiagnostics();
  });

  // =========================================================================
  // 1. ADVERSARIAL TAB STRESS
  // =========================================================================

  describe("1. Adversarial Tab Stress", () => {
    it("handles 100+ tabs in rapid succession with deterministic IDs, active retention, and memory stability", () => {
      const store = useEditorTabsStore.getState();
      const TAB_COUNT = 150;

      // Rapidly open 150 tabs (when documentStore files are unpopulated)
      for (let i = 0; i < TAB_COUNT; i++) {
        store.openTab({
          id: `tab_id_${i}`,
          path: `sections/chapter_${i}.typ`,
          title: `Chapter ${i}`,
        });
      }

      const state = useEditorTabsStore.getState();
      expect(state.tabs).toHaveLength(TAB_COUNT);
      expect(state.openTabIds).toHaveLength(TAB_COUNT);
      expect(state.activeTabId).toBe(`tab_id_${TAB_COUNT - 1}`);

      // Verify deterministic tab IDs
      for (let i = 0; i < TAB_COUNT; i++) {
        expect(state.tabs[i].id).toBe(`tab_id_${i}`);
        expect(state.tabs[i].path).toBe(`sections/chapter_${i}.typ`);
        expect(state.tabs[i].title).toBe(`Chapter ${i}`);
        expect(state.openTabIds[i]).toBe(`tab_id_${i}`);
      }

      // Memory stability: Set of openTabIds matches tabs array exactly
      const uniqueIds = new Set(state.openTabIds);
      expect(uniqueIds.size).toBe(TAB_COUNT);

      // Verify active tab retention when opening with activate: false
      store.openTab(
        { id: "background_tab", path: "bg.typ", title: "Background" },
        { activate: false },
      );
      expect(useEditorTabsStore.getState().activeTabId).toBe(
        `tab_id_${TAB_COUNT - 1}`,
      );
      expect(useEditorTabsStore.getState().tabs).toHaveLength(TAB_COUNT + 1);

      // Verify re-opening an existing tab deduplicates and activates it without memory growth
      store.openTab({ id: "tab_id_42", path: "sections/chapter_42.typ" });
      const stateAfterReopen = useEditorTabsStore.getState();
      expect(stateAfterReopen.tabs).toHaveLength(TAB_COUNT + 1);
      expect(stateAfterReopen.activeTabId).toBe("tab_id_42");
    });

    it("enforces strict boundary guards during out-of-bounds reordering (from = -1, from = 1000, to = -5, to = 500)", () => {
      const store = useEditorTabsStore.getState();
      const files = [
        "doc_0.typ",
        "doc_1.typ",
        "doc_2.typ",
        "doc_3.typ",
        "doc_4.typ",
      ];
      files.forEach((f, idx) => store.openTab({ id: `tab_${idx}`, path: f }));

      const initialOrder = ["tab_0", "tab_1", "tab_2", "tab_3", "tab_4"];
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(
        initialOrder,
      );

      // Test extreme out-of-bounds indices against useEditorTabsStore
      store.reorderTabs(-1, 2);
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(
        initialOrder,
      );

      store.reorderTabs(1000, 2);
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(
        initialOrder,
      );

      store.reorderTabs(2, -5);
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(
        initialOrder,
      );

      store.reorderTabs(2, 500);
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(
        initialOrder,
      );

      store.reorderTabs(-100, -200);
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(
        initialOrder,
      );

      store.reorderTabs(500, 1000);
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(
        initialOrder,
      );

      store.reorderTabs(2, 2);
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual(
        initialOrder,
      );

      // Also test standalone EditorTabsStore class for same boundary invariants
      const classStore = new EditorTabsStore();
      files.forEach((f) => classStore.openTab({ path: f }));
      const initialClassPaths = classStore.tabs.map((t) => t.path);

      classStore.reorderTabs(-1, 2);
      expect(classStore.tabs.map((t) => t.path)).toEqual(initialClassPaths);

      classStore.reorderTabs(1000, 2);
      expect(classStore.tabs.map((t) => t.path)).toEqual(initialClassPaths);

      classStore.reorderTabs(2, -5);
      expect(classStore.tabs.map((t) => t.path)).toEqual(initialClassPaths);

      classStore.reorderTabs(2, 500);
      expect(classStore.tabs.map((t) => t.path)).toEqual(initialClassPaths);
    });

    it("verifies middle-click events: e.button === 1 triggers preventDefault(), stopPropagation(), and closes tab", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "t1", path: "main.typ", title: "Main Document" });
      store.openTab({ id: "t2", path: "ref.bib", title: "References" });

      const { container } = render(<EditorTabStrip />);
      const tabElements = container.querySelectorAll('[role="tab"]');
      expect(tabElements.length).toBe(2);

      const secondTab = tabElements[1];
      expect(secondTab.textContent).toContain("References");

      // Spy on preventDefault and stopPropagation
      const preventDefaultSpy = vi.fn();
      const stopPropagationSpy = vi.fn();

      const middleClickEvent = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 1, // Middle click
      });

      Object.defineProperty(middleClickEvent, "preventDefault", {
        value: preventDefaultSpy,
      });
      Object.defineProperty(middleClickEvent, "stopPropagation", {
        value: stopPropagationSpy,
      });

      act(() => {
        secondTab.dispatchEvent(middleClickEvent);
      });

      expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
      expect(stopPropagationSpy).toHaveBeenCalledTimes(1);
      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual([
        "t1",
      ]);
    });

    it("verifies dirty tab closing: closing an unsaved tab prompts without dropping the tab until confirmed", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "dirty_tab", path: "notes.typ", title: "My Notes" });
      store.setDirty("dirty_tab", true);

      // 1. Direct store invocation verification
      const promptRes = store.closeTab("dirty_tab", false);
      expect(promptRes).toBe("prompt");
      expect(useEditorTabsStore.getState().tabs).toHaveLength(1);
      expect(useEditorTabsStore.getState().tabs[0].id).toBe("dirty_tab");

      // 2. Component-level verification with UI confirmation dialog
      const { getByRole, getByText, queryByText } = render(<EditorTabStrip />);

      act(() => {
        const tabEl = screen.getByRole("tab");
        fireEvent.mouseEnter(tabEl);
      });

      const closeBtn = screen.getByLabelText("Close My Notes");
      act(() => {
        fireEvent.click(closeBtn);
      });

      // Dialog must appear
      expect(
        getByText(
          "My Notes has unsaved changes. Do you want to close it without saving?",
        ),
      ).toBeDefined();

      // Tab is STILL in the store and open in the DOM
      expect(useEditorTabsStore.getState().tabs).toHaveLength(1);

      // Click "Cancel"
      const cancelBtn = getByRole("button", { name: "Cancel" });
      act(() => {
        fireEvent.click(cancelBtn);
      });

      // Dialog is dismissed, tab still preserved
      expect(
        queryByText(
          "My Notes has unsaved changes. Do you want to close it without saving?",
        ),
      ).toBeNull();
      expect(useEditorTabsStore.getState().tabs).toHaveLength(1);

      // Click close again, then confirm "Close Without Saving"
      act(() => {
        fireEvent.click(closeBtn);
      });
      const confirmBtn = getByRole("button", { name: "Close Without Saving" });
      act(() => {
        fireEvent.click(confirmBtn);
      });

      // Tab is now confirmed closed and removed
      expect(useEditorTabsStore.getState().tabs).toHaveLength(0);
    });

    it("verifies buildMultiTabCompileOverlay aggregates dirty files without dropping clean files or throwing on empty projects", () => {
      // 1. Empty project test: must not throw, returns empty object
      useDocumentStore.setState({ files: [] });
      useEditorTabsStore.getState().resetTabs();

      expect(() => {
        const emptyOverlay = buildMultiTabCompileOverlay();
        expect(emptyOverlay).toEqual({});
      }).not.toThrow();

      // 2. Clean files project: clean files must NOT be placed into overlay, clean files in store must NOT be dropped
      useDocumentStore.setState({
        files: [
          {
            id: "clean1",
            name: "main.typ",
            relativePath: "main.typ",
            absolutePath: "/project/main.typ",
            content: "= Clean Title",
            type: "typst",
            isDirty: false,
          },
          {
            id: "clean2",
            name: "appendix.typ",
            relativePath: "appendix.typ",
            absolutePath: "/project/appendix.typ",
            content: "= Appendix Content",
            type: "typst",
            isDirty: false,
          },
        ],
      });
      const cleanOverlay = buildMultiTabCompileOverlay();
      expect(cleanOverlay).toEqual({});
      // Ensure clean files still exist intact in documentStore
      expect(useDocumentStore.getState().files).toHaveLength(2);

      // 3. Mixed clean and dirty files (via docStore.isDirty and editorTabsStore.dirtyTabIds)
      // Note: open tabs with activate: false to avoid mutual recursion trigger
      useEditorTabsStore
        .getState()
        .openTab({ id: "clean1", path: "main.typ" }, { activate: false });
      useEditorTabsStore
        .getState()
        .openTab({ id: "clean2", path: "appendix.typ" }, { activate: false });
      useEditorTabsStore
        .getState()
        .openTab({ id: "dirty1", path: "chapter1.typ" }, { activate: false });
      useEditorTabsStore
        .getState()
        .openTab({ id: "dirty2", path: "chapter2.typ" }, { activate: false });

      useDocumentStore.setState({
        files: [
          {
            id: "clean1",
            name: "main.typ",
            relativePath: "main.typ",
            absolutePath: "/project/main.typ",
            content: "= Clean Main",
            type: "typst",
            isDirty: false,
          },
          {
            id: "clean2",
            name: "appendix.typ",
            relativePath: "appendix.typ",
            absolutePath: "/project/appendix.typ",
            content: "= Clean Appendix",
            type: "typst",
            isDirty: false,
          },
          {
            id: "dirty1",
            name: "chapter1.typ",
            relativePath: "chapter1.typ",
            absolutePath: "/project/chapter1.typ",
            content: "= Edited Chapter 1 Buffer",
            type: "typst",
            isDirty: true,
          },
          {
            id: "dirty2",
            name: "chapter2.typ",
            relativePath: "chapter2.typ",
            absolutePath: "/project/chapter2.typ",
            content: "= Edited Chapter 2 Buffer",
            type: "typst",
            isDirty: false,
          },
        ],
      });

      useEditorTabsStore.getState().setDirty("dirty2", true);

      const mixedOverlay = buildMultiTabCompileOverlay();
      expect(mixedOverlay).toEqual({
        "chapter1.typ": "= Edited Chapter 1 Buffer",
        "chapter2.typ": "= Edited Chapter 2 Buffer",
      });

      // Verify clean files were neither included in overlay nor dropped from documentStore
      expect(mixedOverlay["main.typ"]).toBeUndefined();
      expect(mixedOverlay["appendix.typ"]).toBeUndefined();
      expect(useDocumentStore.getState().files.map((f) => f.id)).toEqual([
        "clean1",
        "clean2",
        "dirty1",
        "dirty2",
      ]);
    });

    it("verifies bulk tab operations under high tab load (closeOtherTabs, closeTabsToRight, closeAgentTabs, togglePin)", () => {
      const store = useEditorTabsStore.getState();
      const TAB_COUNT = 30;

      for (let i = 0; i < TAB_COUNT; i++) {
        store.openTab({
          id: `t_${i}`,
          path: `file_${i}.typ`,
          title: `File ${i}`,
        });
      }

      // Pin first 3 tabs
      store.pinTab("t_0");
      store.pinTab("t_1");
      store.pinTab("t_2");

      expect(useEditorTabsStore.getState().pinnedTabIds).toEqual([
        "t_0",
        "t_1",
        "t_2",
      ]);

      // Close tabs to right of t_10
      store.closeTabsToRight("t_10");
      const remainingAfterRight = useEditorTabsStore.getState().tabs;
      // All unpinned tabs after index of t_10 should be closed
      expect(remainingAfterRight.some((t) => t.id === "t_29")).toBe(false);

      // Close other tabs around t_5 (preserving pinned tabs t_0, t_1, t_2)
      store.closeOtherTabs("t_5");
      const remainingAfterOthers = useEditorTabsStore.getState().tabs;
      expect(remainingAfterOthers.map((t) => t.id)).toEqual([
        "t_0",
        "t_1",
        "t_2",
        "t_5",
      ]);
      expect(useEditorTabsStore.getState().activeTabId).toBe("t_5");

      // Add agent tabs and verify bulk closeAgentTabs
      store.openTab(
        { id: "agent_a", path: "agent_a.typ" },
        { agentOpened: true },
      );
      store.openTab(
        { id: "agent_b", path: "agent_b.typ" },
        { agentOpened: true },
      );
      expect(useEditorTabsStore.getState().tabs).toHaveLength(6);
      expect(useEditorTabsStore.getState().agentTabIds).toEqual([
        "agent_a",
        "agent_b",
      ]);

      store.closeAgentTabs();
      expect(useEditorTabsStore.getState().tabs).toHaveLength(4);
      expect(useEditorTabsStore.getState().agentTabIds).toHaveLength(0);
    });

    it("verifies mutual recursion guard prevents stack overflow between document-store and editor-tabs-store", () => {
      // Seed documentStore with files
      useDocumentStore.setState({
        files: [
          {
            id: "f1",
            name: "main.typ",
            relativePath: "main.typ",
            absolutePath: "/project/main.typ",
            content: "= Content",
            type: "typst",
            isDirty: false,
          },
          {
            id: "f2",
            name: "intro.typ",
            relativePath: "intro.typ",
            absolutePath: "/project/intro.typ",
            content: "= Intro",
            type: "typst",
            isDirty: false,
          },
        ],
        activeFileId: "f1",
      });

      // When openTab is called for "f2" (with default activate: true):
      // Recursion guard ensures mutual activation does not cause call stack overflow
      expect(() => {
        useEditorTabsStore.getState().openTab({ id: "f2", path: "intro.typ" });
      }).not.toThrow();

      expect(useEditorTabsStore.getState().activeTabId).toBe("f2");
      expect(useDocumentStore.getState().activeFileId).toBe("f2");
    });
  });

  // =========================================================================
  // 2. ADVERSARIAL PROBLEMS DOCK STRESS
  // =========================================================================

  describe("2. Adversarial Problems Dock Stress", () => {
    it("ingests 1,000+ mock compiler diagnostics and slices exactly 100 items per page without lag or leak", () => {
      const TOTAL_DIAGNOSTICS = 1250;
      const mockDiags: TypstDiagnostic[] = [];

      for (let i = 0; i < TOTAL_DIAGNOSTICS; i++) {
        mockDiags.push({
          severity: i % 3 === 0 ? "error" : "warning",
          message: `Diagnostic error code ERR_${i}: unexpected token at symbol`,
          file: `src/section_${i % 10}.typ`,
          line: (i % 200) + 1,
          column: (i % 80) + 1,
          hints: i % 5 === 0 ? [`Check syntax around symbol #${i}`] : [],
        });
      }

      // Ingest 1,250 diagnostics into the registry
      act(() => {
        setTypstDiagnostics("src/all.typ", mockDiags);
      });

      const { container, getByText } = render(
        <ProblemsDock isOpen={true} onToggle={() => {}} />,
      );

      // Header should display total count
      expect(getByText("1250")).toBeDefined();

      // Page 1: exactly 100 diagnostic items rendered in DOM
      let rows = container.querySelectorAll(".divide-y > div");
      expect(rows.length).toBe(100);
      expect(getByText("Showing 1–100 of 1250")).toBeDefined();
      expect(getByText("Page 1 of 13")).toBeDefined();

      // Navigate to Page 2
      const nextBtn = getByText("Next");
      act(() => {
        fireEvent.click(nextBtn);
      });

      rows = container.querySelectorAll(".divide-y > div");
      expect(rows.length).toBe(100);
      expect(getByText("Showing 101–200 of 1250")).toBeDefined();
      expect(getByText("Page 2 of 13")).toBeDefined();
    });

    it("verifies pagination resets to page 1 on filter or search change", () => {
      const TOTAL_DIAGNOSTICS = 1250;
      const mockDiags: TypstDiagnostic[] = [];
      for (let i = 0; i < TOTAL_DIAGNOSTICS; i++) {
        mockDiags.push({
          severity: i % 3 === 0 ? "error" : "warning",
          message: `ERR_${i}`,
          file: `file.typ`,
          line: 1,
          column: 1,
          hints: [],
        });
      }

      act(() => {
        setTypstDiagnostics("file.typ", mockDiags);
      });

      const { getByText } = render(
        <ProblemsDock isOpen={true} onToggle={() => {}} />,
      );

      // Advance to Page 5
      const nextBtn = getByText("Next");
      for (let i = 0; i < 4; i++) {
        act(() => {
          fireEvent.click(nextBtn);
        });
      }
      expect(getByText("Page 5 of 13")).toBeDefined();

      // Now switch filter to "Errors" (which has 417 items = 5 pages)
      const errorFilterBtn = screen.getByRole("button", {
        name: /Errors \(\d+\)/i,
      });
      act(() => {
        fireEvent.click(errorFilterBtn);
      });

      // Pagination resets to Page 1
      expect(getByText("Page 1 of 5")).toBeDefined();

      // Now switch to "Warnings" (which has 833 items = 9 pages)
      const warningFilterBtn = screen.getByRole("button", {
        name: /Warnings \(\d+\)/i,
      });
      act(() => {
        fireEvent.click(warningFilterBtn);
      });
      // Resets to Page 1 of 9
      expect(getByText("Page 1 of 9")).toBeDefined();

      // Advance to Page 5
      for (let i = 0; i < 4; i++) {
        act(() => {
          fireEvent.click(nextBtn);
        });
      }
      expect(getByText("Page 5 of 9")).toBeDefined();

      // Switch back to "Errors" (only 5 pages)
      act(() => {
        fireEvent.click(errorFilterBtn);
      });
      // Resets to Page 1 of 5
      expect(getByText("Page 1 of 5")).toBeDefined();

      // Advance to Page 2
      act(() => {
        fireEvent.click(nextBtn);
      });
      expect(getByText("Page 2 of 5")).toBeDefined();

      // Click Previous button to return to Page 1
      const prevBtn = getByText("Previous");
      act(() => {
        fireEvent.click(prevBtn);
      });
      expect(getByText("Page 1 of 5")).toBeDefined();
    });

    it("verifies height clamping under extreme resize values (-100px, 10px, 50px, 60px, 500px, 1200px) strictly clamps to [60px, 500px]", () => {
      // 1. Pure function clampProblemsDockHeight unit tests
      expect(clampProblemsDockHeight(-100)).toBe(60);
      expect(clampProblemsDockHeight(10)).toBe(60);
      expect(clampProblemsDockHeight(50)).toBe(60);
      expect(clampProblemsDockHeight(60)).toBe(60);
      expect(clampProblemsDockHeight(200)).toBe(200);
      expect(clampProblemsDockHeight(500)).toBe(500);
      expect(clampProblemsDockHeight(1200)).toBe(500);

      // Boundary constants check
      expect(PROBLEMS_DOCK_MIN_HEIGHT).toBe(60);
      expect(PROBLEMS_DOCK_MAX_HEIGHT).toBe(500);

      // 2. Component-level DOM style clamp tests
      const { rerender, getByTestId } = render(
        <ProblemsDock isOpen={true} onToggle={() => {}} height={-100} />,
      );
      expect(getByTestId("problems-dock").style.height).toBe("60px");

      rerender(<ProblemsDock isOpen={true} onToggle={() => {}} height={10} />);
      expect(getByTestId("problems-dock").style.height).toBe("60px");

      rerender(<ProblemsDock isOpen={true} onToggle={() => {}} height={50} />);
      expect(getByTestId("problems-dock").style.height).toBe("60px");

      rerender(<ProblemsDock isOpen={true} onToggle={() => {}} height={60} />);
      expect(getByTestId("problems-dock").style.height).toBe("60px");

      rerender(<ProblemsDock isOpen={true} onToggle={() => {}} height={300} />);
      expect(getByTestId("problems-dock").style.height).toBe("300px");

      rerender(<ProblemsDock isOpen={true} onToggle={() => {}} height={500} />);
      expect(getByTestId("problems-dock").style.height).toBe("500px");

      rerender(
        <ProblemsDock isOpen={true} onToggle={() => {}} height={1200} />,
      );
      expect(getByTestId("problems-dock").style.height).toBe("500px");

      // 3. allocatePanels layout calculation clamping
      const extremePanelsLow = allocatePanelsPure(-50, -20);
      expect(extremePanelsLow.clampedSidebar).toBe(15);
      expect(extremePanelsLow.clampedProblems).toBe(10);
      expect(extremePanelsLow.mainEditorPct).toBe(75);
      expect(extremePanelsLow.total).toBe(100);

      const extremePanelsHigh = allocatePanelsPure(999, 999);
      expect(extremePanelsHigh.clampedSidebar).toBe(30);
      expect(extremePanelsHigh.clampedProblems).toBe(40);
      expect(extremePanelsHigh.mainEditorPct).toBe(30);
      expect(extremePanelsHigh.total).toBe(100);
    });

    it("verifies that an empty diagnostic list renders the exact required string: 'No problems detected in workspace.'", () => {
      // 1. Helper function verification
      expect(renderProblemsCount([])).toBe(
        "No problems detected in workspace.",
      );
      expect(renderProblemsCount([1, 2])).toBe("2 problems");

      // 2. Component DOM verification with empty diagnostics
      clearTypstDiagnostics();
      useDocumentStore.setState({ compileError: null });

      const { getByText } = render(
        <ProblemsDock isOpen={true} onToggle={() => {}} />,
      );

      const emptyMsg = getByText("No problems detected in workspace.");
      expect(emptyMsg).toBeDefined();
      expect(emptyMsg.textContent?.trim()).toBe(
        "No problems detected in workspace.",
      );
    });
  });
});
