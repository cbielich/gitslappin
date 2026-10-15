import { branchNameProblem, type OpState, type PullMode, type RemoteInfo } from '@gitslappin/shared';
import { repoIdFor } from '../state/registry';
import { readOpState } from './opState';
import { runExclusive } from './queue';
import { runGit, type EnvOverride, type GitResult } from './runner';
import { scrubSecrets } from './scrub';

/*
 * Fetch, pull, push and upstream (phase 7). Every function except listRemotes runs inside one runExclusive for the
 * repo, runs git with `-c protocol.ext.allow=never` and an empty stdin, and returns a RemoteResult. None throws for a
 * git failure. Nothing here ever force-pushes, deletes a remote ref, or stashes.
 */

export interface RemoteResult {
  outcome: 'done' | 'conflict' | 'failed' | 'blocked' | 'refused' | 'no-remote' | 'needs-upstream' | 'rejected';
  error?: string;
  stderr?: string;
  stdout?: string;
  remotes?: string[];
  rejected?: 'non-ff';
  /** With `rejected`: the sha of the local refs/remotes/<remote>/<branch> at that moment (phase 11 uses it as a lease). */
  expect?: string;
  /** With `rejected`: the remote branch that refused, as `<remote>/<branch>`. */
  target?: string;
  /** With `rejected`: git said "fetch first" (the remote has commits this repository has not fetched), so a lease on `expect` cannot work yet. */
  fetchFirst?: boolean;
  op?: OpState;
  /** 'detached' = HEAD is detached; otherwise another operation is in progress. */
  blockedBy?: 'detached' | 'op';
}

const TIMEOUT_MS = 5 * 60 * 1000;
const SAFE_ARGS = [
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.allow=user',
  ...['https', 'http', 'ssh', 'git', 'file'].flatMap((p) => ['-c', `protocol.${p}.allow=always`]),
];
/** git must never open an editor from here. */
const ENV: EnvOverride = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' };
const MODES: readonly PullMode[] = ['merge', 'ff-only', 'rebase'];

const refused = (error: string): RemoteResult => ({ outcome: 'refused', error });
const noRemote = (): RemoteResult => ({ outcome: 'no-remote', error: 'There are no remotes.' });

function failed(res: GitResult, fallback: string): RemoteResult {
  const text = scrubSecrets(`${res.stderr}${res.stdout}`.trim());
  return { outcome: 'failed', error: text.split('\n')[0] || fallback, stderr: text || `git exited with code ${res.code}.` };
}

export interface Remote {
  name: string;
  /** Every url and pushurl, as configured (not scrubbed: only for checks, never sent out). */
  urls: string[];
}

const plain = (root: string, repoId: string) => ({ cwd: root, repoId });
export const net = (root: string, repoId: string, args: string[]): Promise<GitResult> =>
  runGit([...SAFE_ARGS, ...args], { cwd: root, repoId, timeoutMs: TIMEOUT_MS, input: '', env: ENV });

export async function readRemotes(root: string, repoId: string): Promise<Remote[]> {
  const names = await runGit(['remote'], plain(root, repoId));
  if (names.code !== 0) return [];
  const list: Remote[] = names.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((name) => ({ name, urls: [] }));
  // One round of parallel git calls: the configured urls, and the urls git will really use (insteadOf / pushInsteadOf rewrites
  // can turn a plain url into a "foo::" helper).
  const real = list.filter((r) => !r.name.startsWith('-')).flatMap((r) => [[], ['--push']].map((extra) => ({ r, run: runGit(['remote', 'get-url', ...extra, '--all', '--', r.name], plain(root, repoId)) })));
  const cfg = await runGit(['config', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], plain(root, repoId));
  for (const entry of cfg.stdout.split('\0')) {
    const nl = entry.indexOf('\n');
    if (nl < 0) continue;
    const m = /^remote\.(.*)\.(url|pushurl)$/i.exec(entry.slice(0, nl));
    if (!m) continue;
    list.find((r) => r.name === m[1])?.urls.push(entry.slice(nl + 1));
  }
  for (const { r, run } of real) {
    const got = await run;
    if (got.code === 0) r.urls.push(...got.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
  }
  return list;
}

export const hasExtUrl = (r: Remote): boolean => r.urls.some((u) => u.includes('::'));

/** Pure checks (no `+` either), then git's own rule. check-ref-format --branch expands @{-1}, so its stdout must equal the name. */
async function validRef(root: string, repoId: string, name: unknown): Promise<boolean> {
  if (typeof name !== 'string' || name === '' || name.includes('+') || branchNameProblem(name) !== null) return false;
  const res = await runGit(['check-ref-format', '--branch', name], plain(root, repoId));
  return res.code === 0 && res.stdout.trim() === name;
}

async function localExists(root: string, repoId: string, name: string): Promise<boolean> {
  return (await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], plain(root, repoId))).code === 0;
}

async function currentBranch(root: string, repoId: string): Promise<string | null> {
  const r = await runGit(['symbolic-ref', '-q', '--short', 'HEAD'], plain(root, repoId));
  return r.code === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
}

/** The configured upstream of a local branch, or null when it is missing or not usable (unknown remote, odd merge ref). */
export async function upstreamOf(root: string, repoId: string, branch: string, remotes: Remote[]): Promise<{ remote: Remote; rb: string } | null> {
  const [r, m] = await Promise.all([
    runGit(['config', '--get', `branch.${branch}.remote`], plain(root, repoId)),
    runGit(['config', '--get', `branch.${branch}.merge`], plain(root, repoId)),
  ]);
  if (r.code !== 0 || m.code !== 0) return null;
  const remote = remotes.find((x) => x.name === r.stdout.trim());
  const merge = m.stdout.trim();
  if (!remote || remote.name.startsWith('-') || !merge.startsWith('refs/heads/')) return null;
  const rb = merge.slice('refs/heads/'.length);
  return (await validRef(root, repoId, rb)) ? { remote, rb } : null;
}

export async function listRemotes(root: string): Promise<RemoteInfo[]> {
  const repoId = repoIdFor(root);
  const list = await readRemotes(root, repoId);
  return list.map((r) => ({ name: r.name, url: scrubSecrets(r.urls[0] ?? '') }));
}

export function fetchAll(root: string): Promise<RemoteResult> {
  const repoId = repoIdFor(root);
  return runExclusive<RemoteResult>(repoId, async () => {
    const remotes = await readRemotes(root, repoId);
    if (remotes.length === 0) return noRemote();
    const ext = remotes.find(hasExtUrl);
    if (ext) return refused(`The remote '${ext.name}' has a URL that is not supported.`);
    const res = await net(root, repoId, ['fetch', '--all', '--prune']);
    return res.code === 0 ? { outcome: 'done' } : failed(res, 'git fetch failed.');
  });
}

export function pullRemote(root: string, opts: { mode: PullMode; branch?: string }): Promise<RemoteResult> {
  const repoId = repoIdFor(root);
  return runExclusive<RemoteResult>(repoId, async () => {
    if (!MODES.includes(opts.mode)) return refused('Unknown pull mode.');
    if (opts.branch !== undefined && !(await validRef(root, repoId, opts.branch))) return refused('The given branch name is not valid');
    if (await readOpState(root)) return { outcome: 'blocked', error: 'Another operation is in progress.', blockedBy: 'op' };
    const current = await currentBranch(root, repoId);
    if (!current) return { outcome: 'blocked', error: 'HEAD is detached.', blockedBy: 'detached' };
    const remotes = await readRemotes(root, repoId);
    if (remotes.length === 0) return noRemote();

    const branch = opts.branch ?? current;
    if (!(await localExists(root, repoId, branch))) return refused('That is not an existing local branch.');
    const up = await upstreamOf(root, repoId, branch, remotes);
    if (!up) return { outcome: 'needs-upstream', remotes: remotes.map((r) => r.name) };
    if (hasExtUrl(up.remote)) return refused(`The remote '${up.remote.name}' has a URL that is not supported.`);

    if (branch !== current) {
      // Not the checked-out branch: fast-forward the local ref only. No `+`, so a diverged branch is refused by git.
      const res = await net(root, repoId, ['fetch', '--end-of-options', up.remote.name, `refs/heads/${up.rb}:refs/heads/${branch}`]);
      return res.code === 0 ? { outcome: 'done' } : failed(res, 'git fetch failed.');
    }

    // Only the configured upstream is used: no request value reaches git here. Never a stash.
    const modeArgs =
      opts.mode === 'merge' ? ['--no-rebase', '--ff', '--no-edit'] : opts.mode === 'ff-only' ? ['--no-rebase', '--ff-only'] : ['--rebase', '--no-autostash'];
    const res = await net(root, repoId, ['pull', ...modeArgs, ...(opts.mode === 'rebase' ? [] : ['--no-autostash'])]);
    if (res.code === 0) return { outcome: 'done' };
    // A conflict is not an error: the merge or rebase is stopped and the phase 6 screens take over.
    const op = await readOpState(root);
    if (op && (op.kind === 'merge' || op.kind === 'rebase')) return { outcome: 'conflict', op };
    return failed(res, 'git pull failed.');
  });
}

export function pushRemote(root: string, opts: { branch?: string; remote?: string; remoteBranch?: string }): Promise<RemoteResult> {
  const repoId = repoIdFor(root);
  return runExclusive<RemoteResult>(repoId, async () => {
    if (await readOpState(root)) return { outcome: 'blocked', error: 'Another operation is in progress.', blockedBy: 'op' };
    let local = opts.branch;
    if (local === undefined) {
      const cur = await currentBranch(root, repoId);
      if (!cur) return { outcome: 'blocked', error: 'HEAD is detached.', blockedBy: 'detached' };
      local = cur;
    }
    const remotes = await readRemotes(root, repoId);
    if (remotes.length === 0) return noRemote();
    // The source is always a validated, existing local branch: an empty source (which would delete a remote ref) never gets through.
    if (!(await validRef(root, repoId, local))) return refused('The given branch name is not valid');
    if (!(await localExists(root, repoId, local))) return refused('That is not an existing local branch.');

    let remote: Remote;
    let rb: string;
    let setUpstream = false;
    if (opts.remote !== undefined) {
      const found = remotes.find((r) => r.name === opts.remote);
      if (!found || found.name.startsWith('-')) return refused('That is not an existing remote.');
      const dest = opts.remoteBranch === undefined ? local : opts.remoteBranch;
      if (!(await validRef(root, repoId, dest))) return refused('The given branch name is not valid');
      remote = found;
      rb = dest;
      setUpstream = true;
    } else {
      if (opts.remoteBranch !== undefined) return refused('A remote branch needs a remote.');
      const up = await upstreamOf(root, repoId, local, remotes);
      if (!up) return { outcome: 'needs-upstream', remotes: remotes.map((r) => r.name) };
      remote = up.remote;
      rb = up.rb;
    }
    if (hasExtUrl(remote)) return refused(`The remote '${remote.name}' has a URL that is not supported.`);

    // Never `+`, --force, --delete, --mirror or --prune. Tags stay home even when push.followTags is set.
    const args = ['push', '--porcelain', '--no-follow-tags', ...(setUpstream ? ['-u'] : []), '--end-of-options', remote.name, `refs/heads/${local}:refs/heads/${rb}`];
    const res = await net(root, repoId, args);
    if (res.code === 0) return { outcome: 'done' };
    const text = `${res.stdout}\n${res.stderr}`;
    if (/\[rejected\] \((non-fast-forward|fetch first)\)/.test(text) || /^\s*!.*\[rejected\]/m.test(res.stdout)) {
      const tip = await runGit(['rev-parse', '--verify', '-q', '--end-of-options', `refs/remotes/${remote.name}/${rb}`], plain(root, repoId));
      const out = failed(res, 'git push failed.');
      return {
        ...out,
        outcome: 'rejected',
        rejected: 'non-ff',
        target: `${remote.name}/${rb}`,
        ...(tip.code === 0 && /^[0-9a-f]{40,64}$/.test(tip.stdout.trim()) ? { expect: tip.stdout.trim() } : {}),
        ...(/\(fetch first\)/.test(text) ? { fetchFirst: true } : {}),
      };
    }
    return failed(res, 'git push failed.');
  });
}

export function setUpstream(root: string, opts: { branch: string; remote: string; remoteBranch: string }): Promise<RemoteResult> {
  const repoId = repoIdFor(root);
  return runExclusive<RemoteResult>(repoId, async () => {
    if (!(await validRef(root, repoId, opts.branch)) || !(await validRef(root, repoId, opts.remoteBranch))) return refused('The given branch name is not valid');
    if (!(await localExists(root, repoId, opts.branch))) return refused('That is not an existing local branch.');
    const remotes = await readRemotes(root, repoId);
    const remote = typeof opts.remote === 'string' ? remotes.find((r) => r.name === opts.remote) : undefined;
    if (!remote || remote.name.startsWith('-')) return refused('That is not an existing remote.');

    const tracking = `${remote.name}/${opts.remoteBranch}`;
    const haveTracking = (await runGit(['show-ref', '--verify', '--quiet', `refs/remotes/${tracking}`], plain(root, repoId))).code === 0;
    if (haveTracking) {
      const res = await runGit(['branch', `--set-upstream-to=${tracking}`, '--end-of-options', opts.branch], plain(root, repoId));
      return res.code === 0 ? { outcome: 'done' } : failed(res, 'git branch failed.');
    }
    // The remote branch does not exist yet: write the tracking config by hand (fixed keys, validated values).
    const a = await runGit(['config', '--local', `branch.${opts.branch}.remote`, remote.name], plain(root, repoId));
    if (a.code !== 0) return failed(a, 'git config failed.');
    const b = await runGit(['config', '--local', `branch.${opts.branch}.merge`, `refs/heads/${opts.remoteBranch}`], plain(root, repoId));
    return b.code === 0 ? { outcome: 'done' } : failed(b, 'git config failed.');
  });
}
