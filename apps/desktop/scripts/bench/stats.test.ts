import { describe, expect, it } from "vitest";
import { cargoBenchArgs } from "./cargo-args";
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

describe("cargo bench argv", () => {
  it("targets only baseline, and puts --smoke after --", () => {
    const full = cargoBenchArgs("apps/desktop/src-tauri/Cargo.toml", false);
    expect(full).toEqual([
      "bench",
      "--manifest-path",
      "apps/desktop/src-tauri/Cargo.toml",
      "--bench",
      "baseline",
    ]);
    expect(full).not.toContain("--lib");
    expect(full).not.toContain("--smoke");

    const smoke = cargoBenchArgs("apps/desktop/src-tauri/Cargo.toml", true);
    expect(smoke.slice(0, 5)).toEqual(full);
    expect(smoke.indexOf("--")).toBeLessThan(smoke.indexOf("--smoke"));
    expect(smoke.at(-2)).toBe("--");
    expect(smoke.at(-1)).toBe("--smoke");
    expect(smoke).not.toContain("--lib");
  });
});
