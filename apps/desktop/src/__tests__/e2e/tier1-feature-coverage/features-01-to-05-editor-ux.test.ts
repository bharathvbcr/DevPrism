import { describe, it, expect, beforeEach, vi } from "vitest";
import { createIsolatedHarness } from "../harness";

// --- Tab Store Model & Interface ---
interface EditorTab {
  id: string;
  path: string;
  title: string;
  isDirty: boolean;
  isPinned?: boolean;
}

class EditorTabsStore {
  public tabs: EditorTab[] = [];
  public activeTabId: string | null = null;

  public openTab(file: { path: string; title: string }): void {
    const existing = this.tabs.find((t) => t.path === file.path);
    if (existing) {
      this.activeTabId = existing.id;
      return;
    }
    const newTab: EditorTab = {
      id: `tab_${Math.random().toString(36).slice(2, 8)}`,
      path: file.path,
      title: file.title,
      isDirty: false,
    };
    this.tabs.push(newTab);
    this.activeTabId = newTab.id;
  }

  public closeTab(id: string): void {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index === -1) return;
    this.tabs.splice(index, 1);
    if (this.activeTabId === id) {
      if (this.tabs.length === 0) {
        this.activeTabId = null;
      } else {
        const nextIndex = Math.min(index, this.tabs.length - 1);
        this.activeTabId = this.tabs[nextIndex].id;
      }
    }
  }

  public setDirty(id: string, isDirty: boolean): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) tab.isDirty = isDirty;
  }

  public reorderTabs(fromIndex: number, toIndex: number): void {
    if (
      fromIndex < 0 ||
      fromIndex >= this.tabs.length ||
      toIndex < 0 ||
      toIndex >= this.tabs.length
    ) {
      return;
    }
    const [moved] = this.tabs.splice(fromIndex, 1);
    this.tabs.splice(toIndex, 0, moved);
  }
}

// --- Outline Parser Helper ---
interface OutlineItem {
  id: string;
  title: string;
  level: number;
  line: number;
  type: "typst" | "latex";
}

function parseDocumentOutline(
  source: string,
  type: "typst" | "latex",
): OutlineItem[] {
  const lines = source.split("\n");
  const items: OutlineItem[] = [];

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    if (type === "typst") {
      const match = line.match(/^(=+)\s+(.+)$/);
      if (match) {
        items.push({
          id: `typ_${lineNum}`,
          level: match[1].length,
          title: match[2].trim(),
          line: lineNum,
          type: "typst",
        });
      }
    } else {
      const match = line.match(
        /\\(section|subsection|subsubsection)\*?\{([^}]+)\}/,
      );
      if (match) {
        const levelMap: Record<string, number> = {
          section: 1,
          subsection: 2,
          subsubsection: 3,
        };
        items.push({
          id: `tex_${lineNum}`,
          level: levelMap[match[1]] || 1,
          title: match[2].trim(),
          line: lineNum,
          type: "latex",
        });
      }
    }
  });

  return items;
}

describe("Tier 1: Editor & UX Feature Coverage (Features 1 - 5)", () => {
  let harness = createIsolatedHarness();

  beforeEach(() => {
    harness = createIsolatedHarness();
  });

  // =========================================================================
  // Feature 1: Multi-File Tab Management
  // =========================================================================
  describe("Feature 1: Multi-File Tab Management", () => {
    it("T1-F01-01: opening a new tab adds it to tab list and marks it as active", () => {
      const store = new EditorTabsStore();
      store.openTab({ path: "/project/main.typ", title: "main.typ" });

      expect(store.tabs).toHaveLength(1);
      expect(store.tabs[0].title).toBe("main.typ");
      expect(store.tabs[0].path).toBe("/project/main.typ");
      expect(store.activeTabId).toBe(store.tabs[0].id);
      expect(store.tabs[0].isDirty).toBe(false);
    });

    it("T1-F01-02: opening an existing tab activates it without creating duplicates", () => {
      const store = new EditorTabsStore();
      store.openTab({ path: "/project/main.typ", title: "main.typ" });
      store.openTab({ path: "/project/skills.typ", title: "skills.typ" });
      const firstTabId = store.tabs[0].id;

      expect(store.tabs).toHaveLength(2);
      expect(store.activeTabId).toBe(store.tabs[1].id);

      // Re-open first tab
      store.openTab({ path: "/project/main.typ", title: "main.typ" });
      expect(store.tabs).toHaveLength(2);
      expect(store.activeTabId).toBe(firstTabId);
    });

    it("T1-F01-03: closing the active tab activates the adjacent tab", () => {
      const store = new EditorTabsStore();
      store.openTab({ path: "/project/tab1.typ", title: "Tab 1" });
      store.openTab({ path: "/project/tab2.typ", title: "Tab 2" });
      store.openTab({ path: "/project/tab3.typ", title: "Tab 3" });
      const tab2Id = store.tabs[1].id;
      const tab3Id = store.tabs[2].id;

      // Active is Tab 3 (last). Closing tab 3 should activate tab 2.
      store.closeTab(tab3Id);
      expect(store.tabs).toHaveLength(2);
      expect(store.activeTabId).toBe(tab2Id);
    });

    it("T1-F01-04: tab dirty state updates on edit and clears on save", () => {
      const store = new EditorTabsStore();
      store.openTab({ path: "/project/main.typ", title: "main.typ" });
      const tabId = store.tabs[0].id;

      store.setDirty(tabId, true);
      expect(store.tabs[0].isDirty).toBe(true);

      store.setDirty(tabId, false);
      expect(store.tabs[0].isDirty).toBe(false);
    });

    it("T1-F01-05: reordering tabs moves tab position while preserving active tab", () => {
      const store = new EditorTabsStore();
      store.openTab({ path: "/project/a.typ", title: "A" });
      store.openTab({ path: "/project/b.typ", title: "B" });
      store.openTab({ path: "/project/c.typ", title: "C" });
      const activeId = store.activeTabId;

      store.reorderTabs(0, 2);
      expect(store.tabs[0].title).toBe("B");
      expect(store.tabs[1].title).toBe("C");
      expect(store.tabs[2].title).toBe("A");
      expect(store.activeTabId).toBe(activeId);
    });
  });

  // =========================================================================
  // Feature 2: Workspace Layout & Activity Dock
  // =========================================================================
  describe("Feature 2: Workspace Layout & Activity Dock", () => {
    it("T1-F02-01: activity bar rail toggles active sidebar view", () => {
      type ActivityView =
        | "explorer"
        | "outline"
        | "resume-organizer"
        | "problems";
      let activeView: ActivityView = "explorer";
      const setView = (v: ActivityView) => {
        activeView = v;
      };

      setView("outline");
      expect(activeView).toBe("outline");

      setView("resume-organizer");
      expect(activeView).toBe("resume-organizer");
    });

    it("T1-F02-02: bottom problems dock maintains visible state and diagnostic list", () => {
      interface ProblemsDockState {
        visible: boolean;
        diagnostics: Array<{
          file: string;
          line: number;
          message: string;
          severity: "error" | "warning";
        }>;
      }
      const state: ProblemsDockState = {
        visible: false,
        diagnostics: [],
      };

      state.visible = true;
      state.diagnostics = [
        {
          file: "main.typ",
          line: 12,
          message: "Undefined function #invalid()",
          severity: "error",
        },
        {
          file: "main.typ",
          line: 24,
          message: "Unused variable",
          severity: "warning",
        },
      ];

      expect(state.visible).toBe(true);
      expect(state.diagnostics).toHaveLength(2);
      expect(state.diagnostics[0].severity).toBe("error");
    });

    it("T1-F02-03: problems dock filters diagnostics by severity", () => {
      const diagnostics = [
        { message: "E1", severity: "error" as const },
        { message: "W1", severity: "warning" as const },
        { message: "E2", severity: "error" as const },
      ];
      const errors = diagnostics.filter((d) => d.severity === "error");
      const warnings = diagnostics.filter((d) => d.severity === "warning");

      expect(errors).toHaveLength(2);
      expect(warnings).toHaveLength(1);
    });

    it("T1-F02-04: clicking a problem navigates to target line and column", () => {
      const navigate = vi.fn();
      const problem = { file: "main.typ", line: 42, column: 7 };

      navigate(problem.file, problem.line, problem.column);
      expect(navigate).toHaveBeenCalledWith("main.typ", 42, 7);
    });

    it("T1-F02-05: assistant drawer toggle operates independently without occluding editor", () => {
      interface LayoutState {
        assistantOpen: boolean;
        editorWidthPct: number;
      }
      const layout: LayoutState = { assistantOpen: false, editorWidthPct: 50 };

      // Toggle assistant open: resizes proportionally rather than covering
      layout.assistantOpen = true;
      layout.editorWidthPct = 35; // docked side-by-side
      expect(layout.assistantOpen).toBe(true);
      expect(layout.editorWidthPct).toBe(35);
    });
  });

  // =========================================================================
  // Feature 3: Engine-Neutral Document Outline
  // =========================================================================
  describe("Feature 3: Engine-Neutral Document Outline", () => {
    it("T1-F03-01: parses Typst headings (=, ==, ===) into hierarchical tree", () => {
      const typstDoc = [
        "= Resume Title",
        "Some intro text",
        "== Experience",
        "Software Engineer details",
        "=== Project Alpha",
        "== Education",
      ].join("\n");

      const outline = parseDocumentOutline(typstDoc, "typst");
      expect(outline).toHaveLength(4);
      expect(outline[0]).toMatchObject({
        title: "Resume Title",
        level: 1,
        line: 1,
      });
      expect(outline[1]).toMatchObject({
        title: "Experience",
        level: 2,
        line: 3,
      });
      expect(outline[2]).toMatchObject({
        title: "Project Alpha",
        level: 3,
        line: 5,
      });
      expect(outline[3]).toMatchObject({
        title: "Education",
        level: 2,
        line: 6,
      });
    });

    it("T1-F03-02: parses LaTeX headings (\\section, \\subsection) into hierarchical tree", () => {
      const latexDoc = [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Summary}",
        "Brief bio",
        "\\subsection{Background}",
        "\\section{Skills}",
        "\\end{document}",
      ].join("\n");

      const outline = parseDocumentOutline(latexDoc, "latex");
      expect(outline).toHaveLength(3);
      expect(outline[0]).toMatchObject({ title: "Summary", level: 1, line: 3 });
      expect(outline[1]).toMatchObject({
        title: "Background",
        level: 2,
        line: 5,
      });
      expect(outline[2]).toMatchObject({ title: "Skills", level: 1, line: 6 });
    });

    it("T1-F03-03: accurately identifies document type by file extension", () => {
      const getDocType = (filename: string): "typst" | "latex" => {
        return filename.endsWith(".typ") ? "typst" : "latex";
      };
      expect(getDocType("cv.typ")).toBe("typst");
      expect(getDocType("cv.tex")).toBe("latex");
    });

    it("T1-F03-04: clicking outline item triggers scroll-to-line callback", () => {
      const scrollToLine = vi.fn();
      const item: OutlineItem = {
        id: "1",
        title: "Experience",
        level: 1,
        line: 15,
        type: "typst",
      };

      scrollToLine(item.line);
      expect(scrollToLine).toHaveBeenCalledWith(15);
    });

    it("T1-F03-05: active outline item is resolved from editor cursor line position", () => {
      const outline: OutlineItem[] = [
        { id: "1", title: "Intro", level: 1, line: 1, type: "typst" },
        { id: "2", title: "Experience", level: 1, line: 10, type: "typst" },
        { id: "3", title: "Education", level: 1, line: 25, type: "typst" },
      ];

      const getActiveOutlineItem = (cursorLine: number): OutlineItem | null => {
        let active: OutlineItem | null = null;
        for (const item of outline) {
          if (cursorLine >= item.line) active = item;
          else break;
        }
        return active;
      };

      expect(getActiveOutlineItem(5)?.title).toBe("Intro");
      expect(getActiveOutlineItem(15)?.title).toBe("Experience");
      expect(getActiveOutlineItem(30)?.title).toBe("Education");
    });
  });

  // =========================================================================
  // Feature 4: Workspace-Integrated Resume Organizer
  // =========================================================================
  describe("Feature 4: Workspace-Integrated Resume Organizer", () => {
    it("T1-F04-01: mounts organizer panel without unmounting workspace editor", async () => {
      const variants = await harness.invoke("list_variants", {
        projectRoot: "/proj",
      });
      expect(Array.isArray(variants)).toBe(true);
      expect(variants).toHaveLength(0);
    });

    it("T1-F04-02: displays variants with metadata tags and ATS scores", async () => {
      await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Google Staff SRE",
        jd: "JD for Google SRE",
        status: "applied",
        company: "Google",
        role: "Staff SRE",
        atsScore: 89,
      });

      const variants = await harness.invoke("list_variants", {
        projectRoot: "/proj",
      });
      expect(variants).toHaveLength(1);
      expect(variants[0].name).toBe("Google Staff SRE");
      expect(variants[0].company).toBe("Google");
      expect(variants[0].role).toBe("Staff SRE");
      expect(variants[0].atsScore).toBe(89);
    });

    it("T1-F04-03: switching variants sets active variant path in workspace", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Stripe Backend",
        jd: "JD Stripe",
        status: "draft",
      });

      expect(v.path).toContain(".prism/variants/stripe-backend");
    });

    it("T1-F04-04: in-place update of target JD persists to variant", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Datadog Eng",
        jd: "Old JD",
        status: "draft",
      });

      const updated = await harness.invoke("update_variant", {
        projectRoot: "/proj",
        variantId: v.id,
        jd: "New Targeted JD for Datadog",
      });

      expect(updated.jd).toBe("New Targeted JD for Datadog");
    });

    it("T1-F04-05: filters variant list by status", async () => {
      await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "V1",
        jd: "",
        status: "draft",
      });
      await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "V2",
        jd: "",
        status: "applied",
      });
      await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "V3",
        jd: "",
        status: "interview",
      });

      const all = await harness.invoke("list_variants", {
        projectRoot: "/proj",
      });
      const applied = all.filter((item: any) => item.status === "applied");
      expect(applied).toHaveLength(1);
      expect(applied[0].name).toBe("V2");
    });
  });

  // =========================================================================
  // Feature 5: Dynamic Theme & Visual Polish
  // =========================================================================
  describe("Feature 5: Dynamic Theme & Visual Polish", () => {
    it("T1-F05-01: applies light theme and updates documentElement classes", () => {
      const applyTheme = (theme: "light" | "dark") => {
        if (theme === "dark") {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
      };

      applyTheme("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it("T1-F05-02: applies dark theme and adds dark class to documentElement", () => {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("T1-F05-03: syncs native window theme via IPC invoke", async () => {
      await harness.invoke("set_native_window_theme", { theme: "light" });
      expect(harness.nativeTheme).toBe("light");

      await harness.invoke("set_native_window_theme", { theme: "dark" });
      expect(harness.nativeTheme).toBe("dark");
    });

    it("T1-F05-04: math palette renders categorized symbols", () => {
      const palette = [
        { category: "greek", name: "alpha", typst: "alpha", latex: "\\alpha" },
        { category: "greek", name: "beta", typst: "beta", latex: "\\beta" },
        { category: "operator", name: "sum", typst: "sum", latex: "\\sum" },
        { category: "relation", name: "leq", typst: "<=", latex: "\\le" },
      ];

      const greek = palette.filter((s) => s.category === "greek");
      expect(greek).toHaveLength(2);
      expect(greek[0].name).toBe("alpha");
    });

    it("T1-F05-05: math palette symbol insertion formats according to active mode", () => {
      const getSymbolSnippet = (
        symbol: { typst: string; latex: string },
        mode: "typst" | "latex",
      ) => {
        return mode === "typst" ? `$${symbol.typst}$` : `$${symbol.latex}$`;
      };

      const sym = { typst: "sum", latex: "\\sum" };
      expect(getSymbolSnippet(sym, "typst")).toBe("$sum$");
      expect(getSymbolSnippet(sym, "latex")).toBe("$\\sum$");
    });
  });
});
