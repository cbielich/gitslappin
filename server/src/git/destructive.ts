import { branchNameProblem, buildPatch, parseUnifiedDiff } from '@gitslappin/shared';
import { repoIdFor } from '../state/registry';
import { readOpState } from './opState';
import { runExclusive } from './queue';
import { hasExtUrl, net, readRemotes, upstreamOf } from './remote';
import { runGit, type GitResult } from './runner';
import { resetFacts } from './resetFacts';
import { UnsafePathError, safeRepoPath } from './safeRepoPath';
import { scrubSecrets } from './scrub';
import { captureFile, pin, preState, stashSnapshot, stateOf, writeTree, type PinnedFile } from './snapshot';
import { MAX_PATHS, reDiffArgs } from './stageCommands';
import { clearRedo, record } from './undo';

/*
 * Phase 11: discard, hunk discard, reset, branch rename / delete, force push (with lease) and tags. Every function takes the repo
 * ROOT, runs inside one runExclusive for the repo, and returns a DResult; none throws for a git failure.
 *
 * Data safety: whatever could lose data is snapshotted first (snapshot.ts) and the snapshot FAILS CLOSED: when one step of it fails,
 * the operation does not run. Paths come from the server's own status (never straight from the request), run with literal pathspecs,
 * and are re-checked against it. Shas must be 40-64 lowercase hex and are verified to be commits. Remote and remote branch of a
 * delete or force push come only from the branch's configured upstream. Nothing here uses a bare --force, `+`, `-d`/`-x` on clean,
 * `branch -M` or `tag -f`.
 */

export interface DResult {
  /** refused = input validation or a precondition failed, git never changed anything. failed = git ran and failed (or a snapshot step failed). */
  outcome: 'done' | 'conflict' | 'noop' | 'unmerged' | 'rejected' | 'refused' | 'failed' | 'blocked';
  error?: string;
  stderr?: string;
  stash?: { message: string; sha?: string };
  expect?: string;
  /** With `refused`: the request was well formed but out of date (a hunk header that no longer matches). The route answers 409. */
  stale?: boolean;
  /** With `failed` (force push): the lease was not met, because the remote moved after the last fetch. */
  lease?: boolean;
}

const TIMEOUT_MS = 5 * 60 * 1000;
const SHA = /^[0-9a-f]{40,64}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const REDIFF_MAX_BYTES = 20 * 1024 * 1024;
const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } as const;

const run = (root: string, repoId: string, args: string[], input?: string | Buffer, latin1 = false): Promise<GitResult> =>
  runGit(args, { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR, ...(input === undefined ? {} : { input }), ...(latin1 ? { encoding: 'latin1' as const } : {}) });

const refused = (error: string): DResult => ({ outcome: 'refused', error });
const blocked = (): DResult => ({ outcome: 'blocked', error: 'Another operation is in progress.' });
function failed(res: GitResult, fallback: string, extra: Partial<DResult> = {}): DResult {
  const text = scrubSecrets(`${res.stderr}${res.stdout}`.trim());
  return { outcome: 'failed', error: text.split('\n')[0] || fallback, stderr: text || `git exited with code ${res.code}.`, ...extra };
}
const snapshotFailed = (res: GitResult, what: string): DResult => failed(res, `${what} (nothing was changed).`);

const nulList = (paths: string[]): string => `${paths.join('\0')}\0`;
const stopped = async (root: string): Promise<boolean> => (await readOpState(root)) !== undefined;

async function headInfo(root: string, repoId: string): Promise<{ sha: string | null; branch: string | null }> {
  const [sha, sym] = await Promise.all([run(root, repoId, ['rev-parse', '-q', '--verify', 'HEAD']), run(root, repoId, ['symbolic-ref', '-q', '--short', 'HEAD'])]);
  return { sha: sha.code === 0 ? sha.stdout.trim() : null, branch: sym.code === 0 && sym.stdout.trim() !== '' ? sym.stdout.trim() : null };
}

/** A full lowercase hex sha that really is a commit, or null. */
async function resolveCommit(root: string, repoId: string, sha: unknown): Promise<string | null> {
  if (typeof sha !== 'string' || !SHA.test(sha)) return null;
  const r = await run(root, repoId, ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]);
  return r.code === 0 && r.stdout.trim() === sha ? sha : null;
}

/** short name -> sha for refs/heads. */
async function localBranches(root: string, repoId: string): Promise<Map<string, string>> {
  const r = await run(root, repoId, ['for-each-ref', '--format=%(refname)%1f%(objectname)', 'refs/heads']);
  const out = new Map<string, string>();
  if (r.code !== 0) return out;
  for (const line of r.stdout.split('\n')) {
    const [ref, sha] = line.split('\x1f');
    if (ref && sha && ref.startsWith('refs/heads/')) out.set(ref.slice('refs/heads/'.length), sha);
  }
  return out;
}

/** Pure checks, then git's own rule (check-ref-format --branch expands @{-1}, so its stdout must equal the name). */
async function validBranchName(root: string, repoId: string, name: unknown): Promise<boolean> {
  if (typeof name !== 'string' || name.includes('+') || branchNameProblem(name) !== null) return false;
  const r = await run(root, repoId, ['check-ref-format', '--branch', name]);
  return r.code === 0 && r.stdout.trim() === name;
}

// ---------------------------------------------------------------------------------------------------------------------
// status

interface StatusEntry {
  x: string;
  y: string;
  path: string;
  orig?: string;
}

/** `status --porcelain=v1 -z`: "XY path\0", and for a rename or copy "XY new\0old\0". */
function parseStatus(out: string): StatusEntry[] {
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? '';
    if (p.length < 4) continue;
    const x = p.charAt(0);
    const y = p.charAt(1);
    const e: StatusEntry = { x, y, path: p.slice(3) };
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') e.orig = parts[++i] ?? '';
    entries.push(e);
  }
  return entries;
}

const isUnmergedEntry = (e: StatusEntry): boolean => e.x === 'U' || e.y === 'U' || (e.x === 'A' && e.y === 'A') || (e.x === 'D' && e.y === 'D');

/** Digits of a hunk header only: the function-context text after it can differ in encoding. */
const headerNumbers = (h: string): string => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(h)?.[0] ?? h;

// ---------------------------------------------------------------------------------------------------------------------
// discard

export function discardFiles(root: string, paths: string[]): Promise<DResult> {
  const repoId = repoIdFor(root);
  return runExclusive<DResult>(repoId, async () => {
    if (await stopped(root)) return blocked();
    if (!Array.isArray(paths) || paths.length === 0) return refused('No paths given.');
    if (paths.length > MAX_PATHS) return refused('Too many paths.');
    for (const p of paths) {
      if (typeof p !== 'string') return refused('Invalid path.');
      try {
        safeRepoPath(root, p);
      } catch (e) {
        return refused(e instanceof UnsafePathError ? e.message : 'Invalid path.');
      }
    }
    const head = await headInfo(root, repoId);
    if (!head.sha) return refused('There is no commit yet, so nothing can be discarded.');

    // The paths are looked up in the server's own status: only listed (changed, not ignored) paths are ever used.
    const st = await run(root, repoId, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (st.code !== 0) return failed(st, 'git status failed.');
    const entries = parseStatus(st.stdout);
    const byPath = new Map<string, StatusEntry[]>();
    for (const e of entries) for (const key of [e.path, ...(e.orig ? [e.orig] : [])]) byPath.set(key, [...(byPath.get(key) ?? []), e]);

    const selected = new Set<StatusEntry>();
    for (const p of new Set(paths)) {
      const hit = byPath.get(p);
      if (!hit) return refused('That path has no changes to discard.');
      for (const e of hit) {
        if (e.path.endsWith('/')) return refused('A folder or a nested repository cannot be discarded.');
        if (isUnmergedEntry(e)) return refused('That file has merge conflicts.');
        selected.add(e);
      }
    }
    // A rename is discarded as a pair: both of its paths.
    const untrackedPaths = new Set<string>();
    const trackedPaths = new Set<string>();
    for (const e of selected) {
      if (e.x === '?') untrackedPaths.add(e.path);
      else {
        trackedPaths.add(e.path);
        if (e.orig) trackedPaths.add(e.orig);
      }
    }
    for (const p of trackedPaths) untrackedPaths.delete(p);
    const all = [...trackedPaths, ...untrackedPaths];
    if (all.length > MAX_PATHS) return refused('Too many paths.');
    for (const p of all) {
      try {
        safeRepoPath(root, p);
      } catch {
        return refused('Invalid path.');
      }
    }
    if (untrackedPaths.size > 0) {
      const others = await run(root, repoId, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z']);
      if (others.code !== 0) return failed(others, 'git ls-files failed.');
      const known = new Set(others.stdout.split('\0'));
      for (const p of untrackedPaths) if (!known.has(p)) return refused('That path is not an untracked file.');
    }

    // ---- the safety snapshot: nothing is changed until all of it is pinned ----
    const indexBefore = await writeTree(root, repoId);
    if (!indexBefore) return refused('The index cannot be saved, so changes cannot be discarded safely (it has an intent-to-add entry or is unmerged).');
    const files: PinnedFile[] = [];
    for (const p of all) {
      const f = await captureFile(root, repoId, p, trackedPaths.has(p));
      if (!f) return snapshotFailed({ code: 1, stdout: '', stderr: `The bytes of '${p}' could not be saved.` }, 'The safety snapshot failed');
      if (untrackedPaths.has(p) && f.blob === null) return refused('That file does not exist any more.');
      files.push(f);
    }
    let snap: string | null = null;
    if (trackedPaths.size > 0) {
      const s = await stashSnapshot(root, repoId);
      if (!s.ok) return snapshotFailed(s.res, 'The safety snapshot failed');
      if (!s.sha) return snapshotFailed({ code: 1, stdout: '', stderr: 'There was no tracked state to save.' }, 'The safety snapshot failed');
      snap = s.sha;
    }

    // ---- the discard ----
    let problem: DResult | null = null;
    if (trackedPaths.size > 0) {
      const res = await run(root, repoId, ['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], nulList([...trackedPaths]));
      if (res.code !== 0) problem = failed(res, 'git restore failed.');
    }
    if (!problem) {
      for (const p of untrackedPaths) {
        // One file per call, literally; never -d (folders) and never -x (ignored files).
        const res = await run(root, repoId, ['--literal-pathspecs', 'clean', '-f', '--', p]);
        if (res.code !== 0) {
          problem = failed(res, 'git clean failed.');
          break;
        }
      }
    }

    // ---- the journal: recorded when anything changed (also after a partial failure, so the undo can put it back) ----
    let changed = false;
    for (const f of files) {
      f.post = await stateOf(root, repoId, f.path);
      if (f.post !== preState(f)) changed = true;
    }
    const indexAfter = await writeTree(root, repoId);
    if (changed && indexAfter) record(root, { kind: 'discard', head: head.sha, snap, files, indexAfter });
    else clearRedo(root);
    return problem ?? { outcome: 'done' };
  });
}

export function discardHunk(root: string, opts: { path: string; hunk: number; header: string }): Promise<DResult> {
  const repoId = repoIdFor(root);
  return runExclusive<DResult>(repoId, async () => {
    if (await stopped(root)) return blocked();
    const { path, hunk, header } = opts;
    if (typeof path !== 'string') return refused('Invalid path.');
    try {
      safeRepoPath(root, path);
    } catch (e) {
      return refused(e instanceof UnsafePathError ? e.message : 'Invalid path.');
    }
    if (typeof header !== 'string' || typeof hunk !== 'number' || !Number.isInteger(hunk) || hunk < 0) return { outcome: 'refused', error: 'The hunk is out of date.', stale: true };
    const head = await headInfo(root, repoId);
    if (!head.sha) return refused('There is no commit yet.');

    // The path must be an exact, unmerged-free entry of the index.
    const ls = await run(root, repoId, ['--literal-pathspecs', 'ls-files', '-z', '--stage', '--error-unmatch', '--', path]);
    if (ls.code !== 0) return refused('Not a tracked file.');
    let tracked = false;
    for (const entry of ls.stdout.split('\0')) {
      const m = /^\d+ [0-9a-f]+ (\d)\t([\s\S]*)$/.exec(entry);
      if (!m || m[2] !== path) continue;
      if (m[1] !== '0') return refused('Merge conflicts detected');
      tracked = true;
    }
    if (!tracked) return refused('Not a tracked file.');

    // The server re-diffs (unstaged side only) and compares the header: a stale hunk is never applied.
    const diff = await runGit(reDiffArgs('unstaged', [path]), { cwd: root, repoId, encoding: 'latin1', maxBuffer: REDIFF_MAX_BYTES, timeoutMs: 60_000 });
    if (diff.code !== 0) return failed(diff, 'git diff failed.');
    const matches = parseUnifiedDiff(diff.stdout).filter((f) => f.path === path);
    if (matches.length === 0) return { outcome: 'refused', error: 'The file has changed.', stale: true };
    if (matches.length > 1) return { outcome: 'refused', error: 'The type of this file changed. Discard the whole file instead.', stale: true };
    const file = matches[0]!;
    if (file.binary) return refused('Binary file');
    const target = file.hunks[hunk];
    if (!target || headerNumbers(target.header) !== headerNumbers(header)) return { outcome: 'refused', error: 'The hunk is out of date.', stale: true };

    const patch = Buffer.from(buildPatch({ ...file, path }, hunk, undefined, true), 'latin1');
    const check = await run(root, repoId, ['apply', '-R', '--whitespace=nowarn', '--check', '-'], patch);
    if (check.code !== 0) return { outcome: 'refused', error: scrubSecrets(check.stderr.trim().split('\n')[0] || 'The change no longer applies.'), stderr: scrubSecrets(check.stderr), stale: true };

    // ---- snapshot (raw bytes of the file), then the discard ----
    const indexBefore = await writeTree(root, repoId);
    if (!indexBefore) return refused('The index cannot be saved, so changes cannot be discarded safely.');
    const f = await captureFile(root, repoId, path, false);
    if (!f || f.blob === null) return snapshotFailed({ code: 1, stdout: '', stderr: `The bytes of '${path}' could not be saved.` }, 'The safety snapshot failed');
    const done = await run(root, repoId, ['apply', '-R', '--whitespace=nowarn', '-'], patch);
    f.post = await stateOf(root, repoId, path);
    const indexAfter = await writeTree(root, repoId);
    if (f.post !== preState(f) && indexAfter) record(root, { kind: 'discard', head: head.sha, snap: null, files: [f], indexAfter });
    else clearRedo(root);
    return done.code === 0 ? { outcome: 'done' } : failed(done, 'git apply failed.');
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// reset

export { resetFacts };
const MODES = ['soft', 'mixed', 'hard'] as const;


/** For the client's hard-reset confirm bar: would this reset touch anything uncommitted (or collide with a file)? Read-only. */
export async function resetNeedsConfirm(root: string, sha: string): Promise<{ dirty: boolean } | { error: string }> {
  const repoId = repoIdFor(root);
  const head = await headInfo(root, repoId);
  const target = await resolveCommit(root, repoId, sha);
  if (!head.sha || !target) return { error: 'Invalid commit id.' };
  const facts = await resetFacts(root, repoId, head.sha, target, 'hard');
  if ('code' in facts) return { error: 'git failed.' };
  return { dirty: facts.trackedDirty || facts.collisions.length > 0 };
}

export function resetTo(root: string, opts: { sha: string; mode: 'soft' | 'mixed' | 'hard' }): Promise<DResult> {
  const repoId = repoIdFor(root);
  return runExclusive<DResult>(repoId, async () => {
    if (await stopped(root)) return blocked();
    const { sha, mode } = opts;
    if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) return refused('Unknown reset mode.');
    const head = await headInfo(root, repoId);
    if (!head.sha) return refused('There is no commit yet.');
    if (!head.branch) return refused('A branch must be checked out.');
    const target = await resolveCommit(root, repoId, sha);
    if (!target) return refused('Invalid commit id.');

    // ---- snapshot: before a mixed or hard reset with a dirty index or worktree (a hard reset also counts a collision as dirty) ----
    let snap: string | null = null;
    const files: PinnedFile[] = [];
    if (mode !== 'soft') {
      const facts = await resetFacts(root, repoId, head.sha, target, mode);
      if ('code' in facts) return failed(facts, 'git failed.');
      const { trackedDirty, collisions } = facts;
      if (trackedDirty || collisions.length > 0) {
        const indexBefore = await writeTree(root, repoId);
        if (!indexBefore) return refused('The index cannot be saved, so the reset is not safe (it has an intent-to-add entry or is unmerged).');
        if (mode === 'hard') {
          // Raw bytes of every tracked edit (no line-ending conversion) and of every colliding untracked or ignored file.
          const edited = await run(root, repoId, ['diff', '--name-only', '-z', '--no-renames', 'HEAD']);
          if (edited.code !== 0) return failed(edited, 'git diff failed.');
          for (const p of edited.stdout.split('\0').filter((x) => x !== '')) {
            const f = await captureFile(root, repoId, p, true);
            if (!f) return snapshotFailed({ code: 1, stdout: '', stderr: `The bytes of '${p}' could not be saved.` }, 'The safety snapshot failed');
            files.push(f);
          }
          for (const p of collisions) {
            const f = await captureFile(root, repoId, p, false);
            if (!f) return snapshotFailed({ code: 1, stdout: '', stderr: `The bytes of '${p}' could not be saved.` }, 'The safety snapshot failed');
            files.push(f);
          }
        }
        if (trackedDirty) {
          const s = await stashSnapshot(root, repoId);
          if (!s.ok) return snapshotFailed(s.res, 'The safety snapshot failed');
          snap = s.sha;
        }
      }
    }

    const res = await run(root, repoId, ['reset', `--${mode}`, target, '--']);
    if (res.code !== 0) return failed(res, 'git reset failed.');
    const indexAfter = await writeTree(root, repoId);
    if (indexAfter) record(root, { kind: 'reset', mode, branch: head.branch, prev: head.sha, to: target, snap, files, indexAfter });
    else clearRedo(root);
    return { outcome: 'done' };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// branches

export function renameBranch(root: string, opts: { name: string; newName: string }): Promise<DResult> {
  const repoId = repoIdFor(root);
  return runExclusive<DResult>(repoId, async () => {
    if (await stopped(root)) return blocked();
    const { name, newName } = opts;
    if (typeof name !== 'string' || typeof newName !== 'string') return refused('Invalid request.');
    if (!(await validBranchName(root, repoId, newName))) return refused('The given branch name is not valid');
    const branches = await localBranches(root, repoId);
    if (!branches.has(name)) return refused('That is not an existing local branch.');
    if (branches.has(newName)) return refused(`A branch named '${newName}' already exists.`);
    // -m, never -M: git itself refuses to overwrite.
    const res = await run(root, repoId, ['branch', '-m', name, newName]);
    return res.code === 0 ? { outcome: 'done' } : failed(res, 'git branch failed.');
  });
}

/** The configured upstream of a local branch, from the config only. */
async function configOf(root: string, repoId: string, branch: string): Promise<{ remote?: string; merge?: string }> {
  const [r, m] = await Promise.all([run(root, repoId, ['config', '--local', '--get', `branch.${branch}.remote`]), run(root, repoId, ['config', '--local', '--get', `branch.${branch}.merge`])]);
  return { ...(r.code === 0 ? { remote: r.stdout.trim() } : {}), ...(m.code === 0 ? { merge: m.stdout.trim() } : {}) };
}

export function deleteBranch(root: string, opts: { name: string; expectSha: string; force?: boolean; remote?: boolean }): Promise<DResult> {
  const repoId = repoIdFor(root);
  return runExclusive<DResult>(repoId, async () => {
    if (await stopped(root)) return blocked();
    const { name, expectSha, force, remote } = opts;
    if (typeof name !== 'string' || typeof expectSha !== 'string') return refused('Invalid request.');
    if ((force !== undefined && typeof force !== 'boolean') || (remote !== undefined && typeof remote !== 'boolean')) return refused('Invalid request.');
    if (!SHA.test(expectSha)) return refused('Invalid commit id.');
    const branches = await localBranches(root, repoId);
    const tip = branches.get(name);
    if (!tip) return refused('That is not an existing local branch.');
    if (tip !== expectSha) return refused('The branch has changed since it was shown.');
    const head = await headInfo(root, repoId);
    if (head.branch === name) return refused('The checked-out branch cannot be deleted.');

    // Remote part, validated in full BEFORE the local branch goes: the remote and its branch come only from the upstream configuration.
    let target: { name: string; rb: string; lease: string } | undefined;
    if (remote === true) {
      const remotes = await readRemotes(root, repoId);
      const up = await upstreamOf(root, repoId, name, remotes);
      if (!up) return refused('The branch has no upstream.');
      if (hasExtUrl(up.remote)) return refused(`The remote '${up.remote.name}' has a URL that is not supported.`);
      // The lease is what this repository last saw of the remote branch (no fresh fetch, no ls-remote).
      const seen = await run(root, repoId, ['rev-parse', '--verify', '-q', '--end-of-options', `refs/remotes/${up.remote.name}/${up.rb}`]);
      if (seen.code !== 0 || !SHA.test(seen.stdout.trim())) return refused('The remote branch has not been fetched, so it cannot be deleted safely.');
      target = { name: up.remote.name, rb: up.rb, lease: seen.stdout.trim() };
    }

    const config = await configOf(root, repoId, name);
    // -D: pin the tip first. The branch's reflog goes with it, and an unmerged tip would then live only until gc.
    // (-d only deletes merged branches, whose tip stays reachable, so it needs no pin.)
    if (force === true && !(await pin(root, repoId, tip))) {
      return snapshotFailed({ code: 1, stdout: '', stderr: `The tip of '${name}' could not be saved.` }, 'The safety snapshot failed');
    }
    const del = await run(root, repoId, ['branch', force === true ? '-D' : '-d', name]);
    if (del.code !== 0) {
      const text = `${del.stderr}${del.stdout}`;
      if (force !== true && /not fully merged/i.test(text)) return { outcome: 'unmerged', error: scrubSecrets(text.trim().split('\n')[0] ?? ''), stderr: scrubSecrets(text.trim()) };
      return failed(del, 'git branch failed.');
    }

    let remoteDeleted: { name: string; rb: string; sha: string } | undefined;
    let problem: DResult | null = null;
    if (target) {
      const push = await net(root, repoId, [
        'push', '--porcelain', '--no-follow-tags', `--force-with-lease=refs/heads/${target.rb}:${target.lease}`, '--delete', '--end-of-options', target.name, `refs/heads/${target.rb}`,
      ]);
      if (push.code === 0) remoteDeleted = { name: target.name, rb: target.rb, sha: target.lease };
      else problem = failed(push, 'git push failed.');
    }
    // The local delete happened, so it is journaled even when the remote part failed (the undo brings the branch back).
    record(root, { kind: 'delete-branch', name, sha: tip, config, ...(remoteDeleted ? { remote: remoteDeleted } : {}) });
    return problem ?? { outcome: 'done' };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// force push

export function forcePush(root: string, opts: { branch: string; expect: string }): Promise<DResult> {
  const repoId = repoIdFor(root);
  return runExclusive<DResult>(repoId, async () => {
    if (await stopped(root)) return blocked();
    const { branch, expect } = opts;
    if (typeof branch !== 'string' || typeof expect !== 'string') return refused('Invalid request.');
    if (!SHA.test(expect)) return refused('Invalid lease.');
    if (!(await validBranchName(root, repoId, branch))) return refused('The given branch name is not valid');
    const branches = await localBranches(root, repoId);
    if (!branches.has(branch)) return refused('That is not an existing local branch.');
    // Remote and remote branch come only from the upstream configuration (a body-supplied remote is never read).
    const remotes = await readRemotes(root, repoId);
    const up = await upstreamOf(root, repoId, branch, remotes);
    if (!up) return refused('The branch has no upstream.');
    if (hasExtUrl(up.remote)) return refused(`The remote '${up.remote.name}' has a URL that is not supported.`);
    // The lease must be the sha this repository holds for the upstream's own remote-tracking ref.
    const tip = await run(root, repoId, ['rev-parse', '--verify', '-q', '--end-of-options', `refs/remotes/${up.remote.name}/${up.rb}`]);
    if (tip.code !== 0 || tip.stdout.trim() !== expect) return refused('The remote branch changed. Fetch first, then push again.');
    // Never a bare --force or a `+`: the lease makes git refuse when the remote branch is not at `expect`.
    const res = await net(root, repoId, [
      'push', '--porcelain', '--no-follow-tags', `--force-with-lease=refs/heads/${up.rb}:${expect}`, '--end-of-options', up.remote.name, `refs/heads/${branch}:refs/heads/${up.rb}`,
    ]);
    if (res.code === 0) return { outcome: 'done' };
    return failed(res, 'git push failed.', /stale info|\(stale\)/i.test(`${res.stdout}\n${res.stderr}`) ? { lease: true } : {});
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// tags

export function createTag(root: string, opts: { name: string; sha: string; message?: string }): Promise<DResult> {
  const repoId = repoIdFor(root);
  return runExclusive<DResult>(repoId, async () => {
    if (await stopped(root)) return blocked();
    const { name, sha, message } = opts;
    if (typeof name !== 'string' || name === '' || name.length > 255 || name.startsWith('-') || name.includes('\0')) return refused('The given tag name is not valid');
    const fmt = await run(root, repoId, ['check-ref-format', `refs/tags/${name}`]);
    if (fmt.code !== 0) return refused('The given tag name is not valid');
    if (message !== undefined) {
      if (typeof message !== 'string' || message.includes('\0')) return refused('Invalid annotation message.');
      if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) return refused('The annotation message is too large.');
      if (message.trim() === '') return refused('The annotation message is empty.');
    }
    const target = await resolveCommit(root, repoId, sha);
    if (!target) return refused('Invalid commit id.');
    // Never -f. The message goes in on stdin; signing config never starts gpg from here.
    const args =
      message === undefined
        ? ['-c', 'tag.gpgSign=false', 'tag', '--end-of-options', name, target]
        : ['-c', 'tag.gpgSign=false', '-c', 'tag.forceSignAnnotated=false', 'tag', '-a', '--cleanup=whitespace', '-F', '-', '--end-of-options', name, target];
    const res = await run(root, repoId, args, message);
    return res.code === 0 ? { outcome: 'done' } : failed(res, 'git tag failed.');
  });
}
