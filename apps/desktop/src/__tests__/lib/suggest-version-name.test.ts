import { describe, it, expect } from "vitest";
import { suggestVersionName } from "@/lib/variant-status";

describe("suggestVersionName", () => {
  it("uses the first short title line", () => {
    expect(
      suggestVersionName("Senior Product Manager\nWe are looking for…"),
    ).toBe("Senior Product Manager");
  });

  it("combines an explicit org label with the title", () => {
    const jd = "Staff Engineer\nCompany: Acme Robotics\nYou will build…";
    expect(suggestVersionName(jd)).toBe("Acme Robotics — Staff Engineer");
  });

  it("skips long sentence-like first lines for a better title", () => {
    const jd =
      "We are a fast-growing startup seeking talented people to join us.\nData Scientist\n";
    expect(suggestVersionName(jd)).toBe("Data Scientist");
  });

  it("returns empty for empty input", () => {
    expect(suggestVersionName("   ")).toBe("");
  });
});
