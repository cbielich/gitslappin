import { lstat, truncate, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { repoIdFor } from '../state/registry';
import { rebaseBackend, readOpState } from './opState';
import { runExclusive } from './queue';
import { runGit, type EnvOverride, type GitResult } from './runner';

/*
 * Merge, rebase and their continue / skip / abort steps (phase 6). Every function runs inside one runExclusive for
 * the repo and never throws for a git failure: it returns an IntegrateResult.
 */

export interface IntegrateResult {
  outcome: 'done' | 'conflict' | 'failed' | 'blocked';
  error?: string;
  stderr?: string;
  /** Only when an auto-stash was created. It is never popped here. */
  stash?: { message: string };
  /** A bad request (unknown branch, invalid message), not a git failure. */
  bad?: boolean;
}

const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const SHA_FULL_RE = /^[0-9a-f]{40,64}$/;
/** git must never open an editor from here. */
const NO_EDITOR: EnvOverride = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };

/** Placeholders from en-us.json StashMessage-Merge / StashMessage-RebaseOnto. */
const stashMessageMerge = (head: string, other: string): string => `Auto stash before merge of "${head}" and "${other}"`;
const stashMessageRebase = (head: string, onto: string): string => `Auto stash before rebase of "${head}" onto "${onto}"`;

function failed(res: GitResult, fallback: string, stash?: { message: string }): IntegrateResult {
  const text = `${res.stderr}${res.stdout}`.trim();
  return { outcome: 'failed', error: text.split('\n')[0] || fallback, stderr: text || `git exited with code ${res.code}.`, ...(stash ? { stash } : {}) };
}
const bad = (error: string): IntegrateResult => ({ outcome: 'failed', error, stderr: error, bad: true });
const blocked = (): IntegrateResult => ({ outcome: 'blocked', error: 'Another operation is in progress.' });

/**
 * Short branch name -> its full ref (refs/heads/<n>, else refs/remotes/<n>), or null. git is given the full ref, never
 * the bare name: a tag of the same name would win a bare name.
 */
async function branchRef(root: string, repoId: string, name: string): Promise<{ ref: string; sha: string } | null> {
  if (name === '' || name.length > 255 || name.includes('\0') || name.startsWith('-')) return null;
  const res = await runGit(['for-each-ref', '--format=%(refname)%1f%(objectname)', 'refs/heads', 'refs/remotes'], { cwd: root, repoId });
  if (res.code !== 0) return null;
  const refs = new Map(res.stdout.split('\n').map((l) => l.split('\x1f') as [string, string | undefined]));
  for (const ref of [`refs/heads/${name}`, ...(name.endsWith('/HEAD') ? [] : [`refs/remotes/${name}`])]) {
    const sha = refs.get(ref);
    if (sha) return { ref, sha };
  }
  return null;
}

/** The merge commit message git would write for this branch, or undefined (then git words it itself). */
async function mergeMessage(root: string, repoId: string, head: string, name: string, found: { ref: string; sha: string }): Promise<string | undefined> {
  const what = found.ref.startsWith('refs/remotes/') ? 'remote-tracking branch' : 'branch';
  const res = await runGit(['fmt-merge-msg', '--into-name', head], { cwd: root, repoId, input: `${found.sha}\t\t${what} '${name}' of .\n` });
  const text = res.stdout.replace(/\s+$/, '');
  return res.code === 0 && text !== '' ? text : undefined;
}

async function currentBranch(root: string, repoId: string): Promise<string | null> {
  const r = await runGit(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, repoId });
  return r.code === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
}

async function isDirty(root: string, repoId: string): Promise<boolean | null> {
  const r = await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: root, repoId });
  if (r.code !== 0) return null;
  return r.stdout.replace(/\0/g, '').trim() !== '';
}

const stashTip = async (root: string, repoId: string): Promise<string> =>
  (await runGit(['rev-parse', '-q', '--verify', 'refs/stash'], { cwd: root, repoId })).stdout.trim();

/**
 * Stashes everything (untracked files too) when the tree is dirty. Returns the stash info, undefined when nothing
 * needed stashing, or a failed result (the caller must then not run the merge or rebase).
 */
async function autoStash(root: string, repoId: string, message: string): Promise<{ message: string } | undefined | IntegrateResult> {
  const dirty = await isDirty(root, repoId);
  if (dirty === null) return failed({ code: 1, stdout: '', stderr: 'git status failed.' }, 'git status failed.');
  if (!dirty) return undefined;
  const before = await stashTip(root, repoId);
  const res = await runGit(['stash', 'push', '--include-untracked', '-m', message], { cwd: root, repoId, timeoutMs: TIMEOUT_MS });
  if (res.code !== 0) return failed(res, 'git stash failed.');
  const after = await stashTip(root, repoId);
  return after !== '' && after !== before ? { message } : undefined;
}

const isResult = (v: { message: string } | undefined | IntegrateResult): v is IntegrateResult => v !== undefined && 'outcome' in v;

export function mergeBranch(root: string, name: string, opts: { ffOnly?: boolean } = {}): Promise<IntegrateResult> {
  const repoId = repoIdFor(root);
  return runExclusive<IntegrateResult>(repoId, async () => {
    if (await readOpState(root)) return blocked();
    const head = await currentBranch(root, repoId);
    if (!head) return bad('HEAD is detached.');
    const found = await branchRef(root, repoId, name);
    if (!found) return bad('That is not an existing branch.');

    const stash = await autoStash(root, repoId, stashMessageMerge(head, name));
    if (isResult(stash)) return stash;

    // git words the message from the name it is given; a full ref would read "Merge branch 'refs/heads/x'", so the
    // message comes from git's own fmt-merge-msg, given the short name.
    const msg = opts.ffOnly ? undefined : await mergeMessage(root, repoId, head, name, found);
    const args = ['merge', ...(opts.ffOnly ? ['--ff-only'] : ['--no-ff']), '--no-edit', ...(msg ? ['-m', msg] : []), '--end-of-options', found.ref];
    const res = await runGit(args, { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });
    const withStash = stash ? { stash } : {};
    if (res.code === 0) return { outcome: 'done', ...withStash };
    // A conflict is not an error: MERGE_HEAD is there and the user resolves it.
    if ((await readOpState(root))?.kind === 'merge') return { outcome: 'conflict', ...withStash };
    return failed(res, 'git merge failed.', stash);
  });
}

export function rebaseOnto(root: string, onto: string): Promise<IntegrateResult> {
  const repoId = repoIdFor(root);
  return runExclusive<IntegrateResult>(repoId, async () => {
    if (await readOpState(root)) return blocked();
    const head = await currentBranch(root, repoId);
    if (!head) return bad('HEAD is detached.');
    let target = onto;
    if (SHA_FULL_RE.test(onto)) {
      const v = await runGit(['rev-parse', '--verify', '--end-of-options', `${onto}^{commit}`], { cwd: root, repoId });
      if (v.code !== 0 || v.stdout.trim() !== onto) return bad('Invalid commit id.');
    } else {
      const found = await branchRef(root, repoId, onto);
      if (!found) return bad('That is not an existing branch.');
      target = found.ref;
    }

    const stash = await autoStash(root, repoId, stashMessageRebase(head, onto));
    if (isResult(stash)) return stash;

    const res = await runGit(['rebase', '--no-autostash', '--end-of-options', target], { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });
    const withStash = stash ? { stash } : {};
    if (res.code === 0) return { outcome: 'done', ...withStash };
    if ((await readOpState(root))?.kind === 'rebase') return { outcome: 'conflict', ...withStash };
    return failed(res, 'git rebase failed.', stash);
  });
}

export function mergeAbort(root: string): Promise<IntegrateResult> {
  const repoId = repoIdFor(root);
  return runExclusive<IntegrateResult>(repoId, async () => {
    const res = await runGit(['merge', '--abort'], { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });
    return res.code === 0 ? { outcome: 'done' } : failed(res, 'git merge --abort failed.');
  });
}

export function rebaseAbort(root: string): Promise<IntegrateResult> {
  const repoId = repoIdFor(root);
  return runExclusive<IntegrateResult>(repoId, async () => {
    const res = await runGit(['rebase', '--abort'], { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });
    return res.code === 0 ? { outcome: 'done' } : failed(res, 'git rebase --abort failed.');
  });
}

/** After `rebase --continue` or `--skip` returned non-zero: a new conflict (the step moved on) or a failure. */
async function afterStep(root: string, res: GitResult, stepBefore: number | undefined, fallback: string): Promise<IntegrateResult> {
  const op = await readOpState(root);
  if (op?.kind === 'rebase' && op.step !== undefined && op.step !== stepBefore) return { outcome: 'conflict' };
  return failed(res, fallback);
}

export function rebaseSkip(root: string): Promise<IntegrateResult> {
  const repoId = repoIdFor(root);
  return runExclusive<IntegrateResult>(repoId, async () => {
    const before = await readOpState(root);
    const res = await runGit(['rebase', '--skip'], { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });
    return res.code === 0 ? { outcome: 'done' } : afterStep(root, res, before?.step, 'git rebase --skip failed.');
  });
}

// ---- cherry-pick and revert (phase 11) ----

export interface PickResult {
  /** noop = the result was empty (the change is already there); it was skipped, nothing is left in progress. */
  outcome: 'done' | 'conflict' | 'noop' | 'refused' | 'failed' | 'blocked';
  error?: string;
  stderr?: string;
  /** Set when an auto-stash was made. It is kept (referenced by sha) after a failure, a conflict and a clean pick; an abort pops it back when it can. */
  stash?: { message: string; sha?: string };
}

type PickKind = 'cherry-pick' | 'revert';

/** Placeholders from en-us.json StashMessage-CherryPick / StashMessage-Revert ({0} is the short sha of the commit). */
const stashMessagePick = (kind: PickKind, sha: string): string => (kind === 'cherry-pick' ? `Auto stash before cherry pick of "${sha.slice(0, 7)}"` : `Auto stash before revert of "${sha.slice(0, 7)}"`);

/** The auto-stash of the pick or revert that is stopped, by repo id: the abort pops it back by this sha. */
const pendingStash = new Map<string, { sha: string; message: string; kind: PickKind }>();

const pickBlocked = (): PickResult => ({ outcome: 'blocked', error: 'Another operation is in progress.' });
const pickRefused = (error: string): PickResult => ({ outcome: 'refused', error });
function pickFailed(res: GitResult, fallback: string, stash?: PickResult['stash']): PickResult {
  const text = `${res.stderr}${res.stdout}`.trim();
  return { outcome: 'failed', error: text.split('\n')[0] || fallback, stderr: text || `git exited with code ${res.code}.`, ...(stash ? { stash } : {}) };
}

export function cherryPick(root: string, sha: string): Promise<PickResult> {
  return pick(root, 'cherry-pick', sha);
}
export function revert(root: string, sha: string): Promise<PickResult> {
  return pick(root, 'revert', sha);
}

function pick(root: string, kind: PickKind, sha: unknown): Promise<PickResult> {
  const repoId = repoIdFor(root);
  return runExclusive<PickResult>(repoId, async () => {
    if (await readOpState(root)) return pickBlocked();
    pendingStash.delete(repoId); // nothing is stopped, so an older entry is stale
    if (typeof sha !== 'string' || !SHA_FULL_RE.test(sha)) return pickRefused('Invalid commit id.');
    const v = await runGit(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`], { cwd: root, repoId });
    if (v.code !== 0 || v.stdout.trim() !== sha) return pickRefused('Invalid commit id.');
    const parents = await runGit(['rev-list', '--parents', '-n', '1', '--end-of-options', sha], { cwd: root, repoId });
    if (parents.code !== 0) return pickFailed(parents, 'git rev-list failed.');
    if (parents.stdout.trim().split(' ').length > 2) return pickRefused(kind === 'cherry-pick' ? 'A merge commit cannot be cherry-picked.' : 'A merge commit cannot be reverted.');
    if ((await runGit(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root, repoId })).code !== 0) return pickRefused('There is no commit yet.');

    // A dirty tree is stashed first (untracked files too), by sha. If the stash fails, nothing else runs.
    let stash: PickResult['stash'];
    const dirty = await isDirty(root, repoId);
    if (dirty === null) return pickFailed({ code: 1, stdout: '', stderr: 'git status failed.' }, 'git status failed.');
    if (dirty) {
      const message = stashMessagePick(kind, sha);
      const before = await stashTip(root, repoId);
      const made = await runGit(['stash', 'push', '--include-untracked', '-m', message], { cwd: root, repoId, timeoutMs: TIMEOUT_MS });
      if (made.code !== 0) return pickFailed(made, 'git stash failed.');
      const after = await stashTip(root, repoId);
      if (after !== '' && after !== before) stash = { message, sha: after };
    }

    const args = kind === 'cherry-pick' ? ['cherry-pick', '--end-of-options', sha] : ['revert', '--no-edit', '--end-of-options', sha];
    const headBefore = (await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: root, repoId })).stdout.trim();
    const res = await runGit(args, { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });
    const withStash = stash ? { stash } : {};
    if (res.code === 0) return { outcome: 'done', ...withStash };

    const op = await readOpState(root);
    if (op?.kind === kind) {
      const unmerged = await runGit(['ls-files', '-u', '-z'], { cwd: root, repoId });
      const staged = await runGit(['diff', '--cached', '--quiet'], { cwd: root, repoId });
      if (unmerged.code === 0 && unmerged.stdout === '' && staged.code === 0) {
        // Empty result (the change is already there): skip it, so nothing stays in progress.
        const skip = await runGit([kind, '--skip'], { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });
        if (skip.code !== 0) return pickFailed(skip, `git ${kind} --skip failed.`, stash);
        return { outcome: 'noop', ...withStash };
      }
      if (stash?.sha) pendingStash.set(repoId, { sha: stash.sha, message: stash.message, kind });
      return { outcome: 'conflict', ...withStash };
    }
    // An empty revert makes git stop with "nothing to commit" and leave no state file (checked with real git): HEAD and the tree are as before.
    if (!op && /nothing to commit|working tree clean|now empty/i.test(`${res.stdout}\n${res.stderr}`)) {
      const headNow = (await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: root, repoId })).stdout.trim();
      const staged = await runGit(['diff', '--cached', '--quiet'], { cwd: root, repoId });
      if (headNow === headBefore && staged.code === 0) return { outcome: 'noop', ...withStash };
    }
    return pickFailed(res, `git ${kind} failed.`, stash);
  });
}

function pickAbort(root: string, kind: PickKind): Promise<PickResult> {
  const repoId = repoIdFor(root);
  return runExclusive<PickResult>(repoId, async () => {
    const res = await runGit([kind, '--abort'], { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });
    if (res.code !== 0) return pickFailed(res, `git ${kind} --abort failed.`);
    const pend = pendingStash.get(repoId);
    if (!pend || pend.kind !== kind) return { outcome: 'done' };
    pendingStash.delete(repoId);

    // The auto-stash goes back by sha, and only when the tree is clean after the abort; otherwise it is kept and the user is told.
    const kept: PickResult = { outcome: 'done', stash: { message: pend.message, sha: pend.sha } };
    const list = await runGit(['stash', 'list', '--format=%H'], { cwd: root, repoId });
    const n = list.code === 0 ? list.stdout.split('\n').filter(Boolean).indexOf(pend.sha) : -1;
    if (n < 0) return { outcome: 'done' }; // already gone: the user dealt with it
    const status = await runGit(['status', '--porcelain', '--untracked-files=all', '-z'], { cwd: root, repoId });
    if (status.code !== 0 || status.stdout !== '') return kept;
    if ((await runGit(['update-ref', `refs/gitslappin/stash-keep/${pend.sha}`, pend.sha], { cwd: root, repoId })).code !== 0) return kept;
    const pop = await runGit(['stash', 'pop', '--index', `stash@{${n}}`], { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });
    return pop.code === 0 ? { outcome: 'done' } : kept;
  });
}

export const cherryPickAbort = (root: string): Promise<PickResult> => pickAbort(root, 'cherry-pick');
export const revertAbort = (root: string): Promise<PickResult> => pickAbort(root, 'revert');

const normalise = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/\s+$/, '');

/** The apply backend commits from git's own state file; the user's edited message goes there. Regular file only. */
async function writeApplyMessage(root: string, repoId: string, message: string): Promise<boolean> {
  const p = await runGit(['rev-parse', '--git-path', 'rebase-apply/final-commit'], { cwd: root, repoId });
  if (p.code !== 0) return false;
  const file = resolvePath(root, p.stdout.trim());
  const text = message.endsWith('\n') ? message : `${message}\n`;
  try {
    if (!(await lstat(file)).isFile()) return false;
    await writeFile(file, text, { encoding: 'utf8', flag: 'r+' });
    await truncate(file, Buffer.byteLength(text, 'utf8')); // r+ keeps the old length when the new text is shorter
    return true;
  } catch {
    return false;
  }
}

export function rebaseContinue(root: string, opts: { message?: string; step?: number } = {}): Promise<IntegrateResult> {
  const repoId = repoIdFor(root);
  const message = opts.message;
  return runExclusive<IntegrateResult>(repoId, async () => {
    if (message !== undefined) {
      if (typeof message !== 'string' || message.includes('\0')) return bad('Invalid commit message.');
      if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) return bad('The commit message is too large.');
    }
    const before = await readOpState(root);
    if (before?.kind !== 'rebase') return failed({ code: 1, stdout: '', stderr: 'No rebase in progress.' }, 'No rebase in progress.');
    // The screen the user saw belongs to one step; if the rebase has moved on, nothing is committed.
    if (opts.step !== undefined && opts.step !== before.step) return { outcome: 'blocked', error: 'The rebase is at another step now. Review it again.' };

    // The apply backend (am) commits by itself on `--continue` and refuses when a commit was made by hand first.
    if ((await rebaseBackend(root)) === 'apply') {
      const edited = message !== undefined && message.trim() !== '' && normalise(message) !== normalise(before.message);
      if (edited && !(await writeApplyMessage(root, repoId, message as string))) return failed({ code: 1, stdout: '', stderr: 'The edited message could not be saved.' }, 'The edited message could not be saved.');
      const done = await runGit(['rebase', '--continue'], { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });
      return done.code === 0 ? { outcome: 'done' } : afterStep(root, done, before.step, 'git rebase --continue failed.');
    }

    // `rebase --continue` on its own never runs the pre-commit hook (checked with real git), so the commit is made
    // here first, with the original author. Unchanged (or no) message: git's own text, "#" lines stripped as git does.
    // Edited message: exactly what the user sees, "#" lines kept.
    const edited = message !== undefined && message.trim() !== '' && normalise(message) !== normalise(before.message);
    const text = edited ? (message as string) : before.message;
    const hasStaged = (await runGit(['diff', '--cached', '--quiet'], { cwd: root, repoId })).code === 1;
    // A cut-off or empty message, or nothing staged: leave it to git itself.
    if (hasStaged && text.trim() !== '' && (edited || !before.truncated)) {
      const rh = await runGit(['rev-parse', '-q', '--verify', 'REBASE_HEAD'], { cwd: root, repoId });
      const sha = rh.stdout.trim();
      if (rh.code !== 0 || !SHA_FULL_RE.test(sha)) return failed(rh, 'REBASE_HEAD was not found.');
      const who = await runGit(['log', '-1', '--format=%an%x00%ae%x00%aI', '--end-of-options', sha], { cwd: root, repoId });
      const [an, ae, ad] = who.stdout.replace(/\n$/, '').split('\0');
      if (who.code !== 0 || !an || !ae || !ad) return failed(who, 'The author of the commit could not be read.');
      // Hooks run (no --no-verify).
      const commit = await runGit(['commit', '-F', '-', `--cleanup=${edited ? 'whitespace' : 'strip'}`], {
        cwd: root,
        repoId,
        input: text,
        timeoutMs: TIMEOUT_MS,
        env: { ...NO_EDITOR, GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad },
      });
      if (commit.code !== 0) return failed(commit, 'git commit failed.');
    }

    const res = await runGit(['rebase', '--continue'], { cwd: root, repoId, timeoutMs: TIMEOUT_MS, env: NO_EDITOR });
    return res.code === 0 ? { outcome: 'done' } : afterStep(root, res, before.step, 'git rebase --continue failed.');
  });
}
