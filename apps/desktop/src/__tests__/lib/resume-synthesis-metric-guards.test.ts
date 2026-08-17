import { describe, expect, it } from "vitest";
import { metricPreservedInText } from "@/lib/resume-synthesis/rewrite";

/**
 * These pin the boundary guards added alongside the Rust port in
 * `src-tauri/src/career_match/metrics.rs`. A 770-pair differential between the
 * two implementations must stay at zero divergences.
 */
describe("metricPreservedInText boundary guards", () => {
  it("does not accept a longer number that merely contains the metric", () => {
    expect(metricPreservedInText("25%", "improved by 125%")).toBe(false);
    expect(metricPreservedInText("25%", "improved by 0.25%")).toBe(false);
    expect(metricPreservedInText("5x", "delivered 15x speedup")).toBe(false);
    expect(metricPreservedInText("1.5", "raised score to 1.55")).toBe(false);
    expect(metricPreservedInText("0.94", "raised success to 0.945")).toBe(
      false,
    );
    expect(metricPreservedInText("10,000", "processed 110,000 rows")).toBe(
      false,
    );
    expect(metricPreservedInText("10,000", "processed 10,000,000 rows")).toBe(
      false,
    );
  });

  it("does not accept a partial magnitude group", () => {
    expect(metricPreservedInText("$1.2M", "generated 1,200,000,000")).toBe(
      false,
    );
    expect(metricPreservedInText("$100K", "saved 2,100,000 dollars")).toBe(
      false,
    );
    expect(
      metricPreservedInText("$1.2M", "generated 1,200,000 in revenue"),
    ).toBe(true);
  });

  it("does not treat a decimal point or a letter as a numeric boundary", () => {
    expect(metricPreservedInText("5%", "changed by 5.5%")).toBe(false);
    expect(metricPreservedInText("25", "reduced by 0.25 points")).toBe(false);
    expect(metricPreservedInText("2", "shipped v2.4 of the API")).toBe(false);
    expect(metricPreservedInText("5", "ranked 5th in the org")).toBe(false);
    expect(metricPreservedInText("5", "ticket ABC5 resolved")).toBe(false);
    expect(metricPreservedInText("5", "in Q5 planning")).toBe(false);
  });

  it("only applies the one-decimal tolerance when it is lossless", () => {
    expect(metricPreservedInText("25%", "improved by 25.0%")).toBe(true);
    expect(metricPreservedInText("0.25%", "reduced by 0.2%")).toBe(false);
    expect(metricPreservedInText("0.25%", "reduced by 0.3%")).toBe(false);
    // Regression: an unescaped "1.5" made '.' a regex wildcard.
    expect(metricPreservedInText("1.5%", "improved by 125%")).toBe(false);
  });

  it("still accepts genuine matches and synonyms", () => {
    expect(metricPreservedInText("25%", "improved by 25%")).toBe(true);
    expect(metricPreservedInText("25%", "improved by 25 percent")).toBe(true);
    expect(metricPreservedInText("5x", "a 5-fold increase")).toBe(true);
    expect(metricPreservedInText("5", "shipped 5 features")).toBe(true);
    expect(metricPreservedInText("3", "a team of three")).toBe(true);
    expect(metricPreservedInText("10,000", "processed 10k rows")).toBe(true);
    expect(metricPreservedInText("1.61x", "delivered 1.61x speedup")).toBe(
      true,
    );
  });
});
