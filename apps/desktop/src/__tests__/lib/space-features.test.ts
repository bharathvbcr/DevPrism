import { describe, expect, it } from "vitest";
import {
  inferSpaceKind,
  inferSpaceKindFromProjectPath,
  spaceFeatureConfig,
  bundledSkillsForKind,
} from "@/lib/space-features";

describe("inferSpaceKind", () => {
  it("returns explicit kind when set", () => {
    expect(
      inferSpaceKind({
        name: "Anything",
        description: "",
        icon: null,
        kind: "manuscript",
      }),
    ).toBe("manuscript");
  });

  it("infers resume from name", () => {
    expect(
      inferSpaceKind({
        name: "Job Applications",
        description: "",
        icon: null,
      }),
    ).toBe("resume");
  });

  it("infers manuscript from description", () => {
    expect(
      inferSpaceKind({
        name: "PhD",
        description: "Conference papers and journal manuscripts",
        icon: null,
      }),
    ).toBe("manuscript");
  });

  it("infers statements from keywords", () => {
    expect(
      inferSpaceKind({
        name: "Grad school",
        description: "Personal statements and SOP drafts",
        icon: null,
      }),
    ).toBe("statements");
  });
});

describe("spaceFeatureConfig", () => {
  it("enables tailored versions for resume spaces", () => {
    const config = spaceFeatureConfig({
      name: "Jobs",
      description: "",
      icon: "briefcase",
      kind: "resume",
    });
    expect(config.variants).toBe(true);
    expect(config.variantLabels.createAction).toContain("JD");
  });

  it("exposes manuscript quick actions", () => {
    const config = spaceFeatureConfig({
      name: "Papers",
      description: "",
      icon: "flask",
      kind: "manuscript",
    });
    expect(config.quickActions.length).toBeGreaterThan(0);
    expect(config.variantLabels.createAction).toContain("submission");
  });

  it("exposes statement tailoring labels", () => {
    const config = spaceFeatureConfig({
      name: "SOPs",
      description: "",
      icon: "graduation-cap",
      kind: "statements",
    });
    expect(config.variantLabels.createAction).toContain("prompt");
  });

  it("infers kind from project folder name", () => {
    expect(inferSpaceKindFromProjectPath("C:\\Users\\me\\my-resume")).toBe(
      "resume",
    );
  });

  it("maps resume spaces to resume skills", () => {
    expect(bundledSkillsForKind("resume")).toContain("resume-cv");
  });

  it("maps statement spaces to statement-authoring skill", () => {
    expect(bundledSkillsForKind("statements")).toContain("statement-authoring");
    expect(bundledSkillsForKind("statements")).not.toContain("resume-cv");
  });
});
