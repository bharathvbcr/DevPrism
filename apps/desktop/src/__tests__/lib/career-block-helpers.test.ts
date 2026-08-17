import { describe, expect, it } from "vitest";
import {
  clampSkillLevel,
  computeEmbeddingText,
  createEmptyBlock,
  createEmptyPersona,
  isSeededPersonaId,
  newBlockFact,
  newSkillTag,
  SEEDED_PERSONA_IDS,
} from "@/lib/career/block-helpers";

describe("createEmptyPersona", () => {
  it("defaults to the Typst single-column template", () => {
    const persona = createEmptyPersona();
    expect(persona.defaultTemplateId).toBe("typst-ats-single-column");
  });

  it("allows overrides", () => {
    const persona = createEmptyPersona({
      label: "Custom",
      defaultTemplateId: "other",
    });
    expect(persona.label).toBe("Custom");
    expect(persona.defaultTemplateId).toBe("other");
  });
});

describe("isSeededPersonaId", () => {
  it("recognizes built-in personas", () => {
    for (const id of SEEDED_PERSONA_IDS) {
      expect(isSeededPersonaId(id)).toBe(true);
    }
    expect(isSeededPersonaId("persona_abc")).toBe(false);
  });
});

describe("newSkillTag / clampSkillLevel", () => {
  it("defaults level to 3", () => {
    expect(newSkillTag("rust")).toEqual({ name: "rust", level: 3 });
  });

  it("clamps level to 1–5", () => {
    expect(clampSkillLevel(0)).toBe(1);
    expect(clampSkillLevel(3.4)).toBe(3);
    expect(clampSkillLevel(3.6)).toBe(4);
    expect(clampSkillLevel(99)).toBe(5);
  });
});

describe("newBlockFact", () => {
  it("defaults to manual source with empty skills/metrics", () => {
    const fact = newBlockFact("Shipped feature");
    expect(fact.id).toMatch(/^fct_/);
    expect(fact.text).toBe("Shipped feature");
    expect(fact.skills).toEqual([]);
    expect(fact.metrics).toEqual([]);
    expect(fact.source).toBe("manual");
    expect(fact.createdAt).toBeTruthy();
  });
});

describe("createEmptyBlock", () => {
  it("initializes an empty facts pool", () => {
    expect(createEmptyBlock().facts).toEqual([]);
  });
});

describe("computeEmbeddingText", () => {
  it("joins title, org, domains, skills, canonical bullets, and facts", () => {
    const block = createEmptyBlock({
      title: "ML Eng",
      org: "Acme",
      domains: ["mlops"],
      skills: [{ name: "python", level: 4 }],
      bullets: [
        {
          id: "b1",
          canonical: "Built pipelines",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
      ],
      facts: [
        {
          id: "fct_1",
          text: "Reduced p99 latency 40%",
          skills: ["latency"],
          metrics: [{ value: "40%", kind: "improvement" }],
          source: "manual",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    const text = computeEmbeddingText(block);
    expect(text).toContain("ML Eng");
    expect(text).toContain("Acme");
    expect(text).toContain("mlops");
    expect(text).toContain("python");
    expect(text).toContain("Built pipelines");
    expect(text).toContain("Reduced p99 latency 40%");
  });
});
