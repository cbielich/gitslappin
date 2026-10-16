import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { readOpState } from './opState';
import { buildAndMove, runner, type Run, type Step } from './rewrite';
import { repoIdFor } from '../state/registry';

/*
 * V4 (History rewriting): reword, squash, interactive rebase, multi cherry-pick and the rewrite undo journal, driven through the HTTP routes
 * (buildApp + app.inject, like phase6Review.int.test.ts), because the todo files live in the data dir the app is built with.
 * Real git in mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted. The data dir of every app has SPACES in its name
 * (audit data-safety item 5: made with mkdtemp too, nothing removes it), so every rebase test is also the "data dir with spaces" test.
 *
 * Route contract the builder implements (chosen by the test author unless marked build-notes):
 *   POST /api/repos/:id/reword        {sha, expectHead, message}            build-notes A.   200 {outcome:'done', sha?: newTip}
 *   POST /api/repos/:id/squash        {shas[], expectHead}                  build-notes A.   200 {outcome:'done', sha?}
 *   GET  /api/repos/:id/rebase/interactive/plan?mode=onto|children&target=   200 {branch, ontoLabel, commits:[{sha, subject, authorName, authorEmail}] newest first}
 *        mode=children: target is a commit on HEAD's line; the plan is the commits ABOVE it up to HEAD (rev-list target..HEAD).
 *        mode=onto: target is a branch name or full sha; the plan is rev-list target..HEAD.
 *   POST /api/repos/:id/rebase/interactive {upstream, onto, expectHead, steps:[{sha, action, message?}]}   steps OLDEST FIRST (todo order)
 *        200 {outcome:'done'|'conflict'} like /rebase. A squash step has no message of its own: the combined commit's message is
 *        joinMessages([the commit it squashes into, then each squashed commit]) oldest first (shared/src/rewrite.ts). A reword step carries `message`.
 *   POST /api/repos/:id/cherry-pick/multi {shas[] (OLDEST FIRST), expectHead}   200 {outcome:'done'|'conflict'}
 *   Refusals: HTTP 400 (malformed body / invalid sha) or 409 (state: HEAD moved, detached, operation in progress, merge in the way, ...), body {error}.
 *   Cap refusals (500) carry the number 500 in the error text. Nothing in the repo changes on a refusal (HEAD, refs, index, worktree bytes).
 *   Journal: undo-state labels "reword '<subject>'", "squash 3 commits", "rebase 'main'", "cherry pick 2 commits" (build-notes Journal; the quoted
 *   subject of a reword is asserted only as /^reword '.+'$/).
 *   Pins: the old tip is pinned as refs/gitslappin/undo/<sha> (snapshot.ts:56 pin()) before any ref moves.
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const GLOBAL_CFG = join(fresh('gitcfg-rewrite'), 'global.gitconfig');
writeFileSync(GLOBAL_CFG, '[core]\n\teditor = false\n');
const BASE_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL_CFG, GIT_TERMINAL_PROMPT: '0' };
delete BASE_ENV.GITSLAPPIN_TOKEN;
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com' });

let clock = 1_700_000_000;
const envFor = (who: string, date: string): NodeJS.ProcessEnv => ({
  ...BASE_ENV,
  GIT_AUTHOR_NAME: who,
  GIT_AUTHOR_EMAIL: `${who.toLowerCase().replace(/ /g, '.')}@example.com`,
  GIT_AUTHOR_DATE: date,
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: date,
});
const git = (cwd: string, args: string[], who = 'Test Author'): string =>
  execFileSync('git', args, { cwd, env: envFor(who, `${clock} +0000`), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): number | null => spawnSync('git', args, { cwd, env: envFor('Test Author', `${clock} +0000`), encoding: 'utf8', windowsHide: true }).status;
const gitBuf = (cwd: string, args: string[]): Buffer => execFileSync('git', args, { cwd, env: BASE_ENV, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

const head = (repo: string): string => git(repo, ['rev-parse', 'HEAD']).trim();
const rev = (repo: string, r: string): string => git(repo, ['rev-parse', r]).trim();
const refOrNull = (repo: string, ref: string): string | null => {
  const r = spawnSync('git', ['rev-parse', '--verify', '-q', ref], { cwd: repo, env: BASE_ENV, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};
const pinned = (repo: string, sha: string): boolean => refOrNull(repo, `refs/gitslappin/undo/${sha}`) === sha;
const text = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8');
const treeOf = (repo: string, r: string): string => git(repo, ['rev-parse', `${r}^{tree}`]).trim();
const subjects = (repo: string, r = 'HEAD'): string[] => git(repo, ['log', '--format=%s', r]).split('\n').filter(Boolean);
const message = (repo: string, r = 'HEAD'): string => git(repo, ['log', '-1', '--format=%B', r]).trimEnd();
const rebasing = (repo: string): boolean => existsSync(join(repo, '.git', 'rebase-merge')) || existsSync(join(repo, '.git', 'rebase-apply'));
const stashes = (repo: string): string[] => git(repo, ['stash', 'list', '--format=%gs']).split('\n').filter(Boolean);
const authorLine = (repo: string, r: string): Buffer => {
  const raw = gitBuf(repo, ['cat-file', 'commit', r]);
  const start = raw.indexOf('\nauthor ') + 1;
  return raw.subarray(start, raw.indexOf('\n', start));
};
const authorInfo = (repo: string, r: string): string => git(repo, ['log', '-1', '--format=%an|%ae|%at', r]).trim();

function commit(repo: string, files: Record<string, string>, msg: string, who = 'Test Author'): string {
  clock += 100;
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

interface Lin {
  repo: string;
  base: string;
  c1: string;
  c2: string;
  c3: string;
  c4: string;
}
/** main: Base (a.txt, b.txt), then one, two, three, four (each adds fN.txt; four different authors). */
function linear(prefix = 'rw-lin'): Lin {
  const repo = newRepo(prefix);
  const base = commit(repo, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'Base');
  const c1 = commit(repo, { 'f1.txt': '1\n' }, 'one', 'First Author');
  const c2 = commit(repo, { 'f2.txt': '2\n' }, 'two', 'Second Author');
  const c3 = commit(repo, { 'f3.txt': '3\n' }, 'three', 'Third Author');
  const c4 = commit(repo, { 'f4.txt': '4\n' }, 'four', 'Fourth Author');
  return { repo, base, c1, c2, c3, c4 };
}

/** A commit object written byte for byte (hash-object --literally): headers git itself would never write. Same tree as `tree`. */
function rawCommit(repo: string, o: { tree: string; parents: string[]; author: string; headers?: string[]; message: string }): string {
  const lines = [`tree ${o.tree}`, ...o.parents.map((p) => `parent ${p}`), `author ${o.author}`, `committer ${o.author}`, ...(o.headers ?? [])];
  const buf = Buffer.from(`${lines.join('\n')}\n\n${o.message}`, 'utf8');
  return execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], { cwd: repo, env: BASE_ENV, input: buf, encoding: 'utf8', windowsHide: true }).trim();
}

function snap(repo: string): { head: string; refs: string; index: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const rel of readdirSync(repo, { recursive: true }) as string[]) {
    const r = rel.replace(/\\/g, '/');
    if (r === '.git' || r.startsWith('.git/')) continue;
    const full = join(repo, rel);
    if (statSync(full).isFile()) files[r] = readFileSync(full).toString('base64');
  }
  return { head: head(repo), refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags']), index: git(repo, ['ls-files', '-s']), files };
}

const PORT = 4983;
const HOST = `127.0.0.1:${PORT}`;
async function start(repo: string) {
  const dataDir = fresh('rw data with spaces'); // spaces on purpose (audit data-safety item 5)
  const app = await buildApp({ port: PORT, token: 'tok', dataDir, clientDist: join(tmpdir(), 'gitslappin-no-such-dist'), noOpen: true });
  const headers = { host: HOST, 'x-gitslappin-token': 'tok' };
  const opened = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path: repo } });
  expect(opened.statusCode).toBe(200);
  const id = (opened.json() as { id: string }).id;
  const post = (sub: string, payload?: unknown) => app.inject({ method: 'POST', url: `/api/repos/${id}/${sub}`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  const get = (sub: string) => app.inject({ method: 'GET', url: `/api/repos/${id}/${sub}`, headers });
  const undoState = async () => (await get('undo-state')).json() as { undo: { label: string } | null; redo: { label: string } | null };
  return { dataDir, post, get, undoState };
}
type Res = Awaited<ReturnType<Awaited<ReturnType<typeof start>>['post']>>;
const refused = (r: Res): void => expect([400, 409], r.body).toContain(r.statusCode);
const okRes = (r: Res): void => expect(r.statusCode, r.body).toBe(200);
const outcome = (r: Res): string => (r.json() as { outcome?: string }).outcome ?? '';

const step = (sha: string, action: 'pick' | 'reword' | 'squash' | 'drop', msg?: string) => ({ sha, action, ...(msg === undefined ? {} : { message: msg }) });
const picks = (...shas: string[]) => shas.map((s) => step(s, 'pick'));

// ---------------------------------------------------------------------------------------------------------------------
describe('reword', () => {
  it('HEAD with staged and unstaged changes: new message, same tree and parent, index and worktree bytes untouched, old tip pinned', async () => {
    const fx = linear();
    writeFileSync(join(fx.repo, 'b.txt'), 'b staged\n');
    git(fx.repo, ['add', 'b.txt']);
    writeFileSync(join(fx.repo, 'a.txt'), 'a unstaged edit\n');
    writeFileSync(join(fx.repo, 'untracked.txt'), 'u\n');
    const before = snap(fx.repo);
    const s = await start(fx.repo);
    const res = await s.post('reword', { sha: fx.c4, expectHead: fx.c4, message: 'Four reworded\n\nwith a body' });
    okRes(res);
    const after = snap(fx.repo);
    expect(after.head).not.toBe(fx.c4);
    expect(treeOf(fx.repo, 'HEAD')).toBe(treeOf(fx.repo, fx.c4));
    expect(rev(fx.repo, 'HEAD^')).toBe(fx.c3);
    expect(message(fx.repo)).toBe('Four reworded\n\nwith a body');
    expect(authorInfo(fx.repo, 'HEAD')).toBe(authorInfo(fx.repo, fx.c4));
    expect(after.index).toBe(before.index);
    expect(after.files).toEqual(before.files);
    expect(git(fx.repo, ['branch', '--show-current']).trim()).toBe('main');
    expect(pinned(fx.repo, fx.c4)).toBe(true);
    expect((await s.undoState()).undo?.label).toMatch(/^reword '.+'$/);
  });

  it('an ancestor: every descendant is rebuilt with the same tree, author name, email and date; old tip pinned; others keep their messages', async () => {
    const fx = linear();
    const s = await start(fx.repo);
    okRes(await s.post('reword', { sha: fx.c2, expectHead: fx.c4, message: 'two reworded' }));
    expect(subjects(fx.repo)).toEqual(['four', 'three', 'two reworded', 'one', 'Base']);
    const [n4, n3, n2] = ['HEAD', 'HEAD~1', 'HEAD~2'];
    expect(treeOf(fx.repo, n4!)).toBe(treeOf(fx.repo, fx.c4));
    expect(treeOf(fx.repo, n3!)).toBe(treeOf(fx.repo, fx.c3));
    expect(treeOf(fx.repo, n2!)).toBe(treeOf(fx.repo, fx.c2));
    for (const [n, o] of [[n4, fx.c4], [n3, fx.c3], [n2, fx.c2]] as const) expect(authorLine(fx.repo, n!).equals(authorLine(fx.repo, o))).toBe(true);
    expect(rev(fx.repo, 'HEAD~3')).toBe(fx.c1); // below the target nothing was touched
    expect(pinned(fx.repo, fx.c4)).toBe(true);
    expect(tryGit(fx.repo, ['diff', '--quiet'])).toBe(0);
    expect(tryGit(fx.repo, ['diff', '--cached', '--quiet'])).toBe(0);
  });

  it('works on a dirty worktree without touching it (the tip tree is unchanged)', async () => {
    const fx = linear();
    writeFileSync(join(fx.repo, 'f2.txt'), 'dirty edit to a file the target added\n');
    const before = snap(fx.repo);
    const s = await start(fx.repo);
    okRes(await s.post('reword', { sha: fx.c2, expectHead: fx.c4, message: 'two reworded' }));
    expect(snap(fx.repo).files).toEqual(before.files);
    expect(snap(fx.repo).index).toBe(before.index);
  });

  it('refusals: empty, NUL, over 64 KB, stale expectHead, unknown / short / non-hex sha, detached HEAD; nothing changes', async () => {
    const fx = linear();
    const s = await start(fx.repo);
    const before = snap(fx.repo);
    const attempts: Array<[string, object]> = [
      ['empty message', { sha: fx.c3, expectHead: fx.c4, message: '' }],
      ['NUL in message', { sha: fx.c3, expectHead: fx.c4, message: 'bad\0message' }],
      ['65537 bytes', { sha: fx.c3, expectHead: fx.c4, message: 'x'.repeat(64 * 1024 + 1) }],
      ['stale expectHead', { sha: fx.c3, expectHead: fx.c3, message: 'x' }],
      ['unknown sha', { sha: 'f'.repeat(40), expectHead: fx.c4, message: 'x' }],
      ['short sha', { sha: fx.c3.slice(0, 7), expectHead: fx.c4, message: 'x' }],
      ['flag as sha', { sha: '--all', expectHead: fx.c4, message: 'x' }],
      ['ref name as sha', { sha: 'HEAD~1', expectHead: fx.c4, message: 'x' }],
      ['non-string message', { sha: fx.c3, expectHead: fx.c4, message: 7 }],
    ];
    for (const [name, body] of attempts) {
      const r = await s.post('reword', body);
      expect([400, 409], name).toContain(r.statusCode);
      expect(snap(fx.repo), name).toEqual(before);
    }
    // positive control: the same request shape with a good message does run
    okRes(await s.post('reword', { sha: fx.c3, expectHead: fx.c4, message: 'three reworded' }));
    // detached HEAD
    const fx2 = linear('rw-lin-detached');
    git(fx2.repo, ['switch', '--detach']);
    const s2 = await start(fx2.repo);
    const b2 = snap(fx2.repo);
    refused(await s2.post('reword', { sha: fx2.c4, expectHead: fx2.c4, message: 'x' }));
    expect(snap(fx2.repo)).toEqual(b2);
  });

  it('refuses a commit that is not on the first-parent line, and one with a merge between it and HEAD', async () => {
    const repo = newRepo('rw-merge');
    commit(repo, { 'a.txt': 'a\n' }, 'Base');
    const c1 = commit(repo, { 'f1.txt': '1\n' }, 'one');
    git(repo, ['switch', '-c', 'side']);
    const s1 = commit(repo, { 'side.txt': 's\n' }, 'side one');
    git(repo, ['switch', 'main']);
    const c2 = commit(repo, { 'f2.txt': '2\n' }, 'two');
    clock += 100;
    git(repo, ['merge', '--no-ff', '-m', 'Merge side', 'side']);
    const tip = head(repo);
    const s = await start(repo);
    const before = snap(repo);
    refused(await s.post('reword', { sha: s1, expectHead: tip, message: 'x' })); // reachable only through the merge's second parent
    refused(await s.post('reword', { sha: c1, expectHead: tip, message: 'x' })); // a merge lies between c1 and HEAD
    refused(await s.post('reword', { sha: c2, expectHead: tip, message: 'x' }));
    expect(snap(repo)).toEqual(before);
  });

  it('refuses a commit with an encoding header (target or descendant) and leaves everything unchanged', async () => {
    const fx = linear();
    const tree = treeOf(fx.repo, 'HEAD');
    const enc = rawCommit(fx.repo, { tree, parents: [fx.c4], author: 'Latin Author <latin@example.com> 1700000000 +0000', headers: ['encoding ISO-8859-1'], message: 'latin one\n' });
    git(fx.repo, ['update-ref', 'refs/heads/main', enc, fx.c4]);
    const s = await start(fx.repo);
    const before = snap(fx.repo);
    refused(await s.post('reword', { sha: enc, expectHead: enc, message: 'x' }));
    refused(await s.post('reword', { sha: fx.c3, expectHead: enc, message: 'x' })); // the encoded commit is a descendant that would be rebuilt
    expect(snap(fx.repo)).toEqual(before);
    // positive control: below the encoded commit is not possible either (it is a descendant), so a clean repo of the same shape does work
    const ok = linear('rw-lin-enc-ok');
    okRes(await (await start(ok.repo)).post('reword', { sha: ok.c3, expectHead: ok.c4, message: 'x' }));
  });

  it('non-ASCII author: name, email and date of the target and every descendant stay byte-identical (UTF-8, non-trivial timezone)', async () => {
    const repo = newRepo('rw-utf8');
    const base = commit(repo, { 'a.txt': 'a\n' }, 'Base');
    const n1 = commit(repo, { 'f1.txt': '1\n' }, 'one');
    const n2 = commit(repo, { 'f2.txt': '2\n' }, 'two');
    const author = 'Zoë Müller 日本語 <zoe.müller@example.com> 1700000000 +0530';
    const x = rawCommit(repo, { tree: treeOf(repo, n1), parents: [base], author, message: 'one by Zoe\n' });
    const y = rawCommit(repo, { tree: treeOf(repo, n2), parents: [x], author, message: 'two by Zoe\n' });
    git(repo, ['update-ref', 'refs/heads/main', y, n2]);
    expect(tryGit(repo, ['diff', '--quiet'])).toBe(0);
    const s = await start(repo);
    okRes(await s.post('reword', { sha: x, expectHead: y, message: 'one by Zoe, reworded' }));
    expect(authorLine(repo, 'HEAD~1').equals(authorLine(repo, x))).toBe(true);
    expect(authorLine(repo, 'HEAD').equals(authorLine(repo, y))).toBe(true);
    expect(authorLine(repo, 'HEAD').toString('utf8')).toContain('Zoë Müller 日本語 <zoe.müller@example.com> 1700000000 +0530');
    expect(message(repo, 'HEAD~1')).toBe('one by Zoe, reworded');
    expect(treeOf(repo, 'HEAD')).toBe(treeOf(repo, y));
  });

  it('an author name or email holding < or > is refused (not mangled), for the target and for a descendant', async () => {
    const fx = linear();
    const tree = treeOf(fx.repo, 'HEAD');
    const evil = rawCommit(fx.repo, { tree, parents: [fx.c4], author: 'Evil <Name> <evil@example.com> 1700000000 +0000', message: 'evil\n' });
    git(fx.repo, ['update-ref', 'refs/heads/main', evil, fx.c4]);
    const s = await start(fx.repo);
    const before = snap(fx.repo);
    refused(await s.post('reword', { sha: evil, expectHead: evil, message: 'x' }));
    refused(await s.post('reword', { sha: fx.c3, expectHead: evil, message: 'x' }));
    expect(snap(fx.repo)).toEqual(before);
    expect(authorLine(fx.repo, 'HEAD').toString('utf8')).toContain('Evil <Name> <evil@example.com>'); // still exactly as written
  });

  it('caps: more than 500 descendants to rebuild is refused with the number 500, nothing changes', async () => {
    const big = sharedBig();
    const s = await start(big.repo);
    const before = snap(big.repo);
    const r = await s.post('reword', { sha: big.shas[1]!, expectHead: big.shas[big.shas.length - 1]!, message: 'x' }); // 502 descendants
    refused(r);
    expect(r.body).toMatch(/500/);
    expect(snap(big.repo)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('squash', () => {
  it('3 consecutive commits become one: tree of the newest, messages joined oldest first by blank lines, descendant rebuilt, old tip pinned, undo/redo are CAS only', async () => {
    const fx = linear();
    writeFileSync(join(fx.repo, 'a.txt'), 'dirty tracked edit\n');
    const before = snap(fx.repo);
    const s = await start(fx.repo);
    okRes(await s.post('squash', { shas: [fx.c1, fx.c2, fx.c3], expectHead: fx.c4 }));
    expect(subjects(fx.repo)).toEqual(['four', 'one', 'Base']);
    expect(message(fx.repo, 'HEAD~1')).toBe('one\n\ntwo\n\nthree');
    expect(treeOf(fx.repo, 'HEAD~1')).toBe(treeOf(fx.repo, fx.c3));
    expect(treeOf(fx.repo, 'HEAD')).toBe(treeOf(fx.repo, fx.c4));
    expect(authorLine(fx.repo, 'HEAD').equals(authorLine(fx.repo, fx.c4))).toBe(true);
    expect(pinned(fx.repo, fx.c4)).toBe(true);
    const after = snap(fx.repo);
    expect(after.files).toEqual(before.files); // dirty edit and everything else untouched
    expect(after.index).toBe(before.index);
    const newTip = head(fx.repo);
    expect((await s.undoState()).undo?.label).toBe('squash 3 commits');
    okRes(await s.post('undo'));
    expect(head(fx.repo)).toBe(fx.c4);
    expect(snap(fx.repo).files).toEqual(before.files);
    okRes(await s.post('redo'));
    expect(head(fx.repo)).toBe(newTip);
  });

  it('the shas may come in any order; the oldest..youngest range is what is squashed', async () => {
    const fx = linear();
    const s = await start(fx.repo);
    okRes(await s.post('squash', { shas: [fx.c3, fx.c2], expectHead: fx.c4 }));
    expect(subjects(fx.repo)).toEqual(['four', 'two', 'one', 'Base']);
    expect(message(fx.repo, 'HEAD~1')).toBe('two\n\nthree');
  });

  it('refusals leave everything unchanged: one sha, a gap, a duplicate, stale head, unknown / short sha, HEAD detached, merge inside the range', async () => {
    const fx = linear();
    const s = await start(fx.repo);
    const before = snap(fx.repo);
    const attempts: Array<[string, object]> = [
      ['one sha', { shas: [fx.c2], expectHead: fx.c4 }],
      ['empty', { shas: [], expectHead: fx.c4 }],
      ['gap', { shas: [fx.c1, fx.c3], expectHead: fx.c4 }],
      ['duplicate', { shas: [fx.c2, fx.c2], expectHead: fx.c4 }],
      ['stale head', { shas: [fx.c1, fx.c2], expectHead: fx.c3 }],
      ['unknown sha', { shas: [fx.c1, 'f'.repeat(40)], expectHead: fx.c4 }],
      ['short sha', { shas: [fx.c1.slice(0, 7), fx.c2.slice(0, 7)], expectHead: fx.c4 }],
      ['not an array', { shas: fx.c1, expectHead: fx.c4 }],
    ];
    for (const [name, body] of attempts) {
      const r = await s.post('squash', body);
      expect([400, 409], name).toContain(r.statusCode);
      expect(snap(fx.repo), name).toEqual(before);
    }
    okRes(await s.post('squash', { shas: [fx.c1, fx.c2], expectHead: fx.c4 })); // positive control
    const repo = newRepo('rw-squash-merge');
    commit(repo, { 'a.txt': 'a\n' }, 'Base');
    const m1 = commit(repo, { 'f1.txt': '1\n' }, 'one');
    git(repo, ['switch', '-c', 'side']);
    commit(repo, { 'side.txt': 's\n' }, 'side');
    git(repo, ['switch', 'main']);
    const m2 = commit(repo, { 'f2.txt': '2\n' }, 'two');
    clock += 100;
    git(repo, ['merge', '--no-ff', '-m', 'Merge side', 'side']);
    const tip = head(repo);
    const sm = await start(repo);
    const b = snap(repo);
    refused(await sm.post('squash', { shas: [m1, m2, tip], expectHead: tip }));
    expect(snap(repo)).toEqual(b);
  });

  it('caps: 501 shas are refused with the number 500', async () => {
    const big = sharedBig();
    const s = await start(big.repo);
    const before = snap(big.repo);
    const r = await s.post('squash', { shas: big.shas.slice(1, 502), expectHead: big.shas[big.shas.length - 1]! });
    refused(r);
    expect(r.body).toMatch(/500/);
    expect(snap(big.repo)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('interactive rebase: plan', () => {
  it('mode=children lists the commits above the target, newest first, with the branch', async () => {
    const fx = linear();
    const s = await start(fx.repo);
    const r = await s.get(`rebase/interactive/plan?mode=children&target=${fx.c1}`);
    okRes(r);
    const j = r.json() as { branch: string; ontoLabel: string; commits: Array<{ sha: string; subject: string }> };
    expect(j.branch).toBe('main');
    expect(j.commits.map((c) => c.sha)).toEqual([fx.c4, fx.c3, fx.c2]);
    expect(j.commits.map((c) => c.subject)).toEqual(['four', 'three', 'two']);
    expect(typeof j.ontoLabel).toBe('string');
    expect(j.ontoLabel.length).toBeGreaterThan(0);
  });

  it('mode=onto with a branch name', async () => {
    const fx = linear();
    git(fx.repo, ['branch', 'base-branch', fx.base]);
    const s = await start(fx.repo);
    const r = await s.get('rebase/interactive/plan?mode=onto&target=base-branch');
    okRes(r);
    expect((r.json() as { commits: Array<{ sha: string }> }).commits.map((c) => c.sha)).toEqual([fx.c4, fx.c3, fx.c2, fx.c1]);
  });

  it('refuses a merge in the range, a bad target, a bad mode, detached HEAD and more than 500 commits', async () => {
    const repo = newRepo('rw-plan-merge');
    const base = commit(repo, { 'a.txt': 'a\n' }, 'Base');
    git(repo, ['switch', '-c', 'side']);
    commit(repo, { 'side.txt': 's\n' }, 'side');
    git(repo, ['switch', 'main']);
    commit(repo, { 'f2.txt': '2\n' }, 'two');
    clock += 100;
    git(repo, ['merge', '--no-ff', '-m', 'Merge side', 'side']);
    const s = await start(repo);
    refused(await s.get(`rebase/interactive/plan?mode=children&target=${base}`) as unknown as Res);
    const fx = linear('rw-plan-bad');
    const s2 = await start(fx.repo);
    for (const q of ['mode=children&target=HEAD~1', 'mode=children&target=--all', `mode=children&target=${fx.c1.slice(0, 7)}`, `mode=children&target=${'f'.repeat(40)}`, 'mode=bogus&target=' + fx.c1, 'mode=onto&target=no-such-branch', 'mode=children']) {
      refused((await s2.get(`rebase/interactive/plan?${q}`)) as unknown as Res);
    }
    const big = sharedBig();
    const sb = await start(big.repo);
    const r = await sb.get(`rebase/interactive/plan?mode=children&target=${big.shas[0]!}`); // 502 commits
    refused(r as unknown as Res);
    expect(r.body).toMatch(/500/);
    const det = linear('rw-plan-detached');
    git(det.repo, ['switch', '--detach']);
    refused((await (await start(det.repo)).get(`rebase/interactive/plan?mode=children&target=${det.c1}`)) as unknown as Res);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('interactive rebase: run', () => {
  it('pick, reword, squash and drop in one go: history, messages, trees, authors, pins, auto-stash of a dirty file, journal and undo/redo', async () => {
    const fx = linear();
    writeFileSync(join(fx.repo, 'b.txt'), 'dirty b\n');
    const s = await start(fx.repo);
    const r = await s.post('rebase/interactive', {
      upstream: fx.base,
      onto: fx.base,
      expectHead: fx.c4,
      steps: [step(fx.c1, 'pick'), step(fx.c2, 'squash'), step(fx.c3, 'drop'), step(fx.c4, 'reword', 'Four reworded\n\nbody text')],
    });
    okRes(r);
    expect(outcome(r)).toBe('done');
    expect(rebasing(fx.repo)).toBe(false);
    expect(subjects(fx.repo)).toEqual(['Four reworded', 'one', 'Base']);
    expect(message(fx.repo, 'HEAD')).toBe('Four reworded\n\nbody text');
    expect(message(fx.repo, 'HEAD~1')).toBe('one\n\ntwo');
    expect(git(fx.repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean)).toEqual(['a.txt', 'b.txt', 'f1.txt', 'f2.txt', 'f4.txt']);
    expect(authorInfo(fx.repo, 'HEAD').split('|')[0]).toBe('Fourth Author');
    expect(authorInfo(fx.repo, 'HEAD~1').split('|')[0]).toBe('First Author');
    expect(pinned(fx.repo, fx.c4)).toBe(true);
    // phase 6 auto-stash rules: the dirty tracked edit is stashed (never popped)
    expect(stashes(fx.repo).some((m) => /Auto stash before rebase of "main"/.test(m))).toBe(true);
    expect(text(fx.repo, 'b.txt')).toBe('b\n');
    expect((await s.undoState()).undo?.label).toBe("rebase 'main'");
    const newTip = head(fx.repo);
    okRes(await s.post('undo'));
    expect(head(fx.repo)).toBe(fx.c4); // different tree -> reset --keep, worktree was clean after the auto-stash
    expect(existsSync(join(fx.repo, 'f3.txt'))).toBe(true);
    expect(pinned(fx.repo, newTip)).toBe(true); // the tip is pinned before undo moves it
    okRes(await s.post('redo'));
    expect(head(fx.repo)).toBe(newTip);
  });

  it('reorder: the commits come out in the new order with their own trees and authors', async () => {
    const fx = linear();
    const s = await start(fx.repo);
    okRes(await s.post('rebase/interactive', { upstream: fx.base, onto: fx.base, expectHead: fx.c4, steps: picks(fx.c2, fx.c1, fx.c3, fx.c4) }));
    expect(subjects(fx.repo)).toEqual(['four', 'three', 'one', 'two', 'Base']);
    expect(authorInfo(fx.repo, 'HEAD~2').split('|')[0]).toBe('First Author');
    expect(treeOf(fx.repo, 'HEAD')).toBe(treeOf(fx.repo, fx.c4));
  });

  it('drop and move presets are the same call: dropping the newest commit, and children mode (upstream = onto = the target)', async () => {
    const fx = linear();
    const s = await start(fx.repo);
    okRes(await s.post('rebase/interactive', { upstream: fx.c2, onto: fx.c2, expectHead: fx.c4, steps: [step(fx.c3, 'pick'), step(fx.c4, 'drop')] }));
    expect(subjects(fx.repo)).toEqual(['three', 'two', 'one', 'Base']);
  });

  it('a conflict while dropping: outcome conflict, rebase in progress, nothing journaled yet; Continue ends it and journals ONE entry; undo and redo work', async () => {
    const fx = conflictRepo();
    const s = await start(fx.repo);
    const r = await s.post('rebase/interactive', { upstream: fx.base, onto: fx.base, expectHead: fx.c4, steps: [step(fx.c1, 'pick'), step(fx.c2, 'drop'), step(fx.c3, 'pick'), step(fx.c4, 'pick')] });
    okRes(r);
    expect(outcome(r)).toBe('conflict');
    expect(rebasing(fx.repo)).toBe(true);
    expect((await readOpState(fx.repo))?.kind).toBe('rebase');
    expect((await s.undoState()).undo).toBeNull(); // pending entry is in memory only
    writeFileSync(join(fx.repo, 's.txt'), 'resolved\n');
    git(fx.repo, ['add', 's.txt']);
    const c = await s.post('rebase/continue', {});
    okRes(c);
    expect(outcome(c)).toBe('done');
    expect(rebasing(fx.repo)).toBe(false);
    expect(subjects(fx.repo)).toEqual(['four', 'three', 'one', 'Base']);
    expect(text(fx.repo, 's.txt')).toBe('resolved\n');
    expect((await s.undoState()).undo?.label).toBe("rebase 'main'");
    const newTip = head(fx.repo);
    okRes(await s.post('undo'));
    expect(head(fx.repo)).toBe(fx.c4);
    expect(text(fx.repo, 's.txt')).toBe('three\n');
    okRes(await s.post('redo'));
    expect(head(fx.repo)).toBe(newTip);
  });

  it('Abort after a conflict: HEAD is back, and NO journal entry was written', async () => {
    const fx = conflictRepo();
    const s = await start(fx.repo);
    const r = await s.post('rebase/interactive', { upstream: fx.base, onto: fx.base, expectHead: fx.c4, steps: [step(fx.c1, 'pick'), step(fx.c2, 'drop'), step(fx.c3, 'pick'), step(fx.c4, 'pick')] });
    expect(outcome(r)).toBe('conflict');
    okRes(await s.post('rebase/abort'));
    expect(rebasing(fx.repo)).toBe(false);
    expect(head(fx.repo)).toBe(fx.c4);
    expect(await s.undoState()).toEqual({ undo: null, redo: null });
  });

  it('a conflict on a FIXUP step keeps the squash: Continue (plain --continue) ends with one combined commit', async () => {
    const repo = newRepo('rw-fixup');
    const base = commit(repo, { 's.txt': 'x\n' }, 'Base');
    const c1 = commit(repo, { 's.txt': 'a\n' }, 'one');
    const c2 = commit(repo, { 't.txt': 't\n' }, 'two');
    const c3 = commit(repo, { 's.txt': 'b\n' }, 'three');
    const s = await start(repo);
    // drop one, pick two, squash three into two: three's change (a -> b) conflicts with s.txt = x
    const r = await s.post('rebase/interactive', { upstream: base, onto: base, expectHead: c3, steps: [step(c1, 'drop'), step(c2, 'pick'), step(c3, 'squash')] });
    okRes(r);
    expect(outcome(r)).toBe('conflict');
    writeFileSync(join(repo, 's.txt'), 'resolved\n');
    git(repo, ['add', 's.txt']);
    const c = await s.post('rebase/continue', {});
    okRes(c);
    expect(outcome(c)).toBe('done');
    expect(rebasing(repo)).toBe(false);
    expect(subjects(repo)).toEqual(['two', 'Base']); // one commit, not two: the squash was kept
    expect(text(repo, 's.txt')).toBe('resolved\n');
    expect(text(repo, 't.txt')).toBe('t\n');
  });

  it('user config rebase.updateRefs, rebase.autoSquash and sequence.editor is ignored', async () => {
    const fx = linear('rw-cfg');
    const c5 = commit(fx.repo, { 'f5.txt': '5\n' }, 'fixup! one');
    git(fx.repo, ['branch', 'side', c5]);
    git(fx.repo, ['config', 'rebase.updateRefs', 'true']);
    git(fx.repo, ['config', 'rebase.autoSquash', 'true']);
    git(fx.repo, ['config', 'sequence.editor', 'false']);
    const s = await start(fx.repo);
    const r = await s.post('rebase/interactive', { upstream: fx.base, onto: fx.base, expectHead: c5, steps: [step(fx.c1, 'pick'), step(fx.c2, 'drop'), step(fx.c3, 'pick'), step(fx.c4, 'pick'), step(c5, 'pick')] });
    okRes(r);
    expect(outcome(r)).toBe('done');
    expect(subjects(fx.repo)).toEqual(['fixup! one', 'four', 'three', 'one', 'Base']); // the fixup! commit was NOT folded into 'one'
    expect(rev(fx.repo, 'side')).toBe(c5); // the other branch was NOT moved by update-refs
  });

  it('the todo file is server-owned: one random name of at least 128 bits under <dataDir>/rebase-todo exists while git runs (pre-rebase hook looks)', async () => {
    const fx = linear('rw-todo');
    const s = await start(fx.repo);
    const listing = join(fx.repo, '.git', 'todo-names.txt');
    const dir = join(s.dataDir, 'rebase-todo').replace(/\\/g, '/');
    mkdirSync(join(fx.repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(fx.repo, '.git', 'hooks', 'pre-rebase'), `#!/bin/sh\nls -1 "${dir}" > "${listing.replace(/\\/g, '/')}"\nexit 0\n`, { mode: 0o755 });
    okRes(await s.post('rebase/interactive', { upstream: fx.base, onto: fx.base, expectHead: fx.c4, steps: [step(fx.c1, 'drop'), ...picks(fx.c2, fx.c3, fx.c4)] }));
    // UNVERIFIED: this assumes the todo is written before `git rebase` starts (its path is inside GIT_SEQUENCE_EDITOR), so the pre-rebase hook can see it.
    const names = readFileSync(listing, 'utf8').split('\n').filter(Boolean);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[A-Za-z0-9_-]{22,}\.todo$/);
  });

  it('refusals leave everything unchanged: not a permutation, squash as the oldest row, bad action, stale head, detached, caps', async () => {
    const fx = linear();
    const s = await start(fx.repo);
    const before = snap(fx.repo);
    const base = { upstream: fx.base, onto: fx.base, expectHead: fx.c4 };
    const sideSha = fx.base; // a real commit that is not in the plan set
    const attempts: Array<[string, object]> = [
      ['missing a commit', { ...base, steps: picks(fx.c1, fx.c2, fx.c3) }],
      ['extra commit outside the plan', { ...base, steps: picks(fx.c1, fx.c2, fx.c3, fx.c4, sideSha) }],
      ['duplicate', { ...base, steps: picks(fx.c1, fx.c2, fx.c3, fx.c3) }],
      ['unknown sha', { ...base, steps: picks(fx.c1, fx.c2, fx.c3, 'f'.repeat(40)) }],
      ['squash as the oldest row', { ...base, steps: [step(fx.c1, 'squash'), ...picks(fx.c2, fx.c3, fx.c4)] }],
      ['unknown action', { ...base, steps: [{ sha: fx.c1, action: 'exec' }, ...picks(fx.c2, fx.c3, fx.c4)] }],
      ['fixup is not an action', { ...base, steps: [{ sha: fx.c1, action: 'fixup' }, ...picks(fx.c2, fx.c3, fx.c4)] }],
      ['stale expectHead', { ...base, expectHead: fx.c3, steps: picks(fx.c1, fx.c2, fx.c3, fx.c4) }],
      ['reword without a message', { ...base, steps: [{ sha: fx.c1, action: 'reword' }, ...picks(fx.c2, fx.c3, fx.c4)] }],
      ['reword with an empty message', { ...base, steps: [step(fx.c1, 'reword', ''), ...picks(fx.c2, fx.c3, fx.c4)] }],
      ['steps not an array', { ...base, steps: 'pick' }],
    ];
    for (const [name, body] of attempts) {
      const r = await s.post('rebase/interactive', body);
      expect([400, 409], name).toContain(r.statusCode);
      expect(snap(fx.repo), name).toEqual(before);
      expect(rebasing(fx.repo), name).toBe(false);
    }
    // positive control: the same shape with the right plan runs (the refusals above are not a dead route)
    okRes(await s.post('rebase/interactive', { ...base, steps: [step(fx.c1, 'pick'), step(fx.c2, 'drop'), step(fx.c3, 'pick'), step(fx.c4, 'pick')] }));
    const det = linear('rw-ir-detached');
    git(det.repo, ['switch', '--detach']);
    const sd = await start(det.repo);
    const bd = snap(det.repo);
    refused(await sd.post('rebase/interactive', { upstream: det.base, onto: det.base, expectHead: det.c4, steps: picks(det.c1, det.c2, det.c3, det.c4) }));
    expect(snap(det.repo)).toEqual(bd);
  });

  it('a merge commit inside the plan range is refused', async () => {
    const repo = newRepo('rw-ir-merge');
    const base = commit(repo, { 'a.txt': 'a\n' }, 'Base');
    git(repo, ['switch', '-c', 'side']);
    commit(repo, { 'side.txt': 's\n' }, 'side');
    git(repo, ['switch', 'main']);
    const m1 = commit(repo, { 'f2.txt': '2\n' }, 'two');
    clock += 100;
    git(repo, ['merge', '--no-ff', '-m', 'Merge side', 'side']);
    const tip = head(repo);
    const s = await start(repo);
    const before = snap(repo);
    refused(await s.post('rebase/interactive', { upstream: base, onto: base, expectHead: tip, steps: picks(m1, tip) }));
    expect(snap(repo)).toEqual(before);
    expect(rebasing(repo)).toBe(false);
  });

  it('upstream and onto: only a full commit sha or an existing branch is accepted; everything else is refused with nothing started', async () => {
    const fx = linear();
    git(fx.repo, ['branch', 'base-branch', fx.base]);
    const treeSha = treeOf(fx.repo, fx.base);
    const bad = ['--upload-pack=x', '--onto', '-x', 'HEAD', 'HEAD~1', 'main^', fx.base.slice(0, 7), 'f'.repeat(40), treeSha, 'no-such-branch', '', 'base-branch ', 'refs/heads/../x', 'a\nb'];
    const s = await start(fx.repo);
    const before = snap(fx.repo);
    const steps = picks(fx.c1, fx.c2, fx.c3, fx.c4);
    for (const x of bad) {
      for (const [name, body] of [
        ['upstream', { upstream: x, onto: fx.base, expectHead: fx.c4, steps }],
        ['onto', { upstream: fx.base, onto: x, expectHead: fx.c4, steps }],
      ] as const) {
        const r = await s.post('rebase/interactive', body);
        expect([400, 409], `${name}=${JSON.stringify(x)}`).toContain(r.statusCode);
        expect(snap(fx.repo), `${name}=${JSON.stringify(x)}`).toEqual(before);
        expect(rebasing(fx.repo)).toBe(false);
      }
    }
    for (const bodyUp of [fx.base, 'base-branch']) {
      // positive control: a full sha and an existing branch are accepted for upstream
      const again = linear('rw-ir-ok');
      git(again.repo, ['branch', 'base-branch', again.base]);
      const s2 = await start(again.repo);
      const up = bodyUp === 'base-branch' ? 'base-branch' : again.base;
      okRes(await s2.post('rebase/interactive', { upstream: up, onto: again.base, expectHead: again.c4, steps: [step(again.c1, 'drop'), ...picks(again.c2, again.c3, again.c4)] }));
    }
  });

  it('caps: a plan over 500 commits is refused with the number 500', async () => {
    const big = sharedBig();
    const s = await start(big.repo);
    const before = snap(big.repo);
    const r = await s.post('rebase/interactive', { upstream: big.shas[0]!, onto: big.shas[0]!, expectHead: big.shas[big.shas.length - 1]!, steps: picks(...big.shas.slice(1)) });
    refused(r);
    expect(r.body).toMatch(/500/);
    expect(snap(big.repo)).toEqual(before);
    expect(rebasing(big.repo)).toBe(false);
  });

  // UNVERIFIED / not drivable: the 10 minute `rebase -i` timeout (audit security item 3). It is a constant in the server, there is no config or env knob,
  // so no test can make git run for 10 minutes. The builder should expose the timeout as a parameter if a test of "a timeout leaves the rebase in
  // progress and reports in-progress, not failure" is wanted. Not written.
});

// ---------------------------------------------------------------------------------------------------------------------
describe('multi cherry-pick', () => {
  /** main: Base, M1 (m.txt); feature (from Base): F1 (f1.txt, First Author), F2 (f2.txt, Second Author), F3 (s.txt). */
  function pickRepo(): { repo: string; base: string; m1: string; f1: string; f2: string; f3: string } {
    const repo = newRepo('rw-pick');
    const base = commit(repo, { 'a.txt': 'a\n', 's.txt': 'base\n' }, 'Base');
    git(repo, ['switch', '-c', 'feature']);
    const f1 = commit(repo, { 'f1.txt': '1\n' }, 'feat one', 'First Author');
    const f2 = commit(repo, { 'f2.txt': '2\n' }, 'feat two', 'Second Author');
    const f3 = commit(repo, { 's.txt': 'feature\n' }, 'feat three');
    git(repo, ['switch', 'main']);
    const m1 = commit(repo, { 'm.txt': 'm\n', 's.txt': 'main\n' }, 'main one');
    return { repo, base, m1, f1, f2, f3 };
  }

  it('two commits onto an empty rebase range (git runs the injected todo): messages and authors kept, in the given order, journal and undo/redo', async () => {
    const fx = pickRepo();
    const s = await start(fx.repo);
    const r = await s.post('cherry-pick/multi', { shas: [fx.f1, fx.f2], expectHead: fx.m1 });
    okRes(r);
    expect(outcome(r)).toBe('done');
    expect(subjects(fx.repo)).toEqual(['feat two', 'feat one', 'main one', 'Base']);
    expect(authorInfo(fx.repo, 'HEAD').split('|')[0]).toBe('Second Author');
    expect(authorInfo(fx.repo, 'HEAD~1').split('|')[0]).toBe('First Author');
    expect(text(fx.repo, 'f1.txt')).toBe('1\n');
    expect(text(fx.repo, 'f2.txt')).toBe('2\n');
    expect(rebasing(fx.repo)).toBe(false);
    expect(pinned(fx.repo, fx.m1)).toBe(true);
    expect((await s.undoState()).undo?.label).toBe('cherry pick 2 commits');
    const tip = head(fx.repo);
    okRes(await s.post('undo'));
    expect(head(fx.repo)).toBe(fx.m1);
    expect(existsSync(join(fx.repo, 'f1.txt'))).toBe(false);
    okRes(await s.post('redo'));
    expect(head(fx.repo)).toBe(tip);
  });

  it('a conflict uses the rebase state: Abort restores HEAD with no journal entry; Continue finishes and journals', async () => {
    const fx = pickRepo();
    const s = await start(fx.repo);
    const r = await s.post('cherry-pick/multi', { shas: [fx.f1, fx.f3], expectHead: fx.m1 });
    okRes(r);
    expect(outcome(r)).toBe('conflict');
    expect(rebasing(fx.repo)).toBe(true);
    expect((await readOpState(fx.repo))?.kind).toBe('rebase');
    okRes(await s.post('rebase/abort'));
    expect(head(fx.repo)).toBe(fx.m1);
    expect(await s.undoState()).toEqual({ undo: null, redo: null });
    const again = await s.post('cherry-pick/multi', { shas: [fx.f1, fx.f3], expectHead: fx.m1 });
    expect(outcome(again)).toBe('conflict');
    writeFileSync(join(fx.repo, 's.txt'), 'both\n');
    git(fx.repo, ['add', 's.txt']);
    const c = await s.post('rebase/continue', {});
    okRes(c);
    expect(subjects(fx.repo)).toEqual(['feat three', 'feat one', 'main one', 'Base']);
    expect((await s.undoState()).undo?.label).toBe('cherry pick 2 commits');
  });

  it('refusals: merge commit, stale head, detached, bad / short / non-commit / flag shas, empty list; nothing changes', async () => {
    const fx = pickRepo();
    git(fx.repo, ['switch', '-c', 'mergeside', fx.base]);
    commit(fx.repo, { 'side.txt': 's\n' }, 'side');
    clock += 100;
    git(fx.repo, ['merge', '--no-ff', '-m', 'Merge feature', 'feature']);
    const merge = head(fx.repo);
    git(fx.repo, ['switch', 'main']);
    const s = await start(fx.repo);
    const before = snap(fx.repo);
    const tree = treeOf(fx.repo, fx.f1);
    const attempts: Array<[string, object]> = [
      ['merge commit', { shas: [fx.f1, merge], expectHead: fx.m1 }],
      ['stale head', { shas: [fx.f1, fx.f2], expectHead: fx.base }],
      ['HEAD as a sha', { shas: ['HEAD', fx.f2], expectHead: fx.m1 }],
      ['ref name', { shas: ['feature', fx.f2], expectHead: fx.m1 }],
      ['short sha', { shas: [fx.f1.slice(0, 7), fx.f2], expectHead: fx.m1 }],
      ['tree sha', { shas: [tree, fx.f2], expectHead: fx.m1 }],
      ['unknown sha', { shas: ['f'.repeat(40), fx.f2], expectHead: fx.m1 }],
      ['flag', { shas: ['--all', fx.f2], expectHead: fx.m1 }],
      ['empty', { shas: [], expectHead: fx.m1 }],
      ['not an array', { shas: fx.f1, expectHead: fx.m1 }],
    ];
    for (const [name, body] of attempts) {
      const r = await s.post('cherry-pick/multi', body);
      expect([400, 409], name).toContain(r.statusCode);
      expect(snap(fx.repo), name).toEqual(before);
      expect(rebasing(fx.repo), name).toBe(false);
    }
    okRes(await s.post('cherry-pick/multi', { shas: [fx.f1, fx.f2], expectHead: fx.m1 })); // positive control
    const det = pickRepo();
    git(det.repo, ['switch', '--detach']);
    const sd = await start(det.repo);
    const bd = snap(det.repo);
    refused(await sd.post('cherry-pick/multi', { shas: [det.f1, det.f2], expectHead: det.m1 }));
    expect(snap(det.repo)).toEqual(bd);
  });

  it('caps: 501 shas are refused with the number 500', async () => {
    const big = sharedBig();
    git(big.repo, ['switch', '-c', 'target', big.shas[0]!]);
    try {
      const s = await start(big.repo);
      const before = snap(big.repo);
      const r = await s.post('cherry-pick/multi', { shas: big.shas.slice(1, 502), expectHead: big.shas[0]! });
      refused(r);
      expect(r.body).toMatch(/500/);
      expect(snap(big.repo)).toEqual(before);
    } finally {
      git(big.repo, ['switch', 'big']); // the fixture is shared: leave it as it was found
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('rewrite undo journal', () => {
  it('reword HEAD on a dirty tree: undo and redo are update-ref only; index and worktree bytes never change', async () => {
    const fx = linear();
    writeFileSync(join(fx.repo, 'b.txt'), 'b staged\n');
    git(fx.repo, ['add', 'b.txt']);
    writeFileSync(join(fx.repo, 'a.txt'), 'a unstaged\n');
    const s = await start(fx.repo);
    const before = snap(fx.repo);
    okRes(await s.post('reword', { sha: fx.c4, expectHead: fx.c4, message: 'four reworded' }));
    const newTip = head(fx.repo);
    okRes(await s.post('undo'));
    expect(head(fx.repo)).toBe(fx.c4);
    expect(snap(fx.repo)).toEqual(before);
    expect((await s.undoState()).redo?.label).toMatch(/^reword '.+'$/);
    okRes(await s.post('redo'));
    expect(head(fx.repo)).toBe(newTip);
    expect(snap(fx.repo).files).toEqual(before.files);
    expect(snap(fx.repo).index).toBe(before.index);
  });

  it('undo is refused when the branch moved on outside GitSlappin (compare-and-swap), nothing changes', async () => {
    const fx = linear();
    const s = await start(fx.repo);
    okRes(await s.post('reword', { sha: fx.c4, expectHead: fx.c4, message: 'four reworded' }));
    commit(fx.repo, { 'outside.txt': 'o\n' }, 'made outside');
    const before = snap(fx.repo);
    const r = await s.post('undo');
    expect(r.statusCode).toBe(409);
    expect(snap(fx.repo)).toEqual(before);
  });

  /** After dropping `two` (f2.txt) the tree differs from the old tip, so undo needs reset --keep. */
  async function afterDrop(): Promise<{ fx: Lin; s: Awaited<ReturnType<typeof start>>; oldTip: string; newTip: string }> {
    const fx = linear('rw-undo');
    const s = await start(fx.repo);
    okRes(await s.post('rebase/interactive', { upstream: fx.base, onto: fx.base, expectHead: fx.c4, steps: [step(fx.c1, 'pick'), step(fx.c2, 'drop'), step(fx.c3, 'pick'), step(fx.c4, 'pick')] }));
    expect(existsSync(join(fx.repo, 'f2.txt'))).toBe(false);
    return { fx, s, oldTip: fx.c4, newTip: head(fx.repo) };
  }

  it('a different-tree undo on a clean tree: reset --keep to the old tip, the pre-undo tip is pinned, redo goes back', async () => {
    const { fx, s, oldTip, newTip } = await afterDrop();
    okRes(await s.post('undo'));
    expect(head(fx.repo)).toBe(oldTip);
    expect(text(fx.repo, 'f2.txt')).toBe('2\n');
    expect(pinned(fx.repo, newTip)).toBe(true);
    expect(tryGit(fx.repo, ['diff', '--quiet', 'HEAD'])).toBe(0);
    okRes(await s.post('redo'));
    expect(head(fx.repo)).toBe(newTip);
    expect(existsSync(join(fx.repo, 'f2.txt'))).toBe(false);
  });

  it('refused (409, nothing changes, the file is never overwritten) when an UNTRACKED file sits where the undo would write', async () => {
    const { fx, s, newTip } = await afterDrop();
    writeFileSync(join(fx.repo, 'f2.txt'), 'my own untracked work\n');
    const before = snap(fx.repo);
    const r = await s.post('undo');
    expect(r.statusCode).toBe(409);
    expect(head(fx.repo)).toBe(newTip);
    expect(text(fx.repo, 'f2.txt')).toBe('my own untracked work\n');
    expect(snap(fx.repo)).toEqual(before);
    expect(stashes(fx.repo)).toEqual([]); // never snapshot-and-proceed
    expect((await s.undoState()).undo?.label).toBe("rebase 'main'"); // the entry is still there
  });

  it('refused (409, nothing changes) when an IGNORED file sits where the undo would write', async () => {
    const { fx, s, newTip } = await afterDrop();
    writeFileSync(join(fx.repo, '.git', 'info', 'exclude'), 'f2.txt\n');
    writeFileSync(join(fx.repo, 'f2.txt'), 'ignored but mine\n');
    const before = snap(fx.repo);
    const r = await s.post('undo');
    expect(r.statusCode).toBe(409);
    expect(head(fx.repo)).toBe(newTip);
    expect(text(fx.repo, 'f2.txt')).toBe('ignored but mine\n');
    expect(snap(fx.repo)).toEqual(before);
  });

  it('refused (409, nothing changes) when a tracked file has uncommitted changes', async () => {
    const { fx, s, newTip } = await afterDrop();
    writeFileSync(join(fx.repo, 'a.txt'), 'uncommitted tracked edit\n');
    const before = snap(fx.repo);
    const r = await s.post('undo');
    expect(r.statusCode).toBe(409);
    expect(head(fx.repo)).toBe(newTip);
    expect(snap(fx.repo)).toEqual(before);
  });

  it('a new rewrite clears the redo list (like every recorded action)', async () => {
    const fx = linear();
    const s = await start(fx.repo);
    okRes(await s.post('reword', { sha: fx.c4, expectHead: fx.c4, message: 'first' }));
    okRes(await s.post('undo'));
    expect((await s.undoState()).redo).not.toBeNull();
    okRes(await s.post('reword', { sha: fx.c4, expectHead: fx.c4, message: 'second' }));
    expect((await s.undoState()).redo).toBeNull();
  });
});

describe('review fixes (V4)', () => {
  /** Steps that rebuild two and three on top of one (same trees, authors and messages as the originals). */
  function stepsFor(fx: Lin): Step[] {
    return [fx.c2, fx.c3].map((c) => ({
      tree: treeOf(fx.repo, c),
      author: authorLine(fx.repo, c).subarray('author '.length).toString('latin1'),
      message: Buffer.from(`${message(fx.repo, c)}\n`, 'utf8'),
    }));
  }
  const h = (fx: Lin) => ({ tip: fx.c3, ref: 'refs/heads/main', branch: 'main' });

  it('read-back check: the intended parents and message bytes pass; a wrong parent or altered message moves nothing', async () => {
    const make = (tamper?: (args: string[], opts: Parameters<Run>[1]) => [string[], Parameters<Run>[1]]): { fx: Lin; run: Run } => {
      const fx = linear('rw-readback');
      git(fx.repo, ['reset', '--hard', fx.c3]);
      const real = runner(fx.repo, repoIdFor(fx.repo));
      return { fx, run: (args, opts) => (tamper && args.includes('commit-tree') ? real(...tamper(args, opts)) : real(args, opts)) };
    };
    const ok = make();
    const done = await buildAndMove(ok.run, h(ok.fx), ok.fx.c1, stepsFor(ok.fx), 'test', ok.fx.repo);
    expect(done.outcome).toBe('done');
    expect(head(ok.fx.repo)).toBe(done.sha);

    const wrongParent = make((args, opts) => {
      const i = args.indexOf('-p');
      return [i < 0 ? args : [...args.slice(0, i), ...args.slice(i + 2)], opts];
    });
    const r1 = await buildAndMove(wrongParent.run, h(wrongParent.fx), wrongParent.fx.c1, stepsFor(wrongParent.fx), 'test', wrongParent.fx.repo);
    expect(r1.outcome).toBe('refused');
    expect(head(wrongParent.fx.repo)).toBe(wrongParent.fx.c3);

    const altered = make((args, opts) => [args, { ...opts, input: Buffer.concat([Buffer.from(opts?.input ?? ''), Buffer.from('extra\n')]) }]);
    const r2 = await buildAndMove(altered.run, h(altered.fx), altered.fx.c1, stepsFor(altered.fx), 'test', altered.fx.repo);
    expect(r2.outcome).toBe('refused');
    expect(head(altered.fx.repo)).toBe(altered.fx.c3);
  });

  it('a todo file that cannot be written after the auto-stash still tells the user about the stash', async () => {
    const fx = linear('rw-todo-fail');
    writeFileSync(join(fx.repo, 'a.txt'), 'dirty tracked\n');
    const s = await start(fx.repo);
    writeFileSync(join(s.dataDir, 'rebase-todo'), 'a file where the folder should be');
    const r = await s.post('rebase/interactive', { upstream: fx.base, onto: fx.base, expectHead: fx.c4, steps: picks(fx.c1, fx.c2, fx.c3, fx.c4) });
    const j = r.json() as { outcome?: string; stash?: { message: string } };
    expect(j.stash?.message).toBeTruthy();
    expect(stashes(fx.repo)).toHaveLength(1);
    expect(head(fx.repo)).toBe(fx.c4);
  });

  it('a pending journal entry of an aborted-by-hand rebase is dropped when a merge starts, so a later rebase does not journal it', async () => {
    const fx = conflictRepo();
    git(fx.repo, ['switch', '-c', 'side']);
    const five = commit(fx.repo, { 'f5.txt': '5\n' }, 'five');
    git(fx.repo, ['switch', 'main']);
    const s = await start(fx.repo);
    const r = await s.post('rebase/interactive', { upstream: fx.base, onto: fx.base, expectHead: fx.c4, steps: [step(fx.c1, 'pick'), step(fx.c2, 'drop'), step(fx.c3, 'pick'), step(fx.c4, 'pick')] });
    expect(outcome(r)).toBe('conflict');
    git(fx.repo, ['rebase', '--abort']); // behind the server's back: its pending entry stays
    okRes(await s.post('merge', { name: 'side', ffOnly: true }));
    expect(head(fx.repo)).toBe(five);
    // a second, hand-made rebase that conflicts and is finished through the route
    const edit = spawnSync('git', ['rebase', '-i', fx.base], { cwd: fx.repo, env: { ...envFor('Test Author', `${clock} +0000`), GIT_SEQUENCE_EDITOR: 'sed -i /two/d' }, encoding: 'utf8', windowsHide: true });
    expect(edit.status).not.toBe(0);
    expect(rebasing(fx.repo)).toBe(true);
    writeFileSync(join(fx.repo, 's.txt'), 'resolved\n');
    git(fx.repo, ['add', 's.txt']);
    okRes(await s.post('rebase/continue', {}));
    expect(rebasing(fx.repo)).toBe(false);
    expect((await s.undoState()).undo).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------
describe('operations in progress and detached HEAD', () => {
  it('while a rebase is stopped on a conflict, reword, squash, interactive rebase and multi cherry-pick all answer 409 and change nothing', async () => {
    const fx = conflictRepo();
    const s = await start(fx.repo);
    const r = await s.post('rebase/interactive', { upstream: fx.base, onto: fx.base, expectHead: fx.c4, steps: [step(fx.c1, 'pick'), step(fx.c2, 'drop'), step(fx.c3, 'pick'), step(fx.c4, 'pick')] });
    expect(outcome(r)).toBe('conflict');
    const before = snap(fx.repo);
    const tipNow = head(fx.repo);
    for (const [sub, body] of [
      ['reword', { sha: fx.c1, expectHead: tipNow, message: 'x' }],
      ['squash', { shas: [fx.c1, fx.c3], expectHead: tipNow }],
      ['rebase/interactive', { upstream: fx.base, onto: fx.base, expectHead: tipNow, steps: picks(fx.c1, fx.c2, fx.c3, fx.c4) }],
      ['cherry-pick/multi', { shas: [fx.c1, fx.c2], expectHead: tipNow }],
    ] as const) {
      const res = await s.post(sub, body);
      expect(res.statusCode, sub).toBe(409);
    }
    expect(snap(fx.repo)).toEqual(before);
    expect(rebasing(fx.repo)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
/** main: Base (s.txt='base'), one (f1), two (s.txt='two'), three (s.txt='three'), four (f4). Dropping two makes three conflict. */
function conflictRepo(): Lin {
  const repo = newRepo('rw-conflict');
  const base = commit(repo, { 's.txt': 'base\n', 'a.txt': 'a\n' }, 'Base');
  const c1 = commit(repo, { 'f1.txt': '1\n' }, 'one', 'First Author');
  const c2 = commit(repo, { 's.txt': 'two\n' }, 'two', 'Second Author');
  const c3 = commit(repo, { 's.txt': 'three\n' }, 'three', 'Third Author');
  const c4 = commit(repo, { 'f4.txt': '4\n' }, 'four', 'Fourth Author');
  return { repo, base, c1, c2, c3, c4 };
}

let bigFixture: { repo: string; shas: string[] } | undefined;
/** One 503-commit repository for every cap test (building it five times was the slow part); no test may change it. */
function sharedBig(): { repo: string; shas: string[] } {
  return (bigFixture ??= bigRepo(503));
}

/**
 * main = Base; branch `big` = Base + n-1 more commits written with git fast-import (one process), then checked out clean.
 * shas[0] is the first commit (the root of the chain: every later commit descends from it), shas[n-1] the tip.
 */
function bigRepo(n: number): { repo: string; shas: string[] } {
  const repo = newRepo('rw-big');
  commit(repo, { 'a.txt': 'a\n' }, 'Base');
  let stream = '';
  for (let i = 1; i <= n; i++) {
    const msg = `big ${i}`;
    const body = `${i}\n`;
    stream += `commit refs/heads/big\nmark :${i}\nauthor Big Author <big@example.com> ${1_600_000_000 + i} +0000\ncommitter Big Author <big@example.com> ${1_600_000_000 + i} +0000\ndata ${msg.length}\n${msg}\n`;
    if (i === 1) stream += 'from refs/heads/main\n';
    stream += `M 100644 inline f.txt\ndata ${body.length}\n${body}\n`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, env: BASE_ENV, input: stream, windowsHide: true });
  git(repo, ['switch', 'big']);
  const shas = git(repo, ['rev-list', '--reverse', 'main..big']).split('\n').filter(Boolean);
  if (shas.length !== n) throw new Error(`fixture: expected ${n} commits, got ${shas.length}`);
  return { repo, shas };
}
