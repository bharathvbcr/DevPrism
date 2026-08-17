import { describe, expect, it } from "vitest";
import { repairFlagged } from "@/lib/resume-synthesis/critic";
import type {
  CriticResult,
  JDProfile,
  RewrittenBlockDraft,
} from "@/lib/resume-synthesis/types";
import type { Persona } from "@/lib/career/types";

const mockProfile: JDProfile = {
  roleTitle: "Staff Software Engineer",
  seniority: "Staff",
  mustHaveSkills: ["Rust", "Distributed Systems"],
  niceToHaveSkills: ["Typst"],
  atsKeywords: ["Rust", "Latency", "Distributed Systems"],
  toneSignals: ["ownership"],
  domainKeywords: ["Systems"],
};

const mockPersona: Persona = {
  id: "ai",
  name: "AI Engineer",
  toneDirective: "Technical, impactful",
  sectionOrder: ["experience", "skills", "projects", "education"],
  defaultTemplateId: "typst-ats-single-column",
  skillWeights: {},
  domainAffinities: {},
};

describe("repairFlagged with fact-only distilled bullets", () => {
  it("repairs an ungrounded fact-only bullet using cited ground truth facts", async () => {
    const drafts: RewrittenBlockDraft[] = [
      {
        block: {
          id: "blk1",
          kind: "experience",
          title: "Staff Engineer",
          org: "ScaleCorp",
          dateRange: { start: "2021-01", end: null },
          personas: ["ai"],
          domains: ["systems"],
          skills: [],
          seniorityLevel: 4,
          bullets: [
            {
              id: "b_canonical_1",
              canonical: "Built distributed key-value store in Rust.",
              variants: {},
              metrics: [],
              evidenceRefs: [],
              locked: false,
            },
          ],
          facts: [
            {
              id: "fact_1",
              text: "Reduced P99 read latency from 45ms to 12ms (73% drop) using raft consensus.",
              skills: ["Rust", "Raft"],
              metrics: [{ id: "m1", value: "73%" }],
              source: "manual",
            },
          ],
        },
        bullets: [
          {
            id: "b_canonical_1",
            text: "Built distributed key-value store in Rust.",
            usedCanonical: true,
            sourceBulletId: "b_canonical_1",
          },
          {
            id: "distill_fact_1",
            text: "Achieved 99.999% uptime for payment cluster.", // Hallucinated / ungrounded
            usedCanonical: false,
            sourceFactIds: ["fact_1"],
            sourceBulletId: null,
          },
        ],
        evidence: ["Raft consensus implementation in Rust"],
        score: 0.95,
        components: { embedding: 0.95, skills: 0.95, persona: 0.95, recency: 0.95, seniority: 0.95 },
      },
    ];

    const critique: CriticResult = {
      atsCoveragePct: 80,
      programmaticFlags: [],
      verdicts: [
        {
          blockId: "blk1",
          bulletId: "distill_fact_1",
          grounded: false,
          keywordHits: [],
          flags: ["unsupported-claim"],
        },
      ],
    };

    // Mock LLM repair that outputs grounded bullet with fact metric
    const mockLlm = async () => ({
      bullets: [
        {
          id: "distill_fact_1",
          text: "Reduced P99 read latency by 73% using Raft consensus in Rust.",
        },
      ],
    });

    const repaired = await repairFlagged(
      drafts,
      critique,
      mockProfile,
      mockPersona,
      140,
      { llmJson: mockLlm as any, maxRetries: 1 },
    );

    expect(repaired[0]!.bullets.length).toBe(2);
    const factBullet = repaired[0]!.bullets.find((b) => b.id === "distill_fact_1");
    expect(factBullet).toBeDefined();
    expect(factBullet!.text).toContain("73%");
    expect(factBullet!.usedCanonical).toBe(false);
  });

  it("prunes ungrounded fact-only bullet if it has no cited facts or repair fails", async () => {
    const drafts: RewrittenBlockDraft[] = [
      {
        block: {
          id: "blk1",
          kind: "experience",
          title: "Staff Engineer",
          org: "ScaleCorp",
          dateRange: { start: "2021-01", end: null },
          personas: ["ai"],
          domains: ["systems"],
          skills: [],
          seniorityLevel: 4,
          bullets: [
            {
              id: "b_canonical_1",
              canonical: "Built distributed key-value store in Rust.",
              variants: {},
              metrics: [],
              evidenceRefs: [],
              locked: false,
            },
          ],
          facts: [],
        },
        bullets: [
          {
            id: "b_canonical_1",
            text: "Built distributed key-value store in Rust.",
            usedCanonical: true,
            sourceBulletId: "b_canonical_1",
          },
          {
            id: "distill_orphan_1",
            text: "Hallucinated completely ungrounded accomplishment.",
            usedCanonical: false,
            sourceFactIds: [], // Missing provenance / no facts
            sourceBulletId: null,
          },
        ],
        evidence: [],
        score: 0.95,
        components: { embedding: 0.95, skills: 0.95, persona: 0.95, recency: 0.95, seniority: 0.95 },
      },
    ];

    const critique: CriticResult = {
      atsCoveragePct: 60,
      programmaticFlags: [],
      verdicts: [
        {
          blockId: "blk1",
          bulletId: "distill_orphan_1",
          grounded: false,
          keywordHits: [],
          flags: ["unsupported-claim"],
        },
      ],
    };

    const repaired = await repairFlagged(
      drafts,
      critique,
      mockProfile,
      mockPersona,
      140,
      { maxRetries: 1 },
    );

    // Ungrounded fact bullet without valid backing facts must be pruned
    expect(repaired[0]!.bullets.length).toBe(1);
    expect(repaired[0]!.bullets[0]!.id).toBe("b_canonical_1");
  });
});
