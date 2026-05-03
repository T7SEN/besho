// src/lib/text-diff.ts

export type DiffLineType = "add" | "remove" | "context";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/**
 * Line-level diff using longest-common-subsequence DP. Returns the
 * union of both inputs marked as `add` (only in newText), `remove`
 * (only in oldText), or `context` (in both). Suitable for short
 * documents — O(m*n) memory, fine at ≤ a few thousand lines.
 *
 * No external dependency. Stable on identical input (returns all
 * context). Empty inputs handled (one all-add, one all-remove).
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
  const newLines = newText.length === 0 ? [] : newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) return newLines.map((text) => ({ type: "add", text }));
  if (n === 0) return oldLines.map((text) => ({ type: "remove", text }));

  // LCS DP — dp[i][j] = LCS length of oldLines[0..i) and newLines[0..j).
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp.push(new Array<number>(n + 1).fill(0));
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Walk DP back-to-front to reconstruct the diff.
  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: "context", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "add", text: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: "remove", text: oldLines[i - 1] });
      i--;
    }
  }
  return result;
}

export function diffStats(diff: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.type === "add") added++;
    else if (line.type === "remove") removed++;
  }
  return { added, removed };
}
