/*
 * Three-way merge (diff3) for the merge tool. Pure: no Node or DOM APIs.
 * Lines keep their own EOL, so a line that differs only by its EOL (or a missing newline at EOF) is a different line.
 */

export type Merge3Chunk =
  | { kind: 'stable'; lines: string[] }
  | { kind: 'conflict'; base: string[]; a: string[]; b: string[] };

/** Past this many edits the diff gives up and treats the middle as one replaced block (still correct, just coarser). */
const MAX_EDITS = 3000;

export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

interface Hunk {
  /** Replaces base lines [bs, be) with `lines`. */
  bs: number;
  be: number;
  lines: string[];
}

/** Matching line pairs [i, j] (a[i] === b[j]) in order, by Myers' O(ND) algorithm, or null when there are too many edits. */
function matchPairs(a: string[], b: string[]): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + off]! < v[k + 1 + off]!)) x = v[k + 1 + off]!;
      else x = v[k - 1 + off]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + off] = x;
      if (x >= n && y >= m) found = d;
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return null;
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 1; d--) {
    const prev = trace[d - 1]!;
    const at = (kk: number): number => prev[kk + (d - 1)]!;
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) {
      pairs.push([x - 1, y - 1]);
      x--;
      y--;
    }
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    pairs.push([x - 1, y - 1]);
    x--;
    y--;
  }
  return pairs.reverse();
}

/** The changes that turn `base` into `other`, as hunks over base line ranges. */
function diffHunks(base: string[], other: string[]): Hunk[] {
  let pre = 0;
  while (pre < base.length && pre < other.length && base[pre] === other[pre]) pre++;
  let suf = 0;
  while (suf < base.length - pre && suf < other.length - pre && base[base.length - 1 - suf] === other[other.length - 1 - suf]) suf++;
  const a = base.slice(pre, base.length - suf);
  const b = other.slice(pre, other.length - suf);
  if (a.length === 0 && b.length === 0) return [];
  const pairs = matchPairs(a, b);
  const hunks: Hunk[] = [];
  if (!pairs) return [{ bs: pre, be: pre + a.length, lines: b }];
  let pa = 0;
  let pb = 0;
  for (const [i, j] of pairs) {
    if (i > pa || j > pb) hunks.push({ bs: pre + pa, be: pre + i, lines: b.slice(pb, j) });
    pa = i + 1;
    pb = j + 1;
  }
  if (a.length > pa || b.length > pb) hunks.push({ bs: pre + pa, be: pre + a.length, lines: b.slice(pb) });
  return hunks;
}

/** `base[gs, ge)` with this side's hunks (all inside the range) applied. */
function applyHunks(base: string[], hunks: Hunk[], gs: number, ge: number): string[] {
  const out: string[] = [];
  let pos = gs;
  for (const h of hunks) {
    for (let i = pos; i < h.bs; i++) out.push(base[i]!);
    for (const l of h.lines) out.push(l);
    pos = h.be;
  }
  for (let i = pos; i < ge; i++) out.push(base[i]!);
  return out;
}

const same = (x: string[], y: string[]): boolean => x.length === y.length && x.every((l, i) => l === y[i]);

/** A chunk and how many lines it covers in the A text and in the B text (a stable chunk can differ there: it holds the taken side). */
export interface Merge3Span {
  chunk: Merge3Chunk;
  aLen: number;
  bLen: number;
}

export function merge3(baseText: string, aText: string, bText: string): Merge3Chunk[] {
  return merge3Spans(baseText, aText, bText).map((s) => s.chunk);
}

export function merge3Spans(baseText: string, aText: string, bText: string): Merge3Span[] {
  const base = splitLines(baseText);
  const ha = diffHunks(base, splitLines(aText));
  const hb = diffHunks(base, splitLines(bText));
  const tagged = [...ha.map((h) => ({ h, side: 'a' as const })), ...hb.map((h) => ({ h, side: 'b' as const }))].sort((p, q) => p.h.bs - q.h.bs || p.h.be - q.h.be);

  const spans: Merge3Span[] = [];
  const pushStable = (lines: string[], aLen = lines.length, bLen = lines.length): void => {
    if (lines.length === 0 && aLen === 0 && bLen === 0) return;
    const last = spans[spans.length - 1];
    if (last?.chunk.kind === 'stable') {
      for (const l of lines) last.chunk.lines.push(l);
      last.aLen += aLen;
      last.bLen += bLen;
    } else spans.push({ chunk: { kind: 'stable', lines: [...lines] }, aLen, bLen });
  };

  let pos = 0;
  let i = 0;
  while (i < tagged.length) {
    // A group: changes that overlap or touch (no unchanged line between them).
    const gs = tagged[i]!.h.bs;
    let ge = tagged[i]!.h.be;
    let j = i + 1;
    while (j < tagged.length && tagged[j]!.h.bs <= ge) {
      ge = Math.max(ge, tagged[j]!.h.be);
      j++;
    }
    const group = tagged.slice(i, j);
    i = j;
    pushStable(base.slice(pos, gs));
    pos = ge;
    const aHunks = group.filter((t) => t.side === 'a').map((t) => t.h);
    const bHunks = group.filter((t) => t.side === 'b').map((t) => t.h);
    if (bHunks.length === 0 || aHunks.length === 0) {
      const taken = applyHunks(base, aHunks.length > 0 ? aHunks : bHunks, gs, ge);
      const aLen = aHunks.length > 0 ? taken.length : ge - gs;
      pushStable(taken, aLen, aHunks.length > 0 ? ge - gs : taken.length);
      continue;
    }
    let a = applyHunks(base, aHunks, gs, ge);
    let b = applyHunks(base, bHunks, gs, ge);
    if (same(a, b)) {
      pushStable(a);
      continue;
    }
    let bs = base.slice(gs, ge);
    // Lines both sides agree on at the start and end of the group are not part of the conflict.
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    pushStable(a.slice(0, pre));
    if (pre > 0 && pre <= bs.length && same(bs.slice(0, pre), a.slice(0, pre))) bs = bs.slice(pre);
    a = a.slice(pre);
    b = b.slice(pre);
    let suf = 0;
    while (suf < a.length && suf < b.length && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const tail = suf > 0 ? a.slice(a.length - suf) : [];
    if (suf > 0 && suf <= bs.length && same(bs.slice(bs.length - suf), tail)) bs = bs.slice(0, bs.length - suf);
    a = a.slice(0, a.length - suf);
    b = b.slice(0, b.length - suf);
    spans.push({ chunk: { kind: 'conflict', base: bs, a, b }, aLen: a.length, bLen: b.length });
    pushStable(tail);
  }
  pushStable(base.slice(pos));
  return spans;
}
