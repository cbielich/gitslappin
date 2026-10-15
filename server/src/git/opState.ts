import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { OpState } from '@gitslappin/shared';
import { repoIdFor } from '../state/registry';
import { runGit } from './runner';

export type { OpState };

/** Longest state file we read (bytes). */
const MAX_BYTES = 64 * 1024;

const NAMES = ['MERGE_HEAD', 'MERGE_MSG', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const;

interface Text {
  text: string;
  truncated: boolean;
}

/** NUL and control characters out (newline and tab stay), CRLF to LF. */
const clean = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

/** A regular file only: no symlink, FIFO or directory. At most 64 KB, decoded as UTF-8 with replacement. */
async function readState(path: string): Promise<Text | undefined> {
  try {
    const st = await lstat(path);
    if (!st.isFile()) return undefined;
    const fh = await open(path, 'r');
    try {
      const fst = await fh.stat();
      if (!fst.isFile()) return undefined;
      const buf = Buffer.alloc(MAX_BYTES);
      const { bytesRead } = await fh.read(buf, 0, MAX_BYTES, 0);
      return { text: clean(buf.subarray(0, bytesRead).toString('utf8')), truncated: fst.size > MAX_BYTES };
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

const stripHashLines = (s: string): string =>
  s
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .replace(/\s+$/, '');

const trim = (s: string | undefined): string => (s ?? '').trim();

async function out(root: string, repoId: string, args: string[]): Promise<string | undefined> {
  const r = await runGit(args, { cwd: root, repoId });
  return r.code === 0 ? r.stdout : undefined;
}

async function currentBranch(root: string, repoId: string): Promise<string> {
  const b = trim(await out(root, repoId, ['symbolic-ref', '-q', '--short', 'HEAD']));
  return clean(b) || 'HEAD';
}

/** Name of a branch at this commit (local first, then remote), else the short sha. */
async function nameForSha(root: string, repoId: string, sha: string): Promise<string> {
  if (/^[0-9a-f]{40,64}$/.test(sha)) {
    for (const prefix of ['refs/heads', 'refs/remotes']) {
      const list = await out(root, repoId, ['for-each-ref', '--format=%(refname:short)', '--points-at', sha, prefix]);
      const first = list?.split('\n').find((l) => l.trim() !== '' && !l.endsWith('/HEAD'));
      if (first) return clean(first.trim());
    }
  }
  return sha.slice(0, 7);
}

/** What a merge was asked to merge: the name from git's own merge message, else a branch at that commit. */
async function mergeOther(root: string, repoId: string, sha: string, rawMsg: string | undefined): Promise<string> {
  const first = (rawMsg ?? '').split('\n')[0] ?? '';
  const m = /^Merge (?:remote-tracking branch|branch|tag|commit) '(.+?)'/.exec(first);
  if (m?.[1]) return m[1];
  return nameForSha(root, repoId, sha);
}

/**
 * The name the user gave `git rebase`, from the HEAD reflog ("rebase (start): checkout <name>"). Only an entry written
 * after the rebase directory was created counts (an older rebase's entry must not name this one); else the sha is used.
 * `stateDir` is that directory: its birth time (or its mtime when the file system gives none) is the earliest start.
 */
async function rebaseOntoName(root: string, repoId: string, ontoSha: string, stateDir: string): Promise<string> {
  let startedAt = 0;
  try {
    const st = await lstat(stateDir);
    startedAt = Math.floor((st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs) / 1000);
  } catch {
    startedAt = Number.POSITIVE_INFINITY;
  }
  const log = await out(root, repoId, ['reflog', 'show', '--format=%gd%x09%gs', '--date=unix', '-n', '1000', 'HEAD', '--']);
  for (const line of (log ?? '').split('\n')) {
    const tab = line.indexOf('\t');
    const at = Number(/@\{(\d+)\}$/.exec(line.slice(0, tab < 0 ? 0 : tab))?.[1]);
    if (!Number.isFinite(at) || at < startedAt) continue;
    const m = /^rebase(?: \(start\))?: checkout (.+)$/.exec(line.slice(tab + 1).trim());
    if (m?.[1]) return clean(m[1]).replace(/^refs\/(?:heads|remotes)\//, '');
  }
  return nameForSha(root, repoId, ontoSha);
}

/** Which backend runs the stopped rebase: `merge` (rebase-merge/), `apply` (rebase-apply/ but not git am), or undefined. */
export async function rebaseBackend(root: string): Promise<'merge' | 'apply' | undefined> {
  const res = await runGit(['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply'], { cwd: root, repoId: repoIdFor(root) });
  if (res.code !== 0) return undefined;
  const [merge = '', apply = ''] = res.stdout.split('\n').map((l) => resolve(root, l.trim()));
  if (await isDir(merge)) return 'merge';
  if ((await isDir(apply)) && !(await isFile(resolve(apply, 'applying')))) return 'apply';
  return undefined;
}

/**
 * The operation that is stopped in this repo, or undefined. One `rev-parse --git-path` call finds the state files
 * (they live elsewhere in a worktree), then they are read with fs. Order: rebase-merge, rebase-apply (git am counts
 * as none), MERGE_HEAD, CHERRY_PICK_HEAD / REVERT_HEAD.
 */
export async function readOpState(root: string): Promise<OpState | undefined> {
  const repoId = repoIdFor(root);
  const unmergedRun = runGit(['ls-files', '-u', '-z'], { cwd: root, repoId }); // started now so it runs beside the next call; read at the end
  const res = await runGit(['rev-parse', ...NAMES.flatMap((n) => ['--git-path', n])], { cwd: root, repoId });
  if (res.code !== 0) return undefined;
  const lines = res.stdout.split('\n');
  const p: Record<(typeof NAMES)[number], string> = {} as never;
  NAMES.forEach((n, i) => {
    p[n] = resolve(root, (lines[i] ?? '').trim());
  });

  const merge = (name: string): Promise<Text | undefined> => readState(resolve(p['rebase-merge'], name));

  if (await isDir(p['rebase-merge'])) {
    const headName = trim((await merge('head-name'))?.text);
    const onto = trim((await merge('onto'))?.text);
    const msg = await merge('message');
    const step = Number(trim((await merge('msgnum'))?.text));
    const total = Number(trim((await merge('end'))?.text));
    const head = headName.startsWith('refs/heads/') ? headName.slice('refs/heads/'.length) : headName.startsWith('refs/') ? headName : 'HEAD';
    return {
      kind: 'rebase',
      head: head === 'HEAD' ? 'HEAD' : head,
      onto: await rebaseOntoName(root, repoId, onto, p['rebase-merge']),
      ...(Number.isInteger(step) && step > 0 ? { step } : {}),
      ...(Number.isInteger(total) && total > 0 ? { total } : {}),
      message: (msg?.text ?? '').replace(/\s+$/, ''),
      ...(msg?.truncated ? { truncated: true } : {}),
    };
  }

  if (await isDir(p['rebase-apply'])) {
    if (await isFile(resolve(p['rebase-apply'], 'applying'))) return undefined; // git am
    const read = (name: string): Promise<Text | undefined> => readState(resolve(p['rebase-apply'], name));
    const headName = trim((await read('head-name'))?.text);
    const onto = trim((await read('onto'))?.text);
    const msg = await read('final-commit');
    const step = Number(trim((await read('next'))?.text));
    const total = Number(trim((await read('last'))?.text));
    return {
      kind: 'rebase',
      head: headName.startsWith('refs/heads/') ? headName.slice('refs/heads/'.length) : 'HEAD',
      onto: await rebaseOntoName(root, repoId, onto, p['rebase-apply']),
      ...(Number.isInteger(step) && step > 0 ? { step } : {}),
      ...(Number.isInteger(total) && total > 0 ? { total } : {}),
      message: (msg?.text ?? '').replace(/\s+$/, ''),
      ...(msg?.truncated ? { truncated: true } : {}),
    };
  }

  const mergeMsg = async (): Promise<Text | undefined> => readState(p['MERGE_MSG']);

  if (await isFile(p['MERGE_HEAD'])) {
    const sha = trim((await readState(p['MERGE_HEAD']))?.text).split('\n')[0] ?? '';
    const msg = await mergeMsg();
    return {
      kind: 'merge',
      head: await currentBranch(root, repoId),
      other: await mergeOther(root, repoId, sha, msg?.text),
      message: stripHashLines(msg?.text ?? ''),
      ...(msg?.truncated ? { truncated: true } : {}),
    };
  }

  for (const [kind, name] of [['cherry-pick', 'CHERRY_PICK_HEAD'], ['revert', 'REVERT_HEAD']] as const) {
    if (!(await isFile(p[name]))) continue;
    const sha = trim((await readState(p[name]))?.text).split('\n')[0] ?? '';
    const msg = await mergeMsg();
    return {
      kind,
      head: await currentBranch(root, repoId),
      other: sha.slice(0, 7),
      message: stripHashLines(msg?.text ?? ''),
      ...(msg?.truncated ? { truncated: true } : {}),
    };
  }
  // Unmerged entries with no other state file: left by a stash apply or pop that conflicted (git keeps no marker of its own).
  const unmerged = await unmergedRun;
  if (unmerged.code === 0 && unmerged.stdout !== '') return { kind: 'stash', head: await currentBranch(root, repoId), message: '' };
  return undefined;
}
