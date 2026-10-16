import { describe, expect, it } from 'vitest';
import type { LogCommit } from './git';
import { compareMode } from './compareMode';

/*
 * V5a. Names the builder must implement (shared/src/compareMode.ts, re-exported from shared/src/index.ts):
 *   compareMode(sel: { kind: 'multi'; shas: string[]; wip: boolean }, commits: LogCommit[] /* loaded graph rows, newest first *\/, headSha: string | null)
 *     -> { mode: 'pair' | 'range' | 'wip' | 'wipRange' | 'none'; base?: string; head?: string }
 *   pair:     base = the lower row (older, larger index), head = the upper row; any 2 commits
 *   range:    more than 2 commits forming ONE first-parent chain; base = the oldest commit's first parent, or 'empty' for a root commit; head = the newest
 *   wip:      WIP + exactly 1 commit; base = that commit's sha (compare it against the working copy)
 *   wipRange: WIP + a chain (>= 2) whose newest commit is HEAD; base as for range
 *   none:     anything else
 */

const sha = (n: number): string => n.toString(16).padStart(40, '0');
function c(n: number, parents: number[]): LogCommit {
  return { sha: sha(n), parents: parents.map(sha), authorName: 'A', authorEmail: 'a@example.com', authorDate: '2026-01-01T10:00:00+00:00', subject: `c${n}`, refs: [] };
}
// Newest first. Main line 9 -> 8 -> 7 -> 6 -> 1(root). Side branch 5 -> 4 -> 1. Merge 10 has first parent 9 and second parent 5.
const rows: LogCommit[] = [c(10, [9, 5]), c(9, [8]), c(8, [7]), c(5, [4]), c(7, [6]), c(4, [1]), c(6, [1]), c(1, [])];
const multi = (shas: number[], wip = false) => ({ kind: 'multi' as const, shas: shas.map(sha), wip });

describe('compareMode', () => {
  it('2 commits is a pair, base = the lower (older) row, whatever order they were selected in', () => {
    expect(compareMode(multi([9, 7]), rows, sha(10))).toMatchObject({ mode: 'pair', base: sha(7), head: sha(9) });
    expect(compareMode(multi([7, 9]), rows, sha(10))).toMatchObject({ mode: 'pair', base: sha(7), head: sha(9) });
  });

  it('2 commits that are not related are still a pair', () => {
    expect(compareMode(multi([8, 4]), rows, sha(10))).toMatchObject({ mode: 'pair', base: sha(4), head: sha(8) });
  });

  it('3 commits in one first-parent chain is a range whose base is the oldest commit\'s first parent', () => {
    const r = compareMode(multi([8, 9, 7]), rows, sha(10));
    expect(r).toMatchObject({ mode: 'range', base: sha(6), head: sha(9) });
  });

  it('a chain that includes the root commit has base "empty"', () => {
    const r = compareMode(multi([6, 7, 8]), rows, sha(10)); // 8 -> 7 -> 6 is a chain, 6's parent is 1 (not root)
    expect(r).toMatchObject({ mode: 'range', base: sha(1), head: sha(8) });
    const root = compareMode(multi([4, 1]), rows, sha(10)); // 2 commits = pair even with the root
    expect(root.mode).toBe('pair');
    const rootRange = compareMode(multi([1, 6, 7]), rows, sha(10)); // 7 -> 6 -> 1(root)
    expect(rootRange).toMatchObject({ mode: 'range', base: 'empty', head: sha(7) });
  });

  it('a merge in the chain counts only through its FIRST parent', () => {
    expect(compareMode(multi([10, 9, 8]), rows, sha(10))).toMatchObject({ mode: 'range', base: sha(7), head: sha(10) });
    // 10 -> (second parent) 5 -> 4: the second parent is not a chain link
    expect(compareMode(multi([10, 5, 4]), rows, sha(10)).mode).toBe('none');
  });

  it('3 commits that are not one chain: none', () => {
    expect(compareMode(multi([9, 8, 4]), rows, sha(10)).mode).toBe('none');
    expect(compareMode(multi([9, 7, 6]), rows, sha(10)).mode).toBe('none'); // gap at 8 -> not each others' first parent
  });

  it('WIP + 1 commit is "wip", base = that commit, head or not', () => {
    expect(compareMode(multi([7], true), rows, sha(10))).toMatchObject({ mode: 'wip', base: sha(7) });
    expect(compareMode(multi([10], true), rows, sha(10))).toMatchObject({ mode: 'wip', base: sha(10) });
  });

  it('WIP + a chain whose newest commit is HEAD is "wipRange"', () => {
    expect(compareMode(multi([9, 8], true), rows, sha(9))).toMatchObject({ mode: 'wipRange', base: sha(7) });
    expect(compareMode(multi([9, 8, 7], true), rows, sha(9))).toMatchObject({ mode: 'wipRange', base: sha(6) });
  });

  it('WIP + a chain whose newest commit is not HEAD, or WIP + a non-chain: none', () => {
    expect(compareMode(multi([9, 8], true), rows, sha(10)).mode).toBe('none');
    expect(compareMode(multi([9, 4], true), rows, sha(9)).mode).toBe('none');
    expect(compareMode(multi([9, 8], true), rows, null).mode).toBe('none');
  });

  it('WIP alone, one commit alone, nothing: none', () => {
    expect(compareMode(multi([], true), rows, sha(10)).mode).toBe('none');
    expect(compareMode(multi([9]), rows, sha(10)).mode).toBe('none');
    expect(compareMode(multi([]), rows, sha(10)).mode).toBe('none');
  });
});
