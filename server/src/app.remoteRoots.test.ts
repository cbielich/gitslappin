import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';

vi.setConfig({ testTimeout: 60_000 });

/*
 * Audit fix 2 (V2 add-remote, roots / Docker mode): with GITSLAPPIN_REPO_ROOTS set, a file:// url or an absolute local path given to
 * POST /api/repos/:id/remote/add goes through mapOpenPath, then the UNC refusal, then realpath, and must pass isUnderRoots; otherwise 4xx and nothing is added.
 * With no roots set nothing changes (the same outside url is accepted).
 * Route and body as in remoteTags.int.test.ts: POST remote/add {name, url, pushUrl?}.
 * Real git, everything under os.tmpdir()/gitslappin-tests, nothing deleted. The "outside" folder is a real bare repo that is NOT under the mount.
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}
const GLOBAL_CFG = join(fresh('gitcfg-remoteroots'), 'global.gitconfig');
writeFileSync(GLOBAL_CFG, '');
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: GLOBAL_CFG,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
};
delete ENV.GITSLAPPIN_TOKEN;
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL_CFG }); // the app's own git calls inherit these
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const remotes = (repo: string): string[] => git(repo, ['remote']).split('\n').filter(Boolean).sort();
const fwd = (p: string): string => p.replace(/\\/g, '/');

const PORT = 4995;
const TOKEN = 'q'.repeat(40);
const headers = { host: `127.0.0.1:${PORT}`, 'x-gitslappin-token': TOKEN };

function bareWithCommit(prefix: string, parent = fresh(prefix)): string {
  const bare = join(parent, 'remote.git');
  mkdirSync(bare);
  git(bare, ['init', '--bare', '-b', 'main']);
  const work = join(fresh(`${prefix}-work`), 'w');
  mkdirSync(work);
  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'user.name', 'Test Author']);
  git(work, ['config', 'user.email', 'author@example.com']);
  writeFileSync(join(work, 'f.txt'), 'x\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'Remote commit']);
  git(work, ['-c', 'protocol.file.allow=always', 'push', pathToFileURL(bare).href, 'main']);
  return bare;
}

function setup(withRoots = true) {
  const base = fresh('remoteroots');
  const mount = join(base, 'mount');
  mkdirSync(mount);
  const repo = join(mount, 'demo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'author@example.com']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'Demo commit']);
  const insideBare = join(mount, 'inside.git'); // a bare repo under the mount (empty: fetching it is fine)
  mkdirSync(insideBare);
  git(insideBare, ['init', '--bare', '-b', 'main']);
  const outside = bareWithCommit('remoteroots-outside');
  const env: NodeJS.ProcessEnv = {
    GITSLAPPIN_NO_OPEN: '1',
    GITSLAPPIN_TOKEN: TOKEN,
    GITSLAPPIN_PORT: String(PORT),
    GITSLAPPIN_DATA_DIR: fresh('gitslappin-unit-remoteroots'),
    GITSLAPPIN_WATCH: 'poll',
    ...(withRoots ? { GITSLAPPIN_REPO_ROOTS: mount } : {}),
  };
  return { mount, repo, insideBare, outside, config: loadConfig(env) };
}

async function openAndAdd(app: Awaited<ReturnType<typeof buildApp>>, repo: string, body: Record<string, unknown>): Promise<number> {
  const open = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: repo } });
  expect(open.statusCode).toBe(200);
  const id = JSON.parse(open.body).id as string;
  const res = await app.inject({ method: 'POST', url: `/api/repos/${id}/remote/add`, headers, payload: body });
  return res.statusCode;
}

describe('add-remote in roots mode', () => {
  it('refuses a file:// url and an absolute local path that point outside the roots; nothing is added', async () => {
    const { repo, outside, config } = setup();
    const app = await buildApp(config);
    const outsideUrl = pathToFileURL(outside).href;
    for (const url of [outsideUrl, outside, fwd(outside)]) {
      const status = await openAndAdd(app, repo, { name: 'sneaky', url });
      expect(status, url).toBeGreaterThanOrEqual(400);
      expect(status, url).toBeLessThan(500);
    }
    expect(remotes(repo)).toEqual([]);
    await app.close();
  });

  it('refuses an outside push url too, and a ".." escape out of the mount', async () => {
    const { mount, repo, insideBare, outside, config } = setup();
    const app = await buildApp(config);
    expect(await openAndAdd(app, repo, { name: 'pushy', url: pathToFileURL(insideBare).href, pushUrl: pathToFileURL(outside).href })).toBeGreaterThanOrEqual(400);
    expect(await openAndAdd(app, repo, { name: 'dots', url: `${fwd(mount)}/../remoteroots-escape/x.git` })).toBeGreaterThanOrEqual(400);
    expect(remotes(repo)).toEqual([]);
    await app.close();
  });

  it('refuses a junction/symlink inside the mount that leads outside (realpath is checked)', async () => {
    const { mount, repo, outside, config } = setup();
    const link = join(mount, 'link-to-outside');
    symlinkSync(outside, link, 'junction');
    const app = await buildApp(config);
    expect(await openAndAdd(app, repo, { name: 'linked', url: pathToFileURL(link).href })).toBeGreaterThanOrEqual(400);
    expect(await openAndAdd(app, repo, { name: 'linked2', url: link })).toBeGreaterThanOrEqual(400);
    expect(remotes(repo)).toEqual([]);
    await app.close();
  });

  it('control: a file:// url and a plain path INSIDE the mount are accepted (the check is alive, not a blanket refusal)', async () => {
    const { repo, insideBare, config } = setup();
    const app = await buildApp(config);
    expect(await openAndAdd(app, repo, { name: 'inside-url', url: pathToFileURL(insideBare).href })).toBe(200);
    expect(await openAndAdd(app, repo, { name: 'inside-path', url: insideBare })).toBe(200);
    expect(remotes(repo)).toEqual(['inside-path', 'inside-url']);
    await app.close();
  });

  it('still refuses UNC and device paths in roots mode', async () => {
    const { repo, config } = setup();
    const app = await buildApp(config);
    for (const url of ['\\\\server\\share\\repo.git', '//server/share/repo.git', 'file://host/share/repo.git']) {
      expect(await openAndAdd(app, repo, { name: 'unc', url }), url).toBeGreaterThanOrEqual(400);
    }
    expect(remotes(repo)).toEqual([]);
    await app.close();
  });

  it('with no roots set nothing changes: the same outside url is accepted', async () => {
    const { repo, outside, config } = setup(false);
    expect(config.repoRoots).toEqual([]);
    const app = await buildApp(config);
    expect(await openAndAdd(app, repo, { name: 'free', url: pathToFileURL(outside).href })).toBe(200);
    expect(remotes(repo)).toEqual(['free']);
    expect(resolve(outside).length).toBeGreaterThan(0);
    await app.close();
  });
});
