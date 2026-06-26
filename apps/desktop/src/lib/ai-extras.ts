import { invoke } from "@tauri-apps/api/core";
import { aiComplete, resolveAiProvider } from "@/lib/ai-assist";

/** Caption / alt-text for an image via a local vision model (Ollama only).
 * `imageBase64` may be a bare base64 string or a data: URL. */
export async function aiCaption(
  imageBase64: string,
  prompt?: string,
): Promise<string> {
  if (!imageBase64.trim()) return "";
  const provider = resolveAiProvider();
  return invoke<string>("ai_caption", {
    imageBase64,
    prompt: prompt ?? null,
    model: provider.model,
    baseUrl: provider.baseUrl,
    numCtx: provider.numCtx,
  });
}

// Pass-4 one-shot AI helpers. Kept in a sibling module (importing aiComplete)
// to stay out of the way of concurrent edits to ai-assist.ts.

const ABSTRACT_SYSTEM =
  "You write a concise abstract/summary for a document, suitable to prepend to an export. " +
  "3-5 sentences capturing purpose, approach, and key points. Plain text only, no heading or label.";

const SUGGESTION_VERDICT_SYSTEM =
  "You briefly assess whether a proposed replacement preserves the original passage's meaning and does " +
  "not drop citations, numbers, or LaTeX commands. Reply in ONE short sentence starting with 'Safe:' or " +
  "'Caution:'. Plain text only.";

const SNIPPET_FILL_SYSTEM =
  "You fill in the placeholders of a LaTeX snippet skeleton using the surrounding document context, " +
  "producing ready-to-insert LaTeX. Keep the snippet's structure and commands; replace placeholder tokens " +
  "(like <...>, empty {} args, or TODO) with sensible content. Return ONLY the filled LaTeX — no explanation, no fences.";

const SPACE_META_SYSTEM =
  "You name and describe a workspace that groups related document projects. Given the project names, " +
  'return JSON {"name": string (2-4 words), "description": string (one sentence)}. Return ONLY JSON — no fences.';

/** Generate an abstract/summary to prepend to an exported document. */
export async function generateAbstract(text: string): Promise<string> {
  const excerpt = text.trim().slice(0, 6000);
  if (excerpt.length < 80) return "";
  return aiComplete({ system: ABSTRACT_SYSTEM, prompt: excerpt, temperature: 0.3 });
}

/** One-sentence safety verdict on a proposed text replacement. */
export async function assessSuggestion(options: {
  original: string;
  replacement: string;
}): Promise<string> {
  if (!options.original.trim() || !options.replacement.trim()) return "";
  return aiComplete({
    system: SUGGESTION_VERDICT_SYSTEM,
    prompt: `Original:\n${options.original.slice(0, 1500)}\n\nProposed:\n${options.replacement.slice(0, 1500)}`,
    temperature: 0.2,
  });
}

/** Fill a LaTeX snippet's placeholders from surrounding document context. */
export async function fillSnippet(options: {
  snippet: string;
  context: string;
}): Promise<string> {
  const snip = options.snippet.trim();
  if (!snip) return "";
  const raw = await aiComplete({
    system: SNIPPET_FILL_SYSTEM,
    prompt: `Context:\n${options.context.slice(0, 1200)}\n\nSnippet:\n${snip}`,
    temperature: 0.3,
  });
  return raw.trim();
}

/** Best-effort parse of a JSON object from a model reply (tolerates fences/prose). */
function parseJsonObjectLoose<T extends object>(raw: string): T {
  const trimmed = raw.trim();
  const tryParse = (s: string): T | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced) return fenced;
  }
  const start = trimmed.indexOf("{");
  if (start >= 0) {
    const sliced = tryParse(trimmed.slice(start));
    if (sliced) return sliced;
  }
  return {} as T;
}

/** Suggest a name + description for a space grouping the given projects. */
export async function suggestSpaceMeta(
  projectNames: string[],
): Promise<{ name?: string; description?: string }> {
  const names = projectNames.filter((n) => n.trim());
  if (names.length === 0) return {};
  const raw = await aiComplete({
    system: SPACE_META_SYSTEM,
    prompt: `Projects:\n${names.slice(0, 40).join("\n")}`,
    temperature: 0.4,
    format: "json",
  });
  const parsed = parseJsonObjectLoose<{ name?: string; description?: string }>(
    raw,
  );
  return {
    name: parsed.name?.trim().slice(0, 40) || undefined,
    description: parsed.description?.trim().slice(0, 160) || undefined,
  };
}
