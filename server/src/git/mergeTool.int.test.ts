import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { createMergeInProgress, createRebaseInProgress, FEATURE } from '../../../tests/e2e/helpers/mergeFixtures';

/*
 * Contract (design: build-notes "Phase 8 design"). Routes are driven through buildApp + app.inject, real git, mkdtemp repos.
 *   GET  /api/repos/:id/merge-tool?path=            -> 200 { binary, bom, eol: 'lf'|'crlf', base, a, b (string|null), aInfo, bInfo, external, workingHash }
 *                                                       aInfo/bInfo = { sha: short sha (>= 7 hex), branch?: string }
 *   POST /api/repos/:id/merge-tool/save     { path, text, expectHash } -> 200 { backup: <40-hex sha of a blob holding the old working bytes> }
 *   POST /api/repos/:id/merge-tool/take     { path, side: 'a' | 'b', expectHash } -> 200 { backup }   (a = stage 2, b = stage 3)
 *   POST /api/repos/:id/merge-tool/external { path } -> runs `git mergetool --no-prompt -- <path>`
 *   Failures: 409 for not-conflicted / stale or missing expectHash / missing stage / external busy; any 4xx (never 404, never 5xx)
 *   for refused paths and bad text. workingHash = sha256 hex of the working file bytes, or "missing" when it does not exist.
 * Nothing is deleted. The only deletion is `git rm` while building the modify/delete fixture inside a throwaway repo.
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com' });

const git = (cwd: string, args: string[], input?: string | Buffer): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, input, stdio: ['pipe', 'pipe', 'pipe'] });
const gitBuf = (cwd: string, args: string[]): Buffer => execFileSync('git', args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): number | null => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).status;
const unmerged = (repo: string): string[] => [...new Set(git(repo, ['ls-files', '-u']).split('\n').filter(Boolean).map((l) => l.split('\t')[1]!))];
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const bytes = (repo: string, rel: string): Buffer => readFileSync(join(repo, rel));
const blobExists = (repo: string, sha: string): boolean => /^[0-9a-f]{40}$/.test(sha) && tryGit(repo, ['cat-file', '-e', `${sha}^{blob}`]) === 0;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

type Content = string | Buffer | null; // null = the side deletes the file
/** main (A, HEAD) and FEATURE (B) both change `rel` from `base`; then `git merge feature` stops on the conflict. */
function conflictRepo(c: { base: Content; a: Content; b: Content }, rel = 'f.txt', extraConfig: Record<string, string> = {}): string {
  const repo = join(fresh('mtool'), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  for (const [k, v] of Object.entries({ 'user.name': 'Test Author', 'user.email': 'author@example.com', 'core.autocrlf': 'false', 'core.editor': 'false', 'core.symlinks': 'false', ...extraConfig })) git(repo, ['config', k, v]);
  const apply = (v: Content): void => {
    if (v === null) git(repo, ['rm', '-q', '--', rel]);
    else {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), v);
    }
    git(repo, ['add', '-A']);
  };
  writeFileSync(join(repo, 'README.md'), '# readme\n');
  if (c.base !== null) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), c.base);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'Base']);
  git(repo, ['switch', '-c', FEATURE]);
  apply(c.b);
  git(repo, ['commit', '-m', 'B side']);
  git(repo, ['switch', 'main']);
  apply(c.a);
  git(repo, ['commit', '-m', 'A side']);
  if (tryGit(repo, ['merge', '--no-ff', '--no-edit', FEATURE]) === 0 || !existsSync(join(repo, '.git', 'MERGE_HEAD'))) throw new Error('fixture: merge should stop on a conflict');
  return repo;
}

const PORT = 4998;
const HOST = `127.0.0.1:${PORT}`;
async function start(repo: string) {
  const app = await buildApp({ port: PORT, token: 'tok', dataDir: fresh('mtool-data'), clientDist: join(tmpdir(), 'gitslappin-no-such-dist'), noOpen: true });
  const headers = { host: HOST, 'x-gitslappin-token': 'tok' };
  const opened = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: repo } });
  expect(opened.statusCode).toBe(200);
  const id = (opened.json() as { id: string }).id;
  const base = `/api/repos/${id}/merge-tool`;
  const get = (path: string) => app.inject({ method: 'GET', url: `${base}?path=${encodeURIComponent(path)}`, headers });
  const post = (sub: string, payload: unknown) => app.inject({ method: 'POST', url: `${base}/${sub}`, headers, payload: payload as object });
  const info = async (path: string) => (await get(path)).json() as Record<string, any>;
  return { get, post, info };
}

const TEXT = { base: 'one\ntitle=base\nthree\n', a: 'one\ntitle=A\nthree\n', b: 'one\ntitle=B\nthree\n' };

describe('merge tool: stage reads', () => {
  it('returns base/a/b from stages 1/2/3, flags, a working hash, and merge header info', async () => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    const s = await start(fx.repo);
    const res = await s.get('src/config.js');
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;
    expect(body.base).toBe('title=base\n');
    expect(body.a).toBe('title=main\n');
    expect(body.b).toBe('title=feature\n');
    expect(body.binary).toBe(false);
    expect(body.bom).toBe(false);
    expect(body.eol).toBe('lf');
    expect(body.workingHash).toBe(sha256(bytes(fx.repo, 'src/config.js')));
    expect(body.aInfo.branch).toBe('main');
    expect(fx.mainSha.startsWith(body.aInfo.sha)).toBe(true);
    expect(body.aInfo.sha.length).toBeGreaterThanOrEqual(7);
    expect(body.bInfo.branch).toBe(FEATURE);
    expect(fx.featureSha.startsWith(body.bInfo.sha)).toBe(true);
  });

  it('on a rebase the header names are swapped: A is the target (HEAD), B is the commit being applied (REBASE_HEAD)', async () => {
    const fx = createRebaseInProgress();
    const s = await start(fx.repo);
    const body = await s.info('src/config.js');
    expect(body.a).toBe('title=feature\n'); // stage 2 is the branch being rebased onto
    expect(body.b).toBe('title=main\n'); // stage 3 is the commit being replayed
    expect(body.aInfo.branch).toBe(FEATURE);
    expect(fx.onto.startsWith(body.aInfo.sha)).toBe(true);
    const rebaseHead = git(fx.repo, ['rev-parse', 'REBASE_HEAD']).trim();
    expect(rebaseHead.startsWith(body.bInfo.sha)).toBe(true);
    expect(body.bInfo.branch).toBe('main');
  });

  it('decodes UTF-8 text sides and reports CRLF and BOM from the working file', async () => {
    const repo = conflictRepo({ base: '﻿head\r\nv=base\r\n', a: '﻿head\r\nv=café\r\n', b: '﻿head\r\nv=B\r\n' });
    const body = await (await start(repo)).info('f.txt');
    expect(body.a).toContain('café');
    expect(body.bom).toBe(true);
    expect(body.eol).toBe('crlf');
  });

  it('flags binary files (NUL byte) and non UTF-8 bytes', async () => {
    const nul = await (await start(conflictRepo({ base: Buffer.from([0, 1, 2]), a: Buffer.from([0, 1, 2, 3]), b: Buffer.from([0, 1, 2, 4]) }, 'img.bin'))).info('img.bin');
    expect(nul.binary).toBe(true);
    const bad = await (await start(conflictRepo({ base: Buffer.from('x\n'), a: Buffer.from([0x61, 0xff, 0xfe, 0x0a]), b: Buffer.from('b\n') }, 'bad.txt'))).info('bad.txt');
    expect(bad.binary).toBe(true);
  });

  it('a missing stage is null (add/add has no base; modify/delete has no A)', async () => {
    const addAdd = await (await start(conflictRepo({ base: null, a: 'x\n', b: 'y\n' }))).info('f.txt');
    expect(addAdd.base).toBeNull();
    expect(addAdd.a).toBe('x\n');
    const delMod = await (await start(conflictRepo({ base: 'x\n', a: null, b: 'y\n' }))).info('f.txt');
    expect(delMod.a).toBeNull();
    expect(delMod.b).toBe('y\n');
  });

  it('a path that is not conflicted gives 409 (README.md exists but is clean)', async () => {
    const s = await start(conflictRepo(TEXT));
    expect((await s.get('README.md')).statusCode).toBe(409);
    expect((await s.get('no-such-file.txt')).statusCode).toBe(409);
    expect((await s.get('f.txt')).statusCode).toBe(200); // control: the route exists
  });

  it('external is false without merge.tool and true with merge.tool and all three stages', async () => {
    const without = await (await start(conflictRepo(TEXT))).info('f.txt');
    expect(without.external).toBe(false); // UNVERIFIED: assumes no merge.tool in the developer's global git config
    const withTool = await (await start(conflictRepo(TEXT, 'f.txt', { 'merge.tool': 'gitslappintest', 'mergetool.gitslappintest.cmd': 'true' }))).info('f.txt');
    expect(withTool.external).toBe(true);
    const noStage = await (await start(conflictRepo({ base: 'x\n', a: null, b: 'y\n' }, 'f.txt', { 'merge.tool': 'gitslappintest', 'mergetool.gitslappintest.cmd': 'true' }))).info('f.txt');
    expect(noStage.external).toBe(false);
  });
});

describe('merge tool: save', () => {
  it('writes the exact bytes (LF), stages the path (it leaves ls-files -u) and does not commit', async () => {
    const repo = conflictRepo(TEXT);
    const s = await start(repo);
    const before = bytes(repo, 'f.txt');
    const { workingHash } = await s.info('f.txt');
    const res = await s.post('save', { path: 'f.txt', text: 'one\ntitle=A\ntitle=B\nthree\n', expectHash: workingHash });
    expect(res.statusCode).toBe(200);
    expect(bytes(repo, 'f.txt').equals(Buffer.from('one\ntitle=A\ntitle=B\nthree\n'))).toBe(true);
    expect(unmerged(repo)).toEqual([]);
    expect(git(repo, ['ls-files', '-s', '--', 'f.txt']).split(' ')[2]!.startsWith('0')).toBe(true);
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
    const backup = (res.json() as { backup: string }).backup;
    expect(blobExists(repo, backup)).toBe(true);
    expect(gitBuf(repo, ['cat-file', 'blob', backup]).equals(before)).toBe(true); // the old working bytes (with conflict markers) are kept
  });

  it('CRLF and mixed EOL text is written byte for byte (no normalisation)', async () => {
    const repo = conflictRepo(TEXT);
    const s = await start(repo);
    const mixed = 'one\r\ntitle=A\ntwo\r\nthree\n';
    const res = await s.post('save', { path: 'f.txt', text: mixed, expectHash: (await s.info('f.txt')).workingHash });
    expect(res.statusCode).toBe(200);
    expect(bytes(repo, 'f.txt').equals(Buffer.from(mixed))).toBe(true);
  });

  it('keeps the BOM when the working file has one, and never doubles it', async () => {
    const repo = conflictRepo({ base: '﻿head\nv=base\n', a: '﻿head\nv=A\n', b: '﻿head\nv=B\n' });
    expect(bytes(repo, 'f.txt').subarray(0, 3).equals(BOM)).toBe(true); // fixture check: working file starts with the BOM
    const s = await start(repo);
    const res = await s.post('save', { path: 'f.txt', text: '﻿head\nv=A\n', expectHash: (await s.info('f.txt')).workingHash });
    expect(res.statusCode).toBe(200);
    expect(bytes(repo, 'f.txt').equals(Buffer.concat([BOM, Buffer.from('head\nv=A\n')]))).toBe(true);
  });

  it('adds the BOM when side A has one and B has none (A wins), even if the working file starts with markers', async () => {
    const repo = conflictRepo({ base: 'x\n', a: '﻿A\n', b: 'B\n' });
    expect(bytes(repo, 'f.txt').subarray(0, 3).equals(BOM)).toBe(false); // fixture check
    const s = await start(repo);
    const res = await s.post('save', { path: 'f.txt', text: 'A\n', expectHash: (await s.info('f.txt')).workingHash });
    expect(res.statusCode).toBe(200);
    expect(bytes(repo, 'f.txt').equals(Buffer.concat([BOM, Buffer.from('A\n')]))).toBe(true);
  });

  it('writes no BOM when nothing had one, and strips a leading U+FEFF from the text', async () => {
    const repo = conflictRepo(TEXT);
    const s = await start(repo);
    const res = await s.post('save', { path: 'f.txt', text: '﻿one\n', expectHash: (await s.info('f.txt')).workingHash });
    expect(res.statusCode).toBe(200);
    expect(bytes(repo, 'f.txt').equals(Buffer.from('one\n'))).toBe(true);
  });

  it('409 for a stale expectHash (the file changed since it was read); nothing is written or staged', async () => {
    const repo = conflictRepo(TEXT);
    const s = await start(repo);
    const { workingHash } = await s.info('f.txt');
    writeFileSync(join(repo, 'f.txt'), 'edited elsewhere\n');
    const edited = bytes(repo, 'f.txt');
    const res = await s.post('save', { path: 'f.txt', text: 'mine\n', expectHash: workingHash });
    expect(res.statusCode).toBe(409);
    expect(bytes(repo, 'f.txt').equals(edited)).toBe(true);
    expect(unmerged(repo)).toEqual(['f.txt']);
  });

  it('409 for a missing expectHash', async () => {
    const repo = conflictRepo(TEXT);
    const s = await start(repo);
    const before = bytes(repo, 'f.txt');
    const res = await s.post('save', { path: 'f.txt', text: 'mine\n' });
    expect(res.statusCode).toBe(409);
    expect(bytes(repo, 'f.txt').equals(before)).toBe(true);
    expect(unmerged(repo)).toEqual(['f.txt']);
  });

  it('409 for a path that is not conflicted, even with a correct hash of that file', async () => {
    const repo = conflictRepo(TEXT);
    const s = await start(repo);
    const readme = bytes(repo, 'README.md');
    const res = await s.post('save', { path: 'README.md', text: 'overwritten\n', expectHash: sha256(readme) });
    expect(res.statusCode).toBe(409);
    expect(bytes(repo, 'README.md').equals(readme)).toBe(true);
    expect((await s.get('f.txt')).statusCode).toBe(200); // control: the route exists
  });

  it('workingHash is the sha256 of the file; the sentinel "missing" is stale while the file exists', async () => {
    const repo = conflictRepo({ base: 'x\n', a: null, b: 'y\n' }); // modify/delete: the working file holds B's version
    const s = await start(repo);
    const body = await s.info('f.txt');
    expect(body.workingHash).toBe(sha256(bytes(repo, 'f.txt')));
    const bad = await s.post('save', { path: 'f.txt', text: 'z\n', expectHash: 'missing' });
    expect(bad.statusCode).toBe(409); // the file exists, so "missing" is stale
    expect(unmerged(repo)).toEqual(['f.txt']);
  });

  it('rejects a lone surrogate and a NUL in the text; the file stays as it was and conflicted', async () => {
    const repo = conflictRepo(TEXT);
    const s = await start(repo);
    const { workingHash } = await s.info('f.txt');
    const before = bytes(repo, 'f.txt');
    for (const text of ['ab\uD800cd\n', 'ab\uDC00\n', 'a\0b\n']) {
      const res = await s.post('save', { path: 'f.txt', text, expectHash: workingHash });
      expect([400, 413, 415, 422]).toContain(res.statusCode);
    }
    expect(bytes(repo, 'f.txt').equals(before)).toBe(true);
    expect(unmerged(repo)).toEqual(['f.txt']);
  });

  it('refuses reserved device names and 8.3 names on save, take and external (4xx, nothing created)', async () => {
    const repo = conflictRepo(TEXT);
    const s = await start(repo);
    expect((await s.get('f.txt')).statusCode).toBe(200); // control: the route exists
    const listing = (): string => JSON.stringify(readdirSync(repo).sort());
    const before = listing();
    const bad = ['CON', 'con.txt', 'sub/Nul', 'Com3.x.y', 'lpt1', 'AUX.', 'aux .txt', 'PROGRA~1', 'src/FILE~1.TXT'];
    for (const path of bad) {
      for (const [sub, payload] of [
        ['save', { path, text: 'x\n', expectHash: 'a'.repeat(64) }],
        ['take', { path, side: 'a', expectHash: 'a'.repeat(64) }],
        ['external', { path }],
      ] as const) {
        const res = await s.post(sub, payload);
        expect(res.statusCode, `${sub} ${path}`).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, `${sub} ${path}`).toBeLessThan(500);
        expect(res.statusCode, `${sub} ${path} must not be a 404`).not.toBe(404);
      }
    }
    expect(listing()).toBe(before);
  });

  it('refuses an unmerged symlink (mode 120000): no text is written', async () => {
    const repo = join(fresh('mtool-link'), 'r');
    mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    for (const [k, v] of Object.entries({ 'user.name': 'Test Author', 'user.email': 'author@example.com', 'core.autocrlf': 'false', 'core.symlinks': 'false' })) git(repo, ['config', k, v]);
    const link = (target: string): void => {
      const blob = git(repo, ['hash-object', '-w', '--stdin'], target).trim();
      git(repo, ['update-index', '--add', '--cacheinfo', `120000,${blob},lnk`]);
    };
    writeFileSync(join(repo, 'README.md'), '# r\n');
    git(repo, ['add', 'README.md']);
    link('base-target');
    git(repo, ['commit', '-m', 'Base']);
    git(repo, ['switch', '-c', FEATURE]);
    link('b-target');
    git(repo, ['commit', '-m', 'B side']);
    git(repo, ['switch', 'main']);
    link('a-target');
    git(repo, ['commit', '-m', 'A side']);
    expect(tryGit(repo, ['merge', '--no-ff', '--no-edit', FEATURE])).not.toBe(0);
    expect(unmerged(repo)).toEqual(['lnk']); // fixture check
    const s = await start(repo);
    expect((await s.get('README.md')).statusCode).toBe(409); // control: the route exists
    const before = bytes(repo, 'lnk');
    for (const [sub, payload] of [
      ['save', { path: 'lnk', text: 'x\n', expectHash: sha256(before) }],
      ['take', { path: 'lnk', side: 'a', expectHash: sha256(before) }],
    ] as const) {
      const res = await s.post(sub, payload);
      expect(res.statusCode, sub).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, sub).toBeLessThan(500);
      expect(res.statusCode, sub).not.toBe(404);
    }
    expect(bytes(repo, 'lnk').equals(before)).toBe(true);
    expect(unmerged(repo)).toEqual(['lnk']);
  });
});

describe('merge tool: take (binary)', () => {
  const A = Buffer.from([0, 1, 2, 3, 0xaa]);
  const B = Buffer.from([0, 1, 2, 4, 0xbb]);

  it('writes the stage 2 bytes for side a, stages the path, and keeps a backup of the old bytes', async () => {
    const repo = conflictRepo({ base: Buffer.from([0, 1, 2]), a: A, b: B }, 'img.bin');
    const s = await start(repo);
    const before = bytes(repo, 'img.bin');
    const { workingHash } = await s.info('img.bin');
    const res = await s.post('take', { path: 'img.bin', side: 'a', expectHash: workingHash });
    expect(res.statusCode).toBe(200);
    expect(bytes(repo, 'img.bin').equals(A)).toBe(true);
    expect(unmerged(repo)).toEqual([]);
    const backup = (res.json() as { backup: string }).backup;
    expect(blobExists(repo, backup)).toBe(true);
    expect(gitBuf(repo, ['cat-file', 'blob', backup]).equals(before)).toBe(true);
  });

  it('writes the stage 3 bytes for side b', async () => {
    const repo = conflictRepo({ base: Buffer.from([0, 1, 2]), a: A, b: B }, 'img.bin');
    const s = await start(repo);
    const res = await s.post('take', { path: 'img.bin', side: 'b', expectHash: (await s.info('img.bin')).workingHash });
    expect(res.statusCode).toBe(200);
    expect(bytes(repo, 'img.bin').equals(B)).toBe(true);
    expect(unmerged(repo)).toEqual([]);
  });

  it('409 for a stale or missing expectHash', async () => {
    const repo = conflictRepo({ base: Buffer.from([0, 1, 2]), a: A, b: B }, 'img.bin');
    const s = await start(repo);
    const before = bytes(repo, 'img.bin');
    expect((await s.post('take', { path: 'img.bin', side: 'a', expectHash: 'f'.repeat(64) })).statusCode).toBe(409);
    expect((await s.post('take', { path: 'img.bin', side: 'a' })).statusCode).toBe(409);
    expect(bytes(repo, 'img.bin').equals(before)).toBe(true);
    expect(unmerged(repo)).toEqual(['img.bin']);
  });

  it('400 for a text file: nothing changes', async () => {
    const repo = conflictRepo(TEXT, 'f.txt');
    const s = await start(repo);
    const { workingHash } = await s.info('f.txt');
    const before = bytes(repo, 'f.txt');
    for (const side of ['a', 'b']) expect((await s.post('take', { path: 'f.txt', side, expectHash: workingHash })).statusCode).toBe(400);
    expect(bytes(repo, 'f.txt').equals(before)).toBe(true);
    expect(unmerged(repo)).toEqual(['f.txt']);
  });

  it('409 for a path that is not conflicted', async () => {
    const repo = conflictRepo({ base: Buffer.from([0, 1, 2]), a: A, b: B }, 'img.bin');
    const s = await start(repo);
    expect((await s.post('take', { path: 'README.md', side: 'a', expectHash: sha256(bytes(repo, 'README.md')) })).statusCode).toBe(409);
    expect((await s.get('img.bin')).statusCode).toBe(200); // control: the route exists
  });

  it('Take on a missing stage gives 409 and the file is still there, unchanged and unmerged', async () => {
    const repo = conflictRepo({ base: Buffer.from([0, 1, 2]), a: null, b: B }, 'img.bin'); // A deleted it: no stage 2
    expect(existsSync(join(repo, 'img.bin'))).toBe(true); // fixture check
    const s = await start(repo);
    const info = await s.info('img.bin');
    expect(info.a).toBeNull();
    const before = bytes(repo, 'img.bin');
    const res = await s.post('take', { path: 'img.bin', side: 'a', expectHash: info.workingHash });
    expect(res.statusCode).toBe(409);
    expect(existsSync(join(repo, 'img.bin'))).toBe(true);
    expect(bytes(repo, 'img.bin').equals(before)).toBe(true);
    expect(unmerged(repo)).toEqual(['img.bin']);
  });
});

describe('merge tool: external busy flag', () => {
  it('save and take return 409 while the external tool runs for that path; the file is untouched', async () => {
    const dir = fresh('mtool-ext');
    const marker = join(dir, 'started.txt').replace(/\\/g, '/');
    const cmd = `node -e "require('fs').writeFileSync('${marker}','x');setTimeout(function(){},4000)"`;
    const repo = conflictRepo(TEXT, 'f.txt', { 'merge.tool': 'gitslappintest', 'mergetool.gitslappintest.cmd': cmd, 'mergetool.gitslappintest.trustExitCode': 'true', 'mergetool.keepBackup': 'false' });
    const s = await start(repo);
    const { workingHash, external } = await s.info('f.txt');
    expect(external).toBe(true);
    const running = s.post('external', { path: 'f.txt' });
    const deadline = Date.now() + 20_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(marker)).toBe(true); // the tool really started, so the busy flag is set
    const before = bytes(repo, 'f.txt');
    const save = await s.post('save', { path: 'f.txt', text: 'mine\n', expectHash: workingHash });
    expect(save.statusCode).toBe(409);
    const take = await s.post('take', { path: 'f.txt', side: 'a', expectHash: workingHash });
    expect(take.statusCode).toBe(409);
    expect(bytes(repo, 'f.txt').equals(before)).toBe(true);
    const done = await running;
    expect(done.statusCode).toBeLessThan(500);
  }, 60_000);

  it('the external route refuses a path that is not conflicted', async () => {
    const repo = conflictRepo(TEXT, 'f.txt', { 'merge.tool': 'gitslappintest', 'mergetool.gitslappintest.cmd': 'true' });
    const s = await start(repo);
    expect((await s.post('external', { path: 'README.md' })).statusCode).toBe(409);
    expect((await s.get('f.txt')).statusCode).toBe(200); // control: the route exists
  });
});

describe('merge tool: phase 8 code-review fixes', () => {
  it('3: the temp file lives under <gitdir>/gitslappin-tmp, so the worktree is never littered and nothing is untracked', async () => {
    const repo = conflictRepo(TEXT);
    const s = await start(repo);
    const { workingHash } = await s.info('f.txt');
    expect((await s.post('save', { path: 'f.txt', text: 'one\nmine\nthree\n', expectHash: workingHash })).statusCode).toBe(200);
    expect(readdirSync(repo).filter((n) => n.includes('gitslappin-merge'))).toEqual([]);
    expect(statSync(join(repo, '.git', 'gitslappin-tmp')).isDirectory()).toBe(true);
    expect(git(repo, ['status', '--porcelain']).split('\n').filter((l) => l.startsWith('??'))).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')('3: a rename that keeps failing (read-only target) answers 503 after retries; the file is unchanged and still unmerged', async () => {
    const repo = conflictRepo(TEXT);
    const s = await start(repo);
    const { workingHash } = await s.info('f.txt');
    const before = bytes(repo, 'f.txt');
    chmodSync(join(repo, 'f.txt'), 0o444);
    try {
      const res = await s.post('save', { path: 'f.txt', text: 'one\nmine\nthree\n', expectHash: workingHash });
      expect(res.statusCode).toBe(503);
    } finally {
      chmodSync(join(repo, 'f.txt'), 0o666);
    }
    expect(bytes(repo, 'f.txt').equals(before)).toBe(true);
    expect(unmerged(repo)).toEqual(['f.txt']);
  });

  it('4: a missing target whose parent resolves outside the repo is refused and nothing is created there', async () => {
    const repo = conflictRepo({ base: 'x\n', a: 'a\n', b: 'b\n' }, 'sub/f.txt');
    const outside = fresh('mtool-outside');
    renameSync(join(repo, 'sub', 'f.txt'), join(outside, 'moved.txt')); // moved away, not deleted: the working file is now missing
    renameSync(join(repo, 'sub'), join(outside, 'sub'));
    symlinkSync(join(outside, 'sub'), join(repo, 'sub'), 'junction');
    const s = await start(repo);
    const res = await s.post('save', { path: 'sub/f.txt', text: 'mine\n', expectHash: 'missing' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(existsSync(join(outside, 'sub', 'f.txt'))).toBe(false);
    expect(unmerged(repo)).toEqual(['sub/f.txt']);
  });

  it.skipIf(process.platform === 'win32')('5: the file keeps its permission bits (exec bit) after a save', async () => {
    const repo = conflictRepo(TEXT);
    chmodSync(join(repo, 'f.txt'), 0o755);
    const s = await start(repo);
    const { workingHash } = await s.info('f.txt');
    expect((await s.post('save', { path: 'f.txt', text: 'one\nmine\nthree\n', expectHash: workingHash })).statusCode).toBe(200);
    expect(statSync(join(repo, 'f.txt')).mode & 0o777).toBe(0o755);
  });

  it('6: a file with a lone CR is take-only: reported as not text-mergeable, save refused, take works', async () => {
    const repo = conflictRepo({ base: 'x\ry\n', a: 'a\ry\n', b: 'b\ry\n' });
    const s = await start(repo);
    const info = await s.info('f.txt');
    expect(info.binary).toBe(true);
    const before = bytes(repo, 'f.txt');
    expect((await s.post('save', { path: 'f.txt', text: 'mine\n', expectHash: info.workingHash })).statusCode).toBe(400);
    expect(bytes(repo, 'f.txt').equals(before)).toBe(true);
    expect((await s.post('take', { path: 'f.txt', side: 'a', expectHash: info.workingHash })).statusCode).toBe(200);
    expect(bytes(repo, 'f.txt').equals(Buffer.from('a\ry\n'))).toBe(true);
    expect(unmerged(repo)).toEqual([]);
  });

  it('6: CRLF text is not a lone CR and stays text-mergeable', async () => {
    const repo = conflictRepo({ base: 'x\r\ny\r\n', a: 'a\r\ny\r\n', b: 'b\r\ny\r\n' });
    expect((await start(repo).then((s) => s.info('f.txt'))).binary).toBe(false);
  });

  it('9: a second external run for the same file is refused while the first holds the busy flag, and the first returns the backup', async () => {
    const dir = fresh('mtool-ext2');
    const marker = join(dir, 'started.txt').replace(/\\/g, '/');
    const cmd = `node -e "require('fs').writeFileSync('${marker}','x');setTimeout(function(){},3000)"`;
    const repo = conflictRepo(TEXT, 'f.txt', { 'merge.tool': 'gitslappintest', 'mergetool.gitslappintest.cmd': cmd, 'mergetool.gitslappintest.trustExitCode': 'true', 'mergetool.keepBackup': 'false' });
    const s = await start(repo);
    const before = bytes(repo, 'f.txt');
    const first = s.post('external', { path: 'f.txt' });
    const deadline = Date.now() + 20_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect((await s.post('external', { path: 'f.txt' })).statusCode).toBe(409);
    const done = await first;
    expect(done.statusCode).toBe(200);
    expect(gitBuf(repo, ['cat-file', 'blob', (done.json() as { backup: string }).backup]).equals(before)).toBe(true);
  }, 60_000);
});
