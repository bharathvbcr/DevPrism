import { describe, expect, it } from "vitest";
import type { BlockFact, Bullet, ExperienceBlock } from "@/lib/career/types";
import {
  analyzeMustHaveGaps,
  collectBlockSkillHits,
  enforceBulletInvariants,
  enforceFactOnlyInvariants,
  gapMissingOrWeak,
  hasProvenance,
  metricsFromProvenance,
  normalizeDistillBullet,
  validateDistillBlockOut,
  validateRewriteBlockOut,
} from "@/lib/resume-synthesis";

const bullet: Bullet = {
  id: "b1",
  canonical: "Cut latency 40% with caching",
  variants: {},
  metrics: [{ value: "40%", kind: "pct" }],
  evidenceRefs: [],
  locked: false,
};

const factFast: BlockFact = {
  id: "fct_1",
  text: "Shipped Kubernetes autoscaling that cut p99 by 40%",
  skills: ["Kubernetes"],
  metrics: [{ value: "40%", kind: "pct" }],
  source: "manual",
  createdAt: "2024-01-01T00:00:00.000Z",
};

const factK8s: BlockFact = {
  id: "fct_2",
  text: "Operated a 50-node Kubernetes cluster for ML inference",
  skills: ["Kubernetes"],
  metrics: [{ value: "50-node", kind: "count" }],
  source: "manual",
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("distill validation + provenance invariants", () => {
  it("validateDistillBlockOut requires provenance fields", () => {
    expect(
      validateDistillBlockOut({
        bullets: [
          { id: "b1", text: "x", sourceFactIds: [], sourceBulletId: "b1" },
        ],
      }),
    ).toBe(true);
    expect(
      validateRewriteBlockOut({
        bullets: [{ id: "b1", text: "x" }],
      }),
    ).toBe(true);
    expect(
      validateDistillBlockOut({
        bullets: [{ id: "b1", text: "x" }],
      }),
    ).toBe(false);
  });

  it("normalizeDistillBullet infers sourceBulletId from matching id", () => {
    const block = {
      bullets: [bullet],
    } as ExperienceBlock;
    const n = normalizeDistillBullet(
      { id: "b1", text: "Cut latency 40% with Redis" },
      block,
    );
    expect(n.sourceBulletId).toBe("b1");
    expect(hasProvenance(n)).toBe(true);
  });

  it("rejects unknown cited fact ids", () => {
    const out = enforceBulletInvariants(
      "Cut latency 40% with caching",
      bullet,
      140,
      {
        facts: [factFast],
        sourceFactIds: ["fct_missing"],
        sourceBulletId: "b1",
      },
    );
    expect(out.usedCanonical).toBe(true);
    expect(out.fallbackReason).toBe("invalid-provenance");
  });

  it("requires metrics from cited facts", () => {
    const out = enforceBulletInvariants(
      "Ran a Kubernetes cluster for ML",
      { ...bullet, metrics: [] },
      140,
      {
        facts: [factK8s],
        sourceFactIds: ["fct_2"],
        sourceBulletId: "b1",
      },
    );
    expect(out.fallbackReason).toBe("metrics-lost");

    const ok = enforceBulletInvariants(
      "Operated a 50-node Kubernetes cluster for ML inference",
      { ...bullet, metrics: [] },
      140,
      {
        facts: [factK8s],
        sourceFactIds: ["fct_2"],
        sourceBulletId: "b1",
      },
    );
    expect(ok.usedCanonical).toBe(false);
    expect(ok.sourceFactIds).toEqual(["fct_2"]);
  });

  it("metricsFromProvenance unions bullet + fact metrics", () => {
    const metrics = metricsFromProvenance(bullet, ["fct_2"], [factK8s]);
    expect(metrics.map((m) => m.value)).toEqual(
      expect.arrayContaining(["40%", "50-node"]),
    );
  });

  it("enforceFactOnlyInvariants requires non-empty valid fact ids", () => {
    const bad = enforceFactOnlyInvariants(
      "Something about k8s",
      "distill_1",
      140,
      [factK8s],
      [],
    );
    expect(bad.fallbackReason).toBe("invalid-provenance");

    const ok = enforceFactOnlyInvariants(
      "Operated a 50-node Kubernetes cluster for ML inference",
      "distill_1",
      140,
      [factK8s],
      ["fct_2"],
    );
    expect(ok.usedCanonical).toBe(false);
    expect(ok.sourceBulletId).toBeNull();
    expect(ok.sourceFactIds).toEqual(["fct_2"]);
  });
});

function block(
  partial: Partial<ExperienceBlock> & { id: string },
): ExperienceBlock {
  return {
    kind: "experience",
    title: partial.title ?? "Engineer",
    org: partial.org ?? "Acme",
    dateRange: { start: "2022-01", end: null },
    personas: [],
    domains: partial.domains ?? [],
    skills: partial.skills ?? [],
    seniorityLevel: "senior",
    bullets: partial.bullets ?? [],
    facts: partial.facts ?? [],
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("gap analysis", () => {
  it("classifies covered / weak / missing across selected, pool, facts, KB", () => {
    const selected = block({
      id: "exp_sel",
      title: "Platform",
      skills: [{ name: "Python", level: 4 }],
      bullets: [
        {
          id: "b1",
          canonical: "Built Python services",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
      ],
      facts: [factFast],
    });
    const poolOnly = block({
      id: "exp_pool",
      title: "Infra",
      org: "Beta",
      skills: [{ name: "Go", level: 3 }],
      bullets: [
        {
          id: "b2",
          canonical: "Wrote Go microservices",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
      ],
    });

    const gap = analyzeMustHaveGaps({
      mustHaveSkills: ["Python", "Kubernetes", "Go", "Rust"],
      selectedBlocks: [selected],
      poolBlocks: [selected, poolOnly],
      kbChunks: ["Experience with Rust async runtimes"],
    });

    const bySkill = Object.fromEntries(gap.items.map((i) => [i.skill, i]));
    expect(bySkill.Python?.status).toBe("covered");
    expect(bySkill.Kubernetes?.status).toBe("covered"); // via fact skills/text
    expect(bySkill.Go?.status).toBe("weak"); // pool only
    expect(bySkill.Rust?.status).toBe("weak"); // KB only
    expect(gap.coveredCount).toBe(2);
    expect(gap.weakCount).toBe(2);
    expect(gap.missingCount).toBe(0);

    const gap2 = analyzeMustHaveGaps({
      mustHaveSkills: ["Terraform"],
      selectedBlocks: [selected],
      poolBlocks: [selected, poolOnly],
      kbChunks: [],
    });
    expect(gap2.items[0]?.status).toBe("missing");
    expect(gap2.items[0]?.suggestion).toMatch(/Terraform/i);
    expect(gapMissingOrWeak(gap2)).toHaveLength(1);
  });

  it("collectBlockSkillHits finds fact skill tags", () => {
    const b = block({
      id: "exp_1",
      facts: [factK8s],
    });
    const hits = collectBlockSkillHits(b, "Kubernetes");
    expect(hits.some((h) => h.kind === "fact" && h.factId === "fct_2")).toBe(
      true,
    );
  });
});
