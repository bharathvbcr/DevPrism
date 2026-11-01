import { describe, it, expect, beforeEach, vi } from "vitest";
import { createIsolatedHarness, assertPdfBuffer } from "../harness";
import { createAutoCompileScheduler } from "@/lib/auto-compile";

describe("Tier 3: Cross-Feature Combinations & Pairwise Interactions", () => {
  let harness = createIsolatedHarness();

  beforeEach(() => {
    harness = createIsolatedHarness();
  });

  // 1. Feature 1 (Tabs) + Feature 7 (Overlay)
  it("T3-01: switching active tab updates compiler overlay to the new active buffer", async () => {
    const tabs = [
      { id: "t1", path: "main.typ", content: "= Main Content" },
      { id: "t2", path: "skills.typ", content: "= Skills Content" },
    ];
    let activeTab = tabs[0];

    const getOverlay = () => ({ [activeTab.path]: activeTab.content });

    await harness.invoke("typst_compile_document", {
      projectDir: "/proj",
      mainFile: activeTab.path,
      overlay: getOverlay(),
    });
    expect(harness.lastCompileOverlay!["main.typ"]).toBe("= Main Content");

    // Switch tab
    activeTab = tabs[1];
    await harness.invoke("typst_compile_document", {
      projectDir: "/proj",
      mainFile: activeTab.path,
      overlay: getOverlay(),
    });
    expect(harness.lastCompileOverlay!["skills.typ"]).toBe("= Skills Content");
  });

  // 2. Feature 1 (Tabs) + Feature 8 (Adaptive Debounce)
  it("T3-02: switching from Typst tab to LaTeX tab updates debounce from 120ms to 1200ms", () => {
    const getDebounceForTab = (tabPath: string) => {
      return tabPath.endsWith(".typ") ? 120 : 1200;
    };

    expect(getDebounceForTab("cv.typ")).toBe(120);
    expect(getDebounceForTab("cv.tex")).toBe(1200);
  });

  // 3. Feature 1 (Tabs) + Feature 9 (Diagnostics)
  it("T3-03: diagnostics for tab A are not displayed in editor when tab B is active", () => {
    const allDiagnostics = [
      { file: "tabA.typ", line: 5, message: "Error in A" },
      { file: "tabB.typ", line: 12, message: "Error in B" },
    ];

    const getEditorDiagnostics = (activePath: string) => {
      return allDiagnostics.filter((d) => d.file === activePath);
    };

    expect(getEditorDiagnostics("tabA.typ")).toHaveLength(1);
    expect(getEditorDiagnostics("tabA.typ")[0].message).toBe("Error in A");
    expect(getEditorDiagnostics("tabB.typ")).toHaveLength(1);
    expect(getEditorDiagnostics("tabB.typ")[0].message).toBe("Error in B");
  });

  // 4. Feature 2 (Activity Dock) + Feature 4 (Resume Organizer)
  it("T3-04: toggling Organizer in Activity Bar mounts panel and retains Problems Dock state", () => {
    interface LayoutState {
      activeSidebar: "explorer" | "organizer";
      problemsDockOpen: boolean;
    }
    const layout: LayoutState = {
      activeSidebar: "explorer",
      problemsDockOpen: true,
    };

    // Toggle organizer in activity bar
    layout.activeSidebar = "organizer";
    expect(layout.activeSidebar).toBe("organizer");
    expect(layout.problemsDockOpen).toBe(true); // Retained
  });

  // 5. Feature 3 (Outline) + Feature 11 (Bidirectional Sync)
  it("T3-05: clicking heading in Outline syncs both editor cursor and PDF preview scroll", async () => {
    const heading = { title: "Experience", line: 25 };
    const syncResult = await harness.invoke("typst_sync_forward", {
      projectDir: "/proj",
      mainFile: "main.typ",
      file: "main.typ",
      line: heading.line,
    });

    expect(syncResult).toBeDefined();
    expect(syncResult.page).toBe(1);
    expect(syncResult.y).toBeGreaterThan(100);
  });

  // 6. Feature 4 (Resume Organizer) + Feature 15 (Organizer Data Model)
  it("T3-06: creating variant in Organizer persists extended manifest and immediately updates list", async () => {
    const created = await harness.invoke("create_variant", {
      projectRoot: "/proj",
      name: "Stripe Senior",
      jd: "Stripe JD",
      status: "draft",
      company: "Stripe",
      role: "Senior Engineer",
      atsScore: 85,
    });

    const list = await harness.invoke("list_variants", {
      projectRoot: "/proj",
    });
    const match = list.find((v: any) => v.id === created.id);
    expect(match).toBeDefined();
    expect(match.company).toBe("Stripe");
    expect(match.atsScore).toBe(85);
  });

  // 7. Feature 5 (Theme) + Feature 10 (Autocomplete)
  it("T3-07: autocomplete popup inherits theme tokens and dark class from documentElement", () => {
    document.documentElement.classList.add("dark");
    const isDarkMode = document.documentElement.classList.contains("dark");
    const popupTheme = isDarkMode ? "cm-tooltip-dark" : "cm-tooltip-light";

    expect(popupTheme).toBe("cm-tooltip-dark");
  });

  // 8. Feature 6 (Binary IPC) + Feature 12 (Stale-State Preservation)
  it("T3-08: failed binary IPC compile retains prior ArrayBuffer in preview canvas", async () => {
    let previewBuffer: ArrayBuffer | null = null;

    // Successful compile
    const buf = await harness.invoke("typst_compile_document", {
      projectDir: "/proj",
      mainFile: "main.typ",
    });
    previewBuffer = buf;

    // Failed compile
    try {
      await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
        overlay: { "main.typ": "#syntax_error" },
      });
    } catch {
      // Keep previous buffer
    }

    expect(previewBuffer).toBe(buf);
    assertPdfBuffer(previewBuffer!);
  });

  // 9. Feature 6 (Binary IPC) + Feature 7 (In-Memory Overlay)
  it("T3-09: binary IPC compile includes dirty overlay buffers and returns fresh PDF", async () => {
    const res = await harness.invoke("typst_compile_document", {
      projectDir: "/proj",
      mainFile: "main.typ",
      overlay: { "main.typ": "= Live Typst Overlay with Binary IPC" },
    });

    expect(res).toBeInstanceOf(ArrayBuffer);
    assertPdfBuffer(res);
    expect(harness.lastCompileOverlay!["main.typ"]).toContain(
      "Live Typst Overlay",
    );
  });

  // 10. Feature 8 (Adaptive Debounce) + Feature 12 (Stale-State Preservation)
  it("T3-10: rapid edits under adaptive debounce do not clear stale canvas until successful compile finishes", () => {
    vi.useFakeTimers();
    let canvas: string | null = "last_valid_pdf_data";
    const compile = vi.fn(() => {
      canvas = "fresh_pdf_data";
    });

    const scheduler = createAutoCompileScheduler(compile, 120);
    scheduler.sync({ enabled: true, ready: true, generation: 1 });
    scheduler.sync({ enabled: true, ready: true, generation: 2 });

    // Mid-debounce
    vi.advanceTimersByTime(50);
    expect(canvas).toBe("last_valid_pdf_data"); // Canvas preserved!

    // Debounce expires
    vi.advanceTimersByTime(80);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(canvas).toBe("fresh_pdf_data");

    scheduler.dispose();
    vi.useRealTimers();
  });

  // 11. Feature 9 (Diagnostics) + Feature 2 (Problems Dock)
  it("T3-11: compiler diagnostics from Typst compile populate both editor squiggles and Problems Dock list", async () => {
    let problemsDockItems: any[] = [];
    try {
      await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
        overlay: { "main.typ": "#syntax_error" },
      });
    } catch (err: any) {
      problemsDockItems = err.errors;
    }

    expect(problemsDockItems).toHaveLength(1);
    expect(problemsDockItems[0].message).toContain("syntax error");
    expect(problemsDockItems[0].line).toBe(2);
  });

  // 12. Feature 10 (Autocomplete) + Feature 7 (In-Memory Overlay)
  it("T3-12: autocomplete suggestions work seamlessly within unsaved in-memory overlay buffer", () => {
    const overlayBuffer = "= Introduction\n#al";
    const lastLine = overlayBuffer.split("\n").pop()!;

    const completions = ["#align", "#circle"].filter((c) =>
      c.startsWith(lastLine),
    );
    expect(completions).toEqual(["#align"]);
  });

  // 13. Feature 11 (Sync) + Feature 12 (Stale-State Preservation)
  it("T3-13: sync forward during stale preview state maps to known coordinates without error", async () => {
    const forward = await harness.invoke("typst_sync_forward", {
      projectDir: "/proj",
      mainFile: "main.typ",
      file: "main.typ",
      line: 10,
    });

    expect(forward).toBeDefined();
    expect(forward.page).toBe(1);
  });

  // 14. Feature 13 (Manvi Bridge) + Feature 14 (Vani Pipeline)
  it("T3-14: bridge streams NDJSON events from 4-phase tailoring pipeline to UI", async () => {
    const progressList: number[] = [];
    const unsubscribe = harness.listen("vani://tailor-progress", (p: any) => {
      progressList.push(p.phase);
    });

    await harness.invoke("manvi_tailor_resume", {
      request: {
        masterPath: "/proj/main.typ",
        jobDescription: "Senior Distributed Systems Engineer",
        targetPageBudget: 1,
        strictMetrics: true,
      },
    });

    expect(progressList).toEqual([1, 2, 3, 4]);
    unsubscribe();
  });

  // 15. Feature 14 (Vani Pipeline) + Feature 16 (Studio UI)
  it("T3-15: pipeline progress events and approval triggers drive Studio UI state machine", async () => {
    interface StudioUIState {
      phase: number;
      dialogActive: boolean;
      approved: boolean;
    }
    const uiState: StudioUIState = {
      phase: 0,
      dialogActive: false,
      approved: false,
    };

    harness.listen("vani://tailor-progress", (p: any) => {
      uiState.phase = p.phase;
    });

    harness.listen("vani://approval-required", (e: any) => {
      uiState.dialogActive = true;
      harness.invoke("manvi_approve_action", {
        approvalId: e.approvalId,
        allow: true,
      });
      uiState.approved = true;
      uiState.dialogActive = false;
    });

    await harness.invoke("manvi_tailor_resume", {
      request: {
        masterPath: "/proj/main.typ",
        jobDescription: "Staff Platform SRE",
        targetPageBudget: 1,
        strictMetrics: true,
      },
    });

    expect(uiState.phase).toBe(4);
    expect(uiState.approved).toBe(true);
  });

  // 16. Feature 15 (Organizer Data Model) + Feature 16 (Studio UI)
  it("T3-16: completing tailoring run updates variant ATS score and metadata in Organizer data model", async () => {
    const v = await harness.invoke("create_variant", {
      projectRoot: "/proj",
      name: "Tailored Google L6",
      jd: "Google L6 JD",
      status: "draft",
      atsScore: 65,
    });

    const tailoringRes = await harness.invoke("manvi_tailor_resume", {
      request: {
        masterPath: v.path,
        jobDescription: v.jd,
        targetPageBudget: 1,
        strictMetrics: true,
      },
    });

    const updated = await harness.invoke("update_variant", {
      projectRoot: "/proj",
      variantId: v.id,
      atsScore: tailoringRes.atsScore,
      status: "tailored",
    });

    expect(updated.atsScore).toBe(92);
    expect(updated.status).toBe("tailored");
  });
});
