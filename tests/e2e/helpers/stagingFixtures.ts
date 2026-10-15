import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepo, freshDir } from './repo';

const ROOT = join(tmpdir(), 'gitslappin-tests');

/** Every repo handed out by this file must live under os.tmpdir()/gitslappin-tests. */
function assertUnderTestRoot(dir: string): string {
  if (!dir.startsWith(ROOT + '\\') && !dir.startsWith(ROOT + '/')) throw new Error(`Fixture dir is not under ${ROOT}: ${dir}`);
  return dir;
}

export function gitOut(cwd: string, args: string[]): string {
  assertUnderTestRoot(cwd);
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

/** Local identity so commits made through the app work on any machine. */
function setIdentity(repo: string): void {
  gitOut(repo, ['config', 'user.name', 'Test Author']);
  gitOut(repo, ['config', 'user.email', 'author@example.com']);
  gitOut(repo, ['config', 'core.autocrlf', 'false']);
}

export const cachedNames = (repo: string): string[] => gitOut(repo, ['ls-files', '--cached']).split('\n').filter(Boolean).sort();
export const indexText = (repo: string, path: string): string => gitOut(repo, ['show', `:${path}`]);
export const cachedDiff = (repo: string): string => gitOut(repo, ['diff', '--cached']);
export const commitCount = (repo: string): number => {
  try {
    return Number(gitOut(repo, ['rev-list', '--count', 'HEAD']).trim());
  } catch {
    return 0; // unborn HEAD
  }
};
export const headMessage = (repo: string): string => gitOut(repo, ['log', '-1', '--format=%B']).trim();

export const LAST_SUBJECT = 'Second commit';
export const LAST_BODY = 'Second body line';

export const STAGING_FILES = { header: 'src/header.js', app: 'src/app.js', todo: 'TODO.txt' } as const;

/**
 * Matches the GitKraken staging reference screen:
 *  - unstaged (2): src/header.js (modified), TODO.txt (untracked)
 *  - staged (1): src/app.js (modified)
 * HEAD message is LAST_SUBJECT + blank line + LAST_BODY; two commits in total.
 */
export function createStagingRepo(): string {
  const repo = createRepo('staging', [
    { message: 'Initial files', files: { 'src/header.js': 'h1\nh2\nh3\n', 'src/app.js': 'a1\na2\na3\n', 'README.md': '# t\n' } },
    { message: `${LAST_SUBJECT}\n\n${LAST_BODY}`, files: { 'README.md': '# t2\n' } },
  ]);
  assertUnderTestRoot(repo);
  setIdentity(repo);
  writeFileSync(join(repo, 'src/header.js'), 'h1\nh2 edited\nh3\n');
  writeFileSync(join(repo, 'src/app.js'), 'a1\na2 edited\na3\n');
  gitOut(repo, ['add', 'src/app.js']);
  writeFileSync(join(repo, 'TODO.txt'), 'todo 1\n');
  return repo;
}

/**
 * Unstaged only:
 *  - hunks.txt: 30 lines, changed at lines 2 and 28 (two hunks, "line 2 CHANGED" / "line 28 CHANGED")
 *  - lines.txt: base "a\nb\n", working tree "a\nX1\nX2\nb\n" (hunk "@@ -1,2 +1,4 @@", lines ctx a, +X1, +X2, ctx b)
 */
export function createHunkRepo(): string {
  const n = (f: (i: number) => string) => Array.from({ length: 30 }, (_, i) => f(i + 1)).join('\n') + '\n';
  const repo = createRepo('staging-hunks', [
    { message: 'Initial files', files: { 'hunks.txt': n((i) => `line ${i}`), 'lines.txt': 'a\nb\n' } },
  ]);
  assertUnderTestRoot(repo);
  setIdentity(repo);
  writeFileSync(join(repo, 'hunks.txt'), n((i) => (i === 2 ? 'line 2 CHANGED' : i === 28 ? 'line 28 CHANGED' : `line ${i}`)));
  writeFileSync(join(repo, 'lines.txt'), 'a\nX1\nX2\nb\n');
  return repo;
}

/** A repo with no commits and one untracked file, first.txt. */
export function createUnbornRepo(): string {
  const repo = join(assertUnderTestRoot(freshDir('staging-unborn')), 'unborn');
  mkdirSync(repo);
  gitOut(repo, ['init', '-b', 'main']);
  setIdentity(repo);
  writeFileSync(join(repo, 'first.txt'), 'first\n');
  return repo;
}

/** One commit, then a staged change to a.txt and a pre-commit hook. */
export function createHookRepo(hook: 'fail' | 'env'): string {
  const repo = createRepo(`staging-hook-${hook}`, [{ message: 'Initial files', files: { 'a.txt': 'a\n' } }]);
  assertUnderTestRoot(repo);
  setIdentity(repo);
  writeFileSync(join(repo, 'a.txt'), 'a changed\n');
  gitOut(repo, ['add', 'a.txt']);
  const body = hook === 'fail' ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\nenv > .git/hook-env.txt\nexit 0\n';
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), body, { mode: 0o755 });
  return repo;
}

/** What the env-recording hook saw (undefined when the hook never ran). */
export function hookEnv(repo: string): string | undefined {
  try {
    return readFileSync(join(repo, '.git', 'hook-env.txt'), 'utf8');
  } catch {
    return undefined;
  }
}
