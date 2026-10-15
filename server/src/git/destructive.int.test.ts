import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createTag, deleteBranch, discardFiles, discardHunk, forcePush, renameBranch, resetNeedsConfirm, resetTo } from './destructive';
import { cherryPick, cherryPickAbort, revert, revertAbort } from './integrate';
import { readOpState } from './opState';
import { pushRemote } from './remote';
import { undo, undoState } from './undo';

vi.setConfig({ testTimeout: 90_000 });

/*
 * Contract the builder must export (every function takes the repo ROOT, runs through runExclusive + the runner, never throws for a
 * git failure, and returns a result). Real git in mkdtemp folders under os.tmpdir()/gitslappin-tests; remotes are file:// inside it.
 *
 *   server/src/git/destructive.ts
 *     discardFiles(root, paths: string[]): Promise<DResult>
 *     discardHunk(root, { path: string; hunk: number /* 0-based index in `git diff -- path` (unstaged) *\/; header: string /* the whole "@@ -a,b +c,d @@" line *\/ }): Promise<DResult>
 *     resetTo(root, { sha: string; mode: 'soft' | 'mixed' | 'hard' }): Promise<DResult>
 *     renameBranch(root, { name: string; newName: string }): Promise<DResult>
 *     deleteBranch(root, { name: string; expectSha: string; force?: boolean; remote?: boolean }): Promise<DResult>
 *         remote: true = "Delete {0} and {1}": the remote and remote branch come ONLY from the branch's configured upstream
 *     forcePush(root, { branch: string; expect: string }): Promise<DResult>     (remote + remote branch from the upstream only)
 *     createTag(root, { name: string; sha: string; message?: string }): Promise<DResult>
 *   server/src/git/integrate.ts (added)
 *     cherryPick(root, sha), revert(root, sha), cherryPickAbort(root), revertAbort(root): Promise<DResult>
 *   server/src/git/remote.ts: pushRemote's 'rejected' result also carries expect (the local refs/remotes/<r>/<rb> sha at that moment).
 *   server/src/git/undo.ts: discard / reset / delete-branch entries are recorded INSIDE those functions (not by the test).
 *     Labels: "discard changes", "reset 'main'", "delete branch 'x'".
 *   DResult = { outcome: 'done' | 'conflict' | 'noop' | 'unmerged' | 'rejected' | 'refused' | 'failed' | 'blocked';
 *               error?: string; stderr?: string; stash?: { message: string; sha?: string }; expect?: string }
 *     refused  = input validation or a precondition failed, git never changed anything (route 4xx)
 *     failed   = git ran and failed (or a snapshot step failed: fail closed, nothing changed)
 *     blocked  = an operation is in progress or something is unmerged (route 409)
 *     unmerged = deleteBranch without force: git says not fully merged (route 409 {unmerged, stderr})
 *     noop     = cherry-pick/revert produced no change; it was skipped (no CHERRY_PICK_HEAD / REVERT_HEAD left)
 *
 * UNVERIFIED (inferred, flagged to the conductor): exact refusal outcome where a test accepts ['refused','failed'];
 * a cherry-pick/revert auto-stash is kept after a CLEAN success (taken from phase 6's "never popped"); header text of a hunk is git's
 * default 3-line-context diff; reset 'mixed'/'hard' take no confirm at the function level.
 * Nothing in this file deletes anything outside its own throwaway repos (the one gc runs inside a throwaway repo).
 */

const ROOT = resolve(join(tmpdir(), 'gitslappin-tests'));
const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const underRoot = (p: string): boolean => norm(p).startsWith(norm(ROOT) + (process.platform === 'win32' ? '\\' : sep));

function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!underRoot(dir) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const CFG_DIR = fresh('gitcfg-destructive-int');
const EMPTY_GLOBAL = join(CFG_DIR, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL, '');
const ASKPASS = join(CFG_DIR, process.platform === 'win32' ? 'fail-askpass.cmd' : 'fail-askpass.sh');
writeFileSync(ASKPASS, process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });

// The code under test inherits this environment (the runner must pass these through).
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
  GIT_ASKPASS: ASKPASS,
  SSH_ASKPASS: ASKPASS,
  GCM_INTERACTIVE: 'never',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
});
delete process.env.GITSLAPPIN_TOKEN;
delete process.env.GIT_SSH;
delete process.env.GIT_SSH_COMMAND;

const envFor = (who?: string): NodeJS.ProcessEnv =>
  who ? { ...process.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who.toLowerCase().replace(/ /g, '.')}@example.com` } : process.env;
const git = (cwd: string, args: string[], who?: string): string =>
  execFileSync('git', args, { cwd, env: envFor(who), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const head = (repo: string): string => git(repo, ['rev-parse', 'HEAD']).trim();
const refSha = (repo: string, ref: string): string | null => {
  const r = tryGit(repo, ['rev-parse', '--verify', '-q', ref]);
  return r.status === 0 ? r.stdout.trim() : null;
};
const text = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8');
const stashLines = (repo: string): string[] => git(repo, ['stash', 'list', '--format=%gs']).split('\n').filter(Boolean);
const subjects = (repo: string): string[] => git(repo, ['log', '--format=%s']).split('\n').filter(Boolean);
const cfg = (repo: string, key: string): string | undefined => {
  const r = tryGit(repo, ['config', '--local', '--get', key]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const marker = (repo: string, name: string): boolean => existsSync(join(repo, '.git', name));
const pinned = (repo: string): string => git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/gitslappin/undo/']).trim();
/** Content of every blob that is pinned under refs/gitslappin/undo/ (what an undo can restore from). */
function pinnedBlobs(repo: string): string[] {
  const out: string[] = [];
  for (const line of git(repo, ['for-each-ref', '--format=%(objectname) %(objecttype)', 'refs/gitslappin/undo/']).split('\n').filter(Boolean)) {
    const [sha, type] = line.split(' ');
    if (type === 'blob') out.push(git(repo, ['cat-file', 'blob', sha!]));
  }
  return out;
}

function write(repo: string, files: Record<string, string>): void {
  for (const [rel, t] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, t);
  }
}
function commit(repo: string, files: Record<string, string>, msg: string, who?: string): string {
  write(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', msg], who);
  return head(repo);
}
function newRepo(prefix: string): string {
  const repo = join(fresh(prefix), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  configure(repo);
  return repo;
}
function configure(repo: string): void {
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'author@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'core.editor', 'false']); // an editor started by mistake fails instead of hanging
  git(repo, ['config', 'gc.auto', '0']);
  git(repo, ['config', 'protocol.allow', 'never']);
  git(repo, ['config', 'protocol.file.allow', 'always']);
}

const GIT_DIR_RE = /(^|[\\/])\.git([\\/]|$)/;
function files(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of readdirSync(repo, { recursive: true }) as string[]) {
    if (GIT_DIR_RE.test(rel)) continue;
    const full = join(repo, rel);
    const st = lstatSync(full);
    const key = rel.replace(/\\/g, '/');
    if (st.isSymbolicLink()) out[key] = `link:${readlinkSync(full)}`;
    else if (st.isFile()) out[key] = readFileSync(full).toString('base64');
  }
  return out;
}
/** Everything a refusal must leave alone, minus refs (see snap). */
function state(repo: string): { head: string | null; branch: string; index: string; status: string; files: Record<string, string> } {
  return {
    head: refSha(repo, 'HEAD'),
    branch: git(repo, ['branch', '--show-current']).trim(),
    index: git(repo, ['ls-files', '-s']),
    status: git(repo, ['status', '--porcelain=v1', '-uall', '--ignored']),
    files: files(repo),
  };
}
/** state + refs + stash list. pins=false leaves refs/gitslappin/* out (for operations that may legitimately have pinned before failing closed). */
function snap(repo: string, pins = true): ReturnType<typeof state> & { refs: string; stashes: string[] } {
  const refs = pins
    ? git(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])
    : git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes', 'refs/stash']);
  return { ...state(repo), refs, stashes: stashLines(repo) };
}

type R = { outcome: string; error?: string; stderr?: string; stash?: { message: string; sha?: string }; expect?: string };
/** The call must answer one of `allowed` and change nothing at all. Proves the code path ran (an outcome came back) and the repo is byte for byte the same. */
async function refusal(repo: string, call: () => Promise<R>, allowed: string[] = ['refused'], pins = true): Promise<R> {
  const before = snap(repo, pins);
  const r = await call();
  expect(allowed).toContain(r.outcome);
  expect(snap(repo, pins)).toEqual(before);
  return r;
}

/** Makes `update-ref refs/gitslappin/undo/<blob of bytes>` fail: its lock file already exists. */
function lockPin(repo: string, bytes: string | Buffer): void {
  const sha = execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { cwd: repo, env: process.env, input: bytes, encoding: 'utf8', windowsHide: true }).trim();
  mkdirSync(join(repo, '.git', 'refs', 'gitslappin', 'undo'), { recursive: true });
  writeFileSync(join(repo, '.git', 'refs', 'gitslappin', 'undo', `${sha}.lock`), '');
}

function baseRepo(): { repo: string; c1: string } {
  const repo = newRepo('destr-int');
  const c1 = commit(repo, { 'a.txt': 'a1\na2\n', 'b.txt': 'b1\n', 'dir/c.txt': 'c1\n', '.gitignore': '*.log\n' }, 'Base');
  return { repo, c1 };
}

// ---------------------------------------------------------------------------------------------------------------------
describe('settles the open questions about git itself', () => {
  it('update-ref accepts a BLOB target under refs/gitslappin/undo/, and the pinned blob survives reflog expire + gc --prune=now', () => {
    const { repo } = baseRepo();
    write(repo, { 'precious.bin': 'only copy\r\nof my bytes\n' });
    const sha = git(repo, ['hash-object', '-w', '--no-filters', 'precious.bin']).trim();
    expect(tryGit(repo, ['update-ref', `refs/gitslappin/undo/${sha}`, sha]).status).toBe(0);
    expect(git(repo, ['cat-file', '-t', `refs/gitslappin/undo/${sha}`]).trim()).toBe('blob');
    expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/gitslappin/undo/']).trim()).toBe(`refs/gitslappin/undo/${sha}`);
    git(repo, ['reflog', 'expire', '--expire=now', '--all']);
    git(repo, ['gc', '--prune=now', '-q']); // inside this throwaway repo only
    expect(tryGit(repo, ['cat-file', '-e', sha]).status).toBe(0);
    expect(git(repo, ['cat-file', 'blob', sha])).toBe('only copy\r\nof my bytes\n');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('discardFiles', () => {
  it('round trip: tracked (staged + unstaged) and untracked files are discarded, ignored files stay, bytes are pinned, undo restores index and bytes', async () => {
    const { repo } = baseRepo();
    write(repo, { 'a.txt': 'a staged\n' });
    git(repo, ['add', 'a.txt']);
    write(repo, { 'a.txt': 'a staged\na unstaged\n', 'u.txt': 'untracked bytes\n', 'x.log': 'ignored\n' });
    const before = state(repo);
    const r = await discardFiles(repo, ['a.txt', 'u.txt']);
    expect(r.outcome).toBe('done');
    expect(text(repo, 'a.txt')).toBe('a1\na2\n');
    expect(existsSync(join(repo, 'u.txt'))).toBe(false);
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(text(repo, 'x.log')).toBe('ignored\n');
    const blobs = pinnedBlobs(repo);
    expect(blobs).toContain('untracked bytes\n');
    expect(blobs).toContain('a staged\na unstaged\n'); // raw worktree bytes of the tracked file
    expect(undoState(repo).undo).toEqual({ label: 'discard changes' });
    expect((await undo(repo)).outcome).toBe('done');
    expect(state(repo)).toEqual(before);
  });

  it('raw bytes survive: a CRLF edit on a tracked file with core.autocrlf=true comes back byte for byte', async () => {
    const { repo } = baseRepo();
    git(repo, ['config', 'core.autocrlf', 'true']);
    write(repo, { 'a.txt': 'edited\r\nwith crlf\r\n' });
    const before = files(repo);
    expect((await discardFiles(repo, ['a.txt'])).outcome).toBe('done');
    expect(pinnedBlobs(repo)).toContain('edited\r\nwith crlf\r\n');
    expect((await undo(repo)).outcome).toBe('done');
    expect(files(repo)).toEqual(before);
  });

  it('snapshots fail closed: when the pin of an untracked file cannot be written nothing is discarded (and the same call works without the fault)', async () => {
    const faulty = baseRepo().repo;
    write(faulty, { 'u.txt': 'precious untracked\n' });
    lockPin(faulty, 'precious untracked\n');
    const r = await refusal(faulty, () => discardFiles(faulty, ['u.txt']), ['failed', 'refused'], false);
    expect(r.outcome).not.toBe('done');
    expect(text(faulty, 'u.txt')).toBe('precious untracked\n');
    expect(undoState(faulty).undo).toBeNull();

    const healthy = baseRepo().repo; // control: proves the code path itself works
    write(healthy, { 'u.txt': 'precious untracked\n' });
    expect((await discardFiles(healthy, ['u.txt'])).outcome).toBe('done');
    expect(existsSync(join(healthy, 'u.txt'))).toBe(false);
  });

  it('snapshots fail closed for a TRACKED file too: its raw worktree bytes must be pinned first', async () => {
    const { repo } = baseRepo();
    write(repo, { 'a.txt': 'edited raw bytes\n' });
    lockPin(repo, 'edited raw bytes\n');
    const r = await refusal(repo, () => discardFiles(repo, ['a.txt']), ['failed', 'refused'], false);
    expect(r.outcome).not.toBe('done');
    expect(text(repo, 'a.txt')).toBe('edited raw bytes\n');
  });

  it('an index-mode change is discarded and undone (HEAD mode 100755, index 100644 + content edit)', async () => {
    const { repo } = baseRepo();
    write(repo, { 'run.sh': '#!/bin/sh\necho 1\n' });
    git(repo, ['add', 'run.sh']);
    git(repo, ['update-index', '--chmod=+x', 'run.sh']);
    git(repo, ['commit', '-m', 'Add run.sh']);
    write(repo, { 'run.sh': '#!/bin/sh\necho 2\n' });
    git(repo, ['update-index', '--chmod=-x', 'run.sh']);
    git(repo, ['add', 'run.sh']);
    expect(git(repo, ['ls-files', '-s', 'run.sh']).startsWith('100644')).toBe(true);
    const before = state(repo);
    expect((await discardFiles(repo, ['run.sh'])).outcome).toBe('done');
    expect(git(repo, ['ls-files', '-s', 'run.sh']).startsWith('100755')).toBe(true);
    expect(text(repo, 'run.sh')).toBe('#!/bin/sh\necho 1\n');
    expect((await undo(repo)).outcome).toBe('done');
    expect(git(repo, ['ls-files', '-s', 'run.sh']).startsWith('100644')).toBe(true);
    expect(state(repo)).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')('the exec bit of an untracked file is restored by undo (POSIX only: NTFS has no exec bit)', async () => {
    const { repo } = baseRepo();
    write(repo, { 'tool.sh': '#!/bin/sh\necho hi\n' });
    chmodSync(join(repo, 'tool.sh'), 0o755);
    expect((await discardFiles(repo, ['tool.sh'])).outcome).toBe('done');
    expect(existsSync(join(repo, 'tool.sh'))).toBe(false);
    expect((await undo(repo)).outcome).toBe('done');
    expect(lstatSync(join(repo, 'tool.sh')).mode & 0o111).not.toBe(0);
    expect(text(repo, 'tool.sh')).toBe('#!/bin/sh\necho hi\n');
  });

  it('a symlink is never followed: its target text is stored (not the pointed-to file), and undo recreates the symlink', async (ctx) => {
    const { repo } = baseRepo();
    const secret = join(fresh('destr-outside'), 'secret.txt');
    writeFileSync(secret, 'TOP SECRET CONTENT\n');
    try {
      symlinkSync(secret, join(repo, 'link'));
    } catch {
      ctx.skip(); // symlinks need a privilege on this machine; skipped is reported as skipped, not passed
      return;
    }
    const target = readlinkSync(join(repo, 'link'));
    expect((await discardFiles(repo, ['link'])).outcome).toBe('done');
    expect(() => lstatSync(join(repo, 'link'))).toThrow();
    const blobs = pinnedBlobs(repo);
    expect(blobs.some((b) => b.includes('TOP SECRET CONTENT'))).toBe(false);
    expect(blobs.some((b) => b.includes(target))).toBe(true);
    expect((await undo(repo)).outcome).toBe('done');
    expect(lstatSync(join(repo, 'link')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(repo, 'link'))).toBe(target);
    expect(readFileSync(secret, 'utf8')).toBe('TOP SECRET CONTENT\n');
  });

  it('an index-added file (not in HEAD) is removed from index and disk, snapshotted, and undo puts both back', async () => {
    const { repo } = baseRepo();
    write(repo, { 'new.txt': 'added v1\n' });
    git(repo, ['add', 'new.txt']);
    write(repo, { 'new.txt': 'added v1\nplus an unstaged line\n' });
    const before = state(repo);
    expect((await discardFiles(repo, ['new.txt'])).outcome).toBe('done');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
    expect(git(repo, ['ls-files', '--', 'new.txt']).trim()).toBe('');
    expect(pinnedBlobs(repo)).toContain('added v1\nplus an unstaged line\n');
    expect((await undo(repo)).outcome).toBe('done');
    expect(state(repo)).toEqual(before);
  });

  it('a rename is discarded as a pair, even when only the new path is listed; undo restores the rename', async () => {
    const { repo } = baseRepo();
    git(repo, ['mv', 'b.txt', 'b2.txt']);
    write(repo, { 'b2.txt': 'b1\nedited after rename\n' });
    expect(git(repo, ['status', '--porcelain=v1']).includes('b.txt -> b2.txt')).toBe(true);
    const before = state(repo);
    expect((await discardFiles(repo, ['b2.txt'])).outcome).toBe('done');
    expect(text(repo, 'b.txt')).toBe('b1\n');
    expect(existsSync(join(repo, 'b2.txt'))).toBe(false);
    expect(git(repo, ['status', '--porcelain=v1']).trim()).toBe('');
    expect((await undo(repo)).outcome).toBe('done');
    expect(state(repo)).toEqual(before);
  });

  it('listing both paths of a rename gives the same result', async () => {
    const { repo } = baseRepo();
    git(repo, ['mv', 'b.txt', 'b2.txt']);
    expect((await discardFiles(repo, ['b.txt', 'b2.txt'])).outcome).toBe('done');
    expect(text(repo, 'b.txt')).toBe('b1\n');
    expect(existsSync(join(repo, 'b2.txt'))).toBe(false);
    expect(git(repo, ['status', '--porcelain=v1']).trim()).toBe('');
  });

  it('clean never touches unlisted, ignored or glob-named files: only the literally listed path goes', async () => {
    const repo = newRepo('destr-clean');
    commit(repo, { 'base.txt': 'base\n', '.gitignore': '*.log\n' }, 'Base');
    write(repo, { 'a.txt': 'A\n', 'b.txt': 'B\n', '[ab].txt': 'AB\n', 'unlisted.txt': 'U\n', 'x.log': 'ignored\n' });
    const r = await discardFiles(repo, ['[ab].txt']);
    expect(r.outcome).toBe('done');
    expect(existsSync(join(repo, '[ab].txt'))).toBe(false);
    for (const [f, t] of [['a.txt', 'A\n'], ['b.txt', 'B\n'], ['unlisted.txt', 'U\n'], ['x.log', 'ignored\n']] as const) expect(text(repo, f)).toBe(t);
    expect(pinnedBlobs(repo)).toContain('AB\n');

    const second = newRepo('destr-clean');
    commit(second, { 'base.txt': 'base\n' }, 'Base');
    write(second, { 'a.txt': 'A\n', 'b.txt': 'B\n', '[ab].txt': 'AB\n' });
    expect((await discardFiles(second, ['a.txt'])).outcome).toBe('done');
    expect(existsSync(join(second, 'a.txt'))).toBe(false);
    expect(text(second, 'b.txt')).toBe('B\n');
    expect(text(second, '[ab].txt')).toBe('AB\n');
  });

  it('restore is literal too: discarding the tracked file "[ab].txt" does not touch tracked a.txt or b.txt', async () => {
    const repo = newRepo('destr-literal');
    commit(repo, { 'a.txt': 'a\n', 'b.txt': 'b\n', '[ab].txt': 'ab\n' }, 'Base');
    write(repo, { 'a.txt': 'a edited\n', 'b.txt': 'b edited\n', '[ab].txt': 'ab edited\n' });
    expect((await discardFiles(repo, ['[ab].txt'])).outcome).toBe('done');
    expect(text(repo, '[ab].txt')).toBe('ab\n');
    expect(text(repo, 'a.txt')).toBe('a edited\n');
    expect(text(repo, 'b.txt')).toBe('b edited\n');
  });

  it('paths that are not in the status, ignored files, pathspec magic, escapes and empty lists are refused and change nothing', async () => {
    const { repo } = baseRepo();
    write(repo, { 'a.txt': 'edited\n', 'u.txt': 'untracked\n', 'x.log': 'ignored\n' });
    write(join(repo, '..'), { 'outside.txt': 'outside the repo\n' });
    const cases: string[][] = [
      [],
      [''],
      ['b.txt'], // tracked but clean: not in the status
      ['x.log'], // ignored
      ['*'],
      ['.'],
      [':(glob)**'],
      [':/'],
      ['../outside.txt'],
      [resolve(join(repo, '..', 'outside.txt'))],
      ['.git/config'],
      ['dir/../a.txt\0'],
    ];
    for (const paths of cases) await refusal(repo, () => discardFiles(repo, paths));
    expect(readFileSync(join(repo, '..', 'outside.txt'), 'utf8')).toBe('outside the repo\n');
    // the code path does run for a listed path
    expect((await discardFiles(repo, ['u.txt'])).outcome).toBe('done');
    expect(text(repo, 'a.txt')).toBe('edited\n');
    expect(text(repo, 'x.log')).toBe('ignored\n');
  });

  it('a nested repository is refused (an untracked directory is never cleaned)', async () => {
    const { repo } = baseRepo();
    mkdirSync(join(repo, 'nested'));
    git(join(repo, 'nested'), ['init', '-b', 'main']);
    write(join(repo, 'nested'), { 'inner.txt': 'inner\n' });
    expect(git(repo, ['status', '--porcelain=v1']).includes('?? nested/')).toBe(true);
    await refusal(repo, () => discardFiles(repo, ['nested/']));
    await refusal(repo, () => discardFiles(repo, ['nested']));
    expect(existsSync(join(repo, 'nested', '.git'))).toBe(true);
  });

  it('is disabled on an unborn HEAD', async () => {
    const repo = newRepo('destr-unborn');
    write(repo, { 'first.txt': 'first\n' });
    await refusal(repo, () => discardFiles(repo, ['first.txt']));
    expect(text(repo, 'first.txt')).toBe('first\n');
  });

  it('undo is refused (409, nothing changes) when a restored tracked file was edited after the discard', async () => {
    const { repo } = baseRepo();
    write(repo, { 'a.txt': 'edited\n' });
    expect((await discardFiles(repo, ['a.txt'])).outcome).toBe('done');
    write(repo, { 'a.txt': 'edited again after the discard\n' });
    await refusal(repo, () => undo(repo));
    expect(text(repo, 'a.txt')).toBe('edited again after the discard\n');
  });

  it('undo is refused when an untracked path has reappeared, or the index changed, since the discard', async () => {
    const one = baseRepo().repo;
    write(one, { 'u.txt': 'original untracked\n' });
    expect((await discardFiles(one, ['u.txt'])).outcome).toBe('done');
    write(one, { 'u.txt': 'someone made a new one\n' });
    await refusal(one, () => undo(one));
    expect(text(one, 'u.txt')).toBe('someone made a new one\n');

    const two = baseRepo().repo;
    write(two, { 'a.txt': 'staged then discarded\n' });
    git(two, ['add', 'a.txt']);
    expect((await discardFiles(two, ['a.txt'])).outcome).toBe('done');
    write(two, { 'other.txt': 'staged afterwards\n' });
    git(two, ['add', 'other.txt']);
    await refusal(two, () => undo(two));
    expect(git(two, ['ls-files', '--', 'other.txt']).trim()).toBe('other.txt');
  });

  it('blocked (nothing changes) while a merge is unresolved', async () => {
    const { repo, c1 } = baseRepo();
    git(repo, ['switch', '-c', 'side']);
    commit(repo, { 'a.txt': 'side\n' }, 'Side');
    git(repo, ['switch', 'main']);
    commit(repo, { 'a.txt': 'main\n' }, 'Main');
    expect(tryGit(repo, ['merge', 'side']).status).not.toBe(0);
    write(repo, { 'u.txt': 'untracked\n' });
    await refusal(repo, () => discardFiles(repo, ['u.txt']), ['blocked']);
    await refusal(repo, () => resetTo(repo, { sha: c1, mode: 'hard' }), ['blocked']);
    await refusal(repo, () => createTag(repo, { name: 'v1', sha: head(repo) }), ['blocked']);
    await refusal(repo, () => renameBranch(repo, { name: 'side', newName: 'side2' }), ['blocked']);
    await refusal(repo, () => deleteBranch(repo, { name: 'side', expectSha: refSha(repo, 'side')!, force: true }), ['blocked']);
    await refusal(repo, () => cherryPick(repo, refSha(repo, 'side')!), ['blocked']);
    await refusal(repo, () => revert(repo, c1), ['blocked']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('discardHunk', () => {
  const lines = (f: (i: number) => string): string => Array.from({ length: 30 }, (_, i) => f(i + 1)).join('\n') + '\n';
  const ORIGINAL = lines((i) => `line ${i}`);
  const EDITED = lines((i) => (i === 2 ? 'line 2 CHANGED' : i === 28 ? 'line 28 CHANGED' : `line ${i}`));
  function hunkRepo(): string {
    const repo = newRepo('destr-hunk');
    commit(repo, { 'hunks.txt': ORIGINAL, 'other.txt': 'o\n' }, 'Base');
    write(repo, { 'hunks.txt': EDITED });
    return repo;
  }
  const headers = (repo: string, extra: string[] = []): string[] =>
    git(repo, ['diff', '--no-color', ...extra, '--', 'hunks.txt']).split('\n').filter((l) => l.startsWith('@@'));

  it('discards exactly one hunk of the worktree, leaves the index alone, pins the bytes, and undo restores the file', async () => {
    const repo = hunkRepo();
    const hs = headers(repo);
    expect(hs).toHaveLength(2);
    const before = state(repo);
    const r = await discardHunk(repo, { path: 'hunks.txt', hunk: 1, header: hs[1]! });
    expect(r.outcome).toBe('done');
    expect(text(repo, 'hunks.txt')).toBe(lines((i) => (i === 2 ? 'line 2 CHANGED' : `line ${i}`)));
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(pinnedBlobs(repo)).toContain(EDITED);
    expect(undoState(repo).undo).toEqual({ label: 'discard changes' });
    expect((await undo(repo)).outcome).toBe('done');
    expect(state(repo)).toEqual(before);
  });

  it('a header that does not match the server\'s own re-diff, a bad index, an unsafe path and the staged side are refused (409/4xx), nothing changes', async () => {
    const repo = hunkRepo();
    const hs = headers(repo);
    await refusal(repo, () => discardHunk(repo, { path: 'hunks.txt', hunk: 0, header: hs[1]! })); // wrong hunk's header
    await refusal(repo, () => discardHunk(repo, { path: 'hunks.txt', hunk: 0, header: '@@ -1,1 +1,1 @@' }));
    await refusal(repo, () => discardHunk(repo, { path: 'hunks.txt', hunk: 7, header: hs[0]! }));
    await refusal(repo, () => discardHunk(repo, { path: 'hunks.txt', hunk: -1, header: hs[0]! }));
    await refusal(repo, () => discardHunk(repo, { path: '../hunks.txt', hunk: 0, header: hs[0]! }));
    await refusal(repo, () => discardHunk(repo, { path: '.git/config', hunk: 0, header: hs[0]! }));
    await refusal(repo, () => discardHunk(repo, { path: 'other.txt', hunk: 0, header: hs[0]! })); // clean file
    git(repo, ['add', 'hunks.txt']);
    const staged = headers(repo, ['--cached']);
    await refusal(repo, () => discardHunk(repo, { path: 'hunks.txt', hunk: 0, header: staged[0]! })); // unstaged side only
    // the code path itself runs for a valid call on the unstaged side
    write(repo, { 'hunks.txt': EDITED + 'tail\n' });
    const fresh2 = headers(repo);
    expect((await discardHunk(repo, { path: 'hunks.txt', hunk: fresh2.length - 1, header: fresh2[fresh2.length - 1]! })).outcome).toBe('done');
    expect(text(repo, 'hunks.txt')).toBe(EDITED);
  });

  it('undo is refused when the file changed after the hunk discard', async () => {
    const repo = hunkRepo();
    const hs = headers(repo);
    expect((await discardHunk(repo, { path: 'hunks.txt', hunk: 0, header: hs[0]! })).outcome).toBe('done');
    write(repo, { 'hunks.txt': 'completely different now\n' });
    await refusal(repo, () => undo(repo));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('resetTo', () => {
  function resetRepo(): { repo: string; c1: string; c2: string; c3: string } {
    const repo = newRepo('destr-reset');
    const c1 = commit(repo, { 'a.txt': 'a1\n', 'b.txt': 'b1\n' }, 'R1');
    const c2 = commit(repo, { 'a.txt': 'a2\n', 'extra.txt': 'extra tracked\n' }, 'R2');
    git(repo, ['rm', '-q', 'extra.txt']);
    write(repo, { 'a.txt': 'a3\n' });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'R3']);
    return { repo, c1, c2, c3: head(repo) };
  }
  function dirty(repo: string, untracked = false): void {
    write(repo, { 'a.txt': 'a staged edit\n' });
    git(repo, ['add', 'a.txt']);
    write(repo, { 'a.txt': 'a staged edit\nplus unstaged\n', ...(untracked ? { 'u.txt': 'untracked\n' } : {}) });
  }

  it("soft reset: HEAD moves, index and worktree stay, no confirm or snapshot needed, labelled \"reset 'main'\", undo moves HEAD back", async () => {
    const { repo, c1, c3 } = resetRepo();
    write(repo, { 'b.txt': 'b edit\n' });
    const filesBefore = files(repo);
    expect((await resetTo(repo, { sha: c1, mode: 'soft' })).outcome).toBe('done');
    expect(head(repo)).toBe(c1);
    expect(files(repo)).toEqual(filesBefore);
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('a.txt');
    expect(undoState(repo).undo).toEqual({ label: "reset 'main'" });
    expect((await undo(repo)).outcome).toBe('done');
    expect(head(repo)).toBe(c3);
    expect(files(repo)).toEqual(filesBefore);
  });

  it('mixed reset on a dirty index: index resets, worktree bytes stay, a snapshot is pinned, undo restores index AND worktree', async () => {
    const { repo, c1, c3 } = resetRepo();
    dirty(repo);
    const before = state(repo);
    expect((await resetTo(repo, { sha: c1, mode: 'mixed' })).outcome).toBe('done');
    expect(head(repo)).toBe(c1);
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(text(repo, 'a.txt')).toBe('a staged edit\nplus unstaged\n');
    expect(pinned(repo)).not.toBe('');
    expect((await undo(repo)).outcome).toBe('done');
    expect(head(repo)).toBe(c3);
    expect(state(repo)).toEqual(before);
  });

  it('hard reset on a dirty tree: pinned first, worktree reset, undo restores index and worktree bytes', async () => {
    const { repo, c1, c3 } = resetRepo();
    dirty(repo);
    const before = state(repo);
    expect((await resetTo(repo, { sha: c1, mode: 'hard' })).outcome).toBe('done');
    expect(head(repo)).toBe(c1);
    expect(text(repo, 'a.txt')).toBe('a1\n');
    expect(pinnedBlobs(repo)).toContain('a staged edit\nplus unstaged\n');
    expect(undoState(repo).undo).toEqual({ label: "reset 'main'" });
    expect((await undo(repo)).outcome).toBe('done');
    expect(head(repo)).toBe(c3);
    expect(state(repo)).toEqual(before);
  });

  it('hard reset on a clean tree needs no snapshot, and undo is a plain reset back', async () => {
    const { repo, c1, c3 } = resetRepo();
    expect((await resetTo(repo, { sha: c1, mode: 'hard' })).outcome).toBe('done');
    expect(pinned(repo)).toBe('');
    expect((await undo(repo)).outcome).toBe('done');
    expect(head(repo)).toBe(c3);
    expect(text(repo, 'a.txt')).toBe('a3\n');
  });

  it('hard reset collision with an UNTRACKED file counts as dirty: the file\'s bytes are pinned and undo brings them back', async () => {
    const { repo, c2, c3 } = resetRepo();
    write(repo, { 'extra.txt': 'my precious untracked bytes\n' }); // R2 tracks extra.txt, R3 (HEAD) does not
    const before = state(repo);
    expect((await resetTo(repo, { sha: c2, mode: 'hard' })).outcome).toBe('done');
    expect(text(repo, 'extra.txt')).toBe('extra tracked\n');
    expect(pinnedBlobs(repo)).toContain('my precious untracked bytes\n');
    expect((await undo(repo)).outcome).toBe('done');
    expect(head(repo)).toBe(c3);
    expect(state(repo)).toEqual(before);
  });

  it('hard reset collision with an IGNORED file counts as dirty too', async () => {
    const repo = newRepo('destr-reset-ignored');
    commit(repo, { '.gitignore': '*.dat\n', 'a.txt': 'a\n' }, 'R1');
    write(repo, { 'gen.dat': 'tracked gen\n' });
    git(repo, ['add', '-f', 'gen.dat']);
    git(repo, ['commit', '-m', 'R2 tracks an ignored name']);
    const c2 = head(repo);
    git(repo, ['rm', '--cached', '-q', 'gen.dat']);
    git(repo, ['commit', '-m', 'R3 untracks it']);
    const c3 = head(repo);
    write(repo, { 'gen.dat': 'my ignored precious bytes\n' });
    expect(git(repo, ['status', '--porcelain=v1', '--ignored']).includes('!! gen.dat')).toBe(true);
    const before = state(repo);
    expect((await resetTo(repo, { sha: c2, mode: 'hard' })).outcome).toBe('done');
    expect(text(repo, 'gen.dat')).toBe('tracked gen\n');
    expect(pinnedBlobs(repo)).toContain('my ignored precious bytes\n');
    expect((await undo(repo)).outcome).toBe('done');
    expect(head(repo)).toBe(c3);
    expect(state(repo)).toEqual(before);
  });

  it('hard reset where the target adds a FILE `d` and an untracked FOLDER `d/` exists: the folder\'s files are pinned and the bar fact says dirty', async () => {
    const repo = newRepo('destr-reset-folder');
    commit(repo, { 'a.txt': 'a\n' }, 'R1');
    commit(repo, { 'd': 'tracked file d\n' }, 'R2 adds file d');
    const c2 = head(repo);
    git(repo, ['rm', '-q', 'd']);
    git(repo, ['commit', '-m', 'R3 removes d']);
    const c3 = head(repo);
    write(repo, { 'd/x.txt': 'precious untracked x\n', 'd/deep/y.txt': 'precious untracked y\n' });
    expect(await resetNeedsConfirm(repo, c2)).toEqual({ dirty: true });
    const before = state(repo);
    expect((await resetTo(repo, { sha: c2, mode: 'hard' })).outcome).toBe('done');
    expect(pinnedBlobs(repo)).toContain('precious untracked x\n');
    expect(pinnedBlobs(repo)).toContain('precious untracked y\n');
    expect((await undo(repo)).outcome).toBe('done');
    expect(head(repo)).toBe(c3);
    expect(state(repo)).toEqual(before);
  });

  it('snapshots fail closed for reset: when the pin of the colliding bytes cannot be written, HEAD, index and bytes are unchanged', async () => {
    const { repo, c2 } = resetRepo();
    write(repo, { 'extra.txt': 'my precious untracked bytes\n' });
    lockPin(repo, 'my precious untracked bytes\n');
    const r = await refusal(repo, () => resetTo(repo, { sha: c2, mode: 'hard' }), ['failed', 'refused'], false);
    expect(r.outcome).not.toBe('done');
    expect(text(repo, 'extra.txt')).toBe('my precious untracked bytes\n');
  });

  it('undo of a hard reset is refused when the tree was edited since (it needs a clean tree)', async () => {
    const { repo, c1 } = resetRepo();
    dirty(repo);
    expect((await resetTo(repo, { sha: c1, mode: 'hard' })).outcome).toBe('done');
    write(repo, { 'b.txt': 'edited after the reset\n' });
    await refusal(repo, () => undo(repo));
    expect(text(repo, 'b.txt')).toBe('edited after the reset\n');
  });

  it('bad sha, bad mode and a detached HEAD are refused; HEAD, refs, index and bytes stay', async () => {
    const { repo, c1 } = resetRepo();
    dirty(repo, true);
    const tree =git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
    for (const sha of ['HEAD', 'main', 'HEAD~1', '--hard', c1.slice(0, 7), 'f'.repeat(40), tree, c1.toUpperCase(), '']) {
      await refusal(repo, () => resetTo(repo, { sha, mode: 'hard' }));
    }
    for (const mode of ['keep', 'merge', '--hard', '', 'HARD']) {
      await refusal(repo, () => resetTo(repo, { sha: c1, mode: mode as 'hard' }));
    }
    git(repo, ['stash', '-u', '-q']); // detaching needs nothing special, but keep the tree clean for the switch
    git(repo, ['switch', '--detach', 'HEAD']);
    await refusal(repo, () => resetTo(repo, { sha: c1, mode: 'hard' }));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('renameBranch', () => {
  it('renames with branch -m (never -M); HEAD follows when it is the current branch; nothing is journaled', async () => {
    const { repo, c1 } = baseRepo();
    git(repo, ['branch', 'old', c1]);
    expect((await renameBranch(repo, { name: 'old', newName: 'renamed/new' })).outcome).toBe('done');
    expect(refSha(repo, 'refs/heads/old')).toBeNull();
    expect(refSha(repo, 'refs/heads/renamed/new')).toBe(c1);
    expect((await renameBranch(repo, { name: 'main', newName: 'trunk' })).outcome).toBe('done');
    expect(git(repo, ['branch', '--show-current']).trim()).toBe('trunk');
    expect(undoState(repo)).toEqual({ undo: null, redo: null });
  });

  it('an existing target is not overwritten, and invalid names or a missing source are refused; nothing changes', async () => {
    const { repo, c1 } = baseRepo();
    git(repo, ['branch', 'old', c1]);
    const c2 = commit(repo, { 'b.txt': 'b2\n' }, 'Second');
    git(repo, ['branch', 'taken', c2]);
    await refusal(repo, () => renameBranch(repo, { name: 'old', newName: 'taken' }), ['refused', 'failed']);
    expect(refSha(repo, 'refs/heads/taken')).toBe(c2);
    for (const newName of ['a b', '-x', '--force', 'a..b', 'x.lock', '', 'a~b', 'a:b', '/a', 'a/', '@{x}']) {
      await refusal(repo, () => renameBranch(repo, { name: 'old', newName }));
    }
    for (const name of ['nope', '-M', '--all', 'refs/heads/old', 'origin/x']) {
      await refusal(repo, () => renameBranch(repo, { name, newName: 'fine' }));
    }
    expect((await renameBranch(repo, { name: 'old', newName: 'fine' })).outcome).toBe('done'); // the path is live
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('deleteBranch (local)', () => {
  function branchRepo(): { repo: string; c1: string; w1: string } {
    const { repo, c1 } = baseRepo();
    git(repo, ['switch', '-c', 'wip']);
    const w1 = commit(repo, { 'b.txt': 'wip work\n' }, 'WIP work');
    git(repo, ['switch', 'main']);
    git(repo, ['branch', 'done', c1]); // fully merged into main
    return { repo, c1, w1 };
  }

  it('-d refuses an unmerged branch (outcome unmerged with git\'s stderr, nothing changes); then force (-D) with the same sha check deletes it; undo recreates it', async () => {
    const { repo, w1 } = branchRepo();
    const r = await refusal(repo, () => deleteBranch(repo, { name: 'wip', expectSha: w1 }), ['unmerged']);
    expect(r.stderr).toMatch(/not fully merged/);
    expect((await deleteBranch(repo, { name: 'wip', expectSha: w1, force: true })).outcome).toBe('done');
    expect(refSha(repo, 'refs/heads/wip')).toBeNull();
    // Data safety: the unmerged tip is pinned before -D, so it survives the branch's reflog going away.
    expect(pinned(repo)).toContain(`refs/gitslappin/undo/${w1} ${w1}`);
    expect(undoState(repo).undo).toEqual({ label: "delete branch 'wip'" });
    expect((await undo(repo)).outcome).toBe('done');
    expect(refSha(repo, 'refs/heads/wip')).toBe(w1);
  });

  it('a merged branch is deleted without force', async () => {
    const { repo, c1 } = branchRepo();
    expect((await deleteBranch(repo, { name: 'done', expectSha: c1 })).outcome).toBe('done');
    expect(refSha(repo, 'refs/heads/done')).toBeNull();
  });

  it('a stale expectSha is refused for -d and for -D; the current branch, missing branches and option-like names are refused', async () => {
    const { repo, c1, w1 } = branchRepo();
    await refusal(repo, () => deleteBranch(repo, { name: 'wip', expectSha: c1 }));
    await refusal(repo, () => deleteBranch(repo, { name: 'wip', expectSha: c1, force: true }));
    await refusal(repo, () => deleteBranch(repo, { name: 'wip', expectSha: 'HEAD', force: true }));
    await refusal(repo, () => deleteBranch(repo, { name: 'main', expectSha: head(repo), force: true }), ['refused', 'failed']);
    for (const name of ['nope', '-D', '--all', 'refs/heads/wip', 'origin/x']) {
      await refusal(repo, () => deleteBranch(repo, { name, expectSha: w1, force: true }));
    }
    expect(refSha(repo, 'refs/heads/wip')).toBe(w1);
  });

  it('undo restores the upstream configuration that git removed with the branch', async () => {
    const { repo, c1 } = branchRepo();
    git(repo, ['config', 'branch.done.remote', '.']);
    git(repo, ['config', 'branch.done.merge', 'refs/heads/main']);
    expect((await deleteBranch(repo, { name: 'done', expectSha: c1 })).outcome).toBe('done');
    expect(cfg(repo, 'branch.done.merge')).toBeUndefined();
    expect((await undo(repo)).outcome).toBe('done');
    expect(refSha(repo, 'refs/heads/done')).toBe(c1);
    expect(cfg(repo, 'branch.done.remote')).toBe('.');
    expect(cfg(repo, 'branch.done.merge')).toBe('refs/heads/main');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
interface Fx {
  base: string;
  origin: string;
  a: string;
  b: string;
}
function assertRemotesSafe(repo: string): void {
  const r = tryGit(repo, ['config', '--local', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']);
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const url = line.slice(line.indexOf(' ') + 1).trim();
    if (!url.startsWith('file://')) throw new Error(`Unsafe remote URL (not file://): ${line}`);
    if (!underRoot(fileURLToPath(url))) throw new Error(`Remote URL is outside ${ROOT}: ${line}`);
  }
}
/** origin (bare) main = 2 commits; A (repo under test, tracks origin/main); B (somebody else). */
function makeFx(): Fx {
  const base = fresh('destr-remote-int');
  const origin = join(base, 'origin.git');
  const a = join(base, 'a');
  const b = join(base, 'b');
  mkdirSync(origin);
  git(origin, ['init', '--bare', '-b', 'main']);
  const url = pathToFileURL(origin).href;
  mkdirSync(a);
  git(a, ['init', '-b', 'main']);
  configure(a);
  git(a, ['remote', 'add', 'origin', url]);
  assertRemotesSafe(a);
  commit(a, { 'README.md': '# readme\n' }, 'Remote base 1');
  commit(a, { 'docs.txt': 'docs\n' }, 'Remote base 2');
  git(a, ['push', '-u', 'origin', 'main']);
  git(base, ['clone', url, 'b']);
  configure(b);
  assertRemotesSafe(b);
  return { base, origin, a, b };
}
function originAdvance(fx: Fx, files_: Record<string, string>, msg: string): string {
  assertRemotesSafe(fx.b);
  git(fx.b, ['pull', '--ff-only', 'origin', 'main']);
  const sha = commit(fx.b, files_, msg, 'Other Author');
  git(fx.b, ['push', 'origin', 'main']);
  return sha;
}
const originRef = (fx: Fx, ref: string): string | null => refSha(fx.origin, ref);
const originRefs = (fx: Fx): string => git(fx.origin, ['for-each-ref', '--format=%(refname) %(objectname)']);

describe('deleteBranch with remote: true ("Delete {0} and {1}")', () => {
  /** A has `feature` pushed with -u (upstream origin/feature), and is on main. */
  function featureFx(): Fx & { sha: string } {
    const fx = makeFx();
    git(fx.a, ['switch', '-c', 'feature']);
    const sha = commit(fx.a, { 'feature.txt': 'feature\n' }, 'Feature commit');
    assertRemotesSafe(fx.a);
    git(fx.a, ['push', '-u', 'origin', 'feature']);
    git(fx.a, ['switch', 'main']);
    return { ...fx, sha };
  }

  it('deletes the local branch, then the remote branch with a lease on the journaled sha; undo restores both and the upstream config', async () => {
    const fx = featureFx();
    assertRemotesSafe(fx.a);
    expect(originRef(fx, 'refs/heads/feature')).toBe(fx.sha);
    const r = await deleteBranch(fx.a, { name: 'feature', expectSha: fx.sha, remote: true });
    expect(r.outcome).toBe('done');
    expect(refSha(fx.a, 'refs/heads/feature')).toBeNull();
    expect(originRef(fx, 'refs/heads/feature')).toBeNull();
    expect(originRef(fx, 'refs/heads/main')).not.toBeNull(); // only that branch went
    expect(undoState(fx.a).undo).toEqual({ label: "delete branch 'feature'" });
    expect((await undo(fx.a)).outcome).toBe('done');
    expect(refSha(fx.a, 'refs/heads/feature')).toBe(fx.sha);
    expect(originRef(fx, 'refs/heads/feature')).toBe(fx.sha); // undo re-pushed it
    expect(cfg(fx.a, 'branch.feature.remote')).toBe('origin');
    expect(cfg(fx.a, 'branch.feature.merge')).toBe('refs/heads/feature');
  });

  it('the lease protects somebody else\'s newer commit: origin moved after the last fetch, so the remote branch is NOT deleted', async () => {
    const fx = featureFx();
    assertRemotesSafe(fx.b);
    git(fx.b, ['fetch', 'origin']);
    git(fx.b, ['switch', '-c', 'feature', '--track', 'origin/feature']);
    const theirs = commit(fx.b, { 'theirs.txt': 'their work\n' }, 'Their commit on feature', 'Other Author');
    git(fx.b, ['push', 'origin', 'feature']);
    const r = await deleteBranch(fx.a, { name: 'feature', expectSha: fx.sha, remote: true });
    expect(r.outcome).not.toBe('done');
    expect(originRef(fx, 'refs/heads/feature')).toBe(theirs);
  });

  it('never touches the remote after a failed local delete (unmerged branch, no force): origin and local are unchanged', async () => {
    const fx = featureFx();
    git(fx.a, ['switch', 'feature']);
    const sha = commit(fx.a, { 'unpushed.txt': 'only local\n' }, 'Unpushed feature commit'); // -d checks against the upstream: not merged there
    git(fx.a, ['switch', 'main']);
    const beforeOrigin = originRefs(fx);
    const r = await refusal(fx.a, () => deleteBranch(fx.a, { name: 'feature', expectSha: sha, remote: true }), ['unmerged']);
    expect(r.stderr).toMatch(/not fully merged/);
    expect(originRefs(fx)).toBe(beforeOrigin);
  });

  it('the remote comes only from the upstream: a branch with no upstream, or a "remote" that is not a boolean, deletes nothing remote', async () => {
    const fx = makeFx();
    git(fx.a, ['switch', '-c', 'lonely']);
    const sha = commit(fx.a, { 'l.txt': 'l\n' }, 'Lonely');
    git(fx.a, ['switch', 'main']);
    const beforeOrigin = originRefs(fx);
    const r1 = await deleteBranch(fx.a, { name: 'lonely', expectSha: sha, remote: true });
    expect(r1.outcome).not.toBe('done');
    expect(originRefs(fx)).toBe(beforeOrigin);
    const r2 = await refusal(fx.a, () => deleteBranch(fx.a, { name: 'lonely', expectSha: sha, force: true, remote: '--delete origin main' as unknown as boolean }), ['refused']);
    expect(r2.outcome).toBe('refused');
    expect(originRefs(fx)).toBe(beforeOrigin);
  });

  it('undo of a remote delete is refused (additive push only) when the remote branch name was taken by a different commit meanwhile', async () => {
    const fx = featureFx();
    expect((await deleteBranch(fx.a, { name: 'feature', expectSha: fx.sha, remote: true })).outcome).toBe('done');
    assertRemotesSafe(fx.b);
    git(fx.b, ['switch', '-c', 'feature', 'main']);
    const other = commit(fx.b, { 'other.txt': 'other\n' }, 'Unrelated feature branch', 'Other Author');
    git(fx.b, ['push', 'origin', 'feature']);
    const r = await undo(fx.a);
    expect(r.outcome).not.toBe('done');
    expect(originRef(fx, 'refs/heads/feature')).toBe(other);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('forcePush (force-with-lease)', () => {
  /** A: local commit; origin: B's commit; A has fetched, so origin/main is B's sha. */
  function diverged(): Fx & { remoteSha: string; local: string } {
    const fx = makeFx();
    const remoteSha = originAdvance(fx, { 'remote.txt': 'r\n' }, 'Remote side commit');
    const local = commit(fx.a, { 'local.txt': 'l\n' }, 'Local side commit');
    assertRemotesSafe(fx.a);
    git(fx.a, ['fetch', 'origin']);
    return { ...fx, remoteSha, local };
  }

  it('a rejected push reports the local remote-tracking sha as `expect`; forcePush with it replaces origin/main and is NOT undoable', async () => {
    const fx = diverged();
    assertRemotesSafe(fx.a);
    const rej = await pushRemote(fx.a, {});
    expect(rej.outcome).toBe('rejected');
    expect((rej as { expect?: string }).expect).toBe(fx.remoteSha);
    expect(originRef(fx, 'refs/heads/main')).toBe(fx.remoteSha);
    const r = await forcePush(fx.a, { branch: 'main', expect: fx.remoteSha });
    expect(r.outcome).toBe('done');
    expect(originRef(fx, 'refs/heads/main')).toBe(fx.local);
    expect(head(fx.a)).toBe(fx.local);
    expect(undoState(fx.a).undo).toBeNull();
  });

  it('the lease fails when the remote moved after the last fetch: origin keeps the newer commit, local is unchanged, the failure is reported', async () => {
    const fx = diverged();
    const moved = originAdvance(fx, { 'again.txt': 'again\n' }, 'Remote moved again after my fetch');
    const before = snap(fx.a);
    const r = await forcePush(fx.a, { branch: 'main', expect: fx.remoteSha });
    expect(r.outcome).toBe('failed');
    expect(`${r.stderr ?? ''}${r.error ?? ''}`).not.toBe('');
    expect(originRef(fx, 'refs/heads/main')).toBe(moved);
    expect(snap(fx.a)).toEqual(before);
  });

  it('refuses a malformed expect, an unknown branch, a branch without upstream and a body-supplied remote; origin is untouched', async () => {
    const fx = diverged();
    git(fx.a, ['switch', '-c', 'noup']);
    git(fx.a, ['switch', 'main']);
    for (const expect_ of ['', 'main', 'origin/main', '--force', fx.remoteSha.slice(0, 7), 'g'.repeat(40)]) {
      await refusal(fx.a, () => forcePush(fx.a, { branch: 'main', expect: expect_ }), ['refused']);
    }
    await refusal(fx.a, () => forcePush(fx.a, { branch: 'nope', expect: fx.remoteSha }));
    await refusal(fx.a, () => forcePush(fx.a, { branch: 'noup', expect: fx.remoteSha }));
    await refusal(fx.a, () => forcePush(fx.a, { branch: '-f', expect: fx.remoteSha }));
    expect(originRef(fx, 'refs/heads/main')).toBe(fx.remoteSha); // none of the refusals pushed anything
    // last: a body-supplied remote is ignored (the upstream decides), so nothing appears on any other remote
    const evil = join(fresh('destr-evil'), 'evil.git');
    mkdirSync(evil);
    git(evil, ['init', '--bare', '-b', 'main']);
    git(fx.a, ['remote', 'add', 'evil', pathToFileURL(evil).href]);
    assertRemotesSafe(fx.a);
    await forcePush(fx.a, { branch: 'main', expect: fx.remoteSha, remote: 'evil' } as unknown as { branch: string; expect: string });
    expect(git(evil, ['for-each-ref']).trim()).toBe('');
  });

  it('a wrong-but-well-formed expect is refused (it must equal refs/remotes/<upstream remote>/<rb>): origin unchanged', async () => {
    const fx = diverged();
    const before = originRefs(fx);
    const r = await forcePush(fx.a, { branch: 'main', expect: 'a'.repeat(40) });
    expect(r.outcome).toBe('refused');
    expect(originRefs(fx)).toBe(before);
  });

  it('an expect taken from ANOTHER remote-tracking ref (a custom push target) is refused: the upstream is never overwritten', async () => {
    const fx = diverged();
    const other = commit(fx.a, { 'o.txt': 'o\n' }, 'On another branch');
    git(fx.a, ['update-ref', 'refs/remotes/origin/other', other]); // a tracking ref for some other remote branch
    const before = originRefs(fx);
    const r = await forcePush(fx.a, { branch: 'main', expect: other });
    expect(r.outcome).toBe('refused');
    expect(originRefs(fx)).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('createTag', () => {
  it('a lightweight tag points at the commit; an annotated tag is a tag object with the message (read from stdin)', async () => {
    const { repo, c1 } = baseRepo();
    const c2 = commit(repo, { 'b.txt': 'b2\n' }, 'Second');
    expect((await createTag(repo, { name: 'v1.0', sha: c1 })).outcome).toBe('done');
    expect(git(repo, ['rev-parse', 'refs/tags/v1.0']).trim()).toBe(c1);
    expect(git(repo, ['cat-file', '-t', 'refs/tags/v1.0']).trim()).toBe('commit');
    expect((await createTag(repo, { name: 'rel/v2', sha: c2, message: 'Release two\n\n--hostile looking body line\n' })).outcome).toBe('done');
    expect(git(repo, ['cat-file', '-t', 'refs/tags/rel/v2']).trim()).toBe('tag');
    expect(git(repo, ['rev-parse', 'refs/tags/rel/v2^{commit}']).trim()).toBe(c2);
    const body = git(repo, ['tag', '-l', 'rel/v2', '--format=%(contents)']);
    expect(body).toContain('Release two');
    expect(body).toContain('--hostile looking body line');
    expect(undoState(repo)).toEqual({ undo: null, redo: null });
  });

  it('invalid names are refused (leading dash, check-ref-format rules); nothing is created', async () => {
    const { repo, c1 } = baseRepo();
    const names = ['-x', '--force', '-d', 'a b', 'a..b', 'x.lock', '', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a@{b', '/a', 'a/', 'a//b', '.a', 'a.', 'a\\b', 'a\u0001b'];
    for (const name of names) await refusal(repo, () => createTag(repo, { name, sha: c1 }));
    for (const name of ['-x', 'a b']) await refusal(repo, () => createTag(repo, { name, sha: c1, message: 'annotated' }));
    expect(git(repo, ['tag', '--list']).trim()).toBe('');
    expect((await createTag(repo, { name: 'ok', sha: c1 })).outcome).toBe('done'); // the path is live
  });

  it('never forces: an existing tag name fails and the tag stays on its commit', async () => {
    const { repo, c1 } = baseRepo();
    const c2 = commit(repo, { 'b.txt': 'b2\n' }, 'Second');
    expect((await createTag(repo, { name: 'v1', sha: c1 })).outcome).toBe('done');
    await refusal(repo, () => createTag(repo, { name: 'v1', sha: c2 }), ['failed', 'refused']);
    await refusal(repo, () => createTag(repo, { name: 'v1', sha: c2, message: 'annotated over it' }), ['failed', 'refused']);
    expect(git(repo, ['rev-parse', 'refs/tags/v1']).trim()).toBe(c1);
  });

  it('target must be a full commit sha; message limits (64 KB, no NUL) are enforced', async () => {
    const { repo, c1 } = baseRepo();
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
    for (const sha of ['HEAD', 'main', c1.slice(0, 7), 'f'.repeat(40), tree, `${c1} `, '', c1.toUpperCase()]) {
      await refusal(repo, () => createTag(repo, { name: 'v9', sha }));
    }
    await refusal(repo, () => createTag(repo, { name: 'v9', sha: c1, message: 'x'.repeat(64 * 1024 + 1) }));
    await refusal(repo, () => createTag(repo, { name: 'v9', sha: c1, message: 'has a \0 nul' }));
    expect((await createTag(repo, { name: 'v9', sha: c1, message: 'x'.repeat(64 * 1024 - 16) })).outcome).toBe('done');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
/**
 * main: C1, M1 (a.txt='a main'), M2 (b.txt='b main'), M3 (a.txt='a main 3'), M4 (c.txt='c x'), M5 (c.txt='c1' again).
 * topic (from C1): T1 adds topic.txt (author Topic Author), T2 c.txt='c topic', T3 a.txt='a topic' (conflicts with M1/M3).
 * On main at the end; README.md is committed (a dirty edit of it is the auto-stash material).
 */
const DIRTY = '# readme with an uncommitted edit\n';
function pickRepo(): { repo: string; c1: string; t1: string; t2: string; t3: string; m: Record<'m1' | 'm2' | 'm3' | 'm4' | 'm5', string> } {
  const repo = newRepo('destr-pick');
  const c1 = commit(repo, { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n', 'README.md': '# readme\n' }, 'Base');
  git(repo, ['switch', '-c', 'topic']);
  const t1 = commit(repo, { 'topic.txt': 'topic\n' }, 'T1 add topic file', 'Topic Author');
  const t2 = commit(repo, { 'c.txt': 'c topic\n' }, 'T2 change c', 'Topic Author');
  const t3 = commit(repo, { 'a.txt': 'a topic\n' }, 'T3 change a', 'Topic Author');
  git(repo, ['switch', 'main']);
  const m1 = commit(repo, { 'a.txt': 'a main\n' }, 'M1 change a');
  const m2 = commit(repo, { 'b.txt': 'b main\n' }, 'M2 change b');
  const m3 = commit(repo, { 'a.txt': 'a main 3\n' }, 'M3 change a again');
  const m4 = commit(repo, { 'c.txt': 'c x\n' }, 'M4 change c');
  const m5 = commit(repo, { 'c.txt': 'c1\n' }, 'M5 change c back');
  return { repo, c1, t1, t2, t3, m: { m1, m2, m3, m4, m5 } };
}
const lastAuthor = (repo: string): string => git(repo, ['log', '-1', '--format=%an']).trim();
const lastBody = (repo: string): string => git(repo, ['log', '-1', '--format=%B']);

describe('cherryPick', () => {
  it('clean: a new commit with the same message and author on top of HEAD; no stash on a clean tree', async () => {
    const { repo, t1, m } = pickRepo();
    const r = await cherryPick(repo, t1);
    expect(r.outcome).toBe('done');
    expect(r.stash).toBeUndefined();
    expect(git(repo, ['rev-parse', 'HEAD^']).trim()).toBe(m.m5);
    expect(subjects(repo)[0]).toBe('T1 add topic file');
    expect(lastAuthor(repo)).toBe('Topic Author');
    expect(text(repo, 'topic.txt')).toBe('topic\n');
    expect(marker(repo, 'CHERRY_PICK_HEAD')).toBe(false);
    expect(git(repo, ['status', '--porcelain=v1']).trim()).toBe('');
  });

  it('conflict: outcome conflict (not an error), CHERRY_PICK_HEAD present, opState kind cherry-pick, conflict markers on disk', async () => {
    const { repo, t3 } = pickRepo();
    const r = await cherryPick(repo, t3);
    expect(r.outcome).toBe('conflict');
    expect(marker(repo, 'CHERRY_PICK_HEAD')).toBe(true);
    expect((await readOpState(repo))!.kind).toBe('cherry-pick');
    expect(text(repo, 'a.txt')).toContain('<<<<<<<');
  });

  it('abort after a conflict on a clean tree: HEAD and bytes are exactly as before', async () => {
    const { repo, t3 } = pickRepo();
    const before = state(repo);
    expect((await cherryPick(repo, t3)).outcome).toBe('conflict');
    expect((await cherryPickAbort(repo)).outcome).toBe('done');
    expect(marker(repo, 'CHERRY_PICK_HEAD')).toBe(false);
    expect(state(repo)).toEqual(before);
  });

  it('dirty tree: auto-stash first (StashMessage-CherryPick text, by sha), conflict keeps it, abort pops it back and drops the entry', async () => {
    const { repo, t3 } = pickRepo();
    write(repo, { 'README.md': DIRTY });
    const beforeHead = head(repo);
    const r = await cherryPick(repo, t3);
    expect(r.outcome).toBe('conflict');
    expect(r.stash?.message).toMatch(/^Auto stash before cherry pick of ".+"$/);
    expect(stashLines(repo).filter((s) => s.includes('Auto stash before cherry pick of'))).toHaveLength(1);
    expect(text(repo, 'README.md')).toBe('# readme\n'); // the edit lives in the stash
    expect((await cherryPickAbort(repo)).outcome).toBe('done');
    expect(head(repo)).toBe(beforeHead);
    expect(marker(repo, 'CHERRY_PICK_HEAD')).toBe(false);
    expect(text(repo, 'README.md')).toBe(DIRTY);
    expect(stashLines(repo)).toEqual([]);
  });

  it('abort when the tree is NOT clean afterwards: the stash is kept, the user is told (result.stash), nothing is lost', async () => {
    const { repo, t3 } = pickRepo();
    write(repo, { 'README.md': DIRTY });
    expect((await cherryPick(repo, t3)).outcome).toBe('conflict');
    write(repo, { 'late.txt': 'created during the conflict\n' });
    const r = await cherryPickAbort(repo);
    expect(r.outcome).toBe('done');
    expect(r.stash).toBeDefined();
    expect(stashLines(repo).filter((s) => s.includes('Auto stash before cherry pick of'))).toHaveLength(1);
    expect(git(repo, ['show', 'stash@{0}:README.md'])).toBe(DIRTY);
    expect(text(repo, 'late.txt')).toBe('created during the conflict\n');
    expect(text(repo, 'README.md')).toBe('# readme\n');
  });

  it('dirty tree + clean pick: the edit is never lost (kept in the stash named in the result, or back in the tree)', async () => {
    const { repo, t1 } = pickRepo();
    write(repo, { 'README.md': DIRTY, 'u.txt': 'untracked\n' });
    const r = await cherryPick(repo, t1);
    expect(r.outcome).toBe('done');
    expect(r.stash?.message).toMatch(/^Auto stash before cherry pick of ".+"$/);
    const inStash = stashLines(repo).length === 1 && git(repo, ['show', 'stash@{0}:README.md']) === DIRTY && git(repo, ['show', 'stash@{0}^3:u.txt']) === 'untracked\n';
    const inTree = text(repo, 'README.md') === DIRTY && existsSync(join(repo, 'u.txt'));
    expect(inStash || inTree).toBe(true);
    expect(text(repo, 'topic.txt')).toBe('topic\n');
  });

  it('stash fails: the pick never runs, HEAD and the dirty bytes are unchanged', async () => {
    const { repo, t1 } = pickRepo();
    write(repo, { 'README.md': DIRTY });
    writeFileSync(join(repo, '.git', 'refs', 'stash.lock'), ''); // makes `stash push` unable to update refs/stash; the pick itself would succeed
    const r = await refusal(repo, () => cherryPick(repo, t1), ['failed'], true);
    expect(r.error ?? r.stderr ?? '').not.toBe('');
    expect(subjects(repo)).not.toContain('T1 add topic file');
    expect(marker(repo, 'CHERRY_PICK_HEAD')).toBe(false);
  });

  it('empty result (change already present): skipped, outcome noop, no CHERRY_PICK_HEAD, HEAD and tree unchanged', async () => {
    const { repo, t1 } = pickRepo();
    expect((await cherryPick(repo, t1)).outcome).toBe('done');
    const before = state(repo);
    const r = await cherryPick(repo, t1);
    expect(r.outcome).toBe('noop');
    expect(marker(repo, 'CHERRY_PICK_HEAD')).toBe(false);
    expect(state(repo)).toEqual(before);
  });

  it('bad sha is refused; nothing changes', async () => {
    const { repo } = pickRepo();
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
    for (const sha of ['HEAD', 'topic', '--abort', '--continue', 'f'.repeat(40), tree, '']) await refusal(repo, () => cherryPick(repo, sha));
  });
});

describe('revert', () => {
  it('clean: a new commit that undoes the change; message is git\'s Revert "..." text without comment lines', async () => {
    const { repo, m } = pickRepo();
    const r = await revert(repo, m.m2);
    expect(r.outcome).toBe('done');
    expect(r.stash).toBeUndefined();
    expect(text(repo, 'b.txt')).toBe('b1\n');
    expect(subjects(repo)[0]).toBe('Revert "M2 change b"');
    expect(lastBody(repo)).toContain(`This reverts commit ${m.m2}.`);
    expect(lastBody(repo).split('\n').some((l) => l.startsWith('#'))).toBe(false);
    expect(marker(repo, 'REVERT_HEAD')).toBe(false);
    expect(git(repo, ['status', '--porcelain=v1']).trim()).toBe('');
  });

  it('conflict then abort: opState kind revert, HEAD and bytes restored', async () => {
    const { repo, m } = pickRepo();
    const before = state(repo);
    const r = await revert(repo, m.m1); // M3 changed the same line later
    expect(r.outcome).toBe('conflict');
    expect(marker(repo, 'REVERT_HEAD')).toBe(true);
    expect((await readOpState(repo))!.kind).toBe('revert');
    expect((await revertAbort(repo)).outcome).toBe('done');
    expect(marker(repo, 'REVERT_HEAD')).toBe(false);
    expect(state(repo)).toEqual(before);
  });

  it('dirty tree: auto-stash (StashMessage-Revert text), conflict keeps it, abort pops it back', async () => {
    const { repo, m } = pickRepo();
    write(repo, { 'README.md': DIRTY });
    const r = await revert(repo, m.m1);
    expect(r.outcome).toBe('conflict');
    expect(r.stash?.message).toMatch(/^Auto stash before revert of ".+"$/);
    expect(text(repo, 'README.md')).toBe('# readme\n');
    expect((await revertAbort(repo)).outcome).toBe('done');
    expect(text(repo, 'README.md')).toBe(DIRTY);
    expect(stashLines(repo)).toEqual([]);
  });

  it('empty result (already reverted by the history): skipped, outcome noop, nothing left behind', async () => {
    const { repo, m } = pickRepo();
    const before = state(repo);
    const r = await revert(repo, m.m4); // M5 already put c.txt back
    expect(r.outcome).toBe('noop');
    expect(marker(repo, 'REVERT_HEAD')).toBe(false);
    expect(state(repo)).toEqual(before);
  });

  it('bad sha is refused; nothing changes', async () => {
    const { repo } = pickRepo();
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
    for (const sha of ['HEAD', 'topic', '--abort', '--continue', 'f'.repeat(40), tree, '']) await refusal(repo, () => revert(repo, sha));
  });
});

describe('every refusal leaves HEAD, refs, index and bytes unchanged (spot check on a dirty repo with a stash)', () => {
  it('a battery of refused calls changes nothing', async () => {
    const { repo, t1 } = pickRepo();
    write(repo, { 'b.txt': 'b stashed\n' });
    git(repo, ['stash', 'push', '-q', '-m', 'pre-existing stash', '--', 'b.txt']);
    expect(stashLines(repo)).toHaveLength(1);
    write(repo, { 'a.txt': 'staged\n' });
    git(repo, ['add', 'a.txt']);
    write(repo, { 'a.txt': 'staged\nunstaged\n', 'u.txt': 'untracked\n' });
    await refusal(repo, () => discardFiles(repo, ['../x']));
    await refusal(repo, () => resetTo(repo, { sha: 'HEAD', mode: 'hard' }));
    await refusal(repo, () => renameBranch(repo, { name: 'topic', newName: 'bad name' }));
    await refusal(repo, () => deleteBranch(repo, { name: 'topic', expectSha: head(repo), force: true }));
    await refusal(repo, () => createTag(repo, { name: '-x', sha: t1 }));
    await refusal(repo, () => cherryPick(repo, 'HEAD'));
    await refusal(repo, () => revert(repo, 'HEAD'));
    await refusal(repo, () => forcePush(repo, { branch: 'main', expect: 'nothex' }));
  });
});
