import { EOL } from 'node:os';
import { appendIgnore, ignorePattern, type IgnoreMode } from '@gitslappin/shared';
import { repoIdFor } from '../state/registry';
import { readGitignore, writeGitignore, type IgnoreRemoved } from './ignoreUndo';
import { readOpState } from './opState';
import { runExclusive } from './queue';
import { runGit, type GitResult } from './runner';
import { safeRepoPath } from './safeRepoPath';
import { hashBytes, pin } from './snapshot';
import { MAX_PATHS } from './stageCommands';
import { record } from './undo';

/*
 * V3 Ignore. The pattern text is built here from the paths (shared/ignorePattern), never taken from the client. One lock for the
 * whole thing: validate, pin the old and the new .gitignore, write it (temp + rename), then (optionally) `rm --cached` the tracked paths.
 */

export interface IgnoreRequest {
  paths: string[];
  mode: IgnoreMode;
  untrack: boolean;
}

export interface IgnoreResult {
  outcome: 'done' | 'noop' | 'refused' | 'failed' | 'blocked';
  error?: string;
  stderr?: string;
}

const run = (root: string, repoId: string, args: string[], input?: string | Buffer): Promise<GitResult> =>
  runGit(args, { cwd: root, repoId, timeoutMs: 5 * 60 * 1000, ...(input === undefined ? {} : { input }) });
const refused = (error: string): IgnoreResult => ({ outcome: 'refused', error });
const failed = (res: GitResult, fallback: string): IgnoreResult => ({
  outcome: 'failed',
  error: res.stderr.trim().split('\n')[0] || fallback,
  stderr: res.stderr.trim() || `git exited with code ${res.code}.`,
});
const clean = (s: string): string => s.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
const cut = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

/** `status --porcelain=v1 -z`: "XY path\0", and for a rename or copy "XY new\0old\0". Every listed path. */
function statusPaths(out: string): Set<string> {
  const parts = out.split('\0');
  const set = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? '';
    if (p.length < 4) continue;
    set.add(p.slice(3));
    if ('RC'.includes(p.charAt(0)) || 'RC'.includes(p.charAt(1))) i++;
  }
  return set;
}

export function ignorePaths(root: string, req: IgnoreRequest): Promise<IgnoreResult> {
  const repoId = repoIdFor(root);
  return runExclusive<IgnoreResult>(repoId, async () => {
    if ((await readOpState(root)) !== undefined) return { outcome: 'blocked', error: 'Another operation is in progress.' };
    const { paths, mode, untrack } = req;
    if (!Array.isArray(paths) || paths.length === 0) return refused('No paths given.');
    if (paths.length > MAX_PATHS) return refused('Too many paths.');
    if (mode !== 'file' && mode !== 'ext' && mode !== 'folder') return refused('Invalid request.');
    for (const p of paths) {
      if (typeof p !== 'string') return refused('Invalid path.');
      try {
        safeRepoPath(root, p);
      } catch {
        return refused('Invalid path.');
      }
    }
    const unique = [...new Set(paths)];

    // Already ignored paths add nothing (--no-index: a tracked file counts too). An ignored path is not in the status list, so this comes first.
    // In folder mode each path IS the folder (no trailing slash): exactly that folder's pattern is written.
    let todo = unique;
    if (mode !== 'folder') {
      const chk = await run(root, repoId, ['check-ignore', '--no-index', '-z', '--stdin'], `${unique.join('\0')}\0`);
      if (chk.code !== 0 && chk.code !== 1) return failed(chk, 'git check-ignore failed.');
      const already = new Set(chk.stdout.split('\0').filter(Boolean));
      todo = unique.filter((p) => !already.has(p));
    }

    // Every other path (a folder: at least one path under it) must be listed in the server's own status.
    const st = await run(root, repoId, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (st.code !== 0) return failed(st, 'git status failed.');
    const listed = statusPaths(st.stdout);
    const inList = (p: string): boolean => (mode === 'folder' ? [...listed].some((l) => l.startsWith(`${p}/`)) : listed.has(p));
    if (todo.some((p) => !inList(p))) return refused('That path is not in the list of changes.');
    const patterns: string[] = [];
    for (const p of todo) {
      const pat = ignorePattern(mode === 'folder' ? `${p}/x` : p, mode);
      if (pat === null) continue;
      if (!patterns.includes(pat)) patterns.push(pat);
    }
    if (patterns.length === 0 && todo.length > 0) return refused('Nothing can be ignored with that choice.');

    const cur = await readGitignore(root);
    if (!cur) return refused('.gitignore is not a regular file.');
    const old = cur.kind === 'file' ? cur.bytes : null;
    const eol = EOL === '\r\n' ? '\r\n' : '\n';
    let bytes: Uint8Array | null = old;
    for (const pat of patterns) bytes = appendIgnore(bytes, pat, eol);
    const next = bytes ? Buffer.from(bytes) : Buffer.alloc(0);

    // What would leave the index (decided before the write, executed after it): tracked paths among all the validated ones
    // (already-ignored included); in folder mode only the tracked files under the folder that are in the current status.
    const removed: IgnoreRemoved[] = [];
    if (untrack) {
      const ls = await run(root, repoId, ['ls-files', '-s', '-z']);
      if (ls.code !== 0) return failed(ls, 'git ls-files failed.');
      const want = new Set(unique);
      for (const rec of ls.stdout.split('\0')) {
        const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(rec);
        if (!m) continue;
        const path = m[4]!;
        const hit = mode === 'folder' ? listed.has(path) && unique.some((d) => path.startsWith(`${d}/`)) : want.has(path);
        if (!hit) continue;
        if (m[3] !== '0') return refused('That file has merge conflicts.');
        removed.push({ mode: m[1]!, sha: m[2]!, path });
      }
    }
    if (patterns.length === 0 && removed.length === 0) return { outcome: 'noop' };

    // Pin the old and the new bytes first: if that fails nothing is written.
    let before: string | null = null;
    if (old) {
      before = await hashBytes(root, repoId, old, true);
      if (!before || !(await pin(root, repoId, before))) return { outcome: 'failed', error: 'The old .gitignore could not be saved, so nothing was changed.' };
    }
    const after = await hashBytes(root, repoId, next, true);
    if (!after || !(await pin(root, repoId, after))) return { outcome: 'failed', error: 'The new .gitignore could not be saved, so nothing was changed.' };

    const err = await writeGitignore(root, next);
    if (err) return { outcome: 'failed', error: err };
    const name = unique[0]!.slice(unique[0]!.lastIndexOf('/') + 1);
    const label = unique.length === 1 ? `ignore '${cut(clean(name))}'` : `ignore ${unique.length} files`;

    let rm: GitResult | null = null;
    if (removed.length > 0) {
      // Literal pathspecs as a global option (an env variable would be dropped); --cached is always there, -r never.
      rm = await run(root, repoId, ['--literal-pathspecs', 'rm', '--cached', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], `${removed.map((r) => r.path).join('\0')}\0`);
    }
    // The .gitignore was written either way, so it is recorded (with nothing removed when git rm failed, which leaves the index as it was).
    record(root, { kind: 'ignore', before, after, removed: rm && rm.code !== 0 ? [] : removed, label });
    if (rm && rm.code !== 0) return failed(rm, 'git rm failed.');
    return { outcome: 'done' };
  });
}
