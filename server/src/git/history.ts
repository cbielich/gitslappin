import { createHash } from 'node:crypto';
import type { LogCommit, StashInfo } from '@gitslappin/shared';
import { runGit } from './runner';
import { isOwnRef, OWN_REF_EXCLUDES } from './ownRefs';
import { LOG_FORMAT, parseLog } from './parsers/log';
import { STASH_FORMAT, parseStashList } from './parsers/refs';

/** Ordered graph commits of one repo (`git log --all --date-order`), cached until the refs change. */
export interface History {
  fingerprint: string;
  commits: LogCommit[];
  indexBySha: Map<string, number>;
}

interface Entry {
  fingerprint: string;
  promise: Promise<History>;
}

const cache = new Map<string, Entry>();
const HISTORY_TIMEOUT_MS = 300_000;

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** Hash of the for-each-ref output + HEAD + the stash list. Cheap: three small git calls. */
export async function refsFingerprint(root: string, repoId: string): Promise<{ fingerprint: string; empty: boolean; stashes: StashInfo[] }> {
  const [fer, head, stash] = await Promise.all([
    runGit(['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: root, repoId }),
    runGit(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root, repoId }),
    runGit(['stash', 'list', `--format=${STASH_FORMAT}`], { cwd: root, repoId }),
  ]);
  const stashes = stash.code === 0 ? parseStashList(stash.stdout) : [];
  const headSha = head.code === 0 ? head.stdout.trim() : '';
  // Our own snapshot refs (either namespace) are not part of the graph, so they do not count here either.
  const refLines = fer.stdout.split('\n').filter((l) => !isOwnRef(l)).join('\n');
  const empty = refLines.trim() === '' && headSha === '' && stashes.length === 0;
  return { fingerprint: sha1(`${refLines}\n${headSha}\n${stash.stdout}`), empty, stashes };
}

async function build(root: string, repoId: string, fingerprint: string, empty: boolean, stashes: StashInfo[]): Promise<History> {
  if (empty) return { fingerprint, commits: [], indexBySha: new Map() };
  const stashBySha = new Map(stashes.map((s) => [s.sha, s]));
  // The index/untracked helper commits of a stash are not graph nodes.
  const hidden = new Set(stashes.flatMap((s) => s.parents.slice(1)));
  const res = await runGit(
    ['log', '--date-order', '--decorate=full', `--format=${LOG_FORMAT}`, '--exclude=refs/stash', ...OWN_REF_EXCLUDES, '--all', '--end-of-options', ...stashes.map((s) => s.sha)],
    { cwd: root, repoId, timeoutMs: HISTORY_TIMEOUT_MS },
  );
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git log failed.');
  const commits = parseLog(res.stdout)
    .filter((c) => !hidden.has(c.sha) || stashBySha.has(c.sha))
    .map((c) => {
      const stash = stashBySha.get(c.sha);
      return stash ? { ...c, parents: c.parents.slice(0, 1), refs: [], stash: stash.index } : c;
    });
  return { fingerprint, commits, indexBySha: new Map(commits.map((c, i) => [c.sha, i])) };
}

/** Returns the cached history, rebuilding it (one git log walk) only when the refs fingerprint changed. */
export async function getHistory(root: string, repoId: string): Promise<History> {
  const { fingerprint, empty, stashes } = await refsFingerprint(root, repoId);
  const hit = cache.get(repoId);
  if (hit && hit.fingerprint === fingerprint) return hit.promise;
  const promise = build(root, repoId, fingerprint, empty, stashes);
  const entry: Entry = { fingerprint, promise };
  cache.set(repoId, entry);
  promise.catch(() => {
    if (cache.get(repoId) === entry) cache.delete(repoId);
  });
  return promise;
}
