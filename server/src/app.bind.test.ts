import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { repoIdFor } from './state/registry';

// Docker mode: Host check under bind 0.0.0.0 (security audit 1), and GITSLAPPIN_REPO_ROOTS (audit 9).
// Real git in mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted.

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}
const GLOBAL_CFG = join(fresh('gitcfg-bind'), 'global.gitconfig');
writeFileSync(GLOBAL_CFG, '');
const ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL_CFG, GIT_TERMINAL_PROMPT: '0' };
delete ENV.GITSLAPPIN_TOKEN;
function makeRepo(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, env: ENV, windowsHide: true });
  return dir;
}

const PORT = 4999;
const TOKEN = 't'.repeat(40);

describe('Host check under bind 0.0.0.0', () => {
  const make = () =>
    buildApp(
      loadConfig({ GITSLAPPIN_BIND: '0.0.0.0', GITSLAPPIN_NO_OPEN: '1', GITSLAPPIN_TOKEN: TOKEN, GITSLAPPIN_PORT: String(PORT), GITSLAPPIN_DATA_DIR: fresh('gitslappin-unit-bind') }),
    );

  it('403 for evil.com, host.docker.internal and 172.17.0.2; 200 for localhost:<port>', async () => {
    const app = await make();
    const get = (host: string) => app.inject({ method: 'GET', url: '/api/ping', headers: { host, 'x-gitslappin-token': TOKEN } });
    for (const host of ['evil.com', 'evil.com:4999', 'host.docker.internal', `host.docker.internal:${PORT}`, '172.17.0.2', `172.17.0.2:${PORT}`]) {
      expect((await get(host)).statusCode, host).toBe(403);
    }
    expect((await get(`localhost:${PORT}`)).statusCode).toBe(200);
    expect((await get(`127.0.0.1:${PORT}`)).statusCode).toBe(200);
  });

  it('still needs the token (403 without it)', async () => {
    const app = await make();
    const res = await app.inject({ method: 'GET', url: '/api/ping', headers: { host: `localhost:${PORT}` } });
    expect(res.statusCode).toBe(403);
  });
});

describe('GITSLAPPIN_REPO_ROOTS', () => {
  const setup = () => {
    const base = fresh('gitslappin-roots');
    const allowed = join(base, 'allowed');
    const outside = join(base, 'outside');
    mkdirSync(allowed);
    mkdirSync(outside);
    const inRepo = makeRepo(allowed, 'in-repo');
    const outRepo = makeRepo(outside, 'out-repo');
    const dataDir = fresh('gitslappin-unit-roots');
    const config = loadConfig({ GITSLAPPIN_NO_OPEN: '1', GITSLAPPIN_TOKEN: TOKEN, GITSLAPPIN_PORT: String(PORT), GITSLAPPIN_DATA_DIR: dataDir, GITSLAPPIN_REPO_ROOTS: allowed });
    return { allowed, inRepo, outRepo, dataDir, config };
  };
  const headers = { host: `127.0.0.1:${PORT}`, 'x-gitslappin-token': TOKEN };

  it('opens a repo under the roots and refuses one outside them', async () => {
    const { inRepo, outRepo, config } = setup();
    const app = await buildApp(config);
    const ok = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: inRepo } });
    expect(ok.statusCode).toBe(200); // the open path ran
    const bad = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: outRepo } });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBeTruthy();
    // Not remembered either.
    const recent = await app.inject({ method: 'GET', url: '/api/recent', headers });
    expect(JSON.parse(recent.body).map((r: { root: string }) => resolve(r.root))).toEqual([resolve(inRepo)]);
  });

  it('refuses a path that reaches outside the roots with ..', async () => {
    const { allowed, outRepo, config } = setup();
    const app = await buildApp(config);
    const tricky = join(allowed, '..', 'outside', 'out-repo');
    const res = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: tricky } });
    expect(res.statusCode).toBe(400);
    expect(outRepo).toBeTruthy();
  });

  it('restoring tabs drops a tab outside the roots and keeps the one inside', async () => {
    const { inRepo, outRepo, dataDir, config } = setup();
    const tab = (root: string) => ({ id: repoIdFor(resolve(root)), root: resolve(root), name: root.split(/[\\/]/).pop() });
    writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify({ tabs: [tab(outRepo), tab(inRepo)], activeId: tab(outRepo).id }));
    const app = await buildApp(config);
    const res = await app.inject({ method: 'GET', url: '/api/tabs', headers });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { tabs: { root: string }[]; activeId: string | null };
    expect(body.tabs.map((t) => resolve(t.root))).toEqual([resolve(inRepo)]); // inside kept: the restore path ran
    expect(body.activeId).toBe(tab(inRepo).id);
  });

  it('PUT /api/tabs with an outside tab does not keep it', async () => {
    const { inRepo, outRepo, config } = setup();
    const app = await buildApp(config);
    const tab = (root: string) => ({ id: repoIdFor(resolve(root)), root: resolve(root), name: 'x' });
    const put = await app.inject({ method: 'PUT', url: '/api/tabs', headers, payload: { tabs: [tab(inRepo), tab(outRepo)], activeId: null } });
    expect(put.statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/api/tabs', headers });
    expect((JSON.parse(res.body) as { tabs: { root: string }[] }).tabs.map((t) => resolve(t.root))).toEqual([resolve(inRepo)]);
  });

  it('without GITSLAPPIN_REPO_ROOTS any repo opens (native mode unchanged)', async () => {
    const { outRepo, dataDir } = setup();
    const app = await buildApp(loadConfig({ GITSLAPPIN_NO_OPEN: '1', GITSLAPPIN_TOKEN: TOKEN, GITSLAPPIN_PORT: String(PORT), GITSLAPPIN_DATA_DIR: dataDir }));
    const res = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: outRepo } });
    expect(res.statusCode).toBe(200);
  });
});
