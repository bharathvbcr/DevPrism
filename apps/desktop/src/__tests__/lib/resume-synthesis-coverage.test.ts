import { describe, expect, it } from "vitest";
import type { ExperienceBlock } from "@/lib/career/types";
import { buildMustHaveCoverage } from "@/lib/resume-synthesis/orchestrator";
import type { RewrittenBlockDraft } from "@/lib/resume-synthesis/types";

function block(
  id: string,
  opts: {
    skills?: string[];
    domains?: string[];
    bullets?: Array<{ id: string; canonical: string }>;
  } = {},
): ExperienceBlock {
  return {
    id,
    kind: "experience",
    title: `Title ${id}`,
    org: `Org ${id}`,
    dateRange: { start: "2021-01", end: null },
    personas: ["ai"],
    domains: opts.domains ?? [],
    skills: (opts.skills ?? []).map((name) => ({ name, level: 4 as const })),
    seniorityLevel: "senior",
    bullets: (opts.bullets ?? [{ id: `${id}_b1`, canonical: "Did work" }]).map(
      (b) => ({
        id: b.id,
        canonical: b.canonical,
        variants: {},
        metrics: [],
        evidenceRefs: [],
        locked: false,
      }),
    ),
    facts: [],
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("buildMustHaveCoverage", () => {
  it("maps must-have skills to covering blocks and bullets", () => {
    const selected = [
      block("exp_a", {
        skills: ["Python"],
        bullets: [
          { id: "exp_a_b1", canonical: "Built Python services" },
          { id: "exp_a_b2", canonical: "Led hiring" },
        ],
      }),
      block("exp_b", {
        skills: ["Go"],
        bullets: [{ id: "exp_b_b1", canonical: "Wrote Go APIs" }],
      }),
    ];
    const coverage = buildMustHaveCoverage(
      ["Python", "Kubernetes"],
      selected,
      null,
    );
    expect(coverage).toHaveLength(2);
    const py = coverage.find((c) => c.skill === "Python")!;
    expect(py.status).toBe("covered");
    expect(py.selectionHits.some((h) => h.blockId === "exp_a")).toBe(true);
    expect(py.selectionHits.some((h) => h.bulletId === "exp_a_b1")).toBe(true);

    const k8s = coverage.find((c) => c.skill === "Kubernetes")!;
    expect(k8s.status).toBe("uncovered");
    expect(k8s.selectionHits).toEqual([]);
  });

  it("records rewriteHits from rewritten bullet text", () => {
    const selected = [
      block("exp_a", {
        skills: [],
        bullets: [{ id: "exp_a_b1", canonical: "Built internal tools" }],
      }),
    ];
    const drafts: RewrittenBlockDraft[] = [
      {
        block: selected[0]!,
        score: 0.8,
        components: {
          embedding: 0.5,
          skills: 0.5,
          persona: 1,
          recency: 0.5,
          seniority: 1,
        },
        evidence: [],
        bullets: [
          {
            id: "exp_a_b1",
            text: "Built Kubernetes platforms for ML",
            usedCanonical: false,
          },
        ],
      },
    ];
    const coverage = buildMustHaveCoverage(["Kubernetes"], selected, drafts);
    expect(coverage[0]!.status).toBe("covered");
    expect(coverage[0]!.rewriteHits).toEqual([
      { blockId: "exp_a", bulletId: "exp_a_b1" },
    ]);
  });
});
