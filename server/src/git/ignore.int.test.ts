import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { EOL, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ignorePaths } from './ignore';
import { undo, undoState, redo } from './undo';

vi.setConfig({ testTimeout: 60_000 });

/*
 * Contract the builder must export from server/src/git/ignore.ts (build notes "V3 design (Ignore)" + "V3 + V4 audit fixes"):
 *   ignorePaths(root, { paths: string[]; mode: 'file' | 'ext' | 'folder'; untrack: boolean }): Promise<IgnoreResult>
 *     runs in runExclusive; the pattern text is built on the server (shared/ignorePattern); records the undo entry itself.
 *   IgnoreResult = { outcome: 'done' | 'noop' | 'refused' | 'failed' | 'blocked'; error?: string }
 *     noop    = every pattern is already ignored (git check-ignore --no-index -q): nothing written, nothing recorded
 *     refused = validation failed (path not in status, '..', NUL/CR/LF, empty list, .gitignore is a symlink or directory): nothing changed
 *     failed  = git or the write failed (the temp-file rename failing is 'failed' with an error; nothing is cleaned up)
 *   Undo journal kind 'ignore' (undo.ts, via undo(root)/redo(root)); labels "ignore '<name>'" (one path) and "ignore <N> files".
 *   Undo of a .gitignore GitSlappin created truncates it to empty ONLY while its hash still equals `after`, and never unlinks it.
 *   Both the `before` and `after` blobs are pinned under refs/gitslappin/undo/ before the rename.
 * Real git in mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted.
 * UNVERIFIED (inferred): a tracked target must be modified so it shows in status; the '*.txt' test builds its index entry with
 * update-index --cacheinfo because Windows cannot create a file named '*.txt'; redo of an undone created-file ignore re-applies it.
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

const CFG = join(fresh('gitcfg-ignore-int'), 'empty.gitconfig');
writeFileSync(CFG, '');
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: CFG,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
});
delete process.env.GITSLAPPIN_TOKEN;

const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true, input, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): number | null => spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true }).status;

function newRepo(prefix: string): string {
  const repo = join(fresh(prefix), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'author@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  return repo;
}
function write(repo: string, files: Record<string, string>): void {
  for (const [rel, t] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, t);
  }
}
function commit(repo: string, files: Record<string, string>, msg: string): void {
  write(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', msg]);
}
const bytes = (repo: string, rel: string): Buffer => readFileSync(join(repo, rel));
const porcelain = (repo: string): string => git(repo, ['status', '--porcelain=v1', '-uall']);
const cached = (repo: string): string[] => git(repo, ['ls-files', '--cached']).split('\n').filter(Boolean).sort();
const pinnedBlobs = (repo: string): string[] => {
  const out: string[] = [];
  for (const line of git(repo, ['for-each-ref', '--format=%(objectname) %(objecttype)', 'refs/gitslappin/undo/']).split('\n').filter(Boolean)) {
    const [sha, type] = line.split(' ');
    if (type === 'blob') out.push(git(repo, ['cat-file', 'blob', sha!]));
  }
  return out;
};
const entries = (repo: string): string[] => (readdirSync(repo) as string[]).filter((n) => n !== '.git').sort();

/** main: one commit with a.log (untracked-to-be targets are added by each test). */
function baseRepo(prefix: string): string {
  const repo = newRepo(prefix);
  commit(repo, { 'README.md': '# t\n', 'src/app.js': 'a1\n', 'src/lib.js': 'l1\n' }, 'Base');
  return repo;
}

describe('write', () => {
  it('an untracked file is ignored: old .gitignore bytes stay an exact prefix, then EOL pattern EOL, and the file leaves status', async () => {
    const repo = baseRepo('ignore-int-write');
    commit(repo, { '.gitignore': 'build/\r\nkeep' }, 'gitignore'); // CRLF + no final newline on purpose
    write(repo, { 'debug.log': 'x\n' });
    const old = bytes(repo, '.gitignore');
    expect(porcelain(repo)).toContain('?? debug.log');

    const r = await ignorePaths(repo, { paths: ['debug.log'], mode: 'file', untrack: false });
    expect(r.outcome).toBe('done');
    const now = bytes(repo, '.gitignore');
    expect(now.subarray(0, old.length).equals(old)).toBe(true);
    expect(now.subarray(old.length).toString('utf8')).toBe(`${EOL}debug.log${EOL}`);
    expect(porcelain(repo)).not.toContain('debug.log');
    expect(porcelain(repo)).toContain('M .gitignore');
    expect(bytes(repo, 'debug.log').toString()).toBe('x\n');
  });

  it('creates .gitignore when missing (EOL pattern EOL) and ext / folder modes write *.ext and dir/', async () => {
    const repo = baseRepo('ignore-int-modes');
    write(repo, { 'a.log': '1', 'b.log': '2', 'out/x.bin': '3', 'out/y.bin': '4' });
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    expect((await ignorePaths(repo, { paths: ['a.log'], mode: 'ext', untrack: false })).outcome).toBe('done');
    expect(bytes(repo, '.gitignore').toString('utf8')).toBe(`${EOL}*.log${EOL}`);
    expect((await ignorePaths(repo, { paths: ['out'], mode: 'folder', untrack: false })).outcome).toBe('done');
    expect(bytes(repo, '.gitignore').toString('utf8')).toBe(`${EOL}*.log${EOL}${EOL}out/${EOL}`);
    expect(porcelain(repo)).not.toMatch(/a\.log|b\.log|out\//);
  });

  it('an already-ignored file writes nothing, records nothing and leaves no stray file', async () => {
    const repo = baseRepo('ignore-int-already');
    commit(repo, { '.gitignore': '*.log\n' }, 'gitignore');
    write(repo, { 'a.log': 'x' });
    const before = bytes(repo, '.gitignore');
    const names = entries(repo);
    const r = await ignorePaths(repo, { paths: ['a.log'], mode: 'file', untrack: false });
    expect(r.outcome).toBe('noop');
    expect(bytes(repo, '.gitignore').equals(before)).toBe(true);
    expect(entries(repo)).toEqual(names);
    expect(undoState(repo).undo).toBeNull();
  });

  it('refuses without touching anything: path not in status, "..", newline in a name, empty list, .gitignore is a directory', async () => {
    const repo = baseRepo('ignore-int-refuse');
    write(repo, { 'new.txt': 'n' });
    const names = entries(repo);
    for (const paths of [['src/app.js'] /* tracked + clean = not in status */, ['../x'], ['no/such.txt'], ['a\nb.txt'], []]) {
      const r = await ignorePaths(repo, { paths, mode: 'file', untrack: false });
      expect(r.outcome, JSON.stringify(paths)).toBe('refused');
    }
    expect(entries(repo)).toEqual(names);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);

    mkdirSync(join(repo, '.gitignore'));
    const r = await ignorePaths(repo, { paths: ['new.txt'], mode: 'file', untrack: false });
    expect(r.outcome).toBe('refused');
    expect(lstatSync(join(repo, '.gitignore')).isDirectory()).toBe(true);
  });

  it('a symlinked .gitignore is refused and its target is not written', async (ctx) => {
    const repo = baseRepo('ignore-int-symlink');
    const target = join(fresh('ignore-int-symlink-target'), 'elsewhere.txt');
    writeFileSync(target, 'ORIGINAL\n');
    try {
      symlinkSync(target, join(repo, '.gitignore'));
    } catch {
      ctx.skip(); // symlinks need a privilege on this machine; reported as skipped, not passed
      return;
    }
    write(repo, { 'new.txt': 'n' });
    const r = await ignorePaths(repo, { paths: ['new.txt'], mode: 'file', untrack: false });
    expect(r.outcome).toBe('refused');
    expect(readFileSync(target, 'utf8')).toBe('ORIGINAL\n');
    expect(lstatSync(join(repo, '.gitignore')).isSymbolicLink()).toBe(true);
  });

  it('pins the old and the new .gitignore blobs under refs/gitslappin/undo/', async () => {
    const repo = baseRepo('ignore-int-pins');
    commit(repo, { '.gitignore': 'old-line\n' }, 'gitignore');
    write(repo, { 'a.log': 'x' });
    expect((await ignorePaths(repo, { paths: ['a.log'], mode: 'file', untrack: false })).outcome).toBe('done');
    const blobs = pinnedBlobs(repo);
    expect(blobs).toContain('old-line\n');
    expect(blobs).toContain(bytes(repo, '.gitignore').toString('utf8'));
  });
});

describe('stop tracking', () => {
  it('tracked + untrack: a staged deletion, worktree bytes unchanged, pattern written', async () => {
    const repo = baseRepo('ignore-int-untrack');
    write(repo, { 'src/app.js': 'a1\nEDITED\n' });
    const r = await ignorePaths(repo, { paths: ['src/app.js'], mode: 'file', untrack: true });
    expect(r.outcome).toBe('done');
    expect(porcelain(repo)).toContain('D  src/app.js');
    expect(cached(repo)).not.toContain('src/app.js');
    expect(cached(repo)).toContain('src/lib.js');
    expect(bytes(repo, 'src/app.js').toString()).toBe('a1\nEDITED\n');
    expect(bytes(repo, '.gitignore').toString('utf8')).toBe(`${EOL}src/app.js${EOL}`);
  });

  it('tracked without untrack: ignored in the file only, stays in the index', async () => {
    const repo = baseRepo('ignore-int-keep');
    write(repo, { 'src/app.js': 'changed\n' });
    expect((await ignorePaths(repo, { paths: ['src/app.js'], mode: 'file', untrack: false })).outcome).toBe('done');
    expect(cached(repo)).toContain('src/app.js');
  });

  it('literal pathspecs: untracking a file named "*.txt" untracks only that entry, never a.txt / b.txt', async () => {
    const repo = newRepo('ignore-int-literal');
    commit(repo, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'Base');
    // Windows cannot create a worktree file called "*.txt", so only the index entry exists (status shows it as deleted).
    const blob = git(repo, ['hash-object', '-w', '--stdin'], 'star\n').trim();
    git(repo, ['-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},*.txt`]);
    git(repo, ['commit', '-m', 'star']);
    expect(cached(repo)).toEqual(['*.txt', 'a.txt', 'b.txt']);
    expect(porcelain(repo)).toContain('*.txt');

    const r = await ignorePaths(repo, { paths: ['*.txt'], mode: 'file', untrack: true });
    expect(r.outcome).toBe('done');
    expect(cached(repo)).toEqual(['a.txt', 'b.txt']);
    expect(bytes(repo, 'a.txt').toString()).toBe('a\n');
    expect(bytes(repo, 'b.txt').toString()).toBe('b\n');
    expect(bytes(repo, '.gitignore').toString('utf8')).toBe(`${EOL}\\*.txt${EOL}`);
  });

  it('folder mode with untrack untracks only the tracked files in that folder, not other folders or untracked files', async () => {
    const repo = baseRepo('ignore-int-folder');
    write(repo, { 'src/app.js': 'a1\nEDITED\n', 'src/new.js': 'untracked\n', 'README.md': '# edited\n' });
    const r = await ignorePaths(repo, { paths: ['src'], mode: 'folder', untrack: true });
    expect(r.outcome).toBe('done');
    expect(cached(repo)).toEqual(['README.md', 'src/lib.js']);
    expect(bytes(repo, 'src/app.js').toString()).toBe('a1\nEDITED\n');
    expect(bytes(repo, 'src/lib.js').toString()).toBe('l1\n');
    expect(bytes(repo, 'src/new.js').toString()).toBe('untracked\n');
    expect(bytes(repo, '.gitignore').toString('utf8')).toBe(`${EOL}src/${EOL}`);
  });
});

describe('review fixes', () => {
  it('a tracked file that already matches an ignore rule is untracked with untrack', async () => {
    const repo = baseRepo('ignore-int-already-untrack');
    commit(repo, { '.gitignore': '*.js\n' }, 'gitignore');
    expect(cached(repo)).toContain('src/app.js');
    const before = bytes(repo, '.gitignore');
    const r = await ignorePaths(repo, { paths: ['src/app.js'], mode: 'file', untrack: true });
    expect(r.outcome).toBe('done');
    expect(cached(repo)).not.toContain('src/app.js');
    expect(cached(repo)).toContain('src/lib.js');
    expect(bytes(repo, '.gitignore').equals(before)).toBe(true);
  });

  it('folder mode writes exactly the clicked folder, even with no direct files, and validates it', async () => {
    const repo = baseRepo('ignore-int-deepfolder');
    write(repo, { 'deep/a/x.txt': '1', 'deep/b/y.txt': '2' });
    expect((await ignorePaths(repo, { paths: ['nodir'], mode: 'folder', untrack: false })).outcome).toBe('refused');
    expect((await ignorePaths(repo, { paths: ['../deep'], mode: 'folder', untrack: false })).outcome).toBe('refused');
    expect((await ignorePaths(repo, { paths: ['deep'], mode: 'folder', untrack: false })).outcome).toBe('done');
    expect(bytes(repo, '.gitignore').toString('utf8')).toBe(`${EOL}deep/${EOL}`);
  });

  it('folder untrack only takes the tracked files that are changed, not clean tracked ones', async () => {
    const repo = baseRepo('ignore-int-folder-changed');
    write(repo, { 'src/app.js': 'a1\nEDITED\n' });
    expect((await ignorePaths(repo, { paths: ['src'], mode: 'folder', untrack: true })).outcome).toBe('done');
    expect(cached(repo)).toEqual(['README.md', 'src/lib.js']);
  });
});

describe('undo / redo', () => {
  it('round trip with untrack: undo restores the old bytes and the index entry, redo re-applies; labels follow', async () => {
    const repo = baseRepo('ignore-int-roundtrip');
    commit(repo, { '.gitignore': 'old\n' }, 'gitignore');
    write(repo, { 'src/app.js': 'a1\nEDITED\n' });
    const indexBefore = git(repo, ['ls-files', '-s']);
    expect((await ignorePaths(repo, { paths: ['src/app.js'], mode: 'file', untrack: true })).outcome).toBe('done');
    const after = bytes(repo, '.gitignore');
    expect(undoState(repo).undo).toEqual({ label: "ignore 'app.js'" });

    expect((await undo(repo)).outcome).toBe('done');
    expect(bytes(repo, '.gitignore').toString()).toBe('old\n');
    expect(git(repo, ['ls-files', '-s'])).toBe(indexBefore);
    expect(bytes(repo, 'src/app.js').toString()).toBe('a1\nEDITED\n');
    expect(undoState(repo).redo).not.toBeNull();

    expect((await redo(repo)).outcome).toBe('done');
    expect(bytes(repo, '.gitignore').equals(after)).toBe(true);
    expect(cached(repo)).not.toContain('src/app.js');
  });

  it('label for several files is "ignore N files"', async () => {
    const repo = baseRepo('ignore-int-label');
    write(repo, { 'a.log': '1', 'b.log': '2' });
    expect((await ignorePaths(repo, { paths: ['a.log', 'b.log'], mode: 'file', untrack: false })).outcome).toBe('done');
    expect(undoState(repo).undo).toEqual({ label: 'ignore 2 files' });
  });

  it('undo is refused after a hand edit of .gitignore; nothing changes', async () => {
    const repo = baseRepo('ignore-int-handedit');
    commit(repo, { '.gitignore': 'old\n' }, 'gitignore');
    write(repo, { 'a.log': 'x' });
    expect((await ignorePaths(repo, { paths: ['a.log'], mode: 'file', untrack: false })).outcome).toBe('done');
    writeFileSync(join(repo, '.gitignore'), Buffer.concat([bytes(repo, '.gitignore'), Buffer.from('hand-written\n')]));
    const edited = bytes(repo, '.gitignore');
    const r = await undo(repo);
    expect(r.outcome).toBe('refused');
    expect(bytes(repo, '.gitignore').equals(edited)).toBe(true);
  });

  it('undo is refused when a removed index entry is back (re-added with -f); nothing changes', async () => {
    const repo = baseRepo('ignore-int-readded');
    write(repo, { 'src/app.js': 'a1\nEDITED\n' });
    expect((await ignorePaths(repo, { paths: ['src/app.js'], mode: 'file', untrack: true })).outcome).toBe('done');
    git(repo, ['add', '-f', 'src/app.js']);
    const idx = git(repo, ['ls-files', '-s']);
    const gi = bytes(repo, '.gitignore');
    expect((await undo(repo)).outcome).toBe('refused');
    expect(git(repo, ['ls-files', '-s'])).toBe(idx);
    expect(bytes(repo, '.gitignore').equals(gi)).toBe(true);
  });

  it('undo of a .gitignore GitSlappin created truncates it to empty and leaves it in place (never deletes)', async () => {
    const repo = baseRepo('ignore-int-created');
    write(repo, { 'a.log': 'x' });
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    expect((await ignorePaths(repo, { paths: ['a.log'], mode: 'file', untrack: false })).outcome).toBe('done');
    const created = bytes(repo, '.gitignore');
    expect(created.length).toBeGreaterThan(0);
    expect(pinnedBlobs(repo)).toContain(created.toString('utf8')); // the `after` blob is pinned

    expect((await undo(repo)).outcome).toBe('done');
    expect(existsSync(join(repo, '.gitignore'))).toBe(true);
    expect(bytes(repo, '.gitignore').length).toBe(0);
    expect(porcelain(repo)).toContain('a.log'); // visible again

    expect((await redo(repo)).outcome).toBe('done');
    expect(bytes(repo, '.gitignore').equals(created)).toBe(true);
  });

  it('undo of a created .gitignore is refused when its hash no longer equals `after`; the file keeps its content and is not unlinked', async () => {
    const repo = baseRepo('ignore-int-created-edit');
    write(repo, { 'a.log': 'x' });
    expect((await ignorePaths(repo, { paths: ['a.log'], mode: 'file', untrack: false })).outcome).toBe('done');
    writeFileSync(join(repo, '.gitignore'), `${EOL}a.log${EOL}my-own-rule${EOL}`);
    const edited = bytes(repo, '.gitignore');
    const r = await undo(repo);
    expect(r.outcome).toBe('refused');
    expect(existsSync(join(repo, '.gitignore'))).toBe(true);
    expect(bytes(repo, '.gitignore').equals(edited)).toBe(true);
  });
});

describe('temp-file rename failure', () => {
  // Drivable on Windows only: renaming over a read-only file fails with EPERM there. On POSIX the rename succeeds, so it is skipped (reported as skipped).
  it.skipIf(process.platform !== 'win32')(
    'fails closed with an error, leaves .gitignore bytes, the index and the temp file in place (nothing is deleted)',
    async () => {
      const repo = baseRepo('ignore-int-renamefail');
      commit(repo, { '.gitignore': 'old\n' }, 'gitignore');
      write(repo, { 'src/app.js': 'a1\nEDITED\n' });
      chmodSync(join(repo, '.gitignore'), 0o444);
      const names = entries(repo);
      const idx = git(repo, ['ls-files', '-s']);

      const r = await ignorePaths(repo, { paths: ['src/app.js'], mode: 'file', untrack: true });
      expect(r.outcome).toBe('failed');
      expect(typeof r.error).toBe('string');
      expect((r.error ?? '').length).toBeGreaterThan(0);
      expect(bytes(repo, '.gitignore').toString()).toBe('old\n');
      expect(git(repo, ['ls-files', '-s'])).toBe(idx); // untrack runs only after the write succeeded
      const now = entries(repo);
      const stray = now.filter((n) => !names.includes(n));
      expect(stray.length).toBeGreaterThanOrEqual(1); // the temp file is left, not cleaned up
      for (const n of stray) expect(bytes(repo, n).toString()).toContain('old'); // it holds the new content built from the old bytes
      expect(pinnedBlobs(repo)).toContain('old\n'); // the old file was pinned before the rename
      expect(tryGit(repo, ['rev-parse', 'HEAD'])).toBe(0);
    },
  );
});
