import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDir } from './repo';

/* V4 fixtures. Every repo is created in a fresh mkdtemp folder under os.tmpdir()/gitslappin-tests (freshDir). Nothing is deleted. */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function assertUnderTestRoot(dir: string): string {
  if (!dir.startsWith(ROOT + '\\') && !dir.startsWith(ROOT + '/')) throw new Error(`Fixture dir is not under ${ROOT}: ${dir}`);
  return dir;
}

let clock = 1_700_000_000;
export function gitOut(cwd: string, args: string[], who = 'Test Author'): string {
  assertUnderTestRoot(cwd);
  const date = `${clock} +0000`;
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: who,
      GIT_AUTHOR_EMAIL: `${who.toLowerCase().replace(/ /g, '.')}@example.com`,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'author@example.com',
      GIT_COMMITTER_DATE: date,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

export const headSha = (repo: string): string => gitOut(repo, ['rev-parse', 'HEAD']).trim();
export const subjectsOf = (repo: string, ref = 'HEAD'): string[] => gitOut(repo, ['log', '--format=%s', ref]).split('\n').filter(Boolean);
export const messageOf = (repo: string, ref = 'HEAD'): string => gitOut(repo, ['log', '-1', '--format=%B', ref]).trimEnd();
export const treeOf = (repo: string, ref = 'HEAD'): string => gitOut(repo, ['rev-parse', `${ref}^{tree}`]).trim();
export const rebaseInProgress = (repo: string): boolean => existsSync(join(repo, '.git', 'rebase-merge'));
export const trackedFiles = (repo: string, ref = 'HEAD'): string[] => gitOut(repo, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean);
export const authorOfSubject = (repo: string, subject: string): string | undefined =>
  gitOut(repo, ['log', '--format=%an%x09%s']).split('\n').find((l) => l.endsWith(`\t${subject}`))?.split('\t')[0];

function newRepo(prefix: string): string {
  const repo = join(assertUnderTestRoot(freshDir(prefix)), 'r');
  mkdirSync(repo);
  gitOut(repo, ['init', '-b', 'main']);
  gitOut(repo, ['config', 'user.name', 'Test Author']);
  gitOut(repo, ['config', 'user.email', 'author@example.com']);
  gitOut(repo, ['config', 'core.autocrlf', 'false']);
  gitOut(repo, ['config', 'core.editor', 'false']); // an editor launched by mistake fails fast instead of hanging
  return repo;
}
export function commitFiles(repo: string, files: Record<string, string>, message: string, who = 'Test Author'): string {
  clock += 100;
  for (const [rel, text] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  gitOut(repo, ['add', '-A']);
  gitOut(repo, ['commit', '-m', message], who);
  return headSha(repo);
}

export interface RewriteFx {
  repo: string;
  base: string;
  one: string;
  two: string;
  three: string;
  four: string;
}

/** main: Base (a.txt, b.txt), one (f1.txt, First Author), two (f2.txt, Second Author), three (f3.txt, Third Author), four (f4.txt, Fourth Author). Clean, on main. */
export function createRewriteRepo(): RewriteFx {
  const repo = newRepo('rewrite');
  const base = commitFiles(repo, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'Base');
  const one = commitFiles(repo, { 'f1.txt': '1\n' }, 'one', 'First Author');
  const two = commitFiles(repo, { 'f2.txt': '2\n' }, 'two', 'Second Author');
  const three = commitFiles(repo, { 'f3.txt': '3\n' }, 'three', 'Third Author');
  const four = commitFiles(repo, { 'f4.txt': '4\n' }, 'four', 'Fourth Author');
  return { repo, base, one, two, three, four };
}

/** createRewriteRepo plus a branch `base-branch` at Base (for the pill menu "Interactive Rebase main onto base-branch"). */
export function createRewriteRepoWithBranch(): RewriteFx {
  const fx = createRewriteRepo();
  gitOut(fx.repo, ['branch', 'base-branch', fx.base]);
  return fx;
}

/** main: Base (s.txt=base), one (f1), two (s.txt=two), three (s.txt=three), four (f4). Dropping `two` makes `three` conflict on s.txt. */
export function createRewriteConflictRepo(): RewriteFx {
  const repo = newRepo('rewrite-conflict');
  const base = commitFiles(repo, { 's.txt': 'base\n', 'a.txt': 'a\n' }, 'Base');
  const one = commitFiles(repo, { 'f1.txt': '1\n' }, 'one', 'First Author');
  const two = commitFiles(repo, { 's.txt': 'two\n' }, 'two', 'Second Author');
  const three = commitFiles(repo, { 's.txt': 'three\n' }, 'three', 'Third Author');
  const four = commitFiles(repo, { 'f4.txt': '4\n' }, 'four', 'Fourth Author');
  return { repo, base, one, two, three, four };
}

export interface PickFx {
  repo: string;
  base: string;
  m1: string;
  f1: string;
  f2: string;
}
/** main: Base, "main one" (m.txt). feature (from Base): "feat one" (f1.txt, First Author), "feat two" (f2.txt, Second Author). Checked out: main. */
export function createPickRepo(): PickFx {
  const repo = newRepo('rewrite-pick');
  const base = commitFiles(repo, { 'a.txt': 'a\n' }, 'Base');
  gitOut(repo, ['switch', '-c', 'feature']);
  const f1 = commitFiles(repo, { 'f1.txt': '1\n' }, 'feat one', 'First Author');
  const f2 = commitFiles(repo, { 'f2.txt': '2\n' }, 'feat two', 'Second Author');
  gitOut(repo, ['switch', 'main']);
  const m1 = commitFiles(repo, { 'm.txt': 'm\n' }, 'main one');
  return { repo, base, m1, f1, f2 };
}
