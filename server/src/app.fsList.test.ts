import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';

// GET /api/fs/list (route in server/src/routes/fs.ts). Roots mode over a mkdtemp folder, so C:\repos is never listed. Nothing is deleted.
// Error bodies follow the existing routes: { error: string }.

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const PORT = 4997;
const TOKEN = 't'.repeat(40);
const headers = { host: `127.0.0.1:${PORT}`, 'x-gitslappin-token': TOKEN };

const setup = () => {
  const mount = fresh('gitslappin-fsroute');
  mkdirSync(join(mount, 'Zed'));
  mkdirSync(join(mount, 'alpha', '.git'), { recursive: true });
  writeFileSync(join(mount, 'file.txt'), 'x');
  const config = loadConfig({
    GITSLAPPIN_NO_OPEN: '1',
    GITSLAPPIN_TOKEN: TOKEN,
    GITSLAPPIN_PORT: String(PORT),
    GITSLAPPIN_DATA_DIR: fresh('gitslappin-unit-fsroute'),
    GITSLAPPIN_REPO_ROOTS: mount,
    GITSLAPPIN_PATH_MAP: `Z:/gitslappin-host=${mount.replace(/\\/g, '/')}`,
  });
  return { mount, config };
};
const get = (app: Awaited<ReturnType<typeof buildApp>>, url: string, h: Record<string, string> = headers) => app.inject({ method: 'GET', url, headers: h });

describe('GET /api/fs/list', () => {
  it('needs the token', async () => {
    const { mount, config } = setup();
    const app = await buildApp(config);
    const url = `/api/fs/list?path=${encodeURIComponent(mount)}`;
    expect((await get(app, url, { host: headers.host })).statusCode).toBe(403);
    expect((await get(app, url, { host: headers.host, 'x-gitslappin-token': 'wrong' })).statusCode).toBe(403);
    expect((await get(app, url)).statusCode).toBe(200); // the 403s above mean something: the same call with the token works
  });

  it('returns {path, display, parent, entries, roots, truncated}', async () => {
    const { mount, config } = setup();
    const res = await get(await buildApp(config), `/api/fs/list?path=${encodeURIComponent(mount)}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort()).toEqual(['display', 'entries', 'parent', 'path', 'roots', 'truncated']);
    expect(body.entries.map((e: { name: string; isRepo: boolean }) => ({ name: e.name, isRepo: e.isRepo }))).toEqual([
      { name: 'alpha', isRepo: true },
      { name: 'Zed', isRepo: false },
    ]);
    expect(body.entries.map((e: { path: string }) => e.path.toLowerCase())).toEqual([join(mount, 'alpha').toLowerCase(), join(mount, 'Zed').toLowerCase()]);
    expect(body.parent).toBeNull();
    expect(body.truncated).toBe(false);
    expect(body.display).toBe('Z:/gitslappin-host');
    expect(body.roots).toHaveLength(1);
    expect(body.roots[0].display).toBe('Z:/gitslappin-host');
  });

  it('without path it starts at the first root; a Windows-style host path is mapped', async () => {
    const { mount, config } = setup();
    const app = await buildApp(config);
    expect(JSON.parse((await get(app, '/api/fs/list')).body).path.toLowerCase()).toBe(mount.toLowerCase());
    const mapped = await get(app, `/api/fs/list?path=${encodeURIComponent('Z:\\gitslappin-host\\alpha')}`);
    expect(mapped.statusCode).toBe(200);
    expect(JSON.parse(mapped.body).display).toBe('Z:/gitslappin-host/alpha');
  });

  it('refuses outside the roots, escapes, UNC, NUL and relative paths with 400 and an error message', async () => {
    const { mount, config } = setup();
    const app = await buildApp(config);
    for (const p of [fresh('gitslappin-fsroute-out'), `${mount}\\..`, 'Z:\\gitslappin-host\\..\\..', 'C:\\Windows', '\\\\server\\share', `${mount}\0x`, 'relative']) {
      const res = await get(app, `/api/fs/list?path=${encodeURIComponent(p)}`);
      expect(res.statusCode, p).toBe(400);
      expect(typeof JSON.parse(res.body).error, p).toBe('string');
    }
  });
});
