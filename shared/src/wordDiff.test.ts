import { describe, expect, it } from 'vitest';
import { wordDiff, wordDiffHunk, type DiffLine } from './wordDiff';

const changed = (segs: { text: string; changed: boolean }[]) => segs.filter((s) => s.changed).map((s) => s.text.trim());
const join = (segs: { text: string }[]) => segs.map((s) => s.text).join('');

const line = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text, oldNo: null, newNo: null });

describe('wordDiff', () => {
  it('marks only the changed word on each side and keeps the text lossless', () => {
    const r = wordDiff('let total = price * 2;', 'let total = cost * 2;');
    expect(r).not.toBeNull();
    expect(join(r!.old)).toBe('let total = price * 2;');
    expect(join(r!.new)).toBe('let total = cost * 2;');
    expect(changed(r!.old)).toEqual(['price']);
    expect(changed(r!.new)).toEqual(['cost']);
  });

  it('marks an inserted word only on the new side', () => {
    const r = wordDiff('a b', 'a x b');
    expect(changed(r!.old)).toEqual([]);
    expect(changed(r!.new)).toEqual(['x']);
  });

  it('skips lines over 500 characters', () => {
    const long = 'w '.repeat(260); // 520 chars
    expect(long.length).toBeGreaterThan(500);
    expect(wordDiff(long, long + 'x')).toBeNull();
    expect(wordDiff('a', long)).toBeNull();
  });

  it('still diffs a line of exactly 500 characters or less', () => {
    const ok = 'w '.repeat(50); // 100 chars, 50 words
    expect(wordDiff(ok, ok + 'x')).not.toBeNull();
  });

  it('skips lines over 200 tokens (token cap)', () => {
    const tooMany = 'a '.repeat(240); // 480 chars (under the 500 limit), 240 words
    expect(tooMany.length).toBeLessThanOrEqual(500);
    expect(wordDiff(tooMany, tooMany + 'z')).toBeNull();
  });
});

describe('wordDiffHunk', () => {
  it('pairs -/+ lines only inside equal-count blocks', () => {
    const lines = [line('context', 'c'), line('del', 'foo 1'), line('del', 'bar 1'), line('add', 'foo 2'), line('add', 'bar 2'), line('context', 'd')];
    const r = wordDiffHunk(lines);
    expect(r).toHaveLength(lines.length);
    expect(r[0]).toBeNull();
    expect(r[5]).toBeNull();
    for (const i of [1, 2, 3, 4]) expect(r[i]).not.toBeNull();
    expect(changed(r[1]!)).toEqual(['1']);
    expect(changed(r[3]!)).toEqual(['2']);
  });

  it('does not pair unequal-count blocks', () => {
    const lines = [line('del', 'foo 1'), line('del', 'bar 1'), line('add', 'foo 2')];
    const r = wordDiffHunk(lines);
    expect(r).toEqual([null, null, null]);
  });

  it('is skipped for hunks with over 200 changed lines', () => {
    const lines: DiffLine[] = [];
    for (let i = 0; i < 101; i++) lines.push(line('del', `old ${i}`));
    for (let i = 0; i < 101; i++) lines.push(line('add', `new ${i}`));
    const r = wordDiffHunk(lines);
    expect(r.every((x) => x === null)).toBe(true);
  });

  it('runs for a hunk of exactly 200 changed lines', () => {
    const lines: DiffLine[] = [];
    for (let i = 0; i < 100; i++) lines.push(line('del', `old ${i}`));
    for (let i = 0; i < 100; i++) lines.push(line('add', `new ${i}`));
    const r = wordDiffHunk(lines);
    expect(r.some((x) => x !== null)).toBe(true);
  });
});
