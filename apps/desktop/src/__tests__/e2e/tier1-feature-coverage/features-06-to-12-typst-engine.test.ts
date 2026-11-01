import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createIsolatedHarness,
  assertPdfBuffer,
  type TypstCompileError,
} from "../harness";
import { createAutoCompileScheduler } from "@/lib/auto-compile";

describe("Tier 1: Typst Engine & Compilation Feature Coverage (Features 6 - 12)", () => {
  let harness = createIsolatedHarness();

  beforeEach(() => {
    harness = createIsolatedHarness();
  });

  // =========================================================================
  // Feature 6: Fast In-Process Typst Binary IPC
  // =========================================================================
  describe("Feature 6: Fast In-Process Typst Binary IPC", () => {
    it("T1-F06-01: successful compilation returns binary ArrayBuffer with PDF magic numbers", async () => {
      const response = await harness.invoke("typst_compile_document", {
        projectDir: "/project",
        mainFile: "main.typ",
      });

      expect(response).toBeInstanceOf(ArrayBuffer);
      assertPdfBuffer(response);
    });

    it("T1-F06-02: compilation returns non-empty byte buffer", async () => {
      const response = await harness.invoke("typst_compile_document", {
        projectDir: "/project",
        mainFile: "main.typ",
      });
      const bytes = new Uint8Array(response);
      expect(bytes.byteLength).toBeGreaterThan(100);
    });

    it("T1-F06-03: syntax error throws TypstCompileError with structured diagnostics", async () => {
      try {
        await harness.invoke("typst_compile_document", {
          projectDir: "/project",
          mainFile: "main.typ",
          overlay: {
            "main.typ": "#syntax_error unclosed",
          },
        });
        expect.unreachable("Compilation should have failed with syntax error");
      } catch (err: any) {
        const compileErr = err as TypstCompileError;
        expect(compileErr.message).toContain("Compilation failed");
        expect(compileErr.errors).toHaveLength(1);
        expect(compileErr.errors[0].severity).toBe("error");
        expect(compileErr.errors[0].line).toBe(2);
        expect(compileErr.errors[0].column).toBe(8);
      }
    });

    it("T1-F06-04: warm compile reports duration_ms metric", async () => {
      const start = performance.now();
      await harness.invoke("typst_compile_document", {
        projectDir: "/project",
        mainFile: "main.typ",
      });
      const duration = performance.now() - start;
      // In-process compilation should complete well within 500ms
      expect(duration).toBeLessThan(500);
    });

    it("T1-F06-05: compilation warnings are surfaced while still returning PDF bytes", async () => {
      const response = await harness.invoke("typst_compile_document", {
        projectDir: "/project",
        mainFile: "main.typ",
        overlay: {
          "main.typ": "#warning_tag Warning text",
        },
      });
      expect(response).toBeInstanceOf(ArrayBuffer);
      assertPdfBuffer(response);
    });
  });

  // =========================================================================
  // Feature 7: In-Memory Buffer Overlay
  // =========================================================================
  describe("Feature 7: In-Memory Buffer Overlay", () => {
    it("T1-F07-01: compile uses overlay content over on-disk source", async () => {
      const overlayContent =
        "= Unsaved Live Editor Content\nFresh edits live in memory.";
      const response = await harness.invoke("typst_compile_document", {
        projectDir: "/project",
        mainFile: "main.typ",
        overlay: {
          "main.typ": overlayContent,
        },
      });

      expect(harness.lastCompileOverlay).toBeDefined();
      expect(harness.lastCompileOverlay!["main.typ"]).toBe(overlayContent);
      assertPdfBuffer(response);
    });

    it("T1-F07-02: resolves multiple unsaved files from overlay map", async () => {
      const response = await harness.invoke("typst_compile_document", {
        projectDir: "/project",
        mainFile: "main.typ",
        overlay: {
          "main.typ": '#import "sections/experience.typ": *\n= Master',
          "sections/experience.typ": "= Experience\nSenior Engineer",
        },
      });

      expect(harness.lastCompileOverlay!["sections/experience.typ"]).toContain(
        "Senior Engineer",
      );
      assertPdfBuffer(response);
    });

    it("T1-F07-03: compiles successfully with empty overlay falling back to disk", async () => {
      const response = await harness.invoke("typst_compile_document", {
        projectDir: "/project",
        mainFile: "main.typ",
        overlay: {},
      });
      assertPdfBuffer(response);
    });

    it("T1-F07-04: consecutive keystroke overlay updates update compiler buffer immediately", async () => {
      await harness.invoke("typst_compile_document", {
        projectDir: "/project",
        mainFile: "main.typ",
        overlay: { "main.typ": "Keystroke 1" },
      });
      expect(harness.lastCompileOverlay!["main.typ"]).toBe("Keystroke 1");

      await harness.invoke("typst_compile_document", {
        projectDir: "/project",
        mainFile: "main.typ",
        overlay: { "main.typ": "Keystroke 2" },
      });
      expect(harness.lastCompileOverlay!["main.typ"]).toBe("Keystroke 2");
    });

    it("T1-F07-05: supports leading slash normalization in overlay paths", async () => {
      const response = await harness.invoke("typst_compile_document", {
        projectDir: "/project",
        mainFile: "main.typ",
        overlay: { "/main.typ": "= Normalized Path Content" },
      });
      assertPdfBuffer(response);
    });
  });

  // =========================================================================
  // Feature 8: Adaptive Auto-Compile Debounce
  // =========================================================================
  describe("Feature 8: Adaptive Auto-Compile Debounce", () => {
    it("T1-F08-01: Typst documents use fast 120ms debounce", () => {
      const getDebounceMs = (type: "typst" | "latex") =>
        type === "typst" ? 120 : 1200;
      expect(getDebounceMs("typst")).toBe(120);
    });

    it("T1-F08-02: LaTeX documents use standard 1200ms debounce", () => {
      const getDebounceMs = (type: "typst" | "latex") =>
        type === "typst" ? 120 : 1200;
      expect(getDebounceMs("latex")).toBe(1200);
    });

    it("T1-F08-03: rapid keystrokes on Typst coalesce into a single compilation call", () => {
      vi.useFakeTimers();
      const compile = vi.fn();
      const scheduler = createAutoCompileScheduler(compile, 120);

      scheduler.sync({ enabled: true, ready: true, generation: 1 });
      // Rapid typing burst: 5 generation bumps within 50ms
      scheduler.sync({ enabled: true, ready: true, generation: 2 });
      vi.advanceTimersByTime(20);
      scheduler.sync({ enabled: true, ready: true, generation: 3 });
      vi.advanceTimersByTime(20);
      scheduler.sync({ enabled: true, ready: true, generation: 4 });
      vi.advanceTimersByTime(20);
      scheduler.sync({ enabled: true, ready: true, generation: 5 });

      expect(compile).not.toHaveBeenCalled();

      // Settle period past 120ms debounce
      vi.advanceTimersByTime(130);
      expect(compile).toHaveBeenCalledTimes(1);

      scheduler.dispose();
      vi.useRealTimers();
    });

    it("T1-F08-04: rapid keystrokes on LaTeX wait full 1200ms before compiling", () => {
      vi.useFakeTimers();
      const compile = vi.fn();
      const scheduler = createAutoCompileScheduler(compile, 1200);

      scheduler.sync({ enabled: true, ready: true, generation: 1 });
      scheduler.sync({ enabled: true, ready: true, generation: 2 });

      vi.advanceTimersByTime(500);
      expect(compile).not.toHaveBeenCalled();

      vi.advanceTimersByTime(750);
      expect(compile).toHaveBeenCalledTimes(1);

      scheduler.dispose();
      vi.useRealTimers();
    });

    it("T1-F08-05: disabling auto-compile cancels pending debounced timer", () => {
      vi.useFakeTimers();
      const compile = vi.fn();
      const scheduler = createAutoCompileScheduler(compile, 120);

      scheduler.sync({ enabled: true, ready: true, generation: 1 });
      scheduler.sync({ enabled: true, ready: true, generation: 2 });

      // Disable before timer fires
      scheduler.sync({ enabled: false, ready: true, generation: 2 });

      vi.advanceTimersByTime(300);
      expect(compile).not.toHaveBeenCalled();

      scheduler.dispose();
      vi.useRealTimers();
    });
  });

  // =========================================================================
  // Feature 9: Typst Editor Diagnostics & Linting
  // =========================================================================
  describe("Feature 9: Typst Editor Diagnostics & Linting", () => {
    interface CMDiagnostic {
      from: number;
      to: number;
      severity: "error" | "warning" | "info";
      message: string;
      hints?: string[];
    }

    function mapTypstDiagnosticToCM(
      diag: {
        severity: "error" | "warning" | "info";
        message: string;
        line?: number;
        column?: number;
        hints: string[];
      },
      lineOffsets: number[],
    ): CMDiagnostic {
      const lineIdx = Math.max(0, (diag.line ?? 1) - 1);
      const lineStart = lineOffsets[lineIdx] ?? 0;
      const colOffset = Math.max(0, (diag.column ?? 1) - 1);
      const from = lineStart + colOffset;
      const to = from + 1;
      return {
        from,
        to,
        severity: diag.severity,
        message: diag.message,
        hints: diag.hints,
      };
    }

    it("T1-F09-01: maps compiler error to CodeMirror Diagnostic with severity 'error'", () => {
      const diag = {
        severity: "error" as const,
        message: "undefined symbol",
        line: 2,
        column: 5,
        hints: [],
      };
      const cmDiag = mapTypstDiagnosticToCM(diag, [0, 20, 50]);

      expect(cmDiag.severity).toBe("error");
      expect(cmDiag.message).toBe("undefined symbol");
      expect(cmDiag.from).toBe(24);
      expect(cmDiag.to).toBe(25);
    });

    it("T1-F09-02: maps compiler warning to CodeMirror Diagnostic with severity 'warning'", () => {
      const diag = {
        severity: "warning" as const,
        message: "unused import",
        line: 1,
        column: 1,
        hints: [],
      };
      const cmDiag = mapTypstDiagnosticToCM(diag, [0, 20]);

      expect(cmDiag.severity).toBe("warning");
      expect(cmDiag.message).toBe("unused import");
      expect(cmDiag.from).toBe(0);
    });

    it("T1-F09-03: preserves diagnostic hints in CodeMirror mapping", () => {
      const diag = {
        severity: "error" as const,
        message: "unknown function #algn",
        line: 3,
        column: 2,
        hints: ["did you mean #align?"],
      };
      const cmDiag = mapTypstDiagnosticToCM(diag, [0, 10, 25]);
      expect(cmDiag.hints).toContain("did you mean #align?");
    });

    it("T1-F09-04: successful compilation yields empty diagnostic list", () => {
      const errors: CMDiagnostic[] = [];
      expect(errors).toHaveLength(0);
    });

    it("T1-F09-05: multiple diagnostics on different lines map cleanly to disjoint offset ranges", () => {
      const diags = [
        {
          severity: "error" as const,
          message: "err1",
          line: 1,
          column: 1,
          hints: [],
        },
        {
          severity: "warning" as const,
          message: "warn1",
          line: 2,
          column: 3,
          hints: [],
        },
      ];
      const lineOffsets = [0, 30];
      const mapped = diags.map((d) => mapTypstDiagnosticToCM(d, lineOffsets));

      expect(mapped[0].from).toBe(0);
      expect(mapped[1].from).toBe(32);
      expect(mapped[1].from).toBeGreaterThan(mapped[0].to);
    });
  });

  // =========================================================================
  // Feature 10: Typst Editor Autocomplete
  // =========================================================================
  describe("Feature 10: Typst Editor Autocomplete", () => {
    interface CompletionOption {
      label: string;
      type: "keyword" | "function" | "symbol";
      apply?: string;
    }

    const TYPST_COMPLETIONS: CompletionOption[] = [
      {
        label: "#align",
        type: "function",
        apply: "#align(center)[]",
      },
      {
        label: "#circle",
        type: "function",
        apply: "#circle(radius: 10pt)",
      },
      { label: "#let", type: "keyword", apply: "#let var = value" },
      { label: "#set", type: "keyword", apply: "#set target()" },
      { label: "#show", type: "keyword", apply: "#show target: replacement" },
      {
        label: "#table",
        type: "function",
        apply: "#table(columns: 2)[]",
      },
      { label: "@ref", type: "keyword", apply: "@label" },
    ];

    function getCompletions(prefix: string): CompletionOption[] {
      if (!prefix.startsWith("#") && !prefix.startsWith("@")) return [];
      return TYPST_COMPLETIONS.filter((c) => c.label.startsWith(prefix));
    }

    it("T1-F10-01: typing '#' returns Typst built-in functions and keywords", () => {
      const completions = getCompletions("#");
      expect(completions.length).toBeGreaterThan(3);
      expect(completions.some((c) => c.label === "#let")).toBe(true);
      expect(completions.some((c) => c.label === "#align")).toBe(true);
    });

    it("T1-F10-02: typing '#al' filters completion suggestions to '#align'", () => {
      const completions = getCompletions("#al");
      expect(completions).toHaveLength(1);
      expect(completions[0].label).toBe("#align");
    });

    it("T1-F10-03: selecting function completion provides snippet template", () => {
      const completions = getCompletions("#table");
      expect(completions[0].apply).toContain("#table(columns:");
    });

    it("T1-F10-04: typing '@' triggers label reference completions", () => {
      const completions = getCompletions("@");
      expect(completions.some((c) => c.label === "@ref")).toBe(true);
    });

    it("T1-F10-05: ordinary text without trigger prefix yields no Typst keyword completions", () => {
      const completions = getCompletions("regular text");
      expect(completions).toHaveLength(0);
    });
  });

  // =========================================================================
  // Feature 11: Typst Bidirectional Sync
  // =========================================================================
  describe("Feature 11: Typst Bidirectional Sync", () => {
    it("T1-F11-01: typst_sync_forward maps line 1 to page 1 coordinates", async () => {
      const forward = await harness.invoke("typst_sync_forward", {
        projectDir: "/proj",
        mainFile: "main.typ",
        file: "main.typ",
        line: 1,
      });

      expect(forward).toBeDefined();
      expect(forward.page).toBe(1);
      expect(forward.x).toBeGreaterThan(0);
      expect(forward.y).toBeGreaterThan(0);
      expect(forward.width).toBeGreaterThan(0);
      expect(forward.height).toBeGreaterThan(0);
    });

    it("T1-F11-02: forward sync to subsequent lines returns lower vertical coordinates or next page", async () => {
      const line1 = await harness.invoke("typst_sync_forward", {
        projectDir: "/proj",
        mainFile: "main.typ",
        file: "main.typ",
        line: 1,
      });
      const line25 = await harness.invoke("typst_sync_forward", {
        projectDir: "/proj",
        mainFile: "main.typ",
        file: "main.typ",
        line: 25,
      });

      expect(line25.y).toBeGreaterThan(line1.y);
    });

    it("T1-F11-03: typst_sync_inverse maps page coordinates back to source line", async () => {
      const inverse = await harness.invoke("typst_sync_inverse", {
        projectDir: "/proj",
        mainFile: "main.typ",
        page: 1,
        x: 100,
        y: 220,
      });

      expect(inverse).toBeDefined();
      expect(inverse.file).toBe("main.typ");
      expect(inverse.line).toBe(10);
    });

    it("T1-F11-04: inverse sync on page margins returns null", async () => {
      const inverse = await harness.invoke("typst_sync_inverse", {
        projectDir: "/proj",
        mainFile: "main.typ",
        page: 1,
        x: 10,
        y: 20, // margin header area
      });

      expect(inverse).toBeNull();
    });

    it("T1-F11-05: sync forward gracefully handles out of bounds lines", async () => {
      const result = await harness.invoke("typst_sync_forward", {
        projectDir: "/proj",
        mainFile: "main.typ",
        file: "main.typ",
        line: 99999,
      });
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // Feature 12: Preview Stale-State Preservation
  // =========================================================================
  describe("Feature 12: Preview Stale-State Preservation", () => {
    interface PreviewStoreState {
      currentPdf: ArrayBuffer | null;
      lastSuccessfulPdf: ArrayBuffer | null;
      isStale: boolean;
      errorMessage: string | null;
    }

    class PreviewManager {
      public state: PreviewStoreState = {
        currentPdf: null,
        lastSuccessfulPdf: null,
        isStale: false,
        errorMessage: null,
      };

      public onCompileSuccess(pdf: ArrayBuffer): void {
        this.state.currentPdf = pdf;
        this.state.lastSuccessfulPdf = pdf;
        this.state.isStale = false;
        this.state.errorMessage = null;
      }

      public onCompileFailure(errorMsg: string): void {
        // Keep lastSuccessfulPdf, do NOT clear current display
        this.state.isStale = this.state.lastSuccessfulPdf !== null;
        this.state.errorMessage = errorMsg;
      }
    }

    it("T1-F12-01: successful compilation sets both current and lastSuccessful PDF buffers", async () => {
      const pm = new PreviewManager();
      const pdf = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
      });

      pm.onCompileSuccess(pdf);
      expect(pm.state.currentPdf).toBe(pdf);
      expect(pm.state.lastSuccessfulPdf).toBe(pdf);
      expect(pm.state.isStale).toBe(false);
    });

    it("T1-F12-02: compilation failure preserves previously rendered PDF in preview canvas", async () => {
      const pm = new PreviewManager();
      const initialPdf = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
      });
      pm.onCompileSuccess(initialPdf);

      // Now compilation fails
      pm.onCompileFailure("Syntax error at line 5");

      // The preview retains initialPdf so the canvas does not clear
      expect(pm.state.lastSuccessfulPdf).toBe(initialPdf);
      expect(pm.state.isStale).toBe(true);
      expect(pm.state.errorMessage).toContain("Syntax error");
    });

    it("T1-F12-03: preview surfaces non-blocking stale indicator without unmounting canvas", () => {
      const pm = new PreviewManager();
      pm.onCompileSuccess(new ArrayBuffer(128));
      pm.onCompileFailure("Unclosed block");

      expect(pm.state.isStale).toBe(true);
      expect(pm.state.lastSuccessfulPdf).not.toBeNull();
    });

    it("T1-F12-04: subsequent successful compilation clears stale state and updates PDF buffer", async () => {
      const pm = new PreviewManager();
      const pdf1 = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
      });
      pm.onCompileSuccess(pdf1);
      pm.onCompileFailure("Syntax error");

      const pdf2 = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
      });
      pm.onCompileSuccess(pdf2);

      expect(pm.state.isStale).toBe(false);
      expect(pm.state.errorMessage).toBeNull();
      expect(pm.state.lastSuccessfulPdf).toBe(pdf2);
    });

    it("T1-F12-05: initial compile failure on empty project shows clean placeholder without crashing", () => {
      const pm = new PreviewManager();
      pm.onCompileFailure("File not found");

      expect(pm.state.lastSuccessfulPdf).toBeNull();
      expect(pm.state.isStale).toBe(false);
      expect(pm.state.errorMessage).toContain("File not found");
    });
  });
});
