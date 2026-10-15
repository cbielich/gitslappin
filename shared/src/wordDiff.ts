import type { DiffLine } from './diff';

export type { DiffLine } from './diff';

export interface Seg {
  text: string;
  changed: boolean;
}

export const WORD_DIFF_MAX_CHARS = 500;
export const WORD_DIFF_MAX_TOKENS = 200;
export const WORD_DIFF_MAX_CHANGED_LINES = 200;

const TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu;

const tokenize = (s: string): string[] => s.match(TOKEN_RE) ?? [];

function toSegs(tokens: string[], keep: boolean[]): Seg[] {
  const out: Seg[] = [];
  tokens.forEach((t, i) => {
    const changed = !keep[i];
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += t;
    else out.push({ text: t, changed });
  });
  return out;
}

/** Token LCS between two lines. Null when a line is too long (over 500 chars or 200 tokens). */
export function wordDiff(oldText: string, newText: string): { old: Seg[]; new: Seg[] } | null {
  if (oldText.length > WORD_DIFF_MAX_CHARS || newText.length > WORD_DIFF_MAX_CHARS) return null;
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length > WORD_DIFF_MAX_TOKENS || b.length > WORD_DIFF_MAX_TOKENS) return null;
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const keepA = new Array<boolean>(n).fill(false);
  const keepB = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keepA[i] = true;
      keepB[j] = true;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return { old: toSegs(a, keepA), new: toSegs(b, keepB) };
}

/**
 * Word diff for every line of a hunk (same length as `lines`). Lines are paired only inside a block
 * of deletions followed by additions with equal counts. Hunks with over 200 changed lines are skipped.
 */
export function wordDiffHunk(lines: DiffLine[]): (Seg[] | null)[] {
  const out: (Seg[] | null)[] = lines.map(() => null);
  let changedCount = 0;
  for (const l of lines) if (l.kind !== 'context') changedCount++;
  if (changedCount > WORD_DIFF_MAX_CHANGED_LINES) return out;

  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i]!.kind === 'del') i++;
    const addStart = i;
    while (i < lines.length && lines[i]!.kind === 'add') i++;
    const dels = addStart - delStart;
    const adds = i - addStart;
    if (dels !== adds || adds === 0) continue;
    for (let k = 0; k < dels; k++) {
      const r = wordDiff(lines[delStart + k]!.text, lines[addStart + k]!.text);
      if (r) {
        out[delStart + k] = r.old;
        out[addStart + k] = r.new;
      }
    }
  }
  return out;
}
