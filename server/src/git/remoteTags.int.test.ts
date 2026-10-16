import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { getCommandLog } from './commandLog';
import { runExclusive } from './queue';

vi.setConfig({ testTimeout: 90_000 });

/*
 * V2 (Remotes & tags), black-box through the app (app.inject), real git, no mocks. Routes under /api/repos/:id (names from the design):
 *   POST remote/add {name, url, pushUrl?}        -> 200 {outcome:'done'} (remote added, then fetched);  refused input = 4xx (not 5xx), nothing changed
 *   POST tag/push {name, sha, remote}            -> 200 on success;  409 when `sha` is not the tag's commit;  4xx on refused input;  non-fast tag clash = >= 400
 *   POST tag/delete {name, sha}                  -> 200; the tag-object sha is pinned under refs/gitslappin/undo/ first (fail closed); journaled "delete tag 'x'"
 *   POST tag/delete-remote {name, sha, remote}   -> 200; refused (>= 400) on a lease mismatch or when the local tag does not exist; NOT journaled
 *   POST fetch {auto:true}                       -> 200 {outcome:'done', changed:boolean} | {outcome:'skipped'} | {outcome:'failed'} (no stderr, no error text)
 *   GET undo-state, POST undo, POST redo         (existing)
 * The auto-fetch askpass script is written by buildApp into config.dataDir as `askpass.cmd` (win32) or `askpass.sh` (others), overwritten on every start.
 *
 * Isolation: GIT_CONFIG_NOSYSTEM + empty GIT_CONFIG_GLOBAL; GIT_ASKPASS / SSH_ASKPASS are TRAPS (they append a line to a marker file, then fail) so a test can
 * see whether anything asked for a credential. Remotes are file:// inside os.tmpdir()/gitslappin-tests, except: loopback-only servers started here (a tcp socket that
 * never answers, an http server that answers 401), and a fake ssh program set through GIT_SSH_COMMAND (nothing ever leaves this machine).
 * Nothing is deleted anywhere.
 */

const ROOT = resolve(join(tmpdir(), 'gitslappin-tests'));
const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const underRoot = (p: string): boolean => norm(p).startsWith(norm(ROOT) + (process.platform === 'win32' ? '\\' : sep));
const fwd = (p: string): string => p.replace(/\\/g, '/');

function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!underRoot(dir) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const CFG_DIR = fresh('gitcfg-remotetags-int');
const EMPTY_GLOBAL = join(CFG_DIR, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL, '');
const ASKED = join(CFG_DIR, 'asked.log');
writeFileSync(ASKED, '');
const TRAP = join(CFG_DIR, process.platform === 'win32' ? 'trap-askpass.cmd' : 'trap-askpass.sh');
writeFileSync(
  TRAP,
  process.platform === 'win32' ? `@echo off\r\necho asked>>"${ASKED}"\r\nexit /b 1\r\n` : `#!/bin/sh\necho asked >> "${fwd(ASKED)}"\nexit 1\n`,
  { mode: 0o755 },
);
const asks = (): number => readFileSync(ASKED, 'utf8').split('\n').filter(Boolean).length;

// Fake ssh: with SSH_ASKPASS_REQUIRE=force it runs SSH_ASKPASS like a real ssh would (and exits 255 when that fails); otherwise it "prompts on the terminal":
// it records that and waits. It always records that it ran.
const SSH_RAN = join(CFG_DIR, 'ssh-ran.log');
const SSH_TTY = join(CFG_DIR, 'ssh-tty.log');
writeFileSync(SSH_RAN, '');
writeFileSync(SSH_TTY, '');
const FAKE_SSH = join(CFG_DIR, 'fake-ssh.js');
writeFileSync(
  FAKE_SSH,
  `const fs = require('fs');
const { spawnSync } = require('child_process');
fs.appendFileSync(${JSON.stringify(SSH_RAN)}, 'ran\\n');
if (process.env.SSH_ASKPASS_REQUIRE === 'force' && process.env.SSH_ASKPASS) {
  const r = spawnSync('"' + process.env.SSH_ASKPASS + '" "Are you sure you want to continue connecting (yes/no)? "', { shell: true, stdio: 'ignore' });
  process.exit(r.status === 0 ? 0 : 255);
}
fs.appendFileSync(${JSON.stringify(SSH_TTY)}, 'tty prompt\\n');
setTimeout(() => process.exit(255), 20000);
`,
);
const count = (file: string): number => readFileSync(file, 'utf8').split('\n').filter(Boolean).length;

Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
  GIT_ASKPASS: TRAP,
  SSH_ASKPASS: TRAP,
  GCM_INTERACTIVE: 'always',
  GIT_SSH_COMMAND: `"${fwd(process.execPath)}" "${fwd(FAKE_SSH)}"`,
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
});
delete process.env.GIT_TERMINAL_PROMPT;
delete process.env.GITSLAPPIN_TOKEN;
delete process.env.GIT_SSH;
delete process.env.SSH_ASKPASS_REQUIRE;

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const head = (repo: string): string => git(repo, ['rev-parse', 'HEAD']).trim();
const refOrUndef = (repo: string, ref: string): string | undefined => {
  const r = tryGit(repo, ['rev-parse', '--verify', '--quiet', ref]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const cfgGet = (repo: string, key: string): string | undefined => {
  const r = tryGit(repo, ['config', '--local', '--get', key]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const remoteNames = (repo: string): string[] => git(repo, ['remote']).split('\n').filter(Boolean);
const snapshot = (repo: string): string => git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);
const pins = (repo: string): string => git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/gitslappin/undo/']).trim();

function commit(repo: string, files: Record<string, string>, msg: string, who = 'Test Author'): string {
  for (const [rel, t] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, t);
  }
  git(repo, ['add', '-A']);
  execFileSync('git', ['commit', '-m', msg], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who.toLowerCase().replace(/ /g, '.')}@example.com` },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return head(repo);
}
function configure(repo: string): void {
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'author@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'core.editor', 'false']);
  git(repo, ['config', 'protocol.allow', 'never']);
  git(repo, ['config', 'protocol.file.allow', 'always']);
}
function assertFileUrl(url: string): void {
  if (!url.startsWith('file://')) throw new Error(`Unsafe URL (not file://): ${url}`);
  if (!underRoot(fileURLToPath(url))) throw new Error(`URL is outside ${ROOT}: ${url}`);
}
function assertRemotesSafe(repo: string): void {
  const r = tryGit(repo, ['config', '--local', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']);
  for (const line of r.stdout.split('\n').filter(Boolean)) assertFileUrl(line.slice(line.indexOf(' ') + 1).trim());
}

interface Fx {
  base: string;
  origin: string;
  originUrl: string;
  a: string;
  b: string;
  baseSha: string;
}
/** origin (bare, main = 2 commits); A = the repo under test (tracks origin/main); B = another clone. */
function makeFx(): Fx {
  const base = fresh('remotetags-int');
  const origin = join(base, 'origin.git');
  const a = join(base, 'a');
  const b = join(base, 'b');
  mkdirSync(origin);
  git(origin, ['init', '--bare', '-b', 'main']);
  const originUrl = pathToFileURL(origin).href;
  assertFileUrl(originUrl);
  mkdirSync(a);
  git(a, ['init', '-b', 'main']);
  configure(a);
  git(a, ['remote', 'add', 'origin', originUrl]);
  commit(a, { 'README.md': '# readme\n' }, 'Remote base 1');
  const baseSha = commit(a, { 'docs.txt': 'docs\n' }, 'Remote base 2');
  git(a, ['push', '-u', 'origin', 'main']);
  git(base, ['clone', originUrl, 'b']);
  configure(b);
  assertRemotesSafe(b);
  return { base, origin, originUrl, a, b, baseSha };
}
function bareRepo(prefix: string, withCommit = true): { path: string; url: string } {
  const path = join(fresh(prefix), 'second.git');
  mkdirSync(path);
  git(path, ['init', '--bare', '-b', 'main']);
  const url = pathToFileURL(path).href;
  assertFileUrl(url);
  if (withCommit) {
    const work = join(fresh(`${prefix}-work`), 'w');
    mkdirSync(work);
    git(work, ['init', '-b', 'main']);
    configure(work);
    git(work, ['remote', 'add', 'origin', url]);
    commit(work, { 'second.txt': 'second\n' }, 'Second remote commit');
    git(work, ['push', 'origin', 'main']);
  }
  return { path, url };
}
function originAdvance(fx: Fx, files: Record<string, string>, msg: string): string {
  assertRemotesSafe(fx.b);
  git(fx.b, ['pull', '--ff-only', 'origin', 'main']);
  const sha = commit(fx.b, files, msg, 'Other Author');
  git(fx.b, ['push', 'origin', 'main']);
  return sha;
}

// ---- the app -------------------------------------------------------------------------------------------------------------------------
const PORT = 4996;
const TOKEN = 'r'.repeat(40);
const headers = { host: `127.0.0.1:${PORT}`, 'x-gitslappin-token': TOKEN };
const DATA_DIR = fresh('gitslappin-unit-remotetags-data');
const ASKPASS_NAME = process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh';
const PLANTED = 'PLANTED-BY-A-HOSTILE-FILE';
// Item 8: a file already in the data dir is never trusted. Plant one under both names before the server starts.
for (const n of ['askpass.cmd', 'askpass.sh']) writeFileSync(join(DATA_DIR, n), `${PLANTED}\n`);
const app = await buildApp(loadConfig({ GITSLAPPIN_NO_OPEN: '1', GITSLAPPIN_TOKEN: TOKEN, GITSLAPPIN_PORT: String(PORT), GITSLAPPIN_DATA_DIR: DATA_DIR, GITSLAPPIN_WATCH: 'poll' }));
afterAll(async () => {
  for (const s of sockets) s.destroy();
  tcp?.close();
  http?.close();
  await app.close();
});

type Json = Record<string, unknown>;
interface Res {
  status: number;
  body: Json;
  text: string;
}
async function call(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<Res> {
  const r = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  let body: Json = {};
  try {
    body = JSON.parse(r.body) as Json;
  } catch {
    /* not json */
  }
  return { status: r.statusCode, body, text: r.body };
}
async function openRepo(path: string): Promise<string> {
  const r = await call('POST', '/api/repos/open', { path });
  expect(r.status).toBe(200);
  return r.body.id as string;
}
const post = (id: string, route: string, payload?: unknown) => call('POST', `/api/repos/${id}/${route}`, payload ?? {});
const refused = (r: Res): void => {
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);
};

// ---- loopback servers (started lazily) -----------------------------------------------------------------------------------------------
const sockets: Socket[] = [];
let tcp: ReturnType<typeof createTcpServer> | undefined;
let tcpPort = 0;
let tcpConnections = 0;
async function startHangingGitServer(): Promise<number> {
  if (tcp) return tcpPort;
  tcp = createTcpServer((s) => {
    tcpConnections++;
    sockets.push(s);
    s.on('error', () => undefined); // never answers
  });
  await new Promise<void>((ok) => tcp!.listen(0, '127.0.0.1', ok));
  tcpPort = (tcp.address() as { port: number }).port;
  return tcpPort;
}
let http: ReturnType<typeof createHttpServer> | undefined;
let httpPort = 0;
async function startUnauthorizedHttpServer(): Promise<number> {
  if (http) return httpPort;
  http = createHttpServer((_req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="gitslappin-test"' });
    res.end('auth needed');
  });
  await new Promise<void>((ok) => http!.listen(0, '127.0.0.1', ok));
  httpPort = (http.address() as { port: number }).port;
  return httpPort;
}
function soloRepo(prefix: string): string {
  const repo = join(fresh(prefix), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  configure(repo);
  git(repo, ['config', 'protocol.git.allow', 'always']);
  commit(repo, { 'a.txt': 'a\n' }, 'Solo commit');
  return repo;
}

// =====================================================================================================================================
describe('Add Remote', () => {
  it('adds the remote with its pull url and fetches it right away (user-started fetch, so it is in the command log)', async () => {
    const fx = makeFx();
    const second = bareRepo('addremote-second');
    const id = await openRepo(fx.a);
    const before = getCommandLog(id).length;
    const r = await post(id, 'remote/add', { name: 'second', url: second.url });
    expect(r.status).toBe(200);
    expect(remoteNames(fx.a).sort()).toEqual(['origin', 'second']);
    expect(cfgGet(fx.a, 'remote.second.url')).toBe(second.url);
    expect(refOrUndef(fx.a, 'refs/remotes/second/main')).toBeDefined(); // fetched
    expect(getCommandLog(id).length).toBeGreaterThan(before);
    assertRemotesSafe(fx.a);
  });

  it('sets a different push url when one is given, and leaves pushurl unset when it equals the pull url', async () => {
    const fx = makeFx();
    const second = bareRepo('addremote-pull');
    const pushOnly = bareRepo('addremote-push', false);
    const id = await openRepo(fx.a);
    expect((await post(id, 'remote/add', { name: 'two', url: second.url, pushUrl: pushOnly.url })).status).toBe(200);
    expect(cfgGet(fx.a, 'remote.two.url')).toBe(second.url);
    expect(cfgGet(fx.a, 'remote.two.pushurl')).toBe(pushOnly.url);
    expect((await post(id, 'remote/add', { name: 'three', url: second.url, pushUrl: second.url })).status).toBe(200);
    expect(cfgGet(fx.a, 'remote.three.pushurl')).toBeUndefined();
    assertRemotesSafe(fx.a);
  });

  it('refuses a name that already exists (url of the existing remote unchanged) and bad names (nothing added)', async () => {
    const fx = makeFx();
    const second = bareRepo('addremote-bad');
    const id = await openRepo(fx.a);
    const before = git(fx.a, ['config', '--local', '--list']);
    refused(await post(id, 'remote/add', { name: 'origin', url: second.url }));
    for (const name of ['', '-x', '--mirror', 'a b', 'a..b', 'a:b', 'a~b', 'a^b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', 'a\u0001b', '.lock', 'x/', '/x', 'x.lock']) {
      refused(await post(id, 'remote/add', { name, url: second.url }));
    }
    expect(git(fx.a, ['config', '--local', '--list'])).toBe(before);
    expect(cfgGet(fx.a, 'remote.origin.url')).toBe(fx.originUrl);
    // the route is alive: a valid add still works afterwards
    expect((await post(id, 'remote/add', { name: 'ok-name', url: second.url })).status).toBe(200);
  });

  it('refuses hostile or malformed urls (pull and push) before git touches anything: nothing is added, no helper runs', async () => {
    const fx = makeFx();
    const second = bareRepo('addremote-url');
    const id = await openRepo(fx.a);
    const markerParent = fresh('remotetags-ext-marker');
    const marker = join(markerParent, 'ext-ran').replace(/\\/g, '/');
    const bad = [
      `ext::git init ${marker}`,
      'ext::sh -c touch% x',
      '-oProxyCommand=touch x',
      '--upload-pack=touch x',
      '\\\\server\\share\\repo',
      '//server/share/repo',
      'file://host/path',
      'ftp://example.com/x',
      'javascript:alert(1)',
      'https://example.com/a::b',
      'https://example.com/a\nb',
      'https://example.com/a\u0000b',
      '',
      `https://example.com/${'a'.repeat(2100)}`,
    ];
    const before = git(fx.a, ['config', '--local', '--list']);
    for (const url of bad) {
      refused(await post(id, 'remote/add', { name: 'evil', url }));
      refused(await post(id, 'remote/add', { name: 'evil', url: second.url, pushUrl: url })); // the push url goes through the same check
    }
    expect(git(fx.a, ['config', '--local', '--list'])).toBe(before);
    expect(remoteNames(fx.a)).toEqual(['origin']);
    expect(existsSync(join(marker, '.git')) || existsSync(join(marker, 'HEAD'))).toBe(false);
    expect((await post(id, 'remote/add', { name: 'fine', url: second.url })).status).toBe(200); // code path alive
  });

  it('an unknown repo id is a 404 and a body that is not an object is a 4xx', async () => {
    const fx = makeFx();
    const id = await openRepo(fx.a);
    expect((await post('0000000000000000', 'remote/add', { name: 'x', url: 'https://example.com/x.git' })).status).toBe(404);
    refused(await post(id, 'remote/add', { name: 5, url: 'https://example.com/x.git' }));
    refused(await post(id, 'remote/add', { name: 'x', url: ['https://example.com/x.git'] }));
    refused(await post(id, 'remote/add', { name: 'x' }));
    expect(remoteNames(fx.a)).toEqual(['origin']);
  });
});

// =====================================================================================================================================
describe('tag push', () => {
  function tagFx(): { fx: Fx; id: Promise<string>; sha: string; tagObj: string } {
    const fx = makeFx();
    const sha = commit(fx.a, { 'more.txt': 'm\n' }, 'Tagged commit');
    git(fx.a, ['tag', '-a', 'v1.0', '-m', 'release one']);
    git(fx.a, ['tag', 'light']);
    return { fx, id: openRepo(fx.a), sha, tagObj: git(fx.a, ['rev-parse', 'refs/tags/v1.0']).trim() };
  }

  it('pushes an annotated and a lightweight tag to the remote, and only that tag (no branch moves)', async () => {
    const { fx, id, sha, tagObj } = tagFx();
    const before = snapshot(fx.origin);
    assertRemotesSafe(fx.a);
    expect((await post(await id, 'tag/push', { name: 'v1.0', sha, remote: 'origin' })).status).toBe(200);
    expect(refOrUndef(fx.origin, 'refs/tags/v1.0')).toBe(tagObj); // the tag object itself, not just the commit
    expect(refOrUndef(fx.origin, 'refs/tags/light')).toBeUndefined();
    expect(refOrUndef(fx.origin, 'refs/heads/main')).toBe(fx.baseSha); // the unpushed commit did not travel as a branch
    expect(snapshot(fx.origin).split('\n').filter((l) => l !== '' && !l.includes('refs/tags/v1.0'))).toEqual(before.split('\n').filter(Boolean));
    expect((await post(await id, 'tag/push', { name: 'light', sha, remote: 'origin' })).status).toBe(200);
    expect(refOrUndef(fx.origin, 'refs/tags/light')).toBe(sha);
  });

  it('pushing the same tag again is fine (nothing to do)', async () => {
    const { fx, id, sha } = tagFx();
    assertRemotesSafe(fx.a);
    expect((await post(await id, 'tag/push', { name: 'v1.0', sha, remote: 'origin' })).status).toBe(200);
    expect((await post(await id, 'tag/push', { name: 'v1.0', sha, remote: 'origin' })).status).toBe(200);
  });

  it('is refused when the remote already has a different tag of that name; the remote tag is not overwritten (never + or -f)', async () => {
    const { fx, id, sha } = tagFx();
    assertRemotesSafe(fx.b);
    git(fx.b, ['pull', '--ff-only', 'origin', 'main']);
    const other = commit(fx.b, { 'other.txt': 'o\n' }, 'Other side commit', 'Other Author');
    git(fx.b, ['tag', '-a', 'v1.0', '-m', 'their release']);
    git(fx.b, ['push', 'origin', 'v1.0']);
    const theirs = refOrUndef(fx.origin, 'refs/tags/v1.0');
    expect(theirs).toBeDefined();
    const before = snapshot(fx.origin);
    assertRemotesSafe(fx.a);
    const r = await post(await id, 'tag/push', { name: 'v1.0', sha, remote: 'origin' });
    expect(r.status).toBeGreaterThanOrEqual(400); // the code path ran and answered
    expect(snapshot(fx.origin)).toBe(before);
    expect(refOrUndef(fx.origin, 'refs/tags/v1.0')).toBe(theirs);
    expect(other).not.toBe(sha);
  });

  it('the sha the UI shows must equal the tag commit inside the lock, else 409 and nothing is pushed', async () => {
    const { fx, id } = tagFx();
    const before = snapshot(fx.origin);
    const r = await post(await id, 'tag/push', { name: 'v1.0', sha: fx.baseSha, remote: 'origin' }); // a real commit, but not the tag's
    expect(r.status).toBe(409);
    refused(await post(await id, 'tag/push', { name: 'v1.0', sha: 'not-a-sha', remote: 'origin' }));
    refused(await post(await id, 'tag/push', { name: 'v1.0', remote: 'origin' }));
    expect(snapshot(fx.origin)).toBe(before);
  });

  it('refuses bad tag names, tags that do not exist, and remotes that are unknown or look like options', async () => {
    const { fx, id, sha } = tagFx();
    const before = snapshot(fx.origin);
    const idv = await id;
    for (const name of ['', '-x', '--force', 'a:b', 'a b', 'a..b', 'a~b', 'a^b', 'a*b', 'a\\b', 'a@{b', 'x.lock', '+v1.0', 'refs/tags/v1.0:refs/heads/evil', 'does-not-exist']) {
      refused(await post(idv, 'tag/push', { name, sha, remote: 'origin' }));
    }
    for (const remote of ['', 'nope', '-x', '--upload-pack=touch x', '-oProxyCommand=x', 'origin:x', 'origin evil']) {
      refused(await post(idv, 'tag/push', { name: 'v1.0', sha, remote }));
    }
    refused(await post(idv, 'tag/push', { name: ['v1.0'], sha, remote: 'origin' }));
    expect(snapshot(fx.origin)).toBe(before);
    assertRemotesSafe(fx.a);
    expect((await post(idv, 'tag/push', { name: 'v1.0', sha, remote: 'origin' })).status).toBe(200); // alive
  });

  it('refuses a remote whose url contains :: and never runs its helper', async () => {
    const { fx, id, sha } = tagFx();
    const marker = join(fresh('remotetags-ext-push'), 'ext-ran').replace(/\\/g, '/');
    git(fx.a, ['config', 'protocol.ext.allow', 'always']); // a hostile repo that enables ext in its own config
    git(fx.a, ['remote', 'add', 'evil', `ext::git init ${marker}`]);
    const r = await post(await id, 'tag/push', { name: 'v1.0', sha, remote: 'evil' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(marker, '.git')) || existsSync(join(marker, 'HEAD'))).toBe(false);
  });
});

// =====================================================================================================================================
describe('tag delete locally (journaled)', () => {
  function tagFx(): { fx: Fx; idP: Promise<string>; sha: string; tagObj: string } {
    const fx = makeFx();
    const sha = commit(fx.a, { 'more.txt': 'm\n' }, 'Tagged commit');
    git(fx.a, ['tag', '-a', 'v1.0', '-m', 'release one']);
    git(fx.a, ['tag', 'light']);
    return { fx, idP: openRepo(fx.a), sha, tagObj: git(fx.a, ['rev-parse', 'refs/tags/v1.0']).trim() };
  }
  const undoLabel = async (id: string): Promise<string | null> => ((await call('GET', `/api/repos/${id}/undo-state`)).body.undo as { label: string } | null)?.label ?? null;
  const redoLabel = async (id: string): Promise<string | null> => ((await call('GET', `/api/repos/${id}/undo-state`)).body.redo as { label: string } | null)?.label ?? null;

  it('deletes the tag, pins the tag object first, and records "delete tag \'v1.0\'"', async () => {
    const { fx, idP, sha, tagObj } = tagFx();
    const id = await idP;
    expect(pins(fx.a)).not.toContain(tagObj);
    expect((await post(id, 'tag/delete', { name: 'v1.0', sha })).status).toBe(200);
    expect(refOrUndef(fx.a, 'refs/tags/v1.0')).toBeUndefined();
    expect(pins(fx.a)).toContain(tagObj); // the annotated tag object is kept alive for undo
    expect(refOrUndef(fx.a, 'refs/tags/light')).toBe(sha); // other tags untouched
    expect(await undoLabel(id)).toBe("delete tag 'v1.0'");
  });

  it('undo restores the very same annotated tag object (still a tag object, same message); redo deletes it again; undo again restores', async () => {
    const { fx, idP, sha, tagObj } = tagFx();
    const id = await idP;
    expect((await post(id, 'tag/delete', { name: 'v1.0', sha })).status).toBe(200);
    expect((await post(id, 'undo')).status).toBe(200);
    expect(refOrUndef(fx.a, 'refs/tags/v1.0')).toBe(tagObj);
    expect(git(fx.a, ['cat-file', '-t', 'refs/tags/v1.0']).trim()).toBe('tag');
    expect(git(fx.a, ['tag', '-l', 'v1.0', '--format=%(contents:subject)']).trim()).toBe('release one');
    expect(await redoLabel(id)).toBe("delete tag 'v1.0'");
    expect((await post(id, 'redo')).status).toBe(200);
    expect(refOrUndef(fx.a, 'refs/tags/v1.0')).toBeUndefined();
    expect((await post(id, 'undo')).status).toBe(200);
    expect(refOrUndef(fx.a, 'refs/tags/v1.0')).toBe(tagObj);
  });

  it('a lightweight tag is deleted and restored too', async () => {
    const { fx, idP, sha } = tagFx();
    const id = await idP;
    expect((await post(id, 'tag/delete', { name: 'light', sha })).status).toBe(200);
    expect(refOrUndef(fx.a, 'refs/tags/light')).toBeUndefined();
    expect((await post(id, 'undo')).status).toBe(200);
    expect(refOrUndef(fx.a, 'refs/tags/light')).toBe(sha);
  });

  it('a wrong sha is 409 and the tag stays; bad names and missing tags are refused; nothing changes', async () => {
    const { fx, idP, sha } = tagFx();
    const id = await idP;
    const before = snapshot(fx.a);
    expect((await post(id, 'tag/delete', { name: 'v1.0', sha: fx.baseSha })).status).toBe(409);
    for (const name of ['', '-x', '--force', 'a:b', 'a b', 'a..b', 'does-not-exist', 'main', 'refs/heads/main']) {
      refused(await post(id, 'tag/delete', { name, sha }));
    }
    refused(await post(id, 'tag/delete', { name: 'v1.0', sha: 'zzz' }));
    refused(await post(id, 'tag/delete', { name: 'v1.0' }));
    expect(snapshot(fx.a)).toBe(before);
    expect(refOrUndef(fx.a, 'refs/heads/main')).toBe(sha);
  });

  it('fails closed: when the pin cannot be written the tag is NOT deleted', async () => {
    const { fx, idP, sha, tagObj } = tagFx();
    const id = await idP;
    // Whatever sha the pin ref is named after (the tag object or its commit), its lock file already exists, so update-ref cannot create it.
    mkdirSync(join(fx.a, '.git', 'refs', 'gitslappin', 'undo'), { recursive: true });
    for (const s of [tagObj, sha]) writeFileSync(join(fx.a, '.git', 'refs', 'gitslappin', 'undo', `${s}.lock`), '');
    const r = await post(id, 'tag/delete', { name: 'v1.0', sha });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(refOrUndef(fx.a, 'refs/tags/v1.0')).toBe(tagObj);
    expect(await undoLabel(id)).toBeNull(); // nothing journaled
  });
});

// =====================================================================================================================================
describe('tag delete from the remote', () => {
  async function pushed(): Promise<{ fx: Fx; id: string; sha: string; tagObj: string }> {
    const fx = makeFx();
    const sha = commit(fx.a, { 'more.txt': 'm\n' }, 'Tagged commit');
    git(fx.a, ['tag', '-a', 'v1.0', '-m', 'release one']);
    const id = await openRepo(fx.a);
    assertRemotesSafe(fx.a);
    expect((await post(id, 'tag/push', { name: 'v1.0', sha, remote: 'origin' })).status).toBe(200);
    const tagObj = git(fx.a, ['rev-parse', 'refs/tags/v1.0']).trim();
    expect(refOrUndef(fx.origin, 'refs/tags/v1.0')).toBe(tagObj);
    return { fx, id, sha, tagObj };
  }

  it('audit fix 3: the delete argv works against the bare repo: the tag is gone there, the local tag stays, nothing else on origin moves', async () => {
    const { fx, id, sha, tagObj } = await pushed();
    const others = snapshot(fx.origin).split('\n').filter((l) => !l.includes('refs/tags/v1.0'));
    assertRemotesSafe(fx.a);
    const r = await post(id, 'tag/delete-remote', { name: 'v1.0', sha, remote: 'origin' });
    expect(r.status).toBe(200);
    expect(refOrUndef(fx.origin, 'refs/tags/v1.0')).toBeUndefined();
    expect(snapshot(fx.origin).split('\n')).toEqual(others);
    expect(refOrUndef(fx.a, 'refs/tags/v1.0')).toBe(tagObj);
  });

  it('is not journaled (no undo entry is added)', async () => {
    const { id, sha } = await pushed();
    const before = (await call('GET', `/api/repos/${id}/undo-state`)).body;
    expect((await post(id, 'tag/delete-remote', { name: 'v1.0', sha, remote: 'origin' })).status).toBe(200);
    expect((await call('GET', `/api/repos/${id}/undo-state`)).body).toEqual(before);
  });

  it('a lease mismatch (the remote tag was moved by somebody else) is refused and the remote tag stays', async () => {
    const { fx, id, sha, tagObj } = await pushed();
    assertRemotesSafe(fx.b);
    git(fx.b, ['pull', '--ff-only', 'origin', 'main']);
    git(fx.b, ['fetch', 'origin', '--tags']);
    commit(fx.b, { 'other.txt': 'o\n' }, 'Other side commit', 'Other Author');
    git(fx.b, ['tag', '-f', '-a', 'v1.0', '-m', 'their moved release']);
    git(fx.b, ['push', '--force', 'origin', 'refs/tags/v1.0:refs/tags/v1.0']);
    const theirs = refOrUndef(fx.origin, 'refs/tags/v1.0');
    expect(theirs).toBeDefined();
    expect(theirs).not.toBe(tagObj); // the lease really differs
    const before = snapshot(fx.origin);
    assertRemotesSafe(fx.a);
    const r = await post(id, 'tag/delete-remote', { name: 'v1.0', sha, remote: 'origin' });
    expect(r.status).toBeGreaterThanOrEqual(400); // the code path ran and answered
    expect(snapshot(fx.origin)).toBe(before);
    expect(refOrUndef(fx.origin, 'refs/tags/v1.0')).toBe(theirs);
    expect(refOrUndef(fx.a, 'refs/tags/v1.0')).toBe(tagObj);
  });

  it('is only possible while the local tag exists', async () => {
    const { fx, id, sha, tagObj } = await pushed();
    expect((await post(id, 'tag/delete', { name: 'v1.0', sha })).status).toBe(200); // delete locally first
    const before = snapshot(fx.origin);
    refused(await post(id, 'tag/delete-remote', { name: 'v1.0', sha, remote: 'origin' }));
    expect(snapshot(fx.origin)).toBe(before);
    expect(refOrUndef(fx.origin, 'refs/tags/v1.0')).toBe(tagObj);
  });

  it('a wrong sha is 409; bad names, unknown remotes and remotes that look like options are refused; origin never changes', async () => {
    const { fx, id, sha } = await pushed();
    const before = snapshot(fx.origin);
    expect((await post(id, 'tag/delete-remote', { name: 'v1.0', sha: fx.baseSha, remote: 'origin' })).status).toBe(409);
    for (const name of ['', '-x', '--delete', 'a:b', 'a b', 'main', ':v1.0', '+v1.0']) refused(await post(id, 'tag/delete-remote', { name, sha, remote: 'origin' }));
    for (const remote of ['', 'nope', '-x', '--upload-pack=touch x', 'origin:x']) refused(await post(id, 'tag/delete-remote', { name: 'v1.0', sha, remote }));
    expect(snapshot(fx.origin)).toBe(before);
  });

  it('refuses a remote whose url contains :: and never runs its helper', async () => {
    const { fx, id, sha } = await pushed();
    const marker = join(fresh('remotetags-ext-del'), 'ext-ran').replace(/\\/g, '/');
    git(fx.a, ['config', 'protocol.ext.allow', 'always']);
    git(fx.a, ['remote', 'add', 'evil', `ext::git init ${marker}`]);
    expect((await post(id, 'tag/delete-remote', { name: 'v1.0', sha, remote: 'evil' })).status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(marker, '.git')) || existsSync(join(marker, 'HEAD'))).toBe(false);
  });
});

// =====================================================================================================================================
describe('auto-fetch', () => {
  const auto = (id: string) => post(id, 'fetch', { auto: true });

  it('fetch --all: reports changed true when a ref moved, then false; the local branch is untouched', async () => {
    const fx = makeFx();
    const id = await openRepo(fx.a);
    const sha = originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    assertRemotesSafe(fx.a);
    const r1 = await auto(id);
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ outcome: 'done', changed: true });
    expect(refOrUndef(fx.a, 'refs/remotes/origin/main')).toBe(sha);
    expect(head(fx.a)).toBe(fx.baseSha);
    const r2 = await auto(id);
    expect(r2.body).toEqual({ outcome: 'done', changed: false });
  });

  it('a new remote branch and a new remote tag both count as changed', async () => {
    const fx = makeFx();
    const id = await openRepo(fx.a);
    git(fx.b, ['tag', '-a', 'from-b', '-m', 'b']);
    git(fx.b, ['push', 'origin', 'from-b']);
    assertRemotesSafe(fx.a);
    expect((await auto(id)).body.changed).toBe(true);
    expect(refOrUndef(fx.a, 'refs/tags/from-b')).toBeDefined();
  });

  it('never writes the command log (user-started fetch does, so the log is alive)', async () => {
    const fx = makeFx();
    const id = await openRepo(fx.a);
    originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    assertRemotesSafe(fx.a);
    const before = getCommandLog(id).length;
    const r = await auto(id);
    expect(r.body.changed).toBe(true); // the fetch really ran
    expect(getCommandLog(id).length).toBe(before); // no entry: not for fetch, not for the fingerprints
    originAdvance(fx, { 'new2.txt': 'n2\n' }, 'Remote new 2');
    expect((await post(id, 'fetch', {})).status).toBe(200);
    expect(getCommandLog(id).length).toBeGreaterThan(before);
  });

  it('audit fix: never passes --prune (a remote-tracking ref of a deleted remote branch survives); the user-started Fetch still prunes it', async () => {
    const fx = makeFx();
    assertRemotesSafe(fx.b);
    git(fx.b, ['switch', '-c', 'old']);
    commit(fx.b, { 'old.txt': 'old\n' }, 'Branch old commit', 'Other Author');
    git(fx.b, ['push', 'origin', 'old']);
    git(fx.b, ['switch', 'main']);
    git(fx.a, ['fetch', 'origin']);
    expect(refOrUndef(fx.a, 'refs/remotes/origin/old')).toBeDefined();
    git(fx.b, ['push', 'origin', '--delete', 'old']);
    originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    expect(cfgGet(fx.a, 'fetch.prune')).toBeUndefined(); // only the argv decides here, not config
    const id = await openRepo(fx.a);
    assertRemotesSafe(fx.a);
    const r = await auto(id);
    expect(r.body.changed).toBe(true); // the fetch ran (origin/main moved)
    expect(refOrUndef(fx.a, 'refs/remotes/origin/old')).toBeDefined(); // not pruned
    expect((await post(id, 'fetch', {})).status).toBe(200);
    expect(refOrUndef(fx.a, 'refs/remotes/origin/old')).toBeUndefined(); // user-clicked Fetch prunes
  });

  it('returns skipped while the repo is busy, and never queues: it does not run after the busy block ends', async () => {
    const fx = makeFx();
    const id = await openRepo(fx.a);
    const sha = originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    assertRemotesSafe(fx.a);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((ok) => (release = ok));
    const held = runExclusive(id, () => gate);
    const t0 = Date.now();
    const r = await auto(id);
    expect(Date.now() - t0).toBeLessThan(5_000); // answered at once, did not wait for the lock
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ outcome: 'skipped' });
    release();
    await held;
    await new Promise((ok) => setTimeout(ok, 1500));
    expect(refOrUndef(fx.a, 'refs/remotes/origin/main')).toBe(fx.baseSha); // nothing was fetched, even after the lock freed
    expect((await auto(id)).body).toEqual({ outcome: 'done', changed: true }); // a fresh call works, the tracking ref moves now
    expect(refOrUndef(fx.a, 'refs/remotes/origin/main')).toBe(sha);
  });

  it('audit fix: a user action is not delayed by a hung auto-fetch (the auto-fetch is aborted and answers skipped)', async () => {
    const port = await startHangingGitServer();
    const repo = soloRepo('autofetch-hung');
    git(repo, ['remote', 'add', 'slow', `git://127.0.0.1:${port}/x.git`]); // a server that accepts and never answers
    const id = await openRepo(repo);
    const connectionsBefore = tcpConnections;
    const pending = auto(id);
    const deadline = Date.now() + 20_000;
    while (tcpConnections === connectionsBefore && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 50));
    expect(tcpConnections).toBeGreaterThan(connectionsBefore); // git is really stuck on the network now
    const t0 = Date.now();
    const user = await post(id, 'upstream', { branch: 'main', remote: 'slow', remoteBranch: 'main' }); // a user mutation that takes the repo lock
    const waited = Date.now() - t0;
    expect(user.status).toBe(200);
    expect(cfgGet(repo, 'branch.main.remote')).toBe('slow'); // it really ran
    expect(waited).toBeLessThan(8_000); // not behind a 30 s timeout (nor the 5 minute one)
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ outcome: 'skipped' });
  });

  it('audit fix 8: the askpass script is rewritten with fixed content on every start (a planted file is never trusted)', async () => {
    const path = join(DATA_DIR, ASKPASS_NAME);
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(PLANTED);
    expect(text.trim().length).toBeGreaterThan(0);
    if (process.platform !== 'win32') expect(spawnSync('stat', ['-c', '%a', path], { encoding: 'utf8' }).stdout.trim()).toMatch(/^[57]00$/); // owner only, exec bit
    // it is a failing credential helper: running it exits non-zero without output on stdout
    const run = process.platform === 'win32' ? spawnSync(`"${path}" "Username for x: "`, { shell: true, encoding: 'utf8' }) : spawnSync(path, ['Username for x: '], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect((run.stdout ?? '').trim()).toBe('');
  });

  it('audit fix 8: an https remote that needs credentials fails fast and silently (no prompt, no error text); a user-started fetch still asks', async () => {
    const port = await startUnauthorizedHttpServer();
    const repo = soloRepo('autofetch-https');
    git(repo, ['remote', 'add', 'web', `http://127.0.0.1:${port}/team/project.git`]);
    const id = await openRepo(repo);
    // control: the user-started fetch reaches the (trap) credential helper, so the trap is armed and the server answers 401
    const asksBefore = asks();
    const user = await post(id, 'fetch', {});
    expect(user.status).toBeGreaterThanOrEqual(400);
    expect(asks()).toBeGreaterThan(asksBefore);
    // the auto path replaces the helper with the server's failing script: the trap is never called
    const asksMid = asks();
    const t0 = Date.now();
    const r = await auto(id);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(asks()).toBe(asksMid);
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('failed');
    expect(r.body.stderr).toBeUndefined();
    expect(r.body.error).toBeUndefined();
  });

  it('audit fix 8: an ssh remote that wants a host key or passphrase fails fast and silently (SSH_ASKPASS_REQUIRE=force + failing script)', async () => {
    const repo = soloRepo('autofetch-ssh');
    git(repo, ['config', 'ssh.variant', 'ssh']);
    git(repo, ['remote', 'add', 'sshr', 'ssh://git@127.0.0.1:9/team/project.git']);
    const id = await openRepo(repo);
    const ranBefore = count(SSH_RAN);
    const ttyBefore = count(SSH_TTY);
    const t0 = Date.now();
    const r = await auto(id);
    expect(Date.now() - t0).toBeLessThan(10_000); // not the 20 s the fake ssh would wait, not the 30 s timeout
    expect(count(SSH_RAN)).toBeGreaterThan(ranBefore); // the ssh program really was started
    expect(count(SSH_TTY)).toBe(ttyBefore); // it was never allowed to prompt on a terminal
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('failed');
    expect(r.body.stderr).toBeUndefined();
    expect(r.body.error).toBeUndefined();
  });

  it('the request carries only auto:true: extra fields (an askpass path, env values) are ignored and a non-boolean auto is a plain user fetch', async () => {
    const fx = makeFx();
    const id = await openRepo(fx.a);
    const evil = join(fresh('autofetch-evil'), 'evil-askpass.cmd');
    const r = await post(id, 'fetch', { auto: true, askpass: evil, env: { GIT_ASKPASS: evil }, GIT_ASKPASS: evil });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('done');
    expect(existsSync(evil)).toBe(false);
    const user = await post(id, 'fetch', { auto: 'yes' });
    expect(user.body.changed).toBeUndefined(); // not the auto response
  });

  it('auto-fetch of a repo with no remote does nothing and says so quietly', async () => {
    const repo = soloRepo('autofetch-none');
    const id = await openRepo(repo);
    const r = await auto(id);
    expect(r.status).toBe(200);
    expect(['skipped', 'failed', 'done']).toContain(r.body.outcome);
    expect(r.body.changed).not.toBe(true);
  });
});
