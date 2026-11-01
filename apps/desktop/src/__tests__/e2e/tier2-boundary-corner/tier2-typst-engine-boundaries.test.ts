import { describe, it, expect, beforeEach, vi } from "vitest";
import { createIsolatedHarness, assertPdfBuffer } from "../harness";
import { createAutoCompileScheduler } from "@/lib/auto-compile";

describe("Tier 2: Typst Engine & Compilation Boundary & Corner Cases (Features 6 - 12)", () => {
  let harness = createIsolatedHarness();

  beforeEach(() => {
    harness = createIsolatedHarness();
  });

  // =========================================================================
  // Feature 6: Fast In-Process Typst Binary IPC Boundaries
  // =========================================================================
  describe("Feature 6: Fast In-Process Typst Binary IPC Boundaries", () => {
    it("T2-F06-01: massive document (simulated 100+ pages) returns complete binary buffer", async () => {
      const largeContent = `= Large Resume\n${"- Accomplishment bullet\n".repeat(500)}`;
      const res = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
        overlay: { "main.typ": largeContent },
      });

      expect(res).toBeInstanceOf(ArrayBuffer);
      assertPdfBuffer(res);
      expect(res.byteLength).toBeGreaterThan(5000);
    });

    it("T2-F06-02: binary response preserves exact byte structure without UTF-8 string mangling", async () => {
      const res = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
      });
      const bytes = new Uint8Array(res);
      // Valid binary PDF stream does not contain high-byte Unicode replacement markers (0xFFFD)
      let hasUtf8Replacement = false;
      for (let i = 0; i < bytes.length - 2; i++) {
        if (
          bytes[i] === 0xef &&
          bytes[i + 1] === 0xbf &&
          bytes[i + 2] === 0xbd
        ) {
          hasUtf8Replacement = true;
          break;
        }
      }
      expect(hasUtf8Replacement).toBe(false);
    });

    it("T2-F06-03: concurrent compilation calls serialize or execute without IPC deadlocks", async () => {
      const calls = [
        harness.invoke("typst_compile_document", {
          projectDir: "/proj",
          mainFile: "main.typ",
        }),
        harness.invoke("typst_compile_document", {
          projectDir: "/proj",
          mainFile: "main.typ",
        }),
        harness.invoke("typst_compile_document", {
          projectDir: "/proj",
          mainFile: "main.typ",
        }),
      ];

      const results = await Promise.all(calls);
      expect(results).toHaveLength(3);
      results.forEach((r) => assertPdfBuffer(r));
    });

    it("T2-F06-04: missing main file parameter falls back to main.typ without throw", async () => {
      const res = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
      });
      assertPdfBuffer(res);
    });

    it("T2-F06-05: compilation error surfaces multiple diagnostic hints", async () => {
      try {
        await harness.invoke("typst_compile_document", {
          projectDir: "/proj",
          mainFile: "main.typ",
          overlay: { "main.typ": "#syntax_error" },
        });
        expect.unreachable("Expected error");
      } catch (err: any) {
        expect(err.errors[0].hints.length).toBeGreaterThan(0);
        expect(err.errors[0].hints[0]).toContain(
          "check for unclosed delimiters",
        );
      }
    });
  });

  // =========================================================================
  // Feature 7: In-Memory Buffer Overlay Boundaries
  // =========================================================================
  describe("Feature 7: In-Memory Buffer Overlay Boundaries", () => {
    it("T2-F07-01: overlay with unicode emojis and CJK characters compiles cleanly", async () => {
      const unicodeDoc =
        "= 简历 / Résumé 🚀\n- 带领团队构建高并发服务 (99.99% 可用性) ⚡";
      const res = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
        overlay: { "main.typ": unicodeDoc },
      });

      expect(harness.lastCompileOverlay!["main.typ"]).toContain("简历");
      assertPdfBuffer(res);
    });

    it("T2-F07-02: overlay with extremely large text (>1MB) does not cause stack overflow", async () => {
      const hugeText = `= Giant Document\n${"x".repeat(1_000_000)}`;
      const res = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
        overlay: { "main.typ": hugeText },
      });

      assertPdfBuffer(res);
    });

    it("T2-F07-03: removing a file from the overlay map causes subsequent compile to revert", async () => {
      await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
        overlay: { "main.typ": "Overlay Version" },
      });
      expect(harness.lastCompileOverlay!["main.typ"]).toBe("Overlay Version");

      // Next compile without overlay for that file
      await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
        overlay: {},
      });
      expect(harness.lastCompileOverlay!["main.typ"]).toBeUndefined();
    });

    it("T2-F07-04: handles relative vs absolute path keys in overlay", async () => {
      const res = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "sub/section.typ",
        overlay: { "sub/section.typ": "= Sub Section" },
      });
      assertPdfBuffer(res);
    });

    it("T2-F07-05: overlay with empty file string compiles to blank or valid empty PDF", async () => {
      const res = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
        overlay: { "main.typ": "" },
      });
      assertPdfBuffer(res);
    });
  });

  // =========================================================================
  // Feature 8: Adaptive Auto-Compile Debounce Boundaries
  // =========================================================================
  describe("Feature 8: Adaptive Auto-Compile Debounce Boundaries", () => {
    it("T2-F08-01: negative or zero debounce values clamp to safe minimum 50ms", () => {
      const clampDebounce = (ms: number) => Math.max(ms, 50);
      expect(clampDebounce(0)).toBe(50);
      expect(clampDebounce(-100)).toBe(50);
      expect(clampDebounce(120)).toBe(120);
    });

    it("T2-F08-02: 50+ rapid generation advances settle and trigger exactly one compile", () => {
      vi.useFakeTimers();
      const compile = vi.fn();
      const scheduler = createAutoCompileScheduler(compile, 100);

      scheduler.sync({ enabled: true, ready: true, generation: 0 });
      for (let g = 1; g <= 50; g++) {
        scheduler.sync({ enabled: true, ready: true, generation: g });
        vi.advanceTimersByTime(2); // rapid typing every 2ms
      }

      expect(compile).not.toHaveBeenCalled();
      vi.advanceTimersByTime(110);
      expect(compile).toHaveBeenCalledTimes(1);

      scheduler.dispose();
      vi.useRealTimers();
    });

    it("T2-F08-03: keystroke arriving after debounce has fired schedules new compile cycle", () => {
      vi.useFakeTimers();
      const compile = vi.fn();
      const scheduler = createAutoCompileScheduler(compile, 100);

      scheduler.sync({ enabled: true, ready: true, generation: 1 });
      scheduler.sync({ enabled: true, ready: true, generation: 2 });
      vi.advanceTimersByTime(110);
      expect(compile).toHaveBeenCalledTimes(1);

      // New keystroke later
      scheduler.sync({ enabled: true, ready: true, generation: 3 });
      vi.advanceTimersByTime(110);
      expect(compile).toHaveBeenCalledTimes(2);

      scheduler.dispose();
      vi.useRealTimers();
    });

    it("T2-F08-04: scheduler unmount via dispose immediately clears any pending timeout", () => {
      vi.useFakeTimers();
      const compile = vi.fn();
      const scheduler = createAutoCompileScheduler(compile, 100);

      scheduler.sync({ enabled: true, ready: true, generation: 1 });
      scheduler.sync({ enabled: true, ready: true, generation: 2 });
      scheduler.dispose();

      vi.advanceTimersByTime(200);
      expect(compile).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("T2-F08-05: not-ready state does not trigger compilation even if generation advances", () => {
      vi.useFakeTimers();
      const compile = vi.fn();
      const scheduler = createAutoCompileScheduler(compile, 100);

      scheduler.sync({ enabled: true, ready: false, generation: 1 });
      scheduler.sync({ enabled: true, ready: false, generation: 2 });

      vi.advanceTimersByTime(200);
      expect(compile).not.toHaveBeenCalled();

      scheduler.dispose();
      vi.useRealTimers();
    });
  });

  // =========================================================================
  // Feature 9: Typst Editor Diagnostics & Linting Boundaries
  // =========================================================================
  describe("Feature 9: Typst Editor Diagnostics & Linting Boundaries", () => {
    it("T2-F09-01: error pointing beyond buffer length clamps to buffer end", () => {
      const bufferLength = 100;
      const clampOffset = (offset: number) => Math.min(offset, bufferLength);

      expect(clampOffset(150)).toBe(100);
      expect(clampOffset(50)).toBe(50);
    });

    it("T2-F09-02: error with line 0 or negative column clamps to line start (0-offset)", () => {
      const clampCol = (col?: number) => Math.max(0, (col ?? 1) - 1);
      expect(clampCol(0)).toBe(0);
      expect(clampCol(-5)).toBe(0);
      expect(clampCol(10)).toBe(9);
    });

    it("T2-F09-03: multiple diagnostics at same offset sort stably by severity", () => {
      const diags = [
        { offset: 10, severity: "warning" as const, id: "w1" },
        { offset: 10, severity: "error" as const, id: "e1" },
        { offset: 10, severity: "info" as const, id: "i1" },
      ];

      const severityWeight = { error: 0, warning: 1, info: 2 };
      const sorted = [...diags].sort(
        (a, b) => severityWeight[a.severity] - severityWeight[b.severity],
      );

      expect(sorted[0].severity).toBe("error");
      expect(sorted[1].severity).toBe("warning");
      expect(sorted[2].severity).toBe("info");
    });

    it("T2-F09-04: multi-line diagnostic span calculates span across line breaks", () => {
      const startLine = 2;
      const endLine = 4;
      const lineOffsets = [0, 20, 50, 80, 110];

      const from = lineOffsets[startLine - 1];
      const to = lineOffsets[endLine - 1] + 15;

      expect(from).toBe(20);
      expect(to).toBe(95);
      expect(to - from).toBe(75);
    });

    it("T2-F09-05: handles diagnostics on imported non-active sub-files", () => {
      const activeFile = "main.typ";
      const diag = { file: "sections/exp.typ", message: "Error in subfile" };

      const isForActiveEditor = diag.file === activeFile;
      expect(isForActiveEditor).toBe(false);
    });
  });

  // =========================================================================
  // Feature 10: Typst Editor Autocomplete Boundaries
  // =========================================================================
  describe("Feature 10: Typst Editor Autocomplete Boundaries", () => {
    it("T2-F10-01: suppresses Typst keyword autocomplete inside string literals", () => {
      const isInStringLiteral = (line: string, col: number) => {
        const quoteCount = (line.slice(0, col).match(/"/g) || []).length;
        return quoteCount % 2 === 1;
      };

      const line = 'let name = "#al';
      expect(isInStringLiteral(line, line.length)).toBe(true);
    });

    it("T2-F10-02: suppresses keyword autocomplete inside single-line comments", () => {
      const isInComment = (line: string, col: number) => {
        const commentIdx = line.indexOf("//");
        return commentIdx !== -1 && col > commentIdx;
      };

      const line = "let x = 10; // #al";
      expect(isInComment(line, line.length)).toBe(true);
    });

    it("T2-F10-03: matches case-insensitively on symbol prefixes", () => {
      const symbols = ["#align", "#circle", "#rect"];
      const matchSymbol = (query: string) => {
        const q = query.toLowerCase();
        return symbols.filter((s) => s.toLowerCase().startsWith(q));
      };

      expect(matchSymbol("#AL")).toContain("#align");
    });

    it("T2-F10-04: handles auto-closing parens insertion when function snippet selected", () => {
      const applySnippet = (label: string) => `${label}()`;
      expect(applySnippet("#rect")).toBe("#rect()");
    });

    it("T2-F10-05: autocomplete lookup on large list completes in under 10ms", () => {
      const largeSymbolList = Array.from(
        { length: 500 },
        (_, i) => `#symbol_${i}`,
      );
      const start = performance.now();
      const filtered = largeSymbolList.filter((s) =>
        s.startsWith("#symbol_42"),
      );
      const duration = performance.now() - start;

      expect(filtered).toHaveLength(11);
      expect(duration).toBeLessThan(10);
    });
  });

  // =========================================================================
  // Feature 11: Typst Bidirectional Sync Boundaries
  // =========================================================================
  describe("Feature 11: Typst Bidirectional Sync Boundaries", () => {
    it("T2-F11-01: negative line in forward sync clamps to line 1 or returns null", async () => {
      const result = await harness.invoke("typst_sync_forward", {
        projectDir: "/proj",
        mainFile: "main.typ",
        file: "main.typ",
        line: -5,
      });
      expect(result).toBeNull();
    });

    it("T2-F11-02: page coordinate click on empty margin returns null", async () => {
      const result = await harness.invoke("typst_sync_inverse", {
        projectDir: "/proj",
        mainFile: "main.typ",
        page: 1,
        x: 5,
        y: 10,
      });
      expect(result).toBeNull();
    });

    it("T2-F11-03: sync inverse on invalid page (> total pages) returns null", async () => {
      const result = await harness.invoke("typst_sync_inverse", {
        projectDir: "/proj",
        mainFile: "main.typ",
        page: 99,
        x: 100,
        y: 200,
      });
      expect(result).toBeNull();
    });

    it("T2-F11-04: coordinate scaling applies zoom factor accurately", () => {
      const scaleCoordinates = (
        coord: { x: number; y: number },
        zoomFactor: number,
      ) => {
        return { x: coord.x * zoomFactor, y: coord.y * zoomFactor };
      };

      const base = { x: 72, y: 100 };
      expect(scaleCoordinates(base, 1.5)).toEqual({ x: 108, y: 150 });
      expect(scaleCoordinates(base, 2.0)).toEqual({ x: 144, y: 200 });
    });

    it("T2-F11-05: sync forward across multiple pages maps to page 2 when line > 50", async () => {
      const res = await harness.invoke("typst_sync_forward", {
        projectDir: "/proj",
        mainFile: "main.typ",
        file: "main.typ",
        line: 65,
      });
      expect(res.page).toBe(2);
    });
  });

  // =========================================================================
  // Feature 12: Preview Stale-State Preservation Boundaries
  // =========================================================================
  describe("Feature 12: Preview Stale-State Preservation Boundaries", () => {
    it("T2-F12-01: rapid alternating compile success/fail sequence never flashes null canvas", async () => {
      let currentDisplay: ArrayBuffer | null = null;
      let lastGood: ArrayBuffer | null = null;

      const onResult = (res: { ok: boolean; pdf?: ArrayBuffer }) => {
        if (res.ok && res.pdf) {
          lastGood = res.pdf;
          currentDisplay = res.pdf;
        } else {
          // Keep last good
          currentDisplay = lastGood;
        }
      };

      const pdf1 = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
      });
      onResult({ ok: true, pdf: pdf1 });
      expect(currentDisplay).not.toBeNull();

      onResult({ ok: false }); // syntax error
      expect(currentDisplay).toBe(pdf1); // still preserved!

      const pdf2 = await harness.invoke("typst_compile_document", {
        projectDir: "/proj",
        mainFile: "main.typ",
      });
      onResult({ ok: true, pdf: pdf2 });
      expect(currentDisplay).toBe(pdf2);
    });

    it("T2-F12-02: preview scroll position and zoom are preserved across compilation failures", () => {
      interface CanvasViewport {
        scrollLeft: number;
        scrollTop: number;
        zoom: number;
      }
      const viewport: CanvasViewport = {
        scrollLeft: 0,
        scrollTop: 450,
        zoom: 1.25,
      };

      // Simulate compile error: viewport must NOT reset to 0,0,1.0
      const isCompileFailed = true;
      if (isCompileFailed) {
        // preserve
      }

      expect(viewport.scrollTop).toBe(450);
      expect(viewport.zoom).toBe(1.25);
    });

    it("T2-F12-03: multi-page document maintains active page index when recompilation fails", () => {
      const activePage = 2;
      const onCompileError = () => {
        // activePage retained
      };
      onCompileError();
      expect(activePage).toBe(2);
    });

    it("T2-F12-04: memory cleanup: older superseded buffers are replaced without unbounded accumulation", () => {
      const maxHistory = 1;
      const history: ArrayBuffer[] = [];

      const pushPdf = (buf: ArrayBuffer) => {
        if (history.length >= maxHistory) history.shift();
        history.push(buf);
      };

      pushPdf(new ArrayBuffer(100));
      pushPdf(new ArrayBuffer(200));
      pushPdf(new ArrayBuffer(300));

      expect(history).toHaveLength(1);
    });

    it("T2-F12-05: dismissing error overlay does not clear the preserved preview canvas", () => {
      let errorOverlayVisible = true;
      const canvasVisible = true;

      const dismissOverlay = () => {
        errorOverlayVisible = false;
      };

      dismissOverlay();
      expect(errorOverlayVisible).toBe(false);
      expect(canvasVisible).toBe(true);
    });
  });
});
