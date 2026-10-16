import { runGit, type GitResult } from './runner';

const TIMEOUT_MS = 5 * 60 * 1000;
const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } as const;
const run = (root: string, repoId: string, args: string[]): Promise<GitResult> => runGit(args, { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });

/**
 * What a reset could lose: tracked changes in the index or the worktree, and (hard only) untracked or ignored files, or files in
 * the way of a folder, on paths the target tree would write. A collision counts as dirty (data-safety item 7).
 * Its own module (imports only the runner) so rewriteUndo and destructive do not import each other.
 */
export async function resetFacts(root: string, repoId: string, headSha: string, target: string, mode: 'mixed' | 'hard'): Promise<{ trackedDirty: boolean; collisions: string[] } | GitResult> {
  const dirty = await run(root, repoId, ['status', '--porcelain', '--untracked-files=no', '-z']);
  if (dirty.code !== 0) return dirty;
  const trackedDirty = dirty.stdout !== '';
  const collisions: string[] = [];
  if (mode === 'hard') {
    const [changed, others, ignored] = await Promise.all([
      run(root, repoId, ['diff', '--name-only', '-z', '--no-renames', headSha, target]),
      run(root, repoId, ['ls-files', '--others', '--exclude-standard', '-z']),
      run(root, repoId, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
    ]);
    for (const r of [changed, others, ignored]) if (r.code !== 0) return r;
    const there = new Set([...others.stdout.split('\0'), ...ignored.stdout.split('\0')].filter((p) => p !== ''));
    const names = changed.stdout.split('\0').filter((p) => p !== '');
    for (const p of names) if (there.has(p) && !collisions.includes(p)) collisions.push(p);
    // A file where the target needs a folder.
    for (const p of names) {
      const segs = p.split('/');
      for (let i = 1; i < segs.length; i++) {
        const parent = segs.slice(0, i).join('/');
        if (there.has(parent) && !collisions.includes(parent)) collisions.push(parent);
      }
    }
    // A folder (untracked or ignored files under `a/`) where the target adds a file `a`: every file under it is pinned.
    for (const p of names) {
      const prefix = `${p}/`;
      for (const t of there) if (t.startsWith(prefix) && !collisions.includes(t)) collisions.push(t);
    }
  }
  return { trackedDirty, collisions };
}
