import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';

// GITSLAPPIN_PATH_MAP at the /open route. The "container" folder is a real mkdtemp folder; the "host" prefix is made up (Z:/gitslappin-host).
// Real git, nothing is deleted.

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}
const GLOBAL_CFG = join(fresh('gitcfg-pathmap'), 'global.gitconfig');
writeFileSync(GLOBAL_CFG, '');
const ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL_CFG, GIT_TERMINAL_PROMPT: '0' };
delete ENV.GITSLAPPIN_TOKEN;

const PORT = 4998;
const TOKEN = 't'.repeat(40);
const headers = { host: `127.0.0.1:${PORT}`, 'x-gitslappin-token': TOKEN };
const fwd = (p: string) => p.replace(/\\/g, '/');

const setup = (withMap = true) => {
  const base = fresh('gitslappin-pathmap');
  const mount = join(base, 'mount');
  mkdirSync(mount);
  const repo = join(mount, 'demo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, env: ENV, windowsHide: true });
  const env: NodeJS.ProcessEnv = { GITSLAPPIN_NO_OPEN: '1', GITSLAPPIN_TOKEN: TOKEN, GITSLAPPIN_PORT: String(PORT), GITSLAPPIN_DATA_DIR: fresh('gitslappin-unit-pathmap'), GITSLAPPIN_REPO_ROOTS: mount };
  if (withMap) env.GITSLAPPIN_PATH_MAP = `Z:/gitslappin-host=${fwd(mount)}`;
  return { repo, config: loadConfig(env) };
};
const open = (app: Awaited<ReturnType<typeof buildApp>>, path: string) => app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path } });

describe('GITSLAPPIN_PATH_MAP on POST /api/repos/open', () => {
  it('opens a Windows-style path (backslashes, other case, quotes) under the map', async () => {
    const { repo, config } = setup();
    const app = await buildApp(config);
    for (const typed of ['Z:\\gitslappin-host\\demo', 'z:/GITSLAPPIN-HOST/demo/', '"Z:\\gitslappin-host\\demo"']) {
      const res = await open(app, typed);
      expect(res.statusCode, typed).toBe(200);
      expect(resolve(JSON.parse(res.body).root)).toBe(resolve(repo));
    }
  });

  it('an unmapped drive is refused with the mounted-folders message', async () => {
    const { config } = setup();
    const res = await open(await buildApp(config), 'D:\\elsewhere\\demo');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/^In Docker, GitSlappin can only open folders under the mounted folders \(.* = Z:\/gitslappin-host\)\.$/);
  });

  it('.. that escapes the mount after mapping is refused by the roots check', async () => {
    const { config } = setup();
    const res = await open(await buildApp(config), 'Z:\\gitslappin-host\\..\\..');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('That folder is outside the folders GitSlappin may open.');
  });

  it('a UNC path is still refused', async () => {
    const { config } = setup();
    const res = await open(await buildApp(config), '\\\\server\\share\\demo');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/UNC/);
  });

  it('without the map a Windows-style path is not rewritten (native mode unchanged)', async () => {
    const { config } = setup(false);
    const res = await open(await buildApp(config), 'Z:\\gitslappin-host\\demo');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).not.toMatch(/In Docker/);
  });
});
