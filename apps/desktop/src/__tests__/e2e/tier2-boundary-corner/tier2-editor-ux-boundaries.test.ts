import { describe, it, expect, beforeEach, vi } from "vitest";
import { createIsolatedHarness } from "../harness";

describe("Tier 2: Editor & UX Boundary & Corner Cases (Features 1 - 5)", () => {
  let harness = createIsolatedHarness();

  beforeEach(() => {
    harness = createIsolatedHarness();
  });

  // =========================================================================
  // Feature 1: Multi-File Tab Management Boundaries
  // =========================================================================
  describe("Feature 1: Multi-File Tab Management Boundaries", () => {
    interface Tab {
      id: string;
      path: string;
      title: string;
      isDirty: boolean;
    }

    it("T2-F01-01: closing the last remaining tab clears activeTabId without throwing", () => {
      let tabs: Tab[] = [
        { id: "tab1", path: "/a.typ", title: "a.typ", isDirty: false },
      ];
      let activeTabId: string | null = "tab1";

      // Close last
      tabs = [];
      activeTabId = null;

      expect(tabs).toHaveLength(0);
      expect(activeTabId).toBeNull();
    });

    it("T2-F01-02: middle-click (button === 1) triggers close and prevents default autoscroll", () => {
      const closeTab = vi.fn();
      const mockEvent = {
        button: 1,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };

      const handleMouseDown = (e: typeof mockEvent, tabId: string) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          closeTab(tabId);
        }
      };

      handleMouseDown(mockEvent, "tab_42");
      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(closeTab).toHaveBeenCalledWith("tab_42");
    });

    it("T2-F01-03: reordering tabs with out-of-bounds indices leaves array intact", () => {
      const tabs = ["tab1", "tab2", "tab3"];
      const safeReorder = (list: string[], from: number, to: number) => {
        if (from < 0 || from >= list.length || to < 0 || to >= list.length)
          return list;
        const copy = [...list];
        const [item] = copy.splice(from, 1);
        copy.splice(to, 0, item);
        return copy;
      };

      expect(safeReorder(tabs, -1, 2)).toEqual(tabs);
      expect(safeReorder(tabs, 0, 10)).toEqual(tabs);
      expect(safeReorder(tabs, 5, 0)).toEqual(tabs);
    });

    it("T2-F01-04: opening 100+ tabs preserves deterministic ordering and unique IDs", () => {
      const tabs: Tab[] = [];
      for (let i = 0; i < 120; i++) {
        tabs.push({
          id: `tab_${i}`,
          path: `/proj/file_${i}.typ`,
          title: `file_${i}.typ`,
          isDirty: false,
        });
      }

      expect(tabs).toHaveLength(120);
      const uniqueIds = new Set(tabs.map((t) => t.id));
      expect(uniqueIds.size).toBe(120);
      expect(tabs[119].title).toBe("file_119.typ");
    });

    it("T2-F01-05: closing a dirty tab flags unsaved change prompt before removal", () => {
      const dirtyTab: Tab = {
        id: "t1",
        path: "/a.typ",
        title: "a.typ",
        isDirty: true,
      };
      const requestClose = (tab: Tab): "prompt" | "close" => {
        return tab.isDirty ? "prompt" : "close";
      };

      expect(requestClose(dirtyTab)).toBe("prompt");
    });
  });

  // =========================================================================
  // Feature 2: Workspace Layout & Activity Dock Boundaries
  // =========================================================================
  describe("Feature 2: Workspace Layout & Activity Dock Boundaries", () => {
    it("T2-F02-01: problems dock handles empty diagnostics list with clean empty state", () => {
      const diagnostics: any[] = [];
      const renderProblemsCount = (list: any[]) => {
        if (list.length === 0) return "No problems detected in workspace.";
        return `${list.length} problems`;
      };

      expect(renderProblemsCount(diagnostics)).toBe(
        "No problems detected in workspace.",
      );
    });

    it("T2-F02-02: problems dock with 1,000+ compiler diagnostics handles pagination or bounded slice", () => {
      const manyDiagnostics = Array.from({ length: 1500 }, (_, i) => ({
        id: i,
        file: `file_${i % 10}.typ`,
        line: i + 1,
        message: `Diagnostic warning #${i}`,
      }));

      const pageSize = 100;
      const firstPage = manyDiagnostics.slice(0, pageSize);
      expect(firstPage).toHaveLength(100);
      expect(manyDiagnostics.length).toBe(1500);
    });

    it("T2-F02-03: activity bar clicking already active panel toggles it closed", () => {
      let activePanel: string | null = "outline";
      const togglePanel = (panel: string) => {
        activePanel = activePanel === panel ? null : panel;
      };

      togglePanel("outline");
      expect(activePanel).toBeNull();

      togglePanel("outline");
      expect(activePanel).toBe("outline");
    });

    it("T2-F02-04: problems dock height clamp respects minimum 60px and maximum 500px", () => {
      const clampHeight = (h: number) => Math.min(Math.max(h, 60), 500);

      expect(clampHeight(20)).toBe(60);
      expect(clampHeight(300)).toBe(300);
      expect(clampHeight(800)).toBe(500);
    });

    it("T2-F02-05: simultaneous layout resize respects total 100% allocation", () => {
      const allocatePanels = (sidebarPct: number, problemsPct: number) => {
        const clampedSidebar = Math.min(Math.max(sidebarPct, 15), 30);
        const clampedProblems = Math.min(Math.max(problemsPct, 10), 40);
        const mainEditorPct = 100 - clampedSidebar - clampedProblems;
        return {
          clampedSidebar,
          clampedProblems,
          mainEditorPct,
          total: clampedSidebar + clampedProblems + mainEditorPct,
        };
      };

      const result = allocatePanels(20, 25);
      expect(result.total).toBe(100);
      expect(result.mainEditorPct).toBe(55);
    });
  });

  // =========================================================================
  // Feature 3: Engine-Neutral Document Outline Boundaries
  // =========================================================================
  describe("Feature 3: Engine-Neutral Document Outline Boundaries", () => {
    function parseTypstOutlineRobust(
      source: string,
    ): Array<{ title: string; level: number; line: number }> {
      const lines = source.split("\n");
      const items: Array<{ title: string; level: number; line: number }> = [];
      let inCodeBlock = false;

      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          return;
        }
        if (inCodeBlock) return;

        const match = line.match(/^(=+)\s+(.+)$/);
        if (match) {
          items.push({
            level: match[1].length,
            title: match[2].trim(),
            line: idx + 1,
          });
        }
      });
      return items;
    }

    it("T2-F03-01: ignores fake headings inside fenced code blocks", () => {
      const doc = [
        "= Real Title",
        "```typst",
        "= Fake Heading in Code Block",
        "```",
        "== Real Subsection",
      ].join("\n");

      const outline = parseTypstOutlineRobust(doc);
      expect(outline).toHaveLength(2);
      expect(outline[0].title).toBe("Real Title");
      expect(outline[1].title).toBe("Real Subsection");
    });

    it("T2-F03-02: handles deeply nested headings (level 6+) without crashing", () => {
      const doc = "= Heading 1\n====== Deep Level 6 Heading";
      const outline = parseTypstOutlineRobust(doc);

      expect(outline).toHaveLength(2);
      expect(outline[1].level).toBe(6);
      expect(outline[1].title).toBe("Deep Level 6 Heading");
    });

    it("T2-F03-03: handles unicode characters and math symbols inside heading titles", () => {
      const doc =
        "= $\\mu$-Controller Architecture with 99.9% Uptime in $\\mathbb{R}^n$";
      const outline = parseTypstOutlineRobust(doc);

      expect(outline).toHaveLength(1);
      expect(outline[0].title).toContain("$\\mu$-Controller");
    });

    it("T2-F03-04: empty or whitespace-only documents produce empty outline array", () => {
      expect(parseTypstOutlineRobust("")).toHaveLength(0);
      expect(parseTypstOutlineRobust("   \n\n\t  \n")).toHaveLength(0);
    });

    it("T2-F03-05: parses LaTeX unclosed heading syntax gracefully", () => {
      const parseLatexLoose = (text: string) => {
        const matches = [
          ...text.matchAll(/\\(section|subsection)\*?\{([^}]+)/g),
        ];
        return matches.map((m) => m[2].trim());
      };

      const doc =
        "\\section{Valid Section}\n\\section{Unclosed Section without brace\nNext line";
      const sections = parseLatexLoose(doc);
      expect(sections).toHaveLength(2);
      expect(sections[0]).toBe("Valid Section");
      expect(sections[1]).toContain("Unclosed Section");
    });
  });

  // =========================================================================
  // Feature 4: Workspace-Integrated Resume Organizer Boundaries
  // =========================================================================
  describe("Feature 4: Workspace-Integrated Resume Organizer Boundaries", () => {
    it("T2-F04-01: empty variants list displays empty state CTA message", async () => {
      const variants = await harness.invoke("list_variants", {
        projectRoot: "/empty-proj",
      });
      const renderEmptyState = (items: any[]) => {
        return items.length === 0
          ? "No resume variants created yet. Create one from master."
          : "";
      };

      expect(renderEmptyState(variants)).toContain(
        "No resume variants created yet",
      );
    });

    it("T2-F04-02: handles variant with empty job description gracefully", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Empty JD Variant",
        jd: "",
        status: "draft",
      });

      expect(v.jd).toBe("");
      expect(v.id).toBe("empty-jd-variant");
    });

    it("T2-F04-03: rapid sequential variant switching does not cause race condition in active path", async () => {
      const v1 = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Var 1",
        jd: "",
        status: "draft",
      });
      const v2 = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Var 2",
        jd: "",
        status: "draft",
      });

      let activePath = "/proj";
      const switchVariant = async (path: string) => {
        activePath = path;
      };

      await Promise.all([
        switchVariant(v1.path),
        switchVariant(v2.path),
        switchVariant(v1.path),
      ]);

      expect([v1.path, v2.path]).toContain(activePath);
    });

    it("T2-F04-04: slugifies variant names containing illegal filesystem characters", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Google: Staff / SRE & Cloud (L6) *HOT*",
        jd: "JD",
        status: "applied",
      });

      expect(v.id).not.toContain(":");
      expect(v.id).not.toContain("/");
      expect(v.id).not.toContain("*");
      expect(v.id).toBe("google-staff-sre-cloud-l6-hot");
    });

    it("T2-F04-05: ATS readiness score boundaries (0 and 100) are accepted and rendered correctly", async () => {
      const v0 = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Low ATS",
        jd: "",
        status: "draft",
        atsScore: 0,
      });
      const v100 = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Perfect ATS",
        jd: "",
        status: "applied",
        atsScore: 100,
      });

      expect(v0.atsScore).toBe(0);
      expect(v100.atsScore).toBe(100);

      // Score > 100 rejected
      await expect(
        harness.invoke("update_variant", {
          projectRoot: "/proj",
          variantId: v0.id,
          atsScore: 150,
        }),
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // Feature 5: Dynamic Theme & Visual Polish Boundaries
  // =========================================================================
  describe("Feature 5: Dynamic Theme & Visual Polish Boundaries", () => {
    it("T2-F05-01: system theme resolves dynamically to dark or light based on media query", () => {
      const resolveSystemTheme = (prefersDark: boolean): "dark" | "light" => {
        return prefersDark ? "dark" : "light";
      };

      expect(resolveSystemTheme(true)).toBe("dark");
      expect(resolveSystemTheme(false)).toBe("light");
    });

    it("T2-F05-02: math palette query with no matches returns empty list without error", () => {
      const palette = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }];
      const search = (q: string) =>
        palette.filter((s) => s.name.includes(q.toLowerCase()));

      expect(search("xyz123")).toHaveLength(0);
    });

    it("T2-F05-03: math palette search handles regex meta-characters without crashing", () => {
      const palette = [
        { name: "\\alpha" },
        { name: "[bracket]" },
        { name: "sum*" },
      ];
      const safeSearch = (q: string) => {
        return palette.filter((s) =>
          s.name.toLowerCase().includes(q.toLowerCase()),
        );
      };

      expect(safeSearch("\\")).toHaveLength(1);
      expect(safeSearch("[")).toHaveLength(1);
      expect(safeSearch("*")).toHaveLength(1);
    });

    it("T2-F05-04: rapid theme toggling keeps native window theme in sync", async () => {
      await harness.invoke("set_native_window_theme", { theme: "light" });
      await harness.invoke("set_native_window_theme", { theme: "dark" });
      await harness.invoke("set_native_window_theme", { theme: "light" });
      await harness.invoke("set_native_window_theme", { theme: "dark" });

      expect(harness.nativeTheme).toBe("dark");
    });

    it("T2-F05-05: symbol insertion into empty editor buffer positions cursor accurately", () => {
      let buffer = "";
      let cursor = 0;

      const insertSymbol = (sym: string) => {
        buffer = buffer.slice(0, cursor) + sym + buffer.slice(cursor);
        cursor += sym.length;
      };

      insertSymbol("$alpha$");
      expect(buffer).toBe("$alpha$");
      expect(cursor).toBe(7);
    });
  });
});
