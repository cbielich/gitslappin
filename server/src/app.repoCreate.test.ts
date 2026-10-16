import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { GENERIC_PHASE, cloneRepo } from './git/clone';

/*
 * POST /api/repos/clone, POST /api/repos/init, GET /api/repos/templates (new server/src/routes/repoCreate.ts, V1 design "API").
 * Contract added to buildApp's second argument so the tests can inject (audit fix 7 and a deterministic 409):
 *   buildApp(config, { cloneVersionProblem?: () => Promise<string | null>;  cloneImpl?: typeof cloneRepo })
 *     cloneVersionProblem defaults to a real `git --version` check (cloneGitProblem); a string refuses the clone route with 400 { error } that
 *       contains that text, before anything is spawned or streamed. Init and every other route are unaffected.
 *     cloneImpl defaults to cloneRepo from server/src/git/clone.ts; the route calls it as cloneImpl(req, { roots, pathMap, signal, onProgress })
 *       where `signal` aborts when the client closes the response.
 * Route behaviour asserted here:
 *   - Token hook: 403 without / with a wrong token (same as every other route in this repo; the design text says "401" but the app-wide hook answers 403).
 *   - Validation failures (CloneResult 'refused', bad body, version) answer BEFORE streaming: status 400, JSON { error: string }.
 *   - A clone that starts streams NDJSON (one JSON object per line, status 200): { type:'progress', phase, percent } lines, then exactly one of
 *     { type:'done', repo: RepoInfo } | { type:'error', error, stderr } | { type:'cancelled', path }.
 *     phase is always one of PROGRESS_PHASES or GENERIC_PHASE; error and stderr text go through scrubSecrets (audit fix 6).
 *   - One clone at a time server-wide: a second concurrent one gets 409 { error }; once the first ends a new one is accepted.
 *   - POST /init answers 200 with RepoInfo { id, root, name }; a validation failure is 400 { error }.
 * Real git over file://, all inside mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted.
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const CFG = fresh('gitcfg-repocreate');
const EMPTY_GLOBAL = join(CFG, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL, '');
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
};
delete ENV.GITSLAPPIN_TOKEN;
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
});
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

const PORT = 4996;
const TOKEN = 't'.repeat(40);
const headers = { host: `127.0.0.1:${PORT}`, 'x-gitslappin-token': TOKEN };
const fwd = (p: string) => p.replace(/\\/g, '/');
type App = Awaited<ReturnType<typeof buildApp>>;

/** mount/ { origin.git (bare, 2 commits on main), parent/ }; roots mode over mount, and a PATH_MAP to a made-up Windows prefix. */
function setup(roots = true, mapPaths = false) {
  const mount = fresh('gitslappin-repocreate');
  const bare = join(mount, 'origin.git');
  mkdirSync(bare);
  git(bare, ['init', '--bare', '-b', 'main']);
  const work = join(mount, 'work');
  mkdirSync(work);
  git(work, ['init', '-b', 'main']);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'one']);
  writeFileSync(join(work, 'b.txt'), 'b\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'two']);
  const url = pathToFileURL(bare).href;
  git(work, ['remote', 'add', 'origin', url]);
  git(work, ['push', 'origin', 'main']);
  const parent = join(mount, 'parent');
  mkdirSync(parent);
  const env: NodeJS.ProcessEnv = {
    GITSLAPPIN_NO_OPEN: '1',
    GITSLAPPIN_TOKEN: TOKEN,
    GITSLAPPIN_PORT: String(PORT),
    GITSLAPPIN_DATA_DIR: fresh('gitslappin-unit-repocreate'),
    ...(mapPaths ? { GITSLAPPIN_PATH_MAP: `Z:/gitslappin-host=${fwd(mount)}` } : {}),
  };
  if (roots) env.GITSLAPPIN_REPO_ROOTS = mount;
  return { mount, bare, url, parent, config: loadConfig(env) };
}
const post = (app: App, path: string, payload: unknown, h: Record<string, string> = headers) => app.inject({ method: 'POST', url: path, headers: h, payload: payload as object });
const ndjson = (body: string): Record<string, unknown>[] =>
  body
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('token hook', () => {
  it('clone, init and templates need the token', async () => {
    const { config, parent, url } = setup();
    const app = await buildApp(config);
    const noTok = { host: headers.host };
    const wrong = { host: headers.host, 'x-gitslappin-token': 'wrong' };
    for (const h of [noTok, wrong]) {
      expect((await post(app, '/api/repos/clone', { parent, url }, h)).statusCode).toBe(403);
      expect((await post(app, '/api/repos/init', { parent, name: 'x' }, h)).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/repos/templates', headers: h })).statusCode).toBe(403);
    }
    expect(readdirSync(parent)).toEqual([]); // nothing ran
    expect((await app.inject({ method: 'GET', url: '/api/repos/templates', headers })).statusCode).toBe(200);
  });
});

describe('GET /api/repos/templates', () => {
  it('returns { gitignore: string[], license: {id,title}[] }', async () => {
    const { config } = setup();
    const res = await app_get(await buildApp(config), '/api/repos/templates');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort()).toEqual(['gitignore', 'license']);
    expect(body.gitignore).toHaveLength(127);
    expect(body.gitignore).toContain('Node');
    expect(body.license).toHaveLength(17);
    expect(body.license).toContainEqual(expect.objectContaining({ id: 'mit-license' }));
  });
});
const app_get = (app: App, url: string) => app.inject({ method: 'GET', url, headers });

describe('POST /api/repos/clone', () => {
  it('streams NDJSON ending in exactly one done line with the RepoInfo; the clone exists on disk', async () => {
    const { config, parent, url } = setup();
    const app = await buildApp(config, { cloneVersionProblem: async () => null });
    const res = await post(app, '/api/repos/clone', { parent, url });
    expect(res.statusCode).toBe(200);
    const lines = ndjson(res.body);
    const last = lines[lines.length - 1]!;
    expect(last.type).toBe('done');
    expect(lines.filter((l) => l.type !== 'progress')).toHaveLength(1);
    const repo = last.repo as { id: string; root: string; name: string };
    expect(typeof repo.id).toBe('string');
    expect(repo.name).toBe('origin');
    expect(resolve(repo.root).toLowerCase()).toBe(resolve(join(parent, 'origin')).toLowerCase());
    expect(existsSync(join(parent, 'origin', '.git'))).toBe(true);
    for (const l of lines.filter((x) => x.type === 'progress')) expect(typeof l.phase).toBe('string');
  });

  it('refused input is answered before streaming: 400 + { error } and nothing is created', async () => {
    const { config, parent, url, mount } = setup();
    const app = await buildApp(config, { cloneVersionProblem: async () => null });
    const outsideParent = fresh('gitslappin-repocreate-outside');
    const cases: [string, Record<string, unknown>][] = [
      ['ext:: url', { parent, url: 'ext::git init /tmp/x' }],
      ['bare local path', { parent, url: join(mount, 'origin.git') }],
      ['refused flag', { parent, url, shallow: { by: 'depth', depth: 1, flags: '--upload-pack=calc' } }],
      ['bad depth', { parent, url, shallow: { by: 'depth', depth: 0 } }],
      ['parent outside the roots', { parent: outsideParent, url }],
      ['missing parent', { parent: join(mount, 'nope'), url }],
      ['no url', { parent }],
      ['no parent', { url }],
    ];
    for (const [label, body] of cases) {
      const res = await post(app, '/api/repos/clone', body);
      expect(res.statusCode, label).toBe(400);
      expect(typeof JSON.parse(res.body).error, label).toBe('string');
    }
    expect(readdirSync(parent)).toEqual([]);
    expect(readdirSync(outsideParent)).toEqual([]);
    expect((await post(app, '/api/repos/clone', { parent, url })).statusCode).toBe(200); // the same app accepts a good request
  });

  it('audit fix 2: in roots mode a file:// origin outside the roots is refused with 400; with no roots it is cloned', async () => {
    const inRoots = setup();
    const other = setup(); // another mkdtemp mount: outside inRoots' roots
    const app = await buildApp(inRoots.config, { cloneVersionProblem: async () => null });
    const res = await post(app, '/api/repos/clone', { parent: inRoots.parent, url: other.url });
    expect(res.statusCode).toBe(400);
    expect(typeof JSON.parse(res.body).error).toBe('string');
    expect(readdirSync(inRoots.parent)).toEqual([]);

    const open = setup(false);
    const openApp = await buildApp(open.config, { cloneVersionProblem: async () => null });
    const ok = await post(openApp, '/api/repos/clone', { parent: open.parent, url: other.url });
    expect(ok.statusCode).toBe(200);
    const lines = ndjson(ok.body);
    expect(lines[lines.length - 1]!.type).toBe('done');
  });

  it('PATH_MAP: a Windows-style parent is mapped to the mounted folder', async () => {
    const { config, parent, url } = setup(true, true);
    const app = await buildApp(config, { cloneVersionProblem: async () => null });
    const res = await post(app, '/api/repos/clone', { parent: 'Z:\\gitslappin-host\\parent', url });
    expect(res.statusCode).toBe(200);
    const lines = ndjson(res.body);
    expect(lines[lines.length - 1]!.type).toBe('done');
    expect(existsSync(join(parent, 'origin', '.git'))).toBe(true);
    const bad = await post(app, '/api/repos/clone', { parent: 'D:\\elsewhere', url });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/mounted folders/);
  });

  it('audit fix 7: git older than 2.39.2 (injected) refuses the clone with 400 naming it, never calls the clone, and init still works', async () => {
    const { config, parent, url } = setup();
    let called = 0;
    const app = await buildApp(config, {
      cloneVersionProblem: async () => 'Clone needs git 2.39.2 or newer, but this is git 2.30.',
      cloneImpl: async (...a: Parameters<typeof cloneRepo>) => {
        called++;
        return cloneRepo(...a);
      },
    });
    const res = await post(app, '/api/repos/clone', { parent, url });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('2.39.2');
    expect(called).toBe(0);
    expect(readdirSync(parent)).toEqual([]);
    expect((await post(app, '/api/repos/init', { parent, name: 'still-works' })).statusCode).toBe(200);

    let called2 = 0;
    const okApp = await buildApp(config, {
      cloneVersionProblem: async () => null,
      cloneImpl: async (...a: Parameters<typeof cloneRepo>) => {
        called2++;
        return cloneRepo(...a);
      },
    });
    expect((await post(okApp, '/api/repos/clone', { parent, url })).statusCode).toBe(200);
    expect(called2).toBe(1);
  });

  it('audit fix 6: unknown progress phases are mapped to the generic phase and error text is scrubbed on the stream', async () => {
    const { config, parent, url } = setup();
    const SECRET = 'pw-from-the-stream-9';
    const app = await buildApp(config, {
      cloneVersionProblem: async () => null,
      cloneImpl: async (_req, opts) => {
        opts.onProgress?.({ phase: 'Evil <b>phase</b>\nhttps://alice:' + SECRET + '@h/x', percent: 10 });
        opts.onProgress?.({ phase: 'Receiving objects', percent: 50 });
        return { type: 'error', error: `fatal: unable to access 'https://alice:${SECRET}@example.invalid/x.git/'`, stderr: `fatal: https://alice:${SECRET}@example.invalid/x.git failed\nAuthorization: Bearer abc.def` };
      },
    });
    const res = await post(app, '/api/repos/clone', { parent, url });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain('abc.def');
    const lines = ndjson(res.body);
    const progress = lines.filter((l) => l.type === 'progress');
    expect(progress.map((p) => p.phase)).toEqual([GENERIC_PHASE, 'Receiving objects']);
    expect(progress.map((p) => p.percent)).toEqual([10, 50]);
    const last = lines[lines.length - 1]!;
    expect(last.type).toBe('error');
    expect(typeof last.error).toBe('string');
    expect(typeof last.stderr).toBe('string');
  });

  it('409 for a second clone while one runs, and a new clone is accepted once it ends', async () => {
    const { config, parent, url } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const app = await buildApp(config, {
      cloneVersionProblem: async () => null,
      cloneImpl: async (...a: Parameters<typeof cloneRepo>) => {
        started++;
        await gate;
        return cloneRepo(...a);
      },
    });
    const first = post(app, '/api/repos/clone', { parent, url });
    for (let i = 0; i < 100 && started === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(started, 'the first clone must be running').toBe(1);
    const second = await post(app, '/api/repos/clone', { parent, url });
    expect(second.statusCode).toBe(409);
    expect(typeof JSON.parse(second.body).error).toBe('string');
    release();
    const done = await first;
    expect(done.statusCode).toBe(200);
    const lines = ndjson(done.body);
    expect(lines[lines.length - 1]!.type).toBe('done');
    // The slot is free again (different target name so the folder from the first is not in the way).
    const parent2 = join(parent, '..', 'parent2');
    mkdirSync(parent2);
    const third = await post(app, '/api/repos/clone', { parent: parent2, url });
    expect(third.statusCode).toBe(200);
    expect(started).toBe(2);
  });

  it('closing the response (client abort) aborts the signal the clone was given', async () => {
    const { config, parent, url } = setup();
    let sawSignal: AbortSignal | undefined;
    let sawProgressSent = false;
    const app = await buildApp(config, {
      cloneVersionProblem: async () => null,
      cloneImpl: (_req, opts) =>
        new Promise((resolveClone) => {
          sawSignal = opts.signal;
          opts.onProgress?.({ phase: 'Receiving objects', percent: 1 });
          sawProgressSent = true;
          opts.signal?.addEventListener('abort', () => resolveClone({ type: 'cancelled', path: join(parent, 'origin') }));
        }),
    });
    await app.listen({ port: PORT, host: '127.0.0.1' });
    try {
      await new Promise<void>((done, fail) => {
        const body = JSON.stringify({ parent, url });
        const req = request(
          { host: '127.0.0.1', port: PORT, path: '/api/repos/clone', method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } },
          (res) => {
            res.setEncoding('utf8');
            res.once('data', () => {
              req.destroy(); // the user pressed Cancel: the fetch is aborted
              done();
            });
          },
        );
        req.on('error', () => undefined);
        req.on('close', () => undefined);
        req.end(body);
        setTimeout(() => fail(new Error('no streamed line arrived')), 10_000);
      });
      for (let i = 0; i < 100 && !sawSignal?.aborted; i++) await new Promise((r) => setTimeout(r, 50));
      expect(sawProgressSent).toBe(true);
      expect(sawSignal).toBeDefined();
      expect(sawSignal!.aborted).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/repos/init', () => {
  it('returns RepoInfo for the new repo with the Initial commit made', async () => {
    const { config, parent } = setup();
    const app = await buildApp(config);
    const res = await post(app, '/api/repos/init', { parent, name: 'fresh-one', gitignore: 'Node', license: 'mit-license' });
    expect(res.statusCode).toBe(200);
    const info = JSON.parse(res.body);
    expect(Object.keys(info)).toEqual(expect.arrayContaining(['id', 'root', 'name']));
    expect(info.name).toBe('fresh-one');
    expect(resolve(info.root).toLowerCase()).toBe(resolve(join(parent, 'fresh-one')).toLowerCase());
    expect(git(join(parent, 'fresh-one'), ['log', '--format=%s']).trim()).toBe('Initial commit');
    expect(readFileSync(join(parent, 'fresh-one', 'README.md'), 'utf8')).toBe('# fresh-one\n');
  });

  it('PATH_MAP: a Windows-style parent is mapped, an unmapped drive is refused', async () => {
    const { config, parent } = setup(true, true);
    const app = await buildApp(config);
    const ok = await post(app, '/api/repos/init', { parent: 'Z:\\gitslappin-host\\parent', name: 'mapped' });
    expect(ok.statusCode).toBe(200);
    expect(existsSync(join(parent, 'mapped', '.git'))).toBe(true);
    const bad = await post(app, '/api/repos/init', { parent: 'D:\\elsewhere', name: 'x' });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/mounted folders/);
  });

  it('roots-mode refusals: parent outside the roots, bad name, bad branch, unknown template, existing repo -> 400 { error }', async () => {
    const { config, parent } = setup();
    const app = await buildApp(config);
    const outside = fresh('gitslappin-repocreate-init-outside');
    const cases: [string, Record<string, unknown>][] = [
      ['outside roots', { parent: outside, name: 'x' }],
      ['bad name', { parent, name: 'a/b' }],
      ['reserved name', { parent, name: 'CON' }],
      ['bad branch', { parent, name: 'x', defaultBranch: 'bad..name' }],
      ['unknown gitignore', { parent, name: 'x', gitignore: 'Nope' }],
      ['unknown license', { parent, name: 'x', license: 'nope' }],
      ['missing name', { parent }],
    ];
    for (const [label, body] of cases) {
      const res = await post(app, '/api/repos/init', body);
      expect(res.statusCode, label).toBe(400);
      expect(typeof JSON.parse(res.body).error, label).toBe('string');
    }
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(parent)).toEqual([]);
    // an existing repo as the target is refused too
    mkdirSync(join(parent, 'existing'));
    git(join(parent, 'existing'), ['init', '-b', 'main']);
    writeFileSync(join(parent, 'existing', 'README.md'), 'mine\n');
    const existing = await post(app, '/api/repos/init', { parent, name: 'existing' });
    expect(existing.statusCode).toBe(400);
    expect(readFileSync(join(parent, 'existing', 'README.md'), 'utf8')).toBe('mine\n');
    expect((await post(app, '/api/repos/init', { parent, name: 'good' })).statusCode).toBe(200);
  });
});
