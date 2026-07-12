import { aiComplete, canUseAiAssist } from "@/lib/ai-assist";
import { newBlockFact } from "./block-helpers";
import { tryParseJsonLoose } from "./extract-resume";
import type { BlockFact, BulletMetric } from "./types";

const DISTILL_FACTS_SYSTEM = `You structure raw career notes into discrete fact points for a resume knowledge pool.
Return ONLY JSON of the form:
{"facts":[{
  "text":string,
  "skills":string[],
  "metrics":[{"value":string,"kind":string}]
}]}
Rules:
- Each fact is one concrete, attributable detail (achievement, ownership, tool, scale, outcome).
- Prefer factual content present in the notes; do not invent employers, dates, or numbers.
- Extract metric strings verbatim into metrics[].value (e.g. "40%", "2M users", "$1.2M").
- Use metrics[].kind as a short label (e.g. "improvement", "scale", "metric") when clear; otherwise "metric".
- Tag relevant skill/tool names in skills[] (lowercase, short).
- Skip fluff, section headings, and near-duplicate points.
- Return ONLY JSON — no markdown fences, no commentary.`;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function asMetrics(value: unknown): BulletMetric[] {
  if (!Array.isArray(value)) return [];
  const out: BulletMetric[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) out.push({ value: trimmed, kind: "metric" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const metricValue =
      typeof row.value === "string"
        ? row.value.trim()
        : typeof row.metric === "string"
          ? row.metric.trim()
          : "";
    if (!metricValue) continue;
    const kind =
      typeof row.kind === "string" && row.kind.trim()
        ? row.kind.trim()
        : "metric";
    out.push({ value: metricValue, kind });
  }
  return out;
}

/** Validate/normalize LLM JSON into BlockFact[] (new ids, never persisted). */
export function parseDistilledFacts(
  raw: string,
  source: BlockFact["source"] = "distilled",
): BlockFact[] {
  const parsed = tryParseJsonLoose(raw);
  let items: unknown[] = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.facts)) items = obj.facts;
    else {
      const nested = Object.values(obj).find(Array.isArray);
      if (nested) items = nested as unknown[];
    }
  }

  const out: BlockFact[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push(newBlockFact(text, { source }));
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const text =
      typeof row.text === "string"
        ? row.text.trim()
        : typeof row.point === "string"
          ? row.point.trim()
          : typeof row.fact === "string"
            ? row.fact.trim()
            : "";
    if (!text) continue;
    out.push(
      newBlockFact(text, {
        source,
        skills: asStringArray(row.skills),
        metrics: asMetrics(row.metrics),
      }),
    );
  }
  return out;
}

/**
 * LLM: paste/scratchpad notes → structured BlockFact[].
 * Caller previews and applies; never auto-persists.
 */
export async function distillFactsFromNotes(
  notes: string,
  options?: {
    signal?: AbortSignal;
    source?: BlockFact["source"];
  },
): Promise<BlockFact[]> {
  const text = notes.trim();
  if (text.length < 8) {
    throw new Error("Paste a few raw points or notes before distilling.");
  }
  if (!canUseAiAssist()) {
    throw new Error(
      "AI assist is unavailable. Enable a local or API provider in Settings.",
    );
  }
  const source = options?.source ?? "distilled";
  const raw = await aiComplete({
    system: DISTILL_FACTS_SYSTEM,
    prompt: text.slice(0, 16_000),
    temperature: 0.1,
    format: "json",
    signal: options?.signal,
  });
  const facts = parseDistilledFacts(raw, source);
  if (facts.length === 0) {
    throw new Error(
      "Could not distill any facts. Try clearer bullet-style notes.",
    );
  }
  return facts;
}
