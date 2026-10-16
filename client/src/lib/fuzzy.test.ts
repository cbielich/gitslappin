import { describe, expect, it } from 'vitest';
import { fuzzyMatch, fuzzyRank } from './fuzzy';

/*
 * V6 design "3 Command palette": pure client/src/lib/fuzzy.ts "matches label + *Keywords and highlights the matched characters" (screen 34a). Contract chosen by the test author:
 *   fuzzyMatch(query: string, label: string, keywords?: string): { score: number; ranges: Array<[number, number]> } | null
 *     case-insensitive subsequence match on the label; ranges are [start, end) index pairs INTO THE LABEL, adjacent characters merged into one range, ascending.
 *     When the label does not match but the keywords do, the result is non-null with ranges = [] (nothing in the label to highlight).
 *     Empty (or whitespace-only) query matches everything with ranges = [].  null = no match.
 *   fuzzyRank<T extends { label: string; keywords?: string }>(items: T[], query: string): Array<{ item: T; ranges: Array<[number, number]> }>
 *     drops non-matches; best match first; for an empty query keeps the input order unchanged.
 *     Order of strength: a label match beats a keywords-only match; among label matches a prefix / contiguous match beats a scattered one.
 */

describe('fuzzyMatch', () => {
  it('is case-insensitive and returns the matched character ranges in the label', () => {
    const m = fuzzyMatch('cb', 'Create Branch');
    expect(m).not.toBeNull();
    expect(m!.ranges).toEqual([
      [0, 1],
      [7, 8],
    ]);
    expect(fuzzyMatch('CB', 'create branch')!.ranges).toEqual([
      [0, 1],
      [7, 8],
    ]);
  });
  it('merges adjacent matched characters into one range', () => {
    expect(fuzzyMatch('crea', 'Create Branch')!.ranges).toEqual([[0, 4]]);
    expect(fuzzyMatch('stash', 'Stash: Pop')!.ranges).toEqual([[0, 5]]);
  });
  it('returns null when the query is not a subsequence of the label or its keywords', () => {
    expect(fuzzyMatch('zzz', 'Create Branch')).toBeNull();
    expect(fuzzyMatch('zq', 'Create Branch', 'make new')).toBeNull();
  });
  it('order matters: the characters must appear in query order', () => {
    expect(fuzzyMatch('hb', 'Create Branch')).toBeNull(); // the only 'h' is the last letter, no 'b' after it
  });
  it('matches through the keywords with nothing to highlight', () => {
    const m = fuzzyMatch('explorer', 'Open in file manager', 'folder explorer finder');
    expect(m).not.toBeNull();
    expect(m!.ranges).toEqual([]);
  });
  it('an empty query matches with no ranges', () => {
    expect(fuzzyMatch('', 'Anything')!.ranges).toEqual([]);
    expect(fuzzyMatch('   ', 'Anything')!.ranges).toEqual([]);
  });
});

describe('fuzzyRank', () => {
  const items = [{ label: 'Open Repo' }, { label: 'Rename Branch' }, { label: 'Reset Zoom' }, { label: 'Fetch All' }];
  it('a prefix match ranks above a later contiguous match; non-matches are dropped', () => {
    const r = fuzzyRank(items, 're').map((x) => x.item.label);
    expect(new Set(r.slice(0, 2))).toEqual(new Set(['Rename Branch', 'Reset Zoom']));
    expect(r[2]).toBe('Open Repo');
    expect(r).not.toContain('Fetch All');
    expect(r).toHaveLength(3);
  });
  it('a contiguous match beats a scattered one', () => {
    const r = fuzzyRank([{ label: 'Toggle Left Panel' }, { label: 'Stash: Pop' }, { label: 'Settings Page' }], 'pop').map((x) => x.item.label);
    expect(r[0]).toBe('Stash: Pop');
  });
  it('a label match beats a keywords-only match, and the keywords-only item still appears with no ranges', () => {
    const r = fuzzyRank([{ label: 'Open in file manager', keywords: 'folder explorer finder' }, { label: 'Explorer Tab' }], 'explorer');
    expect(r.map((x) => x.item.label)).toEqual(['Explorer Tab', 'Open in file manager']);
    expect(r[0]!.ranges).toEqual([[0, 8]]);
    expect(r[1]!.ranges).toEqual([]);
  });
  it('the empty query keeps the order and returns every item', () => {
    const r = fuzzyRank(items, '');
    expect(r.map((x) => x.item.label)).toEqual(items.map((i) => i.label));
    expect(r.every((x) => x.ranges.length === 0)).toBe(true);
  });
  it('returns the original item objects (so the caller can read its id)', () => {
    const a = { label: 'Fetch All', id: 'fetch' };
    expect(fuzzyRank([a], 'fetch')[0]!.item).toBe(a);
  });
});
