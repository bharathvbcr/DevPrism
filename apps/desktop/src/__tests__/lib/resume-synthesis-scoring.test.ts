import { describe, expect, it } from "vitest";
import type { ExperienceBlock, Persona } from "@/lib/career/types";
import {
  combineScore,
  DEFAULT_WEIGHTS,
  hybridScore,
  personaAffinity,
  recencyDecay,
  renormalizeWeights,
  seniorityFit,
  skillOverlap,
  skillsMatch,
  textCoversSkill,
  weightsForFacets,
} from "@/lib/resume-synthesis/scoring";
import type { JDProfile, JdFacets } from "@/lib/resume-synthesis/types";

function block(partial: Partial<ExperienceBlock> = {}): ExperienceBlock {
  return {
    id: "exp_1",
    kind: "experience",
    title: "ML Engineer",
    org: "Acme",
    dateRange: { start: "2022-01", end: null },
    personas: ["ai"],
    domains: ["mlops"],
    skills: [
      { name: "Python", level: 5 },
      { name: "PyTorch", level: 4 },
    ],
    seniorityLevel: "senior",
    bullets: [],
    facts: [],
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...partial,
  };
}

const persona: Persona = {
  id: "ai",
  label: "AI",
  skillWeights: { Python: 1.2, PyTorch: 1.5 },
  defaultTemplateId: "ats-single-column",
  sectionOrder: ["experience", "projects", "skills", "education"],
  toneDirective: "technical, metrics-driven",
};

const profile: JDProfile = {
  roleTitle: "Senior ML Engineer",
  seniority: "senior",
  mustHaveSkills: ["Python", "PyTorch"],
  niceToHaveSkills: ["Kubernetes"],
  domains: ["mlops"],
  atsKeywords: ["Python", "PyTorch", "MLOps"],
  toneSignals: ["metrics-driven"],
  responsibilitiesText: "Build ML systems",
  qualificationsText: "Python and PyTorch",
};

describe("renormalizeWeights", () => {
  it("zeros embedding and renormalizes remaining to sum 1", () => {
    const w = renormalizeWeights({ ...DEFAULT_WEIGHTS, embedding: 0 });
    const sum = w.embedding + w.skills + w.persona + w.recency + w.seniority;
    expect(w.embedding).toBe(0);
    expect(sum).toBeCloseTo(1, 8);
    expect(w.skills).toBeCloseTo(0.3 / 0.6, 8);
  });
});

describe("weightsForFacets", () => {
  it("disables embedding when semantic matching is off", () => {
    const facets: JdFacets = {
      full: null,
      responsibilities: null,
      qualifications: null,
      semanticMatchingDisabled: true,
    };
    expect(weightsForFacets(facets).embedding).toBe(0);
  });
});

describe("skillOverlap", () => {
  it("weights must-have skills 2x", () => {
    const full = skillOverlap(block().skills, ["Python", "PyTorch"], []);
    const half = skillOverlap(block().skills, ["Python", "Rust"], []);
    expect(full).toBeGreaterThan(half);
    expect(full).toBeGreaterThan(0.9);
  });

  it("matches multi-token skills by tokens, not bare substrings", () => {
    expect(
      skillOverlap([{ name: "PyTorch Lightning", level: 3 }], ["pytorch"], []),
    ).toBeGreaterThan(0);
    // Java must not match JavaScript
    expect(skillOverlap([{ name: "JavaScript", level: 3 }], ["Java"], [])).toBe(
      0,
    );
    // Go must not match Cargo
    expect(skillOverlap([{ name: "Cargo", level: 3 }], ["Go"], [])).toBe(0);
  });
});

describe("skillsMatch / textCoversSkill", () => {
  it("rejects Java⊂JavaScript and Go⊂Cargo", () => {
    expect(skillsMatch("Java", "JavaScript")).toBe(false);
    expect(textCoversSkill("Built tooling with Cargo", "Go")).toBe(false);
    expect(textCoversSkill("Shipped Go microservices", "Go")).toBe(true);
    expect(textCoversSkill("Used Java for backends", "Java")).toBe(true);
    expect(textCoversSkill("Used JavaScript for UI", "Java")).toBe(false);
  });
});

describe("personaAffinity / seniorityFit / recencyDecay", () => {
  it("scores persona match high", () => {
    expect(personaAffinity(["ai"], "ai")).toBe(1);
    expect(personaAffinity(["mgmt"], "ai")).toBe(0.15);
  });

  it("scores exact seniority fit as 1", () => {
    expect(seniorityFit("senior", "senior")).toBe(1);
    expect(seniorityFit("ic", "director")).toBeLessThan(0.5);
  });

  it("decays older roles", () => {
    const now = new Date("2026-01-01");
    const recent = recencyDecay({ start: "2024-01", end: null }, now);
    const old = recencyDecay({ start: "2010-01", end: "2012-01" }, now);
    expect(recent).toBeGreaterThan(old);
  });
});

describe("hybridScore determinism", () => {
  it("returns identical scores for identical inputs", () => {
    const now = new Date("2026-06-01");
    const a = hybridScore(block(), profile, persona, 0.8, DEFAULT_WEIGHTS, now);
    const b = hybridScore(block(), profile, persona, 0.8, DEFAULT_WEIGHTS, now);
    expect(a.score).toBe(b.score);
    expect(a.components).toEqual(b.components);
  });

  it("combineScore matches weighted sum", () => {
    const components = {
      embedding: 1,
      skills: 0.5,
      persona: 1,
      recency: 0.5,
      seniority: 1,
    };
    const expected = 0.4 * 1 + 0.3 * 0.5 + 0.15 * 1 + 0.1 * 0.5 + 0.05 * 1;
    expect(combineScore(components, DEFAULT_WEIGHTS)).toBeCloseTo(expected, 8);
  });

  it("tag-only path raises skill influence vs full weights", () => {
    const now = new Date("2026-06-01");
    const full = hybridScore(
      block(),
      profile,
      persona,
      0,
      DEFAULT_WEIGHTS,
      now,
    );
    const tag = hybridScore(
      block(),
      profile,
      persona,
      0,
      weightsForFacets({
        full: null,
        responsibilities: null,
        qualifications: null,
        semanticMatchingDisabled: true,
      }),
      now,
    );
    // Same embedding 0, but tag-only renormalizes → skills weigh more
    expect(tag.score).toBeGreaterThan(full.score);
  });
});
