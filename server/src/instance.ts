import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { TOKEN_HEADER } from '@gitslappin/shared';

/*
 * Single instance (phase 12). `<dataDir>/instance.json` holds {host, port, token, pid} of the running server.
 * It is written atomically after listen and never deleted: a lock is only followed when /api/ping on that port
 * answers with the same pid, so a stale file (crashed server, reused port) is simply ignored and replaced.
 */

export const INSTANCE_FILE = 'instance.json';
const HOST = '127.0.0.1';

export interface Lock {
  port: number;
  token: string;
  pid: number;
}

/** The validated lock, or null for a missing, corrupt or suspicious file (host other than 127.0.0.1, port outside 1024..65535, bad pid or token). Never throws. */
export function readLock(dataDir: string): Lock | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, INSTANCE_FILE), 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const v = raw as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(v, 'host') && v.host !== HOST) return null;
    const { port, token, pid } = v;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null;
    if (typeof token !== 'string' || token === '') return null;
    return { port, token, pid };
  } catch {
    return null;
  }
}

/** Windows can refuse a rename for a moment while a scanner holds the target; try again a few times. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

/** Temp file in the same folder, then rename. The file keeps the data folder's default permissions. Nothing is deleted. */
export function writeLock(dataDir: string, lock: Lock): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = join(dataDir, `${INSTANCE_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ host: HOST, port: lock.port, token: lock.token, pid: lock.pid }, null, 2), 'utf8');
  renameWithRetry(tmp, join(dataDir, INSTANCE_FILE));
}

export interface PingAnswer {
  app: string;
  pid: number;
}

/** GET http://127.0.0.1:<port>/api/ping with the token header. null for anything but a 200 with {app, pid}, or no answer in time. */
export function pingInstance(lock: { port: number; token: string; pid?: number }, opts: { timeoutMs?: number } = {}): Promise<PingAnswer | null> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: PingAnswer | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const req = request({ host: HOST, port: lock.port, path: '/api/ping', method: 'GET', headers: { [TOKEN_HEADER]: lock.token }, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish(null);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 4096) {
          req.destroy();
          return finish(null);
        }
        chunks.push(c);
      });
      res.on('end', () => {
        try {
          const j: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const o = j as { app?: unknown; pid?: unknown };
          finish(typeof o.app === 'string' && typeof o.pid === 'number' && Number.isInteger(o.pid) ? { app: o.app, pid: o.pid } : null);
        } catch {
          finish(null);
        }
      });
      res.on('error', () => finish(null));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, timeoutMs);
    req.on('error', () => finish(null));
    req.end();
  });
}

/** The lock of a running GitSlappin, or null (no lock, invalid lock, no answer, another pid or another app). The lock file is never touched. */
export async function findLiveInstance(dataDir: string, ping: (lock: Lock) => Promise<PingAnswer | null> = pingInstance): Promise<Lock | null> {
  const lock = readLock(dataDir);
  if (!lock) return null;
  try {
    const answer = await ping(lock);
    return answer && answer.app === 'gitslappin' && answer.pid === lock.pid ? lock : null;
  } catch {
    return null;
  }
}
