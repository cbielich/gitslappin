import { describe, expect, it, vi } from 'vitest';
import { ITEMS, buildMenu, type MenuCtx, type MenuEntry } from './refMenu';

/*
 * Contract (client/src/lib/refMenu.ts):
 *   export const ITEMS: { id: string; group: string; key: string; args: ...; when: (ctx: MenuCtx) => boolean; submenu?: ... }[]
 *   export interface MenuCtx {
 *     target: 'pill' | 'row' | 'sidebar-local' | 'sidebar-remote';
 *     sha: string;                       // commit the menu is about
 *     branch?: { name: string; local: boolean; remote: boolean; current: boolean }; // absent for a plain commit row
 *     head: { branch: string | null };   // null = detached
 *   }
 *   export type MenuEntry =
 *     | { type: 'divider' }
 *     | { type: 'item'; id: string; label: string; run: () => void; submenu?: MenuEntry[] };
 *   export function buildMenu(ctx: MenuCtx, handlers: Record<string, () => void>): MenuEntry[];
 * Item ids used here: 'checkout' (submenu), 'checkout-branch', 'checkout-commit-submenu', 'checkout-commit',
 *   'create-branch-here', 'copy-branch-name', 'copy-commit-sha'.
 * Labels come from en-us.json: ContextMenu-Checkout "Checkout", ContextMenu-CheckoutCommitSubmenu "this commit",
 *   ContextMenu-CheckoutCommit "Checkout this commit", ContextMenu-CreateBranchHere "Create branch here",
 *   ContextMenu-CopyBranchName "Copy branch name", ContextMenu-CopyCommitSha "Copy commit sha".
 */

const SHA = 'a'.repeat(40);
const ALL = ['checkout', 'checkout-branch', 'checkout-commit-submenu', 'checkout-commit', 'create-branch-here', 'copy-branch-name', 'copy-commit-sha'];
const allHandlers = (): Record<string, () => void> => Object.fromEntries(ALL.map((id) => [id, vi.fn()]));

const pillCtx: MenuCtx = { target: 'pill', sha: SHA, branch: { name: 'feature/one', local: true, remote: false, current: false }, head: { branch: 'main' } };
const rowCtx: MenuCtx = { target: 'row', sha: SHA, head: { branch: 'main' } };

const labels = (m: MenuEntry[]): string[] => m.map((e) => (e.type === 'divider' ? '---' : e.label));

describe('refMenu ITEMS table', () => {
  it('has unique ids and a ContextMenu- string key per item', () => {
    const ids = ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of ITEMS) expect(i.key).toMatch(/^(ContextMenu-|SoloBranch$|LeftPanel-StopSoloing$)/); // the solo items use GitKraken's own keys (phase 11, build-notes)
  });

  it('lists the phase 5 items', () => {
    const ids = ITEMS.map((i) => i.id);
    for (const id of ALL) expect(ids).toContain(id);
  });
});

describe('buildMenu', () => {
  it('branch pill: Checkout >, divider, Create branch here, divider, Copy items (group order and dividers)', () => {
    const m = buildMenu(pillCtx, allHandlers());
    expect(labels(m)).toEqual(['Checkout', '---', 'Create branch here', '---', 'Copy branch name', 'Copy commit sha']);
  });

  it('Checkout submenu holds the branch and "this commit"', () => {
    const m = buildMenu(pillCtx, allHandlers());
    const checkout = m.find((e) => e.type === 'item' && e.id === 'checkout');
    expect(checkout && checkout.type === 'item' && checkout.submenu).toBeTruthy();
    const sub = (checkout as Extract<MenuEntry, { type: 'item' }>).submenu!;
    expect(sub.some((e) => e.type === 'item' && e.id === 'checkout-branch' && e.label.includes('feature/one'))).toBe(true);
    expect(sub.some((e) => e.type === 'item' && e.id === 'checkout-commit-submenu' && e.label === 'this commit')).toBe(true);
  });

  it('plain commit row: Checkout this commit, divider, Create branch here, divider, Copy commit sha', () => {
    const m = buildMenu(rowCtx, allHandlers());
    expect(labels(m)).toEqual(['Checkout this commit', '---', 'Create branch here', '---', 'Copy commit sha']);
  });

  it('an item without a registered handler is not shown, and its group divider disappears', () => {
    const h = allHandlers();
    delete h['create-branch-here'];
    const m = buildMenu(rowCtx, h);
    expect(labels(m)).toEqual(['Checkout this commit', '---', 'Copy commit sha']);
  });

  it('never starts or ends with a divider and never has two in a row', () => {
    for (const ctx of [pillCtx, rowCtx]) {
      for (const drop of ALL) {
        const h = allHandlers();
        delete h[drop];
        const l = labels(buildMenu(ctx, h));
        expect(l[0]).not.toBe('---');
        expect(l[l.length - 1]).not.toBe('---');
        for (let i = 1; i < l.length; i++) expect(l[i] === '---' && l[i - 1] === '---').toBe(false);
      }
    }
  });

  it('with no handlers the menu is empty', () => {
    expect(buildMenu(pillCtx, {})).toEqual([]);
  });

  it('running an item calls its registered handler once', () => {
    const h = allHandlers();
    const m = buildMenu(rowCtx, h);
    const copy = m.find((e) => e.type === 'item' && e.id === 'copy-commit-sha');
    (copy as Extract<MenuEntry, { type: 'item' }>).run();
    expect(h['copy-commit-sha']).toHaveBeenCalledTimes(1);
    expect(h['checkout-commit']).not.toHaveBeenCalled();
  });

  it('Copy branch name is not offered on a plain commit row', () => {
    expect(labels(buildMenu(rowCtx, allHandlers()))).not.toContain('Copy branch name');
  });
});

describe('phase 6 integrate items', () => {
  const INTEGRATE = ['merge', 'fast-forward', 'rebase', 'rebase-this-commit'];
  const handlers = (): Record<string, () => void> => Object.fromEntries(INTEGRATE.map((id) => [id, vi.fn()]));
  const text = (ctx: MenuCtx): string[] => labels(buildMenu(ctx, handlers())).filter((l) => /^(Merge|Rebase|Fast-forward) /.test(l));

  it('merge and rebase name the branch and HEAD; fast-forward only when asked', () => {
    expect(text(pillCtx)).toEqual(['Merge feature/one into main', 'Rebase main onto feature/one']);
    expect(text({ ...pillCtx, canFastForward: true })).toEqual(['Merge feature/one into main', 'Fast-forward main to feature/one', 'Rebase main onto feature/one']);
  });
  it('rebase onto this commit is on rows only', () => {
    expect(text(rowCtx)).toEqual(['Rebase main onto this commit']);
    expect(text(pillCtx)).not.toContain('Rebase main onto this commit');
  });
  it('all are hidden while an operation is in progress or HEAD is detached', () => {
    expect(text({ ...pillCtx, canFastForward: true, inProgress: true })).toEqual([]);
    expect(text({ ...rowCtx, inProgress: true })).toEqual([]);
    expect(text({ ...pillCtx, canFastForward: true, head: { branch: null } })).toEqual([]);
    expect(text({ ...rowCtx, head: { branch: null } })).toEqual([]);
  });
  it('the checked-out branch gets none', () => {
    expect(text({ ...pillCtx, branch: { name: 'main', local: true, remote: false, current: true }, canFastForward: true })).toEqual([]);
  });
});

describe('phase 7 remote items', () => {
  const REMOTE = ['pull', 'push', 'set-upstream'];
  const handlers = (): Record<string, () => void> => Object.fromEntries(REMOTE.map((id) => [id, vi.fn()]));
  const text = (ctx: MenuCtx): string[] => labels(buildMenu(ctx, handlers()));

  it('a local branch gets Pull, Push and Set Upstream as the first group', () => {
    expect(text(pillCtx)).toEqual(['Pull (fast-forward if possible)', 'Push', 'Set Upstream']);
    const withOthers = labels(buildMenu(pillCtx, { ...allHandlers(), ...handlers() }));
    expect(withOthers.slice(0, 4)).toEqual(['Pull (fast-forward if possible)', 'Push', 'Set Upstream', '---']);
  });
  it('a remote-only branch and a plain commit row get none', () => {
    expect(text({ ...pillCtx, branch: { name: 'origin/x', local: false, remote: true, current: false } })).toEqual([]);
    expect(text(rowCtx)).toEqual([]);
  });
  it('hidden while HEAD is detached or an operation is in progress', () => {
    expect(text({ ...pillCtx, head: { branch: null } })).toEqual([]);
    expect(text({ ...pillCtx, inProgress: true })).toEqual([]);
  });
  it('the current branch gets them too', () => {
    expect(text({ ...pillCtx, branch: { name: 'main', local: true, remote: false, current: true } })).toEqual(['Pull (fast-forward if possible)', 'Push', 'Set Upstream']);
  });
});

describe('phase 9 stash items', () => {
  const stashCtx: MenuCtx = { target: 'stash', sha: SHA, head: { branch: 'main' } };
  const handlers = (): Record<string, () => void> => ({ ...allHandlers(), 'stash-apply': vi.fn(), 'stash-pop': vi.fn(), 'stash-delete': vi.fn() });

  it('a stash shows Apply Stash, Pop Stash, Delete Stash and nothing else', () => {
    expect(labels(buildMenu(stashCtx, handlers()))).toEqual(['Apply Stash', 'Pop Stash', 'Delete Stash']);
  });

  it('other targets never show the stash items', () => {
    for (const ctx of [pillCtx, rowCtx]) expect(labels(buildMenu(ctx, handlers()))).not.toContain('Apply Stash');
  });

  it('an item without a handler is left out', () => {
    const h = handlers();
    delete h['stash-delete'];
    expect(labels(buildMenu(stashCtx, h))).toEqual(['Apply Stash', 'Pop Stash']);
  });
});
