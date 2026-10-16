import { repoIdFor } from '../state/registry';
import { record } from './undo';
import { runGit } from './runner';

/*
 * V4: a rebase (interactive rebase or multi cherry-pick) that stopped on a conflict keeps its journal entry here, in memory. It is
 * journaled when the continue or skip that ends the rebase succeeds, and dropped when the rebase is aborted or another one starts.
 */

interface Pending {
  branch: string;
  oldTip: string;
  label: string;
}
const pending = new Map<string, Pending>();

export const setPending = (root: string, p: Pending): void => void pending.set(repoIdFor(root), p);
export const clearPending = (root: string): void => void pending.delete(repoIdFor(root));

const read = async (root: string, repoId: string, args: string[]): Promise<string> => {
  const r = await runGit(args, { cwd: root, repoId });
  return r.code === 0 ? r.stdout.trim() : '';
};

/** After a rebase ended cleanly. Records the pending entry when the branch still is the one that was rewritten. */
export async function finishPending(root: string): Promise<void> {
  const repoId = repoIdFor(root);
  const p = pending.get(repoId);
  if (!p) return;
  pending.delete(repoId);
  const [tip, branch] = await Promise.all([read(root, repoId, ['rev-parse', '--verify', 'HEAD']), read(root, repoId, ['symbolic-ref', '-q', '--short', 'HEAD'])]);
  if (tip === '' || branch !== p.branch || tip === p.oldTip) return;
  const [a, b] = await Promise.all([read(root, repoId, ['rev-parse', `${p.oldTip}^{tree}`]), read(root, repoId, ['rev-parse', `${tip}^{tree}`])]);
  record(root, { kind: 'rewrite', branch, oldTip: p.oldTip, newTip: tip, sameTree: a !== '' && a === b, label: p.label });
}
