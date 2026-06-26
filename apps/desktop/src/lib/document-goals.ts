import type { SpaceKind } from "@/lib/space-features";

export interface DocumentGoal {
  /** Human-readable label shown in the status bar. */
  label: string;
  wordLimit?: number;
  charLimit?: number;
  /** Soft page guidance (e.g. "1 page") when no numeric limit is known. */
  pageHint?: string;
}

/** Extract numeric word/character limits from a JD, prompt, or requirements file. */
export function parseLimitsFromTarget(text: string): {
  wordLimit?: number;
  charLimit?: number;
} {
  if (!text.trim()) return {};

  const wordPatterns = [
    /\b(?:max(?:imum)?|up to|no more than|limit(?:ed)? to|within)\s+(\d[\d,]*)\s*words?\b/i,
    /\b(\d[\d,]*)\s*-?\s*word\s+(?:limit|maximum|max|essay|statement|response)\b/i,
    /\b(\d[\d,]*)\s*-?\s*words?\b/i,
    /\bword\s+limit\s*(?:of|:)?\s*(\d[\d,]*)\b/i,
    /\b(?:essay|statement|response)\s*(?:of|:)?\s*(\d[\d,]*)\s*words?\b/i,
    /\blimit\s*:\s*(\d[\d,]*)\s*words?\b/i,
  ];
  const charPatterns = [
    /\b(?:max(?:imum)?|up to|no more than|limit(?:ed)? to|within)\s+(\d[\d,]*)\s*(?:chars?|characters?)\b/i,
    /\b(\d[\d,]*)\s*-?\s*character\s+(?:limit|maximum|max)\b/i,
    /\bcharacter\s+limit\s*(?:of|:)?\s*(\d[\d,]*)\b/i,
  ];

  const parseNum = (raw: string) => Number.parseInt(raw.replace(/,/g, ""), 10);

  let wordLimit: number | undefined;
  for (const re of wordPatterns) {
    const m = text.match(re);
    if (m) {
      const n = parseNum(m[1]);
      if (Number.isFinite(n) && n > 0) {
        wordLimit = n;
        break;
      }
    }
  }

  let charLimit: number | undefined;
  for (const re of charPatterns) {
    const m = text.match(re);
    if (m) {
      const n = parseNum(m[1]);
      if (Number.isFinite(n) && n > 0) {
        charLimit = n;
        break;
      }
    }
  }

  return { wordLimit, charLimit };
}

/** Sensible defaults when no target file states a limit explicitly. */
export function defaultGoalForKind(kind: SpaceKind): DocumentGoal | null {
  switch (kind) {
    case "resume":
      return { label: "Resume", pageHint: "1 page" };
    case "statements":
      return { label: "Statement", wordLimit: 1000 };
    case "manuscript":
      return { label: "Abstract", wordLimit: 250 };
    case "report":
      return { label: "Executive summary", wordLimit: 500 };
    default:
      return null;
  }
}

/**
 * Merge parsed limits from JOB_DESCRIPTION.md with space-kind defaults.
 * Manuscript/report defaults apply only when the active file looks like an abstract.
 */
export function resolveDocumentGoal(
  kind: SpaceKind,
  targetText: string | null | undefined,
  options?: { activeFileName?: string },
): DocumentGoal | null {
  const parsed = parseLimitsFromTarget(targetText ?? "");
  if (parsed.wordLimit || parsed.charLimit) {
    return {
      label: "Target limit",
      wordLimit: parsed.wordLimit,
      charLimit: parsed.charLimit,
    };
  }

  const fallback = defaultGoalForKind(kind);
  if (!fallback) return null;

  const name = (options?.activeFileName ?? "").toLowerCase();
  const isAbstractish =
    name.includes("abstract") ||
    name.includes("summary") ||
    name.includes("executive");

  if (
    (kind === "manuscript" || kind === "report") &&
    fallback.wordLimit &&
    !isAbstractish
  ) {
    return null;
  }

  return fallback;
}
