import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { repoIdFor } from '../state/registry';
import { runExclusive } from './queue';
import { stashApply, stashPush } from './stash';
import { MAX_LIST, clipSubject, forgetRepo, record, redo, undo, undoState } from './undo';

/* Phase 10 code-review fixes 1-5 and 7 (server side). Real git in fresh folders under os.tmpdir()/gitslappin-tests. Nothing is deleted. */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const GLOBAL_CFG = join(fresh('gitcfg-p10r'), 'global.gitconfig');
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
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL_CFG, GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com' });

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const head = (repo: string): string => git(repo, ['rev-parse', 'HEAD']).trim();
const branchNow = (repo: string): string => git(repo, ['branch', '--show-current']).trim();
const hasBranch = (repo: string, name: string): boolean => spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${name}`], { cwd: repo, env: ENV, windowsHide: true }).status === 0;

function newRepo(prefix: string): { repo: string; c1: string } {
  const repo = join(fresh(prefix), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'author@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'a.txt'), 'a1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'Base']);
  return { repo, c1: head(repo) };
}

describe('fix 1: journal memory', () => {
  it('a recorded subject is cut to 200 characters', () => {
    expect(clipSubject('x'.repeat(200))).toBe('x'.repeat(200));
    expect(clipSubject('y'.repeat(201))).toBe('y'.repeat(200));
    expect(Array.from(clipSubject('😀'.repeat(500))).length).toBe(200);
    // record() accepts a huge subject and still gives a normal label
    const { repo, c1 } = newRepo('p10r-subject');
    record(repo, { kind: 'commit', sha: c1, prev: null, branch: 'main', subject: 'z'.repeat(100_000) });
    expect(undoState(repo).undo?.label.length).toBeLessThan(100);
  });

  it(`a stash of more than ${MAX_LIST} paths: undo works, but no redo is stored; a pop with more than ${MAX_LIST} untracked files is not recorded`, async () => {
    const { repo } = newRepo('p10r-cap');
    const dir = join(repo, 'many');
    mkdirSync(dir);
    for (let i = 0; i <= MAX_LIST; i++) writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    expect(git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)).toHaveLength(MAX_LIST + 1);

    expect((await stashPush(repo, { message: 'big' })).outcome).toBe('done');
    expect(undoState(repo).undo).toEqual({ label: 'stash' });
    expect((await undo(repo)).outcome).toBe('done');
    expect(git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)).toHaveLength(MAX_LIST + 1); // all files are back
    expect(undoState(repo).redo).toBeNull(); // over the cap: nothing partial is kept
    expect((await redo(repo)).outcome).toBe('refused');

    // pop: the state afterwards has too many untracked names, so the pop is not recorded
    expect((await stashPush(repo, { message: 'big again' })).outcome).toBe('done');
    const sha = git(repo, ['rev-parse', 'stash@{0}']).trim();
    forgetRepo(repo);
    expect((await stashApply(repo, sha, true)).outcome).toBe('done');
    expect(git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)).toHaveLength(MAX_LIST + 1);
    expect(undoState(repo)).toEqual({ undo: null, redo: null });
  }, 400_000); // thousands of files through real git on Windows
});

describe('fix 4: undo never deletes a branch that another worktree has checked out', () => {
  it('create-branch: refused, branch kept, nothing changed', async () => {
    const { repo, c1 } = newRepo('p10r-wt1');
    git(repo, ['branch', 'topic', c1]);
    const other = join(fresh('p10r-wt1-other'), 'w');
    git(repo, ['worktree', 'add', other, 'topic']);
    record(repo, { kind: 'create-branch', name: 'topic', sha: c1, from: { branch: 'main', sha: c1 }, checkedOut: false });
    const r = await undo(repo);
    expect(r.outcome).toBe('refused');
    expect(r.error).toContain('another worktree');
    expect(hasBranch(repo, 'topic')).toBe(true);
    expect(branchNow(repo)).toBe('main');
    expect(undoState(repo).undo).toEqual({ label: "create branch 'topic'" }); // still recorded
  });

  it('checkout that created a branch: refused when a second worktree is also on it; the first worktree stays where it is', async () => {
    const { repo, c1 } = newRepo('p10r-wt2');
    git(repo, ['switch', '-c', 'topic']);
    const other = join(fresh('p10r-wt2-other'), 'w');
    git(repo, ['worktree', 'add', '--force', other, 'topic']);
    record(repo, { kind: 'checkout', from: { branch: 'main', sha: c1 }, to: { branch: 'topic', sha: c1 }, createdBranch: 'topic' });
    const r = await undo(repo);
    expect(r.outcome).toBe('refused');
    expect(r.error).toContain('another worktree');
    expect(hasBranch(repo, 'topic')).toBe(true);
    expect(branchNow(repo)).toBe('topic');
  });

  it('without another worktree the same undo still works (the current worktree on the branch does not count)', async () => {
    const { repo, c1 } = newRepo('p10r-wt3');
    git(repo, ['switch', '-c', 'topic']);
    record(repo, { kind: 'create-branch', name: 'topic', sha: c1, from: { branch: 'main', sha: c1 }, checkedOut: true });
    expect((await undo(repo)).outcome).toBe('done');
    expect(hasBranch(repo, 'topic')).toBe(false);
    expect(branchNow(repo)).toBe('main');
  });
});

describe('fix 5: the redo list is cleared inside the repo lock by any block that is not an undo / redo step', () => {
  it('runExclusive clears redo; an undo / redo step itself keeps it', async () => {
    const { repo, c1 } = newRepo('p10r-lock');
    git(repo, ['branch', 'topic', c1]);
    record(repo, { kind: 'create-branch', name: 'topic', sha: c1, from: { branch: 'main', sha: c1 }, checkedOut: false });
    expect((await undo(repo)).outcome).toBe('done');
    expect(undoState(repo).redo).toEqual({ label: "create branch 'topic'" });
    let seenInside: unknown = 'unset';
    await runExclusive(repoIdFor(repo), async () => {
      seenInside = undoState(repo).redo; // already cleared when the block starts
    });
    expect(seenInside).toBeNull();
    expect(undoState(repo).redo).toBeNull();
    expect((await redo(repo)).outcome).toBe('refused');
    // another repo's redo is not touched
    const b = newRepo('p10r-lock-b');
    git(b.repo, ['branch', 'topic', b.c1]);
    record(b.repo, { kind: 'create-branch', name: 'topic', sha: b.c1, from: { branch: 'main', sha: b.c1 }, checkedOut: false });
    await undo(b.repo);
    await runExclusive(repoIdFor(repo), async () => undefined);
    expect(undoState(b.repo).redo).not.toBeNull();
  });
});

describe('fix 7: the redo-clearing hook goes by the decoded route', () => {
  it('an encoded spelling of /redo is still treated as redo (does not clear its own redo list first)', async () => {
    const { repo, c1 } = newRepo('p10r-route');
    const port = 4999;
    const token = 'p10r-token';
    const app = await buildApp({ port, token, dataDir: fresh('p10r-route-data'), clientDist: join(fresh('p10r-route-nodist'), 'none'), noOpen: true });
    const h = { host: `127.0.0.1:${port}`, 'x-gitslappin-token': token };
    try {
      const opened = await app.inject({ method: 'POST', url: '/api/repos/open', headers: h, payload: { path: repo } });
      expect(opened.statusCode).toBe(200);
      const { id, root } = opened.json() as { id: string; root: string };
      git(repo, ['branch', 'topic', c1]);
      record(root, { kind: 'create-branch', name: 'topic', sha: c1, from: { branch: 'main', sha: c1 }, checkedOut: false });
      expect((await app.inject({ method: 'POST', url: `/api/repos/${id}/undo`, headers: h })).statusCode).toBe(200);
      expect(hasBranch(repo, 'topic')).toBe(false);
      expect(undoState(root).redo).not.toBeNull();
      const res = await app.inject({ method: 'POST', url: `/api/repos/${id}/re%64o`, headers: h });
      expect(res.statusCode, res.body).toBe(200);
      expect(hasBranch(repo, 'topic')).toBe(true);
      // and a different route still clears it, so the hook did run
      expect((await app.inject({ method: 'POST', url: `/api/repos/${id}/undo`, headers: h })).statusCode).toBe(200);
      expect(undoState(root).redo).not.toBeNull();
      await app.inject({ method: 'POST', url: `/api/repos/${id}/stage`, headers: h, payload: { paths: [] } });
      expect(undoState(root).redo).toBeNull();
    } finally {
      await app.close();
    }
  });
});
