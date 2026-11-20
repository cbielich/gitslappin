import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { runGit } from './git/runner';

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

/*
 * ===================================================================================================================================
 * Commit File Menu and Editor, P1 S5: POST /api/repos/:id/file/open and POST /api/repos/:id/file/difftool.
 * Contract chosen by the test author (the builder must match it):
 *   file/open     body { path, how: 'editor' | 'default' | 'show' }   -> 200 { ok: true }; the spawn goes through the same injected OpenSpawn
 *       OpenSpawn options gain `windowsVerbatimArguments?: boolean`.
 *       show    -> file = %SystemRoot%\explorer.exe, args = [ `/select,"<abs path>"` ] (one string), windowsVerbatimArguments: true
 *       default -> file = %SystemRoot%\explorer.exe, args = [ `"<abs path>"` ],            windowsVerbatimArguments: true; refused for program file types
 *       editor  -> file = the resolved editor exe (config.editor = GITSLAPPIN_EDITOR; here an absolute existing .exe), args = [ <abs path> ] (quotes optional)
 *       every spawn: detached true, stdio 'ignore', cwd = the repo root, no `shell`, env without any GITSLAPPIN_* key, unref() once.
 *   file/difftool body { sha, path, oldPath? }                        -> 200 { ok: true }
 *       buildApp(config, { difftoolRunner?: (args: string[], opts: RunOptions) => Promise<GitResult> })  the only thing that runs `git difftool`
 *       (default = runGit). Other git queries of the route (config, rev-parse) may use runGit; the mock below hands them to the real runGit.
 *       args contain '--literal-pathspecs' before 'difftool', the sha, the parent as `<sha>^` | `<sha>~1` | the parent's full sha (the empty tree
 *       4b825dc642cb6eb9a060e54bf8d69288fbee4904 for a root commit), and end with '--' followed by the path(s) (oldPath too when given).
 *       opts.cwd = repo root, opts.signal = an AbortSignal that aborts 30 minutes after the start. The abort is an AbortController + setTimeout
 *       (so a test can fake timers); AbortSignal.timeout() would not be seen by the fake timers and fails this test.
 *   Config.editor: string  = GITSLAPPIN_EDITOR trimmed, '' when unset; `.env.example` documents GITSLAPPIN_EDITOR.
 *   Order (spec S5): unknown id 404 -> not desktop 409 -> 2 s per-repo cooldown 429 -> path checks (400) -> git. Body keys the client sends beyond the contract are ignored.
 *   Refusal texts: default-program refusal error = `Failed to open <...>: this file type runs as a program` (spec section 8);
 *     configured editor missing = contains `The configured external editor was not found`.
 * UNVERIFIED: whether a request refused after the cooldown check also starts a new cooldown (each refusal case below therefore uses a fresh app);
 *   the status of "no diff tool set", "editor refused" and "difftool exited non-zero" (asserted as 4xx / >= 400 only); that a non-zero difftool exit is an error.
 * ===================================================================================================================================
 */

function makeFileRepo(): { dir: string; c1: string; c2: string; c3: string; tree: string } {
  const dir = join(fresh('gitslappin-fileopen'), 'repo');
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of Object.entries({ 'user.name': 'Test Author', 'user.email': 'author@example.com', 'core.autocrlf': 'false' })) git(dir, ['config', k, v]);
  const put = (rel: string, text: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put('README.md', '# readme\n');
  put('docs/notes.txt', 'one\n');
  put('bin/tool.exe', 'not a program');
  put('scripts/Setup.PS1', 'Write-Host x');
  put('sub dir/with space.txt', 'spaced\n');
  put('noext/README', 'plain\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'c1']);
  const c1 = git(dir, ['rev-parse', 'HEAD']).trim();
  put('docs/notes.txt', 'two\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'c2']);
  const c2 = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['mv', 'docs/notes.txt', 'docs/renamed.txt']);
  git(dir, ['commit', '-q', '-m', 'c3 rename']);
  const c3 = git(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, c1, c2, c3, tree: git(dir, ['rev-parse', `${c1}^{tree}`]).trim() };
}

interface RunnerCall {
  args: string[];
  opts: { cwd: string; signal?: AbortSignal; [k: string]: unknown };
}
/** Stands in for the difftool run. Anything that is not `git difftool` goes to the real runGit, so the route's own git queries still work. */
function mockRunner(init: { hang?: boolean; code?: number; stderr?: string } = {}) {
  const calls: RunnerCall[] = [];
  const releases: Array<() => void> = [];
  const state = { hang: init.hang ?? false, code: init.code ?? 0, stderr: init.stderr ?? '' };
  const run = (args: string[], opts: RunnerCall['opts']): Promise<{ code: number; stdout: string; stderr: string }> => {
    if (!args.includes('difftool')) return runGit(args, opts as never);
    calls.push({ args, opts });
    if (state.hang) return new Promise((res) => releases.push(() => res({ code: 0, stdout: '', stderr: '' })));
    return Promise.resolve({ code: state.code, stdout: '', stderr: state.stderr });
  };
  return { calls, state, run, release: () => releases.splice(0).forEach((r) => r()) };
}

async function setupFiles(o: { platform?: NodeJS.Platform; docker?: boolean; editor?: string; tool?: 'diff' | 'merge' | 'none'; runner?: ReturnType<typeof mockRunner>; throws?: Error } = {}) {
  const fx = makeFileRepo();
  const tool = o.tool ?? 'diff';
  if (tool === 'diff') {
    git(fx.dir, ['config', 'diff.tool', 'gitslappintest']);
    git(fx.dir, ['config', 'difftool.gitslappintest.cmd', 'true']);
  } else if (tool === 'merge') {
    git(fx.dir, ['config', 'merge.tool', 'gitslappintest']);
    git(fx.dir, ['config', 'mergetool.gitslappintest.cmd', 'true']);
  }
  const config = loadConfig(envFor({ GITSLAPPIN_EDITOR: o.editor ?? '', ...(o.docker ? { GITSLAPPIN_BIND: '0.0.0.0', GITSLAPPIN_TOKEN: TOKEN } : {}) }));
  const m = mockSpawn(o.throws ? { throws: o.throws } : {});
  const runner = o.runner ?? mockRunner();
  const app = await buildApp(config, { openSpawn: m.spawn, openPlatform: o.platform ?? process.platform, difftoolRunner: runner.run } as never);
  const open = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: fx.dir } });
  expect(open.statusCode).toBe(200);
  const id = (JSON.parse(open.body) as { id: string }).id;
  return { app, id, fx, runner, ...m };
}
const OPEN = 'file/open';
const DIFF = 'file/difftool';
const bodyFor = (route: string, fx: { c2: string }): Record<string, unknown> => (route === OPEN ? { path: 'docs/renamed.txt', how: 'show' } : { sha: fx.c2, path: 'docs/notes.txt' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errorText = (res: { body: string }): string => String((JSON.parse(res.body) as { error?: unknown }).error ?? '');
const absOf = (dir: string, rel: string): string => resolve(dir, ...rel.split('/'));
const lc = (s: string): string => s.toLowerCase();

describe('file/open and file/difftool: gate order (nothing is spawned or run on a refusal)', () => {
  it.each([OPEN, DIFF])('%s: no token, wrong token, foreign Host or Origin -> 403; unknown repo -> 404', async (route) => {
    const h = await setupFiles();
    const url = `/api/repos/${h.id}/${route}`;
    const payload = bodyFor(route, h.fx);
    expect((await post(h.app, url, payload, { host: headers.host })).statusCode).toBe(403);
    expect((await post(h.app, url, payload, { host: headers.host, 'x-gitslappin-token': 'wrong' })).statusCode).toBe(403);
    expect((await post(h.app, url, payload, { ...headers, host: 'evil.example:80' })).statusCode).toBe(403);
    expect((await post(h.app, url, payload, { ...headers, origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await post(h.app, `/api/repos/${'f'.repeat(16)}/${route}`, payload)).statusCode).toBe(404);
    expect(h.calls).toHaveLength(0);
    expect(h.runner.calls).toHaveLength(0);
    // control: the route exists (a non-desktop answer is 409, not 404)
    const lin = await setupFiles({ platform: 'linux' });
    expect((await post(lin.app, `/api/repos/${lin.id}/${route}`, bodyFor(route, lin.fx))).statusCode).toBe(409);
  });

  it.each([OPEN, DIFF])('%s: an unknown repo is 404 even where the desktop gate would say 409', async (route) => {
    const lin = await setupFiles({ platform: 'linux' });
    expect((await post(lin.app, `/api/repos/${'f'.repeat(16)}/${route}`, bodyFor(route, lin.fx))).statusCode).toBe(404);
    expect((await post(lin.app, `/api/repos/${lin.id}/${route}`, bodyFor(route, lin.fx))).statusCode).toBe(409); // control
  });

  it.each([OPEN, DIFF])('%s: a non-Windows host and a Docker bind answer 409 before any path check, whatever the body says', async (route) => {
    for (const o of [{ platform: 'linux' as const }, { platform: 'win32' as const, docker: true }]) {
      const h = await setupFiles(o);
      const url = `/api/repos/${h.id}/${route}`;
      const bad = route === OPEN ? { path: '../outside', how: 'nonsense', desktop: true } : { sha: 'not-a-sha', path: '../outside', desktop: true };
      for (const payload of [bodyFor(route, h.fx), bad, {}, { desktop: true, platform: 'win32', bind: '127.0.0.1' }]) {
        const res = await post(h.app, url, payload);
        expect(res.statusCode, JSON.stringify(o) + JSON.stringify(payload)).toBe(409);
        expect(typeof JSON.parse(res.body).error).toBe('string');
      }
      expect(h.calls).toHaveLength(0);
      expect(h.runner.calls).toHaveLength(0);
    }
  });

  itWin.each([OPEN, DIFF])('%s: a rapid repeat is 429 BEFORE the path checks (even with a bad path)', async (route) => {
    const h = await setupFiles();
    const url = `/api/repos/${h.id}/${route}`;
    expect((await post(h.app, url, bodyFor(route, h.fx))).statusCode).toBe(200);
    const bad = route === OPEN ? { path: '../outside', how: 'show' } : { sha: h.fx.c2, path: '../outside' };
    const again = await post(h.app, url, bad);
    expect(again.statusCode).toBe(429);
    expect(typeof JSON.parse(again.body).error).toBe('string');
    expect(route === OPEN ? h.calls : h.runner.calls).toHaveLength(1);
  });

  itWin.each([OPEN, DIFF])('%s: unsafe paths are 400 after the gate, and nothing is spawned or run', async (route) => {
    for (const path of ['../outside', '.git/config', 'C:/x', 'a\\b', 'CON', '']) {
      const h = await setupFiles();
      const payload = route === OPEN ? { path, how: 'show' } : { sha: h.fx.c2, path };
      const res = await post(h.app, `/api/repos/${h.id}/${route}`, payload);
      expect(res.statusCode, JSON.stringify(path)).toBe(400);
      expect(h.calls, JSON.stringify(path)).toHaveLength(0);
      expect(h.runner.calls, JSON.stringify(path)).toHaveLength(0);
      const ok = await post(h.app, `/api/repos/${h.id}/${route}`, bodyFor(route, h.fx)); // control: same app, a good request is accepted (or 429 if a refusal started the cooldown)
      expect([200, 429], JSON.stringify(path)).toContain(ok.statusCode);
    }
  });
});

describe('file/open: argv, environment, program types and editor', () => {
  itWin('show: explorer.exe /select,"<abs>" as ONE verbatim argument (a path with a space survives)', async () => {
    const h = await setupFiles();
    const res = await post(h.app, `/api/repos/${h.id}/${OPEN}`, { path: 'sub dir/with space.txt', how: 'show' });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.calls).toHaveLength(1);
    const c = h.calls[0]!;
    expect(isAbsolute(c.file)).toBe(true);
    expect(same(c.file, EXPLORER())).toBe(true);
    expect(c.args).toHaveLength(1);
    expect(lc(c.args[0]!)).toBe(lc(`/select,"${absOf(h.fx.dir, 'sub dir/with space.txt')}"`));
    const o = c.options as Record<string, unknown>;
    expect(o.windowsVerbatimArguments).toBe(true);
    expect(o.detached).toBe(true);
    expect(o.stdio).toBe('ignore');
    expect(o.shell).toBeFalsy();
    expect(same(String(o.cwd), h.fx.dir)).toBe(true);
    expect(h.unref).toHaveBeenCalledTimes(1);
  });

  itWin('default: explorer.exe "<abs>" as ONE verbatim argument, for a file type that is not a program', async () => {
    const h = await setupFiles();
    const res = await post(h.app, `/api/repos/${h.id}/${OPEN}`, { path: 'sub dir/with space.txt', how: 'default' });
    expect(res.statusCode, res.body).toBe(200);
    const c = h.calls[0]!;
    expect(same(c.file, EXPLORER())).toBe(true);
    expect(c.args).toHaveLength(1);
    expect(lc(c.args[0]!)).toBe(lc(`"${absOf(h.fx.dir, 'sub dir/with space.txt')}"`));
    expect((c.options as Record<string, unknown>).windowsVerbatimArguments).toBe(true);
    expect((c.options as Record<string, unknown>).shell).toBeFalsy();
    expect(h.unref).toHaveBeenCalledTimes(1);
  });

  itWin('default: a file without an extension is allowed', async () => {
    const h = await setupFiles();
    const res = await post(h.app, `/api/repos/${h.id}/${OPEN}`, { path: 'noext/README', how: 'default' });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  itWin('default: program file types are refused with the section 8 wording, nothing is spawned (extension case does not matter)', async () => {
    for (const path of ['bin/tool.exe', 'scripts/Setup.PS1']) {
      const h = await setupFiles();
      const res = await post(h.app, `/api/repos/${h.id}/${OPEN}`, { path, how: 'default' });
      expect(res.statusCode, path).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, path).toBeLessThan(500);
      expect(res.statusCode, path).not.toBe(404);
      expect(errorText(res), path).toMatch(/^Failed to open /);
      expect(errorText(res), path).toContain('this file type runs as a program');
      expect(h.calls, path).toHaveLength(0);
    }
  });

  itWin('the program-type refusal is only for "default": show and editor work on the same .exe file', async () => {
    const show = await setupFiles();
    expect((await post(show.app, `/api/repos/${show.id}/${OPEN}`, { path: 'bin/tool.exe', how: 'show' })).statusCode).toBe(200);
    expect(lc(show.calls[0]!.args[0]!)).toBe(lc(`/select,"${absOf(show.fx.dir, 'bin/tool.exe')}"`));
    const ed = await setupFiles({ editor: process.execPath });
    expect((await post(ed.app, `/api/repos/${ed.id}/${OPEN}`, { path: 'bin/tool.exe', how: 'editor' })).statusCode).toBe(200);
    expect(ed.calls).toHaveLength(1);
  });

  itWin('editor: starts the configured absolute .exe with the absolute file path, detached, no shell, cwd = repo', async () => {
    const h = await setupFiles({ editor: process.execPath });
    const res = await post(h.app, `/api/repos/${h.id}/${OPEN}`, { path: 'sub dir/with space.txt', how: 'editor' });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.calls).toHaveLength(1);
    const c = h.calls[0]!;
    expect(same(c.file, process.execPath)).toBe(true);
    expect(isAbsolute(c.file)).toBe(true);
    expect(c.args).toHaveLength(1);
    expect(lc(c.args[0]!.replace(/^"|"$/g, ''))).toBe(lc(absOf(h.fx.dir, 'sub dir/with space.txt')));
    const o = c.options as Record<string, unknown>;
    expect(o.detached).toBe(true);
    expect(o.stdio).toBe('ignore');
    expect(o.shell).toBeFalsy();
    expect(same(String(o.cwd), h.fx.dir)).toBe(true);
    expect(h.unref).toHaveBeenCalledTimes(1);
  });

  itWin('editor: a missing editor exe, a .cmd/.bat, a relative path and a bare name are refused and nothing is spawned', async () => {
    const cases: Array<[string, string | null]> = [
      ['C:\\gitslappin-no-such-folder\\editor.exe', 'The configured external editor was not found'],
      ['C:\\gitslappin-no-such-folder\\editor.cmd', null],
      ['C:\\gitslappin-no-such-folder\\editor.bat', null],
      ['notepad.exe', null],
      ['tools\\editor.exe', null],
    ];
    for (const [editor, text] of cases) {
      const h = await setupFiles({ editor });
      const res = await post(h.app, `/api/repos/${h.id}/${OPEN}`, { path: 'docs/renamed.txt', how: 'editor' });
      expect(res.statusCode, editor).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, editor).toBeLessThan(500);
      expect(res.statusCode, editor).not.toBe(404);
      if (text) expect(errorText(res), editor).toContain(text);
      expect(h.calls, editor).toHaveLength(0);
    }
    const good = await setupFiles({ editor: process.execPath }); // control: a valid editor is accepted by the same route
    expect((await post(good.app, `/api/repos/${good.id}/${OPEN}`, { path: 'docs/renamed.txt', how: 'editor' })).statusCode).toBe(200);
  });

  itWin.each(['show', 'default', 'editor'])('%s: no GITSLAPPIN_* key (any case) and not the token value reach the started program; the rest of the environment is passed on', async (how) => {
    process.env.GITSLAPPIN_TOKEN = TOKEN;
    process.env.GITSLAPPIN_TEST_EXTRA = 'leak-extra';
    try {
      const h = await setupFiles({ editor: process.execPath });
      expect((await post(h.app, `/api/repos/${h.id}/${OPEN}`, { path: 'docs/renamed.txt', how })).statusCode).toBe(200);
      const env = h.calls[0]!.options.env;
      expect(Object.keys(env).filter((k) => /^GITSLAPPIN_/i.test(k))).toEqual([]);
      expect(Object.values(env).join('\n')).not.toContain(TOKEN);
      expect(Object.values(env).join('\n')).not.toContain('leak-extra');
      expect(Object.keys(env).some((k) => k.toLowerCase() === 'path')).toBe(true);
    } finally {
      delete process.env.GITSLAPPIN_TEST_EXTRA;
      delete process.env.GITSLAPPIN_TOKEN;
    }
  });

  itWin('the client cannot choose the program, the arguments or the folder: extra body keys are ignored', async () => {
    const h = await setupFiles();
    const elsewhere = fresh('gitslappin-fileopen-elsewhere');
    const res = await post(h.app, `/api/repos/${h.id}/${OPEN}?path=${encodeURIComponent(elsewhere)}`, { path: 'docs/renamed.txt', how: 'show', file: 'calc.exe', exe: 'calc.exe', args: ['--evil'], cwd: elsewhere, root: elsewhere, shell: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.calls).toHaveLength(1);
    const c = h.calls[0]!;
    expect(c.file).not.toMatch(/calc/i);
    expect(c.args.join(' ')).not.toContain('--evil');
    expect(c.args.join(' ')).not.toContain(elsewhere);
    expect(same(String((c.options as Record<string, unknown>).cwd), h.fx.dir)).toBe(true);
    expect((c.options as Record<string, unknown>).shell).toBeFalsy();
  });

  itWin('a path that is not a file in the working tree is refused (4xx) and nothing is spawned: tracked but renamed away, and never existing', async () => {
    for (const [path, how] of [['docs/notes.txt', 'show'], ['docs/notes.txt', 'default'], ['docs/notes.txt', 'editor'], ['nope.txt', 'show']] as const) {
      const h = await setupFiles({ editor: process.execPath });
      expect(existsSync(join(h.fx.dir, 'docs', 'notes.txt'))).toBe(false); // fixture check: commit c3 renamed it, so it is missing on disk
      const res = await post(h.app, `/api/repos/${h.id}/${OPEN}`, { path, how });
      expect(res.statusCode, `${path} ${how}: ${res.body}`).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, `${path} ${how}: ${res.body}`).toBeLessThan(500);
      expect(h.calls, `${path} ${how}`).toHaveLength(0);
    }
    const good = await setupFiles({ editor: process.execPath }); // control: an existing file is accepted by the same route
    expect((await post(good.app, `/api/repos/${good.id}/${OPEN}`, { path: 'docs/renamed.txt', how: 'show' })).statusCode).toBe(200);
    expect(good.calls).toHaveLength(1);
  });

  itWin('an invalid or missing "how" is 400 and nothing is spawned', async () => {
    for (const how of ['run', '', 'EDITOR', 'editor ', 5, null, undefined, ['show']]) {
      const h = await setupFiles({ editor: process.execPath });
      const res = await post(h.app, `/api/repos/${h.id}/${OPEN}`, { path: 'docs/renamed.txt', ...(how === undefined ? {} : { how }) });
      expect(res.statusCode, JSON.stringify(how)).toBe(400);
      expect(h.calls, JSON.stringify(how)).toHaveLength(0);
    }
    const h = await setupFiles();
    expect((await post(h.app, `/api/repos/${h.id}/${OPEN}`, { how: 'show' })).statusCode).toBe(400); // no path
    expect(h.calls).toHaveLength(0);
  });

  itWin('a failing spawn answers an error and never echoes the exception text', async () => {
    const h = await setupFiles({ throws: new Error('boom C:\\secret\\path leak-9') });
    const res = await post(h.app, `/api/repos/${h.id}/${OPEN}`, { path: 'docs/renamed.txt', how: 'show' });
    expect(h.calls).toHaveLength(1); // the code path ran
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain('leak-9');
    expect(res.body).not.toContain('C:\\secret');
  });
});

describe('file/difftool', () => {
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const after = (args: string[]): string[] => args.slice(args.lastIndexOf('--') + 1);

  itWin('runs git difftool for that file: commit vs its parent, literal pathspecs, repo cwd, an AbortSignal', async () => {
    const h = await setupFiles();
    const res = await post(h.app, `/api/repos/${h.id}/${DIFF}`, { sha: h.fx.c2, path: 'docs/notes.txt' });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.runner.calls).toHaveLength(1);
    const { args, opts } = h.runner.calls[0]!;
    expect(args).toContain('difftool');
    expect(args).toContain('--literal-pathspecs');
    expect(args.indexOf('--literal-pathspecs')).toBeLessThan(args.indexOf('difftool'));
    expect(args).toContain(h.fx.c2);
    expect(args.some((a) => a === h.fx.c1 || a === `${h.fx.c2}^` || a === `${h.fx.c2}~1`)).toBe(true); // the parent
    expect(args.slice(-2)).toEqual(['--', 'docs/notes.txt']);
    expect(same(opts.cwd, h.fx.dir)).toBe(true);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal!.aborted).toBe(false);
    expect(Object.keys((opts.env as object | undefined) ?? {}).filter((k) => /^GITSLAPPIN_/i.test(k))).toEqual([]);
  });

  itWin('a root commit is compared with the empty tree', async () => {
    const h = await setupFiles();
    const res = await post(h.app, `/api/repos/${h.id}/${DIFF}`, { sha: h.fx.c1, path: 'docs/notes.txt' });
    expect(res.statusCode, res.body).toBe(200);
    const { args } = h.runner.calls[0]!;
    expect(args).toContain(EMPTY_TREE);
    expect(args).toContain(h.fx.c1);
    expect(args.some((a) => a === `${h.fx.c1}^` || a === `${h.fx.c1}~1`)).toBe(false);
    expect(args.slice(-2)).toEqual(['--', 'docs/notes.txt']);
  });

  itWin('a renamed file passes both paths after "--"', async () => {
    const h = await setupFiles();
    const res = await post(h.app, `/api/repos/${h.id}/${DIFF}`, { sha: h.fx.c3, path: 'docs/renamed.txt', oldPath: 'docs/notes.txt' });
    expect(res.statusCode, res.body).toBe(200);
    expect([...after(h.runner.calls[0]!.args)].sort()).toEqual(['docs/notes.txt', 'docs/renamed.txt']);
  });

  itWin('merge.tool alone is enough; with neither diff.tool nor merge.tool it is refused and nothing runs (NoDiffToolSet)', async () => {
    const merge = await setupFiles({ tool: 'merge' });
    expect((await post(merge.app, `/api/repos/${merge.id}/${DIFF}`, { sha: merge.fx.c2, path: 'docs/notes.txt' })).statusCode).toBe(200);
    expect(merge.runner.calls).toHaveLength(1);
    const none = await setupFiles({ tool: 'none' });
    const res = await post(none.app, `/api/repos/${none.id}/${DIFF}`, { sha: none.fx.c2, path: 'docs/notes.txt' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.statusCode).not.toBe(404);
    expect(none.runner.calls).toHaveLength(0);
  });

  itWin('a sha that is not 40-64 lowercase hex or not a commit is refused and nothing runs', async () => {
    const kinds: Array<(fx: { c1: string; tree: string }) => unknown> = [
      () => 'main',
      () => 'HEAD',
      () => 'HEAD~1',
      (fx) => fx.c1.slice(0, 7),
      (fx) => `${fx.c1}^`,
      () => '--help',
      () => 'a'.repeat(40),
      (fx) => fx.tree, // a tree, not a commit
      () => '',
      () => 5,
      () => null,
    ];
    for (const make of kinds) {
      const h = await setupFiles(); // a fresh app each time (a refusal may or may not start the cooldown)
      const sha = make(h.fx);
      const res = await post(h.app, `/api/repos/${h.id}/${DIFF}`, { sha, path: 'docs/notes.txt' });
      expect(res.statusCode, JSON.stringify(sha)).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, JSON.stringify(sha)).toBeLessThan(500);
      expect(h.runner.calls, JSON.stringify(sha)).toHaveLength(0);
    }
    const good = await setupFiles(); // control
    expect((await post(good.app, `/api/repos/${good.id}/${DIFF}`, { sha: good.fx.c2, path: 'docs/notes.txt' })).statusCode).toBe(200);
  });

  itWin('one run per repo: a second request while the tool is still open is 409 (after the cooldown); once it ends a new one is accepted', async () => {
    const runner = mockRunner({ hang: true });
    const h = await setupFiles({ runner });
    const url = `/api/repos/${h.id}/${DIFF}`;
    const body = { sha: h.fx.c2, path: 'docs/notes.txt' };
    const first = post(h.app, url, body);
    const deadline = Date.now() + 10_000;
    while (runner.calls.length === 0 && Date.now() < deadline) await sleep(50);
    expect(runner.calls).toHaveLength(1); // the tool really started, so the busy flag is set
    await sleep(2300); // past the 2 s cooldown: the answer below is the busy flag, not the cooldown
    const second = await post(h.app, url, body);
    expect(second.statusCode, second.body).toBe(409);
    expect(runner.calls).toHaveLength(1);
    runner.state.hang = false;
    runner.release();
    await first;
    await sleep(2300);
    const third = await post(h.app, url, body);
    expect(third.statusCode, third.body).toBe(200);
    expect(runner.calls).toHaveLength(2);
  }, 60_000);

  itWin('the AbortSignal given to the run fires after 30 minutes (and not before)', async () => {
    const runner = mockRunner({ hang: true });
    const h = await setupFiles({ runner });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let pending: Promise<unknown> | undefined;
    try {
      pending = post(h.app, `/api/repos/${h.id}/${DIFF}`, { sha: h.fx.c2, path: 'docs/notes.txt' });
      // Wait in REAL time for the route's own git queries (setImmediate and Date are not faked); the fake clock does not move here.
      const deadline = Date.now() + 20_000;
      while (runner.calls.length === 0 && Date.now() < deadline) await new Promise<void>((r) => setImmediate(r));
      expect(runner.calls).toHaveLength(1);
      const signal = runner.calls[0]!.opts.signal!;
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(61 * 1000);
      expect(signal.aborted).toBe(true);
    } finally {
      runner.state.hang = false;
      runner.release();
      vi.useRealTimers();
      await pending;
    }
  }, 60_000);

  itWin('a difftool that fails never echoes its output (paths, exception text)', async () => {
    const h = await setupFiles({ runner: mockRunner({ code: 1, stderr: 'fatal: C:\\secret\\path leak-77' }) });
    const res = await post(h.app, `/api/repos/${h.id}/${DIFF}`, { sha: h.fx.c2, path: 'docs/notes.txt' });
    expect(h.runner.calls).toHaveLength(1); // the code path ran
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain('leak-77');
    expect(res.body).not.toContain('C:\\secret');
    expect(res.body).not.toContain('C:\\\\secret');
  });
});

describe('GITSLAPPIN_EDITOR configuration', () => {
  it('Config.editor is the trimmed value, and empty when unset', () => {
    expect(loadConfig(envFor()).editor).toBe('');
    expect(loadConfig(envFor({ GITSLAPPIN_EDITOR: '  C:\\Tools\\edit.exe  ' })).editor).toBe('C:\\Tools\\edit.exe');
    expect(loadConfig(envFor({ GITSLAPPIN_EDITOR: 'code' })).editor).toBe('code');
  });

  it('.env.example documents GITSLAPPIN_EDITOR', () => {
    const text = readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');
    expect(text).toContain('GITSLAPPIN_EDITOR');
  });
});
