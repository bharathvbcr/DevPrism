/**
 * Pure helpers for synthesis UX (progress labels, coverage heatmap, run reopen).
 */

import type {
  MatchReport,
  MustHaveCoverage,
  RewriteBlockProgress,
  StageTimingsMs,
  SynthesisStageId,
} from "./types";

/** Heatmap cell: covered at selection, only after rewrite, or still uncovered. */
export type CoverageHeatLevel = "selection" | "rewrite" | "uncovered";

export function coverageHeatLevel(row: MustHaveCoverage): CoverageHeatLevel {
  if (row.selectionHits.length > 0) return "selection";
  if (row.rewriteHits.length > 0) return "rewrite";
  return "uncovered";
}

export function coverageHeatLabel(level: CoverageHeatLevel): string {
  switch (level) {
    case "selection":
      return "Covered at selection";
    case "rewrite":
      return "Covered after rewrite";
    case "uncovered":
      return "Uncovered";
  }
}

const STAGE_TIMING_ORDER: Array<
  Exclude<SynthesisStageId, "idle" | "done" | "error" | "cancelled">
> = [
  "analyzing",
  "scoring",
  "selecting",
  "evidence",
  "rewriting",
  "critic",
  "assembling",
];

const STAGE_TIMING_LABELS: Record<string, string> = {
  analyzing: "Analyze JD",
  scoring: "Score blocks",
  selecting: "Select",
  evidence: "Evidence",
  rewriting: "Rewrite",
  critic: "Critic",
  assembling: "Assemble",
};

export function listStageTimings(
  timings: StageTimingsMs | undefined | null,
): Array<{ id: string; label: string; ms: number }> {
  if (!timings) return [];
  return STAGE_TIMING_ORDER.filter((id) => timings[id] != null).map((id) => ({
    id,
    label: STAGE_TIMING_LABELS[id] ?? id,
    ms: timings[id]!,
  }));
}

export function formatStageMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
}

/** Detail string for per-block rewrite progress (orchestrator + checklist). */
export function formatRewriteBlockDetail(
  label: string,
  index: number,
  total: number,
): string {
  return `Rewriting: ${label} — ${index}/${total}`;
}

export function blockRewriteLabel(org: string, title: string): string {
  const o = org.trim();
  if (o) return o;
  return title.trim() || "Untitled";
}

/**
 * Prefer extracted `"text"` fields from partial JSON; else trailing raw chars.
 */
export function extractRewriteStreamPreview(raw: string, maxLen = 280): string {
  const texts: string[] = [];
  const re = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    texts.push(
      m[1]!.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
    );
  }
  const joined =
    texts.length > 0 ? texts.join(" · ") : raw.replace(/\s+/g, " ").trim();
  if (joined.length <= maxLen) return joined;
  return `…${joined.slice(-maxLen)}`;
}

/** Best-effort parse of a stored `synthesis_runs.report_json` blob. */
export function parseStoredMatchReport(json: unknown): MatchReport | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  // Nested `{ report, tex }` shape (future-proof).
  if (o.report && typeof o.report === "object" && !Array.isArray(o.report)) {
    return parseStoredMatchReport(o.report);
  }
  if (!o.profile || typeof o.profile !== "object") return null;
  if (!Array.isArray(o.scored)) return null;
  if (!Array.isArray(o.selectedBlockIds)) return null;
  // Strip rematerialization-only fields before casting.
  const { tex: _tex, ...rest } = o;
  void _tex;
  return rest as unknown as MatchReport;
}

/** Extract persisted `.tex` from a stored run payload (if present). */
export function extractStoredRunTex(json: unknown): string | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.tex === "string" && o.tex.trim().length > 0) return o.tex;
  if (o.report && typeof o.report === "object" && !Array.isArray(o.report)) {
    const nested = o.report as Record<string, unknown>;
    if (typeof nested.tex === "string" && nested.tex.trim().length > 0) {
      return nested.tex;
    }
  }
  return null;
}

export function atsScoreFromReport(report: MatchReport | null): number | null {
  const pct = report?.critique?.atsCoveragePct;
  if (pct == null || Number.isNaN(pct)) return null;
  return Math.round(pct);
}

export function initBlockProgress(
  blocks: Array<{ blockId: string; label: string }>,
): RewriteBlockProgress[] {
  const total = blocks.length;
  return blocks.map((b, i) => ({
    blockId: b.blockId,
    label: b.label,
    index: i + 1,
    total,
    status: "pending" as const,
  }));
}
