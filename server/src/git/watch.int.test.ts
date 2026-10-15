import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';

/*
 * Live auto-refresh, end to end on the server: GET /api/repos/:id/events (token-gated hijacked stream, lines `data: {"type":...}`).
 * ASSUMED: no hello line is sent, so after connecting the test waits SETTLE_MS for the watcher's baseline; keep-alive comment lines
 * (": ...") are ignored. 404 for an unknown id, 403 without the token (the app-wide hook), 429 past 8 streams per repo / 32 total.
 * Real git in mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted; streams are closed, that is all.
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const GLOBAL_CFG = join(fresh('gitcfg-watch'), 'global.gitconfig');
writeFileSync(GLOBAL_CFG, '');
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: GLOBAL_CFG,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Watch Test',
  GIT_AUTHOR_EMAIL: 'watch@example.com',
  GIT_COMMITTER_NAME: 'Watch Test',
  GIT_COMMITTER_EMAIL: 'watch@example.com',
};
delete ENV.GITSLAPPIN_TOKEN;
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL_CFG, GIT_AUTHOR_NAME: 'Watch Test', GIT_AUTHOR_EMAIL: 'watch@example.com', GIT_COMMITTER_NAME: 'Watch Test', GIT_COMMITTER_EMAIL: 'watch@example.com' });

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true });

function makeRepo(name: string): string {
  const dir = join(fresh(`gitslappin-watch-${name}`), name);
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

const TOKEN = 'w'.repeat(40);
const SETTLE_MS = 1500;
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

interface Server {
  app: FastifyInstance;
  port: number;
  api: (method: string, path: string, body?: unknown, token?: string | null) => Promise<{ status: number; body: string }>;
  open: (root: string) => Promise<string>;
  stream: (id: string) => Promise<Stream>;
}
interface Stream {
  status: number;
  events: string[];
  types: () => string[];
  close: () => void;
}

async function startServer(watch: 'events' | 'poll'): Promise<Server> {
  const port = await freePort();
  const config = loadConfig({ GITSLAPPIN_NO_OPEN: '1', GITSLAPPIN_TOKEN: TOKEN, GITSLAPPIN_PORT: String(port), GITSLAPPIN_DATA_DIR: fresh('gitslappin-unit-watch'), GITSLAPPIN_WATCH: watch });
  const app = await buildApp(config);
  await app.listen({ port, host: '127.0.0.1' });
  const api: Server['api'] = (method, path, body, token = TOKEN) =>
    new Promise((ok, fail) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
      if (token !== null) headers['x-gitslappin-token'] = token;
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
  const open: Server['open'] = async (root) => {
    const res = await api('POST', '/api/repos/open', { path: root });
    expect(res.status).toBe(200);
    return JSON.parse(res.body).id as string;
  };
  const stream: Server['stream'] = (id) =>
    new Promise((ok, fail) => {
      const events: string[] = [];
      const req: ClientRequest = request({ host: '127.0.0.1', port, path: `/api/repos/${id}/events`, method: 'GET', headers: { host: `127.0.0.1:${port}`, 'x-gitslappin-token': TOKEN } }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          buf += c;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of block.split('\n')) if (line.startsWith('data:')) events.push(line.slice(5).trim());
          }
        });
        res.on('error', () => undefined);
        const close = () => req.destroy();
        ok({ status: res.statusCode ?? 0, events, types: () => events.map((e) => JSON.parse(e).type as string), close });
        if ((res.statusCode ?? 0) >= 400) res.resume();
      });
      req.on('error', (e) => {
        if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') fail(e);
      });
      req.end();
    });
  return { app, port, api, open, stream };
}

async function waitForType(s: Stream, type: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (s.types().includes(type)) return true;
    await sleep(100);
  }
  return false;
}

describe('events mode', () => {
  let srv: Server;
  const open: Stream[] = [];
  beforeAll(async () => {
    srv = await startServer('events');
  });
  afterAll(async () => {
    for (const s of open) s.close();
    await srv.app.close();
  });
  const sub = async (id: string): Promise<Stream> => {
    const s = await srv.stream(id);
    open.push(s);
    expect(s.status).toBe(200);
    await sleep(SETTLE_MS);
    return s;
  };

  it('a bad id is 404, a missing or wrong token is rejected', async () => {
    const bad = await srv.api('GET', '/api/repos/deadbeef0000/events');
    expect(bad.status).toBe(404);
    const root = makeRepo('auth');
    const id = await srv.open(root); // the route exists for a real id (below), so the 404 above is about the id
    const noTok = await srv.api('GET', `/api/repos/${id}/events`, undefined, null);
    expect(noTok.status).toBe(403);
    const wrong = await srv.api('GET', `/api/repos/${id}/events`, undefined, 'nope');
    expect(wrong.status).toBe(403);
    const good = await sub(id);
    expect(good.status).toBe(200);
  });

  it('a file edit gives a status event with no paths in it', async () => {
    const root = makeRepo('edit');
    const s = await sub(await srv.open(root));
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    expect(await waitForType(s, 'status', 8000)).toBe(true);
    for (const e of s.events) expect(Object.keys(JSON.parse(e))).toEqual(['type']);
    expect(s.events.join('')).not.toContain('a.txt');
  });

  it('a CLI commit gives refs and head events', async () => {
    const root = makeRepo('clicommit');
    const s = await sub(await srv.open(root));
    writeFileSync(join(root, 'b.txt'), 'two\n');
    git(root, ['add', 'b.txt']);
    git(root, ['commit', '-q', '-m', 'from the cli']);
    expect(await waitForType(s, 'refs', 8000)).toBe(true);
    expect(await waitForType(s, 'head', 8000)).toBe(true);
  });

  it('a GitSlappin commit through the API gives no event, and the watcher is still alive afterwards', async () => {
    const root = makeRepo('selfcommit');
    const id = await srv.open(root);
    const s = await sub(id);
    writeFileSync(join(root, 'self.txt'), 'x\n');
    // The write above is an outside change that the stage+commit below absorbs; the events it causes are at most the debounce's.
    await sleep(200);
    const staged = await srv.api('POST', `/api/repos/${id}/stage`, { paths: ['self.txt'] });
    expect(staged.status).toBe(200);
    const done = await srv.api('POST', `/api/repos/${id}/commit`, { message: 'self commit', amend: false });
    expect(done.status).toBe(200); // the action really ran
    expect(git(root, ['log', '-1', '--format=%s']).trim()).toBe('self commit');
    const before = s.events.length;
    await sleep(3000);
    const after = s.types().slice(before);
    expect(after.filter((t) => t === 'refs' || t === 'head')).toEqual([]);
    // Alive: an outside edit still produces an event.
    writeFileSync(join(root, 'a.txt'), 'outside later\n');
    expect(await waitForType({ ...s, types: () => s.types().slice(before) }, 'status', 8000)).toBe(true);
  });

  it('an idle repo produces zero events over 3 s, and a later edit still does', async () => {
    const root = makeRepo('idle');
    const s = await sub(await srv.open(root));
    await sleep(3000);
    expect(s.events).toEqual([]);
    writeFileSync(join(root, 'a.txt'), 'wake\n');
    expect(await waitForType(s, 'status', 8000)).toBe(true); // the stream was alive, so the zero above means something
  });

  it('a linked worktree: a commit in it reaches the stream (git dir outside its root is watched too)', async () => {
    const main = makeRepo('wtmain');
    const wt = join(fresh('gitslappin-watch-wt'), 'wt');
    git(main, ['worktree', 'add', '-q', '-b', 'wt-branch', wt]);
    const s = await sub(await srv.open(wt));
    writeFileSync(join(wt, 'w.txt'), 'w\n');
    git(wt, ['add', 'w.txt']);
    git(wt, ['commit', '-q', '-m', 'in worktree']);
    expect(await waitForType(s, 'head', 8000)).toBe(true);
  });

  it('a symlink in the worktree that points out of the repo is not followed by the second watcher', async () => {
    const main = makeRepo('symmain');
    const wt = join(fresh('gitslappin-watch-sym'), 'wt');
    git(main, ['worktree', 'add', '-q', '-b', 'sym-branch', wt]);
    const outside = fresh('gitslappin-watch-outside');
    try {
      symlinkSync(outside, join(wt, 'escape'), 'junction');
    } catch {
      return; // symlink creation not permitted on this machine: nothing to prove
    }
    git(wt, ['config', 'status.showUntrackedFiles', 'no']); // so the link itself is invisible to status
    const s = await sub(await srv.open(wt));
    writeFileSync(join(outside, 'secret.txt'), 'outside the repo\n');
    await sleep(3000);
    expect(s.events).toEqual([]); // nothing outside the repo is observed
    writeFileSync(join(wt, 'a.txt'), 'inside\n'); // the watcher ran: an inside edit is reported
    expect(await waitForType(s, 'status', 8000)).toBe(true);
  });

  it('caps: 8 streams per repo, 32 in total, then 429', async () => {
    // Streams from earlier tests still count toward the 32 total; close them first.
    for (const s of open.splice(0)) s.close();
    await new Promise((r) => setTimeout(r, 200));
    const repos = ['capA', 'capB', 'capC', 'capD', 'capE'].map((n) => makeRepo(n));
    const ids: string[] = [];
    for (const r of repos) ids.push(await srv.open(r));
    const held: Stream[] = [];
    for (let i = 0; i < 8; i++) {
      const s = await srv.stream(ids[0]!);
      held.push(s);
      expect(s.status, `stream ${i + 1}`).toBe(200);
    }
    const ninth = await srv.stream(ids[0]!);
    expect(ninth.status).toBe(429);
    ninth.close();
    for (const id of ids.slice(1, 4)) {
      for (let i = 0; i < 8; i++) {
        const s = await srv.stream(id);
        held.push(s);
        expect(s.status).toBe(200);
      }
    }
    const over = await srv.stream(ids[4]!);
    expect(over.status).toBe(429); // 32 are open
    over.close();
    // Closing one frees a slot (the server removed the subscriber on close).
    held.pop()!.close();
    await sleep(500);
    const again = await srv.stream(ids[3]!);
    expect(again.status).toBe(200);
    held.push(again);
    for (const s of held) s.close();
  });
});

describe('poll mode', () => {
  let srv: Server;
  const open: Stream[] = [];
  beforeAll(async () => {
    srv = await startServer('poll');
  });
  afterAll(async () => {
    for (const s of open) s.close();
    await srv.app.close();
  });

  it('picks up a file edit without any fs events', async () => {
    const root = makeRepo('poll');
    const s = await srv.stream(await srv.open(root));
    open.push(s);
    expect(s.status).toBe(200);
    await sleep(SETTLE_MS);
    writeFileSync(join(root, 'a.txt'), 'polled\n');
    expect(await waitForType(s, 'status', 15_000)).toBe(true);
  });
});
