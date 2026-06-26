/** A token in a word-level diff (word or whitespace run). */
export type WordPart = { type: "context" | "del" | "add"; text: string };

const WORD_TOKEN_CAP = 4000;

/** Split text into words and whitespace runs, preserving spacing. */
export function tokenizeWords(text: string): string[] {
  const tokens: string[] = [];
  const re = /\s+|\S+/g;
  let match = re.exec(text);
  while (match) {
    tokens.push(match[0]);
    match = re.exec(text);
  }
  return tokens;
}

/**
 * Word-level diff via LCS. Falls back to delete-all + add-all when token
 * counts are large enough to make O(n·m) costly.
 */
export function wordDiff(oldText: string, newText: string): WordPart[] {
  const a = tokenizeWords(oldText);
  const b = tokenizeWords(newText);
  const n = a.length;
  const m = b.length;

  if (n > WORD_TOKEN_CAP || m > WORD_TOKEN_CAP) {
    return [
      ...a.map((text): WordPart => ({ type: "del", text })),
      ...b.map((text): WordPart => ({ type: "add", text })),
    ];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: WordPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}
