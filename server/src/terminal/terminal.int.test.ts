import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';

vi.setConfig({ testTimeout: 90_000 });

/*
 * V6b real-PTY integration test. Windows only (skipped elsewhere): a real node-pty and the real PowerShell, through the real server and a real `ws` client.
 * Uses the DEFAULT hub built by buildApp (no terminalHub injected), so it also proves node-pty loads on this Node.
 * Output is asserted with marker strings built so that the echo of the typed command can never match (the text is split inside the command), never the exact
 * prompt (the user's PowerShell profile may print). ANSI escapes are stripped first. The terminal is 500 columns wide so a path never wraps.
 * A fake `powershell.exe` is planted at the repo root: if the server ever spawned a bare name with cwd = the repo, the shell would not start and every test fails.
 * Real git in a mkdtemp repo under os.tmpdir()/gitslappin-tests. Nothing is deleted.
 * UNVERIFIED: `ws` must be importable from server/ (dependency of @fastify/websocket; hoisted), and node-pty needs a prebuild for this Node (design item 1 says to verify).
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

const TOKEN = 'p'.repeat(40);
const GLOBAL_CFG = join(fresh('gitcfg-terminal'), 'global.gitconfig');
writeFileSync(GLOBAL_CFG, '');
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: GLOBAL_CFG,
  GIT_AUTHOR_NAME: 'Term Test',
  GIT_AUTHOR_EMAIL: 'term@example.com',
  GIT_COMMITTER_NAME: 'Term Test',
  GIT_COMMITTER_EMAIL: 'term@example.com',
};
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', windowsHide: true });

function makeRepo(): string {
  const dir = join(fresh('gitslappin-term'), 'demo');
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  writeFileSync(join(dir, 'powershell.exe'), 'not a real executable: planted to catch a bare-name spawn\n');
  return dir;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

interface Session {
  ws: WebSocket;
  id: string;
  text: () => string;
  type: (line: string) => void;
  waitFor: (re: RegExp, ms?: number) => Promise<RegExpMatchArray>;
}

describe.skipIf(process.platform !== 'win32')('real PowerShell through the in-app terminal', () => {
  let app: FastifyInstance;
  let port: number;
  let repo: string;
  let repoId: string;
  const savedEnv: Record<string, string | undefined> = {};
  const sockets: WebSocket[] = [];
  const streams: ClientRequest[] = [];

  const api = (method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> =>
    new Promise((ok, fail) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { host: `127.0.0.1:${port}`, 'x-gitslappin-token': TOKEN };
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(payload));
      }
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => ok({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('error', fail);
      req.end(payload);
    });

  function events(id: string): { types: () => string[] } {
    const got: string[] = [];
    const req = request({ host: '127.0.0.1', port, path: `/api/repos/${id}/events`, method: 'GET', headers: { host: `127.0.0.1:${port}`, 'x-gitslappin-token': TOKEN } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          for (const line of buf.slice(0, i).split('\n')) if (line.startsWith('data:')) got.push((JSON.parse(line.slice(5)) as { type: string }).type);
          buf = buf.slice(i + 2);
        }
      });
      res.on('error', () => undefined);
    });
    req.on('error', () => undefined);
    req.end();
    streams.push(req);
    return { types: () => got };
  }

  async function startSession(): Promise<Session> {
    const t = JSON.parse((await api('POST', '/api/terminal/ticket')).body).ticket as string;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal?ticket=${encodeURIComponent(t)}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    sockets.push(ws);
    await new Promise<void>((ok, fail) => {
      ws.once('open', () => ok());
      ws.once('error', fail);
      ws.once('unexpected-response', (_q, res) => fail(new Error(`upgrade refused: ${res.statusCode}`)));
    });
    let raw = '';
    let id = '';
    ws.on('message', (data) => {
      const f = JSON.parse(String(data)) as { t: string; id?: string; d?: string };
      if (f.t === 'opened') id = String(f.id);
      if (f.t === 'out') raw += f.d ?? '';
    });
    ws.send(JSON.stringify({ t: 'open', req: 1, repoId, cols: 500, rows: 30 }));
    const end = Date.now() + 20_000;
    while (!id && Date.now() < end) await sleep(50);
    if (!id) throw new Error('terminal did not open');
    const text = () => raw.replace(ANSI, '');
    return {
      ws,
      id,
      text,
      type: (line) => ws.send(JSON.stringify({ t: 'in', id, d: `${line}\r` })),
      waitFor: async (re, ms = 30_000) => {
        const stop = Date.now() + ms;
        while (Date.now() < stop) {
          const m = text().match(re);
          if (m) return m;
          await sleep(100);
        }
        throw new Error(`timed out waiting for ${re}; saw: ${text().slice(-500)}`);
      },
    };
  }

  beforeAll(async () => {
    for (const k of ['GITSLAPPIN_TOKEN', ...Object.keys(GIT_ENV)]) savedEnv[k] = process.env[k];
    Object.assign(process.env, GIT_ENV, { GITSLAPPIN_TOKEN: TOKEN }); // the shell inherits process.env; the token must NOT reach it
    port = await freePort();
    const config = loadConfig({ GITSLAPPIN_NO_OPEN: '1', GITSLAPPIN_TOKEN: TOKEN, GITSLAPPIN_PORT: String(port), GITSLAPPIN_DATA_DIR: fresh('gitslappin-unit-term'), GITSLAPPIN_WATCH: 'events' });
    app = await buildApp(config);
    await app.listen({ port, host: '127.0.0.1' });
    repo = realpathSync.native(makeRepo());
    const res = await api('POST', '/api/repos/open', { path: repo });
    expect(res.status).toBe(200);
    repoId = JSON.parse(res.body).id as string;
  });
  afterEach(() => {
    for (const s of sockets.splice(0)) s.close(); // the server allows 4 sockets at once; each test frees its own
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    for (const r of streams) r.destroy();
    await app.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('starts the real shell even though a powershell.exe sits at the repo root; the planted file is untouched', async () => {
    const s = await startSession();
    s.type('Write-Output ("UP_" + "OK" + ([string](1+1)))');
    await s.waitFor(/UP_OK2/);
    expect(readFileSync(join(repo, 'powershell.exe'), 'utf8')).toContain('not a real executable');
  });

  it('the shell does not have GITSLAPPIN_TOKEN, but does have PATH (the check is alive)', async () => {
    expect(process.env.GITSLAPPIN_TOKEN).toBe(TOKEN); // the server process really holds it
    const s = await startSession();
    s.type('Write-Output ("TOK_" + [string]($null -eq $env:GITSLAPPIN_TOKEN))');
    s.type('Write-Output ("ANY_" + [string]((Get-ChildItem Env: | Where-Object { $_.Name -like "GITSLAPPIN_*" } | Measure-Object).Count))');
    s.type('Write-Output ("PATH_" + [string]($env:PATH.Length -gt 10))');
    await s.waitFor(/TOK_True/);
    await s.waitFor(/ANY_0/);
    await s.waitFor(/PATH_True/);
    expect(s.text()).not.toContain(TOKEN);
  });

  it('the working directory is the repo root', async () => {
    const s = await startSession();
    s.type('Write-Output ("CWD_" + (Get-Location).Path)');
    const m = await s.waitFor(/CWD_([A-Za-z]:[^\r\n]+)/); // a drive path, so the echo of the typed command (CWD_" + ...) cannot match
    expect(m[1]!.trim().toLowerCase()).toBe(repo.toLowerCase());
  });

  it('a git commit typed in the terminal produces a refs event on the live-refresh stream', async () => {
    const ev = events(repoId);
    await sleep(2000); // the watcher takes its baseline
    const s = await startSession();
    s.type('git commit --allow-empty -q -m "typed in the terminal"; Write-Output ("DONE_" + "COMMIT")');
    await s.waitFor(/DONE_COMMIT/);
    const end = Date.now() + 15_000;
    while (!ev.types().includes('refs') && Date.now() < end) await sleep(100);
    expect(ev.types()).toContain('refs');
    expect(git(repo, ['log', '-1', '--format=%s']).trim()).toBe('typed in the terminal');
  });

  it('closing the socket kills the shell process (taskkill /T), not just the pty handle', async () => {
    const s = await startSession();
    s.type('Write-Output ("PID_" + "x" + $PID)');
    const m = await s.waitFor(/PID_x(\d+)/);
    const pid = Number(m[1]);
    expect(() => process.kill(pid, 0)).not.toThrow(); // alive before
    s.ws.close();
    const end = Date.now() + 15_000;
    let alive = true;
    while (alive && Date.now() < end) {
      try {
        process.kill(pid, 0);
        await sleep(200);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
