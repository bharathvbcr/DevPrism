import { describe, expect, it, vi } from "vitest";
import type { ExperienceBlock, Persona } from "@/lib/career/types";
import { rewriteBlock } from "@/lib/resume-synthesis/rewrite";
import type { JDProfile, ScoredBlock } from "@/lib/resume-synthesis/types";

const persona: Persona = {
  id: "ai",
  label: "AI",
  skillWeights: {},
  defaultTemplateId: "ats-single-column",
  sectionOrder: ["skills", "experience"],
  toneDirective: "concise",
};

const profile: JDProfile = {
  roleTitle: "ML Engineer",
  seniority: "senior",
  mustHaveSkills: ["Python"],
  niceToHaveSkills: [],
  domains: ["ml"],
  atsKeywords: ["Python"],
  toneSignals: [],
  responsibilitiesText: "",
  qualificationsText: "",
};

function scored(): ScoredBlock {
  const block: ExperienceBlock = {
    id: "exp_a",
    kind: "experience",
    title: "Engineer",
    org: "Acme",
    dateRange: { start: "2021-01", end: null },
    personas: ["ai"],
    domains: [],
    skills: [{ name: "Python", level: 4 }],
    seniorityLevel: "senior",
    bullets: [
      {
        id: "exp_a_b1",
        canonical: "Built tools with 40% gain",
        variants: {},
        metrics: [{ value: "40%", kind: "improvement" }],
        evidenceRefs: [],
        locked: false,
      },
    ],
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  return {
    block,
    score: 0.9,
    components: {
      embedding: 0.5,
      skills: 0.9,
      persona: 1,
      recency: 0.5,
      seniority: 1,
    },
  };
}

describe("rewriteBlock streaming", () => {
  it("uses streamComplete when it returns valid JSON", async () => {
    const previews: string[] = [];
    const llmJson = vi.fn();
    const streamComplete = vi.fn(
      async (_opts, onChunk: (f: string) => void) => {
        const json =
          '{"bullets":[{"id":"exp_a_b1","text":"Shipped Python platforms with 40% gain"}]}';
        onChunk(json.slice(0, 20));
        onChunk(json.slice(20));
        return json;
      },
    );

    const out = await rewriteBlock(scored(), profile, persona, [], 200, {
      llmJson: llmJson as never,
      streamComplete,
      onStreamPreview: (p) => previews.push(p),
    });

    expect(streamComplete).toHaveBeenCalled();
    expect(llmJson).not.toHaveBeenCalled();
    expect(out.bullets[0]!.text).toContain("40%");
    expect(out.bullets[0]!.usedCanonical).toBe(false);
    expect(previews.length).toBeGreaterThan(0);
  });

  it("falls back to llmJson when stream JSON is invalid", async () => {
    const llmJson = vi.fn(
      async <T>(opts: { validate: (v: unknown) => v is T }): Promise<T> => {
        const v = {
          bullets: [
            { id: "exp_a_b1", text: "Delivered Python systems with 40% gain" },
          ],
        };
        if (!opts.validate(v)) throw new Error("bad");
        return v as T;
      },
    );
    const streamComplete = vi.fn(async () => "not json at all");

    const out = await rewriteBlock(scored(), profile, persona, [], 200, {
      llmJson: llmJson as never,
      streamComplete,
    });

    expect(streamComplete).toHaveBeenCalled();
    expect(llmJson).toHaveBeenCalled();
    expect(out.bullets[0]!.text).toContain("40%");
  });
});
