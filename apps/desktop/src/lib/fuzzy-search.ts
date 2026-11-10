/** Fields the slash-command scorer reads. `SlashCommand` satisfies this. */
export interface ScorableCommand {
  name: string;
  full_command: string;
  description?: string | null;
}

const SCORE_GAP_LEADING = -0.005;
const SCORE_GAP_TRAILING = -0.005;
const SCORE_GAP_INNER = -0.01;
/** Consecutive-character match. Locked by `fuzzy-search.test.ts`. */
export const SCORE_MATCH_CONSECUTIVE = 1.0;
const SCORE_MATCH_SLASH = 0.9;
const SCORE_MATCH_WORD = 0.8;
const SCORE_MATCH_CAPITAL = 0.7;
const SCORE_MATCH_DOT = 0.6;
const SCORE_MAX_LEADING_GAP = -0.05;

function bonusFor(prev: string, curr: string): number {
  if (prev === "/") return SCORE_MATCH_SLASH;
  if (prev === "-" || prev === "_" || prev === " ") return SCORE_MATCH_WORD;
  if (prev === ".") return SCORE_MATCH_DOT;
  if (prev === prev.toLowerCase() && curr === curr.toUpperCase())
    return SCORE_MATCH_CAPITAL;
  return 0;
}

/** Score query against candidate. Returns -Infinity if no match. */
export function fuzzyScore(query: string, candidate: string): number {
  const n = query.length;
  const m = candidate.length;

  if (n === 0) return 0;
  if (n > m) return -Infinity;

  const qLower = query.toLowerCase();
  const cLower = candidate.toLowerCase();

  // Quick check: all query chars exist in candidate in order
  let qi = 0;
  for (let ci = 0; ci < m && qi < n; ci++) {
    if (qLower[qi] === cLower[ci]) qi++;
  }
  if (qi < n) return -Infinity;

  // Score matrix (simplified fzy)
  // D[i][j] = best score ending with query[i] matching candidate[j] consecutively
  // M[i][j] = best score for query[0..i] matching within candidate[0..j]
  const D: number[][] = [];
  const M: number[][] = [];
  for (let i = 0; i < n; i++) {
    D.push(new Array(m).fill(-Infinity));
    M.push(new Array(m).fill(-Infinity));
  }

  for (let i = 0; i < n; i++) {
    let prevScore = -Infinity;
    const gapScore = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER;

    for (let j = 0; j < m; j++) {
      if (qLower[i] === cLower[j]) {
        let score = 0;

        if (i === 0) {
          // First char of query
          score =
            j === 0
              ? SCORE_MATCH_CONSECUTIVE // start of string
              : Math.max(SCORE_MAX_LEADING_GAP, SCORE_GAP_LEADING * j) +
                bonusFor(candidate[j - 1], candidate[j]);
        } else if (j > 0) {
          // Consecutive match bonus
          const consecutive = D[i - 1][j - 1] + SCORE_MATCH_CONSECUTIVE;
          // Non-consecutive: gap penalty from best previous match
          const boundary =
            M[i - 1][j - 1] + bonusFor(candidate[j - 1], candidate[j]);
          score = Math.max(consecutive, boundary);
        }

        D[i][j] = score;
        M[i][j] = Math.max(score, prevScore + gapScore);
      } else {
        D[i][j] = -Infinity;
        M[i][j] = prevScore + gapScore;
      }

      prevScore = M[i][j];
    }
  }

  return M[n - 1][m - 1];
}

/** Levenshtein distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  const dp: number[] = Array.from({ length: m + 1 }, (_, i) => i);

  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = tmp;
    }
  }

  return dp[m];
}

/**
 * Typo-tolerant score: find the best-matching substring of candidate
 * within a window around the query length, then compute edit distance.
 * Handles "bioarxiv" → "biorxiv-database" (matches the "biorxiv" part).
 */
export function typoScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const maxDist = Math.max(1, Math.floor(q.length / 3));

  // Slide a window of varying size over the candidate to find the closest substring
  let bestDist = Infinity;
  const minWin = Math.max(1, q.length - maxDist);
  const maxWin = q.length + maxDist;

  for (let winLen = minWin; winLen <= maxWin && winLen <= c.length; winLen++) {
    for (let start = 0; start + winLen <= c.length; start++) {
      const sub = c.slice(start, start + winLen);
      const dist = levenshtein(q, sub);
      if (dist < bestDist) {
        bestDist = dist;
        if (dist === 0) break;
      }
    }
    if (bestDist === 0) break;
  }

  if (bestDist > maxDist) return -Infinity;
  // Score: always below fuzzy matches, closer distance = higher score
  return -0.5 - bestDist * 0.5;
}

/** Score a command against the query, checking multiple fields. */
export function scoreCommand(cmd: ScorableCommand, q: string): number {
  const cmdKey = cmd.full_command.slice(1); // strip leading /

  // 1. Fuzzy subsequence matching on command key and name (short strings, reliable)
  const cmdScore = fuzzyScore(q, cmdKey);
  const nameScore = fuzzyScore(q, cmd.name);

  // 2. Description: only substring (contains) match to avoid false positives on long text
  let descScore = -Infinity;
  if (cmd.description?.toLowerCase().includes(q.toLowerCase())) {
    descScore = q.length * 0.3; // modest score for description-only match
  }

  const fuzzy = Math.max(cmdScore, nameScore, descScore);
  if (fuzzy > -Infinity) return fuzzy;

  // 3. Typo-tolerant fallback on command key / name (handles bioarxiv → biorxiv)
  const typo = Math.max(typoScore(q, cmdKey), typoScore(q, cmd.name));

  return typo;
}
