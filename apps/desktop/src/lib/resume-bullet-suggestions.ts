import {
  buildBulletCountInstruction,
  clampResumeBulletCount,
  type BulletListEnv,
} from "@/lib/resume-bullets";

export type ResumeBulletSuggestionKind = "count" | "refine" | "advice";

export interface ResumeBulletQuality {
  itemCount: number;
  withoutMetrics: number;
  weakOpeners: number;
  longBullets: number;
  redundantPairs: number;
  avgChars: number;
}

export interface ResumeBulletSuggestionContext {
  bulletText: string;
  itemCount: number;
  compiledPageCount?: number | null;
  hasJobDescription?: boolean;
  roleLabel?: string;
}

export type BulletItemIssue =
  | "no-metric"
  | "weak-opener"
  | "long"
  | "redundant";

export interface BulletItemDiagnostic {
  index: number;
  preview: string;
  issues: BulletItemIssue[];
}

export function bulletQualityScore(quality: ResumeBulletQuality): number {
  let score = 100;
  score -= quality.withoutMetrics * 12;
  score -= quality.weakOpeners * 15;
  score -= quality.longBullets * 8;
  score -= quality.redundantPairs * 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function bulletQualityGrade(score: number): string {
  if (score >= 85) return "Strong";
  if (score >= 65) return "Good";
  if (score >= 45) return "Fair";
  return "Needs work";
}

/** Per-bullet issue tags for the toolbar breakdown. */
export function diagnoseBulletItems(
  bulletText: string,
): BulletItemDiagnostic[] {
  const bodies = parseLatexItemBodies(bulletText);
  const tokens = bodies.map(tokenSet);
  const redundantIndexes = new Set<number>();

  for (let i = 0; i < tokens.length; i += 1) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (jaccardSimilarity(tokens[i], tokens[j]) >= 0.45) {
        redundantIndexes.add(i);
        redundantIndexes.add(j);
      }
    }
  }

  return bodies.map((body, index) => {
    const plain = stripLatexForAnalysis(body);
    const issues: BulletItemIssue[] = [];
    if (!METRIC_RE.test(plain)) issues.push("no-metric");
    if (WEAK_OPENER_RE.test(plain)) issues.push("weak-opener");
    if (plain.length > 140) issues.push("long");
    if (redundantIndexes.has(index)) issues.push("redundant");

    const preview =
      plain.length > 42
        ? `${plain.slice(0, 39)}…`
        : plain || `Bullet ${index + 1}`;

    return { index: index + 1, preview, issues };
  });
}

/** Map an insight string to a suggestion id for one-click fixes. */
export function suggestionIdForInsight(insight: string): string | null {
  const lower = insight.toLowerCase();
  if (lower.includes("lack metrics") || lower.includes("lacks metrics")) {
    return "add-metrics";
  }
  if (lower.includes("weak opener")) return "stronger-verbs";
  if (lower.includes("overlap")) return "remove-redundancy";
  if (lower.includes("run long")) return "shorten";
  if (lower.includes("pages")) return "fit-one-page";
  if (lower.includes("5+ bullets") || lower.includes("heavy"))
    return "keep-top-3";
  return null;
}

export function findSuggestionById(
  suggestions: ResumeBulletSuggestion[],
  id: string,
): ResumeBulletSuggestion | undefined {
  return suggestions.find((s) => s.id === id);
}

const issueLabel: Record<BulletItemIssue, string> = {
  "no-metric": "no metric",
  "weak-opener": "weak opener",
  long: "too long",
  redundant: "overlaps",
};

export function formatBulletIssue(issue: BulletItemIssue): string {
  return issueLabel[issue];
}

export interface ResumeBulletSuggestion {
  id: string;
  kind: ResumeBulletSuggestionKind;
  label: string;
  title: string;
  instruction: string;
  /** For count suggestions — one-click reshapes to this many bullets. */
  targetCount?: number;
  priority: number;
}

const WEAK_OPENER_RE =
  /^(?:responsible for|worked on|helped with|assisted with|duties included|tasked with|involved in)\b/i;

const METRIC_RE = /\d|%|\b(?:million|billion|thousand|k\b|m\b|x\b|fold)\b/i;

/** Split a list fragment into individual bullet bodies (text after each \\item). */
export function parseLatexItemBodies(text: string): string[] {
  const parts = text.split(/\\item\b/);
  return parts
    .slice(1)
    .map((part) => {
      const body = part.split(/\\end\{/)[0] ?? part;
      return body.replace(/\s+/g, " ").trim();
    })
    .filter((body) => body.length > 0);
}

function stripLatexForAnalysis(text: string): string {
  return text
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?(\{[^}]*\})?/g, " ")
    .replace(/[{}$%&~^_#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text: string): Set<string> {
  const words = stripLatexForAnalysis(text)
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Fast local quality scan — no model call. */
export function analyzeBulletQuality(bulletText: string): ResumeBulletQuality {
  const bodies = parseLatexItemBodies(bulletText);
  let withoutMetrics = 0;
  let weakOpeners = 0;
  let longBullets = 0;
  let redundantPairs = 0;
  let totalChars = 0;

  const tokens = bodies.map(tokenSet);

  for (const body of bodies) {
    const plain = stripLatexForAnalysis(body);
    totalChars += plain.length;
    if (!METRIC_RE.test(plain)) withoutMetrics += 1;
    if (WEAK_OPENER_RE.test(plain)) weakOpeners += 1;
    if (plain.length > 140) longBullets += 1;
  }

  for (let i = 0; i < tokens.length; i += 1) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (jaccardSimilarity(tokens[i], tokens[j]) >= 0.45) {
        redundantPairs += 1;
      }
    }
  }

  return {
    itemCount: bodies.length,
    withoutMetrics,
    weakOpeners,
    longBullets,
    redundantPairs,
    avgChars: bodies.length > 0 ? Math.round(totalChars / bodies.length) : 0,
  };
}

export function bulletQualityInsights(
  quality: ResumeBulletQuality,
  context: ResumeBulletSuggestionContext,
): string[] {
  const insights: string[] = [];

  if (context.compiledPageCount != null && context.compiledPageCount > 1) {
    insights.push(
      `Resume is ${context.compiledPageCount} pages — trim to fit 1`,
    );
  }
  if (quality.withoutMetrics > 0) {
    insights.push(
      `${quality.withoutMetrics} bullet${quality.withoutMetrics === 1 ? "" : "s"} lack metrics`,
    );
  }
  if (quality.weakOpeners > 0) {
    insights.push(
      `${quality.weakOpeners} weak opener${quality.weakOpeners === 1 ? "" : "s"}`,
    );
  }
  if (quality.redundantPairs > 0) {
    insights.push("Some bullets overlap — consider merging");
  }
  if (quality.longBullets > 0) {
    insights.push(
      `${quality.longBullets} bullet${quality.longBullets === 1 ? "" : "s"} run long`,
    );
  }
  if (context.itemCount >= 5) {
    insights.push("5+ bullets is heavy for one role on a 1-page resume");
  }

  return insights.slice(0, 3);
}

export function recommendedBulletTarget(
  context: ResumeBulletSuggestionContext,
  quality: ResumeBulletQuality,
): number | null {
  const count = context.itemCount;
  if (
    context.compiledPageCount != null &&
    context.compiledPageCount > 1 &&
    count > 2
  ) {
    return clampResumeBulletCount(Math.max(2, count - 2));
  }
  if (count >= 5) return 3;
  if (count === 4 && (quality.redundantPairs > 0 || quality.longBullets > 1)) {
    return 3;
  }
  if (count === 1 && quality.avgChars > 120) return 2;
  return null;
}

function envHint(env?: BulletListEnv): string {
  return env
    ? ` Preserve the \\begin{${env}} / \\end{${env}} wrapper exactly.`
    : " Preserve the list environment wrapper.";
}

export function buildBulletRefinementInstruction(
  refinement:
    | "add-metrics"
    | "stronger-verbs"
    | "remove-redundancy"
    | "shorten"
    | "match-jd"
    | "ats-polish"
    | "keep-strongest",
  options?: { itemCount?: number; env?: BulletListEnv; roleLabel?: string },
): string {
  const count = options?.itemCount ?? 0;
  const countHint =
    count > 0
      ? ` Keep exactly ${count} bullet point${count === 1 ? "" : "s"}.`
      : " Keep the same number of bullets.";
  const env = envHint(options?.env);
  const roleHint = options?.roleLabel
    ? ` Role context: ${options.roleLabel}.`
    : "";

  switch (refinement) {
    case "add-metrics":
      return (
        "Strengthen these resume bullets by adding measurable impact (%, counts, scale, time saved) " +
        "using only facts already implied — flag anything that needs a number from me rather than inventing one." +
        countHint +
        " Each bullet must start with \\item and lead with a strong past-tense verb." +
        roleHint +
        env
      );
    case "stronger-verbs":
      return (
        "Rewrite these bullets to lead with strong past-tense action verbs (Built, Led, Reduced, Shipped). " +
        "Remove weak openers like 'Responsible for', 'Worked on', or 'Helped with'." +
        countHint +
        " Do not invent new responsibilities." +
        roleHint +
        env
      );
    case "remove-redundancy":
      return (
        "Merge overlapping bullets so each line covers a distinct achievement. " +
        "Combine related points instead of repeating the same theme." +
        countHint +
        " Keep every fact truthful." +
        env
      );
    case "shorten":
      return (
        "Tighten each bullet to one crisp line (ideally under ~2 printed lines). " +
        "Cut filler words and keep the strongest metric or outcome." +
        countHint +
        env
      );
    case "match-jd":
      return (
        "Rewrite these bullets to mirror keywords and qualifications from JOB_DESCRIPTION.md " +
        "where they are truthful for my background. Do not claim skills I do not have." +
        countHint +
        env
      );
    case "ats-polish":
      return (
        "Polish these bullets for ATS scanning: standard action-verb openings, concrete tools/skills, " +
        "and quantified outcomes. Avoid tables, columns, or unusual formatting inside bullets." +
        countHint +
        env
      );
    case "keep-strongest":
      return (
        `Reduce to the ${Math.min(3, count)} strongest bullets for this role by merging or dropping the weakest points. ` +
        "Prioritize impact, metrics, and relevance to the target job. Keep facts truthful." +
        env
      );
    default:
      return (
        "Improve these resume bullets while keeping the same count and facts truthful." +
        env
      );
  }
}

export function buildBulletAdviceInstruction(
  topic: "which-to-cut" | "how-to-split",
  itemCount: number,
): string {
  if (topic === "which-to-cut") {
    return (
      `I have ${itemCount} bullets for this role on a 1-page resume. ` +
      "Analyze the selected bullets and tell me which to merge or cut — rank them by impact and note what to combine. " +
      "Do not edit the file yet."
    );
  }
  return (
    `I have ${itemCount} bullet(s) for this role. ` +
    "Suggest how to split this into 2–3 distinct achievement lines without inventing facts. " +
    "Do not edit the file yet."
  );
}

export function refinementSuccessMessage(label: string): string {
  return `${label} ready — review the change`;
}

/** Ranked AI suggestion chips for the selection toolbar. */
export function buildResumeBulletSuggestions(
  context: ResumeBulletSuggestionContext,
  options?: { env?: BulletListEnv },
): ResumeBulletSuggestion[] {
  const quality = analyzeBulletQuality(context.bulletText);
  const count = context.itemCount;
  const env = options?.env;
  const roleOpts = { env, roleLabel: context.roleLabel };
  const out: ResumeBulletSuggestion[] = [];

  const recommended = recommendedBulletTarget(context, quality);
  if (recommended != null && recommended !== count) {
    out.push({
      id: "recommended-count",
      kind: "count",
      label: recommended === 1 ? "Try 1 bullet" : `Try ${recommended} bullets`,
      title:
        context.compiledPageCount != null && context.compiledPageCount > 1
          ? "Recommended to help fit a 1-page resume"
          : "Recommended count for this role",
      instruction: buildBulletCountInstruction(count, recommended, {
        env,
        roleLabel: context.roleLabel,
      }),
      targetCount: recommended,
      priority: 100,
    });
  }

  if (
    context.compiledPageCount != null &&
    context.compiledPageCount > 1 &&
    count > 2
  ) {
    const target = clampResumeBulletCount(Math.max(2, count - 1));
    if (target !== count && target !== recommended) {
      out.push({
        id: "fit-one-page",
        kind: "count",
        label: "Fit 1 page",
        title: `Merge toward ${target} bullets to shorten the resume`,
        instruction: buildBulletCountInstruction(count, target, {
          env,
          roleLabel: context.roleLabel,
        }),
        targetCount: target,
        priority: 90,
      });
    }
  }

  if (count >= 4) {
    out.push({
      id: "keep-top-3",
      kind: "count",
      label: "Top 3 only",
      title: "Keep the three strongest bullets for this role",
      instruction: buildBulletCountInstruction(count, 3, {
        env,
        roleLabel: context.roleLabel,
      }),
      targetCount: 3,
      priority: 85,
    });
  }

  if (quality.withoutMetrics > 0) {
    out.push({
      id: "add-metrics",
      kind: "refine",
      label: "Add metrics",
      title: `${quality.withoutMetrics} bullet${quality.withoutMetrics === 1 ? "" : "s"} could use numbers or scale`,
      instruction: buildBulletRefinementInstruction("add-metrics", {
        itemCount: count,
        ...roleOpts,
      }),
      priority: 80,
    });
  }

  if (quality.weakOpeners > 0) {
    out.push({
      id: "stronger-verbs",
      kind: "refine",
      label: "Stronger verbs",
      title: "Replace weak openers with action verbs",
      instruction: buildBulletRefinementInstruction("stronger-verbs", {
        itemCount: count,
        ...roleOpts,
      }),
      priority: 75,
    });
  }

  if (quality.redundantPairs > 0) {
    out.push({
      id: "remove-redundancy",
      kind: "refine",
      label: "Deduplicate",
      title: "Merge bullets that repeat the same theme",
      instruction: buildBulletRefinementInstruction("remove-redundancy", {
        itemCount: count,
        ...roleOpts,
      }),
      priority: 70,
    });
  }

  if (quality.longBullets > 0) {
    out.push({
      id: "shorten",
      kind: "refine",
      label: "Shorten",
      title: "Tighten long bullets to one crisp line each",
      instruction: buildBulletRefinementInstruction("shorten", {
        itemCount: count,
        ...roleOpts,
      }),
      priority: 65,
    });
  }

  if (context.hasJobDescription) {
    out.push({
      id: "match-jd",
      kind: "refine",
      label: "Match JD",
      title: "Mirror keywords from JOB_DESCRIPTION.md truthfully",
      instruction: buildBulletRefinementInstruction("match-jd", {
        itemCount: count,
        ...roleOpts,
      }),
      priority: 60,
    });
  }

  out.push({
    id: "ats-polish",
    kind: "refine",
    label: "ATS polish",
    title: "Action verbs, skills, and quantified outcomes for scanners",
    instruction: buildBulletRefinementInstruction("ats-polish", {
      itemCount: count,
      ...roleOpts,
    }),
    priority: 50,
  });

  if (count >= 4) {
    out.push({
      id: "which-to-cut",
      kind: "advice",
      label: "Which to cut?",
      title: "Get AI advice on which bullets to merge or drop (no edit)",
      instruction: buildBulletAdviceInstruction("which-to-cut", count),
      priority: 40,
    });
  }

  if (count === 1 && quality.avgChars > 100) {
    out.push({
      id: "how-to-split",
      kind: "advice",
      label: "How to split?",
      title: "Get ideas for splitting one dense bullet into 2–3 lines",
      instruction: buildBulletAdviceInstruction("how-to-split", count),
      priority: 35,
    });
  }

  const seen = new Set<string>();
  return out
    .filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 6);
}
