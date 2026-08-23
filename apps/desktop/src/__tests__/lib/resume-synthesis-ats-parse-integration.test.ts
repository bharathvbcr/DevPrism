/**
 * Pipeline integration: the synthesis orchestrator attaches ATS parse
 * simulation and keyword heatmap summaries to every final MatchReport.
 * Ported from IgniteCV and natively integrated into stage 7 (assembling).
 */
import { describe, expect, it, vi } from "vitest";
import type { ExperienceBlock, Persona } from "@/lib/career/types";
import { TYPST_ATS_SINGLE_TEMPLATE } from "@/lib/resume-templates";
import { synthesizeResume } from "@/lib/resume-synthesis/orchestrator";
import type { JDProfile } from "@/lib/resume-synthesis/types";

const persona: Persona = {
  id: "ai",
  label: "AI",
  skillWeights: {},
  defaultTemplateId: "typst-ats-single-column",
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

function mockLlm() {
  return vi.fn(
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
}

describe("synthesizer ATS parse integration", () => {
  it("attaches atsParse + keywordHeatmap summaries to the final report", async () => {
    const llmJson = mockLlm();
    const result = await synthesizeResume({
      jdText:
        "We are hiring via Workday: Senior ML Engineer with Python and PyTorch experience for production systems.",
      personaId: "ai",
      templateId: TYPST_ATS_SINGLE_TEMPLATE.id,
      header: {
        fullName: "Test User",
        cityRegion: "SF",
        email: "t@example.com",
        phone: "555-0100",
      },
      deps: {
        listBlocks: async () => [block("exp_a", ["Python", "PyTorch"])],
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

    const atsParse = result.report.atsParse;
    expect(atsParse).toBeDefined();
    expect(atsParse!.system).toBe("workday");
    expect(Array.isArray(atsParse!.warnings)).toBe(true);
    const detected = atsParse!.sections
      .filter((s) => s.detected)
      .map((s) => s.name);
    expect(detected).toEqual(expect.arrayContaining(["summary", "experience"]));
    // Header contact info flowed into the parse check.
    expect(atsParse!.contact.email).toBe(true);

    const heat = result.report.keywordHeatmap;
    expect(heat).toBeDefined();
    expect(heat!.sections.length).toBeGreaterThan(0);
    expect(heat!.overallDensity).toBeGreaterThanOrEqual(0);
    for (const s of heat!.sections) {
      expect(s.heatLevel).toBeGreaterThanOrEqual(0);
      expect(s.heatLevel).toBeLessThanOrEqual(5);
    }
  });

  it("persists the ATS summaries alongside the run for replay", async () => {
    let saved: unknown = null;
    const llmJson = mockLlm();
    await synthesizeResume({
      jdText:
        "Senior ML Engineer role with Python and PyTorch experience for production systems.",
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
          tex: "tex",
          content,
          repairs: [],
          result: { success: true, summary: "ok" },
        }),
      },
    });
    const persisted = saved as {
      atsParse?: unknown;
      keywordHeatmap?: unknown;
    };
    expect(persisted.atsParse).toBeDefined();
    expect(persisted.keywordHeatmap).toBeDefined();
  });

  it("flags formatting hazards from user data in the final report", async () => {
    const llmJson = mockLlm();
    const result = await synthesizeResume({
      jdText: "Senior ML Engineer role with Python and PyTorch.",
      personaId: "ai",
      templateId: TYPST_ATS_SINGLE_TEMPLATE.id,
      header: {
        fullName: "Test | User",
        cityRegion: "SF",
        email: "t@example.com",
        phone: "555",
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
          tex: "tex",
          content,
          repairs: [],
          result: { success: true, summary: "ok" },
        }),
      },
    });
    // The pipe in the header name must trip the table/tab hazard check.
    expect(
      result.report.atsParse!.warnings.some((w) => /table|tab/i.test(w)),
    ).toBe(true);
  });
});
