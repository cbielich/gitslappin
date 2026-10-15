import { describe, expect, it } from 'vitest';
import { merge3, type Merge3Chunk } from './merge3';

/*
 * Contract the builder must export from shared/src/merge3.ts:
 *   export type Merge3Chunk =
 *     | { kind: 'stable'; lines: string[] }                              // text that needs no decision (common, one-sided or identical change)
 *     | { kind: 'conflict'; base: string[]; a: string[]; b: string[] }   // both sides changed the same region differently
 *   export function merge3(base: string, a: string, b: string): Merge3Chunk[]
 * Every line keeps its own EOL ("\n" or "\r\n"); the last line has none when the text does not end in a newline.
 * A line that differs only by its EOL is a different line. Adjacent chunks of the same kind are merged into one.
 * Contract choices made by the test author (the design leaves them open): changes that touch with no unchanged line
 * between them are ONE conflict (as git does); merge3('', '', '') gives [].
 */

const stable = (...lines: string[]): Merge3Chunk => ({ kind: 'stable', lines });
const conflict = (base: string[], a: string[], b: string[]): Merge3Chunk => ({ kind: 'conflict', base, a, b });
const joined = (chunks: Merge3Chunk[]): string => chunks.map((c) => (c.kind === 'stable' ? c.lines.join('') : '<CONFLICT>')).join('');
const conflicts = (chunks: Merge3Chunk[]): number => chunks.filter((c) => c.kind === 'conflict').length;

describe('merge3', () => {
  it('three identical texts are one stable chunk', () => {
    expect(merge3('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nc\n')).toEqual([stable('a\n', 'b\n', 'c\n')]);
  });

  it('empty everywhere gives no chunks', () => {
    expect(merge3('', '', '')).toEqual([]);
  });

  it('a change only on side A is stable and taken', () => {
    const r = merge3('a\nb\nc\n', 'a\nX\nc\n', 'a\nb\nc\n');
    expect(conflicts(r)).toBe(0);
    expect(joined(r)).toBe('a\nX\nc\n');
  });

  it('a change only on side B is stable and taken', () => {
    const r = merge3('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nY\n');
    expect(conflicts(r)).toBe(0);
    expect(joined(r)).toBe('a\nb\nY\n');
  });

  it('the same change on both sides is stable (no conflict)', () => {
    const r = merge3('a\nb\nc\n', 'a\nZ\nc\n', 'a\nZ\nc\n');
    expect(r).toEqual([stable('a\n', 'Z\n', 'c\n')]);
  });

  it('overlapping different changes give one conflict between stable text', () => {
    expect(merge3('a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n')).toEqual([stable('a\n'), conflict(['b\n'], ['X\n'], ['Y\n']), stable('c\n')]);
  });

  it('A deletes a line B edits: conflict with an empty A side', () => {
    expect(merge3('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n')).toEqual([stable('a\n'), conflict(['b\n'], [], ['B\n']), stable('c\n')]);
  });

  it('changes separated by an unchanged line are both taken (two non-conflicting hunks)', () => {
    const r = merge3('1\n2\n3\n4\n5\n', 'A\n2\n3\n4\n5\n', '1\n2\n3\n4\nB\n');
    expect(conflicts(r)).toBe(0);
    expect(joined(r)).toBe('A\n2\n3\n4\nB\n');
  });

  it('adjacent changes (no unchanged line between) are one conflict', () => {
    const r = merge3('a\nb\nc\n', 'X\nb\nc\n', 'a\nY\nc\n');
    expect(conflicts(r)).toBe(1);
    expect(r[r.length - 1]).toEqual(stable('c\n'));
    const c = r.find((x) => x.kind === 'conflict');
    expect(c).toEqual(conflict(['a\n', 'b\n'], ['X\n', 'b\n'], ['a\n', 'Y\n']));
  });

  it('two separate conflicts stay two chunks in order', () => {
    const r = merge3('a\nb\nc\nd\ne\n', 'a\nX\nc\nP\ne\n', 'a\nY\nc\nQ\ne\n');
    expect(r.map((c) => c.kind)).toEqual(['stable', 'conflict', 'stable', 'conflict', 'stable']);
    expect(r[1]).toEqual(conflict(['b\n'], ['X\n'], ['Y\n']));
    expect(r[3]).toEqual(conflict(['d\n'], ['P\n'], ['Q\n']));
  });

  it('both sides insert different text at the same place', () => {
    expect(merge3('a\nc\n', 'a\nA1\nc\n', 'a\nB1\nc\n')).toEqual([stable('a\n'), conflict([], ['A1\n'], ['B1\n']), stable('c\n')]);
  });

  it('missing newline at EOF: B only adds it, no conflict', () => {
    const r = merge3('a\nb', 'a\nb', 'a\nb\n');
    expect(conflicts(r)).toBe(0);
    expect(joined(r)).toBe('a\nb\n');
  });

  it('missing newline at EOF: both sides drop it identically, so the result has none', () => {
    const r = merge3('a\nb\n', 'a\nb', 'a\nb');
    expect(conflicts(r)).toBe(0);
    expect(joined(r)).toBe('a\nb');
  });

  it('missing newline at EOF counts as a difference when the other side edits the same last line', () => {
    expect(merge3('a\nb\n', 'a\nb', 'a\nB\n')).toEqual([stable('a\n'), conflict(['b\n'], ['b'], ['B\n'])]);
  });

  it('CRLF text keeps "\\r\\n" on every line in chunks', () => {
    const r = merge3('a\r\nb\r\nc\r\n', 'a\r\nX\r\nc\r\n', 'a\r\nY\r\nc\r\n');
    expect(r).toEqual([stable('a\r\n'), conflict(['b\r\n'], ['X\r\n'], ['Y\r\n']), stable('c\r\n')]);
  });

  it('mixed EOL: each stable line keeps the EOL it had, one-sided change taken from A', () => {
    const r = merge3('a\nb\r\nc\n', 'x\nb\r\nc\n', 'a\nb\r\nc\n');
    expect(conflicts(r)).toBe(0);
    expect(joined(r)).toBe('x\nb\r\nc\n');
  });

  it('a line that differs only by its EOL is a change (A switched b to LF, B untouched)', () => {
    const r = merge3('a\r\nb\r\nc\r\n', 'a\r\nb\nc\r\n', 'a\r\nb\r\nc\r\n');
    expect(conflicts(r)).toBe(0);
    expect(joined(r)).toBe('a\r\nb\nc\r\n');
  });

  it('a line that differs only by its EOL on both sides, differently, is a conflict', () => {
    const r = merge3('a\nb\nc\n', 'a\nb\r\nc\n', 'a\nB\nc\n');
    expect(r).toEqual([stable('a\n'), conflict(['b\n'], ['b\r\n'], ['B\n']), stable('c\n')]);
  });

  it('empty base, both sides add different text (add/add) is one conflict with an empty base', () => {
    expect(merge3('', 'x\n', 'y\n')).toEqual([conflict([], ['x\n'], ['y\n'])]);
  });

  it('empty base, both sides add the same text is stable', () => {
    expect(merge3('', 'x\ny\n', 'x\ny\n')).toEqual([stable('x\n', 'y\n')]);
  });

  it('empty base, only one side adds text is stable', () => {
    expect(merge3('', 'x\n', '')).toEqual([stable('x\n')]);
    expect(merge3('', '', 'y\n')).toEqual([stable('y\n')]);
  });

  it('empty base, add/add with a shared first line gives stable text then a conflict', () => {
    expect(merge3('', 'same\nA\n', 'same\nB\n')).toEqual([stable('same\n'), conflict([], ['A\n'], ['B\n'])]);
  });
});

describe('merge3 on very large input', () => {
  it('handles 300k lines (one-sided changes, one conflict, and a one-sided rewrite) without a stack overflow', () => {
    const n = 300_000;
    const lines = Array.from({ length: n }, (_, i) => `line ${i}\n`);
    const base = lines.join('');
    const withLine = (k: number, text: string): string => lines.map((l, i) => (i === k ? text : l)).join('');
    const out = merge3(base, withLine(10, 'A\n'), withLine(n - 10, 'B\n'));
    expect(conflicts(out)).toBe(0);
    expect(joined(out)).toBe(withLine(10, 'A\n').replace(`line ${n - 10}\n`, 'B\n'));
    expect(conflicts(merge3(base, withLine(150_000, 'A\n'), withLine(150_000, 'B\n')))).toBe(1);
    const all = Array.from({ length: n }, (_, i) => `other ${i}\n`).join('');
    expect(joined(merge3(base, all, base))).toBe(all);
  });
});
