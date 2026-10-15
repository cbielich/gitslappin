import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeAbort, mergeBranch, rebaseAbort, rebaseContinue, rebaseOnto, rebaseSkip } from './integrate';
import { readOpState } from './opState';

/*
 * Contract the builder must export from server/src/git/integrate.ts (every function takes the repo root and runs
 * through runExclusive + the runner; none throws for a git failure, they return a result):
 *   mergeBranch(root, name, opts?: { ffOnly?: boolean }): Promise<IntegrateResult>
 *   rebaseOnto(root, onto /* branch name or 40-hex sha *\/): Promise<IntegrateResult>
 *   rebaseContinue(root, opts?: { message?: string }), rebaseSkip(root), rebaseAbort(root), mergeAbort(root): Promise<IntegrateResult>
 *   IntegrateResult = { outcome: 'done' | 'conflict' | 'failed' | 'blocked'; error?: string; stderr?: string;
 *                       stash?: { message: string } }   (stash only when an auto-stash was created; never popped)
 *   'blocked' = another operation is in progress (the route's 409); nothing was changed.
 * Real git in mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted.
 * The runner strips GIT_CONFIG_* from the child, so identity and core.editor=false are also set in each repo's own config:
 * an editor started by mistake then fails instead of hanging.
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');

function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const GLOBAL_CFG = join(fresh('gitcfg-integrate'), 'global.gitconfig');
writeFileSync(GLOBAL_CFG, '[core]\n\teditor = false\n');

const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: GLOBAL_CFG,
  GIT_TERMINAL_PROMPT: '0',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
};
delete BASE_ENV.GITSLAPPIN_TOKEN;
// The code under test inherits this identity; the edited-continue test proves the author is overridden from REBASE_HEAD.
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com' });

const envFor = (who: string): NodeJS.ProcessEnv => ({ ...BASE_ENV, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who.toLowerCase().replace(/ /g, '.')}@example.com` });
const git = (cwd: string, args: string[], who = 'Test Author'): string =>
  execFileSync('git', args, { cwd, env: envFor(who), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): number | null => spawnSync('git', args, { cwd, env: envFor('Test Author'), encoding: 'utf8', windowsHide: true }).status;

const head = (repo: string): string => git(repo, ['rev-parse', 'HEAD']).trim();
const stashes = (repo: string): string[] => git(repo, ['stash', 'list', '--format=%gs']).split('\n').filter(Boolean);
const text = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8');
const rebasing = (repo: string): boolean => existsSync(join(repo, '.git', 'rebase-merge'));
const merging = (repo: string): boolean => existsSync(join(repo, '.git', 'MERGE_HEAD'));
const subjects = (repo: string): string[] => git(repo, ['log', '--format=%s']).split('\n').filter(Boolean);
const authorOf = (repo: string, subject: string): string | undefined =>
  git(repo, ['log', '--format=%an%x09%s']).split('\n').find((l) => l.endsWith(`\t${subject}`))?.split('\t')[0];
const body = (repo: string): string => git(repo, ['log', '-1', '--format=%B']);

function commit(repo: string, files: Record<string, string>, msg: string, who = 'Test Author'): string {
  for (const [rel, t] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, t);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', msg], who);
  return head(repo);
}
function newRepo(prefix: string): string {
  const repo = join(fresh(prefix), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'author@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'core.editor', 'false']);
  return repo;
}

const README = '# readme\n';
const DIRTY = '# readme with an uncommitted edit\n';

/** main: Base, (Main change). feature/conflict conflicts on src/config.js; side merges cleanly; ahead is a descendant of main. */
function mergeRepo(opts: { dirty?: boolean } = {}): string {
  const repo = newRepo('integ-merge');
  commit(repo, { 'src/config.js': 'title=base\n', 'README.md': README }, 'Base');
  git(repo, ['switch', '-c', 'feature/conflict']);
  commit(repo, { 'src/config.js': 'title=feature\n' }, 'Set title to Conflict A');
  git(repo, ['switch', '-c', 'side', 'main']);
  commit(repo, { 'side.txt': 'side\n' }, 'Side change');
  git(repo, ['switch', 'main']);
  commit(repo, { 'src/config.js': 'title=main\n' }, 'Set title to Conflict B');
  git(repo, ['switch', '-c', 'ahead']);
  commit(repo, { 'ahead.txt': 'ahead\n' }, 'Ahead change');
  git(repo, ['switch', 'main']);
  if (opts.dirty) writeFileSync(join(repo, 'README.md'), DIRTY);
  return repo;
}

/** main: Base, First change (First Author), Set title to Conflict B (Other Author), Third change (Third Author); feature/conflict: Base + Set title to Conflict A. */
function rebaseRepo(opts: { dirty?: boolean } = {}): { repo: string; original: string } {
  const repo = newRepo('integ-rebase');
  commit(repo, { 'src/config.js': 'title=base\n', 'README.md': README }, 'Base');
  git(repo, ['switch', '-c', 'feature/conflict']);
  commit(repo, { 'src/config.js': 'title=feature\n' }, 'Set title to Conflict A');
  git(repo, ['switch', 'main']);
  commit(repo, { 'a.txt': 'a\n' }, 'First change', 'First Author');
  commit(repo, { 'src/config.js': 'title=main\n' }, 'Set title to Conflict B', 'Other Author');
  commit(repo, { 'c.txt': 'c\n' }, 'Third change', 'Third Author');
  if (opts.dirty) writeFileSync(join(repo, 'README.md'), DIRTY);
  return { repo, original: head(repo) };
}

/** rebaseRepo, stopped on the conflict of step 2 of 3 through the code under test. */
async function rebaseStopped(): Promise<{ repo: string; original: string }> {
  const fx = rebaseRepo();
  const r = await rebaseOnto(fx.repo, 'feature/conflict');
  expect(r.outcome).toBe('conflict');
  expect(rebasing(fx.repo)).toBe(true);
  return fx;
}
/** Resolve the conflicted file by hand and stage it. */
const resolve = (repo: string): void => {
  writeFileSync(join(repo, 'src/config.js'), 'title=resolved\n');
  git(repo, ['add', 'src/config.js']);
};

describe('mergeBranch', () => {
  it('conflict on a clean tree: outcome conflict (not an error), merge state present, no stash created', async () => {
    const repo = mergeRepo();
    const r = await mergeBranch(repo, 'feature/conflict');
    expect(r.outcome).toBe('conflict');
    expect(r.stash).toBeUndefined();
    expect(merging(repo)).toBe(true);
    expect(stashes(repo)).toEqual([]);
    expect((await readOpState(repo))!.kind).toBe('merge');
  });

  it('clean merge: no stash when nothing is dirty, and --no-ff makes a merge commit', async () => {
    const repo = mergeRepo();
    const before = head(repo);
    const r = await mergeBranch(repo, 'side');
    expect(r.outcome).toBe('done');
    expect(r.stash).toBeUndefined();
    expect(stashes(repo)).toEqual([]);
    expect(git(repo, ['log', '-1', '--format=%P']).trim().split(' ')).toHaveLength(2);
    expect(git(repo, ['rev-parse', 'HEAD^1']).trim()).toBe(before);
  });

  it('dirty tree: stashes first with the StashMessage-Merge text, working tree is then clean, stash is not popped', async () => {
    const repo = mergeRepo({ dirty: true });
    const r = await mergeBranch(repo, 'feature/conflict');
    expect(r.outcome).toBe('conflict');
    expect(r.stash?.message).toBe('Auto stash before merge of "main" and "feature/conflict"');
    expect(stashes(repo).some((s) => s.endsWith('Auto stash before merge of "main" and "feature/conflict"'))).toBe(true);
    expect(text(repo, 'README.md')).toBe(README); // the edit lives in the stash, not in the tree
    expect(git(repo, ['show', 'stash@{0}:README.md'])).toBe(DIRTY);
  });

  it('untracked files are stashed too (--include-untracked)', async () => {
    const repo = mergeRepo();
    writeFileSync(join(repo, 'notes.txt'), 'untracked\n');
    const r = await mergeBranch(repo, 'side');
    expect(r.outcome).toBe('done');
    expect(r.stash?.message).toBe('Auto stash before merge of "main" and "side"');
    expect(existsSync(join(repo, 'notes.txt'))).toBe(false);
    expect(git(repo, ['show', 'stash@{0}^3:notes.txt'])).toBe('untracked\n');
  });

  it('stash fails: the merge never runs, HEAD and the dirty bytes are unchanged, an error is returned', async () => {
    const repo = mergeRepo({ dirty: true });
    const before = head(repo);
    writeFileSync(join(repo, '.git', 'refs', 'stash.lock'), ''); // makes `stash push` unable to update refs/stash; merge itself would succeed
    const r = await mergeBranch(repo, 'side'); // would merge cleanly if it ran
    expect(r.outcome).toBe('failed');
    expect(r.error ?? r.stderr ?? '').not.toBe('');
    expect(head(repo)).toBe(before);
    expect(merging(repo)).toBe(false);
    expect(text(repo, 'README.md')).toBe(DIRTY);
    expect(stashes(repo)).toEqual([]);
    expect(subjects(repo)).not.toContain('Side change');
  });

  it('merge fails for a reason other than a conflict: the stash is kept and named in the result', async () => {
    const repo = mergeRepo({ dirty: true });
    git(repo, ['stash', 'push', '-m', 'park']); // switch --orphan needs a clean tree; park the edit, build the branch, restore it
    git(repo, ['switch', '--orphan', 'orphan']);
    commit(repo, { 'o.txt': 'o\n' }, 'Orphan root');
    git(repo, ['switch', 'main']);
    git(repo, ['stash', 'pop']);
    expect(text(repo, 'README.md')).toBe(DIRTY);
    const before = head(repo);
    const r = await mergeBranch(repo, 'orphan');
    expect(r.outcome).toBe('failed');
    expect(r.stderr ?? r.error ?? '').toMatch(/unrelated histories/);
    expect(r.stash?.message).toBe('Auto stash before merge of "main" and "orphan"');
    expect(stashes(repo).filter((s) => s.includes('Auto stash before merge of "main" and "orphan"'))).toHaveLength(1);
    expect(git(repo, ['show', 'stash@{0}:README.md'])).toBe(DIRTY);
    expect(head(repo)).toBe(before);
    expect(merging(repo)).toBe(false);
  });

  it('ffOnly: fast-forwards when possible, refuses (HEAD unchanged) when diverged', async () => {
    const repo = mergeRepo();
    const diverged = await mergeBranch(repo, 'side', { ffOnly: true });
    expect(diverged.outcome).toBe('failed');
    expect(subjects(repo)).not.toContain('Side change');
    const ahead = git(repo, ['rev-parse', 'ahead']).trim();
    const r = await mergeBranch(repo, 'ahead', { ffOnly: true });
    expect(r.outcome).toBe('done');
    expect(head(repo)).toBe(ahead);
  });

  it('blocked (409) while a rebase is in progress: nothing changes and nothing is stashed', async () => {
    const { repo } = await rebaseStopped();
    writeFileSync(join(repo, 'extra.txt'), 'dirty\n');
    const step = readFileSync(join(repo, '.git', 'rebase-merge', 'msgnum'), 'utf8');
    const r = await mergeBranch(repo, 'feature/conflict');
    expect(r.outcome).toBe('blocked');
    expect(stashes(repo)).toEqual([]);
    expect(existsSync(join(repo, 'extra.txt'))).toBe(true);
    expect(readFileSync(join(repo, '.git', 'rebase-merge', 'msgnum'), 'utf8')).toBe(step);
  });
});

describe('mergeAbort', () => {
  it('after a GitSlappin merge on a dirty tree: HEAD unchanged, tree equals the pre-merge committed bytes, edit still in the stash', async () => {
    const repo = mergeRepo({ dirty: true });
    const before = head(repo);
    const cfgBefore = text(repo, 'src/config.js');
    expect((await mergeBranch(repo, 'feature/conflict')).outcome).toBe('conflict');
    const r = await mergeAbort(repo);
    expect(r.outcome).toBe('done');
    expect(merging(repo)).toBe(false);
    expect(head(repo)).toBe(before);
    expect(text(repo, 'src/config.js')).toBe(cfgBefore);
    expect(text(repo, 'README.md')).toBe(README);
    expect(git(repo, ['show', 'stash@{0}:README.md'])).toBe(DIRTY);
  });

  it('settles git: a raw merge started over a non-overlapping uncommitted edit, then aborted, keeps those bytes', async () => {
    const repo = mergeRepo({ dirty: true });
    const before = head(repo);
    expect(tryGit(repo, ['merge', '--no-ff', '--no-edit', 'feature/conflict'])).not.toBe(0);
    expect(merging(repo)).toBe(true);
    const r = await mergeAbort(repo);
    expect(r.outcome).toBe('done');
    expect(head(repo)).toBe(before);
    expect(text(repo, 'README.md')).toBe(DIRTY);
    expect(text(repo, 'src/config.js')).toBe('title=main\n');
  });
});

describe('rebaseOnto', () => {
  it('stops on the conflict at step 2 of 3 and reports a conflict, not an error', async () => {
    const { repo } = rebaseRepo();
    const r = await rebaseOnto(repo, 'feature/conflict');
    expect(r.outcome).toBe('conflict');
    expect(r.stash).toBeUndefined();
    const op = await readOpState(repo);
    expect(op).toMatchObject({ kind: 'rebase', step: 2, total: 3, head: 'main', onto: 'feature/conflict' });
  });

  it('dirty tree: stashes first with the StashMessage-RebaseOnto text and never pops it', async () => {
    const { repo } = rebaseRepo({ dirty: true });
    const r = await rebaseOnto(repo, 'feature/conflict');
    expect(r.outcome).toBe('conflict');
    expect(r.stash?.message).toBe('Auto stash before rebase of "main" onto "feature/conflict"');
    expect(stashes(repo).some((s) => s.endsWith('Auto stash before rebase of "main" onto "feature/conflict"'))).toBe(true);
    expect(text(repo, 'README.md')).toBe(README);
  });

  it('stash fails: the rebase never runs', async () => {
    const { repo, original } = rebaseRepo({ dirty: true });
    writeFileSync(join(repo, '.git', 'refs', 'stash.lock'), '');
    const r = await rebaseOnto(repo, 'feature/conflict');
    expect(r.outcome).toBe('failed');
    expect(head(repo)).toBe(original);
    expect(rebasing(repo)).toBe(false);
    expect(git(repo, ['branch', '--show-current']).trim()).toBe('main');
    expect(text(repo, 'README.md')).toBe(DIRTY);
    expect(stashes(repo)).toEqual([]);
  });

  it('rebase fails for a reason other than a conflict (pre-rebase hook refuses): the stash is kept and named', async () => {
    const { repo, original } = rebaseRepo({ dirty: true });
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'pre-rebase'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = await rebaseOnto(repo, 'feature/conflict');
    expect(r.outcome).toBe('failed');
    expect(r.stash?.message).toBe('Auto stash before rebase of "main" onto "feature/conflict"');
    expect(stashes(repo)).toHaveLength(1);
    expect(git(repo, ['show', 'stash@{0}:README.md'])).toBe(DIRTY);
    expect(head(repo)).toBe(original);
    expect(rebasing(repo)).toBe(false);
  });

  it('no stash when the tree is clean', async () => {
    const { repo } = rebaseRepo();
    await rebaseOnto(repo, 'feature/conflict');
    expect(stashes(repo)).toEqual([]);
  });
});

describe('rebase continue / skip / abort', () => {
  it('continue with the unchanged message: finishes the rebase, keeps the original author and subject', async () => {
    const { repo } = await rebaseStopped();
    resolve(repo);
    const op = await readOpState(repo);
    const r = await rebaseContinue(repo, { message: op!.message });
    expect(r.outcome).toBe('done');
    expect(rebasing(repo)).toBe(false);
    expect(subjects(repo).slice(0, 3)).toEqual(['Third change', 'Set title to Conflict B', 'First change']);
    expect(authorOf(repo, 'Set title to Conflict B')).toBe('Other Author');
    expect(authorOf(repo, 'Third change')).toBe('Third Author');
    expect(authorOf(repo, 'First change')).toBe('First Author');
    expect(git(repo, ['merge-base', '--is-ancestor', 'feature/conflict', 'HEAD']).trim()).toBe('');
  });

  it('continue without a message also finishes and keeps the author', async () => {
    const { repo } = await rebaseStopped();
    resolve(repo);
    const r = await rebaseContinue(repo);
    expect(r.outcome).toBe('done');
    expect(authorOf(repo, 'Set title to Conflict B')).toBe('Other Author');
  });

  it('continue with an edited message: the author comes from REBASE_HEAD (not the process identity), and "#" lines are kept (--cleanup=whitespace)', async () => {
    const { repo } = await rebaseStopped();
    resolve(repo);
    const message = 'Edited rebase subject\n\n# Conflicts:\n#\tsrc/config.js\n';
    const r = await rebaseContinue(repo, { message });
    expect(r.outcome).toBe('done');
    expect(rebasing(repo)).toBe(false);
    expect(authorOf(repo, 'Edited rebase subject')).toBe('Other Author');
    expect(git(repo, ['log', '--format=%ae', '--grep=Edited rebase subject', '-1']).trim()).toBe('other.author@example.com');
    const edited = git(repo, ['log', '--format=%B', '--grep=Edited rebase subject', '-1']);
    expect(edited).toContain('# Conflicts:');
    expect(edited).toContain('#\tsrc/config.js');
    expect(subjects(repo)).toContain('Third change'); // the rest of the todo list ran
  });

  it('continue runs the user hooks (no --no-verify), for the unchanged and the edited message', async () => {
    for (const edited of [false, true]) {
      const { repo } = await rebaseStopped();
      resolve(repo);
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho ran > .git/hook-ran.txt\nexit 0\n', { mode: 0o755 });
      expect(existsSync(join(repo, '.git', 'hook-ran.txt'))).toBe(false);
      const op = await readOpState(repo);
      const r = await rebaseContinue(repo, { message: edited ? 'Edited with hook\n' : op!.message });
      expect(r.outcome).toBe('done');
      expect(existsSync(join(repo, '.git', 'hook-ran.txt'))).toBe(true);
    }
  });

  it('a failing pre-commit hook makes the edited continue fail and leaves the rebase in progress at step 2', async () => {
    const { repo } = await rebaseStopped();
    resolve(repo);
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = await rebaseContinue(repo, { message: 'Edited but blocked\n' });
    expect(r.outcome).toBe('failed');
    expect(rebasing(repo)).toBe(true);
    expect((await readOpState(repo))!.step).toBe(2);
    expect(subjects(repo)).not.toContain('Edited but blocked');
  });

  it('rejects a posted message with a NUL or over 64 KB; the rebase is untouched', async () => {
    const { repo } = await rebaseStopped();
    resolve(repo);
    for (const message of ['bad\u0000message', 'x'.repeat(64 * 1024 + 1)]) {
      const r = await rebaseContinue(repo, { message });
      expect(r.outcome).toBe('failed');
      expect(rebasing(repo)).toBe(true);
      expect((await readOpState(repo))!.step).toBe(2);
    }
  });

  it('skip drops the conflicting commit, applies the rest, keeps the other authors', async () => {
    const { repo } = await rebaseStopped();
    const r = await rebaseSkip(repo);
    expect(r.outcome).toBe('done');
    expect(rebasing(repo)).toBe(false);
    expect(subjects(repo)).not.toContain('Set title to Conflict B');
    expect(subjects(repo).slice(0, 2)).toEqual(['Third change', 'First change']);
    expect(authorOf(repo, 'Third change')).toBe('Third Author');
    expect(authorOf(repo, 'First change')).toBe('First Author');
  });

  it('abort restores the branch and HEAD exactly, with the original authors', async () => {
    const { repo, original } = await rebaseStopped();
    const r = await rebaseAbort(repo);
    expect(r.outcome).toBe('done');
    expect(rebasing(repo)).toBe(false);
    expect(head(repo)).toBe(original);
    expect(git(repo, ['branch', '--show-current']).trim()).toBe('main');
    expect(authorOf(repo, 'Set title to Conflict B')).toBe('Other Author');
    expect(text(repo, 'src/config.js')).toBe('title=main\n');
  });

  it('continue, skip and abort never open an editor (core.editor=false would fail them)', async () => {
    const a = await rebaseStopped();
    resolve(a.repo);
    expect((await rebaseContinue(a.repo)).outcome).toBe('done');
    const b = await rebaseStopped();
    expect((await rebaseSkip(b.repo)).outcome).toBe('done');
    const c = await rebaseStopped();
    expect((await rebaseAbort(c.repo)).outcome).toBe('done');
  });
});
