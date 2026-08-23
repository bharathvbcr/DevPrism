import { aiComplete, canUseAiAssist } from "@/lib/ai-assist";
import type { BlockFact, ExperienceBlock } from "./types";
import { canonicalizeBlockKind } from "../resume-sections";
import {
  createEmptyBlock,
  isSeniorityLevel,
  newBlockFact,
  newBullet,
  newCareerId,
} from "./block-helpers";

/** Hard cap on blocks accepted from a single LLM extract. Fail closed on floods. */
export const EXTRACT_MAX_BLOCKS = 200;
const EXTRACT_MAX_BULLETS = 40;
const EXTRACT_MAX_FACTS = 40;
const EXTRACT_MAX_TEXT = 2000;
const EXTRACT_MAX_TITLE = 200;

function clipText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

const EXTRACT_SYSTEM = `You extract structured resume experience blocks from LaTeX or plain-text resume source.
Return ONLY JSON of the form:
{"blocks":[{
  "kind":"experience"|"project"|"publication"|"education"|"leadership"|"certification"|"award"|"volunteer",
  "title":string,
  "org":string,
  "dateStart":string (YYYY-MM or YYYY),
  "dateEnd":string|null,
  "domains":string[],
  "skills":string[],
  "seniorityLevel":"ic"|"senior"|"lead"|"manager"|"director",
  "location":string (optional, e.g. "Remote" or "New York, NY"),
  "extra":string (optional trailing detail line: GPA, honors, coursework),
  "bullets":string[],
  "facts":string[] (optional)
}]}
Rules:
- Prefer factual content present in the source; do not invent employers or metrics.
- Split distinct roles/projects into separate blocks.
- Bullets are polished resume lines (plain text, no LaTeX commands) — keep a tight set.
- When the source has extra detail that does not fit cleanly as polished bullets (side metrics, tools, ownership notes), put those in facts[] as short raw points. Omit facts when everything fits in bullets.
- Put a GPA / honors / coursework line in "extra", not in bullets.
- If unsure of seniority, use "senior".
- Return ONLY JSON — no markdown fences, no commentary.`;

/** Best-effort JSON parse (fences / leading prose), matching ai-assist salvage style. */
export function tryParseJsonLoose(raw: string): unknown {
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeDate(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 10);
}

/** Validate/normalize LLM JSON into draft ExperienceBlock[] (new ids, never persisted). */
export function parseExtractedBlocks(raw: string): ExperienceBlock[] {
  const parsed = tryParseJsonLoose(raw);
  let items: unknown[] = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.blocks)) items = obj.blocks;
    else {
      const nested = Object.values(obj).find(Array.isArray);
      if (nested) items = nested as unknown[];
    }
  }

  const out: ExperienceBlock[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title =
      typeof row.title === "string"
        ? row.title.trim()
        : typeof row.role === "string"
          ? row.role.trim()
          : "";
    const org =
      typeof row.org === "string"
        ? row.org.trim()
        : typeof row.organization === "string"
          ? row.organization.trim()
          : typeof row.company === "string"
            ? row.company.trim()
            : "";
    if (!title && !org) continue;
    if (out.length >= EXTRACT_MAX_BLOCKS) break;

    const bulletTexts = asStringArray(row.bullets)
      .slice(0, EXTRACT_MAX_BULLETS)
      .map((t) => clipText(t, EXTRACT_MAX_TEXT));
    const factTexts = asStringArray(row.facts)
      .slice(0, EXTRACT_MAX_FACTS)
      .map((t) => clipText(t, EXTRACT_MAX_TEXT));
    const facts: BlockFact[] = factTexts.map((text) =>
      newBlockFact(text, { source: "import" }),
    );
    const skills = asStringArray(row.skills).map((name) => ({
      name,
      level: 3 as const,
    }));
    const domains = asStringArray(row.domains);
    const dateStart =
      normalizeDate(row.dateStart) ||
      normalizeDate(row.start) ||
      (row.dateRange &&
      typeof row.dateRange === "object" &&
      row.dateRange !== null
        ? normalizeDate((row.dateRange as Record<string, unknown>).start)
        : "");
    const dateEndRaw =
      row.dateEnd === null
        ? null
        : normalizeDate(row.dateEnd) ||
          normalizeDate(row.end) ||
          (row.dateRange &&
          typeof row.dateRange === "object" &&
          row.dateRange !== null
            ? (() => {
                const end = (row.dateRange as Record<string, unknown>).end;
                return end === null ? null : normalizeDate(end) || null;
              })()
            : null);

    const rawKind = row.kind;
    const omittedKind =
      rawKind === undefined || rawKind === null || rawKind === "";
    const kind = omittedKind ? "experience" : canonicalizeBlockKind(rawKind);
    if (!kind) continue;

    out.push(
      createEmptyBlock({
        id: newCareerId("exp"),
        kind,
        title: clipText(title || "Untitled", EXTRACT_MAX_TITLE),
        org: clipText(org, EXTRACT_MAX_TITLE),
        dateRange: {
          start: dateStart,
          end: dateEndRaw === "" ? null : dateEndRaw,
        },
        domains,
        skills,
        seniorityLevel: isSeniorityLevel(row.seniorityLevel)
          ? row.seniorityLevel
          : "senior",
        location: optionalText(row.location),
        extra: optionalText(row.extra),
        bullets:
          bulletTexts.length > 0
            ? bulletTexts.map((t) => newBullet(t))
            : [newBullet()],
        facts,
        personas: [],
      }),
    );
  }
  return out;
}

/** Trimmed string when present and non-empty, else undefined. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** LLM extraction → draft blocks. Caller must review; never auto-commits. */
export async function extractBlocksFromResume(
  source: string,
): Promise<ExperienceBlock[]> {
  const text = source.trim();
  if (text.length < 40) {
    throw new Error("Paste more resume content (at least a few lines).");
  }
  if (!canUseAiAssist()) {
    throw new Error(
      "AI assist is unavailable. Enable a local or API provider in Settings.",
    );
  }
  const raw = await aiComplete({
    system: EXTRACT_SYSTEM,
    prompt: text.slice(0, 24_000),
    temperature: 0.1,
    format: "json",
  });
  const blocks = parseExtractedBlocks(raw);
  if (blocks.length === 0) {
    throw new Error(
      "Could not extract any experience blocks. Try a cleaner .tex excerpt.",
    );
  }
  return blocks;
}
