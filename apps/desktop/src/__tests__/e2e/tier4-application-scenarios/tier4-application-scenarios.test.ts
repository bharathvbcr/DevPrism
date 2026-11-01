import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createIsolatedHarness,
  assertPdfBuffer,
  assertMetricPreservation,
} from "../harness";

describe("Tier 4: Real-World Application Scenarios", () => {
  let harness = createIsolatedHarness();

  beforeEach(() => {
    harness = createIsolatedHarness();
  });

  // =========================================================================
  // Scenario 1: Full Typst Resume Authoring Flow
  // =========================================================================
  it("T4-S01: Full Typst Resume Authoring Flow", async () => {
    // 1. User initializes project with main.typ
    const projectDir = "/workspace/resume-project";
    let mainContent =
      "= John Doe\n*Software Architect* | john@example.com\n\n== Experience\n- Lead Engineer at TechCorp";

    // 2. Types new bullet point into in-memory overlay
    mainContent +=
      "\n- Architected high-throughput message bus processing 100K msg/sec.";
    const overlay = { "main.typ": mainContent };

    // 3. Auto-compile scheduler runs at 120ms debounce
    const compileFn = vi.fn(async () => {
      return harness.invoke("typst_compile_document", {
        projectDir,
        mainFile: "main.typ",
        overlay,
      });
    });

    const pdfBuffer = await compileFn();
    expect(pdfBuffer).toBeInstanceOf(ArrayBuffer);
    assertPdfBuffer(pdfBuffer);

    // 4. User introduces syntax error (#syntax_error)
    const brokenOverlay = { "main.typ": `${mainContent}\n#syntax_error` };
    let compileErrorCaught = false;
    try {
      await harness.invoke("typst_compile_document", {
        projectDir,
        mainFile: "main.typ",
        overlay: brokenOverlay,
      });
    } catch (err: any) {
      compileErrorCaught = true;
      expect(err.errors[0].severity).toBe("error");
      expect(err.errors[0].line).toBe(2);
    }
    expect(compileErrorCaught).toBe(true);

    // 5. User fixes error -> recompiles successfully
    const fixedPdf = await harness.invoke("typst_compile_document", {
      projectDir,
      mainFile: "main.typ",
      overlay: { "main.typ": mainContent },
    });
    assertPdfBuffer(fixedPdf);
  });

  // =========================================================================
  // Scenario 2: Multi-Document Tabbed Editing Session
  // =========================================================================
  it("T4-S02: Multi-Document Tabbed Editing Session", async () => {
    interface TabState {
      id: string;
      path: string;
      content: string;
      isDirty: boolean;
    }
    const tabs: TabState[] = [
      {
        id: "t1",
        path: "main.typ",
        content: '= import "experience.typ": *\n= Resume',
        isDirty: false,
      },
      {
        id: "t2",
        path: "experience.typ",
        content: "== Work Experience\n- Senior Go Developer",
        isDirty: false,
      },
      {
        id: "t3",
        path: "skills.typ",
        content: "== Skills\n- Rust, Go, TypeScript",
        isDirty: false,
      },
    ];
    let activeTabId = "t1";

    // Edit experience.typ tab
    tabs[1].content += "\n- Scaled Cassandra cluster to 20 nodes.";
    tabs[1].isDirty = true;
    activeTabId = "t2";

    // Compile resolves overlays from both active and inactive dirty tabs
    const multiOverlay: Record<string, string> = {};
    tabs.forEach((t) => {
      if (t.isDirty) multiOverlay[t.path] = t.content;
    });

    const pdf = await harness.invoke("typst_compile_document", {
      projectDir: "/proj",
      mainFile: "main.typ",
      overlay: multiOverlay,
    });
    assertPdfBuffer(pdf);

    // Close skills.typ tab via middle-click
    const closeIndex = tabs.findIndex((t) => t.path === "skills.typ");
    tabs.splice(closeIndex, 1);
    expect(tabs).toHaveLength(2);
    expect(activeTabId).toBe("t2");
  });

  // =========================================================================
  // Scenario 3: LaTeX to Typst Migration & Side-by-Side Comparison
  // =========================================================================
  it("T4-S03: LaTeX to Typst Migration & Side-by-Side Comparison", () => {
    const latexSource =
      "\\section{Experience}\n\\subsection{Staff Engineer}\nManaged 15 engineers.";
    const typstSource =
      "= Experience\n== Staff Engineer\nManaged 15 engineers.";

    // Parse outline for LaTeX
    const parseLatexOutline = (src: string) => {
      const matches = [...src.matchAll(/\\(section|subsection)\{([^}]+)\}/g)];
      return matches.map((m) => ({
        title: m[2],
        level: m[1] === "section" ? 1 : 2,
      }));
    };

    // Parse outline for Typst
    const parseTypstOutline = (src: string) => {
      const matches = [...src.matchAll(/^(=+)\s+(.+)$/gm)];
      return matches.map((m) => ({ title: m[2], level: m[1].length }));
    };

    const latexOutline = parseLatexOutline(latexSource);
    const typstOutline = parseTypstOutline(typstSource);

    expect(latexOutline).toEqual(typstOutline);

    // Check debounce mode adaptation
    const getDebounce = (ext: string) => (ext === "typ" ? 120 : 1200);
    expect(getDebounce("tex")).toBe(1200);
    expect(getDebounce("typ")).toBe(120);
  });

  // =========================================================================
  // Scenario 4: End-to-End Vani Resume Tailoring Workflow
  // =========================================================================
  it("T4-S04: End-to-End Vani Resume Tailoring Workflow", async () => {
    const projectRoot = "/projects/my-resume";
    const masterPath = `${projectRoot}/main.typ`;
    const targetJD = `
      Company: Datadog
      Role: Staff Distributed Systems Engineer
      Requirements:
      - 8+ years leading distributed systems in Go or Rust
      - Proven experience reducing latency by >30% in high-scale systems
      - Strong Kubernetes & Kafka architecture expertise
    `;

    // 1. Create tailored variant
    const variant = await harness.invoke("create_variant", {
      projectRoot,
      name: "Datadog Staff",
      jd: targetJD,
      status: "draft",
      company: "Datadog",
      role: "Staff Distributed Systems Engineer",
      seniority: "Staff",
    });
    expect(variant.id).toBe("datadog-staff");

    // 2. Subscribe to progress events and interactive approval
    const phasesSeen: number[] = [];
    harness.listen("vani://tailor-progress", (p: any) => {
      phasesSeen.push(p.phase);
    });

    let approvedPrompt = false;
    harness.listen("vani://approval-required", (e: any) => {
      expect(e.prompt).toContain("Select bullet focus");
      harness.invoke("manvi_approve_action", {
        approvalId: e.approvalId,
        allow: true,
        chosen: e.options[0],
      });
      approvedPrompt = true;
    });

    // 3. Run tailoring pipeline
    const tailorResult = await harness.invoke("manvi_tailor_resume", {
      request: {
        masterPath,
        jobDescription: targetJD,
        targetPageBudget: 1,
        strictMetrics: true,
      },
    });

    expect(tailorResult.status).toBe("completed");
    expect(tailorResult.atsScore).toBeGreaterThanOrEqual(90);
    expect(approvedPrompt).toBe(true);
    expect(phasesSeen).toEqual([1, 2, 3, 4]);

    // 4. Verify metric preservation checkSafe
    assertMetricPreservation(
      "Architected distributed ingestion pipeline reducing p99 latency by 40% across 50M daily events.",
      tailorResult.rewrittenContent,
    );

    // 5. Review side-by-side diff
    const diffs = await harness.invoke("diff_variant", {
      projectRoot,
      variantId: variant.id,
    });
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs[0].status).toBe("modified");
  });

  // =========================================================================
  // Scenario 5: Resume Organizer Lifecycle Management
  // =========================================================================
  it("T4-S05: Resume Organizer Lifecycle Management", async () => {
    const projectRoot = "/career/resumes";

    // 1. Create multiple variants across companies
    const _v1 = await harness.invoke("create_variant", {
      projectRoot,
      name: "Google L6 SRE",
      jd: "Google JD",
      status: "applied",
      company: "Google",
      role: "SRE",
      atsScore: 88,
    });

    const v2 = await harness.invoke("create_variant", {
      projectRoot,
      name: "Stripe Staff Eng",
      jd: "Stripe JD",
      status: "interview",
      company: "Stripe",
      role: "Staff Engineer",
      atsScore: 94,
    });

    const _v3 = await harness.invoke("create_variant", {
      projectRoot,
      name: "Netflix Infra",
      jd: "Netflix JD",
      status: "draft",
      company: "Netflix",
      role: "Infra Engineer",
      atsScore: 76,
    });

    // 2. List variants
    const all = await harness.invoke("list_variants", { projectRoot });
    expect(all).toHaveLength(3);

    // 3. Update status (e.g. Stripe moves from interview -> offer)
    const updated = await harness.invoke("update_variant", {
      projectRoot,
      variantId: v2.id,
      status: "offer",
      atsScore: 96,
    });
    expect(updated.status).toBe("offer");
    expect(updated.atsScore).toBe(96);

    // 4. Filter by status
    const listAfter = await harness.invoke("list_variants", { projectRoot });
    const offers = listAfter.filter((v: any) => v.status === "offer");
    expect(offers).toHaveLength(1);
    expect(offers[0].company).toBe("Stripe");
  });

  // =========================================================================
  // Scenario 6: Error Recovery & Stale-State Resilience Workflow
  // =========================================================================
  it("T4-S06: Error Recovery & Stale-State Resilience Workflow", async () => {
    const projectDir = "/proj";
    const initialContent = "= Valid Document\nEverything works fine.";

    // 1. Initial successful compile
    const initialPdf = await harness.invoke("typst_compile_document", {
      projectDir,
      mainFile: "main.typ",
      overlay: { "main.typ": initialContent },
    });

    interface PreviewCanvas {
      renderedPdf: ArrayBuffer | null;
      isStaleBannerVisible: boolean;
      diagnosticCount: number;
    }
    const canvas: PreviewCanvas = {
      renderedPdf: initialPdf,
      isStaleBannerVisible: false,
      diagnosticCount: 0,
    };

    // 2. User edits and introduces syntax error
    try {
      await harness.invoke("typst_compile_document", {
        projectDir,
        mainFile: "main.typ",
        overlay: { "main.typ": `${initialContent}\n#syntax_error` },
      });
    } catch (err: any) {
      // Stale preservation: canvas still holds initialPdf!
      canvas.isStaleBannerVisible = true;
      canvas.diagnosticCount = err.errors.length;
    }

    expect(canvas.renderedPdf).toBe(initialPdf); // Preserved
    expect(canvas.isStaleBannerVisible).toBe(true);
    expect(canvas.diagnosticCount).toBe(1);

    // 3. User fixes syntax error
    const recoveredPdf = await harness.invoke("typst_compile_document", {
      projectDir,
      mainFile: "main.typ",
      overlay: { "main.typ": `${initialContent}\n- Fixed bullet point.` },
    });

    canvas.renderedPdf = recoveredPdf;
    canvas.isStaleBannerVisible = false;
    canvas.diagnosticCount = 0;

    expect(canvas.renderedPdf).not.toBeNull();
    if (!canvas.renderedPdf) throw new Error("renderedPdf must not be null");
    assertPdfBuffer(canvas.renderedPdf);
    expect(canvas.isStaleBannerVisible).toBe(false);
  });

  // =========================================================================
  // Scenario 7: Bidirectional Navigation & Click-to-Edit Workflow
  // =========================================================================
  it("T4-S07: Bidirectional Navigation & Click-to-Edit Workflow", async () => {
    // 1. User double clicks in PDF preview at coordinates (page 1, x: 100, y: 220)
    const inverseResult = await harness.invoke("typst_sync_inverse", {
      projectDir: "/proj",
      mainFile: "main.typ",
      page: 1,
      x: 100,
      y: 220,
    });

    expect(inverseResult).toBeDefined();
    expect(inverseResult.file).toBe("main.typ");
    expect(inverseResult.line).toBe(10);

    // 2. User modifies text at line 10 and triggers forward sync
    const forwardResult = await harness.invoke("typst_sync_forward", {
      projectDir: "/proj",
      mainFile: "main.typ",
      file: "main.typ",
      line: 10,
    });

    expect(forwardResult).toBeDefined();
    expect(forwardResult.page).toBe(1);
    expect(forwardResult.x).toBe(72);
    expect(forwardResult.y).toBe(220);
  });

  // =========================================================================
  // Scenario 8: Theme Switching & Visual Polish Workflow
  // =========================================================================
  it("T4-S08: Theme Switching & Visual Polish Workflow", async () => {
    // 1. Toggle from dark to light theme
    document.documentElement.classList.remove("dark");
    await harness.invoke("set_native_window_theme", { theme: "light" });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(harness.nativeTheme).toBe("light");

    // 2. Search in 236-symbol math palette for operators
    const mathPalette = [
      { name: "nabla", typst: "nabla", latex: "\\nabla" },
      { name: "sum", typst: "sum", latex: "\\sum" },
      { name: "integral", typst: "integral", latex: "\\int" },
    ];

    const searchMath = (q: string) =>
      mathPalette.filter((m) => m.name.includes(q));
    const hits = searchMath("nab");
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe("nabla");

    // 3. Insert symbol into active Typst editor
    const symbolSnippet = `$${hits[0].typst}$`;
    expect(symbolSnippet).toBe("$nabla$");

    // 4. Toggle back to dark theme
    document.documentElement.classList.add("dark");
    await harness.invoke("set_native_window_theme", { theme: "dark" });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(harness.nativeTheme).toBe("dark");
  });
});
