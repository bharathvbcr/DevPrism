import { describe, expect, it } from "vitest";
import { deriveOwner } from "@/stores/variants-store";
import {
  inferSpaceKindFromProjectPath,
  spaceFeatureConfig,
} from "@/lib/space-features";

describe("useSpaceFeatures resolution (logic)", () => {
  it("infers resume features for an unassigned resume project", () => {
    const owner = "C:\\Users\\me\\Documents\\my-resume";
    const kind = inferSpaceKindFromProjectPath(owner);
    const config = spaceFeatureConfig({
      name: owner.split(/[\\/]/).pop() ?? owner,
      description: "",
      icon: null,
      kind,
    });
    expect(kind).toBe("resume");
    expect(config.variants).toBe(true);
    expect(config.variantLabels.createAction).toContain("JD");
  });

  it("derives owner from variant paths for space lookup", () => {
    const owner = "C:\\Users\\me\\resume";
    const variant = `${owner}\\.prism\\variants\\acme`;
    expect(deriveOwner(variant).owner).toBe(owner);
  });
});
