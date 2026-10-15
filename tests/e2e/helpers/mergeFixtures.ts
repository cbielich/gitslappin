import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDir } from './repo';

const ROOT = join(tmpdir(), 'gitslappin-tests');

function assertUnderTestRoot(dir: string): string {
  if (!dir.startsWith(ROOT + '\\') && !dir.startsWith(ROOT + '/')) throw new Error(`Fixture dir is not under ${ROOT}: ${dir}`);
  return dir;
}

function gitEnv(who: string): NodeJS.ProcessEnv {
  const email = `${who.toLowerCase().replace(/ /g, '.')}@example.com`;
  return {
    ...process.env,
    GIT_AUTHOR_NAME: who,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'author@example.com',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function gitOut(cwd: string, args: string[], who = 'Test Author'): string {
  assertUnderTestRoot(cwd);
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv(who), stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Runs git and returns the exit status instead of throwing (used to start merges/rebases that are expected to stop on a conflict). */
export function gitStatus(cwd: string, args: string[]): number | null {
  assertUnderTestRoot(cwd);
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv('Test Author') }).status;
}

export const FEATURE = 'feature/conflict';
export const CONFLICT_SUBJECT_B = 'Set title to Conflict B';
export const AUTHORS = { first: 'First Author', second: 'Other Author', third: 'Third Author' } as const;
/** Valid for git (no space, no forbidden chars) and hostile as markup. Written to packed-refs because `<` and `>` cannot be loose ref file names on Windows. */
export const HOSTILE_BRANCH = '<img/src=x/onerror=window.__pwned=1>';

export const headSha = (repo: string): string => gitOut(repo, ['rev-parse', 'HEAD']).trim();
export const refSha = (repo: string, ref: string): string => gitOut(repo, ['rev-parse', '--verify', ref]).trim();
export const currentBranch = (repo: string): string => gitOut(repo, ['branch', '--show-current']).trim();
export const parentCount = (repo: string, ref = 'HEAD'): number => gitOut(repo, ['log', '-1', '--format=%P', ref]).trim().split(' ').filter(Boolean).length;
export const headMessageRaw = (repo: string, ref = 'HEAD'): string => gitOut(repo, ['log', '-1', '--format=%B', ref]);
export const subjects = (repo: string): string[] => gitOut(repo, ['log', '--format=%s']).split('\n').filter(Boolean);
export const stashList = (repo: string): string[] => gitOut(repo, ['stash', 'list', '--format=%gs']).split('\n').filter(Boolean);
export const unmergedPaths = (repo: string): string[] =>
  [...new Set(gitOut(repo, ['ls-files', '-u']).split('\n').filter(Boolean).map((l) => l.split('\t')[1]!))].sort();
export const cachedNames = (repo: string): string[] => gitOut(repo, ['ls-files', '--cached']).split('\n').filter(Boolean).sort();
export const merging = (repo: string): boolean => existsSync(join(repo, '.git', 'MERGE_HEAD'));
export const rebasing = (repo: string): boolean => existsSync(join(repo, '.git', 'rebase-merge'));
export const rebaseStep = (repo: string): number => Number(readFileSync(join(repo, '.git', 'rebase-merge', 'msgnum'), 'utf8').trim());
export const fileText = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8');
/** Author name of the (first) commit with this exact subject. */
export function authorOf(repo: string, subject: string): string | undefined {
  const line = gitOut(repo, ['log', '--format=%an%x09%s'])
    .split('\n')
    .find((l) => l.endsWith(`\t${subject}`));
  return line?.split('\t')[0];
}

function newRepo(prefix: string): string {
  const repo = join(assertUnderTestRoot(freshDir(prefix)), 'r');
  mkdirSync(repo);
  gitOut(repo, ['init', '-b', 'main']);
  gitOut(repo, ['config', 'user.name', 'Test Author']);
  gitOut(repo, ['config', 'user.email', 'author@example.com']);
  gitOut(repo, ['config', 'core.autocrlf', 'false']);
  gitOut(repo, ['config', 'core.editor', 'false']); // an editor that is launched by mistake fails fast instead of hanging
  return repo;
}

function commit(repo: string, files: Record<string, string>, message: string, who = 'Test Author'): void {
  for (const [rel, text] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  gitOut(repo, ['add', '-A']);
  gitOut(repo, ['commit', '-m', message], who);
}

export const DIRTY_README = '# readme with an uncommitted edit\n';
export const CLEAN_README = '# readme\n';

export interface MergeOpts {
  /** How many files conflict (default 2: src/config.js and src/other.js). */
  conflicts?: 1 | 2;
  /** feature/conflict also adds src/added.js, which a merge stages by itself (a "Resolved" file from the start). Default true. */
  added?: boolean;
  /** Leave README.md modified (uncommitted) so an auto-stash is needed. */
  dirty?: boolean;
}

export interface MergeFx {
  repo: string;
  /** main tip before any merge. */
  mainSha: string;
  featureSha: string;
}

/**
 * Not merged yet. On main:
 *  - src/config.js title=main, (src/other.js o=main); feature/conflict has title=feature (o=feature) and, with `added`, src/added.js.
 *  - README.md committed as CLEAN_README; with `dirty` it is changed to DIRTY_README in the working tree.
 */
export function createMergeRepo(opts: MergeOpts = {}): MergeFx {
  const { conflicts = 2, added = true, dirty = false } = opts;
  const repo = newRepo('merge');
  commit(repo, { 'src/config.js': 'title=base\n', 'src/other.js': 'o=base\n', 'README.md': CLEAN_README }, 'Set title to Conflict base');
  gitOut(repo, ['switch', '-c', FEATURE]);
  commit(repo, { 'src/config.js': 'title=feature\n', ...(conflicts === 2 ? { 'src/other.js': 'o=feature\n' } : {}), ...(added ? { 'src/added.js': 'added\n' } : {}) }, 'Set title to Conflict A');
  const featureSha = headSha(repo);
  gitOut(repo, ['switch', 'main']);
  commit(repo, { 'src/config.js': 'title=main\n', ...(conflicts === 2 ? { 'src/other.js': 'o=main\n' } : {}) }, CONFLICT_SUBJECT_B);
  if (dirty) writeFileSync(join(repo, 'README.md'), DIRTY_README);
  return { repo, mainSha: headSha(repo), featureSha };
}

/** createMergeRepo, then `git merge --no-ff --no-edit feature/conflict`, which stops on the conflict (MERGE_HEAD exists). */
export function createMergeInProgress(opts: MergeOpts & { untracked?: boolean } = {}): MergeFx & { configMain: string } {
  const fx = createMergeRepo(opts);
  const configMain = fileText(fx.repo, 'src/config.js');
  if (opts.untracked) writeFileSync(join(fx.repo, 'scratch.txt'), 'never staged by the app\n');
  const status = gitStatus(fx.repo, ['merge', '--no-ff', '--no-edit', FEATURE]);
  if (status === 0 || !merging(fx.repo)) throw new Error('fixture: the merge was expected to stop on a conflict');
  return { ...fx, configMain };
}

export interface RebaseFx {
  repo: string;
  /** main tip before the rebase (3 commits ahead of base). */
  original: string;
  /** feature/conflict tip, the rebase target. */
  onto: string;
}

/**
 * main: Base, "First change" (a.txt, First Author), "Set title to Conflict B" (src/config.js, Other Author),
 * "Third change" (c.txt, Third Author). feature/conflict: Base, "Set title to Conflict A" (src/config.js).
 * Rebasing main onto feature/conflict therefore stops at commit 2 of 3.
 */
export function createRebaseRepo(opts: { dirty?: boolean } = {}): RebaseFx {
  const repo = newRepo('rebase');
  commit(repo, { 'src/config.js': 'title=base\n', 'README.md': CLEAN_README }, 'Base');
  gitOut(repo, ['switch', '-c', FEATURE]);
  commit(repo, { 'src/config.js': 'title=feature\n' }, 'Set title to Conflict A');
  const onto = headSha(repo);
  gitOut(repo, ['switch', 'main']);
  commit(repo, { 'a.txt': 'a\n' }, 'First change', AUTHORS.first);
  commit(repo, { 'src/config.js': 'title=main\n' }, CONFLICT_SUBJECT_B, AUTHORS.second);
  commit(repo, { 'c.txt': 'c\n' }, 'Third change', AUTHORS.third);
  if (opts.dirty) writeFileSync(join(repo, 'README.md'), DIRTY_README);
  return { repo, original: headSha(repo), onto };
}

/** createRebaseRepo, then `git rebase feature/conflict`, which stops at step 2 of 3 on src/config.js. */
export function createRebaseInProgress(): RebaseFx {
  const fx = createRebaseRepo();
  const status = gitStatus(fx.repo, ['-c', 'core.editor=true', 'rebase', FEATURE]);
  if (status === 0 || !rebasing(fx.repo)) throw new Error('fixture: the rebase was expected to stop on a conflict');
  return fx;
}

export interface MenuFx {
  repo: string;
  mainSha: string;
  /** Descendant of main (main can fast-forward to it). */
  aheadSha: string;
  /** Diverged from main, touches only side.txt, so it merges without conflict. */
  sideSha: string;
}

/** main (2 commits), `ahead` = main + 1 commit, `side` = first commit + 1 commit that touches a different file. Clean tree, on main. */
export function createMenuRepo(): MenuFx {
  const repo = newRepo('merge-menu');
  commit(repo, { 'base.txt': 'base\n' }, 'Menu base');
  commit(repo, { 'main.txt': 'main\n' }, 'Menu main change');
  gitOut(repo, ['branch', 'ahead']);
  gitOut(repo, ['switch', 'ahead']);
  commit(repo, { 'ahead.txt': 'ahead\n' }, 'Menu ahead change');
  const aheadSha = headSha(repo);
  gitOut(repo, ['switch', '-c', 'side', 'HEAD~2']);
  commit(repo, { 'side.txt': 'side\n' }, 'Menu side change');
  const sideSha = headSha(repo);
  gitOut(repo, ['switch', 'main']);
  return { repo, mainSha: headSha(repo), aheadSha, sideSha };
}

/** createMenuRepo with HEAD detached at the main tip. */
export function createDetachedMenuRepo(): MenuFx {
  const fx = createMenuRepo();
  gitOut(fx.repo, ['switch', '--detach', 'main']);
  return fx;
}

/** createMenuRepo plus a branch named HOSTILE_BRANCH (at main~1), created through packed-refs. */
export function createHostileBranchRepo(): MenuFx {
  const fx = createMenuRepo();
  gitOut(fx.repo, ['pack-refs', '--all']);
  const file = join(fx.repo, '.git', 'packed-refs');
  const header = readFileSync(file, 'utf8').split('\n')[0] ?? '';
  // the "sorted" trait promises binary-searchable order; drop it because the line is appended at the end
  const rewritten = readFileSync(file, 'utf8').replace(header, header.replace(' sorted', ''));
  writeFileSync(file, rewritten);
  // On main~1, a commit with no other refs: at the main tip the graph shows only the current branch pill and "+1".
  const at = gitOut(fx.repo, ['rev-parse', 'main~1']).trim();
  appendFileSync(file, `${at} refs/heads/${HOSTILE_BRANCH}\n`);
  if (!gitOut(fx.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).includes(HOSTILE_BRANCH)) {
    throw new Error('fixture: git does not list the hostile branch');
  }
  return fx;
}

/** Installs a pre-commit hook that only records that it ran (writes .git/hook-ran.txt) and exits 0. Marker is undefined until it runs. */
export function installRecordingHook(repo: string): void {
  assertUnderTestRoot(repo);
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho ran > .git/hook-ran.txt\nexit 0\n', { mode: 0o755 });
}
export const hookRan = (repo: string): boolean => existsSync(join(repo, '.git', 'hook-ran.txt'));
