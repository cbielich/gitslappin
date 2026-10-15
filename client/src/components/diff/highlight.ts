import type { Seg } from '@gitslappin/shared';
import type { MonacoApi } from '../../lib/monaco';

export interface TokSpan {
  start: number;
  end: number;
  cls: string;
}

export interface Piece {
  text: string;
  cls: string;
  changed: boolean;
}

/**
 * Monaco token type ("keyword.flow.ts") to CSS classes ("tok-keyword tok-keyword-flow"). Only [a-z0-9] parts are
 * used, so a class name is never built from file text. The language suffix is dropped.
 */
const tokClass = (type: string): string => {
  const [first, second] = type.split('.').map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, ''));
  if (!first || first === 'white') return '';
  return second ? `tok-${first} tok-${first}-${second}` : `tok-${first}`;
};

/** Tokenizes a hunk as one block. Returns one span list per input line. Never produces HTML. */
export function tokenizeLines(monaco: MonacoApi, lines: string[], languageId: string): TokSpan[][] {
  const clean = lines.map((l) => l.replace(/\r$/, ''));
  const tokens = monaco.editor.tokenize(clean.join('\n'), languageId);
  return clean.map((text, i) => {
    const toks = tokens[i] ?? [];
    return toks.map((t, k) => ({ start: t.offset, end: toks[k + 1]?.offset ?? text.length, cls: tokClass(t.type) }));
  });
}

/** Splits a line at every token and word-diff boundary. */
export function toPieces(text: string, toks: TokSpan[] | undefined, segs: Seg[] | null | undefined): Piece[] {
  const cuts = new Set<number>([0, text.length]);
  for (const t of toks ?? []) {
    cuts.add(Math.min(t.start, text.length));
    cuts.add(Math.min(t.end, text.length));
  }
  let pos = 0;
  const segRanges: { start: number; end: number; changed: boolean }[] = [];
  for (const s of segs ?? []) {
    segRanges.push({ start: pos, end: pos + s.text.length, changed: s.changed });
    pos += s.text.length;
    cuts.add(Math.min(pos, text.length));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Piece[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b <= a) continue;
    const tok = toks?.find((t) => t.start <= a && a < t.end);
    const seg = segRanges.find((r) => r.start <= a && a < r.end);
    out.push({ text: text.slice(a, b), cls: tok?.cls ?? '', changed: seg?.changed ?? false });
  }
  return out;
}
