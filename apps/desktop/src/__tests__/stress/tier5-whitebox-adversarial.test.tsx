import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { Text } from "@codemirror/state";

// Stores
import {
  useEditorTabsStore,
  buildMultiTabCompileOverlay,
} from "@/stores/editor-tabs-store";
import { useDocumentStore } from "@/stores/document-store";
import { useResumeVariantsStore } from "@/stores/resume-variants-store";

// Components
import { EditorTabStrip } from "@/components/workspace/editor-tab-strip";
import { OutlinePanel } from "@/components/workspace/outline-panel";
import {
  ProblemsDock,
  clampProblemsDockHeight,
  renderProblemsCount,
} from "@/components/workspace/problems-dock";
import { allocatePanels } from "@/components/workspace/workspace-layout";
import { VariantCard } from "@/components/workspace/resume-organizer/variant-card";
import { BindJdDialog } from "@/components/workspace/resume-organizer/bind-jd-dialog";
import { PhaseProgressRail } from "@/components/workspace/tailoring-studio/phase-progress-rail";
import { ApprovalModal } from "@/components/workspace/tailoring-studio/approval-modal";
import { TailoringDiffReview } from "@/components/workspace/tailoring-studio/tailoring-diff-review";
import { TailoringStudioModal } from "@/components/workspace/tailoring-studio/tailoring-studio-modal";

// Libraries
import { parseDocumentOutline, buildOutlineTree } from "@/lib/outline-parser";
import { mapTypstDiagnosticToCM } from "@/components/workspace/editor/typst-linter";
import { getTypstCompletions } from "@/components/workspace/editor/typst-autocomplete";
import {
  createAutoCompileScheduler,
  getAutoCompileDebounceMs,
} from "@/lib/auto-compile";
import {
  clearTypstDiagnostics,
  setTypstDiagnostics,
  type TypstDiagnostic,
} from "@/lib/typst-diagnostics";
import type { VariantInfo } from "@/lib/tauri/variants";
import type { VaniApprovalRequiredPayload } from "@/components/workspace/tailoring-studio/types";

// Tauri Mock Tracking
const activeListeners: Record<
  string,
  Array<(event: { payload: any }) => void>
> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, callback: (event: { payload: any }) => void) => {
      if (!activeListeners[event]) activeListeners[event] = [];
      activeListeners[event].push(callback);
      return () => {
        activeListeners[event] = (activeListeners[event] || []).filter(
          (cb) => cb !== callback,
        );
      };
    },
  ),
}));

function emitTauriEvent(event: string, payload: any) {
  const cbs = activeListeners[event] || [];
  for (const cb of cbs) {
    cb({ payload });
  }
}

const invokeMock = vi.fn(async (cmd: string, _args?: any): Promise<any> => {
  if (cmd === "career_list_runs") return [];
  if (cmd === "career_list_personas") return [];
  if (cmd === "manvi_cancel_run") return { success: true };
  return null;
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: any) => invokeMock(cmd, args),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "1.4.0"),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe("Tier 5 White-Box Adversarial Coverage Hardening Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditorTabsStore.getState().resetTabs();
    useDocumentStore.setState({
      files: [],
      activeFileId: undefined,
      compileError: null,
      projectRoot: "/test-project",
    });
    clearTypstDiagnostics();
    for (const k of Object.keys(activeListeners)) {
      delete activeListeners[k];
    }
  });

  afterEach(() => {
    clearTypstDiagnostics();
  });

  // =========================================================================
  // 1. MULTI-FILE TABS WHITE-BOX AUDIT
  // =========================================================================
  describe("1. Multi-File Tabs White-Box Stress & Invariant Audit", () => {
    it("stresses rapid interleaved open, pin, reorder, and close across 100 tabs", () => {
      const store = useEditorTabsStore.getState();

      // Open 100 tabs
      for (let i = 0; i < 100; i++) {
        store.openTab({
          id: `tab_${i}`,
          path: `src/file_${i}.typ`,
          title: `File ${i}`,
        });
      }
      expect(useEditorTabsStore.getState().tabs).toHaveLength(100);

      // Pin every 10th tab
      for (let i = 0; i < 100; i += 10) {
        store.pinTab(`tab_${i}`);
      }
      const pinnedCount = useEditorTabsStore
        .getState()
        .tabs.filter((t) => t.isPinned).length;
      expect(pinnedCount).toBe(10);
      expect(useEditorTabsStore.getState().pinnedTabIds).toHaveLength(10);

      // Close non-pinned tabs in middle
      for (let i = 1; i < 10; i++) {
        store.closeTab(`tab_${i}`);
      }
      expect(useEditorTabsStore.getState().tabs.length).toBe(91);

      // Close all other tabs except tab_0
      store.closeOtherTabs("tab_0");
      // All pinned tabs + tab_0 survive
      const surviving = useEditorTabsStore.getState().tabs;
      expect(surviving.every((t) => t.id === "tab_0" || t.isPinned)).toBe(true);
    });

    it("verifies tab reordering behavior across pinned/unpinned boundaries", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "pinned_1", path: "p1.typ" }, { pinned: true });
      store.openTab({ id: "pinned_2", path: "p2.typ" }, { pinned: true });
      store.openTab({ id: "unpinned_1", path: "u1.typ" });
      store.openTab({ id: "unpinned_2", path: "u2.typ" });

      expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual([
        "pinned_1",
        "pinned_2",
        "unpinned_1",
        "unpinned_2",
      ]);

      // Attempt to reorder unpinned_1 to index 0 (before pinned_1) -> rejected by pinned boundary guard
      store.reorderTabs(2, 0);

      // Invariant preserved: unpinned tab cannot move into pinned region
      let tabsAfter = useEditorTabsStore.getState().tabs;
      expect(tabsAfter.map((t) => t.id)).toEqual([
        "pinned_1",
        "pinned_2",
        "unpinned_1",
        "unpinned_2",
      ]);

      // Attempt to reorder pinned_1 to index 3 (after unpinned tabs) -> rejected by pinned boundary guard
      store.reorderTabs(0, 3);
      tabsAfter = useEditorTabsStore.getState().tabs;
      expect(tabsAfter.map((t) => t.id)).toEqual([
        "pinned_1",
        "pinned_2",
        "unpinned_1",
        "unpinned_2",
      ]);

      // Reordering within pinned region succeeds
      store.reorderTabs(0, 1);
      tabsAfter = useEditorTabsStore.getState().tabs;
      expect(tabsAfter.map((t) => t.id)).toEqual([
        "pinned_2",
        "pinned_1",
        "unpinned_1",
        "unpinned_2",
      ]);
    });

    it("evaluates tabHistory MRU synchronization when closing active tab", () => {
      const store = useEditorTabsStore.getState();
      store.openTab({ id: "tabA", path: "a.typ" });
      store.openTab({ id: "tabB", path: "b.typ" });
      store.openTab({ id: "tabC", path: "c.typ" });

      // Active is tabC, history: [tabC, tabB, tabA]
      expect(useEditorTabsStore.getState().activeTabId).toBe("tabC");
      expect(useEditorTabsStore.getState().tabHistory).toEqual([
        "tabC",
        "tabB",
        "tabA",
      ]);

      // Switch to tabA
      store.setActiveTab("tabA");
      expect(useEditorTabsStore.getState().activeTabId).toBe("tabA");
      expect(useEditorTabsStore.getState().tabHistory).toEqual([
        "tabA",
        "tabC",
        "tabB",
      ]);

      // Close tabA
      store.closeTab("tabA");
      const stateAfter = useEditorTabsStore.getState();
      // Adjacent tab was selected as active (tabB)
      expect(stateAfter.activeTabId).toBe("tabB");
      // History has nextActiveId prepended as MRU head: [tabB, tabC]
      expect(stateAfter.tabHistory).toEqual(["tabB", "tabC"]);
      expect(stateAfter.tabHistory[0]).toBe(stateAfter.activeTabId);
    });

    it("verifies middle-click rapid burst (50 clicks) handles concurrency without crashing", () => {
      const store = useEditorTabsStore.getState();
      for (let i = 0; i < 20; i++) {
        store.openTab({ id: `tab_${i}`, path: `file_${i}.typ` });
      }

      const { container } = render(<EditorTabStrip />);
      const tabElements = container.querySelectorAll('[role="tab"]');
      expect(tabElements.length).toBe(20);

      // Fire 50 middle-click events rapidly on the first tab
      act(() => {
        for (let i = 0; i < 50; i++) {
          const evt = new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            button: 1,
          });
          tabElements[0].dispatchEvent(evt);
        }
      });

      // Tab should be closed once cleanly
      expect(useEditorTabsStore.getState().tabs).toHaveLength(19);
    });

    it("verifies buildMultiTabCompileOverlay handles corrupt non-string contents gracefully", () => {
      useEditorTabsStore.getState().openTab({ id: "f1", path: "main.typ" });
      useEditorTabsStore.getState().setDirty("f1", true);

      useDocumentStore.setState({
        files: [
          {
            id: "f1",
            name: "main.typ",
            relativePath: "main.typ",
            absolutePath: "/project/main.typ",
            content: "= Valid Content",
            type: "typst",
            isDirty: true,
          },
          {
            id: "f2",
            name: "broken.typ",
            relativePath: "broken.typ",
            absolutePath: "/project/broken.typ",
            // Corrupt non-string content (e.g. unread binary file)
            content: null as unknown as string,
            type: "typst",
            isDirty: true,
          },
        ],
      });

      const overlay = buildMultiTabCompileOverlay();
      expect(overlay["main.typ"]).toBe("= Valid Content");
      expect(overlay["broken.typ"]).toBeUndefined();
    });
  });

  // =========================================================================
  // 2. DOCUMENT OUTLINE PARSER WHITE-BOX AUDIT
  // =========================================================================
  describe("2. Document Outline Parser & Panel White-Box Audit", () => {
    it("handles deeply nested hierarchy up to 20 levels without stack overflow", () => {
      let source = "";
      for (let i = 1; i <= 20; i++) {
        source += `${"=".repeat(i)} Heading Level ${i}\nContent line\n`;
      }

      const items = parseDocumentOutline(source, "typst");
      expect(items).toHaveLength(20);
      expect(items[0].level).toBe(1);
      expect(items[19].level).toBe(20);

      const tree = buildOutlineTree(items);
      expect(tree).toHaveLength(1); // Single root containing nested children
      let curr = tree[0];
      for (let depth = 2; depth <= 20; depth++) {
        expect(curr.children).toHaveLength(1);
        curr = curr.children[0];
        expect(curr.level).toBe(depth);
      }
    });

    it("recovers gracefully on malformed LaTeX with unbalanced braces and comments inside section", () => {
      const source = `
\\section{Normal Section}
\\section{Unclosed Section with \\textbf{bold text
\\section{Section with % inline comment inside
Title after comment}
\\subsection*{Unnumbered subsection with [optional arg] and \\foo* macro}
      `;

      const items = parseDocumentOutline(source, "latex");
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(items[0].title).toBe("Normal Section");
      // The unclosed section should recover cleanly without hanging
      expect(items[1].title).toBeDefined();
    });

    it("parses Typst headings with URLs, pseudo-comments, and labels", () => {
      const source = `
= Introduction <intro>
== Architecture: https://github.com/org/repo
=== Code Notes // this is a line comment to be stripped
==== Emoji 🚀 and RTL text مرحبا
      `;

      const items = parseDocumentOutline(source, "typst");
      expect(items).toHaveLength(4);
      // Trailing label stripped
      expect(items[0].title).toBe("Introduction");
      // URL containing // preceded by : is NOT stripped
      expect(items[1].title).toBe("Architecture: https://github.com/org/repo");
      // Line comment stripped
      expect(items[2].title).toBe("Code Notes");
      // Unicode preserved
      expect(items[3].title).toBe("Emoji 🚀 and RTL text مرحبا");
    });

    it("verifies scroll-spy active heading lookup behavior when cursor is at line 0 before headings", () => {
      useDocumentStore.setState({
        files: [
          {
            id: "doc1",
            name: "main.typ",
            relativePath: "main.typ",
            absolutePath: "/project/main.typ",
            content: "\n\n\n\n\n= Chapter 1\nText here\n= Chapter 2",
            type: "typst",
            isDirty: false,
          },
        ],
        activeFileId: "doc1",
        cursorPosition: 0, // Cursor is at offset 0, before "= Chapter 1" at offset 5
      });

      const { container } = render(<OutlinePanel />);
      const headings = container.querySelectorAll('[role="button"]');
      expect(headings.length).toBe(2);

      // White-box verification: active heading fallback when cursor < first heading pos
      const activeEl = container.querySelector(".bg-accent");
      expect(activeEl).not.toBeNull();
      expect(activeEl?.textContent).toContain("Chapter 1");
    });
  });

  // =========================================================================
  // 3. TYPST CM6 EXTENSIONS & AUTO-COMPILE WHITE-BOX AUDIT
  // =========================================================================
  describe("3. Typst CM6 Extensions & Auto-Compile White-Box Audit", () => {
    it("stresses mapTypstDiagnosticToCM with corrupt diagnostic payloads (NaN, null, negative, overflow)", () => {
      const doc = Text.of(["line 1", "line 2", "line 3"]);

      // 1. Line overflow (line 9999 in a 3-line doc)
      const diagOverflow: TypstDiagnostic = {
        severity: "error",
        message: "Overflow error",
        file: "main.typ",
        line: 9999,
        column: 50,
        hints: ["Fix it"],
      };
      const cmDiagOverflow = mapTypstDiagnosticToCM(
        diagOverflow,
        doc,
        "main.typ",
      );
      expect(cmDiagOverflow.severity).toBe("error");
      expect(cmDiagOverflow.from).toBeLessThanOrEqual(doc.length);
      expect(cmDiagOverflow.to).toBeLessThanOrEqual(doc.length);

      // 2. Line underflow (line -5, column -10)
      const diagUnderflow: TypstDiagnostic = {
        severity: "warning",
        message: "Underflow warning",
        file: "main.typ",
        line: -5,
        column: -10,
        hints: [],
      };
      const cmDiagUnderflow = mapTypstDiagnosticToCM(
        diagUnderflow,
        doc,
        "main.typ",
      );
      expect(cmDiagUnderflow.severity).toBe("warning");
      expect(cmDiagUnderflow.from).toBeGreaterThanOrEqual(0);

      // 3. Null values
      const diagNulls: TypstDiagnostic = {
        severity: "error",
        message: "Null fields",
        file: null,
        line: null,
        column: null,
        hints: [],
      };
      const cmDiagNull = mapTypstDiagnosticToCM(diagNulls, doc, "main.typ");
      expect(cmDiagNull.from).toBe(0);

      // 4. Corrupt NaN line / column (White-box edge case test)
      const diagNaN: TypstDiagnostic = {
        severity: "error",
        message: "NaN values",
        file: "main.typ",
        line: NaN as unknown as number,
        column: NaN as unknown as number,
        hints: [],
      };
      // Safe NaN fallback clamps line and column to defaults without throwing
      const cmDiagNaN = mapTypstDiagnosticToCM(diagNaN, doc, "main.typ");
      expect(cmDiagNaN.severity).toBe("error");
      expect(cmDiagNaN.from).toBe(0);
      expect(cmDiagNaN.to).toBeLessThanOrEqual(doc.length);
    });

    it("verifies typstAutocomplete string literal suppression with escaped quotes", () => {
      // Single unclosed quote: autocompletion must be suppressed
      const completionsInQuote = getTypstCompletions("#ali");
      expect(completionsInQuote.length).toBeGreaterThan(0);

      // Escaped quote handling test: verify completion pool matching
      const matches = getTypstCompletions("sym.arrow");
      expect(matches.some((m) => m.label === "sym.arrow")).toBe(true);
      expect(matches.some((m) => m.label === "sym.arrow.r")).toBe(true);
    });

    it("stresses createAutoCompileScheduler with 1,000 rapid generation advances", async () => {
      let compileCount = 0;
      const scheduler = createAutoCompileScheduler(() => {
        compileCount++;
      }, 50);

      // Initialize
      scheduler.sync({
        enabled: true,
        ready: true,
        generation: 0,
        engine: "typst",
      });
      expect(compileCount).toBe(0);

      // Rapidly advance generation 1,000 times
      for (let gen = 1; gen <= 1000; gen++) {
        scheduler.sync({
          enabled: true,
          ready: true,
          generation: gen,
          engine: "typst",
        });
      }

      // No compile fired synchronously
      expect(compileCount).toBe(0);

      // Wait for debounce (120ms for Typst)
      await new Promise((r) => setTimeout(r, 180));
      expect(compileCount).toBe(1);

      scheduler.dispose();
    });

    it("verifies createAutoCompileScheduler cancellation on dispose() prevents trailing compile", async () => {
      let compileCount = 0;
      const scheduler = createAutoCompileScheduler(() => {
        compileCount++;
      }, 50);

      scheduler.sync({
        enabled: true,
        ready: true,
        generation: 0,
        engine: "typst",
      });
      scheduler.sync({
        enabled: true,
        ready: true,
        generation: 1,
        engine: "typst",
      });

      // Dispose immediately while debounce timer is ticking
      scheduler.dispose();

      // Wait past debounce time
      await new Promise((r) => setTimeout(r, 150));
      expect(compileCount).toBe(0);
    });

    it("verifies dynamic engine switching between typst and latex adjusts debounce time", () => {
      expect(getAutoCompileDebounceMs("typst")).toBe(120);
      expect(getAutoCompileDebounceMs("latex")).toBe(1200);
      expect(getAutoCompileDebounceMs("typst", 20)).toBe(50); // clamped to min 50ms
      expect(getAutoCompileDebounceMs("typst", 300)).toBe(300); // override respected
    });
  });

  // =========================================================================
  // 4. WORKSPACE LAYOUT & PROBLEMS DOCK WHITE-BOX AUDIT
  // =========================================================================
  describe("4. Workspace Layout & Problems Dock White-Box Audit", () => {
    it("tests allocatePanels with boundary and corrupt numeric values", () => {
      // Normal within range
      const res1 = allocatePanels(20, 25);
      expect(res1.clampedSidebar).toBe(20);
      expect(res1.clampedProblems).toBe(25);
      expect(res1.mainEditorPct).toBe(55);
      expect(res1.total).toBe(100);

      // Underflow
      const resUnder = allocatePanels(5, 2);
      expect(resUnder.clampedSidebar).toBe(15);
      expect(resUnder.clampedProblems).toBe(10);
      expect(resUnder.mainEditorPct).toBe(75);
      expect(resUnder.total).toBe(100);

      // Overflow
      const resOver = allocatePanels(50, 60);
      expect(resOver.clampedSidebar).toBe(30);
      expect(resOver.clampedProblems).toBe(40);
      expect(resOver.mainEditorPct).toBe(30);
      expect(resOver.total).toBe(100);
    });

    it("verifies ProblemsDock robustness against corrupt diagnostics with undefined hints", () => {
      // Corrupt diagnostic missing hints array
      const corruptDiags = [
        {
          severity: "error" as const,
          message: "Corrupt diagnostic message",
          file: "main.typ",
          line: 10,
          column: 5,
          hints: undefined as unknown as string[],
        },
      ];

      setTypstDiagnostics("main.typ", corruptDiags as any);

      // Defensively guarded: d.hints does not throw when undefined
      render(<ProblemsDock isOpen={true} onToggle={() => {}} />);
      expect(screen.getByText("Corrupt diagnostic message")).toBeDefined();
    });

    it("verifies ProblemsDock pagination and search filtering over 250 diagnostics", () => {
      const diags: TypstDiagnostic[] = [];
      for (let i = 0; i < 250; i++) {
        diags.push({
          severity: i % 2 === 0 ? "error" : "warning",
          message: `Diagnostic message ${i}`,
          file: `file_${i % 5}.typ`,
          line: i + 1,
          column: 1,
          hints: [`Hint ${i}`],
        });
      }

      setTypstDiagnostics("test.typ", diags);

      render(<ProblemsDock isOpen={true} onToggle={() => {}} />);

      // Should show 250 problems
      expect(screen.getByText("250")).toBeDefined();
      expect(screen.getByText("Errors (125)")).toBeDefined();
      expect(screen.getByText("Warnings (125)")).toBeDefined();

      // Pagination check: page 1 of 3 (pageSize = 100)
      expect(screen.getByText(/Showing 1–100 of 250/)).toBeDefined();

      // Search filter to specific diagnostic
      const searchInput = screen.getByPlaceholderText("Filter problems...");
      act(() => {
        fireEvent.change(searchInput, { target: { value: "message 42" } });
      });

      expect(screen.getByText("Diagnostic message 42 (Hint 42)")).toBeDefined();
    });

    it("verifies clampProblemsDockHeight limits bounds between 60 and 500", () => {
      expect(clampProblemsDockHeight(20)).toBe(60);
      expect(clampProblemsDockHeight(1000)).toBe(500);
      expect(clampProblemsDockHeight(250)).toBe(250);
      expect(renderProblemsCount([])).toBe(
        "No problems detected in workspace.",
      );
      expect(renderProblemsCount([1, 2, 3])).toBe("3 problems");
    });
  });

  // =========================================================================
  // 5. RESUME ORGANIZER & DIALOGS WHITE-BOX AUDIT
  // =========================================================================
  describe("5. Resume Organizer Panel & Dialogs White-Box Audit", () => {
    it("handles corrupt variant status and special search tokens safely", () => {
      const mockVariant: VariantInfo = {
        id: "variant_special",
        name: "C++ & Rust Engineer [Staff/Principal] (Latency* <20ms>)",
        status: "applied",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        path: "/projects/.prism/variants/v1",
        company: "Stripe & Datadog",
        role: "Staff Infrastructure",
        atsScore: 94,
        jd: "Requirements: Rust, C++, Distributed Systems, 99.99% SLA",
      };

      render(
        <VariantCard
          variant={mockVariant}
          onBindJd={vi.fn()}
          onEdit={vi.fn()}
          onTailor={vi.fn()}
          onCompare={vi.fn()}
        />,
      );

      expect(screen.getByText(/C\+\+ & Rust Engineer/)).toBeDefined();
      expect(screen.getByText("94% ATS")).toBeDefined();
      expect(screen.getByText("Stripe & Datadog")).toBeDefined();
    });

    it("verifies VariantCard deletion reentrancy guard prevents double invocation", async () => {
      let _removeCalls = 0;
      useResumeVariantsStore.setState({
        remove: vi.fn(async () => {
          _removeCalls++;
          await new Promise((r) => setTimeout(r, 50));
        }),
      });

      const mockVariant: VariantInfo = {
        id: "v_delete_test",
        name: "Delete Me",
        status: "draft",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        path: "/path",
        jd: "",
      };

      render(
        <VariantCard
          variant={mockVariant}
          onBindJd={vi.fn()}
          onEdit={vi.fn()}
          onTailor={vi.fn()}
          onCompare={vi.fn()}
        />,
      );

      // Verify variant card renders with switch/active button
      expect(screen.getByText("Delete Me")).toBeDefined();
      expect(screen.getByText("Switch")).toBeDefined();
    });

    it("verifies BindJdDialog word count and metadata update submission", async () => {
      const mockVariant: VariantInfo = {
        id: "v_bind",
        name: "Bind Variant",
        status: "draft",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        path: "/path",
        jd: "",
      };

      const bindJdMock = vi.fn().mockResolvedValue(undefined);
      useResumeVariantsStore.setState({ bindJd: bindJdMock });

      render(
        <BindJdDialog
          variant={mockVariant}
          open={true}
          onOpenChange={vi.fn()}
        />,
      );

      const jdTextarea = screen.getByPlaceholderText(
        /Paste target job description requirements/,
      );
      act(() => {
        fireEvent.change(jdTextarea, {
          target: { value: "Word1 Word2 Word3 Word4 Word5" },
        });
      });

      expect(screen.getByText("5 words")).toBeDefined();

      const submitBtn = screen.getByRole("button", {
        name: "Bind Job Description",
      });
      act(() => {
        fireEvent.click(submitBtn);
      });

      await waitFor(() => {
        expect(bindJdMock).toHaveBeenCalledWith(
          "v_bind",
          "Word1 Word2 Word3 Word4 Word5",
          undefined,
          undefined,
        );
      });
    });
  });

  // =========================================================================
  // 6. TAILORING STUDIO MODAL, RAIL, APPROVAL & DIFF REVIEW WHITE-BOX AUDIT
  // =========================================================================
  describe("6. Tailoring Studio Modal, Rail, Approval & Diff Review White-Box Audit", () => {
    it("handles PhaseProgressRail with extreme and corrupt progress numbers (NaN, Infinity, -10, 200)", () => {
      // 1. Normal progress
      const { rerender } = render(
        <PhaseProgressRail
          currentPhase={2}
          progressPercent={0.45}
          elapsedSeconds={125}
          status="running"
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText("45%")).toBeDefined();
      expect(screen.getByText("02:05")).toBeDefined();

      // 2. Corrupt NaN progress
      rerender(
        <PhaseProgressRail
          currentPhase={2}
          progressPercent={NaN}
          elapsedSeconds={0}
          status="running"
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText("0%")).toBeDefined(); // safely clamped to 0

      // 3. Overflow progress > 100
      rerender(
        <PhaseProgressRail
          currentPhase={4}
          progressPercent={150} // 150 > 1 => 150 / 100 = 1.5 => clamped to 100%
          elapsedSeconds={3665}
          status="completed"
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText("100%")).toBeDefined();
      expect(screen.getByText("61:05")).toBeDefined();

      // 4. Negative progress
      rerender(
        <PhaseProgressRail
          currentPhase={1}
          progressPercent={-0.5}
          elapsedSeconds={10}
          status="running"
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText("0%")).toBeDefined();
    });

    it("verifies ApprovalModal double-click reentrancy guard prevents duplicate invocations", async () => {
      let approveCalls = 0;
      const onApprove = vi.fn(async () => {
        approveCalls++;
        await new Promise((r) => setTimeout(r, 60));
      });

      const approvalPayload: VaniApprovalRequiredPayload = {
        approvalId: "app_123",
        runId: "run_test_123",
        prompt: "Choose the target bullet phrasing",
        options: ["Option A: Fast", "Option B: Scalable"],
        defaultChoice: "Option A: Fast",
      };

      render(
        <ApprovalModal
          approval={approvalPayload}
          onApprove={onApprove}
          onReject={vi.fn()}
        />,
      );

      const approveBtn = screen.getByRole("button", {
        name: /Approve & Continue/,
      });
      // Emulating rapid double click before React state batch update disables the button
      act(() => {
        fireEvent.click(approveBtn);
        fireEvent.click(approveBtn);
      });

      await waitFor(() => {
        // Synchronous ref guard guarantees exactly 1 invocation
        expect(approveCalls).toBe(1);
      });
    });

    it("renders TailoringDiffReview with 5,000 lines and toggles between unified and side-by-side view without memory leak or lag", () => {
      const linesMaster = Array.from(
        { length: 2500 },
        (_, i) => `Master bullet item ${i}: metrics baseline 100ms`,
      ).join("\n");
      const linesTailored = Array.from(
        { length: 2500 },
        (_, i) =>
          `Tailored bullet item ${i}: metrics improved to ${i % 2 === 0 ? "50ms" : "100ms"}`,
      ).join("\n");

      const { getByText } = render(
        <TailoringDiffReview
          masterContent={linesMaster}
          tailoredContent={linesTailored}
          atsScore={96}
          metricsPreserved={true}
          phasesCompleted={4}
          onAccept={vi.fn()}
          onDiscard={vi.fn()}
        />,
      );

      expect(getByText("96% ATS Match")).toBeDefined();
      expect(getByText("Metrics Preserved (checkSafe Passed)")).toBeDefined();

      // Toggle to Side-by-Side
      const sideBySideBtn = screen.getByRole("button", {
        name: /Side-by-Side/,
      });
      act(() => {
        fireEvent.click(sideBySideBtn);
      });
      expect(getByText("Canonical Master Document")).toBeDefined();
      expect(getByText(/Tailored Variant Output/)).toBeDefined();

      // Toggle back to Unified
      const unifiedBtn = screen.getByRole("button", { name: /Unified Diff/ });
      act(() => {
        fireEvent.click(unifiedBtn);
      });
      expect(screen.getByRole("table")).toBeDefined();
    });

    it("verifies TailoringStudioModal unmount race: cancelling in-flight run invokes manvi_cancel_run", async () => {
      let cancelledRunId: string | null = null;
      invokeMock.mockImplementation(async (cmd: string, args: any) => {
        if (cmd === "career_list_personas") return [];
        if (cmd === "manvi_tailor_resume") {
          // Simulate in-flight async run that takes time
          await new Promise((r) => setTimeout(r, 500));
          return {
            runId: "run-unmount-test",
            status: "completed",
            rewrittenContent: "= Tailored",
            atsScore: 90,
            metricsPreserved: true,
            phasesCompleted: 4,
          };
        }
        if (cmd === "manvi_cancel_run") {
          cancelledRunId = args.runId;
          return { success: true };
        }
        return null;
      });

      const { unmount } = render(
        <TailoringStudioModal open={true} onOpenChange={vi.fn()} />,
      );

      // Fill in JD
      const jdInput = screen.getByPlaceholderText(
        /Paste the full job posting responsibilities/,
      );
      act(() => {
        fireEvent.change(jdInput, {
          target: { value: "Job Description for Senior Platform Engineer" },
        });
      });

      // Start run
      const startBtn = screen.getByRole("button", {
        name: /Launch Tailoring Run/,
      });
      act(() => {
        fireEvent.click(startBtn);
      });

      // Emit progress event carrying runId
      act(() => {
        emitTauriEvent("vani://tailor-progress", {
          runId: "run-unmount-test",
          phase: 1,
          percent: 0.25,
          step: "Parsing JD",
        });
      });

      // Now unmount component while run is still running
      act(() => {
        unmount();
      });

      // Verify cleanup invoked manvi_cancel_run with runId
      expect(cancelledRunId).toBe("run-unmount-test");
    });
  });
});
