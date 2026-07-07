import { describe, expect, it } from "vitest";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampScale,
  computeFitScale,
  settleScale,
  settleSize,
  zoomSelectValue,
} from "@/lib/pdf-zoom";

describe("zoomSelectValue", () => {
  it("returns fit mode tokens unchanged", () => {
    expect(zoomSelectValue("fit-width", 1.5)).toBe("fit-width");
    expect(zoomSelectValue("fit-height", 0.5)).toBe("fit-height");
  });

  it("returns exact preset match for scale", () => {
    expect(zoomSelectValue(null, 1)).toBe("1");
    expect(zoomSelectValue(null, 1.25)).toBe("1.25");
  });

  it("snaps non-preset scale to nearest SelectItem value", () => {
    expect(zoomSelectValue(null, 1.073)).toBe("1");
    expect(zoomSelectValue(null, 1.12)).toBe("1");
    expect(zoomSelectValue(null, 1.875)).toBe("2");
  });
});

describe("clampScale", () => {
  it("clamps to the supported zoom range", () => {
    expect(clampScale(10)).toBe(ZOOM_MAX);
    expect(clampScale(0)).toBe(ZOOM_MIN);
    expect(clampScale(1.5)).toBe(1.5);
  });
});

describe("computeFitScale", () => {
  const page = { width: 612, height: 792 }; // US Letter at 72dpi

  it("returns null when there is nothing to fit", () => {
    expect(computeFitScale(null, { width: 800, height: 600 }, page)).toBeNull();
    expect(computeFitScale("fit-width", null, page)).toBeNull();
    expect(
      computeFitScale("fit-width", { width: 800, height: 600 }, null),
    ).toBeNull();
  });

  it("fits width using container width minus padding", () => {
    const scale = computeFitScale(
      "fit-width",
      { width: 800, height: 600 },
      page,
    );
    expect(scale).toBeCloseTo((800 - 32) / 612, 6);
  });

  it("fits height using container height minus padding", () => {
    const scale = computeFitScale(
      "fit-height",
      { width: 800, height: 600 },
      page,
    );
    expect(scale).toBeCloseTo((600 - 32) / 792, 6);
  });

  it("clamps the fit result into the zoom range", () => {
    // Tiny page in a huge container would overshoot ZOOM_MAX.
    const tiny = { width: 20, height: 20 };
    expect(
      computeFitScale("fit-width", { width: 4000, height: 4000 }, tiny),
    ).toBe(ZOOM_MAX);
    // Huge page in a tiny container would undershoot ZOOM_MIN.
    const huge = { width: 40000, height: 40000 };
    expect(
      computeFitScale("fit-width", { width: 100, height: 100 }, huge),
    ).toBe(ZOOM_MIN);
  });

  it("returns null for a degenerate (zero-width/height) page", () => {
    expect(
      computeFitScale(
        "fit-width",
        { width: 800, height: 600 },
        { width: 0, height: 0 },
      ),
    ).toBeNull();
  });
});

describe("settleScale (anti-loop guard)", () => {
  it("keeps the previous scale for a sub-threshold change", () => {
    // Same reference back => setState bails => no extra render.
    expect(settleScale(1.25, 1.2500001)).toBe(1.25);
  });

  it("adopts the new scale for a perceptible change", () => {
    expect(settleScale(1.25, 1.5)).toBe(1.5);
  });
});

describe("settleSize (anti-loop guard)", () => {
  it("rounds sizes to whole pixels", () => {
    expect(settleSize(null, 799.6, 600.4)).toEqual({ width: 800, height: 600 });
  });

  it("returns the SAME object reference for sub-pixel jitter", () => {
    const first = settleSize(null, 800, 600);
    // ResizeObserver noise within 1px must not produce a new object,
    // otherwise setState commits a render every observer callback.
    const jittered = settleSize(first, 800.4, 599.7);
    expect(jittered).toBe(first);
  });

  it("returns a new object once a dimension crosses the pixel threshold", () => {
    const first = settleSize(null, 800, 600);
    const grown = settleSize(first, 802, 600);
    expect(grown).not.toBe(first);
    expect(grown).toEqual({ width: 802, height: 600 });
  });
});

describe("fit-to-page loop cannot diverge (React #185 regression)", () => {
  // Models the historical loop: fit effect sets scale from the container, the
  // scale re-renders pages, and the container is re-measured. With the scrollbar
  // gutter reserved the container width is stable, so the iteration MUST reach a
  // fixed point that settleScale then pins. If a future change makes the scale
  // computation non-deterministic or removes the settle guard, this loops to the
  // cap and fails instead of hanging a browser.
  it("fit-width reaches a fixed point in one step", () => {
    const page = { width: 612, height: 792 };
    const container = { width: 800, height: 600 };
    let scale = 1;
    let iterations = 0;
    for (; iterations < 100; iterations++) {
      const next = computeFitScale("fit-width", container, page);
      const settled = settleScale(scale, next as number);
      if (settled === scale) break; // React would bail here → loop ends.
      scale = settled;
    }
    expect(iterations).toBeLessThan(2);
    expect(scale).toBeCloseTo((800 - 32) / 612, 6);
  });

  it("absorbs a burst of sub-pixel resize callbacks without churn", () => {
    let size = settleSize(null, 800, 600);
    const stable = size;
    for (const [w, h] of [
      [800.3, 599.8],
      [799.6, 600.2],
      [800.49, 600.49],
      [799.51, 599.51],
    ] as const) {
      size = settleSize(size, w, h);
    }
    // Every callback was within 1px → same reference throughout → zero renders.
    expect(size).toBe(stable);
  });
});
