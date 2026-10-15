import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Phase 12 (not built yet). Expected exports of ./instance:
//   INSTANCE_FILE = 'instance.json'
//   readLock(dataDir): {port,token,pid} | null        (validated; never throws)
//   writeLock(dataDir, lock): void                    (atomic: temp file + rename; never deletes)
//   pingInstance(lock, opts?: {timeoutMs?: number}): Promise<{app:string,pid:number} | null>   (GET http://127.0.0.1:<port>/api/ping, header X-GitSlappin-Token)
//   findLiveInstance(dataDir, ping = pingInstance): Promise<Lock | null>   (lock only followed when ping echoes {app:'gitslappin', pid === lock.pid})
import { INSTANCE_FILE, findLiveInstance, pingInstance, readLock, writeLock } from './instance';

/** A fresh, empty temp dir, asserted new and empty. Never %APPDATA%. */
function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitslappin-test-instance-'));
  if (!dir.startsWith(tmpdir()) || readdirSync(dir).length !== 0) throw new Error(`not fresh: ${dir}`);
  return dir;
}
const lockPath = (dir: string) => join(dir, INSTANCE_FILE);
const put = (dir: string, v: unknown) => writeFileSync(lockPath(dir), typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
const GOOD = { port: 4417, token: 'tok-abc', pid: 1234 };

describe('readLock', () => {
  it('file name is instance.json', () => {
    expect(INSTANCE_FILE).toBe('instance.json');
  });

  it('missing file gives null', () => {
    expect(readLock(freshDataDir())).toBeNull();
  });

  it('reads a valid lock', () => {
    const dir = freshDataDir();
    put(dir, GOOD);
    expect(readLock(dir)).toMatchObject(GOOD);
  });

  it('accepts the port bounds 1024 and 65535', () => {
    for (const port of [1024, 65535]) {
      const dir = freshDataDir();
      put(dir, { ...GOOD, port });
      expect(readLock(dir)?.port, String(port)).toBe(port);
    }
  });

  it('rejects ports outside 1024..65535, non-integers and non-numbers', () => {
    for (const port of [0, 80, 1023, 65536, 70000, -1, 4417.5, '4417', null, NaN, [4417]]) {
      const dir = freshDataDir();
      put(dir, { ...GOOD, port });
      expect(readLock(dir), JSON.stringify(port)).toBeNull();
    }
  });

  it('rejects a pid that is not an integer', () => {
    for (const pid of [1.5, '1234', null, -3, [1], {}]) {
      const dir = freshDataDir();
      put(dir, { ...GOOD, pid });
      expect(readLock(dir), JSON.stringify(pid)).toBeNull();
    }
  });

  it('rejects a missing or non-string token and a host other than 127.0.0.1', () => {
    for (const bad of [{ port: 4417, pid: 1 }, { ...GOOD, token: 5 }, { ...GOOD, host: 'evil.example' }, { ...GOOD, host: '0.0.0.0' }]) {
      const dir = freshDataDir();
      put(dir, bad);
      expect(readLock(dir), JSON.stringify(bad)).toBeNull();
    }
    const dir = freshDataDir();
    put(dir, { ...GOOD, host: '127.0.0.1' });
    expect(readLock(dir)).not.toBeNull();
  });

  it('corrupt or non-object content gives null and does not throw', () => {
    for (const text of ['', '{not json', 'null', '[]', '"x"', '42']) {
      const dir = freshDataDir();
      put(dir, text);
      expect(readLock(dir), text).toBeNull();
    }
  });
});

describe('writeLock', () => {
  it('writes the lock, replaces an older one, and leaves no temp files behind', () => {
    const dir = freshDataDir();
    writeLock(dir, GOOD);
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8'))).toMatchObject(GOOD);
    writeLock(dir, { ...GOOD, port: 5000, pid: 99 });
    expect(readLock(dir)).toMatchObject({ port: 5000, pid: 99 });
    expect(readdirSync(dir)).toEqual([INSTANCE_FILE]);
  });
});

describe('findLiveInstance (stale lock handling)', () => {
  it('no lock gives null and never calls ping', async () => {
    const ping = vi.fn();
    expect(await findLiveInstance(freshDataDir(), ping)).toBeNull();
    expect(ping).not.toHaveBeenCalled();
  });

  it('follows the lock only when ping echoes the lock pid', async () => {
    const dir = freshDataDir();
    put(dir, GOOD);
    const ping = vi.fn().mockResolvedValue({ app: 'gitslappin', pid: GOOD.pid });
    expect(await findLiveInstance(dir, ping)).toMatchObject(GOOD);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a different pid', { app: 'gitslappin', pid: 999 }],
    ['a different app', { app: 'other', pid: 1234 }],
    ['no answer (null)', null],
  ])('stale when ping returns %s; the lock file is kept', async (_n, answer) => {
    const dir = freshDataDir();
    put(dir, GOOD);
    expect(await findLiveInstance(dir, vi.fn().mockResolvedValue(answer))).toBeNull();
    expect(existsSync(lockPath(dir))).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8'))).toMatchObject(GOOD);
  });

  it('stale when ping rejects; lock file kept', async () => {
    const dir = freshDataDir();
    put(dir, GOOD);
    expect(await findLiveInstance(dir, vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))).toBeNull();
    expect(existsSync(lockPath(dir))).toBe(true);
  });

  it('an invalid lock never reaches ping', async () => {
    const dir = freshDataDir();
    put(dir, { ...GOOD, port: 22 });
    const ping = vi.fn();
    expect(await findLiveInstance(dir, ping)).toBeNull();
    expect(ping).not.toHaveBeenCalled();
  });
});

describe('pingInstance (real loopback server)', () => {
  let srv: Server | undefined;
  afterEach(
    () =>
      new Promise<void>((r) => {
        if (!srv) return r();
        srv.close(() => r());
        srv.closeAllConnections();
        srv = undefined;
      }),
  );
  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<number>((resolve) => {
      srv = createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve((srv!.address() as AddressInfo).port));
    });

  it('sends the token header to /api/ping and returns {app,pid}', async () => {
    let seen: { url?: string; token?: string | string[] } = {};
    const port = await listen((req, res) => {
      seen = { url: req.url, token: req.headers['x-gitslappin-token'] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ app: 'gitslappin', pid: 4321 }));
    });
    const out = await pingInstance({ port, token: 'tok-xyz', pid: 4321 });
    expect(out).toEqual({ app: 'gitslappin', pid: 4321 });
    expect(seen.url).toBe('/api/ping');
    expect(seen.token).toBe('tok-xyz');
  });

  it('non-200 or garbage gives null', async () => {
    const port = await listen((_req, res) => {
      res.statusCode = 403;
      res.end('{"error":"no"}');
    });
    expect(await pingInstance({ port, token: 't', pid: 1 })).toBeNull();
  });

  it('gives up after about 1 second when the server never answers', async () => {
    const port = await listen(() => undefined); // never responds
    const t0 = Date.now();
    expect(await pingInstance({ port, token: 't', pid: 1 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 10_000);
});
