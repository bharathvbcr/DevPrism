/**
 * Thin wrapper over `aiComplete` + salvage JSON parse + hand validators.
 * One reprompt on validation failure (no zod).
 * Honors AbortSignal and optional streaming for live previews.
 */

import { aiComplete, aiCompleteStream } from "@/lib/ai-assist";

/** Best-effort JSON parse (fences / leading prose), matching ai-assist salvage style. */
export function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  if (direct !== null) return direct;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== null) return fenced;
  }
  const arrStart = trimmed.indexOf("[");
  const objStart = trimmed.indexOf("{");
  const idx =
    arrStart >= 0 && (objStart < 0 || arrStart < objStart)
      ? arrStart
      : objStart;
  if (idx >= 0) {
    const sliced = tryParse(trimmed.slice(idx));
    if (sliced !== null) return sliced;
  }
  return null;
}

/** Loose object parse — returns `{}` when salvage fails. */
export function parseJsonObjectLoose<T extends object>(raw: string): T {
  const parsed = tryParseJson(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as T;
  }
  return {} as T;
}

export class LlmJsonError extends Error {
  readonly raw: string;
  readonly label: string;

  constructor(message: string, raw: string, label: string) {
    super(message);
    this.name = "LlmJsonError";
    this.raw = raw;
    this.label = label;
  }
}

export type LlmStreamComplete = (
  options: {
    system: string;
    prompt: string;
    temperature?: number;
    signal?: AbortSignal;
  },
  onChunk: (fragment: string) => void,
) => Promise<string>;

export interface LlmJsonOptions<T> {
  system: string;
  prompt: string;
  temperature?: number;
  /** Hand-written schema check (no zod). */
  validate: (value: unknown) => value is T;
  label?: string;
  signal?: AbortSignal;
  /** Prefer streaming when set (JD analysis / critic previews). */
  streamComplete?: LlmStreamComplete;
  /** Live token/text preview while streaming. */
  onStreamPreview?: (preview: string, raw: string) => void;
  /** Injected for tests. */
  complete?: typeof aiComplete;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("LLM request cancelled", "AbortError");
}

function previewFromRaw(raw: string, maxLen = 280): string {
  const joined = raw.replace(/\s+/g, " ").trim();
  if (joined.length <= maxLen) return joined;
  return `…${joined.slice(-maxLen)}`;
}

/**
 * Call `aiComplete` with `format: "json"`, salvage-parse, validate.
 * On failure, one reprompt that includes the parse/validation error.
 * When `streamComplete` is provided, tries streaming first for live previews.
 */
export async function llmJson<T>(options: LlmJsonOptions<T>): Promise<T> {
  const complete = options.complete ?? aiComplete;
  const label = options.label ?? "llmJson";
  const temperature = options.temperature ?? 0.1;
  const signal = options.signal;

  const runOnce = async (
    extra?: string,
  ): Promise<{ value: unknown; raw: string }> => {
    throwIfAborted(signal);
    const prompt = extra
      ? `${options.prompt}\n\nPrevious output was invalid. Fix and return ONLY valid JSON.\nError: ${extra}`
      : options.prompt;

    let raw = "";
    if (options.streamComplete) {
      try {
        let acc = "";
        const full = await options.streamComplete(
          {
            system: options.system,
            prompt,
            temperature,
            signal,
          },
          (fragment) => {
            throwIfAborted(signal);
            acc += fragment;
            options.onStreamPreview?.(previewFromRaw(acc), acc);
          },
        );
        raw = full || acc;
        if (raw && raw !== acc) {
          options.onStreamPreview?.(previewFromRaw(raw), raw);
        }
      } catch (err) {
        throwIfAborted(signal);
        // Fall through to non-streaming complete.
        if (
          err &&
          typeof err === "object" &&
          (err as { name?: string }).name === "AbortError"
        ) {
          throw err;
        }
        raw = "";
      }
    }

    if (!raw) {
      throwIfAborted(signal);
      raw = await complete({
        system: options.system,
        prompt,
        temperature,
        format: "json",
        signal,
      });
    }

    throwIfAborted(signal);
    return { value: tryParseJson(raw), raw };
  };

  let { value, raw } = await runOnce();
  if (options.validate(value)) return value;

  throwIfAborted(signal);
  const errMsg =
    value == null
      ? "Could not parse JSON from model output"
      : "JSON failed schema validation";
  ({ value, raw } = await runOnce(errMsg));
  if (options.validate(value)) return value;

  throwIfAborted(signal);
  throw new LlmJsonError(`${label}: ${errMsg} after reprompt`, raw, label);
}

/** Default streaming helper used by synthesis when deps don't override. */
export async function defaultStreamComplete(
  options: {
    system: string;
    prompt: string;
    temperature?: number;
    signal?: AbortSignal;
  },
  onChunk: (fragment: string) => void,
): Promise<string> {
  return aiCompleteStream(
    {
      system: options.system,
      prompt: options.prompt,
      temperature: options.temperature,
      skipSemanticLayer: true,
      signal: options.signal,
    },
    onChunk,
  );
}
