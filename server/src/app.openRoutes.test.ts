import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';

/*
 * V6 design "4 Toolbar, menu bar, terminal" + audit security 1, 2, 3. POST /api/repos/:id/open-terminal and POST /api/repos/:id/open-folder (new routes), GET /api/ping gains desktop:boolean.
 * Contract added to buildApp's second argument (chosen by the test author) so nothing here ever really spawns:
 *   buildApp(config, { openSpawn?: OpenSpawn; openPlatform?: NodeJS.Platform })
 *     type OpenSpawn = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore'; windowsHide?: boolean }) => { unref(): void; on?(...a: unknown[]): unknown }
 *     openSpawn defaults to child_process.spawn; the route calls it exactly once per accepted request and then child.unref().
 *     openPlatform defaults to process.platform; the gate reads it (and config.bind) on EVERY call (audit security 3), never anything the client sends.
 * Expected spawn calls (design + audit security 1): terminal -> file = %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe, args ['-NoExit'];
 *   folder -> file = %SystemRoot%\explorer.exe, args ['.']; both with detached:true, cwd = the repo root resolved from :id, env = process.env without any GITSLAPPIN_* key.
 * Answers: 200 { ok: true } on spawn; 404 unknown id; 403 no/wrong token, wrong Host or Origin (app-wide hook); 409 not (win32 and bind 127.0.0.1); 429 inside the 2 s per-repo cooldown;
 *   a throwing spawn -> an error status (>= 400) with no exception text in the body.
 * The tests that expect a real spawn call need a Windows host (SystemRoot, the startup exists-check on the two exes); they are skipped elsewhere (the project runs on Windows).
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const CFG = fresh('gitcfg-openroutes');
const EMPTY_GLOBAL = join(CFG, 'empty.gitconfig');
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
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

const PORT = 4995;
const TOKEN = 'o'.repeat(40);
const headers = { host: `127.0.0.1:${PORT}`, 'x-gitslappin-token': TOKEN };
type App = Awaited<ReturnType<typeof buildApp>>;
const WIN = process.platform === 'win32';
const itWin = it.skipIf(!WIN);
const sysRoot = (): string => process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const POWERSHELL = (): string => join(sysRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const EXPLORER = (): string => join(sysRoot(), 'explorer.exe');
const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();

function makeRepo(prefix = 'gitslappin-openroutes'): string {
  const dir = join(fresh(prefix), 'repo');
  mkdirSync(dir);
  git(dir, ['init', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# t\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'one']);
  // Audit security 1: a repo that contains programs named like the ones we start. They must never run.
  writeFileSync(join(dir, 'powershell.exe'), 'not a program');
  writeFileSync(join(dir, 'explorer.exe'), 'not a program');
  return dir;
}

interface Call {
  file: string;
  args: string[];
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: unknown };
}
function mockSpawn(opts: { throws?: Error } = {}) {
  const calls: Call[] = [];
  const unref = vi.fn();
  const spawn = (file: string, args: string[], options: Call['options']) => {
    calls.push({ file, args, options });
    if (opts.throws) throw opts.throws;
    return { unref, on: () => undefined };
  };
  return { calls, unref, spawn };
}

function envFor(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { GITSLAPPIN_NO_OPEN: '1', GITSLAPPIN_TOKEN: TOKEN, GITSLAPPIN_PORT: String(PORT), GITSLAPPIN_DATA_DIR: fresh('gitslappin-unit-openroutes'), ...extra };
}
async function setup(o: { platform?: NodeJS.Platform; docker?: boolean; throws?: Error } = {}) {
  const repo = makeRepo();
  const config = loadConfig(envFor(o.docker ? { GITSLAPPIN_BIND: '0.0.0.0', GITSLAPPIN_TOKEN: TOKEN } : {}));
  const m = mockSpawn(o.throws ? { throws: o.throws } : {});
  const app = await buildApp(config, { openSpawn: m.spawn, openPlatform: o.platform ?? process.platform });
  const open = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: repo } });
  expect(open.statusCode).toBe(200);
  const id = (JSON.parse(open.body) as { id: string }).id;
  return { app, repo, id, ...m };
}
const post = (app: App, url: string, payload?: unknown, h: Record<string, string> = headers) => app.inject({ method: 'POST', url, headers: h, ...(payload !== undefined ? { payload: payload as object } : {}) });
const ROUTES = ['open-terminal', 'open-folder'] as const;

describe('token, host, origin and unknown id (nothing is spawned)', () => {
  it.each(ROUTES)('%s: no token -> 403, wrong token -> 403, foreign Host -> 403, foreign Origin -> 403, unknown repo -> 404', async (route) => {
    const { app, id, calls } = await setup();
    const url = `/api/repos/${id}/${route}`;
    expect((await post(app, url, undefined, { host: headers.host })).statusCode).toBe(403);
    expect((await post(app, url, undefined, { host: headers.host, 'x-gitslappin-token': 'wrong' })).statusCode).toBe(403);
    expect((await post(app, url, undefined, { ...headers, host: 'evil.example:80' })).statusCode).toBe(403);
    expect((await post(app, url, undefined, { ...headers, origin: 'http://evil.example' })).statusCode).toBe(403);
    const unknown = await post(app, `/api/repos/${'f'.repeat(16)}/${route}`);
    expect(unknown.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('spawn arguments', () => {
  itWin('open-terminal: absolute powershell.exe from SystemRoot, args exactly ["-NoExit"], detached, cwd = the repo root, unref called once', async () => {
    const { app, id, repo, calls, unref } = await setup();
    const res = await post(app, `/api/repos/${id}/open-terminal`);
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(isAbsolute(c.file)).toBe(true);
    expect(same(c.file, POWERSHELL())).toBe(true);
    expect(same(c.file, join(repo, 'powershell.exe'))).toBe(false);
    expect(c.args).toEqual(['-NoExit']);
    expect(c.options.detached).toBe(true);
    expect(c.options.stdio).toBe('ignore');
    expect(same(c.options.cwd, repo)).toBe(true);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  itWin('open-folder: absolute explorer.exe from SystemRoot, args exactly ["."], detached, cwd = the repo root', async () => {
    const { app, id, repo, calls, unref } = await setup();
    const res = await post(app, `/api/repos/${id}/open-folder`);
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(isAbsolute(c.file)).toBe(true);
    expect(same(c.file, EXPLORER())).toBe(true);
    expect(same(c.file, join(repo, 'explorer.exe'))).toBe(false);
    expect(c.args).toEqual(['.']);
    expect(c.options.detached).toBe(true);
    expect(same(c.options.cwd, repo)).toBe(true);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  itWin.each(ROUTES)('%s: the client never sends a path; a path in the body, the query or a header is ignored', async (route) => {
    const { app, id, repo, calls } = await setup();
    const elsewhere = fresh('gitslappin-openroutes-elsewhere');
    const res = await app.inject({
      method: 'POST',
      url: `/api/repos/${id}/${route}?path=${encodeURIComponent(elsewhere)}&cwd=${encodeURIComponent(elsewhere)}`,
      headers: { ...headers, 'x-path': elsewhere },
      payload: { path: elsewhere, cwd: elsewhere, root: elsewhere, args: ['--evil'], file: 'calc.exe' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(same(calls[0]!.options.cwd, repo)).toBe(true);
    expect(calls[0]!.args.join(' ')).not.toContain(elsewhere);
    expect(calls[0]!.args.join(' ')).not.toContain('--evil');
    expect(calls[0]!.file).not.toMatch(/calc/i);
  });
});

describe('audit security 2: the spawned program does not get the GITSLAPPIN_* environment', () => {
  itWin.each(ROUTES)('%s: no GITSLAPPIN_* key (any case) and the token value appears nowhere in env', async (route) => {
    process.env.GITSLAPPIN_TOKEN = TOKEN;
    process.env.GITSLAPPIN_DATA_DIR = 'leak-data-dir';
    process.env.GITSLAPPIN_TEST_EXTRA = 'leak-extra';
    try {
      const { app, id, calls } = await setup();
      expect((await post(app, `/api/repos/${id}/${route}`)).statusCode).toBe(200);
      const env = calls[0]!.options.env;
      expect(Object.keys(env).filter((k) => /^GITSLAPPIN_/i.test(k))).toEqual([]);
      expect(Object.values(env).join('\n')).not.toContain(TOKEN);
      expect(Object.values(env).join('\n')).not.toContain('leak-extra');
      // The rest of the environment IS passed on (PATH is how the user's shell finds its tools), so this is not an empty-env pass.
      expect(Object.keys(env).some((k) => k.toLowerCase() === 'path')).toBe(true);
    } finally {
      delete process.env.GITSLAPPIN_DATA_DIR;
      delete process.env.GITSLAPPIN_TEST_EXTRA;
      delete process.env.GITSLAPPIN_TOKEN;
    }
  });
});

describe('audit security 3: the 409 gate is computed on the server on every call', () => {
  it.each(ROUTES)('%s: a non-Windows host answers 409 and spawns nothing, whatever the client claims', async (route) => {
    const { app, id, calls } = await setup({ platform: 'linux' });
    const url = `/api/repos/${id}/${route}`;
    for (const res of [
      await post(app, url),
      await post(app, url, { desktop: true, platform: 'win32', bind: '127.0.0.1' }),
      await app.inject({ method: 'POST', url: `${url}?desktop=1&platform=win32`, headers: { ...headers, 'x-desktop': 'true' } }),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(typeof JSON.parse(res.body).error).toBe('string');
    }
    expect(calls).toHaveLength(0);
  });

  it.each(ROUTES)('%s: bound to 0.0.0.0 (Docker) answers 409 and spawns nothing, even on win32 and with desktop:true from the client', async (route) => {
    const { app, id, calls } = await setup({ docker: true, platform: 'win32' });
    const res = await post(app, `/api/repos/${id}/${route}`, { desktop: true });
    expect(res.statusCode).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('GET /api/ping reports desktop:boolean, true only for win32 + 127.0.0.1, and keeps app and pid', async () => {
    const win = await setup({ platform: 'win32' });
    const a = JSON.parse((await win.app.inject({ method: 'GET', url: '/api/ping', headers })).body);
    expect(a.app).toBe('gitslappin');
    expect(typeof a.pid).toBe('number');
    expect(a.desktop).toBe(true);
    const lin = await setup({ platform: 'linux' });
    expect(JSON.parse((await lin.app.inject({ method: 'GET', url: '/api/ping', headers })).body).desktop).toBe(false);
    const dock = await setup({ platform: 'win32', docker: true });
    expect(JSON.parse((await dock.app.inject({ method: 'GET', url: '/api/ping', headers })).body).desktop).toBe(false);
  });
});

describe('audit security 3: one spawn per repo per 2 seconds', () => {
  itWin('a rapid repeat answers 429 without spawning; another repo is not throttled; after the cooldown it works again', async () => {
    const a = await setup();
    const url = `/api/repos/${a.id}/open-terminal`;
    expect((await post(a.app, url)).statusCode).toBe(200);
    expect(a.calls).toHaveLength(1);
    const again = await post(a.app, url);
    expect(again.statusCode).toBe(429);
    expect(typeof JSON.parse(again.body).error).toBe('string');
    expect((await post(a.app, `/api/repos/${a.id}/open-folder`)).statusCode).toBe(429); // the cooldown is per repo, shared by both routes
    expect(a.calls).toHaveLength(1);

    // a second repo in the same app
    const other = makeRepo('gitslappin-openroutes-b');
    const open = await a.app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: other } });
    const otherId = (JSON.parse(open.body) as { id: string }).id;
    expect((await post(a.app, `/api/repos/${otherId}/open-terminal`)).statusCode).toBe(200);
    expect(a.calls).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 2300));
    expect((await post(a.app, url)).statusCode).toBe(200);
    expect(a.calls).toHaveLength(3);
  });
});

describe('a failing spawn', () => {
  itWin.each(ROUTES)('%s: answers an error status and never echoes the exception text', async (route) => {
    const { app, id, calls } = await setup({ throws: new Error('boom C:\\secret\\path leak-9') });
    const res = await post(app, `/api/repos/${id}/${route}`);
    expect(calls).toHaveLength(1); // the code path ran
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain('leak-9');
    expect(res.body).not.toContain('C:\\secret');
  });
});
