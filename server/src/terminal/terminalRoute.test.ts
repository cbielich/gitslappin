import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { createTerminalHub } from './hub';
import { FakeSpawner } from './testFakes';

vi.setConfig({ testTimeout: 30_000 });

/*
 * V6b wiring: buildApp(config, { terminalHub }) (new optional opt; production builds the real hub itself) with a hub that has a FAKE pty, a real listening
 * server and a real `ws` client. Covers the token-hook exception (audit fix 1), the ticket route, /api/ping `terminal`, the Origin/Host rules on the upgrade,
 * ws maxPayload and app close killing every PTY.
 *   POST /api/terminal/ticket  (normal token hook)  -> 200 {ticket}; 409 when gated
 *   GET  /api/terminal?ticket=... (Upgrade: websocket) -> ws
 *   GET  /api/ping -> {app, pid, terminal: boolean}
 * UNVERIFIED: `ws` (a dependency of @fastify/websocket) must be importable from server/ (hoisted); if not, the builder adds it as a devDependency.
 * Everything under os.tmpdir()/gitslappin-tests; nothing is deleted; no real shell is started.
 */

const TOKEN = 't'.repeat(40);
const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}
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

const SYSROOT = 'C:\\Windows';
const PS = `${SYSROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

interface Rig {
  app: FastifyInstance;
  port: number;
  hub: ReturnType<typeof createTerminalHub>;
  spawner: FakeSpawner;
  taskkills: Array<[string, string[]]>;
  inject: (method: 'GET' | 'POST', url: string, headers?: Record<string, string>) => ReturnType<FastifyInstance['inject']>;
  ticket: () => Promise<string>;
}
const rigs: Rig[] = [];

async function rig(over: Record<string, unknown> = {}): Promise<Rig> {
  const port = await freePort();
  const spawner = new FakeSpawner();
  const taskkills: Array<[string, string[]]> = [];
  const repoRoot = fresh('term-route-repo');
  const hub = createTerminalHub({
    spawnPty: spawner.spawn,
    platform: 'win32',
    bind: '127.0.0.1',
    port,
    shellExists: (p: string) => p === PS,
    now: () => Date.now(),
    rootOf: (id: string) => (id === 'repo-1' ? repoRoot : undefined),
    env: { PATH: 'C:\\bin', GITSLAPPIN_TOKEN: TOKEN },
    systemRoot: SYSROOT,
    programFiles: 'C:\\Program Files',
    runTaskkill: (f: string, a: string[]) => void taskkills.push([f, a]),
    ...over,
  } as never);
  const config = loadConfig({ GITSLAPPIN_NO_OPEN: '1', GITSLAPPIN_TOKEN: TOKEN, GITSLAPPIN_PORT: String(port), GITSLAPPIN_DATA_DIR: fresh('gitslappin-unit-term-route'), GITSLAPPIN_WATCH: 'poll' });
  const app = await buildApp(config, { terminalHub: hub } as never);
  await app.listen({ port, host: '127.0.0.1' });
  const inject: Rig['inject'] = (method, url, headers = {}) => app.inject({ method, url, headers: { host: `127.0.0.1:${port}`, ...headers } });
  const ticket = async (): Promise<string> => {
    const res = await inject('POST', '/api/terminal/ticket', { 'x-gitslappin-token': TOKEN });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).ticket as string;
  };
  const r = { app, port, hub, spawner, taskkills, inject, ticket };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) await r.app.close();
});

const UPGRADE = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };

type Attempt = { status: 101; ws: WebSocket } | { status: number; ws?: undefined };
function connect(r: Rig, ticket: string | null, headers: Record<string, string | undefined> = {}): Promise<Attempt> {
  const h: Record<string, string> = { Origin: `http://127.0.0.1:${r.port}` };
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete h[k];
    else h[k] = v;
  }
  const url = `ws://127.0.0.1:${r.port}/api/terminal${ticket === null ? '' : `?ticket=${encodeURIComponent(ticket)}`}`;
  return new Promise((ok) => {
    const ws = new WebSocket(url, { headers: h });
    ws.once('open', () => ok({ status: 101, ws }));
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      ok({ status: res.statusCode ?? 0 });
    });
    ws.once('error', () => ok({ status: 0 }));
  });
}
function nextFrame(ws: WebSocket, t: string, ms = 5000): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`no ${t} frame`)), ms);
    const on = (data: WebSocket.RawData) => {
      const f = JSON.parse(String(data)) as Record<string, unknown>;
      if (f.t === t) {
        clearTimeout(timer);
        ws.off('message', on);
        ok(f);
      }
    };
    ws.on('message', on);
  });
}
const closed = (ws: WebSocket, ms = 5000): Promise<number> =>
  new Promise((ok, fail) => {
    if (ws.readyState === WebSocket.CLOSED) return ok(0);
    const timer = setTimeout(() => fail(new Error('socket did not close')), ms);
    ws.once('close', (code) => {
      clearTimeout(timer);
      ok(code);
    });
  });

describe('POST /api/terminal/ticket', () => {
  it('needs the token: none, wrong, and a ticket-style query do not help (403)', async () => {
    const r = await rig();
    expect((await r.inject('POST', '/api/terminal/ticket')).statusCode).toBe(403);
    expect((await r.inject('POST', '/api/terminal/ticket', { 'x-gitslappin-token': 'x'.repeat(40) })).statusCode).toBe(403);
    expect((await r.inject('POST', `/api/terminal/ticket?token=${TOKEN}`)).statusCode).toBe(403);
    expect(r.hub.ticketCount()).toBe(0);
  });

  it('with the token returns a ticket, uncached', async () => {
    const r = await rig();
    const res = await r.inject('POST', '/api/terminal/ticket', { 'x-gitslappin-token': TOKEN });
    expect(res.statusCode).toBe(200);
    expect(typeof JSON.parse(res.body).ticket).toBe('string');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(r.hub.ticketCount()).toBe(1);
  });

  it('a foreign Origin is refused by the normal hook before anything is issued', async () => {
    const r = await rig();
    const res = await r.inject('POST', '/api/terminal/ticket', { 'x-gitslappin-token': TOKEN, origin: 'http://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(r.hub.ticketCount()).toBe(0);
  });

  it('is 409 when the terminal is gated off (Docker bind, other platform, no pty module)', async () => {
    for (const over of [{ bind: '0.0.0.0' }, { platform: 'linux' }, { spawnPty: null }]) {
      const r = await rig(over);
      const res = await r.inject('POST', '/api/terminal/ticket', { 'x-gitslappin-token': TOKEN });
      expect(res.statusCode, JSON.stringify(Object.keys(over))).toBe(409);
      expect(r.hub.ticketCount()).toBe(0);
    }
  });
});

describe('/api/ping terminal flag (for the UI only)', () => {
  it('is true when available and false when gated; still needs the token', async () => {
    const on = await rig();
    const res = await on.inject('GET', '/api/ping', { 'x-gitslappin-token': TOKEN });
    expect(JSON.parse(res.body)).toMatchObject({ app: 'gitslappin', terminal: true });
    expect((await on.inject('GET', '/api/ping')).statusCode).toBe(403);
    const off = await rig({ bind: '0.0.0.0' });
    expect(JSON.parse((await off.inject('GET', '/api/ping', { 'x-gitslappin-token': TOKEN })).body).terminal).toBe(false);
  });
});

describe('audit 1: the token-hook exception is exact', () => {
  it('?ticket= on any other /api route is 403 and does not consume the ticket', async () => {
    const r = await rig();
    const t = await r.ticket();
    for (const url of [`/api/ping?ticket=${t}`, `/api/prefs?ticket=${t}`, `/api/repos?ticket=${t}`, `/api/repos/x/events?ticket=${t}`, `/api/terminal/ticket?ticket=${t}`]) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await r.inject(method, url, UPGRADE);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
    }
    expect(r.hub.ticketCount()).toBe(1);
  });

  it('encoded or extended paths of the terminal route are 403: /api/terminal/x, /api/terminal/, /api/terminal%2F.., %2f, double-encoded', async () => {
    const r = await rig();
    const t = await r.ticket();
    for (const path of ['/api/terminal/x', '/api/terminal/', '/api/terminal%2F..', '/api/terminal%2f', '/api/terminal%252F', '/api/terminal/..%2fping', '/api/%74erminal/x', '/api/terminal.']) {
      const res = await r.inject('GET', `${path}?ticket=${t}`, UPGRADE);
      expect(res.statusCode, path).toBe(403);
    }
    expect(r.hub.ticketCount()).toBe(1);
  });

  it('the exact route without the Upgrade header, or with another method, falls back to the token check (403) and keeps the ticket', async () => {
    const r = await rig();
    const t = await r.ticket();
    expect((await r.inject('GET', `/api/terminal?ticket=${t}`)).statusCode).toBe(403);
    expect((await r.inject('POST', `/api/terminal?ticket=${t}`, UPGRADE)).statusCode).toBe(403);
    expect((await r.inject('GET', `/api/terminal?ticket=${t}`, { upgrade: 'h2c' })).statusCode).toBe(403);
    expect(r.hub.ticketCount()).toBe(1);
  });

  it('a normal API call with the token header still works (control: the hook is alive)', async () => {
    const r = await rig();
    expect((await r.inject('GET', '/api/ping', { 'x-gitslappin-token': TOKEN })).statusCode).toBe(200);
  });
});

describe('the websocket upgrade', () => {
  it('a valid ticket with the right Origin and Host upgrades, then a terminal opens and its output arrives', async () => {
    const r = await rig();
    const a = await connect(r, await r.ticket());
    expect(a.status).toBe(101);
    if (a.status !== 101) return;
    a.ws.send(JSON.stringify({ t: 'open', req: 1, repoId: 'repo-1', cols: 80, rows: 24 }));
    const opened = await nextFrame(a.ws, 'opened');
    expect(opened.req).toBe(1);
    const out = nextFrame(a.ws, 'out');
    r.spawner.ptys[0]!.emitData('MARKER-OUT');
    expect(await out).toMatchObject({ id: opened.id, d: 'MARKER-OUT' });
    a.ws.close();
  });

  it('refuses no ticket, an unknown ticket and a reused ticket', async () => {
    const r = await rig();
    expect((await connect(r, null)).status).toBe(403);
    expect((await connect(r, 'bogus')).status).toBe(403);
    const t = await r.ticket();
    const first = await connect(r, t);
    expect(first.status).toBe(101);
    expect((await connect(r, t)).status).toBe(403);
    first.ws?.close();
  });

  it('refuses a missing Origin, a foreign Origin and a foreign Host, and each failed try uses the ticket up', async () => {
    const r = await rig();
    for (const headers of [{ Origin: undefined }, { Origin: 'http://evil.example' }, { Origin: `http://127.0.0.1:${r.port + 1}` }, { Host: 'evil.example' }]) {
      const t = await r.ticket();
      const bad = await connect(r, t, headers);
      expect(bad.status, JSON.stringify(headers)).toBe(403);
      expect(r.hub.ticketCount(), JSON.stringify(headers)).toBe(0);
      const retry = await connect(r, t);
      expect(retry.status, `retry after ${JSON.stringify(headers)}`).toBe(403);
    }
    expect(r.spawner.calls).toHaveLength(0);
  });

  it('a frame over 64 KiB closes the socket and a bad frame closes it too (ws maxPayload)', async () => {
    const r = await rig();
    const a = await connect(r, await r.ticket());
    if (a.status !== 101) throw new Error(`no upgrade: ${a.status}`);
    a.ws.send(JSON.stringify({ t: 'in', id: 'x', d: 'a'.repeat(70_000) }));
    await closed(a.ws);
    const b = await connect(r, await r.ticket());
    if (b.status !== 101) throw new Error(`no upgrade: ${b.status}`);
    b.ws.send('{oops');
    await closed(b.ws);
  });

  it('closing the socket kills its terminals with pty.kill plus taskkill by absolute path', async () => {
    const r = await rig();
    const a = await connect(r, await r.ticket());
    if (a.status !== 101) throw new Error(`no upgrade: ${a.status}`);
    a.ws.send(JSON.stringify({ t: 'open', req: 1, repoId: 'repo-1', cols: 80, rows: 24 }));
    await nextFrame(a.ws, 'opened');
    a.ws.close();
    await closed(a.ws);
    await vi.waitFor(() => expect(r.spawner.ptys[0]!.killed).toBe(1));
    expect(r.taskkills).toEqual([[`${SYSROOT}\\System32\\taskkill.exe`, ['/T', '/F', '/PID', '1000']]]);
  });

  it('app close kills every PTY (onClose) even with the socket still open', async () => {
    const r = await rig();
    const a = await connect(r, await r.ticket());
    if (a.status !== 101) throw new Error(`no upgrade: ${a.status}`);
    a.ws.send(JSON.stringify({ t: 'open', req: 1, repoId: 'repo-1', cols: 80, rows: 24 }));
    await nextFrame(a.ws, 'opened');
    await r.app.close();
    expect(r.spawner.ptys[0]!.killed).toBe(1);
    expect(r.taskkills).toHaveLength(1);
    rigs.splice(rigs.indexOf(r), 1);
  });

  it('an unknown repoId over the real route is error 404 and no PTY exists', async () => {
    const r = await rig();
    const a = await connect(r, await r.ticket());
    if (a.status !== 101) throw new Error(`no upgrade: ${a.status}`);
    a.ws.send(JSON.stringify({ t: 'open', req: 4, repoId: 'nope', cols: 80, rows: 24 }));
    expect(await nextFrame(a.ws, 'error')).toMatchObject({ req: 4, code: 404 });
    expect(r.spawner.calls).toHaveLength(0);
    a.ws.close();
  });
});
