import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, type FileDiff } from '../../../shared/src/diff';
import { buildPatch } from '../../../shared/src/patch';

/*
 * Integration tests with REAL git, in fresh mkdtemp folders under os.tmpdir()/gitslappin-tests.
 * Nothing is ever deleted. They check the exact git command forms the phase-4 design uses
 * (stage/unstage via NUL-separated stdin with literal pathspecs, buildPatch + apply --cached,
 * commit -F -) and that the working-tree bytes never change.
 */

const T = 60_000;
const ROOT = join(tmpdir(), 'gitslappin-tests');

function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

// An empty global config and no system config: the developer's own git settings must not leak in.
const EMPTY_CONFIG = join(fresh('gitcfg'), 'empty.gitconfig');
writeFileSync(EMPTY_CONFIG, '');

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
  GIT_LITERAL_PATHSPECS: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
};
delete ENV.GITSLAPPIN_TOKEN;

type Bytes = Buffer | string;

function git(cwd: string, args: string[], input?: Bytes): Buffer {
  return execFileSync('git', args, { cwd, env: ENV, input, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

function tryGit(cwd: string, args: string[], input?: Bytes): { status: number | null; stdout: Buffer; stderr: string } {
  const r = spawnSync('git', args, { cwd, env: ENV, input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.toString('utf8') };
}

function write(repo: string, files: Record<string, Bytes>): void {
  for (const [p, c] of Object.entries(files)) {
    const full = join(repo, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, c);
  }
}

/** Fresh repo. `base` files are committed (when given), `work` files are then written on top. */
function makeRepo(name: string, base: Record<string, Bytes> | null, work: Record<string, Bytes> = {}): string {
  const repo = join(fresh(name), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  if (base) {
    write(repo, base);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'Base']);
  }
  write(repo, work);
  return repo;
}

const asBuf = (b: Bytes): Buffer => (typeof b === 'string' ? Buffer.from(b, 'utf8') : b);
const head = (repo: string): string => tryGit(repo, ['rev-parse', '--verify', 'HEAD']).stdout.toString().trim();
const names = (repo: string, args: string[]): string[] => git(repo, args).toString('utf8').split('\0').filter(Boolean);
const cachedNames = (repo: string): string[] => names(repo, ['ls-files', '--cached', '-z']);
const indexBytes = (repo: string, path: string): Buffer => git(repo, ['show', `:${path}`]);
const porcelain = (repo: string): string => git(repo, ['status', '--porcelain', '--untracked-files=all']).toString('utf8');

/** Records the working-tree bytes of the given files; `check()` asserts they are unchanged. */
function snapshot(repo: string, paths: string[]): () => void {
  const before = paths.map((p) => readFileSync(join(repo, p)));
  return () => {
    paths.forEach((p, i) => {
      expect(existsSync(join(repo, p)), `${p} still exists`).toBe(true);
      expect(readFileSync(join(repo, p)).equals(before[i]!), `${p} bytes unchanged`).toBe(true);
    });
  };
}

// The exact command forms from the design (global literal pathspecs come from GIT_LITERAL_PATHSPECS in ENV).
const nul = (paths: string[]): Buffer => Buffer.from(paths.join('\0'), 'utf8');
const PSF = ['--pathspec-from-file=-', '--pathspec-file-nul'];
const stagePaths = (repo: string, paths: string[]) => tryGit(repo, ['add', ...PSF], nul(paths));
const unstagePaths = (repo: string, paths: string[]) =>
  head(repo) ? tryGit(repo, ['restore', '--staged', ...PSF], nul(paths)) : tryGit(repo, ['rm', '--cached', '-r', '-q', ...PSF], nul(paths));

type Source = 'unstaged' | 'staged' | 'untracked';

/** Re-diffs like the server does: raw bytes read as latin1 so they stay exact. */
function fileDiff(repo: string, source: Source, path: string): FileDiff {
  const common = ['diff', '-p', '--no-color', '--no-ext-diff', '--no-textconv'];
  const args =
    source === 'unstaged'
      ? [...common, '--', path]
      : source === 'staged'
        ? [...common, '--cached', '--', path]
        : [...common, '--no-index', '--', '/dev/null', path];
  const r = spawnSync('git', args, { cwd: repo, env: ENV, encoding: 'latin1', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  expect(r.status === 0 || (source === 'untracked' && r.status === 1), `diff exit ${r.status}: ${r.stderr}`).toBe(true);
  const files = parseUnifiedDiff(r.stdout);
  expect(files).toHaveLength(1);
  return files[0]!;
}

/** buildPatch, `apply --cached --check`, then apply. The patch goes in as latin1 bytes. */
function applyLines(repo: string, source: Source, path: string, hunk: number, selected: number[] | undefined, reverse: boolean): void {
  const f = fileDiff(repo, source, path);
  const patch = Buffer.from(buildPatch(f, hunk, selected ? new Set(selected) : undefined, reverse), 'latin1');
  const flags = ['apply', '--cached', ...(reverse ? ['-R'] : []), '--whitespace=nowarn'];
  const check = tryGit(repo, [...flags, '--check', '-'], patch);
  expect(check.status, `apply --check: ${check.stderr}\n${patch.toString('latin1')}`).toBe(0);
  const done = tryGit(repo, [...flags, '-'], patch);
  expect(done.status, `apply: ${done.stderr}`).toBe(0);
}

const lines40 = (f: (i: number) => string): string => Array.from({ length: 40 }, (_, i) => f(i + 1)).join('\n') + '\n';

describe('stage lines with real git (index bytes exact, working tree untouched)', () => {
  it('stages one of two added lines', () => {
    const repo = makeRepo('int-add', { 'a.txt': 'a\nb\n' }, { 'a.txt': 'a\nX1\nX2\nb\n' });
    const ok = snapshot(repo, ['a.txt']);
    applyLines(repo, 'unstaged', 'a.txt', 0, [1], false);
    expect(indexBytes(repo, 'a.txt').equals(Buffer.from('a\nX1\nb\n'))).toBe(true);
    ok();
  }, T);

  it('stages only the removed line of a modification', () => {
    const repo = makeRepo('int-del', { 'a.txt': 'a\nold\nc\n' }, { 'a.txt': 'a\nnew\nc\n' });
    const ok = snapshot(repo, ['a.txt']);
    applyLines(repo, 'unstaged', 'a.txt', 0, [1], false);
    expect(indexBytes(repo, 'a.txt').equals(Buffer.from('a\nc\n'))).toBe(true);
    ok();
  }, T);

  it('stages only the second hunk of a file', () => {
    const base = lines40((i) => `line ${i}`);
    const work = lines40((i) => (i === 2 ? 'line 2 CHANGED' : i === 38 ? 'line 38 CHANGED' : `line ${i}`));
    const repo = makeRepo('int-hunk', { 'm.txt': base }, { 'm.txt': work });
    const ok = snapshot(repo, ['m.txt']);
    expect(fileDiff(repo, 'unstaged', 'm.txt').hunks).toHaveLength(2);
    applyLines(repo, 'unstaged', 'm.txt', 1, undefined, false);
    expect(indexBytes(repo, 'm.txt').toString()).toBe(lines40((i) => (i === 38 ? 'line 38 CHANGED' : `line ${i}`)));
    ok();
  }, T);

  it('unstages a single line of a fully staged change', () => {
    const repo = makeRepo('int-unstage-line', { 'a.txt': 'a\nb\n' }, { 'a.txt': 'a\nX1\nX2\nb\n' });
    git(repo, ['add', 'a.txt']);
    const ok = snapshot(repo, ['a.txt']);
    applyLines(repo, 'staged', 'a.txt', 0, [1], true);
    expect(indexBytes(repo, 'a.txt').equals(Buffer.from('a\nX2\nb\n'))).toBe(true);
    ok();
  }, T);

  it('keeps CRLF line endings exact', () => {
    const repo = makeRepo('int-crlf', { 'c.txt': 'a\r\nb\r\n' }, { 'c.txt': 'a\r\nX1\r\nX2\r\nb\r\n' });
    const ok = snapshot(repo, ['c.txt']);
    applyLines(repo, 'unstaged', 'c.txt', 0, [2], false);
    expect(indexBytes(repo, 'c.txt').equals(Buffer.from('a\r\nX2\r\nb\r\n'))).toBe(true);
    ok();
  }, T);

  it('handles a file with no newline at the end', () => {
    const repo = makeRepo('int-noeol', { 'e.txt': 'a\n' }, { 'e.txt': 'a\nb' });
    const ok = snapshot(repo, ['e.txt']);
    applyLines(repo, 'unstaged', 'e.txt', 0, undefined, false);
    expect(indexBytes(repo, 'e.txt').equals(Buffer.from('a\nb'))).toBe(true);
    ok();
  }, T);

  it('stages only the new line when the old last line had no newline (middle no-EOL context)', () => {
    const repo = makeRepo('int-noeol-mid', { 'e.txt': 'a\nb' }, { 'e.txt': 'a\nb\nc\n' });
    const ok = snapshot(repo, ['e.txt']);
    const f = fileDiff(repo, 'unstaged', 'e.txt');
    const cIdx = f.hunks[0]!.lines.findIndex((l) => l.kind === 'add' && l.text === 'c');
    expect(cIdx).toBeGreaterThan(0);
    applyLines(repo, 'unstaged', 'e.txt', 0, [cIdx], false);
    expect(indexBytes(repo, 'e.txt').equals(Buffer.from('a\nb\nc\n'))).toBe(true);
    ok();
  }, T);

  it('keeps non-UTF-8 bytes exact (latin1 round trip)', () => {
    const repo = makeRepo(
      'int-latin1',
      { 'l.txt': Buffer.from([0x61, 0x0a, 0xe9, 0x0a, 0x7a, 0x0a]) },
      { 'l.txt': Buffer.from([0x61, 0x0a, 0x58, 0x31, 0x0a, 0x58, 0x32, 0x0a, 0xe8, 0x0a, 0x7a, 0x0a]) },
    );
    const ok = snapshot(repo, ['l.txt']);
    const f = fileDiff(repo, 'unstaged', 'l.txt');
    const x1 = f.hunks[0]!.lines.findIndex((l) => l.kind === 'add' && l.text === 'X1');
    applyLines(repo, 'unstaged', 'l.txt', 0, [x1], false);
    // git's hunk is: a, -é, +X1, +X2, +è, z. Only X1 is staged: the removed 0xE9 line stays as context
    // (so it comes before X1), X2 and the 0xE8 line are not staged.
    expect(indexBytes(repo, 'l.txt').equals(Buffer.from([0x61, 0x0a, 0xe9, 0x0a, 0x58, 0x31, 0x0a, 0x7a, 0x0a]))).toBe(true);
    ok();
  }, T);

  it('partially stages a file with a non-ASCII name', () => {
    const repo = makeRepo('int-unicode', { 'ünï.txt': 'a\nb\n' }, { 'ünï.txt': 'a\nX1\nX2\nb\n' });
    const ok = snapshot(repo, ['ünï.txt']);
    applyLines(repo, 'unstaged', 'ünï.txt', 0, [2], false);
    expect(indexBytes(repo, 'ünï.txt').equals(Buffer.from('a\nX2\nb\n'))).toBe(true);
    ok();
  }, T);

  it('partially stages an untracked file (new file)', () => {
    const repo = makeRepo('int-untracked', { 'base.txt': 'x\n' }, { 'u.txt': 'l1\nl2\nl3\n' });
    const ok = snapshot(repo, ['u.txt', 'base.txt']);
    applyLines(repo, 'untracked', 'u.txt', 0, [0, 2], false);
    expect(indexBytes(repo, 'u.txt').equals(Buffer.from('l1\nl3\n'))).toBe(true);
    ok();
  }, T);

  it('partially stages and unstages lines on an unborn HEAD', () => {
    const repo = makeRepo('int-unborn-lines', null, { 'u.txt': 'l1\nl2\nl3\n' });
    expect(head(repo)).toBe('');
    const ok = snapshot(repo, ['u.txt']);
    applyLines(repo, 'untracked', 'u.txt', 0, [0, 2], false);
    expect(indexBytes(repo, 'u.txt').equals(Buffer.from('l1\nl3\n'))).toBe(true);
    ok();
    git(repo, ['add', 'u.txt']);
    applyLines(repo, 'staged', 'u.txt', 0, [1], true);
    expect(indexBytes(repo, 'u.txt').equals(Buffer.from('l1\nl3\n'))).toBe(true);
    ok();
  }, T);
});

describe('stage and unstage paths with real git', () => {
  it('stages by path via stdin and leaves the working tree alone', () => {
    const repo = makeRepo('int-stage', { 'a.txt': 'a\n' }, { 'a.txt': 'a2\n', 'new.txt': 'n\n', 'sub/deep.txt': 'd\r\n' });
    const ok = snapshot(repo, ['a.txt', 'new.txt', 'sub/deep.txt']);
    const r = stagePaths(repo, ['a.txt', 'sub/deep.txt']);
    expect(r.status, r.stderr).toBe(0);
    expect(cachedNames(repo).sort()).toEqual(['a.txt', 'sub/deep.txt']);
    ok();
  }, T);

  it('a path is literal: brackets do not match other files', () => {
    const repo = makeRepo('int-literal', { 'keep.txt': 'k\n' }, { 'a.txt': 'a\n', '[ab].txt': 'br\n' });
    const ok = snapshot(repo, ['a.txt', '[ab].txt']);
    const r = stagePaths(repo, ['[ab].txt']);
    expect(r.status, r.stderr).toBe(0);
    expect(cachedNames(repo).sort()).toEqual(['[ab].txt', 'keep.txt']);
    expect(unstagePaths(repo, ['[ab].txt']).status).toBe(0);
    expect(cachedNames(repo)).toEqual(['keep.txt']);
    ok();
  }, T);

  it('a glob character path matches nothing and stages nothing', () => {
    const repo = makeRepo('int-glob', { 'keep.txt': 'k\n' }, { 'starX.txt': 'x\n', 'starY.txt': 'y\n' });
    const r = stagePaths(repo, ['star*.txt']);
    expect(r.status).not.toBe(0);
    expect(cachedNames(repo)).toEqual(['keep.txt']);
  }, T);

  it('unstages by path and keeps the working-tree bytes', () => {
    const repo = makeRepo('int-unstage', { 'a.txt': 'a\n' }, { 'a.txt': 'a2\r\n', 'new.txt': 'n\n' });
    git(repo, ['add', '-A']);
    const ok = snapshot(repo, ['a.txt', 'new.txt']);
    const r = unstagePaths(repo, ['a.txt', 'new.txt']);
    expect(r.status, r.stderr).toBe(0);
    expect(indexBytes(repo, 'a.txt').equals(Buffer.from('a\n'))).toBe(true);
    expect(cachedNames(repo)).toEqual(['a.txt']);
    ok();
  }, T);

  it('unborn HEAD: stage then unstage by path, working tree untouched', () => {
    const repo = makeRepo('int-unborn-paths', null, { 'first.txt': 'f\n', 'sub/second.txt': 's\r\n' });
    expect(head(repo)).toBe('');
    const ok = snapshot(repo, ['first.txt', 'sub/second.txt']);
    const s = stagePaths(repo, ['first.txt', 'sub/second.txt']);
    expect(s.status, s.stderr).toBe(0);
    expect(cachedNames(repo).sort()).toEqual(['first.txt', 'sub/second.txt']);
    ok();
    const u1 = unstagePaths(repo, ['first.txt']);
    expect(u1.status, u1.stderr).toBe(0);
    expect(cachedNames(repo)).toEqual(['sub/second.txt']);
    ok();
    const u2 = unstagePaths(repo, ['sub/second.txt']);
    expect(u2.status, u2.stderr).toBe(0);
    expect(cachedNames(repo)).toEqual([]);
    ok();
  }, T);

  it('unstaging a renamed file with both paths leaves a deletion and an untracked file, nothing staged', () => {
    const repo = makeRepo('int-rename', { 'old.txt': 'one\ntwo\nthree\n' });
    git(repo, ['mv', 'old.txt', 'new.txt']);
    expect(porcelain(repo)).toMatch(/^R {2}old\.txt -> new\.txt/);
    const ok = snapshot(repo, ['new.txt']);
    const r = unstagePaths(repo, ['old.txt', 'new.txt']);
    expect(r.status, r.stderr).toBe(0);
    expect(porcelain(repo)).toBe(' D old.txt\n?? new.txt\n');
    expect(cachedNames(repo)).toEqual(['old.txt']);
    expect(existsSync(join(repo, 'old.txt'))).toBe(false);
    ok();
  }, T);

  it('unstaging only the new path of a rename would leave the old path staged as a deletion (why both are passed)', () => {
    const repo = makeRepo('int-rename-half', { 'old.txt': 'one\ntwo\nthree\n' });
    git(repo, ['mv', 'old.txt', 'new.txt']);
    const r = unstagePaths(repo, ['new.txt']);
    expect(r.status, r.stderr).toBe(0);
    expect(porcelain(repo)).toBe('D  old.txt\n?? new.txt\n');
  }, T);
});

describe('commit with real git', () => {
  const HOOK = (repo: string, body: string) => {
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), body, { mode: 0o755 });
  };

  it('commit -F - keeps a multi-line message exactly, and --amend replaces HEAD', () => {
    const repo = makeRepo('int-commit', { 'a.txt': 'a\n' }, { 'a.txt': 'a2\n' });
    git(repo, ['add', 'a.txt']);
    const before = head(repo);
    const ok = snapshot(repo, ['a.txt']);
    const c = tryGit(repo, ['commit', '-F', '-'], 'Subject line\n\nBody line 1\nBody line 2\n');
    expect(c.status, c.stderr).toBe(0);
    expect(git(repo, ['log', '-1', '--format=%B']).toString().trim()).toBe('Subject line\n\nBody line 1\nBody line 2');
    expect(git(repo, ['rev-list', '--count', 'HEAD']).toString().trim()).toBe('2');
    const a = tryGit(repo, ['commit', '--amend', '-F', '-'], 'Amended subject\n');
    expect(a.status, a.stderr).toBe(0);
    expect(git(repo, ['log', '-1', '--format=%s']).toString().trim()).toBe('Amended subject');
    expect(git(repo, ['rev-list', '--count', 'HEAD']).toString().trim()).toBe('2');
    expect(head(repo)).not.toBe(before);
    ok();
  }, T);

  it('the first commit in an unborn repo works', () => {
    const repo = makeRepo('int-first', null, { 'first.txt': 'f\n' });
    expect(head(repo)).toBe('');
    expect(stagePaths(repo, ['first.txt']).status).toBe(0);
    const c = tryGit(repo, ['commit', '-F', '-'], 'First commit\n');
    expect(c.status, c.stderr).toBe(0);
    expect(git(repo, ['log', '-1', '--format=%s']).toString().trim()).toBe('First commit');
  }, T);

  it('a failing pre-commit hook (just exit 1) fails the commit and changes nothing', () => {
    const repo = makeRepo('int-hook', { 'a.txt': 'a\n' }, { 'a.txt': 'a2\n' });
    git(repo, ['add', 'a.txt']);
    HOOK(repo, '#!/bin/sh\nexit 1\n');
    const before = head(repo);
    const ok = snapshot(repo, ['a.txt']);
    const c = tryGit(repo, ['commit', '-F', '-'], 'Should not land\n');
    expect(c.status).not.toBe(0);
    expect(head(repo)).toBe(before);
    expect(cachedNames(repo)).toEqual(['a.txt']);
    expect(indexBytes(repo, 'a.txt').equals(Buffer.from('a2\n'))).toBe(true);
    ok();
  }, T);
});
