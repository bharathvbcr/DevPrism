/**
 * Stage 3b — Must-have gap analysis (pure TS, no extra LLM).
 * Classifies each mustHaveSkill as covered / weak / missing across
 * selected blocks, the full pool, facts, and optional KB snippets.
 */

import type { ExperienceBlock } from "@/lib/career/types";
import { skillsMatch, textCoversSkill } from "./scoring";
import type {
  GapAnalysis,
  GapAnalysisItem,
  GapCoverageStatus,
  GapHit,
} from "./types";

function snippet(text: string, max = 80): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Collect hits for a skill within a single block (skills, domains, bullets, facts). */
export function collectBlockSkillHits(
  block: ExperienceBlock,
  skill: string,
): GapHit[] {
  const hits: GapHit[] = [];

  for (const s of block.skills) {
    if (skillsMatch(s.name, skill)) {
      hits.push({
        kind: "block-skill",
        blockId: block.id,
        text: s.name,
      });
    }
  }

  for (const d of block.domains) {
    if (skillsMatch(d, skill) || textCoversSkill(d, skill)) {
      hits.push({
        kind: "block-domain",
        blockId: block.id,
        text: d,
      });
    }
  }

  for (const b of block.bullets) {
    if (textCoversSkill(b.canonical, skill)) {
      hits.push({
        kind: "bullet",
        blockId: block.id,
        bulletId: b.id,
        text: snippet(b.canonical),
      });
    }
  }

  for (const f of block.facts ?? []) {
    const skillHit = f.skills.some((s) => skillsMatch(s, skill));
    const textHit = textCoversSkill(f.text, skill);
    if (skillHit || textHit) {
      hits.push({
        kind: "fact",
        blockId: block.id,
        factId: f.id,
        text: snippet(f.text),
      });
    }
  }

  return hits;
}

export function collectKbSkillHits(
  skill: string,
  kbChunks: string[],
): GapHit[] {
  const hits: GapHit[] = [];
  for (const chunk of kbChunks) {
    if (!textCoversSkill(chunk, skill)) continue;
    hits.push({
      kind: "kb",
      text: snippet(chunk),
    });
  }
  return hits;
}

function evidenceLabels(
  selectedHits: GapHit[],
  poolHits: GapHit[],
  kbHits: GapHit[],
): string[] {
  const labels: string[] = [];
  const push = (label: string) => {
    if (!labels.includes(label)) labels.push(label);
  };
  for (const h of selectedHits) {
    if (h.text) push(h.text);
    else if (h.blockId) push(h.blockId);
  }
  for (const h of poolHits.slice(0, 3)) {
    if (h.text) push(`pool: ${h.text}`);
  }
  for (const h of kbHits.slice(0, 2)) {
    if (h.text) push(`KB: ${h.text}`);
  }
  return labels.slice(0, 6);
}

function suggestionFor(
  skill: string,
  status: GapCoverageStatus,
  selectedHits: GapHit[],
  poolHits: GapHit[],
  poolBlocks: ExperienceBlock[],
): string | undefined {
  if (status === "covered") return undefined;

  if (status === "weak") {
    const poolBlockId = poolHits.find((h) => h.blockId)?.blockId;
    if (poolBlockId) {
      const block = poolBlocks.find((b) => b.id === poolBlockId);
      const label = block
        ? `${block.title || block.org || block.id}`
        : poolBlockId;
      return `Include or swap in “${label}”, which mentions ${skill}.`;
    }
    if (selectedHits.length === 0) {
      return `KB mentions ${skill} — add a fact on a selected block so distill can use it.`;
    }
    return `Strengthen ${skill} with an explicit fact or skill tag on a selected block.`;
  }

  // missing
  const candidate = poolBlocks.find(
    (b) => collectBlockSkillHits(b, skill).length > 0,
  );
  if (candidate) {
    return `Add “${candidate.title || candidate.org}” (or a fact about ${skill}) to cover this must-have.`;
  }
  return `Add a fact about ${skill} to a relevant experience/project block.`;
}

export interface AnalyzeMustHaveGapsOptions {
  mustHaveSkills: string[];
  selectedBlocks: ExperienceBlock[];
  /** Full scored pool (selected + non-selected). */
  poolBlocks: ExperienceBlock[];
  /** Optional KB chunk texts (from evidence retrieval or a quick search). */
  kbChunks?: string[];
}

/**
 * Classify each must-have skill:
 * - covered: found on selected blocks (skill tags, domains, bullets, or facts)
 * - weak: not on selected, but found in non-selected pool and/or KB
 * - missing: nowhere in selected, pool, or KB
 */
export function analyzeMustHaveGaps(
  options: AnalyzeMustHaveGapsOptions,
): GapAnalysis {
  const { mustHaveSkills, selectedBlocks, poolBlocks, kbChunks = [] } = options;

  const selectedIds = new Set(selectedBlocks.map((b) => b.id));
  const nonSelected = poolBlocks.filter((b) => !selectedIds.has(b.id));

  const items: GapAnalysisItem[] = mustHaveSkills.map((skill) => {
    const selectedHits = selectedBlocks.flatMap((b) =>
      collectBlockSkillHits(b, skill),
    );
    const poolHits = nonSelected.flatMap((b) =>
      collectBlockSkillHits(b, skill),
    );
    const kbHits = collectKbSkillHits(skill, kbChunks);

    let status: GapCoverageStatus;
    if (selectedHits.length > 0) {
      status = "covered";
    } else if (poolHits.length > 0 || kbHits.length > 0) {
      status = "weak";
    } else {
      status = "missing";
    }

    return {
      skill,
      status,
      evidence: evidenceLabels(selectedHits, poolHits, kbHits),
      suggestion: suggestionFor(
        skill,
        status,
        selectedHits,
        poolHits,
        poolBlocks,
      ),
      selectedHits,
      poolHits,
      kbHits,
    };
  });

  const coveredCount = items.filter((i) => i.status === "covered").length;
  const weakCount = items.filter((i) => i.status === "weak").length;
  const missingCount = items.filter((i) => i.status === "missing").length;

  const parts: string[] = [];
  if (coveredCount > 0) parts.push(`${coveredCount} covered`);
  if (weakCount > 0) parts.push(`${weakCount} weak`);
  if (missingCount > 0) parts.push(`${missingCount} missing`);

  return {
    items,
    summary:
      mustHaveSkills.length === 0
        ? "No must-have skills extracted from the JD."
        : parts.length > 0
          ? `Must-haves: ${parts.join(", ")}.`
          : undefined,
    coveredCount,
    weakCount,
    missingCount,
  };
}

/** Helpers for the "What's missing" panel. */
export function gapItemsByStatus(
  gap: GapAnalysis | null | undefined,
  status: GapCoverageStatus,
): GapAnalysisItem[] {
  return (gap?.items ?? []).filter((i) => i.status === status);
}

export function gapMissingOrWeak(
  gap: GapAnalysis | null | undefined,
): GapAnalysisItem[] {
  return (gap?.items ?? []).filter(
    (i) => i.status === "missing" || i.status === "weak",
  );
}
