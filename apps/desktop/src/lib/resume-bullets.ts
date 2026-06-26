/** Helpers for adjusting LaTeX resume bullet counts in a selection. */

export const MIN_RESUME_BULLETS = 1;
export const MAX_RESUME_BULLETS = 6;

export const BULLET_LIST_ENVS = ["itemize", "bullets", "enumerate"] as const;
export type BulletListEnv = (typeof BULLET_LIST_ENVS)[number];

const ITEM_RE = /\\item\b/g;

export interface BulletListBlock {
  start: number;
  end: number;
  env: BulletListEnv;
  itemCount: number;
}

export interface SelectionBulletStats {
  /** Items inside the editor selection. */
  selectedCount: number;
  /** Items in the enclosing list block, if any. */
  block: BulletListBlock | null;
  /** Selection covers fewer items than the enclosing block. */
  isPartialBlock: boolean;
}

/** Count `\\item` markers in a LaTeX fragment. */
export function countLatexItems(text: string): number {
  const matches = text.match(ITEM_RE);
  return matches ? matches.length : 0;
}

export function isResumeBulletSelection(text: string): boolean {
  return countLatexItems(text) > 0;
}

export function clampResumeBulletCount(count: number): number {
  return Math.max(
    MIN_RESUME_BULLETS,
    Math.min(MAX_RESUME_BULLETS, Math.round(count)),
  );
}

function parseListEnv(opening: string): BulletListEnv | null {
  const match = opening.match(/^\\begin\{(itemize|bullets|enumerate)\*?\}/);
  return match ? (match[1] as BulletListEnv) : null;
}

function endTagFor(env: BulletListEnv, starred: boolean): string {
  return starred ? `\\end{${env}*}` : `\\end{${env}}`;
}

/** Find the innermost bullet list environment containing `anchor`. */
export function findEnclosingBulletList(
  content: string,
  anchor: number,
): BulletListBlock | null {
  const clamped = Math.max(0, Math.min(anchor, content.length));
  let best: BulletListBlock | null = null;

  for (const env of BULLET_LIST_ENVS) {
    const beginRe = new RegExp(`\\\\begin\\{${env}\\*?\\}`, "g");
    let match: RegExpExecArray | null;
    while ((match = beginRe.exec(content)) !== null) {
      const start = match.index;
      const opening = match[0];
      const envName = parseListEnv(opening);
      if (!envName) continue;

      const starred = opening.endsWith("*}");
      const bodyStart = start + opening.length;
      const endTag = endTagFor(envName, starred);
      const endIdx = findMatchingListEnd(content, bodyStart, envName);
      if (endIdx < 0) continue;

      const end = endIdx + endTag.length;
      if (clamped < start || clamped > end) continue;

      const span = end - start;
      if (!best || span < best.end - best.start) {
        best = {
          start,
          end,
          env: envName,
          itemCount: countLatexItems(content.slice(start, end)),
        };
      }
    }
  }

  return best;
}

function findMatchingListEnd(
  content: string,
  from: number,
  env: BulletListEnv,
): number {
  const beginRe = new RegExp(`\\\\begin\\{${env}\\*?\\}`, "g");
  const endRe = new RegExp(`\\\\end\\{${env}\\*?\\}`, "g");
  beginRe.lastIndex = from;
  endRe.lastIndex = from;

  let depth = 0;
  while (true) {
    const nextBegin = beginRe.exec(content);
    const nextEnd = endRe.exec(content);
    if (!nextEnd) return -1;

    if (nextBegin && nextBegin.index < nextEnd.index) {
      depth += 1;
      continue;
    }

    if (depth === 0) return nextEnd.index;
    depth -= 1;
  }
}

export function analyzeSelectionBullets(
  content: string,
  from: number,
  to: number,
): SelectionBulletStats {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const selectedText = content.slice(start, end);
  const selectedCount = countLatexItems(selectedText);
  const anchor = selectedCount > 0 ? (start + end) / 2 : start;
  const block = findEnclosingBulletList(content, anchor);

  return {
    selectedCount,
    block,
    isPartialBlock:
      !!block &&
      selectedCount > 0 &&
      selectedCount < block.itemCount &&
      start >= block.start &&
      end <= block.end,
  };
}

/** Quick-pick targets near the current count (e.g. 3 → [1, 2, 4, 5]). */
export function suggestedBulletTargets(current: number): number[] {
  const nearby = [current - 2, current - 1, current + 1, current + 2];
  const defaults = [1, 2, 3, 4, 5];
  const seen = new Set<number>();
  const out: number[] = [];

  for (const n of [...nearby, ...defaults]) {
    if (n === current) continue;
    const clamped = clampResumeBulletCount(n);
    if (seen.has(clamped)) continue;
    seen.add(clamped);
    out.push(clamped);
  }

  return out.slice(0, 4);
}

export function bulletTargetLabel(target: number): string {
  if (target === 1) return "Merge to 1";
  return `${target} bullets`;
}

export function bulletAdjustSummary(current: number, target: number): string {
  if (target < current) {
    return `Merge ${current} → ${target}`;
  }
  if (target > current) {
    return `Split ${current} → ${target}`;
  }
  return `${current} bullets`;
}

export function bulletCountSuccessMessage(
  current: number,
  target: number,
): string {
  if (target < current) {
    return `Merged ${current} bullets → ${target} — review the change`;
  }
  if (target > current) {
    return `Split ${current} bullets → ${target} — review the change`;
  }
  return "Bullet edit ready — review the change";
}

/** Instruction for inline edit / chat when reshaping bullet count. */
export function buildBulletCountInstruction(
  currentCount: number,
  targetCount: number,
  options?: { env?: BulletListEnv; roleLabel?: string },
): string {
  const envHint = options?.env
    ? ` Preserve the \\begin{${options.env}} / \\end{${options.env}} wrapper exactly.`
    : " Preserve any \\begin{itemize} / \\end{itemize} (or bullets/enumerate) wrapper.";

  const roleHint = options?.roleLabel
    ? ` This bullet list is for: ${options.roleLabel}.`
    : "";

  const action =
    targetCount < currentCount
      ? `Merge and consolidate the ${currentCount} bullet points into exactly ${targetCount} stronger bullet point${targetCount === 1 ? "" : "s"}`
      : targetCount > currentCount
        ? `Split and expand the ${currentCount} bullet point${currentCount === 1 ? "" : "s"} into exactly ${targetCount} distinct bullet points`
        : `Rewrite the ${currentCount} bullet points`;

  return (
    `${action}.${roleHint} ` +
    "Keep every fact truthful — do not invent metrics, tools, or responsibilities. " +
    "Each bullet must start with \\item and lead with a strong past-tense action verb. " +
    `${envHint} ` +
    "Keep role headings and lines outside the list unchanged. " +
    "Keep the same indentation and LaTeX style as the original selection."
  );
}

export interface RoleContext {
  title: string;
  company: string;
  /** Short label for UI, e.g. "Acme · Senior Engineer". */
  label: string;
}

function stripLatexInline(text: string): string {
  return text
    .replace(/\\\\/g, " ")
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?(\{[^}]*\})?/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Best-effort role heading immediately above a bullet list. */
export function findRoleContextBefore(
  content: string,
  blockStart: number,
): RoleContext | null {
  const before = content.slice(Math.max(0, blockStart - 1200), blockStart);

  const entryMatches = [
    ...before.matchAll(/\\entry\{([^}]*)\}\{[^}]*\}\{([^}]*)\}/g),
  ];
  const entry = entryMatches[entryMatches.length - 1];
  if (entry) {
    const title = stripLatexInline(entry[1]);
    const company = stripLatexInline(entry[2]);
    if (title || company) {
      return {
        title,
        company,
        label: company && title ? `${company} · ${title}` : title || company,
      };
    }
  }

  const cvMatches = [
    ...before.matchAll(/\\cventry\{([^}]*)\}\{[^}]*\}\{([^}]*)\}/g),
  ];
  const cv = cvMatches[cvMatches.length - 1];
  if (cv) {
    const title = stripLatexInline(cv[1]);
    const company = stripLatexInline(cv[2]);
    if (title || company) {
      return {
        title,
        company,
        label: company && title ? `${company} · ${title}` : title || company,
      };
    }
  }

  return null;
}
