import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../../../shared/src/diff';
import { buildPatch } from '../../../shared/src/patch';
import { applyCachedArgs, reDiffArgs, unstagePathsArgs } from './stageCommands';

/*
 * Phase 4 code-review fixes 1, 2 and 8, with the REAL argv builders from stageCommands.ts.
 * Fresh mkdtemp repos under os.tmpdir()/gitslappin-tests. Nothing is deleted.
 */

const T = 60_000;
const ROOT = join(tmpdir(), 'gitslappin-tests');

function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const EMPTY_CONFIG = join(fresh('gitcfg-p4review'), 'empty.gitconfig');
writeFileSync(EMPTY_CONFIG, '');

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
};
delete ENV.GITSLAPPIN_TOKEN;

function git(cwd: string, args: string[], input?: Buffer | string): Buffer {
  return execFileSync('git', args, { cwd, env: ENV, input, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
function tryGit(cwd: string, args: string[], input?: Buffer | string): { status: number | null; stdout: Buffer; stderr: string } {
  const r = spawnSync('git', args, { cwd, env: ENV, input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.toString('utf8') };
}

function newRepo(name: string, config: Record<string, string> = {}): string {
  const repo = join(fresh(name), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  for (const [k, v] of Object.entries(config)) git(repo, ['config', k, v]);
  return repo;
}
const put = (repo: string, rel: string, bytes: Buffer | string): void => writeFileSync(join(repo, rel), bytes);
const indexBytes = (repo: string, p: string): Buffer => git(repo, ['show', `:${p}`]);
const nul = (paths: string[]): Buffer => Buffer.from(paths.join('\0'), 'utf8');

/** The server's re-diff (real argv), read as latin1. */
function reDiff(repo: string, source: 'unstaged' | 'staged', path: string) {
  const r = spawnSync('git', reDiffArgs(source, [path]), { cwd: repo, env: ENV, encoding: 'latin1', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  expect(r.status, r.stderr).toBe(0);
  const files = parseUnifiedDiff(r.stdout);
  expect(files).toHaveLength(1);
  return files[0]!;
}

/** buildPatch + apply --cached (real argv), like the route does. */
function applyHunk(repo: string, source: 'unstaged' | 'staged', path: string, hunk: number, selected?: number[]): void {
  const reverse = source === 'staged';
  const f = reDiff(repo, source, path);
  const patch = Buffer.from(buildPatch({ ...f, path }, hunk, selected ? new Set(selected) : undefined, reverse), 'latin1');
  const check = tryGit(repo, applyCachedArgs(reverse, true), patch);
  expect(check.status, `apply --check: ${check.stderr}\n${patch.toString('latin1')}`).toBe(0);
  const done = tryGit(repo, applyCachedArgs(reverse, false), patch);
  expect(done.status, done.stderr).toBe(0);
}

const lines40 = (f: (i: number) => string): string => Array.from({ length: 40 }, (_, i) => f(i + 1)).join('\n') + '\n';

describe('review fix 1: the stage-lines re-diff ignores diff.* user config', () => {
  it('diff.noprefix=true and diff.context=5 in the repo config: same paths and same hunks as the default diff', () => {
    const base = lines40((i) => `line ${i}`);
    const work = lines40((i) => (i === 2 ? 'line 2 CHANGED' : i === 12 ? 'line 12 CHANGED' : `line ${i}`));
    const repo = newRepo('p4r-config', { 'diff.noprefix': 'true', 'diff.context': '5', 'diff.mnemonicPrefix': 'true', 'diff.interHunkContext': '4' });
    put(repo, 'm.txt', base);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'Base']);
    put(repo, 'm.txt', work);
    const f = reDiff(repo, 'unstaged', 'm.txt');
    expect(f.path).toBe('m.txt');
    expect(f.hunks).toHaveLength(2); // -U3 and no inter-hunk context: the two edits stay separate hunks
    const before = readFileSync(join(repo, 'm.txt'));
    applyHunk(repo, 'unstaged', 'm.txt', 1);
    expect(indexBytes(repo, 'm.txt').toString()).toBe(lines40((i) => (i === 12 ? 'line 12 CHANGED' : `line ${i}`)));
    expect(readFileSync(join(repo, 'm.txt')).equals(before)).toBe(true);
  }, T);

  it('the staged re-diff is also pinned (unstage one hunk with the config set)', () => {
    const base = lines40((i) => `line ${i}`);
    const work = lines40((i) => (i === 2 ? 'line 2 CHANGED' : i === 12 ? 'line 12 CHANGED' : `line ${i}`));
    const repo = newRepo('p4r-config-staged', { 'diff.noprefix': 'true', 'diff.context': '5' });
    put(repo, 'm.txt', base);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'Base']);
    put(repo, 'm.txt', work);
    git(repo, ['add', 'm.txt']);
    expect(reDiff(repo, 'staged', 'm.txt').hunks).toHaveLength(2);
    applyHunk(repo, 'staged', 'm.txt', 0);
    expect(indexBytes(repo, 'm.txt').toString()).toBe(lines40((i) => (i === 12 ? 'line 12 CHANGED' : `line ${i}`)));
  }, T);
});

describe('review fix 2: unborn unstage uses rm --cached -f -r -q', () => {
  it('the builder keeps --cached and adds -f', () => {
    const a = unstagePathsArgs(true);
    expect(a).toContain('--cached');
    expect(a).toContain('-f');
  });

  it('a file that is Added in the index and modified again in the worktree (AM) unstages, bytes untouched', () => {
    const repo = newRepo('p4r-am', {});
    put(repo, 'am.txt', 'first\n');
    git(repo, ['add', 'am.txt']);
    put(repo, 'am.txt', 'second, differs from the index\n');
    const before = readFileSync(join(repo, 'am.txt'));
    expect(git(repo, ['status', '--porcelain']).toString()).toMatch(/^AM am\.txt/);
    expect(tryGit(repo, ['rev-parse', '--verify', 'HEAD']).status).not.toBe(0);
    const r = tryGit(repo, [...unstagePathsArgs(true)], nul(['am.txt']));
    expect(r.status, r.stderr).toBe(0);
    expect(git(repo, ['ls-files', '--cached', '-z']).toString()).toBe('');
    expect(existsSync(join(repo, 'am.txt'))).toBe(true);
    expect(readFileSync(join(repo, 'am.txt')).equals(before)).toBe(true);
  }, T);
});

describe('review fix 8: core.autocrlf=true in the repo config', () => {
  it('LF in the index, CRLF in the worktree: line staging keeps the index LF and the worktree bytes', () => {
    const repo = newRepo('p4r-crlf-lf-index', { 'core.autocrlf': 'true' });
    put(repo, 'c.txt', 'a\nb\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'Base']);
    expect(indexBytes(repo, 'c.txt').toString()).toBe('a\nb\n');
    put(repo, 'c.txt', 'a\r\nX1\r\nX2\r\nb\r\n');
    const before = readFileSync(join(repo, 'c.txt'));
    const f = reDiff(repo, 'unstaged', 'c.txt');
    const x2 = f.hunks[0]!.lines.findIndex((l) => l.kind === 'add' && l.text.replace(/\r$/, '') === 'X2');
    expect(x2).toBeGreaterThan(0);
    applyHunk(repo, 'unstaged', 'c.txt', 0, [x2]);
    expect(indexBytes(repo, 'c.txt').toString()).toBe('a\nX2\nb\n');
    expect(readFileSync(join(repo, 'c.txt')).equals(before)).toBe(true);
  }, T);

  it('CRLF already in the index: line staging keeps CRLF and the worktree bytes', () => {
    const repo = newRepo('p4r-crlf-crlf-index', {});
    put(repo, 'c.txt', 'a\r\nb\r\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'Base']);
    git(repo, ['config', 'core.autocrlf', 'true']);
    expect(indexBytes(repo, 'c.txt').toString()).toBe('a\r\nb\r\n');
    put(repo, 'c.txt', 'a\r\nX1\r\nX2\r\nb\r\n');
    const before = readFileSync(join(repo, 'c.txt'));
    const f = reDiff(repo, 'unstaged', 'c.txt');
    const x1 = f.hunks[0]!.lines.findIndex((l) => l.kind === 'add' && l.text.replace(/\r$/, '') === 'X1');
    expect(x1).toBeGreaterThan(0);
    applyHunk(repo, 'unstaged', 'c.txt', 0, [x1]);
    expect(indexBytes(repo, 'c.txt').toString()).toBe('a\r\nX1\r\nb\r\n');
    expect(readFileSync(join(repo, 'c.txt')).equals(before)).toBe(true);
  }, T);
});
