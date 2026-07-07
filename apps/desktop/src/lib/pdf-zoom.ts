/**
 * Pure zoom / fit-to-page math for the PDF preview toolbar.
 *
 * These helpers exist to make the PDF preview *provably* unable to re-enter the
 * infinite re-render loop (React error #185) that fit-to-width/height once
 * caused:
 *
 *   fit effect computes scale from container size
 *     -> new scale re-renders pages, toggling a scrollbar
 *       -> the scrollbar changes the container's measured width
 *         -> ResizeObserver reports a new size -> fit effect recomputes -> ...
 *
 * The loop is broken by two contracts, both enforced by the unit tests in
 * pdf-zoom.test.ts:
 *
 *   1. `computeFitScale` is deterministic and clamped, so a stable container
 *      (the toolbar reserves the scrollbar gutter via `scrollbar-gutter:stable`)
 *      yields a fixed point in a single step.
 *   2. `settleScale` / `settleSize` return the *previous* value when the change
 *      is below a perceptible threshold. Handing that back to `setState` lets
 *      React bail out of the update instead of committing another render, so
 *      sub-pixel ResizeObserver jitter can never drive a re-render cascade.
 *
 * Keeping this inline in the component is what let the loop regress before; keep
 * it here so the guards stay tested.
 */

export type FitMode = "fit-width" | "fit-height" | null;

export interface Size {
  width: number;
  height: number;
}

/** Zoom bounds shared by the fit computation, the +/- buttons and the preset select. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

/** Padding subtracted from the container before fitting (p-4 => 16px each side). */
export const FIT_PADDING = 32;

/** Two zoom levels within this delta are treated as identical (no re-render). */
export const SCALE_EPSILON = 0.001;

/** Two container/page dimensions within this many px are treated as identical. */
export const SIZE_EPSILON = 1;

export const ZOOM_OPTIONS = [
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
  { value: "4", label: "400%" },
];

/** Clamp a scale into the supported zoom range. */
export function clampScale(scale: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
}

/**
 * Clamped fit scale for the current mode, or `null` when there is nothing to
 * fit (no active fit mode, sizes not measured yet, or a degenerate page size).
 * Returning `null` lets the caller skip the state update entirely.
 */
export function computeFitScale(
  fitMode: FitMode,
  container: Size | null,
  page: Size | null,
): number | null {
  if (!fitMode || !container || !page) return null;
  const raw =
    fitMode === "fit-width"
      ? (container.width - FIT_PADDING) / page.width
      : (container.height - FIT_PADDING) / page.height;
  if (!Number.isFinite(raw)) return null;
  return clampScale(raw);
}

/**
 * Return `prev` when `next` is within {@link SCALE_EPSILON}, else `next`.
 * Passing the result to `setScale` makes a sub-threshold change a no-op, so a
 * fit recompute that lands on (essentially) the current scale cannot schedule
 * another render.
 */
export function settleScale(
  prev: number,
  next: number,
  epsilon = SCALE_EPSILON,
): number {
  return Math.abs(prev - next) < epsilon ? prev : next;
}

/**
 * Return the *previous* size object when both (rounded) dimensions are within
 * {@link SIZE_EPSILON}, else a fresh rounded size. Preserving the reference lets
 * React bail out of `setState`, so sub-pixel ResizeObserver noise can't loop.
 */
export function settleSize(
  prev: Size | null,
  width: number,
  height: number,
  epsilon = SIZE_EPSILON,
): Size {
  const w = Math.round(width);
  const h = Math.round(height);
  if (
    prev &&
    Math.abs(prev.width - w) < epsilon &&
    Math.abs(prev.height - h) < epsilon
  ) {
    return prev;
  }
  return { width: w, height: h };
}

/** Radix Select requires `value` to match a SelectItem — snap to nearest preset. */
export function zoomSelectValue(fitMode: FitMode, scale: number): string {
  if (fitMode) return fitMode;
  const exact = ZOOM_OPTIONS.find(
    (o) => Math.abs(Number(o.value) - scale) < SCALE_EPSILON,
  );
  if (exact) return exact.value;
  return ZOOM_OPTIONS.reduce((best, opt) =>
    Math.abs(Number(opt.value) - scale) < Math.abs(Number(best.value) - scale)
      ? opt
      : best,
  ).value;
}
