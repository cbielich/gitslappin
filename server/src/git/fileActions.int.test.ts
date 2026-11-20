import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { record, undo } from './undo';

vi.setConfig({ testTimeout: 120_000 });

/*
 * Commit File Menu and Editor, P1 (server). Black-box through buildApp + app.inject, real git, mkdtemp repos (style of mergeTool.int.test.ts).
 * Contract (spec "Commit File Menu and Editor.md" sections 4 and 6). The builder must provide:
 *   GET  /api/repos/:id/file-edit?path=                     200 { text, hash, bom, eol: 'lf'|'crlf' }   tracked regular file only
 *                                                            413 over 5 MB, 415 binary, 404 tracked but missing on disk, other refusals 4xx (unsafe path = 400)
 *   POST /api/repos/:id/file-edit/save { path, text, expectHash }   200 { backup, undoable }   409 on a stale hash
 *   POST /api/repos/:id/file/restore   { path, sha }                200 { backup, undoable, indexBackup }
 *   POST /api/repos/:id/file/delete    { path }                     200 { backup, undoable, trashPath }
 *   Undo goes through the existing POST /api/repos/:id/undo and GET /api/repos/:id/undo-state; labels:
 *     `edit file 'x'`, `restore file 'x'`, `delete file 'x'`.
 *   Injection point chosen by the test author for the fail-closed capture limit (spec: "injectable MAX_FILE_BYTES"):
 *     buildApp(config, { maxCaptureBytes?: number })   the largest working file (in bytes) the three routes will pin; bigger = refuse, change nothing.
 *   undo.ts: a `discard` journal entry may carry `label` and `indexTree`; undo uses `indexTree ?? snap^2` as the index source; a malformed or missing
 *     indexTree must be refused (never fall back to snap^2).
 * Status choices that the spec does not fix are asserted as ranges: a refusal is 4xx, a fail-closed capture is >= 400.
 * Isolation: every repo is made with mkdtemp under os.tmpdir()/gitslappin-tests, asserted new and empty. Nothing is deleted by the tests
 * (files are moved away with rename, never removed; the only removal is `git rm` while building a throwaway fixture commit).
 * UNVERIFIED (assumptions the builder should confirm): `hash` is the sha256 hex of the working bytes (as the merge tool's workingHash); save writes the
 * text exactly as sent (CRLF/mixed kept byte for byte) and prepends the BOM the working file had; `indexBackup` and `backup` are pinned under
 * refs/gitslappin/undo/<sha> like captureFile/pin do today; the "previous version saved as <sha>" log line is NOT tested (no log API named in the spec).
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

const CFG_DIR = fresh('gitcfg-fileactions-int');
const EMPTY_GLOBAL = join(CFG_DIR, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL, '');
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
});
delete process.env.GITSLAPPIN_TOKEN;

const git = (cwd: string, args: string[], input?: string | Buffer): string =>
  execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true, ...(input !== undefined ? { input } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
const gitBuf = (cwd: string, args: string[]): Buffer => execFileSync('git', args, { cwd, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const bytes = (repo: string, rel: string): Buffer => readFileSync(join(repo, ...rel.split('/')));
const head = (repo: string): string => git(repo, ['rev-parse', 'HEAD']).trim();
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const blobBytes = (repo: string, sha: string): Buffer => gitBuf(repo, ['cat-file', 'blob', sha]);
const objectExists = (repo: string, sha: string): boolean => /^[0-9a-f]{40,64}$/.test(sha) && tryGit(repo, ['cat-file', '-e', sha]).status === 0;
const pinnedRef = (repo: string, sha: string): boolean => tryGit(repo, ['rev-parse', '--verify', '-q', `refs/gitslappin/undo/${sha}`]).status === 0;
const indexBlob = (repo: string, rel: string): string => git(repo, ['ls-files', '-s', '--', rel]).split(/\s+/)[1] ?? '';
const indexMode = (repo: string, rel: string): string => git(repo, ['ls-files', '-s', '--', rel]).split(/\s+/)[0] ?? '';
const indexText = (repo: string, rel: string): string => git(repo, ['show', `:${rel}`]);
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

function commit(repo: string, files: Record<string, string | Buffer>, msg: string): string {
  for (const [rel, t] of Object.entries(files)) {
    const full = join(repo, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, t);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
  return head(repo);
}
function newRepo(prefix = 'fa'): string {
  const repo = join(fresh(prefix), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  for (const [k, v] of Object.entries({ 'user.name': 'Test Author', 'user.email': 'author@example.com', 'core.autocrlf': 'false', 'core.editor': 'false', 'core.symlinks': 'false' })) git(repo, ['config', k, v]);
  return repo;
}
/** c1: f.txt=one, sub/dir/g.txt=g1, old.txt, README.md.  c2 (HEAD): f.txt=two, new-in-c2.txt, old.txt removed. */
function std(): { repo: string; c1: string; c2: string } {
  const repo = newRepo();
  const c1 = commit(repo, { 'f.txt': 'one\n', 'sub/dir/g.txt': 'g1\n', 'old.txt': 'old\n', 'README.md': '# readme\n' }, 'c1');
  git(repo, ['rm', '-q', '--', 'old.txt']); // fixture only: builds the second commit of a throwaway repo
  const c2 = commit(repo, { 'f.txt': 'two\n', 'new-in-c2.txt': 'n\n' }, 'c2');
  return { repo, c1, c2 };
}
/** A tracked symlink entry (mode 120000) in the index with a plain file on disk, and a gitlink (160000) with an empty folder. */
function addOddEntries(repo: string, commitSha: string): void {
  const blob = git(repo, ['hash-object', '-w', '--stdin'], 'target-text').trim();
  git(repo, ['update-index', '--add', '--cacheinfo', `120000,${blob},lnk`]);
  git(repo, ['update-index', '--add', '--cacheinfo', `160000,${commitSha},sm`]);
  writeFileSync(join(repo, 'lnk'), 'target-text');
  mkdirSync(join(repo, 'sm'), { recursive: true });
  git(repo, ['commit', '-q', '-m', 'odd entries']);
}
/** Stops a merge so an operation is in progress. conflict:true leaves f.txt unmerged. */
function withMerge(conflict: boolean): { repo: string; c1: string } {
  const fx = std();
  git(fx.repo, ['switch', '-q', '-c', 'feature', fx.c1]);
  commit(fx.repo, conflict ? { 'f.txt': 'feat\n' } : { 'other.txt': 'o\n' }, 'feature side');
  git(fx.repo, ['switch', '-q', 'main']);
  tryGit(fx.repo, ['merge', '--no-ff', '--no-commit', 'feature']);
  if (!existsSync(join(fx.repo, '.git', 'MERGE_HEAD'))) throw new Error('fixture: merge should be in progress');
  if (conflict && git(fx.repo, ['ls-files', '-u']).trim() === '') throw new Error('fixture: f.txt should be unmerged');
  return { repo: fx.repo, c1: fx.c1 };
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (rel === '' && e.name === '.git') continue;
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}
/** HEAD, the whole index, the status and the hash of every working file: equal strings mean nothing changed. */
function world(repo: string): string {
  const files = walk(repo).map((r) => `${r}:${sha256(bytes(repo, r))}`);
  return [head(repo), git(repo, ['ls-files', '-s']), git(repo, ['status', '--porcelain']), ...files].join('\n--\n');
}
const trashRoot = (repo: string): string => join(repo, '.git', 'gitslappin-trash');
const trashDirs = (repo: string): string[] => (existsSync(trashRoot(repo)) ? readdirSync(trashRoot(repo)) : []);
/** Every trash copy of a repo-relative path: <gitdir>/gitslappin-trash/<ts>-<rand>/<path>. */
const trashCopies = (repo: string, rel: string): string[] => trashDirs(repo).map((d) => join(trashRoot(repo), d, ...rel.split('/'))).filter((p) => existsSync(p));

const PORT = 4981;
const HOST = `127.0.0.1:${PORT}`;
type AppOpts = { maxCaptureBytes?: number };
async function start(repo: string, appOpts: AppOpts = {}) {
  const app = await buildApp({ port: PORT, token: 'tok', dataDir: fresh('fa-data'), clientDist: join(tmpdir(), 'gitslappin-no-such-dist'), noOpen: true }, appOpts as never);
  const headers = { host: HOST, 'x-gitslappin-token': 'tok' };
  const opened = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: repo } });
  expect(opened.statusCode).toBe(200);
  const id = (opened.json() as { id: string }).id;
  const base = `/api/repos/${id}`;
  const get = (path: string) => app.inject({ method: 'GET', url: `${base}/file-edit?path=${encodeURIComponent(path)}`, headers });
  const post = (sub: string, payload?: unknown, h: Record<string, string> = headers) => app.inject({ method: 'POST', url: `${base}/${sub}`, headers: h, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const info = async (path: string) => (await get(path)).json() as Record<string, any>;
  const save = (path: string, text: unknown, expectHash: unknown) => post('file-edit/save', { path, text, expectHash });
  const restore = (path: string, sha: unknown) => post('file/restore', { path, sha });
  const del = (path: string) => post('file/delete', { path });
  const doUndo = () => post('undo');
  const undoLabel = async (): Promise<string | null> => ((await app.inject({ method: 'GET', url: `${base}/undo-state`, headers })).json() as { undo: { label: string } | null }).undo?.label ?? null;
  return { app, id, headers, base, get, post, info, save, restore, del, doUndo, undoLabel };
}
const refused = (res: { statusCode: number; body: string }, what: string): void => {
  expect(res.statusCode, `${what}: ${res.body}`).toBeGreaterThanOrEqual(400);
  expect(res.statusCode, `${what}: ${res.body}`).toBeLessThan(500);
};
const failedClosed = (res: { statusCode: number; body: string }, what: string): void => {
  expect(res.statusCode, `${what}: ${res.body}`).toBeGreaterThanOrEqual(400);
};
/** Every string value of a JSON body (so escaped backslashes compare like real paths), '\' turned into '/', lowercased. */
const flat = (bodyOrText: string): string => {
  const out: string[] = [];
  try {
    JSON.parse(bodyOrText, (_k, v) => {
      if (typeof v === 'string') out.push(v);
      return v;
    });
  } catch {
    out.push(bodyOrText);
  }
  return out.join('\n').replace(/\\/g, '/').toLowerCase();
};
const ok = (res: { statusCode: number; body: string }, what = ''): Record<string, any> => {
  expect(res.statusCode, `${what}: ${res.body}`).toBe(200);
  return JSON.parse(res.body) as Record<string, any>;
};

// ---------------------------------------------------------------------------------------------------------------------------------
describe('GET file-edit', () => {
  it('returns the working text, its sha256, bom and eol for a tracked file', async () => {
    const { repo } = std();
    const s = await start(repo);
    const body = await s.info('f.txt');
    expect(body.text).toBe('two\n');
    expect(body.hash).toBe(sha256(bytes(repo, 'f.txt')));
    expect(body.bom).toBe(false);
    expect(body.eol).toBe('lf');
  });

  it('reads the WORKING copy (an unsaved change on disk), not HEAD', async () => {
    const { repo } = std();
    writeFileSync(join(repo, 'f.txt'), 'three\n');
    const body = await (await start(repo)).info('f.txt');
    expect(body.text).toBe('three\n');
    expect(body.hash).toBe(sha256(Buffer.from('three\n')));
  });

  it('reports a BOM (stripped from text) and the majority EOL', async () => {
    const repo = newRepo();
    commit(repo, { 'bom.txt': Buffer.concat([BOM, Buffer.from('a\r\nb\r\n')]), 'mix.txt': 'a\r\nb\r\nc\n', 'plain.txt': 'x\ny\n' }, 'c1');
    const s = await start(repo);
    const b = await s.info('bom.txt');
    expect(b.bom).toBe(true);
    expect(b.eol).toBe('crlf');
    expect(String(b.text).charCodeAt(0)).not.toBe(0xfeff);
    expect(String(b.text).replace(/\r\n/g, '\n')).toBe('a\nb\n');
    expect(b.hash).toBe(sha256(bytes(repo, 'bom.txt'))); // the hash covers the real bytes, BOM included
    expect((await s.info('mix.txt')).eol).toBe('crlf');
    const p = await s.info('plain.txt');
    expect(p.bom).toBe(false);
    expect(p.eol).toBe('lf');
  });

  it('refuses everything that is not a tracked regular file (4xx, no text in the body)', async () => {
    const { repo, c2 } = std();
    addOddEntries(repo, c2);
    writeFileSync(join(repo, 'untracked.txt'), 'secret-untracked\n');
    mkdirSync(join(repo, 'plain-dir'));
    const gone = fresh('fa-gone');
    renameSync(join(repo, 'README.md'), join(gone, 'README.md')); // tracked, moved away (not deleted)
    const s = await start(repo);
    expect((await s.get('f.txt')).statusCode).toBe(200); // control: the route exists and works
    const cases: Array<[string, number | 'any4xx']> = [
      ['untracked.txt', 'any4xx'],
      ['sub', 'any4xx'],
      ['sub/', 'any4xx'],
      ['sub/dir', 'any4xx'],
      ['plain-dir', 'any4xx'],
      ['lnk', 'any4xx'], // index mode 120000 although a plain file sits on disk
      ['sm', 'any4xx'], // gitlink
      ['F.TXT', 'any4xx'], // exact ls-files match: a case variant of a tracked name is refused even on a case-insensitive disk
      ['*.txt', 'any4xx'],
      ['f.t[x]t', 'any4xx'], // literal pathspecs: no glob
      ['nope.txt', 'any4xx'],
      ['README.md', 404], // tracked, missing on disk
    ];
    for (const [path, want] of cases) {
      const res = await s.get(path);
      if (want === 'any4xx') refused(res, path);
      else expect(res.statusCode, `${path}: ${res.body}`).toBe(want);
      expect(res.body, path).not.toContain('secret-untracked');
      expect(JSON.parse(res.body).text, path).toBeUndefined();
    }
  });

  it('unsafe paths are 400 (safeRepoPath): traversal, .git, absolute, backslash, drive, device and 8.3 names, empty, missing', async () => {
    const { repo } = std();
    const s = await start(repo);
    expect((await s.get('f.txt')).statusCode).toBe(200); // control
    for (const p of ['../f.txt', 'sub/../../f.txt', '.git/config', '/etc/passwd', 'a\\b', 'C:/x', ':(glob)f.txt', 'CON', 'sub/Nul', 'PROGRA~1', 'f.txt\n', '']) {
      expect((await s.get(p)).statusCode, JSON.stringify(p)).toBe(400);
    }
    const noQuery = await s.app.inject({ method: 'GET', url: `${s.base}/file-edit`, headers: s.headers });
    expect(noQuery.statusCode).toBe(400);
  });

  it('413 over 5 MB and 415 for binary content (NUL byte, invalid UTF-8)', async () => {
    const repo = newRepo();
    commit(repo, { 'ok.txt': 'fine\n', 'big.txt': Buffer.alloc(5 * 1024 * 1024 + 1, 0x61), 'zero.bin': Buffer.from([0x61, 0, 0x62, 0x0a]), 'bad8.txt': Buffer.from([0x61, 0xff, 0xfe, 0x0a]) }, 'c1');
    const s = await start(repo);
    expect((await s.get('ok.txt')).statusCode).toBe(200); // control
    const big = await s.get('big.txt');
    expect(big.statusCode).toBe(413);
    expect(big.body.length).toBeLessThan(10_000); // the file is not echoed
    expect((await s.get('zero.bin')).statusCode).toBe(415);
    expect((await s.get('bad8.txt')).statusCode).toBe(415);
  });

  it('403 without the token or with a foreign Host, 404 for an unknown repo id', async () => {
    const { repo } = std();
    const s = await start(repo);
    const url = `${s.base}/file-edit?path=f.txt`;
    expect((await s.app.inject({ method: 'GET', url, headers: { host: HOST } })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'GET', url, headers: { ...s.headers, host: 'evil.example:80' } })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'GET', url: `/api/repos/${'f'.repeat(16)}/file-edit?path=f.txt`, headers: s.headers })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url, headers: s.headers })).statusCode).toBe(200); // control
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('POST file-edit/save', () => {
  it('writes the exact text, never stages or commits, and returns the old bytes pinned as backup', async () => {
    const { repo, c2 } = std();
    const s = await start(repo);
    const before = bytes(repo, 'f.txt');
    const { hash } = await s.info('f.txt');
    const indexBefore = git(repo, ['ls-files', '-s']);
    const res = await s.save('f.txt', 'two\nand more\n', hash);
    const body = ok(res);
    expect(bytes(repo, 'f.txt').equals(Buffer.from('two\nand more\n'))).toBe(true);
    expect(head(repo)).toBe(c2);
    expect(git(repo, ['ls-files', '-s'])).toBe(indexBefore);
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(git(repo, ['status', '--porcelain']).replace(/\r?\n$/, '')).toBe(' M f.txt'); // modified, not staged
    expect(body.undoable).toBe(true);
    expect(objectExists(repo, body.backup)).toBe(true);
    expect(blobBytes(repo, body.backup).equals(before)).toBe(true);
    expect(pinnedRef(repo, body.backup)).toBe(true);
    expect(await s.undoLabel()).toBe("edit file 'f.txt'");
  });

  it('leaves no temp file in the working tree (nothing untracked appears)', async () => {
    const { repo } = std();
    const s = await start(repo);
    const listing = (): string => JSON.stringify(readdirSync(repo).sort());
    const before = listing();
    ok(await s.save('f.txt', 'new\n', (await s.info('f.txt')).hash));
    expect(listing()).toBe(before);
    expect(git(repo, ['status', '--porcelain']).split('\n').filter((l) => l.startsWith('??'))).toEqual([]);
  });

  it('CRLF and mixed EOL text is written byte for byte', async () => {
    const repo = newRepo();
    commit(repo, { 'crlf.txt': 'a\r\nb\r\n' }, 'c1');
    const s = await start(repo);
    const mixed = 'one\r\ntwo\nthree\r\n';
    ok(await s.save('crlf.txt', mixed, (await s.info('crlf.txt')).hash));
    expect(bytes(repo, 'crlf.txt').equals(Buffer.from(mixed))).toBe(true);
  });

  it('keeps the BOM of the working file and never doubles it', async () => {
    const repo = newRepo();
    commit(repo, { 'bom.txt': Buffer.concat([BOM, Buffer.from('a\r\nb\r\n')]) }, 'c1');
    const s = await start(repo);
    const first = await s.save('bom.txt', 'new\r\n', (await s.info('bom.txt')).hash); // GET strips the BOM, so the client sends text without it
    ok(first);
    expect(bytes(repo, 'bom.txt').equals(Buffer.concat([BOM, Buffer.from('new\r\n')]))).toBe(true);
    ok(await s.save('bom.txt', '\uFEFFagain\r\n', (await s.info('bom.txt')).hash));
    expect(bytes(repo, 'bom.txt').equals(Buffer.concat([BOM, Buffer.from('again\r\n')]))).toBe(true);
  });

  it('409 for a stale hash: nothing is written, nothing is journaled; a missing hash is 409 too', async () => {
    const { repo } = std();
    const s = await start(repo);
    const { hash } = await s.info('f.txt');
    writeFileSync(join(repo, 'f.txt'), 'edited elsewhere\n');
    const world0 = world(repo);
    const stale = await s.save('f.txt', 'mine\n', hash);
    expect(stale.statusCode).toBe(409);
    expect((await s.post('file-edit/save', { path: 'f.txt', text: 'mine\n' })).statusCode).toBe(409);
    expect(world(repo)).toBe(world0);
    expect(await s.undoLabel()).toBeNull();
    const fresh1 = await s.info('f.txt'); // control: with the current hash the same call works
    ok(await s.save('f.txt', 'mine\n', fresh1.hash));
    expect(bytes(repo, 'f.txt').equals(Buffer.from('mine\n'))).toBe(true);
  });

  it('refuses untracked, directory, symlink-mode, gitlink, missing, unsafe and unknown paths; a missing file is never created', async () => {
    const { repo, c2 } = std();
    addOddEntries(repo, c2);
    writeFileSync(join(repo, 'untracked.txt'), 'u\n');
    const gone = fresh('fa-gone-save');
    renameSync(join(repo, 'README.md'), join(gone, 'README.md'));
    const s = await start(repo);
    const world0 = world(repo);
    const h = sha256('u\n');
    for (const path of ['untracked.txt', 'sub', 'sub/', 'sub/dir', 'lnk', 'sm', 'F.TXT', '*.txt', 'nope.txt', 'README.md', '../f.txt', '.git/config', 'CON', 'a\\b', 'C:/x']) {
      for (const expectHash of [h, 'missing', sha256(bytes(repo, 'f.txt'))]) {
        refused(await s.save(path, 'overwritten\n', expectHash), `${path} / ${expectHash.slice(0, 7)}`);
      }
    }
    expect(existsSync(join(repo, 'README.md'))).toBe(false); // never creates
    expect(world(repo)).toBe(world0);
    expect(await s.undoLabel()).toBeNull();
    ok(await s.save('f.txt', 'control\n', (await s.info('f.txt')).hash)); // control: a legitimate save works
  });

  it('rejects bad bodies (no path, text not a string, lone surrogate, NUL) and changes nothing', async () => {
    const { repo } = std();
    const s = await start(repo);
    const { hash } = await s.info('f.txt');
    const world0 = world(repo);
    expect((await s.post('file-edit/save', {})).statusCode).toBe(400);
    expect((await s.post('file-edit/save', { path: 7, text: 'x', expectHash: hash })).statusCode).toBe(400);
    expect((await s.post('file-edit/save', { path: 'f.txt', text: 5, expectHash: hash })).statusCode).toBe(400);
    for (const text of ['ab\uD800cd\n', 'ab\uDC00\n', 'a\0b\n']) refused(await s.save('f.txt', text, hash), JSON.stringify(text));
    expect(world(repo)).toBe(world0);
    ok(await s.save('f.txt', 'control\n', hash)); // control
  });

  it('a working file over 5 MB is 413: bytes unchanged, nothing pinned, nothing journaled', async () => {
    const repo = newRepo();
    commit(repo, { 'big.txt': Buffer.alloc(5 * 1024 * 1024 + 1, 0x61), 'small.txt': 'a\n' }, 'c1');
    const s = await start(repo);
    const before = bytes(repo, 'big.txt');
    const res = await s.save('big.txt', 'short\n', sha256(before));
    expect(res.statusCode, res.body.slice(0, 200)).toBe(413);
    expect(bytes(repo, 'big.txt').equals(before)).toBe(true);
    expect(git(repo, ['for-each-ref', 'refs/gitslappin/undo/']).trim()).toBe('');
    expect(await s.undoLabel()).toBeNull();
    ok(await s.save('small.txt', 'b\n', (await s.info('small.txt')).hash), 'control: a small file saves'); // and that one does pin
    expect(git(repo, ['for-each-ref', 'refs/gitslappin/undo/']).trim()).not.toBe('');
  });

  it('the save cap is min(5 MB, maxCaptureBytes): a 2 MB file with a 1 MB limit is 413 too', async () => {
    const repo = newRepo();
    commit(repo, { 'mid.txt': Buffer.alloc(2 * 1024 * 1024, 0x61), 'small.txt': 'a\n' }, 'c1');
    const s = await start(repo, { maxCaptureBytes: 1024 * 1024 });
    const before = bytes(repo, 'mid.txt');
    const res = await s.save('mid.txt', 'short\n', sha256(before));
    expect(res.statusCode, res.body.slice(0, 200)).toBe(413);
    expect(bytes(repo, 'mid.txt').equals(before)).toBe(true);
    expect(git(repo, ['for-each-ref', 'refs/gitslappin/undo/']).trim()).toBe('');
    ok(await s.save('small.txt', 'b\n', (await s.info('small.txt')).hash), 'control: below both limits it saves');
  });

  it('is refused while an operation is in progress, and while the file is unmerged; the file is untouched', async () => {
    for (const conflict of [false, true]) {
      const { repo } = withMerge(conflict);
      const s = await start(repo);
      const readme = sha256(bytes(repo, 'README.md'));
      const world0 = world(repo);
      refused(await s.save('README.md', 'x\n', readme), `merge in progress, conflict=${conflict}`);
      if (conflict) refused(await s.save('f.txt', 'x\n', sha256(bytes(repo, 'f.txt'))), 'unmerged f.txt');
      expect(world(repo)).toBe(world0);
      // control: the same call is accepted once the operation is over
      git(repo, ['merge', '--abort']);
      ok(await s.save('README.md', 'x\n', sha256(bytes(repo, 'README.md'))), 'after merge --abort');
    }
  });

  it('a parent folder that is a link out of the repo is refused and the outside file is untouched', async () => {
    const { repo } = std();
    const outside = fresh('fa-outside-save');
    renameSync(join(repo, 'sub'), join(outside, 'sub'));
    symlinkSync(join(outside, 'sub'), join(repo, 'sub'), 'junction');
    const s = await start(repo);
    failedClosed(await s.save('sub/dir/g.txt', 'pwned\n', sha256('g1\n')), 'save through a link');
    expect(readFileSync(join(outside, 'sub', 'dir', 'g.txt'), 'utf8')).toBe('g1\n');
    const got = await s.get('sub/dir/g.txt');
    failedClosed(got, 'read through a link');
    expect(got.body).not.toContain('g1');
  });

  it('undo: puts the old bytes back, leaves the index alone, and clears the entry', async () => {
    const { repo } = std();
    const s = await start(repo);
    const before = bytes(repo, 'f.txt');
    const indexBefore = git(repo, ['ls-files', '-s']);
    ok(await s.save('f.txt', 'changed\n', (await s.info('f.txt')).hash));
    expect(await s.undoLabel()).toBe("edit file 'f.txt'");
    const res = await s.doUndo();
    expect(res.statusCode, res.body).toBe(200);
    expect(bytes(repo, 'f.txt').equals(before)).toBe(true);
    expect(git(repo, ['ls-files', '-s'])).toBe(indexBefore);
    expect(await s.undoLabel()).toBeNull();
  });

  it('undo is refused (409) after the file was edited outside, and the outside edit survives', async () => {
    const { repo } = std();
    const s = await start(repo);
    ok(await s.save('f.txt', 'changed\n', (await s.info('f.txt')).hash));
    writeFileSync(join(repo, 'f.txt'), 'outside edit\n');
    const res = await s.doUndo();
    expect(res.statusCode, res.body).toBe(409);
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('outside edit\n');
  });

  it('undo is refused (409) after the index changed, and the file keeps the saved text', async () => {
    const { repo } = std();
    const s = await start(repo);
    ok(await s.save('f.txt', 'changed\n', (await s.info('f.txt')).hash));
    git(repo, ['add', 'f.txt']);
    const res = await s.doUndo();
    expect(res.statusCode, res.body).toBe(409);
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('changed\n');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('file-edit: a tracked path that is no longer a regular file on disk', () => {
  const MSG = 'Only regular files can be edited here.';

  it('replaced by a directory: GET and save are 4xx with the "Only regular files" text; nothing is written', async () => {
    const { repo } = std();
    const away = fresh('fa-moved-away');
    const hash = sha256(bytes(repo, 'f.txt'));
    renameSync(join(repo, 'f.txt'), join(away, 'f.txt')); // moved away, not deleted
    mkdirSync(join(repo, 'f.txt'));
    writeFileSync(join(repo, 'f.txt', 'inner.txt'), 'inner\n');
    const s = await start(repo);
    const got = await s.get('f.txt');
    refused(got, 'GET a directory');
    expect(flat(got.body)).toContain(MSG.toLowerCase());
    const saved = await s.save('f.txt', 'x\n', hash);
    refused(saved, 'save over a directory');
    expect(flat(saved.body)).toContain(MSG.toLowerCase());
    expect(readdirSync(join(repo, 'f.txt'))).toEqual(['inner.txt']);
    expect(readFileSync(join(repo, 'f.txt', 'inner.txt'), 'utf8')).toBe('inner\n');
    expect(readFileSync(join(away, 'f.txt'), 'utf8')).toBe('two\n');
    expect(await s.undoLabel()).toBeNull();
    expect((await s.get('README.md')).statusCode).toBe(200); // control: the route works for a regular file
  });

  it('replaced by a link (junction on Windows, symlink elsewhere): GET and save are 4xx with the same text; the link target is untouched', async () => {
    const { repo } = std();
    const away = fresh('fa-moved-away-link');
    const outside = fresh('fa-link-target');
    writeFileSync(join(outside, 'secret.txt'), 'outside secret\n');
    const hash = sha256(bytes(repo, 'f.txt'));
    renameSync(join(repo, 'f.txt'), join(away, 'f.txt'));
    symlinkSync(outside, join(repo, 'f.txt'), 'junction');
    const s = await start(repo);
    const got = await s.get('f.txt');
    refused(got, 'GET a link');
    expect(flat(got.body)).toContain(MSG.toLowerCase());
    expect(got.body).not.toContain('outside secret');
    const saved = await s.save('f.txt', 'x\n', hash);
    refused(saved, 'save over a link');
    expect(flat(saved.body)).toContain(MSG.toLowerCase());
    expect(readdirSync(outside)).toEqual(['secret.txt']);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside secret\n');
    expect((await s.get('README.md')).statusCode).toBe(200); // control
  });
});

describe('POST file/restore', () => {
  it('puts the commit version into the working copy AND the index, keeps HEAD, returns pinned backups', async () => {
    const { repo, c1, c2 } = std();
    const s = await start(repo);
    const body = ok(await s.restore('f.txt', c1));
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('one\n');
    expect(indexText(repo, 'f.txt')).toBe('one\n');
    expect(head(repo)).toBe(c2);
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('f.txt'); // the index now differs from HEAD
    expect(body.undoable).toBe(true);
    expect(blobBytes(repo, body.backup).toString()).toBe('two\n'); // the working bytes before
    expect(pinnedRef(repo, body.backup)).toBe(true);
    expect(objectExists(repo, body.indexBackup)).toBe(true);
    expect(pinnedRef(repo, body.indexBackup)).toBe(true);
    expect(await s.undoLabel()).toBe("restore file 'f.txt'");
  });

  it('a restore that changes nothing (working file and index already match the commit) is 200 changed:false undoable:false, bytes unchanged, nothing journaled', async () => {
    const { repo, c2 } = std();
    const s = await start(repo);
    const world0 = world(repo);
    const body = ok(await s.restore('f.txt', c2)); // HEAD is c2 and f.txt is clean
    expect(body.changed).toBe(false);
    expect(body.undoable).toBe(false);
    expect(world(repo)).toBe(world0);
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('two\n');
    expect(await s.undoLabel()).toBeNull();
  });

  it('a file in a sub folder; only the named path is touched', async () => {
    const { repo, c1 } = std();
    writeFileSync(join(repo, 'sub', 'dir', 'g.txt'), 'dirty g\n');
    writeFileSync(join(repo, 'f.txt'), 'dirty f\n');
    const s = await start(repo);
    ok(await s.restore('sub/dir/g.txt', c1));
    expect(readFileSync(join(repo, 'sub', 'dir', 'g.txt'), 'utf8')).toBe('g1\n');
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('dirty f\n');
  });

  it('a file that no longer exists at HEAD comes back (working copy and index)', async () => {
    const { repo, c1 } = std();
    expect(existsSync(join(repo, 'old.txt'))).toBe(false);
    const s = await start(repo);
    ok(await s.restore('old.txt', c1));
    expect(readFileSync(join(repo, 'old.txt'), 'utf8')).toBe('old\n');
    expect(indexText(repo, 'old.txt')).toBe('old\n');
  });

  it('keeps the executable bit of the commit entry in the index', async () => {
    const repo = newRepo();
    commit(repo, { 'run.sh': '#!/bin/sh\necho 1\n' }, 'c1');
    git(repo, ['update-index', '--chmod=+x', 'run.sh']);
    git(repo, ['commit', '-q', '-m', 'exec']);
    const exec = head(repo);
    writeFileSync(join(repo, 'run.sh'), 'changed\n');
    git(repo, ['update-index', '--chmod=-x', 'run.sh']);
    const s = await start(repo);
    ok(await s.restore('run.sh', exec));
    expect(readFileSync(join(repo, 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho 1\n');
    expect(indexMode(repo, 'run.sh')).toBe('100755');
  });

  it('undo gives back BOTH the unstaged bytes and the staged version (indexTree)', async () => {
    const { repo, c1, c2 } = std();
    writeFileSync(join(repo, 'f.txt'), 'three\n');
    git(repo, ['add', 'f.txt']); // staged: three
    writeFileSync(join(repo, 'f.txt'), 'four\n'); // working: four
    const s = await start(repo);
    const body = ok(await s.restore('f.txt', c1));
    expect(blobBytes(repo, body.backup).toString()).toBe('four\n');
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('one\n');
    expect(indexText(repo, 'f.txt')).toBe('one\n');
    const res = await s.doUndo();
    expect(res.statusCode, res.body).toBe(200);
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('four\n');
    expect(indexText(repo, 'f.txt')).toBe('three\n');
    expect(head(repo)).toBe(c2);
    expect(await s.undoLabel()).toBeNull();
  });

  it('undo of a restore that brought back a deleted path removes it again, working copy and index', async () => {
    const { repo, c1 } = std();
    const s = await start(repo);
    ok(await s.restore('old.txt', c1));
    const res = await s.doUndo();
    expect(res.statusCode, res.body).toBe(200);
    expect(existsSync(join(repo, 'old.txt'))).toBe(false);
    expect(git(repo, ['ls-files', '--', 'old.txt']).trim()).toBe('');
  });

  it('undo is refused when the file was edited again after the restore, or the index changed', async () => {
    const a = std();
    const sa = await start(a.repo);
    ok(await sa.restore('f.txt', a.c1));
    writeFileSync(join(a.repo, 'f.txt'), 'edited after\n');
    expect((await sa.doUndo()).statusCode).toBe(409);
    expect(readFileSync(join(a.repo, 'f.txt'), 'utf8')).toBe('edited after\n');

    const b = std();
    const sb = await start(b.repo);
    ok(await sb.restore('f.txt', b.c1));
    git(b.repo, ['add', 'README.md']);
    writeFileSync(join(b.repo, 'README.md'), '# changed\n');
    git(b.repo, ['add', 'README.md']);
    expect((await sb.doUndo()).statusCode).toBe(409);
    expect(readFileSync(join(b.repo, 'f.txt'), 'utf8')).toBe('one\n');
  });

  it('refuses a sha that is not 40-64 lowercase hex or not a commit; nothing changes', async () => {
    const { repo, c1 } = std();
    const s = await start(repo);
    const tree = git(repo, ['rev-parse', `${c1}^{tree}`]).trim();
    const blob = git(repo, ['rev-parse', `${c1}:f.txt`]).trim();
    const world0 = world(repo);
    for (const sha of ['main', 'HEAD', 'HEAD~1', c1.slice(0, 12), c1.slice(0, 7), '--help', `${c1}^`, 'a'.repeat(40), 'a'.repeat(65), tree, blob, '', 7, null]) {
      refused(await s.restore('f.txt', sha), JSON.stringify(sha));
    }
    expect((await s.post('file/restore', { path: 'f.txt' })).statusCode).toBe(400);
    expect(world(repo)).toBe(world0);
    expect(await s.undoLabel()).toBeNull();
    ok(await s.restore('f.txt', c1)); // control
  });

  it('refuses directories (also with a trailing slash), a path that is not in that commit, and unsafe paths', async () => {
    const { repo, c1 } = std();
    writeFileSync(join(repo, 'sub', 'dir', 'g.txt'), 'dirty g\n');
    const s = await start(repo);
    const world0 = world(repo);
    for (const path of ['sub', 'sub/', 'sub/dir', 'sub/dir/', 'f.txt/', 'sub/dir/g.txt/', 'new-in-c2.txt', 'nope.txt', 'F.TXT', '*.txt', 'f.t[x]t', '../f.txt', '.git/config', 'CON', 'a\\b', 'C:/x', '']) {
      refused(await s.restore(path, c1), JSON.stringify(path));
    }
    expect(world(repo)).toBe(world0);
    expect(await s.undoLabel()).toBeNull();
    ok(await s.restore('f.txt', c1)); // control
  });

  it('refuses a gitlink (160000) and a symlink (120000) entry of the commit', async () => {
    const { repo, c1, c2 } = std();
    addOddEntries(repo, c2);
    const odd = head(repo);
    writeFileSync(join(repo, 'lnk'), 'changed link text');
    const s = await start(repo);
    const world0 = world(repo);
    refused(await s.restore('sm', odd), 'gitlink');
    refused(await s.restore('lnk', odd), 'symlink');
    expect(world(repo)).toBe(world0);
    ok(await s.restore('f.txt', c1), 'control: a regular file of another commit');
  });

  it('refuses a path whose index entry is intent-to-add (git add -N); the entry stays as it was', async () => {
    const { repo, c1 } = std();
    const s = await start(repo);
    ok(await s.restore('sub/dir/g.txt', c1), 'control (before the intent-to-add entry exists): the route works');
    git(repo, ['rm', '-q', '--cached', '--', 'f.txt']); // fixture: f.txt leaves the index but stays on disk
    git(repo, ['add', '-N', '--', 'f.txt']);
    expect(indexBlob(repo, 'f.txt')).toBe(EMPTY_BLOB); // fixture check: it is an intent-to-add entry
    const world0 = world(repo);
    const res = await s.restore('f.txt', c1);
    refused(res, 'intent-to-add');
    expect(res.statusCode).not.toBe(404);
    expect(world(repo)).toBe(world0);
    expect(indexBlob(repo, 'f.txt')).toBe(EMPTY_BLOB);
  });

  it('is refused while an operation is in progress or the repo has unmerged files', async () => {
    for (const conflict of [false, true]) {
      const { repo, c1 } = withMerge(conflict);
      const s = await start(repo);
      const world0 = world(repo);
      refused(await s.restore('README.md', c1), `conflict=${conflict}`);
      expect(world(repo)).toBe(world0);
      git(repo, ['merge', '--abort']);
      ok(await s.restore('README.md', c1), 'control after merge --abort');
    }
  });

  it('a parent folder that is a link out of the repo is refused and the outside file is untouched', async () => {
    const { repo, c1 } = std();
    const outside = fresh('fa-outside-restore');
    writeFileSync(join(repo, 'sub', 'dir', 'g.txt'), 'dirty g\n');
    renameSync(join(repo, 'sub'), join(outside, 'sub'));
    symlinkSync(join(outside, 'sub'), join(repo, 'sub'), 'junction');
    const s = await start(repo);
    failedClosed(await s.restore('sub/dir/g.txt', c1), 'restore through a link');
    expect(readFileSync(join(outside, 'sub', 'dir', 'g.txt'), 'utf8')).toBe('dirty g\n');
  });

  it('rejects bad bodies with 400', async () => {
    const { repo } = std();
    const s = await start(repo);
    expect((await s.post('file/restore', {})).statusCode).toBe(400);
    expect((await s.post('file/restore', { path: 5, sha: 'a'.repeat(40) })).statusCode).toBe(400);
    expect((await s.post('file/restore', [])).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('undo of a discard entry: indexTree validation (journal entry recorded directly, as restore will)', () => {
  /** Builds the state right after a restore: staged `three`, working `four`, restored to c1. Returns what a restore would have journaled. */
  function afterRestore(): { repo: string; c1: string; entry: Record<string, unknown>; stagedTree: string } {
    const { repo, c1 } = std();
    writeFileSync(join(repo, 'f.txt'), 'three\n');
    git(repo, ['add', 'f.txt']);
    writeFileSync(join(repo, 'f.txt'), 'four\n');
    const stagedTree = git(repo, ['write-tree']).trim();
    const blob = git(repo, ['hash-object', '-w', '--no-filters', '--stdin'], 'four\n').trim();
    const snap = git(repo, ['stash', 'create']).trim(); // a stash commit; its ^2 is the index commit and holds the staged `three`, so snap^2 would be a working source if indexTree were ignored
    git(repo, ['restore', `--source=${c1}`, '--staged', '--worktree', '--', 'f.txt']);
    const post = `f:${git(repo, ['hash-object', '--no-filters', '--stdin'], 'one\n').trim()}`;
    const entry = {
      kind: 'discard',
      head: head(repo),
      snap,
      files: [{ path: 'f.txt', blob, symlink: false, exec: false, tracked: true, post }],
      indexAfter: git(repo, ['write-tree']).trim(),
      label: "restore file 'f.txt'",
    };
    return { repo, c1, entry, stagedTree };
  }

  it('a malformed indexTree is refused even though snap^2 would work; nothing changes', async () => {
    for (const indexTree of ['not-a-sha', 'ZZZZ', '--help', '', 'a'.repeat(39), `${'a'.repeat(40)} extra`]) {
      const { repo, entry } = afterRestore();
      record(repo, { ...entry, indexTree } as never);
      const world0 = world(repo);
      const res = await undo(repo);
      expect(res.outcome, JSON.stringify(indexTree)).toBe('refused');
      expect(world(repo), JSON.stringify(indexTree)).toBe(world0);
    }
  });

  it('a well-formed indexTree whose object is missing is refused; nothing changes', async () => {
    const { repo, entry } = afterRestore();
    record(repo, { ...entry, indexTree: 'b'.repeat(40) } as never);
    const world0 = world(repo);
    expect((await undo(repo)).outcome).toBe('refused');
    expect(world(repo)).toBe(world0);
  });

  it('a valid indexTree is used as the index source (works with no snap at all)', async () => {
    const { repo, entry, stagedTree } = afterRestore();
    record(repo, { ...entry, snap: null, indexTree: stagedTree } as never);
    const res = await undo(repo);
    expect(res.outcome, JSON.stringify(res)).toBe('done');
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('four\n');
    expect(indexText(repo, 'f.txt')).toBe('three\n');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('POST file/delete', () => {
  it('moves the file (with its unsaved changes) to <gitdir>/gitslappin-trash/<ts>-<rand>/<path>; index and HEAD untouched', async () => {
    const { repo, c2 } = std();
    writeFileSync(join(repo, 'f.txt'), 'dirty bytes\n');
    const indexBefore = git(repo, ['ls-files', '-s']);
    const s = await start(repo);
    const body = ok(await s.del('f.txt'));
    expect(existsSync(join(repo, 'f.txt'))).toBe(false);
    const copies = trashCopies(repo, 'f.txt');
    expect(copies).toHaveLength(1);
    expect(readFileSync(copies[0]!, 'utf8')).toBe('dirty bytes\n');
    expect(typeof body.trashPath).toBe('string');
    expect(body.trashPath.length).toBeGreaterThan(0);
    expect(head(repo)).toBe(c2);
    expect(git(repo, ['ls-files', '-s'])).toBe(indexBefore); // still tracked: the deletion shows as an unstaged change
    expect(git(repo, ['status', '--porcelain']).replace(/\r?\n$/, '')).toBe(' D f.txt'); // deleted, not staged
    expect(body.undoable).toBe(true);
    expect(blobBytes(repo, body.backup).toString()).toBe('dirty bytes\n');
    expect(pinnedRef(repo, body.backup)).toBe(true);
    expect(await s.undoLabel()).toBe("delete file 'f.txt'");
  });

  it('a nested file keeps its folders in the trash and its sibling folders stay in the repo', async () => {
    const { repo } = std();
    const s = await start(repo);
    ok(await s.del('sub/dir/g.txt'));
    const copies = trashCopies(repo, 'sub/dir/g.txt');
    expect(copies).toHaveLength(1);
    expect(readFileSync(copies[0]!, 'utf8')).toBe('g1\n');
    expect(existsSync(join(repo, 'sub', 'dir'))).toBe(true); // no rmdir
    expect(bytes(repo, 'f.txt').toString()).toBe('two\n'); // other files untouched
  });

  it('two deletes of the same path keep both copies (the trash is never pruned or overwritten)', async () => {
    const { repo } = std();
    const s = await start(repo);
    ok(await s.del('f.txt'));
    writeFileSync(join(repo, 'f.txt'), 'second life\n'); // fixture: the user recreated it
    ok(await s.del('f.txt'));
    const texts = trashCopies(repo, 'f.txt').map((p) => readFileSync(p, 'utf8')).sort();
    expect(texts).toEqual(['second life\n', 'two\n']);
  });

  it('undo puts the bytes back (index untouched) and the trash copy stays', async () => {
    const { repo } = std();
    const s = await start(repo);
    const indexBefore = git(repo, ['ls-files', '-s']);
    ok(await s.del('f.txt'));
    const res = await s.doUndo();
    expect(res.statusCode, res.body).toBe(200);
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('two\n');
    expect(git(repo, ['ls-files', '-s'])).toBe(indexBefore);
    expect(git(repo, ['status', '--porcelain']).trim()).toBe('');
    expect(trashCopies(repo, 'f.txt')).toHaveLength(1); // never pruned
    expect(await s.undoLabel()).toBeNull();
  });

  it('undo is refused (409) when something else now sits at the path, which is left alone', async () => {
    const { repo } = std();
    const s = await start(repo);
    ok(await s.del('f.txt'));
    writeFileSync(join(repo, 'f.txt'), 'someone recreated me\n');
    const res = await s.doUndo();
    expect(res.statusCode, res.body).toBe(409);
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('someone recreated me\n');
  });

  it('refuses untracked, directory, symlink-mode, gitlink, missing, unsafe and unknown paths; nothing moves', async () => {
    const { repo, c2 } = std();
    addOddEntries(repo, c2);
    writeFileSync(join(repo, 'untracked.txt'), 'u\n');
    const gone = fresh('fa-gone-del');
    renameSync(join(repo, 'README.md'), join(gone, 'README.md'));
    const s = await start(repo);
    const world0 = world(repo);
    for (const path of ['untracked.txt', 'sub', 'sub/', 'sub/dir', 'lnk', 'sm', 'F.TXT', '*.txt', 'f.t[x]t', 'nope.txt', 'README.md', '../f.txt', '.git/config', 'CON', 'a\\b', 'C:/x', '']) {
      refused(await s.del(path), JSON.stringify(path));
    }
    expect(world(repo)).toBe(world0);
    expect(trashDirs(repo)).toEqual([]);
    expect(await s.undoLabel()).toBeNull();
    ok(await s.del('f.txt'), 'control: a tracked regular file is deleted');
    expect((await s.post('file/delete', {})).statusCode).toBe(400);
    expect((await s.post('file/delete', { path: 5 })).statusCode).toBe(400);
  });

  it('is refused while an operation is in progress or the repo has unmerged files', async () => {
    for (const conflict of [false, true]) {
      const { repo } = withMerge(conflict);
      const s = await start(repo);
      const world0 = world(repo);
      refused(await s.del('README.md'), `conflict=${conflict}`);
      expect(world(repo)).toBe(world0);
      expect(trashDirs(repo)).toEqual([]);
      git(repo, ['merge', '--abort']);
      ok(await s.del('README.md'), 'control after merge --abort');
    }
  });

  it('a trash folder that is a junction/link to somewhere outside the git dir is refused: the file stays and nothing lands outside', async () => {
    const { repo } = std();
    const outside = fresh('fa-outside-trash');
    symlinkSync(outside, trashRoot(repo), 'junction'); // portable: a junction on Windows (no admin needed), a symlink elsewhere
    const s = await start(repo);
    const res = await s.del('f.txt');
    failedClosed(res, 'delete with a linked trash folder');
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('two\n');
    expect(readdirSync(outside)).toEqual([]);
    expect(await s.undoLabel()).toBeNull();
  });

  it('a parent folder that is a link out of the repo is refused: the outside file stays and no trash copy is made', async () => {
    const { repo } = std();
    const outside = fresh('fa-outside-del');
    renameSync(join(repo, 'sub'), join(outside, 'sub'));
    symlinkSync(join(outside, 'sub'), join(repo, 'sub'), 'junction');
    const s = await start(repo);
    failedClosed(await s.del('sub/dir/g.txt'), 'delete through a link');
    expect(readFileSync(join(outside, 'sub', 'dir', 'g.txt'), 'utf8')).toBe('g1\n');
    expect(trashCopies(repo, 'sub/dir/g.txt')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('fail closed: when the old bytes cannot be pinned, nothing changes (injected maxCaptureBytes)', () => {
  function limitedRepo(): { repo: string; c1: string } {
    const repo = newRepo();
    const c1 = commit(repo, { 'small.txt': 'a\n', 'big.txt': `${'x'.repeat(100)}1\n`, 'small2.txt': 'b\n', 'small3.txt': 'c\n' }, 'c1');
    commit(repo, { 'small.txt': 'a2\n', 'big.txt': `${'x'.repeat(100)}2\n`, 'small2.txt': 'b2\n', 'small3.txt': 'c2\n' }, 'c2');
    return { repo, c1 };
  }

  it('save, restore and delete of a file over the limit are refused; the same calls on a small file work', async () => {
    const { repo, c1 } = limitedRepo();
    const s = await start(repo, { maxCaptureBytes: 10 });
    const big = await s.info('big.txt');
    expect(big.text.length).toBeGreaterThan(10); // control: the read route is not limited, so the file really is bigger than the limit
    const world0 = world(repo);
    failedClosed(await s.save('big.txt', 'short\n', big.hash), 'save big');
    failedClosed(await s.restore('big.txt', c1), 'restore big');
    failedClosed(await s.del('big.txt'), 'delete big');
    expect(world(repo)).toBe(world0);
    expect(trashDirs(repo)).toEqual([]);
    expect(await s.undoLabel()).toBeNull();
    // controls: below the limit, each route does its job (so the refusals above came from the limit)
    ok(await s.save('small.txt', 'z\n', (await s.info('small.txt')).hash), 'save small');
    ok(await s.restore('small2.txt', c1), 'restore small');
    ok(await s.del('small3.txt'), 'delete small');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('security and error bodies', () => {
  const ROUTES: Array<[string, unknown]> = [
    ['file-edit/save', { path: 'f.txt', text: 'x\n', expectHash: 'a'.repeat(64) }],
    ['file/restore', { path: 'f.txt', sha: 'a'.repeat(40) }],
    ['file/delete', { path: 'f.txt' }],
  ];

  it.each(ROUTES)('%s: 403 without the token, with a wrong token, a foreign Host or a foreign Origin; 404 for an unknown repo; nothing changes', async (sub, payload) => {
    const { repo } = std();
    const s = await start(repo);
    const world0 = world(repo);
    const url = `${s.base}/${sub}`;
    const go = (h: Record<string, string>, u = url) => s.app.inject({ method: 'POST', url: u, headers: h, payload: payload as object });
    expect((await go({ host: HOST })).statusCode).toBe(403);
    expect((await go({ host: HOST, 'x-gitslappin-token': 'wrong' })).statusCode).toBe(403);
    expect((await go({ ...s.headers, host: 'evil.example:80' })).statusCode).toBe(403);
    expect((await go({ ...s.headers, origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await go(s.headers, `/api/repos/${'f'.repeat(16)}/${sub}`)).statusCode).toBe(404);
    expect(world(repo)).toBe(world0);
    // control: with the right headers the route exists and validates the body (an empty body is 400, not 404 or 403)
    const empty = await s.app.inject({ method: 'POST', url, headers: s.headers, payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it('reserved device names and 8.3 names are 400 on all three routes, and nothing is created', async () => {
    const { repo, c1 } = std();
    const s = await start(repo);
    const listing = (): string => JSON.stringify(readdirSync(repo).sort());
    const before = listing();
    for (const path of ['CON', 'con.txt', 'sub/Nul', 'Com3.x.y', 'lpt1', 'AUX.', 'aux .txt', 'PROGRA~1', 'src/FILE~1.TXT']) {
      expect((await s.save(path, 'x\n', 'a'.repeat(64))).statusCode, `save ${path}`).toBe(400);
      expect((await s.restore(path, c1)).statusCode, `restore ${path}`).toBe(400);
      expect((await s.del(path)).statusCode, `delete ${path}`).toBe(400);
    }
    expect(listing()).toBe(before);
    expect((await s.get('f.txt')).statusCode).toBe(200); // control: routes exist
  });

  it('restore: a git failure is a generic 500 with no absolute path, no git text and no exception text; the file is unchanged', async () => {
    const { repo, c1 } = std();
    const s = await start(repo);
    writeFileSync(join(repo, '.git', 'index.lock'), ''); // git restore cannot take the index lock: its stderr names the absolute path
    const res = await s.restore('f.txt', c1);
    expect(res.statusCode, res.body).toBe(500);
    const text = flat(res.body);
    for (const leak of [repo, ROOT, 'index.lock', 'fatal', 'enoent', 'eperm', 'stack']) {
      expect(text, `body must not contain ${leak}`).not.toContain(flat(leak));
    }
    expect(typeof JSON.parse(res.body).error).toBe('string');
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('two\n');
  });

  it('delete: a trash folder that cannot be made is an error with no absolute path in the body; the file is still in place', async () => {
    const { repo } = std();
    writeFileSync(trashRoot(repo), 'i am a file, not a folder'); // blocks mkdir of <gitdir>/gitslappin-trash
    const s = await start(repo);
    const res = await s.del('f.txt');
    failedClosed(res, 'trash blocked');
    const text = flat(res.body);
    for (const leak of [repo, ROOT, 'enoent', 'enotdir', 'eexist', 'stack']) {
      expect(text, `body must not contain ${leak}`).not.toContain(flat(leak));
    }
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('two\n');
    expect(await s.undoLabel()).toBeNull();
  });
});
