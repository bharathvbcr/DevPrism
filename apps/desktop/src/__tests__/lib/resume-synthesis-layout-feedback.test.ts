import { describe, expect, it } from "vitest";
import { synthesizeResume } from "@/lib/resume-synthesis";
import type { SynthesisDeps } from "@/lib/resume-synthesis/types";

describe("Stage 7.5 Layout Feedback & Page-Overflow Auto-Condenser", () => {
  it("auto-condenses trailing bullets when layout spills over target page budget", async () => {
    let compileAttempts = 0;

    const mockDeps: Partial<SynthesisDeps> = {
      listBlocks: async () => [
        {
          id: "blk1",
          kind: "experience",
          title: "Principal Engineer",
          org: "Acme",
          dateRange: { start: "2020-01", end: null },
          personas: ["ai"],
          domains: ["ai"],
          skills: [{ name: "Rust", level: 5 }],
          seniorityLevel: 5,
          bullets: [
            {
              id: "b1",
              canonical: "Architected core inference engine in Rust with 4x throughput.",
              variants: {},
              metrics: [{ id: "m1", value: "4x" }],
              evidenceRefs: [],
              locked: false,
            },
            {
              id: "b2",
              canonical: "Reduced memory consumption by 30% using custom arena allocators.",
              variants: {},
              metrics: [{ id: "m2", value: "30%" }],
              evidenceRefs: [],
              locked: false,
            },
          ],
          facts: [],
        },
        {
          id: "blk2",
          kind: "experience",
          title: "Senior Engineer",
          org: "BetaCorp",
          dateRange: { start: "2018-01", end: "2019-12" },
          personas: ["ai"],
          domains: ["ai"],
          skills: [{ name: "Distributed Systems", level: 4 }],
          seniorityLevel: 4,
          bullets: [
            {
              id: "b3",
              canonical: "Managed migration to Kubernetes cluster across 3 availability zones.",
              variants: {},
              metrics: [{ id: "m3", value: "3" }],
              evidenceRefs: [],
              locked: false,
            },
            {
              id: "b4",
              canonical: "Built telemetry dashboards in Grafana with Prometheus alerting.",
              variants: {},
              metrics: [],
              evidenceRefs: [],
              locked: false,
            },
          ],
          facts: [],
        },
      ],
      listPersonas: async () => [
        {
          id: "ai",
          name: "AI Engineer",
          toneDirective: "Technical",
          sectionOrder: ["experience", "skills", "education"],
          defaultTemplateId: "typst-ats-single-column",
          skillWeights: {},
          domainAffinities: {},
        },
      ],
      vectorSearch: async () => [],
      embed: async (texts) => texts.map(() => new Array(384).fill(0.1)),
      llmJson: async ({ label }: { label?: string }) => {
        if (label === "jd-analysis") {
          return {
            roleTitle: "Staff Software Engineer",
            seniority: "Staff",
            mustHaveSkills: ["Rust"],
            niceToHaveSkills: [],
            atsKeywords: ["Rust", "Inference"],
            toneSignals: ["technical"],
            domainKeywords: ["AI"],
          } as any;
        }
        if (label?.startsWith("distill:")) {
          return {
            bullets: [
              { id: "b1", text: "Architected core inference engine in Rust with 4x throughput.", sourceBulletId: "b1", sourceFactIds: [] },
              { id: "b2", text: "Reduced memory consumption by 30% using custom arena allocators.", sourceBulletId: "b2", sourceFactIds: [] },
              { id: "b3", text: "Managed migration to Kubernetes cluster across 3 availability zones.", sourceBulletId: "b3", sourceFactIds: [] },
              { id: "b4", text: "Built telemetry dashboards in Grafana with Prometheus alerting.", sourceBulletId: "b4", sourceFactIds: [] },
            ],
          } as any;
        }
        if (label === "critic") {
          return {
            verdicts: [
              { blockId: "blk1", bulletId: "b1", grounded: true, keywordHits: ["Rust"], flags: [] },
              { blockId: "blk1", bulletId: "b2", grounded: true, keywordHits: [], flags: [] },
              { blockId: "blk2", bulletId: "b3", grounded: true, keywordHits: [], flags: [] },
              { blockId: "blk2", bulletId: "b4", grounded: true, keywordHits: [], flags: [] },
            ],
          } as any;
        }
        return {} as any;
      },
      compile: async (_tmpl, content) => {
        compileAttempts++;
        // Attempt 1: spillover (page count 2)
        // Attempt 2: auto-condensed (page count 1)
        const pageCount = compileAttempts === 1 ? 2 : 1;
        return {
          tex: "mock typst source",
          content,
          result: { success: true, summary: "Compiled successfully" },
          pdfBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          pageCount,
        };
      },
      saveRun: async () => {},
    };

    const res = await synthesizeResume({
      jdText: "Looking for a Staff Engineer with strong Rust and AI inference experience.",
      personaId: "ai",
      templateId: "typst-ats-single-column",
      deps: mockDeps,
    });

    expect(res.compileOk).toBe(true);
    expect(compileAttempts).toBe(2);
    expect(res.report.notices.some((n) => n.includes("Layout auto-condensed"))).toBe(true);
  });
});
