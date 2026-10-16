import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';

vi.setConfig({ testTimeout: 90_000 });

/*
 * V6 design "1 Drag and drop" + audit data-safety 4 + security 4: POST /api/repos/:id/push gains an optional `upstream`.
 *   - omitted or true  -> today's behaviour: `-u` is added when `remote` is given, so the branch's upstream is set.
 *   - false            -> `-u` is left out: branch.<name>.remote / .merge are NOT written.
 *   - any non-boolean (string, number, null, object, array) -> 400 { error } before git runs: nothing is pushed.
 *   - upstream:false never adds --force: a push that is not a fast-forward is refused (409, as today) and origin is unchanged.
 * Black box through app.inject, real git over file:// inside os.tmpdir()/gitslappin-tests. Nothing is deleted.
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const CFG = fresh('gitcfg-pushupstream');
const EMPTY_GLOBAL = join(CFG, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL, '');
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
});
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

const PORT = 4994;
const TOKEN = 'p'.repeat(40);
const headers = { host: `127.0.0.1:${PORT}`, 'x-gitslappin-token': TOKEN };

function commit(repo: string, file: string, text: string, msg: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

/** origin (bare) + work (clone, main pushed with upstream) + a local-only branch `topic` with one extra commit. */
async function setup() {
  const base = fresh('gitslappin-pushupstream');
  const origin = join(base, 'origin.git');
  mkdirSync(origin);
  git(origin, ['init', '--bare', '-b', 'main']);
  const work = join(base, 'work');
  mkdirSync(work);
  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'protocol.allow', 'never']);
  git(work, ['config', 'protocol.file.allow', 'always']);
  git(work, ['remote', 'add', 'origin', pathToFileURL(origin).href]);
  commit(work, 'a.txt', 'a\n', 'one');
  git(work, ['push', '-u', 'origin', 'main']);
  git(work, ['switch', '-c', 'topic']);
  const topicSha = commit(work, 'topic.txt', 'topic\n', 'topic work');
  const config = loadConfig({ GITSLAPPIN_NO_OPEN: '1', GITSLAPPIN_TOKEN: TOKEN, GITSLAPPIN_PORT: String(PORT), GITSLAPPIN_DATA_DIR: fresh('gitslappin-unit-pushupstream') });
  const app = await buildApp(config);
  const open = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: work } });
  expect(open.statusCode).toBe(200);
  const id = (JSON.parse(open.body) as { id: string }).id;
  const push = (body: unknown) => app.inject({ method: 'POST', url: `/api/repos/${id}/push`, headers, payload: body as object });
  const originRef = (ref: string): string | null => {
    const r = tryGit(origin, ['rev-parse', '--verify', '--quiet', ref]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const cfg = (key: string): string | null => {
    const r = tryGit(work, ['config', '--local', '--get', key]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  return { base, origin, work, topicSha, push, originRef, cfg };
}

describe('POST /push upstream', () => {
  it('upstream:false pushes the branch but writes no upstream config (and does not touch the other branches)', async () => {
    const fx = await setup();
    const res = await fx.push({ branch: 'topic', remote: 'origin', remoteBranch: 'topic', upstream: false });
    expect(res.statusCode).toBe(200);
    expect(fx.originRef('refs/heads/topic')).toBe(fx.topicSha); // the code path ran: the branch arrived
    expect(fx.cfg('branch.topic.remote')).toBeNull();
    expect(fx.cfg('branch.topic.merge')).toBeNull();
    expect(fx.cfg('branch.main.remote')).toBe('origin'); // unchanged
  });

  it('upstream omitted keeps today\'s behaviour: -u, the upstream is set', async () => {
    const fx = await setup();
    expect((await fx.push({ branch: 'topic', remote: 'origin', remoteBranch: 'topic' })).statusCode).toBe(200);
    expect(fx.originRef('refs/heads/topic')).toBe(fx.topicSha);
    expect(fx.cfg('branch.topic.remote')).toBe('origin');
    expect(fx.cfg('branch.topic.merge')).toBe('refs/heads/topic');
  });

  it('upstream:true is the same as omitted', async () => {
    const fx = await setup();
    expect((await fx.push({ branch: 'topic', remote: 'origin', remoteBranch: 'topic', upstream: true })).statusCode).toBe(200);
    expect(fx.cfg('branch.topic.remote')).toBe('origin');
  });

  it('audit security 4: a non-boolean upstream is 400 with { error } and nothing is pushed', async () => {
    const fx = await setup();
    const before = tryGit(fx.origin, ['for-each-ref']).stdout;
    for (const bad of ['false', 'true', 'yes', 0, 1, null, {}, [], [false]]) {
      const res = await fx.push({ branch: 'topic', remote: 'origin', remoteBranch: 'topic', upstream: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(typeof JSON.parse(res.body).error).toBe('string');
    }
    expect(tryGit(fx.origin, ['for-each-ref']).stdout).toBe(before);
    expect(fx.originRef('refs/heads/topic')).toBeNull();
    expect(fx.cfg('branch.topic.remote')).toBeNull();
    // the same request with a boolean goes through (the 400s were about the value, not the route)
    expect((await fx.push({ branch: 'topic', remote: 'origin', remoteBranch: 'topic', upstream: false })).statusCode).toBe(200);
  });

  it('audit data-safety 4: upstream:false never forces: a non-fast-forward is refused (409) and origin keeps its commit', async () => {
    const fx = await setup();
    // origin already has `topic` with a commit that local `topic` does not contain
    const other = join(fx.base, 'other');
    git(fx.base, ['clone', pathToFileURL(fx.origin).href, 'other']);
    git(other, ['config', 'user.name', 'Other']);
    git(other, ['config', 'user.email', 'o@example.com']);
    git(other, ['switch', '-c', 'topic']);
    const theirs = commit(other, 'theirs.txt', 'theirs\n', 'their topic commit');
    git(other, ['push', 'origin', 'topic']);
    const res = await fx.push({ branch: 'topic', remote: 'origin', remoteBranch: 'topic', upstream: false });
    expect(res.statusCode).toBe(409);
    expect(fx.originRef('refs/heads/topic')).toBe(theirs);
    expect(fx.cfg('branch.topic.remote')).toBeNull();
  });
});
