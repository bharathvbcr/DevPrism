import { describe, expect, it } from "vitest";
import { textCoversSkill } from "@/lib/resume-synthesis/scoring";

describe("textCoversSkill boundary fixes", () => {
  it("matches a skill that ends a sentence", () => {
    expect(
      textCoversSkill("Deep experience with Kubernetes.", "Kubernetes"),
    ).toBe(true);
    expect(textCoversSkill("We chose Go.", "Go")).toBe(true);
    expect(textCoversSkill("Expert in C++.", "C++")).toBe(true);
    expect(textCoversSkill("Fluent in c#.", "C#")).toBe(true);
  });
  it("does not treat R&D as evidence of R", () => {
    expect(textCoversSkill("Led R&D initiatives", "R")).toBe(false);
    expect(textCoversSkill("R&D and AT&T", "D")).toBe(false);
  });
  it("still matches R as a standalone token", () => {
    expect(textCoversSkill("Proficient in R and Python", "R")).toBe(true);
    expect(textCoversSkill("Analysis in R.", "R")).toBe(true);
  });
  it("keeps the substring protections", () => {
    expect(textCoversSkill("mongodb cluster", "Go")).toBe(false);
    expect(textCoversSkill("Used JavaScript for UI", "Java")).toBe(false);
    expect(textCoversSkill("nodemon watcher", "Node.js")).toBe(false);
    expect(textCoversSkill("c++11 standard", "C++")).toBe(false);
    expect(textCoversSkill("Built tooling with Cargo", "Go")).toBe(false);
  });
  it("keeps alias expansion", () => {
    expect(textCoversSkill("golang services", "Go")).toBe(true);
    expect(textCoversSkill("k8s clusters", "kubernetes")).toBe(true);
    expect(textCoversSkill("machine learning pipelines", "ML")).toBe(true);
  });
});
