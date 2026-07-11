import { describe, expect, it } from "vitest";
import {
  clampSkillLevel,
  computeEmbeddingText,
  createEmptyBlock,
  createEmptyPersona,
  isSeededPersonaId,
  newSkillTag,
  SEEDED_PERSONA_IDS,
} from "@/lib/career/block-helpers";

describe("createEmptyPersona", () => {
  it("defaults to ats-single-column template id", () => {
    const persona = createEmptyPersona();
    expect(persona.defaultTemplateId).toBe("ats-single-column");
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

describe("computeEmbeddingText", () => {
  it("joins title, org, domains, skills, and canonical bullets", () => {
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
    });
    const text = computeEmbeddingText(block);
    expect(text).toContain("ML Eng");
    expect(text).toContain("Acme");
    expect(text).toContain("mlops");
    expect(text).toContain("python");
    expect(text).toContain("Built pipelines");
  });
});
