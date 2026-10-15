import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { merge3Spans, splitLines, type MergeToolInfo } from '@gitslappin/shared';
import type { MergeOutputHandle } from './MergeOutput';

/** The editors work on LF text; each line's own EOL is put back when saving (see `withEols`). */
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

export interface ConflictView {
  /** Lines (LF, with their newline) of this conflict on each side. */
  a: string[];
  b: string[];
  /** 0-based first line and line count in the A text and in the B text. */
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
}

export interface MergeModel {
  conflicts: ConflictView[];
  /** Output text with every conflict empty. */
  initial: string;
  /** Character offset in `initial` where each conflict goes. */
  offsets: number[];
  aText: string;
  bText: string;
}

export function buildModel(info: MergeToolInfo): MergeModel {
  const spans = merge3Spans(info.base ?? '', info.a ?? '', info.b ?? '');
  const conflicts: ConflictView[] = [];
  const offsets: number[] = [];
  let out = '';
  let aPos = 0;
  let bPos = 0;
  for (const s of spans) {
    if (s.chunk.kind === 'stable') out += lf(s.chunk.lines.join(''));
    else {
      offsets.push(out.length);
      conflicts.push({ a: s.chunk.a.map(lf), b: s.chunk.b.map(lf), aStart: aPos, aLen: s.aLen, bStart: bPos, bLen: s.bLen });
    }
    aPos += s.aLen;
    bPos += s.bLen;
  }
  return { conflicts, initial: out, offsets, aText: lf(info.a ?? ''), bText: lf(info.b ?? '') };
}

/**
 * LF text back to the file's bytes: a line that comes from a side keeps that side's EOL; a line the user typed (or one whose
 * text sits in the sides with both EOLs) uses the file's majority EOL. The last line keeps having no EOL if it had none.
 */
export function withEols(text: string, info: MergeToolInfo): string {
  const known = new Map<string, string | null>();
  for (const src of [info.a, info.b, info.base]) {
    for (const line of splitLines(src ?? '')) {
      if (!line.endsWith('\n')) continue;
      const eol = line.endsWith('\r\n') ? '\r\n' : '\n';
      const body = line.slice(0, line.length - eol.length);
      if (!known.has(body)) known.set(body, eol);
      else if (known.get(body) !== eol) known.set(body, null);
    }
  }
  const majority = info.eol === 'crlf' ? '\r\n' : '\n';
  const parts = text.split('\n');
  return parts.map((p, i) => (i === parts.length - 1 ? p : p + (known.get(p) ?? majority))).join('');
}

export interface Take {
  a: boolean;
  b: boolean;
}

/** The output text of a conflict for a take. When both sides are taken and A's last line has no EOL, a newline goes between them. */
export function takeText(c: { a: string[]; b: string[] }, t: Take): string {
  const a = t.a ? c.a.join('') : '';
  const b = t.b ? c.b.join('') : '';
  return a !== '' && b !== '' && !a.endsWith('\n') ? `${a}\n${b}` : a + b;
}

/**
 * After a change that is not an apply (typing, or Undo/Redo inside the output): a take whose text no longer matches the region is
 * cleared (or moved to the take that does match). A region is resolved only if it is ticked and its text matches, or it was edited
 * away from empty.
 */
export function reconcileTakes(conflicts: Array<{ a: string[]; b: string[] }>, takes: Take[], edited: boolean[], hits: number[], texts: string[]): { takes: Take[]; edited: boolean[] } {
  const options: Take[] = [{ a: true, b: false }, { a: false, b: true }, { a: true, b: true }];
  const nextTakes = takes.map((t, i) => {
    const c = conflicts[i];
    const text = texts[i];
    if (!c || text === undefined) return t;
    if (takeText(c, t) === text && (t.a || t.b || text === '')) return t;
    return options.find((o) => takeText(c, o) === text) ?? { a: false, b: false };
  });
  const nextEdited = edited.map((e, i) => {
    if (!hits.includes(i)) return e;
    const t = nextTakes[i]!;
    return !t.a && !t.b && (texts[i] ?? '') !== '';
  });
  return { takes: nextTakes, edited: nextEdited };
}

export function useMergeModel(info: MergeToolInfo | null, output: RefObject<MergeOutputHandle | null>) {
  const model = useMemo(() => (info && !info.binary ? buildModel(info) : null), [info]);
  const count = model?.conflicts.length ?? 0;
  const [takes, setTakes] = useState<Take[]>([]);
  const [edited, setEdited] = useState<boolean[]>([]);
  const [current, setCurrent] = useState(0);
  const [reveal, setReveal] = useState({ index: 0, nonce: 0 });
  const takesRef = useRef(takes);
  takesRef.current = takes;

  useEffect(() => {
    setTakes(Array.from({ length: count }, () => ({ a: false, b: false })));
    setEdited(Array.from({ length: count }, () => false));
    setCurrent(0);
  }, [model, count]);

  const textFor = useCallback((i: number, t: Take): string => (model ? takeText(model.conflicts[i]!, t) : ''), [model]);

  const setTake = useCallback(
    (i: number, side: 'a' | 'b', on: boolean) => {
      const prev = takesRef.current[i];
      if (!prev || prev[side] === on) return;
      const next = { ...prev, [side]: on };
      setTakes((all) => all.map((t, k) => (k === i ? next : t)));
      setEdited((all) => all.map((e, k) => (k === i ? false : e)));
      output.current?.replaceRegion(i, textFor(i, next), !next.a && !next.b);
    },
    [output, textFor],
  );

  const toggle = useCallback((i: number, side: 'a' | 'b') => setTake(i, side, !takesRef.current[i]?.[side]), [setTake]);

  /** A side whose file is missing (deleted there) cannot be taken. */
  const available = (side: 'a' | 'b'): boolean => (side === 'a' ? info?.a : info?.b) !== null && info !== null;
  const allTaken = (side: 'a' | 'b'): boolean => count > 0 && takes.length === count && takes.every((t) => t[side]);
  const takeAll = useCallback(
    (side: 'a' | 'b') => {
      const all = takesRef.current.length > 0 && takesRef.current.every((t) => t[side]);
      for (let i = 0; i < takesRef.current.length; i++) setTake(i, side, !all);
    },
    [setTake],
  );

  const editedRef = useRef(edited);
  editedRef.current = edited;
  /** The output changed by typing, Undo or Redo: recompute the takes and edited flags from the region texts. */
  const markEdited = useCallback(
    (hits: number[], texts: string[]) => {
      if (!model) return;
      const next = reconcileTakes(model.conflicts, takesRef.current, editedRef.current, hits, texts);
      takesRef.current = next.takes;
      editedRef.current = next.edited;
      setTakes(next.takes);
      setEdited(next.edited);
    },
    [model],
  );

  const goTo = useCallback(
    (delta: 1 | -1) => {
      if (count === 0) return;
      const next = (current + delta + count) % count;
      setCurrent(next);
      setReveal((r) => ({ index: next, nonce: r.nonce + 1 }));
    },
    [count, current],
  );

  const unresolved = takes.filter((t, i) => !t.a && !t.b && !edited[i]).length;
  return { model, count, takes, edited, current, reveal, toggle, takeAll, allTaken, available, markEdited, goTo, unresolved };
}
