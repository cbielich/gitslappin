/*
 * ONE table for every ref/commit context menu (pills, graph rows, sidebar items).
 * Every item the milestone will ever show is listed here with its GitKraken string key. An item shows
 * only when `when(ctx)` passes AND a handler is registered for its id, so later phases only register handlers.
 */

export interface MenuCtx {
  target: 'pill' | 'row' | 'sidebar-local' | 'sidebar-remote' | 'more' | 'stash';
  /** The commit the menu is about (for target 'stash': the stash commit). */
  sha: string;
  /** Absent for a plain commit row. `name` is the local name, or the full remote name (`origin/x`) for remote-only. */
  branch?: { name: string; local: boolean; remote: boolean; current: boolean };
  /** null = detached. */
  head: { branch: string | null };
  /** A merge, rebase, cherry-pick or revert is stopped: the Integrate items are hidden. */
  inProgress?: boolean;
  /** HEAD is an ancestor of the branch (asked from the server when the menu opens). */
  canFastForward?: boolean;
  /** target 'more' (the +N pill): the extra branches of that row. */
  more?: NonNullable<MenuCtx['branch']>[];
  /** The upstream of the local branch (`origin/feature`), when it has one: "Delete {0} and {1}" needs it. */
  upstream?: string | null;
  /** The commit is a merge commit (two or more parents): Cherry pick and Revert are hidden. */
  merge?: boolean;
}

export type MenuEntry = { type: 'divider' } | { type: 'item'; id: string; label: string; run: () => void; submenu?: MenuEntry[] };

export type MenuGroup = 'stash' | 'remote' | 'integrate' | 'checkout' | 'commit' | 'branch' | 'copy' | 'tags';

export interface MenuItemDef {
  id: string;
  group: MenuGroup;
  /** en-us.json key. The text for it is in TEXT. */
  key: string;
  /** Values for {0}, {1} in the text. */
  args: (ctx: MenuCtx) => string[];
  when: (ctx: MenuCtx) => boolean;
  /** Ids of the items inside this item's submenu. */
  submenu?: string[];
  /** Only used as a submenu child: never listed on the top level. */
  child?: boolean;
}

/** Text of each key, copied from en-us.json. */
export const TEXT: Record<string, string> = {
  'ContextMenu-StashApply': 'Apply Stash',
  'ContextMenu-StashPop': 'Pop Stash',
  'ContextMenu-StashDelete': 'Delete Stash',
  'ContextMenu-Pull': 'Pull (fast-forward if possible)', // PullOptions-Merge
  'ContextMenu-Push': 'Push', // Push
  'ContextMenu-SetUpstream': 'Set Upstream',
  'ContextMenu-MergeBranchIntoBranch': 'Merge {0} into {1}',
  'ContextMenu-FastForward': 'Fast-forward {0} to {1}',
  'ContextMenu-RebaseBranchOntoBranch': 'Rebase {0} onto {1}',
  'ContextMenu-RebaseBranchOntoThisCommit': 'Rebase {0} onto this commit',
  'ContextMenu-Checkout': 'Checkout',
  'ContextMenu-CheckoutBranch': 'Checkout {0}',
  'ContextMenu-CheckoutCommit': 'Checkout this commit',
  'ContextMenu-CheckoutCommitSubmenu': 'this commit',
  'ContextMenu-CreateBranchHere': 'Create branch here',
  'ContextMenu-CherrypickCommit': 'Cherry pick commit',
  'ContextMenu-ResetBranchToThisCommit': 'Reset {0} to this commit',
  'ContextMenu-ResetSoftWithHint': 'Soft - keep all changes',
  'ContextMenu-ResetMixedWithHint': 'Mixed - keep working copy but reset index',
  'ContextMenu-ResetHardWithHint': 'Hard - discard all changes',
  'ContextMenu-RevertCommit': 'Revert commit',
  'ContextMenu-RenameBranch': 'Rename {0}',
  'ContextMenu-DeleteBranch': 'Delete {0}',
  'ContextMenu-DeleteLocalAndRemoteBranches': 'Delete {0} and {1}',
  'ContextMenu-CopyBranchName': 'Copy branch name',
  'ContextMenu-CopyCommitSha': 'Copy commit sha',
  'ContextMenu-CreateTagHere': 'Create tag here',
  'ContextMenu-CreateAnnotatedTag': 'Create annotated tag here',
};

const none = (): string[] => [];
const branchName = (c: MenuCtx): string => c.branch?.name ?? '';
const onLocal = (c: MenuCtx): boolean => !!c.branch?.local;
/** A branch other than the checked-out one, while a branch is checked out. */
const otherBranch = (c: MenuCtx): boolean => !!c.branch && !c.branch.current && c.head.branch !== null;
/** Integrate items need an attached HEAD and no stopped operation. */
const integrable = (c: MenuCtx): boolean => otherBranch(c) && !c.inProgress;
/** Remote items need a local branch, an attached HEAD and no stopped operation. */
const remotable = (c: MenuCtx): boolean => onLocal(c) && c.head.branch !== null && !c.inProgress;
const intoHead = (c: MenuCtx): string[] => [branchName(c), c.head.branch ?? ''];

const onStash = (c: MenuCtx): boolean => c.target === 'stash';

export const ITEMS: MenuItemDef[] = [
  // Stash (phase 9): a stash node or sidebar item has only these three
  { id: 'stash-apply', group: 'stash', key: 'ContextMenu-StashApply', args: none, when: onStash },
  { id: 'stash-pop', group: 'stash', key: 'ContextMenu-StashPop', args: none, when: onStash },
  { id: 'stash-delete', group: 'stash', key: 'ContextMenu-StashDelete', args: none, when: onStash },
  // Remote (phase 7)
  { id: 'pull', group: 'remote', key: 'ContextMenu-Pull', args: none, when: remotable },
  { id: 'push', group: 'remote', key: 'ContextMenu-Push', args: none, when: remotable },
  { id: 'set-upstream', group: 'remote', key: 'ContextMenu-SetUpstream', args: none, when: remotable },
  // Integrate (phase 6)
  { id: 'merge', group: 'integrate', key: 'ContextMenu-MergeBranchIntoBranch', args: intoHead, when: integrable },
  { id: 'fast-forward', group: 'integrate', key: 'ContextMenu-FastForward', args: (c) => [c.head.branch ?? '', branchName(c)], when: (c) => integrable(c) && c.canFastForward === true },
  { id: 'rebase', group: 'integrate', key: 'ContextMenu-RebaseBranchOntoBranch', args: (c) => [c.head.branch ?? '', branchName(c)], when: integrable },
  { id: 'rebase-this-commit', group: 'integrate', key: 'ContextMenu-RebaseBranchOntoThisCommit', args: (c) => [c.head.branch ?? ''], when: (c) => c.target === 'row' && c.head.branch !== null && !c.inProgress },
  // Checkout (phase 5)
  { id: 'checkout', group: 'checkout', key: 'ContextMenu-Checkout', args: none, when: (c) => !!c.branch, submenu: ['checkout-branch', 'checkout-commit-submenu'] },
  { id: 'checkout-branch', group: 'checkout', key: 'ContextMenu-CheckoutBranch', args: (c) => [branchName(c)], when: (c) => !!c.branch && !c.branch.current, child: true },
  { id: 'checkout-commit-submenu', group: 'checkout', key: 'ContextMenu-CheckoutCommitSubmenu', args: none, when: () => true, child: true },
  { id: 'checkout-commit', group: 'checkout', key: 'ContextMenu-CheckoutCommit', args: none, when: (c) => !c.branch },
  // Commit
  { id: 'create-branch-here', group: 'commit', key: 'ContextMenu-CreateBranchHere', args: none, when: () => true },
  // Cherry pick and revert are hidden for a merge commit; every phase 11 commit action needs an attached HEAD and no stopped operation.
  { id: 'cherry-pick', group: 'commit', key: 'ContextMenu-CherrypickCommit', args: none, when: (c) => c.head.branch !== null && !c.inProgress && !c.merge },
  {
    id: 'reset',
    group: 'commit',
    key: 'ContextMenu-ResetBranchToThisCommit',
    args: (c) => [c.head.branch ?? ''],
    when: (c) => c.head.branch !== null && !c.inProgress,
    submenu: ['reset-soft', 'reset-mixed', 'reset-hard'],
  },
  { id: 'reset-soft', group: 'commit', key: 'ContextMenu-ResetSoftWithHint', args: none, when: () => true, child: true },
  { id: 'reset-mixed', group: 'commit', key: 'ContextMenu-ResetMixedWithHint', args: none, when: () => true, child: true },
  { id: 'reset-hard', group: 'commit', key: 'ContextMenu-ResetHardWithHint', args: none, when: () => true, child: true },
  { id: 'revert', group: 'commit', key: 'ContextMenu-RevertCommit', args: none, when: (c) => c.head.branch !== null && !c.inProgress && !c.merge },
  // Branch (phase 11)
  { id: 'rename-branch', group: 'branch', key: 'ContextMenu-RenameBranch', args: (c) => [branchName(c)], when: onLocal },
  { id: 'delete-branch', group: 'branch', key: 'ContextMenu-DeleteBranch', args: (c) => [branchName(c)], when: (c) => onLocal(c) && !c.branch?.current },
  // Phase 11 decision: GitKraken's own item replaces the spec's checkbox. Only for a branch whose upstream is known.
  { id: 'delete-branch-remote', group: 'branch', key: 'ContextMenu-DeleteLocalAndRemoteBranches', args: (c) => [branchName(c), c.upstream ?? ''], when: (c) => onLocal(c) && !c.branch?.current && !!c.upstream },
  // Copy
  { id: 'copy-branch-name', group: 'copy', key: 'ContextMenu-CopyBranchName', args: none, when: (c) => !!c.branch },
  { id: 'copy-commit-sha', group: 'copy', key: 'ContextMenu-CopyCommitSha', args: none, when: () => true },
  // Tags
  { id: 'create-tag-here', group: 'tags', key: 'ContextMenu-CreateTagHere', args: none, when: () => true },
  { id: 'create-annotated-tag', group: 'tags', key: 'ContextMenu-CreateAnnotatedTag', args: none, when: () => true },
];

const GROUP_ORDER: MenuGroup[] = ['stash', 'remote', 'integrate', 'checkout', 'commit', 'branch', 'copy', 'tags'];

function labelOf(def: MenuItemDef, ctx: MenuCtx): string {
  const a = def.args(ctx);
  return (TEXT[def.key] ?? def.key).replace(/\{(\d)\}/g, (_m, i: string) => a[Number(i)] ?? '');
}

/** Entries for one menu: only items whose `when` passes and that have a handler; dividers only between non-empty groups. */
export function buildMenu(ctx: MenuCtx, handlers: Record<string, () => void>): MenuEntry[] {
  const byId = new Map(ITEMS.map((i) => [i.id, i]));
  const noop = (): void => undefined;

  const make = (def: MenuItemDef): MenuEntry | null => {
    if (!def.when(ctx)) return null;
    if (def.submenu) {
      const sub = def.submenu.map((id) => byId.get(id)).flatMap((d) => (d ? [make(d)] : []));
      const entries = sub.filter((e): e is MenuEntry => e !== null);
      if (entries.length === 0) return null;
      return { type: 'item', id: def.id, label: labelOf(def, ctx), run: noop, submenu: entries };
    }
    const run = handlers[def.id];
    if (!run) return null;
    return { type: 'item', id: def.id, label: labelOf(def, ctx), run: () => run() };
  };

  const out: MenuEntry[] = [];
  for (const group of GROUP_ORDER) {
    // A stash target shows only the stash group; every other target never shows it.
    const entries = ITEMS.filter((i) => i.group === group && !i.child && (group === 'stash') === (ctx.target === 'stash'))
      .map(make)
      .filter((e): e is MenuEntry => e !== null);
    if (entries.length === 0) continue;
    if (out.length > 0) out.push({ type: 'divider' });
    out.push(...entries);
  }
  return out;
}
