import { describe, expect, it, vi } from "vitest";
import type { ExperienceBlock, Persona } from "@/lib/career/types";
import { TYPST_ATS_SINGLE_TEMPLATE } from "@/lib/resume-templates";
import { synthesizeResume } from "@/lib/resume-synthesis/orchestrator";
import type { JDProfile } from "@/lib/resume-synthesis/types";

const persona: Persona = {
  id: "ai",
  label: "AI",
  skillWeights: {},
  defaultTemplateId: "ats-single-column",
  sectionOrder: ["skills", "experience", "education", "projects"],
  toneDirective: "concise",
};

function block(id: string, skills: string[]): ExperienceBlock {
  return {
    id,
    kind: "experience",
    title: `Title ${id}`,
    org: `Org ${id}`,
    dateRange: { start: "2021-03", end: "2023-06" },
    personas: ["ai"],
    domains: ["ml"],
    skills: skills.map((name) => ({ name, level: 4 as const })),
    seniorityLevel: "senior",
    bullets: [
      {
        id: `${id}_b1`,
        canonical: `Shipped feature with 40% gain at ${id}`,
        variants: {},
        metrics: [{ value: "40%", kind: "improvement" }],
        evidenceRefs: [],
        locked: false,
      },
    ],
    facts: [],
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

const profile: JDProfile = {
  roleTitle: "ML Engineer",
  seniority: "senior",
  mustHaveSkills: ["Python"],
  niceToHaveSkills: ["PyTorch"],
  domains: ["ml"],
  atsKeywords: ["Python", "ML"],
  toneSignals: ["technical"],
  responsibilitiesText: "Build models",
  qualificationsText: "Python required",
};

describe("synthesizeResume (mocked llmJson)", () => {
  it("runs stages and returns tex + report without live LLM", async () => {
    const stages: string[] = [];
    const stageDetails: string[] = [];
    const partialReports: number[] = [];
    const llmJson = vi.fn(
      async <T>(opts: {
        label?: string;
        validate: (v: unknown) => v is T;
      }): Promise<T> => {
        const label = opts.label ?? "";
        if (label === "jd-analysis") {
          const v = profile;
          if (!opts.validate(v)) throw new Error("bad profile");
          return v as T;
        }
        if (label.startsWith("distill:") || label.startsWith("rewrite:")) {
          const blockId = label.slice(label.indexOf(":") + 1);
          const v = {
            bullets: [
              {
                id: `${blockId}_b1`,
                text: `Delivered Python systems with 40% gain for ${blockId}`,
              },
            ],
          };
          if (!opts.validate(v)) throw new Error("bad rewrite");
          return v as T;
        }
        if (label === "critic") {
          const v = {
            atsCoveragePct: 80,
            verdicts: [
              {
                blockId: "exp_a",
                bulletId: "exp_a_b1",
                grounded: true,
                keywordHits: ["Python"],
                flags: [],
              },
            ],
          };
          if (!opts.validate(v)) throw new Error("bad critic");
          return v as T;
        }
        if (label === "summary") {
          const v = { summary: "ML engineer shipping production systems." };
          if (!opts.validate(v)) throw new Error("bad summary");
          return v as T;
        }
        // repair or unknown — empty valid-ish object rejected → throw
        throw new Error(`unexpected llmJson label: ${label}`);
      },
    );

    const result = await synthesizeResume({
      jdText: "We need a Senior ML Engineer with Python and PyTorch.",
      personaId: "ai",
      templateId: TYPST_ATS_SINGLE_TEMPLATE.id,
      header: {
        fullName: "Test User",
        cityRegion: "SF",
        email: "t@example.com",
        phone: "555",
      },
      onProgress: (s) => {
        stages.push(s.id);
        if (s.detail) stageDetails.push(s.detail);
        if (s.partialReport) {
          partialReports.push(s.partialReport.scored.length);
        }
      },
      deps: {
        listBlocks: async () => [
          block("exp_a", ["Python", "PyTorch"]),
          block("exp_b", ["Java"]),
          block("exp_c", ["Python", "Go"]),
        ],
        listPersonas: async () => [persona],
        vectorSearch: async () => [],
        saveRun: async () => {},
        llmJson: llmJson as never,
        embed: async () => {
          throw new Error("[E_NO_MODEL] no embedding model");
        },
        compile: async (_template, content) => ({
          tex: "\\documentclass{article}\\begin{document}ok\\end{document}",
          content,
          repairs: [],
          result: { success: true, summary: "ok" },
          pdfBytes: new Uint8Array([37, 80, 68, 70]), // %PDF
        }),
      },
    });

    expect(result.compileOk).toBe(true);
    expect(result.pdfBytes).toBeTruthy();
    expect(result.tex).toContain("documentclass");
    expect(result.report.semanticMatchingDisabled).toBe(true);
    expect(
      result.report.notices.some((n) => /semantic matching disabled/i.test(n)),
    ).toBe(true);
    expect(result.report.selectedBlockIds.length).toBeGreaterThan(0);
    expect(result.report.selectedBlockIds).toContain("exp_a");
    expect(result.report.stageTimingsMs).toBeDefined();
    expect(result.report.stageTimingsMs!.analyzing).toBeGreaterThanOrEqual(0);
    expect(result.report.stageTimingsMs!.scoring).toBeGreaterThanOrEqual(0);
    expect(result.report.stageTimingsMs!.selecting).toBeGreaterThanOrEqual(0);
    expect(result.report.mustHaveCoverage).toBeDefined();
    expect(
      result.report.mustHaveCoverage!.some((c) => c.skill === "Python"),
    ).toBe(true);
    expect(stages).toContain("analyzing");
    expect(stages).toContain("scoring");
    expect(stages).toContain("selecting");
    expect(stages).toContain("rewriting");
    expect(stages).toContain("critic");
    expect(stages).toContain("assembling");
    expect(stages).toContain("done");
    expect(partialReports.length).toBeGreaterThan(0);
    expect(stageDetails.some((d) => /Rewriting: .+ — \d+\/\d+/i.test(d))).toBe(
      true,
    );
    expect(stageDetails.some((d) => /candidate/i.test(d))).toBe(true);
    expect(llmJson).toHaveBeenCalled();
  });

  it("emits per-block rewrite progress rows", async () => {
    const blockSnapshots: Array<{ id: string; status: string }[]> = [];
    const llmJson = vi.fn(
      async <T>(opts: {
        label?: string;
        validate: (v: unknown) => v is T;
      }): Promise<T> => {
        const label = opts.label ?? "";
        if (label === "jd-analysis") {
          if (!opts.validate(profile)) throw new Error("bad profile");
          return profile as T;
        }
        if (label.startsWith("distill:") || label.startsWith("rewrite:")) {
          const blockId = label.slice(label.indexOf(":") + 1);
          const v = {
            bullets: [
              {
                id: `${blockId}_b1`,
                text: `Delivered Python systems with 40% gain for ${blockId}`,
              },
            ],
          };
          if (!opts.validate(v)) throw new Error("bad rewrite");
          return v as T;
        }
        if (label === "critic") {
          const v = { atsCoveragePct: 80, verdicts: [] };
          if (!opts.validate(v)) throw new Error("bad critic");
          return v as T;
        }
        if (label === "summary") {
          const v = { summary: "ML engineer shipping production systems." };
          if (!opts.validate(v)) throw new Error("bad summary");
          return v as T;
        }
        throw new Error(`unexpected llmJson label: ${label}`);
      },
    );

    await synthesizeResume({
      jdText:
        "We need a senior ML engineer with Python experience and strong systems skills for production ML platforms.",
      personaId: "ai",
      templateId: TYPST_ATS_SINGLE_TEMPLATE.id,
      header: {
        fullName: "Test User",
        cityRegion: "SF",
        email: "t@example.com",
        phone: "555",
      },
      onProgress: (s) => {
        if (s.blockProgress?.length) {
          blockSnapshots.push(
            s.blockProgress.map((b) => ({ id: b.blockId, status: b.status })),
          );
        }
      },
      deps: {
        listBlocks: async () => [
          block("exp_a", ["Python", "PyTorch"]),
          block("exp_b", ["Java"]),
        ],
        listPersonas: async () => [persona],
        vectorSearch: async () => [],
        saveRun: async () => {},
        llmJson: llmJson as never,
        embed: async () => {
          throw new Error("[E_NO_MODEL] no embedding model");
        },
        compile: async (_template, content) => ({
          tex: "\\documentclass{article}\\begin{document}ok\\end{document}",
          content,
          repairs: [],
          result: { success: true, summary: "ok" },
          pdfBytes: null,
        }),
      },
    });

    expect(blockSnapshots.length).toBeGreaterThan(0);
    expect(
      blockSnapshots.some((rows) => rows.some((r) => r.status === "active")),
    ).toBe(true);
    expect(
      blockSnapshots.some((rows) => rows.every((r) => r.status === "done")),
    ).toBe(true);
  });

  it("falls back to canonical for locked bullets", async () => {
    const locked: ExperienceBlock = {
      ...block("exp_lock", ["Python"]),
      bullets: [
        {
          id: "exp_lock_b1",
          canonical: "LOCKED CANONICAL 40%",
          variants: {},
          metrics: [{ value: "40%", kind: "pct" }],
          evidenceRefs: [],
          locked: true,
        },
      ],
    };

    const llmJson = vi.fn(
      async <T>(opts: {
        label?: string;
        validate: (v: unknown) => v is T;
      }): Promise<T> => {
        if (opts.label === "jd-analysis") {
          if (!opts.validate(profile)) throw new Error("bad");
          return profile as T;
        }
        if (opts.label === "critic") {
          const v = { atsCoveragePct: 50, verdicts: [] };
          if (!opts.validate(v)) throw new Error("bad");
          return v as T;
        }
        if (opts.label === "summary") {
          const v = { summary: "Locked-bullet resume summary." };
          if (!opts.validate(v)) throw new Error("bad");
          return v as T;
        }
        // rewrite should be skipped when all locked — if called, return junk
        const v = {
          bullets: [{ id: "exp_lock_b1", text: "HALLUCINATED" }],
        };
        if (!opts.validate(v)) throw new Error("bad");
        return v as T;
      },
    );

    const result = await synthesizeResume({
      jdText: "Python role",
      personaId: "ai",
      templateId: TYPST_ATS_SINGLE_TEMPLATE.id,
      deps: {
        listBlocks: async () => [locked],
        listPersonas: async () => [persona],
        vectorSearch: async () => [],
        saveRun: async () => {},
        llmJson: llmJson as never,
        embed: async () => {
          throw new Error("no embed");
        },
        compile: async (_t, content) => ({
          tex: "tex",
          content,
          repairs: [],
          result: { success: true, summary: "ok" },
        }),
      },
    });

    const exp = result.content.experience.find((e) => e.id === "exp_lock");
    expect(exp?.bullets[0]).toBe("LOCKED CANONICAL 40%");
  });

  it("aborts when AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      synthesizeResume({
        jdText:
          "We need a Senior ML Engineer with Python and PyTorch experience for production systems.",
        personaId: "ai",
        templateId: TYPST_ATS_SINGLE_TEMPLATE.id,
        signal: controller.signal,
        deps: {
          listBlocks: async () => [block("exp_a", ["Python"])],
          listPersonas: async () => [persona],
          vectorSearch: async () => [],
          saveRun: async () => {},
          llmJson: async () => {
            throw new Error("should not call llm");
          },
          embed: async () => {
            throw new Error("no embed");
          },
          compile: async (_t, content) => ({
            tex: "tex",
            content,
            repairs: [],
            result: { success: true, summary: "ok" },
          }),
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts between stages when signal fires mid-run", async () => {
    const controller = new AbortController();
    let analyzeCalls = 0;
    const llmJson = vi.fn(
      async <T>(opts: {
        label?: string;
        validate: (v: unknown) => v is T;
      }): Promise<T> => {
        const label = opts.label ?? "";
        if (label === "jd-analysis") {
          analyzeCalls += 1;
          // Abort after JD analysis so scoring never completes.
          controller.abort();
          if (!opts.validate(profile)) throw new Error("bad");
          return profile as T;
        }
        if (label === "summary") {
          const v = { summary: "ML engineer shipping production systems." };
          if (!opts.validate(v)) throw new Error("bad summary");
          return v as T;
        }
        throw new Error(`unexpected llmJson label: ${label}`);
      },
    );

    await expect(
      synthesizeResume({
        jdText:
          "We need a Senior ML Engineer with Python and PyTorch experience for production systems.",
        personaId: "ai",
        templateId: TYPST_ATS_SINGLE_TEMPLATE.id,
        signal: controller.signal,
        deps: {
          listBlocks: async () => [block("exp_a", ["Python"])],
          listPersonas: async () => [persona],
          vectorSearch: async () => [],
          saveRun: async () => {},
          llmJson: llmJson as never,
          embed: async () => {
            throw new Error("[E_NO_MODEL]");
          },
          compile: async (_t, content) => ({
            tex: "tex",
            content,
            repairs: [],
            result: { success: true, summary: "ok" },
          }),
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(analyzeCalls).toBe(1);
  });

  it("persists tex on saveRun for rematerialization", async () => {
    let saved: unknown = null;
    const llmJson = vi.fn(
      async <T>(opts: {
        label?: string;
        validate: (v: unknown) => v is T;
      }): Promise<T> => {
        const label = opts.label ?? "";
        if (label === "jd-analysis") {
          if (!opts.validate(profile)) throw new Error("bad");
          return profile as T;
        }
        if (label.startsWith("distill:") || label.startsWith("rewrite:")) {
          const blockId = label.slice(label.indexOf(":") + 1);
          const v = {
            bullets: [
              {
                id: `${blockId}_b1`,
                text: `Delivered Python systems with 40% gain for ${blockId}`,
              },
            ],
          };
          if (!opts.validate(v)) throw new Error("bad");
          return v as T;
        }
        if (label === "critic") {
          const v = { atsCoveragePct: 80, verdicts: [] };
          if (!opts.validate(v)) throw new Error("bad");
          return v as T;
        }
        if (label === "summary") {
          const v = { summary: "ML engineer shipping production systems." };
          if (!opts.validate(v)) throw new Error("bad summary");
          return v as T;
        }
        throw new Error(`unexpected: ${label}`);
      },
    );

    await synthesizeResume({
      jdText:
        "We need a Senior ML Engineer with Python and PyTorch experience for production systems.",
      personaId: "ai",
      templateId: TYPST_ATS_SINGLE_TEMPLATE.id,
      deps: {
        listBlocks: async () => [block("exp_a", ["Python"])],
        listPersonas: async () => [persona],
        vectorSearch: async () => [],
        saveRun: async (run) => {
          saved = run.reportJson;
        },
        llmJson: llmJson as never,
        embed: async () => {
          throw new Error("[E_NO_MODEL]");
        },
        compile: async (_t, content) => ({
          tex: "\\documentclass{article}\\begin{document}ok\\end{document}",
          content,
          repairs: [],
          result: { success: true, summary: "ok" },
        }),
      },
    });

    expect(saved).toBeTruthy();
    expect((saved as { tex?: string }).tex).toContain("documentclass");
    expect(
      (saved as { profile?: { roleTitle?: string } }).profile?.roleTitle,
    ).toBe("ML Engineer");
  });

  it("surfaces compile soft-fail as done with compileOk false", async () => {
    const stages: string[] = [];
    const details: string[] = [];
    const llmJson = vi.fn(
      async <T>(opts: {
        label?: string;
        validate: (v: unknown) => v is T;
      }): Promise<T> => {
        const label = opts.label ?? "";
        if (label === "jd-analysis") {
          if (!opts.validate(profile)) throw new Error("bad");
          return profile as T;
        }
        if (label.startsWith("distill:") || label.startsWith("rewrite:")) {
          const blockId = label.slice(label.indexOf(":") + 1);
          const v = {
            bullets: [
              {
                id: `${blockId}_b1`,
                text: `Delivered Python systems with 40% gain for ${blockId}`,
              },
            ],
          };
          if (!opts.validate(v)) throw new Error("bad");
          return v as T;
        }
        if (label === "critic") {
          const v = { atsCoveragePct: 80, verdicts: [] };
          if (!opts.validate(v)) throw new Error("bad");
          return v as T;
        }
        if (label === "summary") {
          const v = { summary: "ML engineer shipping production systems." };
          if (!opts.validate(v)) throw new Error("bad summary");
          return v as T;
        }
        throw new Error(`unexpected: ${label}`);
      },
    );

    const result = await synthesizeResume({
      jdText:
        "We need a Senior ML Engineer with Python and PyTorch experience for production systems.",
      personaId: "ai",
      templateId: TYPST_ATS_SINGLE_TEMPLATE.id,
      onProgress: (s) => {
        stages.push(s.id);
        if (s.detail) details.push(s.detail);
      },
      deps: {
        listBlocks: async () => [block("exp_a", ["Python"])],
        listPersonas: async () => [persona],
        vectorSearch: async () => [],
        saveRun: async () => {},
        llmJson: llmJson as never,
        embed: async () => {
          throw new Error("[E_NO_MODEL]");
        },
        compile: async (_t, content) => ({
          tex: "\\documentclass{article}\\begin{document}broken\\end{document}",
          content,
          repairs: ["experience:exp_a:bullet:1"],
          result: { success: false, summary: "compile failed" },
          pdfBytes: null,
        }),
      },
    });

    expect(result.compileOk).toBe(false);
    expect(stages).toContain("done");
    expect(details.some((d) => /needs review/i.test(d))).toBe(true);
  });

  it("emits streamPreview during analyzing when streamComplete is provided", async () => {
    const previews: string[] = [];
    const llmJson = vi.fn(
      async <T>(opts: {
        label?: string;
        validate: (v: unknown) => v is T;
        streamComplete?: (
          o: { system: string; prompt: string },
          onChunk: (f: string) => void,
        ) => Promise<string>;
        onStreamPreview?: (preview: string, raw: string) => void;
      }): Promise<T> => {
        const label = opts.label ?? "";
        if (label === "jd-analysis") {
          opts.onStreamPreview?.('{"roleTitle":"ML', '{"roleTitle":"ML');
          if (!opts.validate(profile)) throw new Error("bad");
          return profile as T;
        }
        if (label.startsWith("distill:") || label.startsWith("rewrite:")) {
          const blockId = label.slice(label.indexOf(":") + 1);
          const v = {
            bullets: [
              {
                id: `${blockId}_b1`,
                text: `Delivered Python systems with 40% gain for ${blockId}`,
              },
            ],
          };
          if (!opts.validate(v)) throw new Error("bad");
          return v as T;
        }
        if (label === "critic") {
          opts.onStreamPreview?.("atsCoverage", "atsCoverage");
          const v = { atsCoveragePct: 80, verdicts: [] };
          if (!opts.validate(v)) throw new Error("bad");
          return v as T;
        }
        if (label === "summary") {
          const v = { summary: "ML engineer shipping production systems." };
          if (!opts.validate(v)) throw new Error("bad summary");
          return v as T;
        }
        throw new Error(`unexpected: ${label}`);
      },
    );

    await synthesizeResume({
      jdText:
        "We need a Senior ML Engineer with Python and PyTorch experience for production systems.",
      personaId: "ai",
      templateId: TYPST_ATS_SINGLE_TEMPLATE.id,
      onProgress: (s) => {
        if (s.streamPreview) previews.push(`${s.id}:${s.streamPreview}`);
      },
      deps: {
        listBlocks: async () => [block("exp_a", ["Python"])],
        listPersonas: async () => [persona],
        vectorSearch: async () => [],
        saveRun: async () => {},
        llmJson: llmJson as never,
        streamComplete: async (_o, onChunk) => {
          onChunk("x");
          return "{}";
        },
        embed: async () => {
          throw new Error("[E_NO_MODEL]");
        },
        compile: async (_t, content) => ({
          tex: "tex",
          content,
          repairs: [],
          result: { success: true, summary: "ok" },
        }),
      },
    });

    expect(previews.some((p) => p.startsWith("analyzing:"))).toBe(true);
    expect(previews.some((p) => p.startsWith("critic:"))).toBe(true);
  });
});
