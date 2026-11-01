/** Default delay between the last edit and an auto-triggered recompile for LaTeX. */
export const AUTO_COMPILE_DEBOUNCE_LATEX_MS = 1200;

/** Optimized delay for warm in-process Typst compilation (100ms–150ms window). */
export const AUTO_COMPILE_DEBOUNCE_TYPST_MS = 120;

/** Absolute safe minimum debounce floor to avoid UI thread starvation. */
export const AUTO_COMPILE_DEBOUNCE_MIN_MS = 50;

/** Default delay (retained for backward compatibility). */
export const AUTO_COMPILE_DEBOUNCE_MS = AUTO_COMPILE_DEBOUNCE_LATEX_MS;

/**
 * Resolve the adaptive debounce interval in milliseconds based on target engine.
 * Negative or sub-minimum values are clamped to AUTO_COMPILE_DEBOUNCE_MIN_MS (50ms).
 */
export function getAutoCompileDebounceMs(
  engine?: "typst" | "latex" | null,
  overrideMs?: number,
): number {
  if (overrideMs != null) {
    return Math.max(overrideMs, AUTO_COMPILE_DEBOUNCE_MIN_MS);
  }
  return engine === "typst"
    ? AUTO_COMPILE_DEBOUNCE_TYPST_MS
    : AUTO_COMPILE_DEBOUNCE_LATEX_MS;
}

export interface AutoCompileSync {
  /** Whether auto-compile is enabled. */
  enabled: boolean;
  /** Whether the project is ready to compile (initialized + has a root). */
  ready: boolean;
  /** Monotonic counter that advances on every document edit. */
  generation: number;
  /** Target engine ("typst" | "latex") to dynamically adjust debounce interval. */
  engine?: "typst" | "latex";
  /** Explicit debounce override in milliseconds. Clamped to minimum 50ms. */
  debounceMs?: number;
}

export interface AutoCompileScheduler {
  /**
   * Reconcile the scheduler with the latest state. Drive this from a React
   * effect on every change to enabled/ready/generation/engine.
   *
   * Behavior:
   * - Disabled → cancels any pending compile and clears the baseline.
   * - Not ready → no-op (a pending compile, if any, is left alone; the compile
   *   callback is expected to guard against a missing project itself).
   * - First call while enabled+ready → records the current generation as a
   *   baseline so enabling does not compile without an edit.
   * - Generation advanced past the baseline → (re)arms a debounced compile.
   *   Rapid advances coalesce into a single compile after the burst settles.
   */
  sync(state: AutoCompileSync): void;
  /** Cancel any pending compile. Call on unmount. */
  dispose(): void;
}

/**
 * Create an adaptive auto-compile scheduler. Framework-agnostic so the debounce/baseline/
 * coalesce behavior can be unit-tested without mounting a component.
 */
export function createAutoCompileScheduler(
  compile: () => void,
  initialDebounceMs: number = AUTO_COMPILE_DEBOUNCE_MS,
): AutoCompileScheduler {
  let baseline: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentDebounce = Math.max(
    initialDebounceMs,
    AUTO_COMPILE_DEBOUNCE_MIN_MS,
  );

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    sync({ enabled, ready, generation, engine, debounceMs: overrideDebounce }) {
      if (!enabled) {
        clear();
        baseline = null;
        return;
      }
      if (!ready) return;

      // Update debounce dynamically if engine or override is specified
      if (overrideDebounce !== undefined) {
        currentDebounce = Math.max(
          overrideDebounce,
          AUTO_COMPILE_DEBOUNCE_MIN_MS,
        );
      } else if (engine) {
        currentDebounce = getAutoCompileDebounceMs(engine);
      }

      // Establish a baseline on enable/first run so we don't compile without edits.
      if (baseline === null) {
        baseline = generation;
        return;
      }
      if (generation === baseline) return;
      baseline = generation;

      // Re-arm the debounce: rapid edits collapse into a single compile.
      clear();
      timer = setTimeout(() => {
        timer = null;
        compile();
      }, currentDebounce);
    },
    dispose() {
      clear();
    },
  };
}
