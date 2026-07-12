import { describe, expect, it } from "vitest";
import type { ExperienceBlock } from "@/lib/career/types";
import { ATS_RESUME_TEMPLATE } from "@/lib/resume-templates";
import {
  assertBudgetInvariants,
  budgetFromTemplate,
  BUDGET_FIXED_OVERHEAD_LINES,
  cosineSimilarity,
  estimateBlockLines,
  knapsackSelect,
  mmrSelect,
  trimSelectedBullets,
} from "@/lib/resume-synthesis/selection";
import type { ScoredBlock } from "@/lib/resume-synthesis/types";

function makeBlock(
  id: string,
  opts: Partial<ExperienceBlock> & { score?: number } = {},
): ScoredBlock {
  const { score = 0.5, ...partial } = opts;
  const block: ExperienceBlock = {
    id,
    kind: "experience",
    title: `Role ${id}`,
    org: partial.org ?? `Org ${id}`,
    dateRange: { start: "2020-01", end: "2022-01" },
    personas: ["ai"],
    domains: [],
    skills: partial.skills ?? [],
    seniorityLevel: "senior",
    bullets: partial.bullets ?? [
      {
        id: `${id}_b1`,
        canonical: "Did a thing",
        variants: {},
        metrics: [],
        evidenceRefs: [],
        locked: false,
      },
      {
        id: `${id}_b2`,
        canonical: "Did another thing",
        variants: {},
        metrics: [],
        evidenceRefs: [],
        locked: false,
      },
    ],
    facts: [],
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...partial,
  };
  return {
    block,
    score,
    components: {
      embedding: score,
      skills: score,
      persona: 1,
      recency: 0.5,
      seniority: 1,
    },
  };
}

describe("estimateBlockLines", () => {
  it("counts header + wrapped bullet lines", () => {
    const s = makeBlock("a");
    // Short bullets → 1 wrapped line each → 2 header + 2 bullets
    expect(estimateBlockLines(s.block)).toBe(2 + s.block.bullets.length);
  });

  it("estimates wrap from long bullet character length", () => {
    const long = "x".repeat(200);
    const s = makeBlock("a", {
      bullets: [
        {
          id: "a_long",
          canonical: long,
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
      ],
    });
    expect(estimateBlockLines(s.block)).toBeGreaterThan(3);
  });
});

describe("budgetFromTemplate overhead", () => {
  it("subtracts fixed overhead from totalLines", () => {
    const b = budgetFromTemplate(ATS_RESUME_TEMPLATE.budget);
    expect(b.totalLines).toBe(
      ATS_RESUME_TEMPLATE.budget.totalLines - BUDGET_FIXED_OVERHEAD_LINES,
    );
    expect(b.totalLines).toBeLessThan(ATS_RESUME_TEMPLATE.budget.totalLines);
  });
});

describe("knapsackSelect budget invariants", () => {
  it("respects blocksPerSection and totalLines", () => {
    const scored = [
      makeBlock("a", { score: 0.9 }),
      makeBlock("b", { score: 0.8 }),
      makeBlock("c", { score: 0.7 }),
      makeBlock("d", { score: 0.6 }),
      makeBlock("e", { score: 0.5 }),
    ];
    const { selected } = knapsackSelect(scored, ATS_RESUME_TEMPLATE.budget, []);
    const check = assertBudgetInvariants(selected, ATS_RESUME_TEMPLATE.budget);
    expect(check.ok).toBe(true);
    expect(selected.length).toBeLessThanOrEqual(
      ATS_RESUME_TEMPLATE.budget.blocksPerSection.experience ?? 3,
    );
  });

  it("keeps at most one block per org unless score gap is large", () => {
    const scored = [
      makeBlock("a", { score: 0.9, org: "Acme" }),
      makeBlock("b", { score: 0.85, org: "Acme" }),
      makeBlock("c", { score: 0.7, org: "Beta" }),
    ];
    const { selected } = knapsackSelect(scored, ATS_RESUME_TEMPLATE.budget, []);
    const acme = selected.filter((s) => s.block.org === "Acme");
    expect(acme).toHaveLength(1);
    expect(acme[0]!.block.id).toBe("a");
  });

  it("swaps in a covering block for uncovered must-have skills", () => {
    const scored = [
      makeBlock("high", {
        score: 0.95,
        skills: [{ name: "Java", level: 3 }],
      }),
      makeBlock("mid", {
        score: 0.5,
        skills: [{ name: "Python", level: 5 }],
      }),
      makeBlock("low", {
        score: 0.4,
        skills: [{ name: "Go", level: 3 }],
      }),
    ];
    const { selected, uncoveredMustHaves, swaps } = knapsackSelect(
      scored,
      {
        totalLines: 20,
        perBullet: 140,
        blocksPerSection: { experience: 1 },
      },
      ["Python"],
    );
    expect(selected.some((s) => s.block.id === "mid")).toBe(true);
    expect(uncoveredMustHaves).toEqual([]);
    expect(swaps.length).toBeGreaterThan(0);
  });

  it("reverts a must-have swap that would uncover another must-have", () => {
    const scored = [
      makeBlock("both", {
        score: 0.9,
        skills: [
          { name: "Python", level: 5 },
          { name: "SQL", level: 4 },
        ],
      }),
      makeBlock("onlyC", {
        score: 0.5,
        skills: [{ name: "Rust", level: 5 }],
      }),
    ];
    const { selected, swaps, uncoveredMustHaves } = knapsackSelect(
      scored,
      {
        totalLines: 40,
        perBullet: 140,
        blocksPerSection: { experience: 1 },
      },
      ["Python", "SQL", "Rust"],
    );
    expect(selected.map((s) => s.block.id)).toEqual(["both"]);
    expect(swaps).toEqual([]);
    expect(uncoveredMustHaves).toContain("Rust");
  });

  it("is deterministic for the same scored input order", () => {
    const scored = [
      makeBlock("a", { score: 0.8 }),
      makeBlock("b", { score: 0.8 }),
      makeBlock("c", { score: 0.7 }),
    ];
    const r1 = knapsackSelect(scored, ATS_RESUME_TEMPLATE.budget, []);
    const r2 = knapsackSelect(scored, ATS_RESUME_TEMPLATE.budget, []);
    expect(r1.selected.map((s) => s.block.id)).toEqual(
      r2.selected.map((s) => s.block.id),
    );
  });
});

describe("trimSelectedBullets", () => {
  it("keeps the highest-relevance bullets up to maxPerBlock", () => {
    const item = makeBlock("a", {
      bullets: [
        {
          id: "a_low",
          canonical: "Unrelated admin work",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
        {
          id: "a_high",
          canonical: "Built Python ML pipelines",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
        {
          id: "a_mid",
          canonical: "Wrote docs",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
        {
          id: "a_also",
          canonical: "Mentored interns",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
        {
          id: "a_extra",
          canonical: "Filed expenses",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
      ],
    });
    const relevance = new Map([
      ["a_low", 0.1],
      ["a_high", 0.95],
      ["a_mid", 0.4],
      ["a_also", 0.5],
      ["a_extra", 0.05],
    ]);
    const [trimmed] = trimSelectedBullets([item], {
      maxBulletsPerBlock: 2,
      relevanceByBulletId: relevance,
    });
    expect(trimmed!.block.bullets.map((b) => b.id)).toEqual([
      "a_high",
      "a_also",
    ]);
  });

  it("always retains locked bullets", () => {
    const item = makeBlock("a", {
      bullets: [
        {
          id: "a_locked",
          canonical: "LOCKED metric 40%",
          variants: {},
          metrics: [{ value: "40%", kind: "pct" }],
          evidenceRefs: [],
          locked: true,
        },
        {
          id: "a_high",
          canonical: "Best match",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
        {
          id: "a_low",
          canonical: "Weak match",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
      ],
    });
    const [trimmed] = trimSelectedBullets([item], {
      maxBulletsPerBlock: 2,
      relevanceByBulletId: new Map([
        ["a_locked", 0],
        ["a_high", 1],
        ["a_low", 0.9],
      ]),
    });
    const ids = trimmed!.block.bullets.map((b) => b.id);
    expect(ids).toContain("a_locked");
    expect(ids).toContain("a_high");
    expect(ids).not.toContain("a_low");
  });

  it("boosts must-have keyword bullets when embedding scores tie", () => {
    const item = makeBlock("a", {
      bullets: [
        {
          id: "a_py",
          canonical: "Shipped Python services",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
        {
          id: "a_other",
          canonical: "Shipped Java services",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
        {
          id: "a_noise",
          canonical: "Office moves",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
      ],
    });
    const [trimmed] = trimSelectedBullets([item], {
      maxBulletsPerBlock: 1,
      relevanceByBulletId: new Map([
        ["a_py", 0.5],
        ["a_other", 0.5],
        ["a_noise", 0.5],
      ]),
      mustHaveSkills: ["Python"],
    });
    expect(trimmed!.block.bullets.map((b) => b.id)).toEqual(["a_py"]);
  });
});

describe("mmrSelect / cosineSimilarity", () => {
  it("computes cosine of identical unit vectors as 1", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("prefers diverse candidates over near-duplicates", () => {
    const selected = mmrSelect(
      [
        { item: "a", relevance: 0.99, vec: [1, 0, 0] },
        { item: "a_dup", relevance: 0.98, vec: [0.99, 0.01, 0] },
        { item: "b", relevance: 0.8, vec: [0, 1, 0] },
        { item: "c", relevance: 0.7, vec: [0, 0, 1] },
      ],
      2,
      0.5,
    );
    expect(selected[0]).toBe("a");
    expect(selected).toContain("b");
    expect(selected).not.toContain("a_dup");
  });

  it("returns at most k items", () => {
    const selected = mmrSelect(
      [
        { item: 1, relevance: 1, vec: [1, 0] },
        { item: 2, relevance: 0.9, vec: [0, 1] },
        { item: 3, relevance: 0.8, vec: [0.7, 0.7] },
      ],
      2,
    );
    expect(selected).toHaveLength(2);
  });
});
