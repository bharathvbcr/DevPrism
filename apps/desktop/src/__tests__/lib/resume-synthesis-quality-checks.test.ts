import { describe, expect, it } from "vitest";
import { runQualityChecks } from "@/lib/resume-synthesis";
import type { RewrittenBlockDraft } from "@/lib/resume-synthesis/types";

describe("runQualityChecks", () => {
  it("detects weak starting verbs", () => {
    const drafts: RewrittenBlockDraft[] = [
      {
        block: {
          id: "blk1",
          kind: "experience",
          title: "Engineer",
          org: "Acme",
          dateRange: { start: "2022-01", end: null },
          personas: ["ai"],
          domains: ["software"],
          skills: [],
          seniorityLevel: 3,
          bullets: [],
          facts: [],
        },
        bullets: [
          {
            id: "b1",
            text: "Responsible for managing the AWS infrastructure and kubernetes cluster.",
            usedCanonical: false,
          },
          {
            id: "b2",
            text: "Helped with migrating legacy Python services to Go.",
            usedCanonical: false,
          },
          {
            id: "b3",
            text: "Worked on database optimization and query profiling.",
            usedCanonical: false,
          },
        ],
        evidence: [],
        score: 0.9,
        components: { embedding: 0.9, skills: 0.9, persona: 0.9, recency: 0.9, seniority: 0.9 },
      },
    ];

    const flags = runQualityChecks(drafts);
    expect(flags).toContain("blk1:b1:weak-verb");
    expect(flags).toContain("blk1:b2:weak-verb");
    expect(flags).toContain("blk1:b3:weak-verb");
  });

  it("detects repetitive starting verbs across consecutive bullets", () => {
    const drafts: RewrittenBlockDraft[] = [
      {
        block: {
          id: "blk1",
          kind: "experience",
          title: "Engineer",
          org: "Acme",
          dateRange: { start: "2022-01", end: null },
          personas: ["ai"],
          domains: ["software"],
          skills: [],
          seniorityLevel: 3,
          bullets: [],
          facts: [],
        },
        bullets: [
          {
            id: "b1",
            text: "Architected real-time streaming pipeline processing 10k events/sec.",
            usedCanonical: false,
          },
          {
            id: "b2",
            text: "Architected fraud prevention engine reducing chargebacks by 20%.",
            usedCanonical: false,
          },
        ],
        evidence: [],
        score: 0.9,
        components: { embedding: 0.9, skills: 0.9, persona: 0.9, recency: 0.9, seniority: 0.9 },
      },
    ];

    const flags = runQualityChecks(drafts);
    expect(flags).toContain("blk1:b2:repetitive-verb");
  });

  it("detects missing X-Y-Z metric or outcome in long descriptive bullets", () => {
    const drafts: RewrittenBlockDraft[] = [
      {
        block: {
          id: "blk1",
          kind: "experience",
          title: "Engineer",
          org: "Acme",
          dateRange: { start: "2022-01", end: null },
          personas: ["ai"],
          domains: ["software"],
          skills: [],
          seniorityLevel: 3,
          bullets: [],
          facts: [],
        },
        bullets: [
          {
            id: "b1",
            text: "Maintained internal tooling documentation and participated in agile sprint planning meetings.",
            usedCanonical: false,
          },
        ],
        evidence: [],
        score: 0.9,
        components: { embedding: 0.9, skills: 0.9, persona: 0.9, recency: 0.9, seniority: 0.9 },
      },
    ];

    const flags = runQualityChecks(drafts);
    expect(flags).toContain("blk1:b1:missing-xyz-metric");
  });

  it("produces zero flags for strong impact bullets", () => {
    const drafts: RewrittenBlockDraft[] = [
      {
        block: {
          id: "blk1",
          kind: "experience",
          title: "Engineer",
          org: "Acme",
          dateRange: { start: "2022-01", end: null },
          personas: ["ai"],
          domains: ["software"],
          skills: [],
          seniorityLevel: 3,
          bullets: [],
          facts: [],
        },
        bullets: [
          {
            id: "b1",
            text: "Engineered distributed streaming pipeline in Rust, accelerating throughput by 4x.",
            usedCanonical: false,
          },
          {
            id: "b2",
            text: "Spearheaded zero-downtime migration of 12 microservices, reducing P99 latency by 35%.",
            usedCanonical: false,
          },
        ],
        evidence: [],
        score: 0.9,
        components: { embedding: 0.9, skills: 0.9, persona: 0.9, recency: 0.9, seniority: 0.9 },
      },
    ];

    const flags = runQualityChecks(drafts);
    expect(flags).toEqual([]);
  });
});
