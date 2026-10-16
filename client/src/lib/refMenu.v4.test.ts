import { describe, expect, it, vi } from 'vitest';
import { ITEMS, buildMenu, type MenuCtx, type MenuEntry } from './refMenu';

/*
 * V4 additions to client/src/lib/refMenu.ts (contract chosen by the test author; GitKraken wording from en-us.json, order from gitkraken-menu-code.txt).
 * New MenuCtx fields (all optional, absent = false / 0):
 *   isHead?: boolean         the row's commit is the HEAD tip.
 *   onHeadLine?: boolean     the row's commit is on HEAD's first-parent line (HEAD itself included) and HEAD is a branch.
 *   childrenCount?: number   commits above this one up to HEAD (what "Interactive Rebase N children of <sha>" would replay).
 *   multi?: { count: number; consecutive: boolean; merge: boolean; wip: boolean; onHeadLine: boolean; canMoveUp: boolean; canMoveDown: boolean }
 *                            set when the menu opens on a row that belongs to a multi selection of 2 or more commits.
 * New item ids -> string keys -> labels:
 *   edit-commit-message       ContextMenu-AmendOrRewordCommitMessage  "Edit commit message"          isHead, single
 *   reword-commit             ContextMenu-RewordCommit                "Reword commit"                 onHeadLine and not HEAD, single
 *   drop-commit               ContextMenu-DropCommit                  "Drop commit"                   onHeadLine, single, not a merge
 *   interactive-rebase-children ContextMenu-RebaseXChildrenOfShaInteractively "Interactive Rebase {0} children of {1}" ({0}=childrenCount, {1}=first 7 chars of sha)
 *                                                                                                     onHeadLine, not HEAD, childrenCount >= 1, single
 *   squash-commits            ContextMenu-SquashXCommits              "Squash {0} commits"            multi, consecutive, no merge, no wip, onHeadLine
 *   drop-commits              ContextMenu-DropCommits                 "Drop {0} commits"              same conditions as squash
 *   move-commits-up / -down   ContextMenu-MoveXCommitsUp / -Down      "Move {0} commits up" / "down"  same conditions + multi.canMoveUp / canMoveDown
 *   cherry-pick-commits       ContextMenu-CherrypickCommits           "Cherry pick {0} commits"       multi, no merge, no wip, attached HEAD, not inProgress (consecutive NOT required)
 *   interactive-rebase-branch ContextMenu-RebaseBranchOntoBranchInteractively "Interactive Rebase {0} onto {1}"  branch pills (same `when` as the 'rebase' item)
 * Every V4 item is hidden while ctx.inProgress is true or HEAD is detached (head.branch === null).
 */

const SHA = 'abcdef0123456789'.repeat(2).padEnd(40, '0');
const V4 = ['edit-commit-message', 'reword-commit', 'drop-commit', 'interactive-rebase-children', 'squash-commits', 'drop-commits', 'move-commits-up', 'move-commits-down', 'cherry-pick-commits', 'interactive-rebase-branch'];
const handlers = (): Record<string, () => void> => Object.fromEntries(V4.map((id) => [id, vi.fn()]));
const labels = (m: MenuEntry[]): string[] => m.map((e) => (e.type === 'divider' ? '---' : e.label)).filter((l) => l !== '---');
const v4Labels = (ctx: MenuCtx): string[] => labels(buildMenu(ctx, handlers())).filter((l) => /^(Edit commit message|Reword commit|Drop|Interactive Rebase|Squash|Move|Cherry pick \d)/.test(l));

const row: MenuCtx = { target: 'row', sha: SHA, head: { branch: 'main' } };
const multi = (over: Partial<NonNullable<MenuCtx['multi']>> = {}): MenuCtx['multi'] => ({ count: 3, consecutive: true, merge: false, wip: false, onHeadLine: true, canMoveUp: true, canMoveDown: true, ...over });

describe('V4 menu table', () => {
  it('lists the V4 ids with unique ids and ContextMenu- keys', () => {
    const ids = ITEMS.map((i) => i.id);
    for (const id of V4) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of ITEMS.filter((x) => V4.includes(x.id))) expect(i.key).toMatch(/^ContextMenu-/);
  });
});

describe('single commit rows', () => {
  it('HEAD: Edit commit message and Drop commit (no Reword, no children item)', () => {
    expect(v4Labels({ ...row, isHead: true, onHeadLine: true })).toEqual(['Edit commit message', 'Drop commit']);
  });
  it('an ancestor on the HEAD line: Reword commit, Drop commit and the children item with the count and the short sha', () => {
    expect(v4Labels({ ...row, onHeadLine: true, childrenCount: 3 })).toEqual(['Reword commit', 'Drop commit', `Interactive Rebase 3 children of ${SHA.slice(0, 7)}`]);
  });
  it('a commit that is not on the HEAD line gets none of the single-commit rewrite items', () => {
    expect(v4Labels({ ...row, onHeadLine: false })).toEqual([]);
    expect(v4Labels(row)).toEqual([]);
  });
  it('a merge commit cannot be dropped', () => {
    expect(v4Labels({ ...row, onHeadLine: true, merge: true, childrenCount: 2 })).not.toContain('Drop commit');
  });
  it('a root commit (no parent) cannot be dropped', () => {
    expect(v4Labels({ ...row, onHeadLine: true, hasParent: false, childrenCount: 2 })).not.toContain('Drop commit');
    expect(v4Labels({ ...row, onHeadLine: true, hasParent: true, childrenCount: 2 })).toContain('Drop commit');
  });
  it('hidden while detached or while an operation is in progress', () => {
    const base: MenuCtx = { ...row, onHeadLine: true, childrenCount: 3 };
    expect(v4Labels({ ...base, head: { branch: null } })).toEqual([]);
    expect(v4Labels({ ...base, inProgress: true })).toEqual([]);
    expect(v4Labels({ ...base, isHead: true, inProgress: true })).toEqual([]);
  });
  it('an item without a handler is not shown', () => {
    const h = handlers();
    delete h['drop-commit'];
    expect(labels(buildMenu({ ...row, isHead: true, onHeadLine: true }, h))).not.toContain('Drop commit');
  });
});

describe('multi selection rows', () => {
  it('consecutive commits on the HEAD line: Squash, Drop, Move up, Move down and Cherry pick use the count', () => {
    expect(v4Labels({ ...row, onHeadLine: true, multi: multi() })).toEqual(['Squash 3 commits', 'Drop 3 commits', 'Move 3 commits up', 'Move 3 commits down', 'Cherry pick 3 commits']);
  });
  it('single-commit items are replaced by the multi ones', () => {
    const l = v4Labels({ ...row, onHeadLine: true, childrenCount: 2, multi: multi({ count: 2 }) });
    for (const single of ['Reword commit', 'Drop commit', 'Edit commit message']) expect(l).not.toContain(single);
    expect(l.some((x) => x.startsWith('Interactive Rebase 2 children'))).toBe(false);
  });
  it('not consecutive: no Squash, Drop, Move; Cherry pick stays (it does not need a chain)', () => {
    expect(v4Labels({ ...row, onHeadLine: true, multi: multi({ consecutive: false, count: 2 }) })).toEqual(['Cherry pick 2 commits']);
  });
  it('a merge commit in the selection: no Squash, Drop, Move and no Cherry pick', () => {
    expect(v4Labels({ ...row, onHeadLine: true, multi: multi({ merge: true }) })).toEqual([]);
  });
  it('the WIP row in the selection: nothing is offered', () => {
    expect(v4Labels({ ...row, onHeadLine: true, multi: multi({ wip: true }) })).toEqual([]);
  });
  it('commits off the HEAD line: only Cherry pick', () => {
    expect(v4Labels({ ...row, onHeadLine: false, multi: multi({ onHeadLine: false }) })).toEqual(['Cherry pick 3 commits']);
  });
  it('Move up is hidden when canMoveUp is false, Move down when canMoveDown is false', () => {
    expect(v4Labels({ ...row, onHeadLine: true, multi: multi({ canMoveUp: false }) })).toEqual(['Squash 3 commits', 'Drop 3 commits', 'Move 3 commits down', 'Cherry pick 3 commits']);
    expect(v4Labels({ ...row, onHeadLine: true, multi: multi({ canMoveDown: false }) })).toEqual(['Squash 3 commits', 'Drop 3 commits', 'Move 3 commits up', 'Cherry pick 3 commits']);
  });
  it('hidden while detached or in progress', () => {
    expect(v4Labels({ ...row, onHeadLine: true, multi: multi(), head: { branch: null } })).toEqual([]);
    expect(v4Labels({ ...row, onHeadLine: true, multi: multi(), inProgress: true })).toEqual([]);
  });
  it('running Squash calls its handler once', () => {
    const h = handlers();
    const m = buildMenu({ ...row, onHeadLine: true, multi: multi() }, h);
    (m.find((e) => e.type === 'item' && e.id === 'squash-commits') as Extract<MenuEntry, { type: 'item' }>).run();
    expect(h['squash-commits']).toHaveBeenCalledTimes(1);
    expect(h['drop-commits']).not.toHaveBeenCalled();
  });
});

describe('branch pills', () => {
  const pill: MenuCtx = { target: 'pill', sha: SHA, branch: { name: 'feature/one', local: true, remote: false, current: false }, head: { branch: 'main' } };
  it('Interactive Rebase {HEAD} onto {branch} sits with the other integrate items', () => {
    expect(v4Labels(pill)).toEqual(['Interactive Rebase main onto feature/one']);
  });
  it('hidden for the checked-out branch, while detached and while in progress', () => {
    expect(v4Labels({ ...pill, branch: { name: 'main', local: true, remote: false, current: true } })).toEqual([]);
    expect(v4Labels({ ...pill, head: { branch: null } })).toEqual([]);
    expect(v4Labels({ ...pill, inProgress: true })).toEqual([]);
  });
});
