import { TEXT, type MenuEntry } from './refMenu';

/*
 * V6 drag and drop: the menu shown when one branch is dropped on another. Pure: nothing runs until an item is clicked.
 * Merge and rebase act only on the checked-out branch, so one side must be it. Never offers a force push.
 */
export interface DropRef {
  name: string;
  kind: 'local' | 'remote';
}
export interface DropCtx {
  inProgress: boolean;
  gitAtLeast238: boolean;
  handlers: Record<string, () => void>;
}

const fill = (key: string, a: string, b: string): string => (TEXT[key] ?? key).replace('{0}', a).replace('{1}', b);

export function dropMenu(src: DropRef, dst: DropRef, head: { branch: string | null }, ctx: DropCtx): MenuEntry[] {
  if (ctx.inProgress || (src.name === dst.name && src.kind === dst.kind)) return [];
  const item = (id: string, key: string): MenuEntry => ({ type: 'item', id, label: fill(key, src.name, dst.name), run: () => ctx.handlers[id]?.() });
  const out: MenuEntry[] = [];
  if (head.branch !== null && dst.kind === 'local' && dst.name === head.branch) out.push(item('merge-branch-into-branch', 'ContextMenu-MergeBranchIntoBranch'));
  if (head.branch !== null && src.kind === 'local' && src.name === head.branch) {
    out.push(item('rebase-branch-onto-branch', 'ContextMenu-RebaseBranchOntoBranch'));
    if (ctx.gitAtLeast238) out.push(item('rebase-branch-onto-branch-interactively', 'ContextMenu-RebaseBranchOntoBranchInteractively'));
  }
  if (src.kind === 'local' && dst.kind === 'remote') {
    if (out.length > 0) out.push({ type: 'divider' });
    out.push(item('push-x-to-y', 'ContextMenu-PushXToY'));
  }
  return out;
}
