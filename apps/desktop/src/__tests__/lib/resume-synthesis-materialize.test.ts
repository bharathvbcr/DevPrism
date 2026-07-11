import { describe, expect, it } from "vitest";
import {
  slugFromJd,
  slugFromVersionName,
  templateDisplayName,
  versionNameFromJd,
} from "@/lib/resume-synthesis/materialize";

describe("slugFromJd", () => {
  it("slugifies a role title", () => {
    expect(slugFromJd("Senior ML Engineer — Acme Corp")).toBe(
      "senior-ml-engineer-acme-corp",
    );
  });

  it("uses the first non-empty line", () => {
    expect(slugFromJd("\n\nStaff Scientist\nMore text")).toBe(
      "staff-scientist",
    );
  });

  it("falls back when empty", () => {
    expect(slugFromJd("   ")).toBe("resume");
  });

  it("truncates long titles", () => {
    const long = "a".repeat(80);
    expect(slugFromJd(long).length).toBeLessThanOrEqual(48);
  });
});

describe("slugFromVersionName", () => {
  it("slugifies a JD-style title", () => {
    expect(slugFromVersionName("Acme — ML Eng")).toBe("acme-ml-eng");
  });

  it("falls back when empty", () => {
    expect(slugFromVersionName("   ")).toBe("tailored-resume");
  });
});

describe("templateDisplayName", () => {
  it("labels the ATS template", () => {
    expect(templateDisplayName("ats-single-column")).toBe("ATS single column");
  });
});

describe("versionNameFromJd", () => {
  it("uses suggestVersionName when JD has a title line", () => {
    expect(versionNameFromJd("Staff Engineer\nWe need…")).toBe(
      "Staff Engineer",
    );
  });

  it("falls back to roleTitle", () => {
    expect(versionNameFromJd("   ", "ML Engineer")).toBe("ML Engineer");
  });
});
