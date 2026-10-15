import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const TEST_TOKEN = 'test-token';

const ROOT = join(tmpdir(), 'gitslappin-tests');

/** Creates a fresh, uniquely named, empty directory under os.tmpdir()/gitslappin-tests/. */
export function freshDir(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) {
    throw new Error(`Test dir is not fresh and empty: ${dir}`);
  }
  return dir;
}

function git(cwd: string, args: string[], date?: string): string {
  const when = date ?? '2026-01-01T10:00:00+00:00';
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'author@example.com',
      GIT_COMMITTER_DATE: when,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

export interface CommitSpec {
  message: string;
  files: Record<string, string>;
  date?: string;
}

/** Creates a throwaway repo (branch main) with the given commits; returns its absolute path. */
export function createRepo(name: string, commits: CommitSpec[] = [{ message: 'Initial commit', files: { 'README.md': '# test\n' } }]): string {
  const dir = join(freshDir(name), name);
  mkdirSync(dir);
  git(dir, ['init', '-b', 'main']);
  for (const c of commits) {
    for (const [file, content] of Object.entries(c.files)) {
      const full = join(dir, file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', c.message], c.date);
  }
  return dir;
}

/** Creates an empty bare repo to act as "origin"; returns its path. */
export function createBareOrigin(name = 'origin'): string {
  const dir = join(freshDir(name), `${name}.git`);
  if (existsSync(dir)) throw new Error(`Already exists: ${dir}`);
  mkdirSync(dir);
  git(dir, ['init', '--bare', '-b', 'main']);
  return dir;
}

/** A plain folder that is not a git repo. */
export function createPlainDir(name = 'plain'): string {
  return freshDir(name);
}
