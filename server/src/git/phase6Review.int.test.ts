import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { mergeBranch, rebaseContinue, rebaseOnto } from './integrate';
import { readOpState } from './opState';

/*
 * Phase 6 code-review fixes 1, 3, 4, 5, 7 and 8 (build-notes). Real git in mkdtemp folders under os.tmpdir()/gitslappin-tests.
 * Nothing is deleted. Fix 2 (toast) and fix 6 (Abort for cherry-pick/revert) are browser behaviour: tests/e2e/phase6-review.spec.ts.
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const GLOBAL_CFG = join(fresh('gitcfg-p6review'), 'global.gitconfig');
writeFileSync(GLOBAL_CFG, '[core]\n\teditor = false\n');
const BASE_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL_CFG, GIT_TERMINAL_PROMPT: '0', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com' };
delete BASE_ENV.GITSLAPPIN_TOKEN;
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com' });

const envFor = (who: string): NodeJS.ProcessEnv => ({ ...BASE_ENV, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who.toLowerCase().replace(/ /g, '.')}@example.com` });
const git = (cwd: string, args: string[], who = 'Test Author'): string => execFileSync('git', args, { cwd, env: envFor(who), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): number | null => spawnSync('git', args, { cwd, env: envFor('Test Author'), encoding: 'utf8', windowsHide: true }).status;
const head = (repo: string): string => git(repo, ['rev-parse', 'HEAD']).trim();
const text = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8');
const subjects = (repo: string): string[] => git(repo, ['log', '--format=%s']).split('\n').filter(Boolean);
const authorOf = (repo: string, subject: string): string | undefined => git(repo, ['log', '--format=%an%x09%s']).split('\n').find((l) => l.endsWith(`\t${subject}`))?.split('\t')[0];

function commit(repo: string, files: Record<string, string>, msg: string, who = 'Test Author'): string {
  for (const [rel, t] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, t);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', msg], who);
  return head(repo);
}
function newRepo(prefix: string): string {
  const repo = join(fresh(prefix), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  for (const [k, v] of Object.entries({ 'user.name': 'Test Author', 'user.email': 'author@example.com', 'core.autocrlf': 'false', 'core.editor': 'false' })) git(repo, ['config', k, v]);
  return repo;
}

/** main: Base, First change (First Author), Set title to Conflict B (Other Author), Third change (Third Author); feature/conflict: Base + Set title to Conflict A. */
function rebaseRepo(config: Record<string, string> = {}): { repo: string; shas: string[] } {
  const repo = newRepo('p6r-rebase');
  for (const [k, v] of Object.entries(config)) git(repo, ['config', k, v]);
  commit(repo, { 'src/config.js': 'title=base\n', 'README.md': '# readme\n' }, 'Base');
  git(repo, ['switch', '-c', 'feature/conflict']);
  commit(repo, { 'src/config.js': 'title=feature\n' }, 'Set title to Conflict A');
  git(repo, ['switch', 'main']);
  const s1 = commit(repo, { 'a.txt': 'a\n' }, 'First change', 'First Author');
  const s2 = commit(repo, { 'src/config.js': 'title=main\n' }, 'Set title to Conflict B', 'Other Author');
  const s3 = commit(repo, { 'c.txt': 'c\n' }, 'Third change', 'Third Author');
  return { repo, shas: [s1, s2, s3] };
}
const resolve = (repo: string): void => {
  writeFileSync(join(repo, 'src/config.js'), 'title=resolved\n');
  git(repo, ['add', 'src/config.js']);
};

describe('review fix 1: merge and rebase pass the resolved full ref', () => {
  it('merge: a tag with the same name as the branch does not win', async () => {
    const repo = newRepo('p6r-tagmerge');
    commit(repo, { 'a.txt': 'a\n' }, 'Base');
    git(repo, ['switch', '-c', 'topic']);
    commit(repo, { 'topic.txt': 'topic\n' }, 'Topic change');
    git(repo, ['switch', 'main']);
    commit(repo, { 'main.txt': 'main\n' }, 'Main change');
    git(repo, ['tag', 'topic', 'main']); // the bare name "topic" now means the tag (it is already merged)
    const r = await mergeBranch(repo, 'topic');
    expect(r.outcome).toBe('done');
    expect(existsSync(join(repo, 'topic.txt'))).toBe(true); // the branch was merged, not the tag
    expect(git(repo, ['log', '-1', '--format=%P']).trim().split(' ')).toHaveLength(2);
    expect(git(repo, ['log', '-1', '--format=%s']).trim()).toBe("Merge branch 'topic'"); // not 'refs/heads/topic'
  });

  it('rebase: a tag with the same name as the branch does not win', async () => {
    const repo = newRepo('p6r-tagrebase');
    commit(repo, { 'a.txt': 'a\n' }, 'Base');
    git(repo, ['switch', '-c', 'topic']);
    commit(repo, { 'topic.txt': 'topic\n' }, 'Topic change');
    git(repo, ['tag', 'topic', 'main']); // tag at the Base commit
    git(repo, ['switch', 'main']);
    commit(repo, { 'main.txt': 'main\n' }, 'Main change');
    const r = await rebaseOnto(repo, 'topic');
    expect(r.outcome).toBe('done');
    expect(subjects(repo).slice(0, 2)).toEqual(['Main change', 'Topic change']); // main now sits on the branch
    expect(existsSync(join(repo, 'topic.txt'))).toBe(true);
  });

  it('merge of a remote-tracking branch still works (refs/remotes/...)', async () => {
    const repo = newRepo('p6r-remote');
    commit(repo, { 'a.txt': 'a\n' }, 'Base');
    git(repo, ['switch', '-c', 'topic']);
    const t = commit(repo, { 'topic.txt': 'topic\n' }, 'Topic change');
    git(repo, ['switch', 'main']);
    commit(repo, { 'main.txt': 'main\n' }, 'Main change');
    git(repo, ['update-ref', 'refs/remotes/origin/topic', t]);
    const r = await mergeBranch(repo, 'origin/topic');
    expect(r.outcome).toBe('done');
    expect(existsSync(join(repo, 'topic.txt'))).toBe(true);
    expect(git(repo, ['log', '-1', '--format=%s']).trim()).toBe("Merge remote-tracking branch 'origin/topic'");
  });
});

describe('review fix 3: rebase.backend=apply', () => {
  it('continue with the unchanged message and with an edited one both finish the rebase and keep the authors', async () => {
    for (const edited of [false, true]) {
      const { repo } = rebaseRepo({ 'rebase.backend': 'apply' });
      const r0 = await rebaseOnto(repo, 'feature/conflict');
      expect(r0.outcome).toBe('conflict');
      expect(existsSync(join(repo, '.git', 'rebase-apply'))).toBe(true); // the apply backend is really in use
      expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false);
      const op = await readOpState(repo);
      expect(op?.kind).toBe('rebase');
      resolve(repo);
      const message = edited ? 'Edited apply subject\n' : op!.message;
      const r = await rebaseContinue(repo, { message });
      expect(r.outcome, r.stderr).toBe('done');
      expect(existsSync(join(repo, '.git', 'rebase-apply'))).toBe(false);
      const subject = edited ? 'Edited apply subject' : 'Set title to Conflict B';
      expect(subjects(repo).slice(0, 3)).toEqual(['Third change', subject, 'First change']);
      expect(authorOf(repo, subject)).toBe('Other Author');
      expect(authorOf(repo, 'Third change')).toBe('Third Author');
      expect(text(repo, 'src/config.js')).toBe('title=resolved\n');
    }
  });
});

describe('review fix 4: post-rewrite hook sees the manually committed step', () => {
  const HOOK = '#!/bin/sh\necho "$1" >> .git/post-rewrite.txt\ncat >> .git/post-rewrite.txt\n';
  const pairs = (repo: string): string[][] =>
    readFileSync(join(repo, '.git', 'post-rewrite.txt'), 'utf8')
      .split('\n')
      .filter((l) => /^[0-9a-f]{40,64} [0-9a-f]{40,64}/.test(l))
      .map((l) => l.split(' ').slice(0, 2));

  for (const edited of [false, true]) {
    it(`${edited ? 'edited' : 'unchanged'} message: every original commit, including the conflicted step, is in the hook input`, async () => {
      const { repo, shas } = rebaseRepo();
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(repo, '.git', 'hooks', 'post-rewrite'), HOOK, { mode: 0o755 });
      expect((await rebaseOnto(repo, 'feature/conflict')).outcome).toBe('conflict');
      resolve(repo);
      const op = await readOpState(repo);
      const r = await rebaseContinue(repo, { message: edited ? 'Edited hook subject\n' : op!.message });
      expect(r.outcome, r.stderr).toBe('done');
      const log = readFileSync(join(repo, '.git', 'post-rewrite.txt'), 'utf8');
      expect(log).toContain('rebase');
      const olds = pairs(repo).map((p) => p[0]);
      for (const sha of shas) expect(olds, `old commit ${sha} is missing from the post-rewrite input`).toContain(sha);
      const news = pairs(repo).map((p) => p[1]);
      expect(news).toContain(head(repo));
    });
  }
});

describe('review fix 5: the rebase onto-name comes only from a reflog entry newer than the rebase directory', () => {
  it('a current entry gives the branch name', async () => {
    const { repo } = rebaseRepo();
    expect((await rebaseOnto(repo, 'feature/conflict')).outcome).toBe('conflict');
    expect((await readOpState(repo))?.onto).toBe('feature/conflict');
  });

  it('a stale entry (older than the rebase directory) is ignored: the branch at that commit, else the short sha', async () => {
    const { repo } = rebaseRepo();
    expect((await rebaseOnto(repo, 'feature/conflict')).outcome).toBe('conflict');
    const onto = git(repo, ['rev-parse', 'feature/conflict']).trim();
    // Replace the HEAD reflog by one old entry that names something else (throwaway repo, no deletion).
    const logFile = join(repo, '.git', 'logs', 'HEAD');
    expect(existsSync(logFile)).toBe(true);
    writeFileSync(logFile, `${'0'.repeat(40)} ${onto} Test Author <author@example.com> 1000000000 +0000\trebase (start): checkout stale/name\n`);
    expect((await readOpState(repo))?.onto).toBe('feature/conflict'); // nameForSha finds the branch at that commit
  });
});

describe('review fix 7 and 8: routes', () => {
  const PORT = 4997;
  const HOST = `127.0.0.1:${PORT}`;
  async function start(repo: string) {
    const app = await buildApp({ port: PORT, token: 'tok', dataDir: fresh('p6r-data'), clientDist: join(tmpdir(), 'gitslappin-no-such-dist'), noOpen: true });
    const headers = { host: HOST, 'x-gitslappin-token': 'tok' };
    const opened = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: repo } });
    expect(opened.statusCode).toBe(200);
    const id = (opened.json() as { id: string }).id;
    const post = (sub: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/repos/${id}/${sub}`, headers, payload: payload as object });
    return { post };
  }

  it('7: a merge whose conflicts were resolved to HEAD content commits with nothing staged (two parents, "#" lines stripped)', async () => {
    const repo = newRepo('p6r-empty-merge');
    commit(repo, { 'f.txt': 'base\n' }, 'Base');
    git(repo, ['switch', '-c', 'topic']);
    commit(repo, { 'f.txt': 'topic\n' }, 'Topic edit');
    git(repo, ['switch', 'main']);
    const mainTip = commit(repo, { 'f.txt': 'main\n' }, 'Main edit');
    expect(tryGit(repo, ['merge', '--no-ff', '--no-edit', 'topic'])).not.toBe(0);
    writeFileSync(join(repo, 'f.txt'), 'main\n'); // HEAD's content
    git(repo, ['add', 'f.txt']);
    expect(tryGit(repo, ['diff', '--cached', '--quiet'])).toBe(0); // fixture check: nothing is staged
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
    const s = await start(repo);
    const res = await s.post('commit', { message: "Merge branch 'topic'\n\n# Conflicts:\n#\tf.txt", amend: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(git(repo, ['log', '-1', '--format=%P']).trim().split(' ')).toHaveLength(2);
    expect(git(repo, ['log', '-1', '--format=%P']).trim().split(' ')[0]).toBe(mainTip);
    expect(git(repo, ['log', '-1', '--format=%B']).split('\n').some((l) => l.startsWith('#'))).toBe(false);
  });

  it('7: with a conflict still unresolved the commit is refused and nothing is committed', async () => {
    const repo = newRepo('p6r-unresolved');
    commit(repo, { 'f.txt': 'base\n' }, 'Base');
    git(repo, ['switch', '-c', 'topic']);
    commit(repo, { 'f.txt': 'topic\n' }, 'Topic edit');
    git(repo, ['switch', 'main']);
    const mainTip = commit(repo, { 'f.txt': 'main\n' }, 'Main edit');
    expect(tryGit(repo, ['merge', '--no-ff', '--no-edit', 'topic'])).not.toBe(0);
    const s = await start(repo);
    const res = await s.post('commit', { message: 'Merge', amend: false });
    expect(res.statusCode).toBe(500);
    expect(head(repo)).toBe(mainTip);
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('8: continue with the wrong step is refused with 409 and changes nothing; the right step works', async () => {
    const { repo } = rebaseRepo();
    expect((await rebaseOnto(repo, 'feature/conflict')).outcome).toBe('conflict');
    resolve(repo);
    const before = head(repo);
    const s = await start(repo);
    const wrong = await s.post('rebase/continue', { message: 'Wrong step\n', step: 1 });
    expect(wrong.statusCode).toBe(409);
    expect(head(repo)).toBe(before);
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(true);
    expect((await readOpState(repo))?.step).toBe(2);
    expect(subjects(repo)).not.toContain('Wrong step');
    const bad = await s.post('rebase/continue', { step: 'two' });
    expect(bad.statusCode).toBe(400);
    const ok = await s.post('rebase/continue', { step: 2 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false);
  });

  it('8: rebaseContinue with a mismatching step returns blocked', async () => {
    const { repo } = rebaseRepo();
    expect((await rebaseOnto(repo, 'feature/conflict')).outcome).toBe('conflict');
    resolve(repo);
    const r = await rebaseContinue(repo, { step: 3 });
    expect(r.outcome).toBe('blocked');
    expect((await readOpState(repo))?.step).toBe(2);
  });
});
