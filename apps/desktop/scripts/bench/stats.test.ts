import { describe, expect, it } from "vitest";
import { summarize, valueOrThrow } from "./stats";

describe("bench summary", () => {
  it("reports the minimum and the spread, not the mean", () => {
    const summary = summarize([5, 1, 3]);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(5);
    expect(summary.spread).toBe(4);
    expect(summary.n).toBe(3);
    const mean = (5 + 1 + 3) / 3;
    expect(summary.min).not.toBe(mean);
  });

  it("refuses to turn a missing run into zero", () => {
    expect(() => summarize([])).toThrow(/empty samples/);
    expect(() => valueOrThrow("not_measured", undefined)).toThrow(
      /did not run/,
    );
    expect(() => valueOrThrow("not_measured", 0)).toThrow(/did not run/);
    expect(valueOrThrow("measured", 0)).toBe(0);
  });

  it("rejects a non-finite sample", () => {
    expect(() => summarize([1, Number.NaN])).toThrow(/non-finite/);
  });
});
