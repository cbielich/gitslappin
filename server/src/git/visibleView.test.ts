import { describe, expect, it } from 'vitest';
import type { LogCommit, RefLabel } from '@gitslappin/shared';
import { buildVisibleView } from './visibleView';

/*
 * V5c + audit fix 1 (in-memory hide/solo; git is never re-run for a toggle).
 * Names the builder must implement: server/src/git/visibleView.ts
 *   buildVisibleView(commits: LogCommit[] /* the full cached walk, newest first *\/, vis: { hidden: string[]; solo: string[]; hideStashes: boolean }): LogCommit[]
 * - ref full names are refs/heads/<name> (kind local), refs/remotes/<name> (kind remote), refs/tags/<name> (kind tag), matched against each commit's RefLabel
 * - visible tips = every commit that still has a non-hidden label (the checked-out branch / detached HEAD label, `current: true` or kind 'head', is never hidden) + stash commits unless hideStashes
 * - kept = commits reachable from the tips through `parents`; the full walk's order is kept (a subsequence); hidden labels are stripped from `refs`, other labels stay
 * - solo (non-empty `solo`): tips = only the soloed refs + the checked-out branch / HEAD
 * - entries naming a ref no commit carries (stale) are ignored; the input array and its commits are never mutated
 */

const sha = (n: number): string => n.toString(16).padStart(40, '0');
const local = (name: string, current = false): RefLabel => ({ name, kind: 'local', ...(current ? { current: true } : {}) });
const remote = (name: string): RefLabel => ({ name, kind: 'remote' });
const tag = (name: string): RefLabel => ({ name, kind: 'tag' });
function c(n: number, parents: number[], refs: RefLabel[] = [], extra: Partial<LogCommit> = {}): LogCommit {
  return { sha: sha(n), parents: parents.map(sha), authorName: 'A', authorEmail: 'a@example.com', authorDate: '2026-01-01T10:00:00+00:00', subject: `c${n}`, refs, ...extra };
}

const NOTHING = { hidden: [] as string[], solo: [] as string[], hideStashes: false };
function graph(): LogCommit[] {
  return [
    c(20, [2], [local('main', true)]), // m3 (HEAD)
    c(21, [11], [local('side'), remote('origin/side')]), // s2
    c(22, [2], [tag('lonely')]), // t1: only a tag points here
    c(23, [2], [local('other')]), // o1
    c(24, [2], [], { stash: 0 }), // stash node
    c(11, [2]), // s1 (only reachable through s2)
    c(2, [1], [tag('v1')]), // c2
    c(1, []), // c1
  ];
}
const subjects = (l: LogCommit[]): string[] => l.map((x) => x.subject);
const byN = (l: LogCommit[], n: number): LogCommit | undefined => l.find((x) => x.sha === sha(n));

describe('buildVisibleView', () => {
  it('nothing hidden: every commit and label is kept, same order', () => {
    expect(buildVisibleView(graph(), NOTHING)).toEqual(graph());
  });

  it('hiding a branch removes its exclusive commits and keeps the shared ones', () => {
    const v = buildVisibleView(graph(), { ...NOTHING, hidden: ['refs/heads/other'] });
    expect(byN(v, 23)).toBeUndefined();
    for (const n of [20, 21, 22, 24, 11, 2, 1]) expect(byN(v, n), `commit ${n}`).toBeDefined(); // c2 is shared with every other branch
  });

  it('hiding the local branch whose commit still has a remote label keeps the commit and the remote label (screen 41)', () => {
    const v = buildVisibleView(graph(), { ...NOTHING, hidden: ['refs/heads/side'] });
    const s2 = byN(v, 21);
    expect(s2).toBeDefined();
    expect(s2!.refs).toEqual([remote('origin/side')]);
    expect(byN(v, 11)).toBeDefined();
  });

  it('hiding both the local and the remote branch removes the commits only they reach (s2 and s1)', () => {
    const v = buildVisibleView(graph(), { ...NOTHING, hidden: ['refs/heads/side', 'refs/remotes/origin/side'] });
    expect(byN(v, 21)).toBeUndefined();
    expect(byN(v, 11)).toBeUndefined();
    expect(byN(v, 2)).toBeDefined();
  });

  it('hiding tags: a tag-only commit goes away, a tag on a still-reachable commit only loses its label', () => {
    const v = buildVisibleView(graph(), { ...NOTHING, hidden: ['refs/tags/lonely', 'refs/tags/v1'] });
    expect(byN(v, 22)).toBeUndefined();
    expect(byN(v, 2)).toBeDefined();
    expect(byN(v, 2)!.refs).toEqual([]);
  });

  it('hide stashes removes the stash node only', () => {
    const v = buildVisibleView(graph(), { ...NOTHING, hideStashes: true });
    expect(byN(v, 24)).toBeUndefined();
    expect(v).toHaveLength(graph().length - 1);
    expect(byN(buildVisibleView(graph(), NOTHING), 24)?.stash).toBe(0); // control: it is there when stashes are shown
  });

  it('the checked-out branch cannot be hidden: its commit and label stay', () => {
    const v = buildVisibleView(graph(), { ...NOTHING, hidden: ['refs/heads/main'] });
    expect(byN(v, 20)?.refs).toEqual([local('main', true)]);
  });

  it('solo keeps only the soloed branch and HEAD (with their ancestors)', () => {
    const v = buildVisibleView(graph(), { ...NOTHING, solo: ['refs/heads/side'] });
    for (const n of [20, 21, 11, 2, 1]) expect(byN(v, n), `commit ${n}`).toBeDefined();
    expect(byN(v, 23)).toBeUndefined(); // other
    expect(byN(v, 22)).toBeUndefined(); // tag-only commit
  });

  it('review fix 1: an explicit solo wins over hidden for the same ref', () => {
    const v = buildVisibleView(graph(), { hidden: ['refs/heads/side'], solo: ['refs/heads/side'], hideStashes: false });
    expect(byN(v, 21)?.refs.map((r) => r.name)).toContain('side');
    expect(subjects(v)).toContain('c21');
  });

  it('solo of a tag keeps that tag commit, HEAD and ancestors, and drops the other branches', () => {
    const v = buildVisibleView(graph(), { ...NOTHING, solo: ['refs/tags/lonely'] });
    expect(byN(v, 22)).toBeDefined();
    expect(byN(v, 20)).toBeDefined();
    expect(byN(v, 21)).toBeUndefined();
    expect(byN(v, 23)).toBeUndefined();
  });

  it('keeps the full walk order (a subsequence) and every kept commit keeps all its parents', () => {
    const full = graph();
    const v = buildVisibleView(full, { ...NOTHING, hidden: ['refs/heads/other'] });
    const order = full.map((x) => x.sha).filter((s) => v.some((k) => k.sha === s));
    expect(v.map((x) => x.sha)).toEqual(order);
    const kept = new Set(v.map((x) => x.sha));
    for (const k of v) for (const p of k.parents) expect(kept.has(p), `${k.subject} parent`).toBe(true);
  });

  it('a stale entry (no commit carries that ref) is ignored', () => {
    expect(buildVisibleView(graph(), { ...NOTHING, hidden: ['refs/heads/gone', 'refs/tags/gone', 'refs/remotes/nope/x'] })).toEqual(graph());
  });

  it('a name that exists as a branch and as a tag is only hidden in the namespace that was named', () => {
    const g = [c(30, [], [local('x', true), tag('x')]), c(31, [], [tag('x')])];
    const v = buildVisibleView(g, { ...NOTHING, hidden: ['refs/tags/x'] });
    expect(byN(v, 30)!.refs).toEqual([local('x', true)]);
    expect(byN(v, 31)).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const full = graph();
    const before = JSON.stringify(full);
    buildVisibleView(full, { hidden: ['refs/heads/side', 'refs/tags/v1'], solo: [], hideStashes: true });
    buildVisibleView(full, { ...NOTHING, solo: ['refs/heads/side'] });
    expect(JSON.stringify(full)).toBe(before);
  });

  it('is fast on a long linear history (O(n), no per-commit scan)', () => {
    const n = 100_000;
    const big: LogCommit[] = [];
    for (let i = n; i >= 1; i--) big.push(c(i, i > 1 ? [i - 1] : [], i === n ? [local('main', true)] : i === 50_000 ? [local('mid')] : []));
    const t0 = Date.now();
    const v = buildVisibleView(big, { ...NOTHING, hidden: ['refs/heads/mid'] });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(v).toHaveLength(n); // main reaches everything
  });
});
