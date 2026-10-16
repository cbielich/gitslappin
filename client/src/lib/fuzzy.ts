/** Command palette matching: a case-insensitive match on the label (ranges to highlight) or, failing that, on the keywords (nothing to highlight). */
export type Range = [number, number];
export interface FuzzyHit {
  score: number;
  ranges: Range[];
}

/** Characters of `q` as a subsequence of `text`; returns the matched indexes, or null. */
function subsequence(q: string, text: string): number[] | null {
  const at: number[] = [];
  let from = 0;
  for (const ch of q) {
    const i = text.indexOf(ch, from);
    if (i < 0) return null;
    at.push(i);
    from = i + 1;
  }
  return at;
}

function toRanges(idx: number[]): Range[] {
  const out: Range[] = [];
  for (const i of idx) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

export function fuzzyMatch(query: string, label: string, keywords?: string): FuzzyHit | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, ranges: [] };
  const l = label.toLowerCase();
  const at = l.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || l[at - 1] === ' ';
    return { score: 1000 - at + (wordStart ? 200 : 0), ranges: [[at, at + q.length]] };
  }
  const sub = subsequence(q, l);
  if (sub) {
    const ranges = toRanges(sub);
    return { score: 400 - ranges.length * 10 - sub[0]!, ranges };
  }
  if (keywords?.toLowerCase().includes(q)) return { score: 10, ranges: [] };
  return null;
}

/** Drops non-matches, best first (ties keep the input order); an empty query keeps the input order. */
export function fuzzyRank<T extends { label: string; keywords?: string }>(items: T[], query: string): Array<{ item: T; ranges: Range[] }> {
  const hits: Array<{ item: T; ranges: Range[]; score: number; i: number }> = [];
  items.forEach((item, i) => {
    const m = fuzzyMatch(query, item.label, item.keywords);
    if (m) hits.push({ item, ranges: m.ranges, score: m.score, i });
  });
  if (!query.trim()) return hits.map(({ item, ranges }) => ({ item, ranges }));
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  return hits.map(({ item, ranges }) => ({ item, ranges }));
}
