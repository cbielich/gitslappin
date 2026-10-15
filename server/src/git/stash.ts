import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { repoIdFor } from '../state/registry';
import { readOpState } from './opState';
import { runExclusive } from './queue';
import { runGit, type EnvOverride, type GitResult } from './runner';
import { scrubSecrets } from './scrub';

/*
 * Stash (phase 9). Every function takes the repo root, runs inside one runExclusive for the repo and returns a
 * StashResult; none throws for a git failure. A stash is always addressed by its commit sha (40-64 lowercase hex), which is
 * turned into `stash@{n}` inside the lock, so a shifted list can never hit the wrong entry. Nothing here passes a force flag.
 */

export interface StashResult {
  outcome: 'done' | 'conflict' | 'failed' | 'blocked' | 'refused' | 'not-found' | 'invalid';
  error?: string;
  stderr?: string;
  sha?: string;
  base?: string;
}

export interface StashFile {
  path: string;
  status: 'M' | 'A' | 'D' | 'R';
  oldPath?: string;
}

export type StashFilesResult = { outcome: 'done'; files: StashFile[]; truncated?: boolean } | { outcome: 'not-found' | 'invalid' };

/** What phase 10 (undo) records. `message` is the stash's own subject (e.g. "On main: x"). */
export type StashEvent =
  | { kind: 'stash'; sha: string; base: string; message: string }
  | { kind: 'pop'; sha: string; message: string; cleanBefore: boolean }
  | { kind: 'drop'; sha: string; message: string };

type Recorder = (root: string, event: StashEvent) => void | Promise<void>;
let recorder: Recorder | null = null;
/** Phase 10 hook: called inside the lock, after a push, a conflict-free pop or a drop succeeded. It may run git (it is awaited). Never throws into the caller. */
export function setStashRecorder(fn: Recorder | null): void {
  recorder = fn;
}
async function record(root: string, event: StashEvent): Promise<void> {
  try {
    await recorder?.(root, event);
  } catch {
    /* the journal must never break a stash */
  }
}

const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_FILES = 5000;
const SHA = /^[0-9a-f]{40,64}$/;
const ENV: EnvOverride = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
/** Text of ErrorMessage-CannotApplyStashWhenFilesAreStaged. */
export const STAGED_REFUSAL = 'Cannot apply stash while anything is staged. Stash, commit, or unstage first.';

const invalid = (error: string): StashResult => ({ outcome: 'invalid', error });
const blocked = (): StashResult => ({ outcome: 'blocked', error: 'Another operation is in progress.' });

function failed(res: GitResult, fallback: string): StashResult {
  const text = scrubSecrets(`${res.stderr}${res.stdout}`.trim());
  return { outcome: 'failed', error: text.split('\n')[0] || fallback, stderr: text || `git exited with code ${res.code}.` };
}

const run = (root: string, repoId: string, args: string[], input?: string | Buffer): Promise<GitResult> =>
  runGit(args, { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: ENV, ...(input === undefined ? {} : { input }) });

interface Entry {
  n: number;
  sha: string;
  message: string;
}

async function listStashes(root: string, repoId: string): Promise<Entry[]> {
  const res = await run(root, repoId, ['stash', 'list', '--format=%H%x00%gs%x1e']);
  if (res.code !== 0) return [];
  const out: Entry[] = [];
  for (const rec of res.stdout.split('\x1e')) {
    const text = rec.replace(/^\n+/, '');
    if (!text) continue;
    const [sha = '', message = ''] = text.split('\0');
    if (SHA.test(sha)) out.push({ n: out.length, sha, message });
  }
  return out;
}

/** True when anything is unmerged or any other operation is stopped. */
const stopped = async (root: string): Promise<boolean> => (await readOpState(root)) !== undefined;

async function nul(root: string, repoId: string, args: string[]): Promise<string[]> {
  const res = await run(root, repoId, args);
  return res.code === 0 ? res.stdout.split('\0').filter((p) => p !== '') : [];
}

async function treeIsClean(root: string, repoId: string): Promise<boolean> {
  const res = await run(root, repoId, ['status', '--porcelain', '--untracked-files=all', '-z']);
  return res.code === 0 && res.stdout === '';
}

/** Is this sha an entry of `stash list` right now (for reads outside this module)? */
export async function isStashSha(root: string, sha: string): Promise<boolean> {
  return SHA.test(sha) && (await listStashes(root, repoIdFor(root))).some((e) => e.sha === sha);
}

export function stashPush(root: string, opts: { message?: string; fromTab?: boolean } = {}): Promise<StashResult> {
  const message = opts.message;
  if (message !== undefined) {
    if (typeof message !== 'string') return Promise.resolve(invalid('Invalid stash message.'));
    if (message.includes('\0') || Buffer.from(message, 'utf8').toString('utf8') !== message || Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) return Promise.resolve(invalid('Invalid stash message.'));
  }
  const repoId = repoIdFor(root);
  return runExclusive<StashResult>(repoId, async () => {
    if (await stopped(root)) return blocked();
    const baseRes = await run(root, repoId, ['rev-parse', '-q', '--verify', 'HEAD']);
    if (baseRes.code !== 0) return { outcome: 'failed', error: 'You do not have the initial commit yet.' };
    const base = baseRes.stdout.trim();
    const before = (await listStashes(root, repoId))[0]?.sha;

    let args: string[];
    let input: string | undefined;
    if (opts.fromTab) {
      // Only the staged paths, read here (never from the client). A whole file is stashed, staged and unstaged part.
      const staged = await nul(root, repoId, ['diff', '--cached', '--name-only', '-z', '--no-renames']);
      if (staged.length === 0) return { outcome: 'refused', error: 'There are no staged changes to stash.' };
      const deleted = await nul(root, repoId, ['diff', '--cached', '--name-only', '--diff-filter=D', '-z', '--no-renames']);
      if (deleted.length === 0) {
        args = ['--literal-pathspecs', 'stash', 'push', '--include-untracked', ...(message ? ['-m', message] : []), '--pathspec-from-file=-', '--pathspec-file-nul'];
        input = `${staged.join('\0')}\0`;
      } else {
        // git cannot take a pathspec for a path that is gone from both the index and the working tree: it saves the stash and then
        // stops half way ("pathspec did not match"). So the stash is asked for everything EXCEPT the paths that are not staged.
        const stagedSet = new Set(staged);
        const status = await run(root, repoId, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
        if (status.code !== 0) return failed(status, 'git status failed.');
        const others = status.stdout
          .split('\0')
          .filter((e) => e.length > 3)
          .map((e) => e.slice(3))
          .filter((p) => !stagedSet.has(p));
        args = ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : []), '--pathspec-from-file=-', '--pathspec-file-nul'];
        input = `${['.', ...others.map((p) => `:(exclude,literal)${p}`)].join('\0')}\0`;
      }
    } else {
      if (await treeIsClean(root, repoId)) return { outcome: 'refused', error: 'No local changes to save.' };
      args = ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])];
    }
    const res = await run(root, repoId, args, input);
    if (res.code !== 0) return failed(res, 'git stash failed.');
    const top = (await listStashes(root, repoId))[0];
    if (!top || top.sha === before) return { outcome: 'refused', error: 'No local changes to save.' };
    await record(root, { kind: 'stash', sha: top.sha, base, message: top.message });
    return { outcome: 'done', sha: top.sha, base };
  });
}

/** Keeps the commit of a stash reachable, so a drop or pop can always be undone. */
async function keep(root: string, repoId: string, sha: string): Promise<boolean> {
  return (await run(root, repoId, ['update-ref', `refs/gitslappin/stash-keep/${sha}`, sha])).code === 0;
}

/**
 * Paths the stash would write over: files it changes that have local edits or are untracked here, and its untracked files
 * that already exist. Git applies part of a stash before it notices such a clash, so this is checked first and nothing runs.
 */
async function clashes(root: string, repoId: string, sha: string): Promise<string[]> {
  const [changed, untracked, dirty, others, ignored] = await Promise.all([
    nul(root, repoId, ['diff-tree', '-r', '-z', '--name-only', '--no-commit-id', `${sha}^1`, sha]),
    nul(root, repoId, ['ls-tree', '-r', '-z', '--name-only', `${sha}^3`]),
    nul(root, repoId, ['diff', '--name-only', '-z', 'HEAD']),
    nul(root, repoId, ['ls-files', '--others', '--exclude-standard', '-z']),
    nul(root, repoId, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
  ]);
  // NTFS compares names without regard to case, so a path that only differs in case is the same file there.
  const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const local = new Set([...dirty, ...others, ...ignored].map(norm));
  const exists = (p: string): boolean => {
    try {
      lstatSync(join(root, p));
      return true;
    } catch {
      return false;
    }
  };
  /** A parent segment that is a file (or a link) where the stash needs a directory: git would fail halfway (ENOTDIR). */
  const parentBlocked = (p: string): boolean => {
    const segs = p.split('/').slice(0, -1);
    for (let i = 1; i <= segs.length; i++) {
      try {
        if (!lstatSync(join(root, ...segs.slice(0, i))).isDirectory()) return true;
      } catch {
        return false; // this segment does not exist, so neither do the deeper ones
      }
    }
    return false;
  };
  const adds = [...changed, ...untracked];
  return [...new Set([...changed.filter((p) => local.has(norm(p))), ...untracked.filter(exists), ...adds.filter(parentBlocked)])];
}

export function stashApply(root: string, sha: string, pop: boolean): Promise<StashResult> {
  if (typeof sha !== 'string' || !SHA.test(sha)) return Promise.resolve(invalid('Invalid stash.'));
  const repoId = repoIdFor(root);
  return runExclusive<StashResult>(repoId, async () => {
    if (await stopped(root)) return blocked();
    const entry = (await listStashes(root, repoId)).find((e) => e.sha === sha);
    if (!entry) return { outcome: 'not-found', error: 'That stash no longer exists.' };
    const staged = await nul(root, repoId, ['diff', '--cached', '--name-only', '-z']);
    if (staged.length > 0) return { outcome: 'refused', error: STAGED_REFUSAL };
    const cleanBefore = await treeIsClean(root, repoId);
    const clash = await clashes(root, repoId, sha);
    if (clash.length > 0) {
      const lines = ['error: Your local changes to the following files would be overwritten by merge:', ...clash.slice(0, 20).map((c) => '\t' + c), 'Please commit your changes or stash them before you merge.', 'Aborting'];
      return { outcome: 'failed', error: lines[0] as string, stderr: scrubSecrets(lines.join('\n')) };
    }
    if (pop && !(await keep(root, repoId, sha))) return { outcome: 'failed', error: 'Could not protect the stash before popping it.' };
    const res = await run(root, repoId, ['stash', pop ? 'pop' : 'apply', `stash@{${entry.n}}`]);
    if (res.code === 0) {
      if (pop) await record(root, { kind: 'pop', sha, message: entry.message, cleanBefore });
      return { outcome: 'done' };
    }
    // Conflicts are not an error: the entries stay unmerged (a pop then keeps the stash) and the conflict screens take over.
    if (await stopped(root)) return { outcome: 'conflict' };
    return failed(res, 'git stash failed.');
  });
}

export function stashDrop(root: string, sha: string): Promise<StashResult> {
  if (typeof sha !== 'string' || !SHA.test(sha)) return Promise.resolve(invalid('Invalid stash.'));
  const repoId = repoIdFor(root);
  return runExclusive<StashResult>(repoId, async () => {
    if (await stopped(root)) return blocked();
    const entry = (await listStashes(root, repoId)).find((e) => e.sha === sha);
    if (!entry) return { outcome: 'not-found', error: 'That stash no longer exists.' };
    if (!(await keep(root, repoId, sha))) return { outcome: 'failed', error: 'Could not protect the stash before deleting it.' };
    const res = await run(root, repoId, ['stash', 'drop', `stash@{${entry.n}}`]);
    if (res.code !== 0) return failed(res, 'git stash drop failed.');
    await record(root, { kind: 'drop', sha, message: entry.message });
    return { outcome: 'done' };
  });
}

const STATUS: Record<string, StashFile['status']> = { M: 'M', A: 'A', D: 'D', T: 'M', R: 'R', C: 'A' };

/** Files of one stash: tracked changes from `sha^1` to `sha`, then the untracked files of `sha^3` (marked A). */
export async function stashFiles(root: string, sha: string): Promise<StashFilesResult> {
  if (typeof sha !== 'string' || !SHA.test(sha)) return { outcome: 'invalid' };
  const repoId = repoIdFor(root);
  if (!(await listStashes(root, repoId)).some((e) => e.sha === sha)) return { outcome: 'not-found' };
  const files: StashFile[] = [];
  const tok = await nul(root, repoId, ['diff-tree', '-r', '-z', '--name-status', '-M', '--no-commit-id', `${sha}^1`, sha]);
  for (let i = 0; i < tok.length; ) {
    const code = tok[i++] ?? '';
    const status = STATUS[code.charAt(0)] ?? 'M';
    if (code.charAt(0) === 'R' || code.charAt(0) === 'C') {
      const oldPath = tok[i++] ?? '';
      const path = tok[i++] ?? '';
      files.push(status === 'R' ? { path, status, oldPath } : { path, status });
    } else files.push({ path: tok[i++] ?? '', status });
  }
  const seen = new Set(files.map((f) => f.path));
  for (const path of await nul(root, repoId, ['ls-tree', '-r', '-z', '--name-only', `${sha}^3`])) {
    if (!seen.has(path)) files.push({ path, status: 'A' });
  }
  return files.length > MAX_FILES ? { outcome: 'done', files: files.slice(0, MAX_FILES), truncated: true } : { outcome: 'done', files };
}
