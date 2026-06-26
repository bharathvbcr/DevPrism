/** Default delay between the last edit and an auto-triggered recompile. */
export const AUTO_COMPILE_DEBOUNCE_MS = 1200;

export interface AutoCompileSync {
  /** Whether auto-compile is enabled. */
  enabled: boolean;
  /** Whether the project is ready to compile (initialized + has a root). */
  ready: boolean;
  /** Monotonic counter that advances on every document edit. */
  generation: number;
}

export interface AutoCompileScheduler {
  /**
   * Reconcile the scheduler with the latest state. Drive this from a React
   * effect on every change to enabled/ready/generation.
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
 * Create an auto-compile scheduler. Framework-agnostic so the debounce/baseline/
 * coalesce behavior can be unit-tested without mounting a component.
 */
export function createAutoCompileScheduler(
  compile: () => void,
  debounceMs: number = AUTO_COMPILE_DEBOUNCE_MS,
): AutoCompileScheduler {
  let baseline: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    sync({ enabled, ready, generation }) {
      if (!enabled) {
        clear();
        baseline = null;
        return;
      }
      if (!ready) return;
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
      }, debounceMs);
    },
    dispose() {
      clear();
    },
  };
}
