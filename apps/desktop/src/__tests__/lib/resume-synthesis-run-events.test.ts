import { describe, expect, it, vi } from "vitest";
import type { ExperienceBlock, Persona } from "@/lib/career/types";
import {
  summarizeRewriteHonesty,
  synthesizeResume,
} from "@/lib/resume-synthesis/orchestrator";
import type {
  JDProfile,
  RewrittenBlockDraft,
  RunEvent,
} from "@/lib/resume-synthesis/types";

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

describe("summarizeRewriteHonesty", () => {
  it("counts AI vs fallback bullets and preserves evidence", () => {
    const drafts: RewrittenBlockDraft[] = [
      {
        block: block("a", ["Python"]),
        bullets: [
          {
            id: "a_b1",
            text: "Delivered Python with 40% gain",
            usedCanonical: false,
            fallbackReason: null,
          },
        ],
        evidence: ["chunk-1"],
        score: 0.9,
        components: {
          embedding: 0.5,
          skills: 0.8,
          persona: 0.5,
          recency: 0.5,
          seniority: 0.5,
        },
      },
      {
        block: block("b", ["Go"]),
        bullets: [
          {
            id: "b_b1",
            text: "canonical",
            usedCanonical: true,
            fallbackReason: "metrics-lost",
          },
        ],
        evidence: [],
        score: 0.4,
        components: {
          embedding: 0.2,
          skills: 0.3,
          persona: 0.5,
          recency: 0.5,
          seniority: 0.5,
        },
      },
    ];
    const out = summarizeRewriteHonesty(drafts);
    expect(out.aiRewrittenCount).toBe(1);
    expect(out.canonicalFallbackCount).toBe(1);
    expect(out.bulletFallbackReasons).toEqual([
      { blockId: "b", bulletId: "b_b1", reason: "metrics-lost" },
    ]);
    expect(out.blockEvidence[0]?.chunks).toEqual(["chunk-1"]);
    expect(out.blockEvidence[1]?.chunks).toEqual([]);
  });
});

describe("synthesizeResume event emission", () => {
  it("emits stage events, skipSemanticCache on llm, and honesty fields", async () => {
    const events: RunEvent[] = [];
    const skipFlags: boolean[] = [];

    const llmJson = vi.fn(
      async <T>(opts: {
        label?: string;
        validate: (v: unknown) => v is T;
        skipSemanticCache?: boolean;
      }): Promise<T> => {
        skipFlags.push(opts.skipSemanticCache === true);
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
          throw new Error("critic unavailable");
        }
        if (label === "summary") {
          const v = { summary: "ML engineer shipping production systems." };
          if (!opts.validate(v)) throw new Error("bad summary");
          return v as T;
        }
        throw new Error(`unexpected llm label: ${label}`);
      },
    );

    const result = await synthesizeResume({
      jdText:
        "We need a senior ML engineer with Python and strong ML systems experience. ".repeat(
          3,
        ),
      personaId: "ai",
      templateId: "ats-single-column",
      onEvent: (e) => events.push(e),
      deps: {
        listBlocks: async () => [block("exp_a", ["Python", "ML"])],
        listPersonas: async () => [persona],
        vectorSearch: async () => [],
        saveRun: async () => {},
        llmJson: llmJson as never,
        embed: async () => {
          throw new Error("no embeddings");
        },
        compile: async (_t, content) => ({
          tex: "% ok",
          content,
          repairs: [],
          result: { success: true, summary: "ok" },
          pdfBytes: null,
        }),
      },
    });

    expect(events.some((e) => e.type === "stage-start")).toBe(true);
    expect(events.some((e) => e.type === "stage-finish")).toBe(true);
    expect(events.some((e) => e.type === "embeddings-disabled")).toBe(true);
    expect(events.some((e) => e.type === "evidence-empty")).toBe(true);
    expect(events.some((e) => e.type === "critic-skipped")).toBe(true);
    expect(events.some((e) => e.type === "block-rewrite-start")).toBe(true);
    expect(events.some((e) => e.type === "block-rewrite-done")).toBe(true);
    // Live token previews stay on stage.streamPreview — not persisted as events.
    expect(events.some((e) => e.type === "block-rewrite-stream")).toBe(false);

    expect(skipFlags.length).toBeGreaterThan(0);
    expect(skipFlags.every(Boolean)).toBe(true);

    expect(result.report.aiRewrittenCount).toBeGreaterThanOrEqual(0);
    expect(result.report.canonicalFallbackCount).toBeGreaterThanOrEqual(0);
    expect(
      (result.report.aiRewrittenCount ?? 0) +
        (result.report.canonicalFallbackCount ?? 0),
    ).toBeGreaterThan(0);
    expect(result.report.blockEvidence?.length).toBe(1);
    expect(result.report.critique?.llmSkipped).toBe(true);
    expect(result.report.critique?.atsCoveragePct).toBeGreaterThanOrEqual(0);
  });

  it("emits bullet-fallback events with reasons and honesty counts", async () => {
    const events: RunEvent[] = [];

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
          // Drop the required metric → metrics-lost fallback
          const blockId = label.includes(":")
            ? label.slice(label.indexOf(":") + 1)
            : label;
          const v = {
            bullets: [
              {
                id: `${blockId}_b1`,
                text: `Delivered Python systems for ${blockId}`,
                sourceFactIds: [],
                sourceBulletId: `${blockId}_b1`,
              },
            ],
          };
          if (!opts.validate(v)) throw new Error("bad rewrite");
          return v as T;
        }
        if (label === "critic") {
          throw new Error("critic unavailable");
        }
        if (label === "summary") {
          const v = { summary: "ML engineer." };
          if (!opts.validate(v)) throw new Error("bad summary");
          return v as T;
        }
        throw new Error(`unexpected llm label: ${label}`);
      },
    );

    const result = await synthesizeResume({
      jdText:
        "We need a senior ML engineer with Python and strong ML systems experience. ".repeat(
          3,
        ),
      personaId: "ai",
      templateId: "ats-single-column",
      onEvent: (e) => events.push(e),
      deps: {
        listBlocks: async () => [block("exp_a", ["Python", "ML"])],
        listPersonas: async () => [persona],
        vectorSearch: async () => [],
        saveRun: async () => {},
        llmJson: llmJson as never,
        embed: async () => [[0.1, 0.2]],
        compile: async (_t, content) => ({
          tex: "% ok",
          content,
          repairs: [],
          result: { success: true, summary: "ok" },
          pdfBytes: null,
        }),
      },
    });

    const fallbacks = events.filter((e) => e.type === "bullet-fallback");
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(
      fallbacks.every((e) => e.type === "bullet-fallback" && e.reason),
    ).toBe(true);
    expect(
      fallbacks.some(
        (e) => e.type === "bullet-fallback" && e.reason === "metrics-lost",
      ),
    ).toBe(true);
    expect(result.report.canonicalFallbackCount).toBeGreaterThan(0);
    expect(result.report.bulletFallbackReasons?.length).toBeGreaterThan(0);
    expect(result.report.bulletFallbackReasons?.[0]?.reason).toBe(
      "metrics-lost",
    );
  });
});
