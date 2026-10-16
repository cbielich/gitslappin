import { resetFacts } from './resetFacts';
import { runGit, type GitResult } from './runner';
import { pin } from './snapshot';
import type { UndoResult } from './undo';

/*
 * V4: the `rewrite` journal kind (reword, squash, interactive rebase, multi cherry-pick; part B reuses it) and its undo / redo.
 * Same tree before and after: `update-ref` compare-and-swap only (index and worktree are never touched). Different tree: the check and
 * `reset --keep` run in the undo step's own lock; any tracked change, or any untracked / ignored file on a path the move would write,
 * refuses (never snapshot-and-proceed, never --hard, never -f). The tip that is left is pinned before the branch moves.
 */

export interface RewriteEntry {
  kind: 'rewrite';
  branch: string;
  oldTip: string;
  newTip: string;
  /** The old and the new tip have the same tree (reword, squash). */
  sameTree: boolean;
  label: string;
}

const SHA = /^[0-9a-f]{40,64}$/;
const MISSING = 'Undo information is missing - it has likely been garbage collected.';
const clean = (s: string): string => s.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
const cut = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

const run = (root: string, repoId: string, args: string[]): Promise<GitResult> =>
  runGit(args, { cwd: root, repoId, timeoutMs: 5 * 60 * 1000, env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });

const refused = (error: string): UndoResult => ({ outcome: 'refused', error });
const failed = (res: GitResult, fallback: string): UndoResult => ({
  outcome: 'failed',
  error: res.stderr.trim().split('\n')[0] || fallback,
  stderr: res.stderr.trim() || `git exited with code ${res.code}.`,
});

/** Label for the journal: control characters out, cut to 60 characters. */
export const rewriteLabel = (verb: string, subject: string): string => `${verb} '${cut(clean(subject))}'`;

/** Undo moves newTip -> oldTip, redo moves oldTip -> newTip. `cur` is the HEAD right now (read inside the lock). */
export async function moveRewrite(root: string, repoId: string, e: RewriteEntry, dir: 'undo' | 'redo', cur: { sha: string | null; branch: string | null }): Promise<UndoResult> {
  const from = dir === 'undo' ? e.newTip : e.oldTip;
  const to = dir === 'undo' ? e.oldTip : e.newTip;
  if (!SHA.test(from) || !SHA.test(to) || e.branch === '' || e.branch.startsWith('-')) return refused(MISSING);
  if (cur.branch !== e.branch || cur.sha !== from) return refused('The branch has changed since this was rewritten.');
  if ((await run(root, repoId, ['cat-file', '-e', `${to}^{commit}`])).code !== 0) return refused(MISSING);
  const ref = `refs/heads/${e.branch}`;

  if (!e.sameTree) {
    const facts = await resetFacts(root, repoId, from, to, 'hard');
    if ('code' in facts) return failed(facts, 'git failed.');
    if (facts.trackedDirty) return refused('There are uncommitted changes.');
    const first = facts.collisions[0];
    if (first !== undefined) return refused(`'${cut(clean(first))}' exists in the working tree, so the history cannot be moved.`);
  }
  if (!(await pin(root, repoId, from))) return refused('Could not protect the current tip before moving it.');

  if (e.sameTree) {
    // Compare-and-swap: only moves the branch if it still is where this entry left it.
    const res = await run(root, repoId, ['update-ref', '-m', `gitslappin: ${dir} ${e.label}`.slice(0, 200), ref, to, from]);
    return res.code === 0 ? { outcome: 'done' } : failed(res, 'git update-ref failed.');
  }
  const res = await run(root, repoId, ['reset', '--keep', to, '--']);
  return res.code === 0 ? { outcome: 'done' } : failed(res, 'git reset failed.');
}
