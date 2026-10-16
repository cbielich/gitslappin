import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Docker mode smoke test (docs/specs/build-notes.md: Docker mode design, data-safety audit 1-7, security audit 10).
// Isolation: unique compose project, fresh mkdtemp REPOS_DIR/SSH_DIR, explicit env, an empty --env-file so the repo's .env is never read,
// never the gitslappin-data volume. The only teardown is `docker compose stop`: no down, no -v, no volume rm, no deletion.
// UNVERIFIED: the compose service name is assumed to be `gitslappin`.

const SERVICE = 'gitslappin';
const REPO_ROOT = resolve(__dirname, '..', '..');
const TESTS_ROOT = join(tmpdir(), 'gitslappin-tests');
const PORT = 4519;
const ALT_PORT = 4521; // non-default GITSLAPPIN_PORT case (the default is 4417)
const TOKEN = randomBytes(24).toString('hex'); // 48 chars
const ID_NAME = 'Docker Test Identity';
const ID_EMAIL = 'docker-test@example.com';

const dockerOk = (() => {
  const r = spawnSync('docker', ['version'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && !r.error;
})();
if (!dockerOk) console.log('docker not available: skipping the Docker smoke test');

function fresh(prefix: string): string {
  mkdirSync(TESTS_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TESTS_ROOT, `${prefix}-`));
  if (!dir.startsWith(TESTS_ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}
const fwd = (p: string) => p.replace(/\\/g, '/');

const suffix = randomBytes(4).toString('hex');
const PROJECT = `gitslappin-test-${suffix}`;
const PROJECT_ALT = `gitslappin-test-${suffix}-alt`;

describe.skipIf(!dockerOk)('docker mode smoke ("docker not available" skips this)', () => {
  let reposDir = '';
  let sshDir = '';
  let emptyEnv = '';
  let demo = '';
  const started: string[] = [];

  const compose = (project: string, port: number, args: string[], timeout = 900_000): string => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REPOS_DIR: fwd(reposDir),
      SSH_DIR: fwd(sshDir),
      GITSLAPPIN_PORT: String(port),
      GITSLAPPIN_TOKEN: TOKEN,
      GIT_USER_NAME: ID_NAME,
      GIT_USER_EMAIL: ID_EMAIL,
      GITSLAPPIN_AUTOCRLF: 'false',
    };
    return execFileSync('docker', ['compose', '--env-file', emptyEnv, '-p', project, '-f', join(REPO_ROOT, 'docker-compose.yml'), ...args], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  const up = (project: string, port: number) => {
    started.push(project);
    compose(project, port, ['up', '-d', '--build', '--wait']);
  };

  /** Raw http so the Host header can be set (fetch forbids it). */
  const http = (port: number, path: string, opts: { host?: string; token?: string | null; method?: string; body?: unknown } = {}) =>
    new Promise<{ status: number; body: string }>((ok, fail) => {
      const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
      if (opts.token !== null) headers['x-gitslappin-token'] = opts.token ?? TOKEN;
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(payload));
      }
      const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => ok({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('error', fail);
      req.end(payload);
    });
  const api = (path: string, opts: Parameters<typeof http>[2] = {}) => http(PORT, path, opts);

  const hostGit = (args: string[], cwd = demo): string => {
    const cfg = join(fresh('gitcfg-docker'), 'global.gitconfig');
    writeFileSync(cfg, '');
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: cfg, GIT_AUTHOR_NAME: 'Host', GIT_AUTHOR_EMAIL: 'host@example.com', GIT_COMMITTER_NAME: 'Host', GIT_COMMITTER_EMAIL: 'host@example.com' },
    });
  };

  beforeAll(() => {
    // Data-safety audit 1 and 2.
    expect(PROJECT).not.toBe('gitslappin');
    expect(PROJECT).toMatch(/^gitslappin-test-[0-9a-f]+$/);
    expect(PROJECT_ALT).not.toBe('gitslappin');
    expect(PORT).toBe(4519);
    reposDir = fresh('docker-repos');
    sshDir = fresh('docker-ssh');
    emptyEnv = join(fresh('docker-env'), 'empty.env');
    writeFileSync(emptyEnv, '');
    expect(reposDir.startsWith(TESTS_ROOT)).toBe(true);
    expect(sshDir.startsWith(TESTS_ROOT)).toBe(true);
    expect(reposDir).not.toBe(sshDir);
    expect(resolve(reposDir).toLowerCase()).not.toContain(join('c:', 'repos').toLowerCase());

    demo = join(reposDir, 'demo');
    mkdirSync(demo);
    hostGit(['init', '-q', '-b', 'main']);
    writeFileSync(join(demo, 'tracked.txt'), 'one\n');
    hostGit(['config', 'core.autocrlf', 'false']);
    hostGit(['add', 'tracked.txt']);
    hostGit(['commit', '-q', '-m', 'initial']);
    // known_hosts only, so the entrypoint has something harmless to copy; no private keys.
    writeFileSync(join(sshDir, 'known_hosts'), '');

    up(PROJECT, PORT);
  });

  afterAll(() => {
    // `stop` only. Never down, -v, volume rm or any deletion.
    for (const p of started) {
      const port = p === PROJECT_ALT ? ALT_PORT : PORT;
      try {
        compose(p, port, ['stop'], 120_000);
      } catch {
        /* a failed stop must not mask the test result */
      }
    }
  });

  it('is healthy', () => {
    const out = execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', compose(PROJECT, PORT, ['ps', '-q', SERVICE]).trim()], { encoding: 'utf8', windowsHide: true });
    expect(out.trim()).toBe('healthy');
  });

  it('ping with the token is 200, without it 403', async () => {
    const ok = await api('/api/ping');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).app).toBe('gitslappin');
    expect((await api('/api/ping', { token: null })).status).toBe(403);
    expect((await api('/api/ping', { token: 'wrong' })).status).toBe(403);
  });

  it('a foreign Host is 403; localhost and 127.0.0.1 with the published port are 200', async () => {
    for (const host of ['evil.com', `evil.com:${PORT}`, 'host.docker.internal', `host.docker.internal:${PORT}`, `172.17.0.2:${PORT}`]) {
      expect((await api('/api/ping', { host })).status, host).toBe(403);
    }
    expect((await api('/api/ping', { host: `localhost:${PORT}` })).status).toBe(200);
    expect((await api('/api/ping', { host: `127.0.0.1:${PORT}` })).status).toBe(200);
    // Not the default port (4417): the Host check follows GITSLAPPIN_PORT.
    expect((await api('/api/ping', { host: '127.0.0.1:4417' })).status).toBe(403);
  });

  it('a non-default GITSLAPPIN_PORT works end to end (separate stack on 4521)', async () => {
    up(PROJECT_ALT, ALT_PORT);
    expect((await http(ALT_PORT, '/api/ping')).status).toBe(200);
    expect((await http(ALT_PORT, '/api/ping', { host: `localhost:${ALT_PORT}` })).status).toBe(200);
    expect((await http(ALT_PORT, '/api/ping', { host: `127.0.0.1:${PORT}` })).status).toBe(403); // another port in Host
    expect((await http(ALT_PORT, '/api/ping', { host: 'evil.com' })).status).toBe(403);
    expect((await http(ALT_PORT, '/api/ping', { token: null })).status).toBe(403);
    const ports = execFileSync('docker', ['port', compose(PROJECT_ALT, ALT_PORT, ['ps', '-q', SERVICE]).trim()], { encoding: 'utf8', windowsHide: true });
    expect(ports).toContain(`127.0.0.1:${ALT_PORT}`);
    expect(ports).not.toContain('0.0.0.0');
  });

  it('docker port publishes only on 127.0.0.1', () => {
    const id = compose(PROJECT, PORT, ['ps', '-q', SERVICE]).trim();
    expect(id).not.toBe('');
    const lines = execFileSync('docker', ['port', id], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toContain(`127.0.0.1:${PORT}`);
      expect(l).not.toContain('0.0.0.0');
      expect(l).not.toContain('[::]');
    }
  });

  it('docker logs do not contain the token', () => {
    const logs = compose(PROJECT, PORT, ['logs', '--no-color', SERVICE]);
    expect(logs).toContain('GitSlappin running at'); // the startup line was printed, so the absence below means something
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain('token=');
  });

  let repoId = '';
  it('opens /repos/demo and refuses /app', async () => {
    const ok = await api('/api/repos/open', { method: 'POST', body: { path: '/repos/demo' } });
    expect(ok.status).toBe(200);
    repoId = JSON.parse(ok.body).id;
    expect(repoId).toBeTruthy();
    for (const p of ['/app', '/repos/..', '/etc']) {
      const bad = await api('/api/repos/open', { method: 'POST', body: { path: p } });
      expect(bad.status, p).toBe(400);
    }
  });

  it('opens a Windows-style host path (GITSLAPPIN_PATH_MAP) and refuses an unmapped drive', async () => {
    // reposDir is the temp REPOS_DIR that compose mounts at /repos; type it the way a Windows user would.
    const typed = join(reposDir, 'demo'); // backslashes on Windows
    for (const p of [typed, `"${typed.toUpperCase().replace(/DEMO$/, 'demo')}"`, `${fwd(typed)}/`]) {
      const res = await api('/api/repos/open', { method: 'POST', body: { path: p } });
      expect(res.status, p).toBe(200);
      expect(JSON.parse(res.body).root).toBe('/repos/demo');
    }
    const drive = reposDir.slice(0, 1).toUpperCase() === 'Q' ? 'R' : 'Q';
    const bad = await api('/api/repos/open', { method: 'POST', body: { path: `${drive}:\\nope\\demo` } });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toBe(`In Docker, GitSlappin can only open folders under the mounted folders (/repos = ${fwd(reposDir)}).`);
  });

  it('V1: POST /api/repos/init through a Windows-style host path creates the repo in the mounted folder with an Initial commit', async () => {
    const name = `docker-init-${suffix}`;
    const res = await api('/api/repos/init', { method: 'POST', body: { parent: reposDir, name } }); // reposDir typed the Windows way (backslashes on Windows)
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).root).toBe(`/repos/${name}`);
    const created = join(reposDir, name);
    expect(readFileSync(join(created, 'README.md'), 'utf8')).toBe(`# ${name}\n`);
    expect(hostGit(['log', '--format=%s'], created).trim()).toBe('Initial commit');
    const bad = await api('/api/repos/init', { method: 'POST', body: { parent: '/etc', name: 'x' } });
    expect(bad.status).toBe(400);
  });

  it('GET /api/fs/list lists /repos but refuses /repos/.., /, C:\\Windows and an escaping symlink', async () => {
    const list = (p: string) => api(`/api/fs/list?path=${encodeURIComponent(p)}`);
    const ok = await list('/repos');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).entries).toContainEqual({ name: 'demo', path: '/repos/demo', isRepo: true });
    expect((await api('/api/fs/list', { token: null })).status).toBe(403);
    for (const p of ['/repos/..', '/', '/etc', 'C:\\Windows', 'C:/repos/../Windows']) {
      const bad = await list(p);
      expect(bad.status, p).toBe(400);
      expect(bad.body, p).not.toContain('"entries"');
    }
    // A symlink inside /repos pointing outside it (created in the container; the test never deletes it).
    compose(PROJECT, PORT, ['exec', '-T', SERVICE, 'sh', '-c', 'ln -s /etc /repos/gitslappin-test-escape-link']);
    const after = await list('/repos');
    expect(after.status).toBe(200);
    const entries = JSON.parse(after.body).entries as { name: string }[];
    expect(entries.map((e) => e.name)).toContain('demo'); // the listing ran
    expect(entries.map((e) => e.name)).not.toContain('gitslappin-test-escape-link');
    expect((await list('/repos/gitslappin-test-escape-link')).status).toBe(400);
  });

  it('a commit through the API has the test identity', async () => {
    writeFileSync(join(demo, 'new.txt'), 'hello\n');
    const staged = await api(`/api/repos/${repoId}/stage`, { method: 'POST', body: { paths: ['new.txt'] } });
    expect(staged.status).toBe(200);
    const done = await api(`/api/repos/${repoId}/commit`, { method: 'POST', body: { message: 'docker smoke commit', amend: false } });
    expect(done.status).toBe(200);
    const who = hostGit(['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s']).trim();
    expect(who).toBe(`${ID_NAME} <${ID_EMAIL}>|${ID_NAME} <${ID_EMAIL}>|docker smoke commit`);
  });

  it('a discard creates refs/gitslappin/undo/* in the mounted repo', async () => {
    writeFileSync(join(demo, 'tracked.txt'), 'changed by host\n');
    expect(hostGit(['for-each-ref', 'refs/gitslappin/undo/']).trim()).toBe('');
    const res = await api(`/api/repos/${repoId}/discard`, { method: 'POST', body: { paths: ['tracked.txt'] } });
    expect(res.status).toBe(200);
    expect(readFileSync(join(demo, 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\n'); // the discard really ran
    expect(hostGit(['for-each-ref', 'refs/gitslappin/undo/']).trim()).not.toBe('');
  });

  it('a file written by the container can be read and overwritten by the host (owner and mode recorded)', () => {
    compose(PROJECT, PORT, ['exec', '-T', SERVICE, 'sh', '-c', 'echo from-container > /repos/demo/from-container.txt']);
    const file = join(demo, 'from-container.txt');
    expect(readFileSync(file, 'utf8').trim()).toBe('from-container');
    const st = statSync(file);
    console.log(`container-written file: uid=${st.uid} gid=${st.gid} mode=${(st.mode & 0o7777).toString(8)} (win32 reports uid/gid 0)`);
    writeFileSync(file, 'overwritten by host\n');
    expect(readFileSync(file, 'utf8')).toBe('overwritten by host\n');
    // And a commit made by the container's git leaves the repo readable by the host git.
    expect(() => hostGit(['fsck', '--no-progress'])).not.toThrow();
  });

  it('live refresh: poll mode picks up a host write (no fs events cross the bind mount)', async () => {
    expect(repoId).toBeTruthy();
    const events: string[] = [];
    const req = request(
      { host: '127.0.0.1', port: PORT, path: `/api/repos/${repoId}/events`, method: 'GET', headers: { host: `127.0.0.1:${PORT}`, 'x-gitslappin-token': TOKEN } },
      (res) => {
        expect(res.statusCode).toBe(200);
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          for (const line of c.split('\n')) if (line.startsWith('data:')) events.push(line.slice(5).trim());
        });
      },
    );
    req.on('error', () => undefined);
    req.end();
    try {
      await new Promise((r) => setTimeout(r, 6000)); // the watcher's baseline (poll interval is 3 s)
      writeFileSync(join(demo, 'live-refresh-host-write.txt'), `host write ${Date.now()}\n`);
      const end = Date.now() + 40_000;
      while (Date.now() < end && !events.some((e) => JSON.parse(e).type === 'status')) await new Promise((r) => setTimeout(r, 500));
      expect(events.map((e) => JSON.parse(e).type)).toContain('status');
    } finally {
      req.destroy();
    }
  });
});
