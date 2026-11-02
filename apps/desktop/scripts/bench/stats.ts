/** Min-of-N summary. The mean is not a result this harness reports. */

export interface Summary {
  n: number;
  min: number;
  max: number;
  spread: number;
  samples: number[];
}

export function summarize(samples: readonly number[]): Summary {
  if (samples.length === 0) {
    throw new Error("empty samples are not a measurement");
  }
  let min = samples[0];
  let max = samples[0];
  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      throw new Error("a non-finite sample is not a measurement");
    }
    if (sample < min) min = sample;
    if (sample > max) max = sample;
  }
  return {
    n: samples.length,
    min,
    max,
    spread: max - min,
    samples: [...samples],
  };
}

/**
 * A run that did not happen must not become 0. A measured 0 is returned only
 * when the caller already classified the run as measured.
 */
export function valueOrThrow(
  status: string,
  value: number | undefined,
): number {
  if (status !== "measured" || value === undefined || !Number.isFinite(value)) {
    throw new Error("a measurement that did not run is not a number");
  }
  return value;
}

export function samplePlan(): { n: number; warmup: number; smoke: boolean } {
  const smoke = process.env.BENCH_SMOKE === "1";
  return { n: smoke ? 1 : 7, warmup: smoke ? 0 : 1, smoke };
}

export async function collectSamples(
  sample: () => number | Promise<number>,
): Promise<{ warmup: number[]; summary: Summary; smoke: boolean }> {
  const plan = samplePlan();
  const warmup: number[] = [];
  for (let i = 0; i < plan.warmup; i++) warmup.push(await sample());
  const samples: number[] = [];
  for (let i = 0; i < plan.n; i++) samples.push(await sample());
  return { warmup, summary: summarize(samples), smoke: plan.smoke };
}

export function measured(summary: Summary, warmup: number[], extra: object) {
  return {
    status: "measured" as const,
    n: summary.n,
    min: summary.min,
    max: summary.max,
    spread: summary.spread,
    samples: summary.samples,
    warmup_excluded: warmup.length,
    warmup,
    noise_floor: warmup.length > 0 && summary.n >= 2,
    ...extra,
  };
}

export function notMeasured(reason: string, extra?: object) {
  return { status: "not_measured" as const, reason, ...extra };
}
