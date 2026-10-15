import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBareOrigin, createRepo, freshDir } from './repo';

const ROOT = join(tmpdir(), 'gitslappin-tests');

function assertUnderTestRoot(dir: string): string {
  if (!dir.startsWith(ROOT + '\\') && !dir.startsWith(ROOT + '/')) throw new Error(`Fixture dir is not under ${ROOT}: ${dir}`);
  return dir;
}

export function gitOut(cwd: string, args: string[]): string {
  assertUnderTestRoot(cwd);
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'author@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

export const currentBranch = (repo: string): string => gitOut(repo, ['branch', '--show-current']).trim();
export const headSha = (repo: string): string => gitOut(repo, ['rev-parse', 'HEAD']).trim();
export const refSha = (repo: string, ref: string): string => gitOut(repo, ['rev-parse', '--verify', ref]).trim();
export const localBranches = (repo: string): string[] =>
  gitOut(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean).sort();
export const upstreamOf = (repo: string, branch: string): string => gitOut(repo, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]).trim();
/** True when HEAD is not on a branch. */
export const isDetached = (repo: string): boolean => currentBranch(repo) === '';

export const SUBJECTS = ['Branch fixture 1', 'Branch fixture 2', 'Branch fixture 3', 'Branch fixture 4', 'Branch fixture 5'] as const;

export interface BranchRepo {
  repo: string;
  origin: string;
  /** Full shas of the 5 commits, oldest first (matches SUBJECTS). */
  shas: string[];
}

/**
 * Linear history C1..C5 (subjects SUBJECTS), current branch main at C5, remote "origin" (bare):
 *  - local `dup` at C1; origin/dup at C5 (local exists at a DIFFERENT sha -> 409 prompt)
 *  - local `feature/one` at C2 (local only)
 *  - origin/remote-only at C3 (no local branch)
 *  - local `same` and origin/same both at C4
 *  - main and origin/main at C5. Clean working tree.
 * Each call builds a fresh repo, so tests may mutate it.
 */
export function createBranchRepo(): BranchRepo {
  const origin = createBareOrigin('branch-origin');
  const repo = createRepo(
    'branches',
    SUBJECTS.map((message, i) => ({ message, files: { 'file.txt': `v${i + 1}\n` } })),
  );
  assertUnderTestRoot(repo);
  const shas = gitOut(repo, ['rev-list', '--reverse', 'HEAD']).split('\n').filter(Boolean);
  gitOut(repo, ['remote', 'add', 'origin', origin]);
  gitOut(repo, ['push', 'origin', 'main', `${shas[2]}:refs/heads/remote-only`, `${shas[3]}:refs/heads/same`, `${shas[4]}:refs/heads/dup`]);
  gitOut(repo, ['fetch', 'origin']);
  gitOut(repo, ['branch', 'same', shas[3]!]);
  gitOut(repo, ['branch', 'dup', shas[0]!]);
  gitOut(repo, ['branch', 'feature/one', shas[1]!]);
  return { repo, origin, shas };
}

/**
 * Like createBranchRepo but with a second remote named `team/a` (name contains a slash) that has
 * branch `feat/x` at C5. There is no local feat/x.
 */
export function createSlashRemoteRepo(): BranchRepo {
  const fx = createBranchRepo();
  const team = join(freshDir('branch-team'), 'team.git');
  mkdirSync(team);
  gitOut(team, ['init', '--bare', '-b', 'main']);
  gitOut(fx.repo, ['remote', 'add', 'team/a', team]);
  gitOut(fx.repo, ['push', 'team/a', `${fx.shas[4]}:refs/heads/feat/x`]);
  gitOut(fx.repo, ['fetch', 'team/a']);
  return fx;
}

/**
 * main has file.txt = "base"; branch `other` (one commit ahead) changes file.txt; the working tree of main
 * has an uncommitted edit to file.txt, so checking out `other` conflicts. Returns the repo path.
 */
export const DIRTY_TEXT = 'local uncommitted edit\n';
export function createConflictRepo(): string {
  const repo = createRepo('branch-conflict', [{ message: 'Conflict base', files: { 'file.txt': 'base\n' } }]);
  assertUnderTestRoot(repo);
  gitOut(repo, ['switch', '-c', 'other']);
  writeFileSync(join(repo, 'file.txt'), 'other\n');
  gitOut(repo, ['commit', '-am', 'Conflict other change']);
  gitOut(repo, ['switch', 'main']);
  writeFileSync(join(repo, 'file.txt'), DIRTY_TEXT);
  return repo;
}
