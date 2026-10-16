import { describe, expect, it, vi } from 'vitest';
import { dropMenu, type DropRef } from './dropMenu';
import type { MenuEntry } from './refMenu';

/*
 * V6 design "1 Drag and drop". New pure module client/src/lib/dropMenu.ts (contract chosen by the test author; the design names the function and the string keys only):
 *   export interface DropRef { name: string; kind: 'local' | 'remote' }          // remote names are full remote-tracking names, e.g. 'origin/feature/x'
 *   export interface DropCtx { inProgress: boolean; gitAtLeast238: boolean; handlers: Record<string, () => void> }
 *   export function dropMenu(src: DropRef, dst: DropRef, head: { branch: string | null }, ctx: DropCtx): MenuEntry[]
 * Item ids -> en-us.json keys -> labels:
 *   merge-branch-into-branch                  ContextMenu-MergeBranchIntoBranch                    "Merge {0} into {1}"                  dst is the checked-out local branch
 *   rebase-branch-onto-branch                 ContextMenu-RebaseBranchOntoBranch                   "Rebase {0} onto {1}"                 src is the checked-out local branch
 *   rebase-branch-onto-branch-interactively   ContextMenu-RebaseBranchOntoBranchInteractively      "Interactive Rebase {0} onto {1}"     as rebase, and only with ctx.gitAtLeast238
 *   push-x-to-y                               ContextMenu-PushXToY                                 "Push {0} to {1}"                     src local, dst remote-tracking; preceded by ONE divider when items come before it
 * handlers[id] is what item.run() calls. Nothing is called by dropMenu itself.
 * No menu at all (empty array): dropped on itself, no applicable item, or a merge/rebase in progress (ctx.inProgress).
 * Audit data-safety 4: no entry anywhere offers a force push.
 */

const local = (name: string): DropRef => ({ name, kind: 'local' });
const remote = (name: string): DropRef => ({ name, kind: 'remote' });
const HEAD = { branch: 'main' };

function make(over: Partial<{ inProgress: boolean; gitAtLeast238: boolean }> = {}) {
  const handlers = {
    'merge-branch-into-branch': vi.fn(),
    'rebase-branch-onto-branch': vi.fn(),
    'rebase-branch-onto-branch-interactively': vi.fn(),
    'push-x-to-y': vi.fn(),
  };
  return { handlers, ctx: { inProgress: false, gitAtLeast238: true, handlers, ...over } };
}
const run = (src: DropRef, dst: DropRef, head: { branch: string | null } = HEAD, over: Partial<{ inProgress: boolean; gitAtLeast238: boolean }> = {}) => {
  const { ctx, handlers } = make(over);
  return { entries: dropMenu(src, dst, head, ctx), handlers };
};
const labels = (m: MenuEntry[]): string[] => m.map((e) => (e.type === 'divider' ? '---' : e.label));
const ids = (m: MenuEntry[]): string[] => m.map((e) => (e.type === 'divider' ? '---' : e.id));

describe('dropMenu: merge', () => {
  it('a local branch dropped on the checked-out branch offers only Merge X into HEAD', () => {
    const { entries } = run(local('feature/x'), local('main'));
    expect(labels(entries)).toEqual(['Merge feature/x into main']);
    expect(ids(entries)).toEqual(['merge-branch-into-branch']);
  });
  it('remote -> local: a remote-tracking branch dropped on the checked-out branch offers Merge origin/x into HEAD', () => {
    expect(labels(run(remote('origin/x'), local('main')).entries)).toEqual(['Merge origin/x into main']);
  });
  it('dropped on a local branch that is NOT checked out: no merge item (merge only acts on HEAD)', () => {
    expect(run(local('feature/x'), local('other')).entries).toEqual([]);
    expect(run(remote('origin/x'), local('other')).entries).toEqual([]);
  });
  it('nothing runs until the item is clicked, and the click runs exactly that handler', () => {
    const { entries, handlers } = run(local('feature/x'), local('main'));
    for (const h of Object.values(handlers)) expect(h).not.toHaveBeenCalled();
    const item = entries[0]!;
    if (item.type !== 'item') throw new Error('expected an item');
    item.run();
    expect(handlers['merge-branch-into-branch']).toHaveBeenCalledTimes(1);
    expect(handlers['rebase-branch-onto-branch']).not.toHaveBeenCalled();
    expect(handlers['push-x-to-y']).not.toHaveBeenCalled();
  });
});

describe('dropMenu: rebase', () => {
  it('the checked-out branch dropped on another local branch: Rebase + Interactive Rebase, no merge, no push', () => {
    const { entries } = run(local('main'), local('feature/x'));
    expect(labels(entries)).toEqual(['Rebase main onto feature/x', 'Interactive Rebase main onto feature/x']);
    expect(ids(entries)).toEqual(['rebase-branch-onto-branch', 'rebase-branch-onto-branch-interactively']);
  });
  it('git older than 2.38 hides the interactive item only', () => {
    const { entries } = run(local('main'), local('feature/x'), HEAD, { gitAtLeast238: false });
    expect(labels(entries)).toEqual(['Rebase main onto feature/x']);
  });
  it('the checked-out branch dropped on a remote-tracking branch: both rebase items, a divider, then Push', () => {
    const { entries } = run(local('main'), remote('origin/main'));
    expect(labels(entries)).toEqual(['Rebase main onto origin/main', 'Interactive Rebase main onto origin/main', '---', 'Push main to origin/main']);
  });
  it('a branch that is not checked out is never the source of a rebase', () => {
    expect(ids(run(local('feature/x'), local('other')).entries)).toEqual([]);
    expect(ids(run(local('feature/x'), remote('origin/x')).entries)).toEqual(['push-x-to-y']);
  });
  it('detached HEAD: no merge and no rebase item', () => {
    const detached = { branch: null };
    expect(run(local('main'), local('feature/x'), detached).entries).toEqual([]);
    expect(run(local('feature/x'), local('main'), detached).entries).toEqual([]);
  });
});

describe('dropMenu: push', () => {
  it('a local branch dropped on a remote-tracking branch offers only Push X to Y, with no leading divider', () => {
    const { entries } = run(local('topic'), remote('origin/x'));
    expect(labels(entries)).toEqual(['Push topic to origin/x']);
    expect(entries[0]!.type).toBe('item');
  });
  it('remote -> local, remote -> remote: no push', () => {
    expect(ids(run(remote('origin/x'), local('topic')).entries)).not.toContain('push-x-to-y');
    expect(run(remote('origin/x'), remote('origin/y')).entries).toEqual([]);
  });
  it('local -> local never pushes', () => {
    expect(ids(run(local('a'), local('b')).entries)).not.toContain('push-x-to-y');
  });
});

describe('dropMenu: no menu', () => {
  it('dropped on itself (same name and kind) gives nothing, even for the checked-out branch', () => {
    expect(run(local('main'), local('main')).entries).toEqual([]);
    expect(run(local('topic'), local('topic')).entries).toEqual([]);
    expect(run(remote('origin/x'), remote('origin/x')).entries).toEqual([]);
  });
  it('a local branch and a remote-tracking branch with the same text are different things (still offers Push)', () => {
    expect(ids(run(local('x'), remote('x')).entries)).toEqual(['push-x-to-y']);
  });
  it('while a merge/rebase is in progress every drop gives nothing', () => {
    const cases: [DropRef, DropRef][] = [
      [local('feature/x'), local('main')],
      [local('main'), local('feature/x')],
      [local('topic'), remote('origin/x')],
      [local('main'), remote('origin/main')],
    ];
    for (const [s, d] of cases) expect(run(s, d, HEAD, { inProgress: true }).entries).toEqual([]);
  });
  it('audit data-safety 4: no case offers a force push, by label or by id', () => {
    const all: [DropRef, DropRef][] = [
      [local('main'), remote('origin/main')],
      [local('topic'), remote('origin/topic')],
      [local('feature/x'), local('main')],
      [remote('origin/x'), local('main')],
      [local('main'), local('feature/x')],
    ];
    for (const [s, d] of all) {
      const { entries } = run(s, d);
      for (const e of entries) {
        if (e.type === 'divider') continue;
        expect(e.label).not.toMatch(/force/i);
        expect(e.id).not.toMatch(/force/i);
      }
    }
  });
});

describe('review fix: branchDndProps targets and gate', () => {
  const evt = (types: string[]) => {
    const calls: string[] = [];
    const el = { setAttribute: () => calls.push('hot'), removeAttribute: () => calls.push('cold'), contains: () => false };
    const e = {
      stopPropagation: () => undefined,
      preventDefault: () => calls.push('prevent'),
      currentTarget: el,
      clientX: 1,
      clientY: 2,
      dataTransfer: { types, effectAllowed: '', dropEffect: '', setData: (t: string) => types.push(t) },
    };
    return { e: e as never, calls };
  };
  const gate = (s: DropRef, d: DropRef) => dropMenu(s, d, HEAD, { inProgress: false, gitAtLeast238: true, handlers: {} }).length > 0;

  it('a local branch dropped on a pill that also has a remote-tracking name resolves to the remote one for push', async () => {
    const { branchDndProps, setDropGate } = await import('./branchDnd');
    setDropGate(gate);
    const drops: [DropRef, DropRef][] = [];
    const src = branchDndProps(local('topic'), () => undefined);
    const dst = branchDndProps(local('feature'), (_x, _y, s, d) => drops.push([s, d]), [remote('origin/feature')]);
    const start = evt([]);
    src.onDragStart(start.e);
    const drop = evt(start.e.dataTransfer.types);
    dst.onDragOver(drop.e);
    expect(drop.calls).toContain('hot');
    dst.onDrop(drop.e);
    expect(drops).toEqual([[local('topic'), remote('origin/feature')]]);
    setDropGate(null);
  });
  it('no highlight and no drop when dropMenu would give nothing, or when the drag did not start here', async () => {
    const { branchDndProps, setDropGate } = await import('./branchDnd');
    setDropGate(gate);
    const drops: unknown[] = [];
    const src = branchDndProps(local('a'), () => undefined);
    const dst = branchDndProps(local('b'), (...a) => drops.push(a)); // neither is HEAD: no menu
    const start = evt([]);
    src.onDragStart(start.e);
    const over = evt(start.e.dataTransfer.types);
    dst.onDragOver(over.e);
    expect(over.calls).not.toContain('hot');
    dst.onDrop(over.e);
    expect(drops).toEqual([]);
    // external drag: no custom MIME
    const head = branchDndProps(local('main'), (...a) => drops.push(a));
    src.onDragStart(evt([]).e);
    const ext = evt(['text/plain']);
    head.onDragOver(ext.e);
    expect(ext.calls).not.toContain('hot');
    head.onDrop(ext.e);
    expect(drops).toEqual([]);
    setDropGate(null);
  });
});
