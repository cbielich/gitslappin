import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { getCommandLog } from './commandLog';

vi.setConfig({ testTimeout: 120_000 });

/*
 * V5 (Compare, File History/Blame, Hide/Solo), black-box through the app (app.inject), real git, no mocks. Routes under /api/repos/:id (names from the design):
 *   GET  compare?from=<sha|empty>&to=<sha>            -> 200 { files: {status,path,oldPath?}[], truncated: boolean }   (cap 5000 files)
 *   GET  compare?from=<sha|empty>&workdir=1           -> same shape, tracked files only (diff <from> --)
 *   GET  diff, diff/contents ?source=commit&sha=&base=<sha|empty>&path=      base replaces the first parent
 *   GET  diff, diff/contents ?source=workdir&sha=&path=                      old = sha:oldPath (cat-file), new = the working file (tracked paths only)
 *   GET  file-history?sha=&path=&skip=&limit=         -> 200 { entries: {sha,authorName,authorEmail,authorDate,summary,status,path,oldPath?}[], nextSkip, hasMore }; skip 0..100000, limit 1..500 (default 100), else 400; path missing at sha = 404
 *   GET  blame?sha=&path=                              -> 200 { commits: {[sha]: {summary,authorName,authorEmail,authorTime}}, lines: string[] /* one sha per line *\/ }; > 5 MB file = 413
 *   GET/PUT visibility                                 -> { hidden: string[], solo: string[], hideStashes: boolean }; PUT refused input = 400; stored in <dataDir>/graph-visibility.json
 *   GET  log, GET locate/:sha                          (existing) follow the hide/solo view: hidden commits are gone from /log and /locate gives index -1
 * Isolation: GIT_CONFIG_NOSYSTEM + empty GIT_CONFIG_GLOBAL; every fixture repo lives in os.tmpdir()/gitslappin-tests (mkdtemp, asserted new and empty). Nothing is deleted
 * anywhere (the textconv marker file is only appended to).
 * UNVERIFIED: git's exact output layout of `log --follow --name-status -z --format=...` (the int tests below run it for real); whether `blame` honours textconv without --no-textconv
 *   on this machine (the textconv test has a control that proves it is armed, and fails loudly if it is not).
 */

const ROOT = resolve(join(tmpdir(), 'gitslappin-tests'));
const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const underRoot = (p: string): boolean => norm(p).startsWith(norm(ROOT) + (process.platform === 'win32' ? '\\' : sep));
const fwd = (p: string): string => p.replace(/\\/g, '/');

function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!underRoot(dir) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const CFG_DIR = fresh('gitcfg-viewing-int');
const EMPTY_GLOBAL = join(CFG_DIR, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL, '');
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
});
delete process.env.GITSLAPPIN_TOKEN;

const git = (cwd: string, args: string[], input?: string): string => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true, ...(input !== undefined ? { input } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const head = (repo: string): string => git(repo, ['rev-parse', 'HEAD']).trim();

function commit(repo: string, files: Record<string, string | Buffer>, msg: string, who = 'Test Author'): string {
  for (const [rel, t] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, t);
  }
  git(repo, ['add', '-A']);
  execFileSync('git', ['commit', '-m', msg], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who.toLowerCase().replace(/ /g, '.')}@example.com` },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return head(repo);
}
function newRepo(prefix: string): string {
  const repo = join(fresh(prefix), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'author@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'core.editor', 'false']);
  return repo;
}
const shaOfSubject = (repo: string, subject: string): string => {
  const line = git(repo, ['log', '--all', '--format=%H%x00%s']).split('\n').find((l) => l.split('\0')[1] === subject);
  if (!line) throw new Error(`no commit "${subject}"`);
  return line.split('\0')[0]!;
};

// ---- the app -------------------------------------------------------------------------------------------------------------------------
const PORT = 4997;
const TOKEN = 'v'.repeat(40);
const headers = { host: `127.0.0.1:${PORT}`, 'x-gitslappin-token': TOKEN };
const DATA_DIR = fresh('gitslappin-unit-viewing-data');
const VIS_FILE = join(DATA_DIR, 'graph-visibility.json');
writeFileSync(VIS_FILE, '{this is not json'); // a corrupt store from the start: must read as "nothing hidden", never crash
const app = await buildApp(loadConfig({ GITSLAPPIN_NO_OPEN: '1', GITSLAPPIN_TOKEN: TOKEN, GITSLAPPIN_PORT: String(PORT), GITSLAPPIN_DATA_DIR: DATA_DIR, GITSLAPPIN_WATCH: 'poll' }));
afterAll(async () => {
  await app.close();
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Res {
  status: number;
  body: Json;
  text: string;
}
async function call(method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown): Promise<Res> {
  const r = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  let body: Json = {};
  try {
    body = JSON.parse(r.body) as Json;
  } catch {
    /* not json */
  }
  return { status: r.statusCode, body, text: r.body };
}
async function openRepo(path: string): Promise<string> {
  const r = await call('POST', '/api/repos/open', { path });
  expect(r.status).toBe(200);
  return r.body.id as string;
}
const q = (o: Record<string, string>): string => new URLSearchParams(o).toString();
const refused = (r: Res): void => {
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);
};
const getLog = (id: string) => call('GET', `/api/repos/${id}/log?limit=1000`);
const subjectsOf = (r: Res): string[] => (r.body.commits as { subject: string }[]).map((c) => c.subject);
const putVis = (id: string, v: unknown) => call('PUT', `/api/repos/${id}/visibility`, v);
const NOTHING = { hidden: [], solo: [], hideStashes: false };
const logRuns = (id: string): number => getCommandLog(id).filter((e) => e.args.includes('log')).length;

// ---- fixtures ------------------------------------------------------------------------------------------------------------------------
interface VFx {
  repo: string;
  orphan: string;
}
/**
 * main: Base one -> Base two (tag v1) -> Main three (HEAD)
 * side: Base two -> Side one -> Side two;  other: Base two -> Other one;  tag "lonely" on "Tag only" (its branch was deleted);  one stash;  one own undo ref on an orphan commit.
 */
function makeViewRepo(): VFx {
  const repo = newRepo('viewing-int');
  commit(repo, { 'base.txt': 'base\n' }, 'Base one');
  commit(repo, { 'base2.txt': 'base2\n' }, 'Base two');
  git(repo, ['tag', 'v1']);
  git(repo, ['switch', '-c', 'side']);
  commit(repo, { 'side1.txt': 's1\n' }, 'Side one');
  commit(repo, { 'side2.txt': 's2\n' }, 'Side two');
  git(repo, ['switch', 'main']);
  git(repo, ['switch', '-c', 'other']);
  commit(repo, { 'other1.txt': 'o1\n' }, 'Other one');
  git(repo, ['switch', 'main']);
  git(repo, ['switch', '-c', 'tmp']);
  commit(repo, { 'tag1.txt': 't1\n' }, 'Tag only');
  git(repo, ['tag', 'lonely']);
  git(repo, ['switch', 'main']);
  git(repo, ['branch', '-D', 'tmp']);
  commit(repo, { 'main3.txt': 'm3\n' }, 'Main three');
  writeFileSync(join(repo, 'base.txt'), 'base changed\n');
  git(repo, ['stash', 'push', '-m', 'stash one']);
  const tree = git(repo, ['hash-object', '-t', 'tree', '--stdin'], '').trim();
  const orphan = git(repo, ['commit-tree', tree, '-m', 'Orphan undo pin']).trim();
  git(repo, ['update-ref', `refs/gitslappin/undo/${orphan}`, orphan]);
  return { repo, orphan };
}

// =====================================================================================================================================
describe('graph-visibility store and routes', () => {
  it('a corrupt graph-visibility.json reads as nothing hidden (200, defaults) and does not stop the app', async () => {
    const fx = makeViewRepo();
    const id = await openRepo(fx.repo);
    const r = await call('GET', `/api/repos/${id}/visibility`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(NOTHING);
    expect(subjectsOf(await getLog(id))).toContain('Other one');
  });

  it('PUT stores it per repo and GET returns it; another repo is unaffected; the file is valid JSON and no temp file is left behind', async () => {
    const a = await openRepo(makeViewRepo().repo);
    const b = await openRepo(makeViewRepo().repo);
    const v = { hidden: ['refs/heads/side', 'refs/tags/v1'], solo: [], hideStashes: true };
    expect((await putVis(a, v)).status).toBe(200);
    expect((await call('GET', `/api/repos/${a}/visibility`)).body).toEqual(v);
    expect((await call('GET', `/api/repos/${b}/visibility`)).body).toEqual(NOTHING);
    const text = readFileSync(VIS_FILE, 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toContain('refs/heads/side');
    expect(readdirSync(DATA_DIR).filter((n) => n.startsWith('graph-visibility'))).toEqual(['graph-visibility.json']);
  });

  it('refuses bad input with 400 and keeps what was stored', async () => {
    const id = await openRepo(makeViewRepo().repo);
    const good = { hidden: ['refs/heads/side'], solo: [], hideStashes: false };
    expect((await putVis(id, good)).status).toBe(200);
    const many = Array.from({ length: 5001 }, (_, i) => `refs/tags/t${i}`);
    const bad: unknown[] = [
      { ...good, hidden: ['heads/side'] },
      { ...good, hidden: ['refs/stash'] },
      { ...good, hidden: ['refs/gitslappin/undo/abc'] },
      { ...good, hidden: ['refs/heads/a\nb'] },
      { ...good, hidden: ['refs/heads/a\0b'] },
      { ...good, solo: [`refs/heads/${'a'.repeat(1100)}`] },
      { ...good, hidden: many },
      { ...good, solo: many },
      { ...good, hidden: 'refs/heads/side' },
      { ...good, hidden: [5] },
      { ...good, hideStashes: 'yes' },
      [],
    ];
    for (const b of bad) {
      const r = await putVis(id, b);
      expect(r.status, JSON.stringify(b).slice(0, 80)).toBe(400);
    }
    expect((await call('GET', `/api/repos/${id}/visibility`)).body).toEqual(good);
  });

  it('a huge body is refused before it is stored (explicit body limit)', async () => {
    const id = await openRepo(makeViewRepo().repo);
    const r = await putVis(id, { hidden: ['refs/heads/' + 'a'.repeat(20 * 1024 * 1024)], solo: [], hideStashes: false });
    refused(r);
    expect((await call('GET', `/api/repos/${id}/visibility`)).body).toEqual(NOTHING);
  });

  it('an unknown repo id is 404 for GET and PUT, including ids that are Object.prototype names', async () => {
    for (const id of ['0000000000000000', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect((await call('GET', `/api/repos/${id}/visibility`)).status, id).toBe(404);
      expect((await putVis(id, NOTHING)).status, id).toBe(404);
    }
  });
});

// =====================================================================================================================================
describe('hide / solo applied to /log and /locate', () => {
  it('control: nothing hidden lists every graph commit, the stash node, and never the own undo ref commit', async () => {
    const fx = makeViewRepo();
    const id = await openRepo(fx.repo);
    const r = await getLog(id);
    expect(r.status).toBe(200);
    for (const s of ['Base one', 'Base two', 'Side one', 'Side two', 'Other one', 'Tag only', 'Main three']) expect(subjectsOf(r), s).toContain(s);
    expect((r.body.commits as { stash?: number }[]).some((c) => c.stash !== undefined)).toBe(true);
    expect(subjectsOf(r)).not.toContain('Orphan undo pin');
    expect(git(fx.repo, ['cat-file', '-t', fx.orphan]).trim()).toBe('commit'); // the orphan really exists
    expect(r.body.total).toBe(r.body.commits.length);
  });

  it('hiding a branch removes its exclusive commits and keeps the shared ones; hiding the remote-less local branch changes total', async () => {
    const id = await openRepo(makeViewRepo().repo);
    const before = (await getLog(id)).body.total as number;
    expect((await putVis(id, { ...NOTHING, hidden: ['refs/heads/side'] })).status).toBe(200);
    const r = await getLog(id);
    const s = subjectsOf(r);
    expect(s).not.toContain('Side one');
    expect(s).not.toContain('Side two');
    for (const keep of ['Base one', 'Base two', 'Other one', 'Main three', 'Tag only']) expect(s, keep).toContain(keep);
    expect(r.body.total).toBe(before - 2);
    // the labels of the hidden branch are gone from every commit
    const names = (r.body.commits as { refs: { name: string }[] }[]).flatMap((c) => c.refs.map((x) => x.name));
    expect(names).not.toContain('side');
    expect(names).toContain('other');
  });

  it('the view follows the visibility value: clearing it brings the commits back (no stale cache)', async () => {
    const id = await openRepo(makeViewRepo().repo);
    const full = subjectsOf(await getLog(id));
    await putVis(id, { ...NOTHING, hidden: ['refs/heads/side', 'refs/heads/other'] });
    expect(subjectsOf(await getLog(id))).not.toContain('Other one');
    await putVis(id, NOTHING);
    expect(subjectsOf(await getLog(id))).toEqual(full);
  });

  it('hide all tags: a commit only a tag points to disappears, a tag on a reachable commit only loses its label', async () => {
    const id = await openRepo(makeViewRepo().repo);
    expect(subjectsOf(await getLog(id))).toContain('Tag only');
    await putVis(id, { ...NOTHING, hidden: ['refs/tags/lonely', 'refs/tags/v1'] });
    const r = await getLog(id);
    expect(subjectsOf(r)).not.toContain('Tag only');
    expect(subjectsOf(r)).toContain('Base two');
    expect((r.body.commits as { refs: { kind: string }[] }[]).flatMap((c) => c.refs).filter((x) => x.kind === 'tag')).toEqual([]);
  });

  it('hide stashes removes the stash node and nothing else', async () => {
    const id = await openRepo(makeViewRepo().repo);
    const before = await getLog(id);
    await putVis(id, { ...NOTHING, hideStashes: true });
    const r = await getLog(id);
    expect((r.body.commits as { stash?: number }[]).some((c) => c.stash !== undefined)).toBe(false);
    expect(r.body.total).toBe(before.body.total - 1);
  });

  it('the checked-out branch cannot be hidden: it is still on the graph with its label', async () => {
    const id = await openRepo(makeViewRepo().repo);
    expect((await putVis(id, { ...NOTHING, hidden: ['refs/heads/main'] })).status).toBe(200);
    const r = await getLog(id);
    expect(subjectsOf(r)).toContain('Main three');
    const labels = (r.body.commits as { refs: { name: string; current?: boolean }[] }[]).flatMap((c) => c.refs);
    expect(labels.some((x) => x.name === 'main' && x.current)).toBe(true);
  });

  it('solo keeps the soloed branch plus HEAD and drops every other branch and tag-only commit; the own undo ref commit stays out', async () => {
    const fx = makeViewRepo();
    const id = await openRepo(fx.repo);
    expect((await putVis(id, { ...NOTHING, solo: ['refs/heads/side'] })).status).toBe(200);
    const r = await getLog(id);
    const s = subjectsOf(r);
    for (const keep of ['Side one', 'Side two', 'Main three', 'Base one', 'Base two']) expect(s, keep).toContain(keep);
    expect(s).not.toContain('Other one');
    expect(s).not.toContain('Tag only');
    expect(s).not.toContain('Orphan undo pin');
  });

  it('a stale entry (that ref no longer exists) is ignored: same list as nothing hidden', async () => {
    const id = await openRepo(makeViewRepo().repo);
    const full = subjectsOf(await getLog(id));
    expect((await putVis(id, { ...NOTHING, hidden: ['refs/heads/deleted-long-ago'], solo: [] })).status).toBe(200);
    expect(subjectsOf(await getLog(id))).toEqual(full);
  });

  it('review fix 2: GET /visibility drops entries for refs that no longer exist and persists the pruned value', async () => {
    const fx = makeViewRepo();
    const id = await openRepo(fx.repo);
    const v = { hidden: ['refs/heads/other', 'refs/heads/gone-hidden'], solo: ['refs/heads/gone-solo'], hideStashes: true };
    expect((await putVis(id, v)).status).toBe(200);
    expect((await call('GET', `/api/repos/${id}/visibility`)).body).toEqual({ hidden: ['refs/heads/other'], solo: [], hideStashes: true });
    const saved = JSON.parse(readFileSync(VIS_FILE, 'utf8')) as Record<string, unknown>;
    expect(saved[id]).toEqual({ hidden: ['refs/heads/other'], solo: [], hideStashes: true });
  });

  it('review fix 2: deleting the only soloed branch ends soloing; a recreated ref of that name is visible', async () => {
    const fx = makeViewRepo();
    const id = await openRepo(fx.repo);
    expect((await putVis(id, { ...NOTHING, solo: ['refs/heads/side'] })).status).toBe(200);
    git(fx.repo, ['branch', '-D', 'side']);
    expect((await call('GET', `/api/repos/${id}/visibility`)).body).toEqual(NOTHING);
    git(fx.repo, ['branch', 'side', 'HEAD']);
    expect((await call('GET', `/api/repos/${id}/visibility`)).body).toEqual(NOTHING);
    expect(subjectsOf(await getLog(id))).toContain('Other one');
  });

  it('/locate gives -1 for a hidden commit and its normal index otherwise', async () => {
    const fx = makeViewRepo();
    const id = await openRepo(fx.repo);
    const o1 = shaOfSubject(fx.repo, 'Other one');
    const m3 = shaOfSubject(fx.repo, 'Main three');
    expect((await call('GET', `/api/repos/${id}/locate/${o1}`)).body.index).toBeGreaterThanOrEqual(0);
    await putVis(id, { ...NOTHING, hidden: ['refs/heads/other'] });
    expect((await call('GET', `/api/repos/${id}/locate/${o1}`)).body.index).toBe(-1);
    expect((await call('GET', `/api/repos/${id}/locate/${m3}`)).body.index).toBeGreaterThanOrEqual(0);
  });

  it('audit fix 1: toggling hide/solo does NOT spawn git log (the one cached walk is filtered in memory); a real ref change still does', async () => {
    const fx = makeViewRepo();
    const id = await openRepo(fx.repo);
    await getLog(id); // builds the walk
    const walks = logRuns(id);
    expect(walks).toBeGreaterThan(0); // the counter sees `log` runs
    for (const v of [
      { ...NOTHING, hidden: ['refs/heads/other'] },
      { ...NOTHING, hidden: ['refs/tags/v1', 'refs/tags/lonely'], hideStashes: true },
      { ...NOTHING, solo: ['refs/heads/side'] },
      NOTHING,
    ]) {
      expect((await putVis(id, v)).status).toBe(200);
      expect((await getLog(id)).status).toBe(200);
    }
    expect(logRuns(id)).toBe(walks);
    commit(fx.repo, { 'late.txt': 'late\n' }, 'Late commit'); // control: a ref moved, so the walk is rebuilt
    expect(subjectsOf(await getLog(id))).toContain('Late commit');
    expect(logRuns(id)).toBeGreaterThan(walks);
  });
});

// =====================================================================================================================================
describe('file history', () => {
  /** a.txt: A, M, renamed to b.txt, M. Returns the shas oldest to newest. */
  function renameRepo(): { repo: string; shas: string[] } {
    const repo = newRepo('viewing-rename');
    const body = (n: number): string => Array.from({ length: 30 }, (_, i) => `line ${i} of the file${i === n ? ' (edited)' : ''}`).join('\n') + '\n';
    const c1 = commit(repo, { 'a.txt': body(-1), 'other.txt': 'x\n' }, 'Add a');
    const c2 = commit(repo, { 'a.txt': body(3) }, 'Edit a');
    git(repo, ['mv', 'a.txt', 'b.txt']);
    git(repo, ['commit', '-m', 'Rename a to b']);
    const c3 = head(repo);
    const c4 = commit(repo, { 'b.txt': body(7) }, 'Edit b');
    return { repo, shas: [c1, c2, c3, c4] };
  }

  it('--follow goes across the rename: 4 entries newest first, each with its own path, the rename has oldPath, the last is an A', async () => {
    const { repo, shas } = renameRepo();
    const id = await openRepo(repo);
    const r = await call('GET', `/api/repos/${id}/file-history?${q({ sha: shas[3]!, path: 'b.txt' })}`);
    expect(r.status).toBe(200);
    const e = r.body.entries as Json[];
    expect(e.map((x) => x.sha)).toEqual([shas[3], shas[2], shas[1], shas[0]]);
    expect(e.map((x) => x.status)).toEqual(['M', 'R', 'M', 'A']);
    expect(e.map((x) => x.path)).toEqual(['b.txt', 'b.txt', 'a.txt', 'a.txt']);
    expect(e[1]!.oldPath).toBe('a.txt');
    expect(e[0]!.oldPath).toBeUndefined();
    expect(e[0]).toMatchObject({ summary: 'Edit b', authorName: 'Test Author', authorEmail: 'test.author@example.com' });
    expect(String(e[0]!.authorDate)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.body.hasMore).toBe(false);
    expect(r.body.nextSkip).toBe(4);
  });

  it('opening at an older commit lists only history up to that commit', async () => {
    const { repo, shas } = renameRepo();
    const id = await openRepo(repo);
    const r = await call('GET', `/api/repos/${id}/file-history?${q({ sha: shas[1]!, path: 'a.txt' })}`);
    expect((r.body.entries as Json[]).map((x) => x.sha)).toEqual([shas[1], shas[0]]);
  });

  it('skip / limit page through the list: hasMore and nextSkip are right and the pages join up', async () => {
    const repo = newRepo('viewing-paging');
    const shas: string[] = [];
    for (let i = 0; i < 5; i++) shas.push(commit(repo, { 'p.txt': `v${i}\n` }, `Edit p ${i}`));
    const id = await openRepo(repo);
    const page = (skip: number, limit: number) => call('GET', `/api/repos/${id}/file-history?${q({ sha: shas[4]!, path: 'p.txt', skip: String(skip), limit: String(limit) })}`);
    const p1 = await page(0, 2);
    const p2 = await page(2, 2);
    const p3 = await page(4, 2);
    expect([p1, p2, p3].map((p) => p.status)).toEqual([200, 200, 200]);
    expect([p1, p2, p3].map((p) => (p.body.entries as Json[]).length)).toEqual([2, 2, 1]);
    expect([p1, p2, p3].map((p) => p.body.hasMore)).toEqual([true, true, false]);
    expect([p1, p2, p3].map((p) => p.body.nextSkip)).toEqual([2, 4, 5]);
    expect([p1, p2, p3].flatMap((p) => (p.body.entries as Json[]).map((x) => x.sha))).toEqual([...shas].reverse());
    const none = await page(100000, 5);
    expect(none.status).toBe(200);
    expect(none.body.entries).toEqual([]);
    expect(none.body.hasMore).toBe(false);
    expect((await call('GET', `/api/repos/${id}/file-history?${q({ sha: shas[4]!, path: 'p.txt' })}`)).body.entries).toHaveLength(5); // default limit 100
  });

  it('audit fix 2: git log --follow runs once with no -n / --skip / --max-count; later pages are served from memory; another path walks again', async () => {
    const repo = newRepo('viewing-cache');
    const shas: string[] = [];
    for (let i = 0; i < 4; i++) shas.push(commit(repo, { 'p.txt': `v${i}\n`, 'q.txt': `w${i}\n` }, `Edit ${i}`));
    const id = await openRepo(repo);
    const follows = (): string[][] => getCommandLog(id).filter((e) => e.args.includes('log') && e.args.includes('--follow')).map((e) => e.args);
    const url = (path: string, skip: number) => `/api/repos/${id}/file-history?${q({ sha: shas[3]!, path, skip: String(skip), limit: '1' })}`;
    expect(follows()).toHaveLength(0);
    expect((await call('GET', url('p.txt', 0))).status).toBe(200);
    expect(follows()).toHaveLength(1);
    const argv = follows()[0]!;
    expect(argv.some((a) => a === '-n' || /^-n\d/.test(a) || a.startsWith('--max-count') || a.startsWith('--skip'))).toBe(false);
    for (const skip of [1, 2, 3]) expect((await call('GET', url('p.txt', skip))).status).toBe(200);
    expect(follows()).toHaveLength(1); // the control above shows the counter works
    expect((await call('GET', url('q.txt', 0))).status).toBe(200);
    expect(follows()).toHaveLength(2);
  });

  it('skip must be an integer 0..100000 and limit 1..500, else 400 (the boundaries themselves are fine)', async () => {
    const repo = newRepo('viewing-limits');
    const sha = commit(repo, { 'p.txt': 'a\n' }, 'One');
    const id = await openRepo(repo);
    const get = (extra: Record<string, string>) => call('GET', `/api/repos/${id}/file-history?${q({ sha, path: 'p.txt', ...extra })}`);
    expect((await get({})).status).toBe(200);
    for (const ok of [{ skip: '0' }, { skip: '100000' }, { limit: '1' }, { limit: '500' }]) expect((await get(ok)).status, JSON.stringify(ok)).toBe(200);
    for (const bad of [{ skip: '-1' }, { skip: '100001' }, { skip: 'abc' }, { skip: '1.5' }, { skip: '1e2' }, { skip: '0x10' }, { limit: '0' }, { limit: '501' }, { limit: '-5' }, { limit: 'abc' }, { limit: '2.5' }, { limit: '99999999999' }]) {
      expect((await get(bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('path not in that commit is 404; unknown but valid-looking sha is 404; unknown repo is 404', async () => {
    const repo = newRepo('viewing-404');
    const sha = commit(repo, { 'p.txt': 'a\n' }, 'One');
    const id = await openRepo(repo);
    expect((await call('GET', `/api/repos/${id}/file-history?${q({ sha, path: 'nope.txt' })}`)).status).toBe(404);
    expect((await call('GET', `/api/repos/${id}/file-history?${q({ sha: 'd'.repeat(40), path: 'p.txt' })}`)).status).toBe(404);
    expect((await call('GET', `/api/repos/0000000000000000/file-history?${q({ sha, path: 'p.txt' })}`)).status).toBe(404);
    expect((await call('GET', `/api/repos/${id}/file-history?${q({ sha, path: 'p.txt' })}`)).status).toBe(200); // alive
  });
});

// =====================================================================================================================================
describe('blame', () => {
  function blameRepo(): { repo: string; c1: string; c2: string; c3: string } {
    const repo = newRepo('viewing-blame');
    const c1 = commit(repo, { 'b.txt': 'L1\nL2\nL3\n' }, 'Create b', 'Ann Author');
    const c2 = commit(repo, { 'b.txt': 'L1\nL2 changed\nL3\n' }, 'Change line two', 'Bob Builder');
    const c3 = commit(repo, { 'b.txt': 'L1\nL2 changed\nL3\nL4\n' }, 'Add line four', 'Cy Coder');
    return { repo, c1, c2, c3 };
  }

  it('gives the right commit for every line, with summary / author / time per commit', async () => {
    const { repo, c1, c2, c3 } = blameRepo();
    const id = await openRepo(repo);
    const r = await call('GET', `/api/repos/${id}/blame?${q({ sha: c3, path: 'b.txt' })}`);
    expect(r.status).toBe(200);
    expect(r.body.lines).toEqual([c1, c2, c1, c3]);
    expect(Object.keys(r.body.commits).sort()).toEqual([c1, c2, c3].sort());
    expect(r.body.commits[c2]).toMatchObject({ summary: 'Change line two', authorName: 'Bob Builder', authorEmail: 'bob.builder@example.com' });
    expect(typeof r.body.commits[c2].authorTime).toBe('number');
    expect(r.body.commits[c1].summary).toBe('Create b');
  });

  it('blame at an older sha only knows the commits up to it', async () => {
    const { repo, c1, c2 } = blameRepo();
    const id = await openRepo(repo);
    const r = await call('GET', `/api/repos/${id}/blame?${q({ sha: c2, path: 'b.txt' })}`);
    expect(r.body.lines).toEqual([c1, c2, c1]);
  });

  it('a file over the 5 MB cap is 413 and git blame is not run on it; the same route still answers for a small file', async () => {
    const { repo, c3 } = blameRepo();
    const big = commit(repo, { 'big.txt': 'abcdefgh\n'.repeat(Math.ceil((5 * 1024 * 1024 + 1) / 9)) }, 'Big file');
    const id = await openRepo(repo);
    const before = getCommandLog(id).length;
    const r = await call('GET', `/api/repos/${id}/blame?${q({ sha: big, path: 'big.txt' })}`);
    expect(r.status).toBe(413);
    expect(getCommandLog(id).slice(before).some((e) => e.args.includes('blame'))).toBe(false);
    expect((await call('GET', `/api/repos/${id}/blame?${q({ sha: c3, path: 'b.txt' })}`)).status).toBe(200);
  });

  it('path missing at that sha is 404', async () => {
    const { repo, c3 } = blameRepo();
    const id = await openRepo(repo);
    expect((await call('GET', `/api/repos/${id}/blame?${q({ sha: c3, path: 'nope.txt' })}`)).status).toBe(404);
  });

  it('audit security 4: blame runs with --no-textconv, so a repo-configured textconv program is never started', async () => {
    const repo = newRepo('viewing-textconv');
    const marker = join(CFG_DIR, `textconv-ran-${Date.now()}.log`);
    writeFileSync(marker, '');
    const script = join(CFG_DIR, `textconv-${Date.now()}.js`);
    writeFileSync(script, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'ran\\n');process.stdout.write(fs.readFileSync(process.argv[2]));\n`);
    git(repo, ['config', 'diff.tc.textconv', `"${fwd(process.execPath)}" "${fwd(script)}"`]);
    const sha = commit(repo, { '.gitattributes': '*.dat diff=tc\n', 'x.dat': 'one\ntwo\n' }, 'Add dat');
    const ran = (): number => readFileSync(marker, 'utf8').split('\n').filter(Boolean).length;
    // control: plain git blame does start the textconv program here, so the trap is armed
    const direct = tryGit(repo, ['blame', '--porcelain', sha, '--', 'x.dat']);
    expect(direct.status).toBe(0);
    expect(ran()).toBeGreaterThan(0);
    const armed = ran();
    const id = await openRepo(repo);
    const r = await call('GET', `/api/repos/${id}/blame?${q({ sha, path: 'x.dat' })}`);
    expect(r.status).toBe(200); // the code path ran
    expect(r.body.lines).toEqual([sha, sha]);
    expect(ran()).toBe(armed);
  });

  it('git accepts --end-of-options for blame and for log --follow (needed by the routes)', () => {
    const { repo, c3 } = blameRepo();
    expect(tryGit(repo, ['blame', '--porcelain', '--no-textconv', c3, '--', 'b.txt']).status).toBe(0);
    expect(tryGit(repo, ['--literal-pathspecs', 'log', '--follow', '-M', '--name-status', '-z', '--format=%x1e%H%x00%an%x00%ae%x00%aI%x00%s', '--end-of-options', c3, '--', 'b.txt']).status).toBe(0);
  });
});

// =====================================================================================================================================
describe('compare', () => {
  /** c1: keep.txt, gone.txt, old-name.txt.  c2: keep.txt edited, gone.txt deleted, new.txt added, old-name.txt renamed to new-name.txt. */
  function compareRepo(): { repo: string; c1: string; c2: string } {
    const repo = newRepo('viewing-compare');
    const rename = Array.from({ length: 20 }, (_, i) => `rename me ${i}`).join('\n') + '\n';
    const c1 = commit(repo, { 'keep.txt': 'k1\n', 'gone.txt': 'g\n', 'old-name.txt': rename }, 'Compare one');
    git(repo, ['rm', '-q', 'gone.txt']);
    git(repo, ['mv', 'old-name.txt', 'new-name.txt']);
    const c2 = commit(repo, { 'keep.txt': 'k1\nk2\n', 'new.txt': 'n\n' }, 'Compare two');
    return { repo, c1, c2 };
  }
  const files = (r: Res): Record<string, string> => Object.fromEntries((r.body.files as { status: string; path: string }[]).map((f) => [f.path, f.status]));

  it('pair: lists M, A, D and the rename between two commits', async () => {
    const { repo, c1, c2 } = compareRepo();
    const id = await openRepo(repo);
    const r = await call('GET', `/api/repos/${id}/compare?${q({ from: c1, to: c2 })}`);
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(false);
    expect(files(r)).toEqual({ 'keep.txt': 'M', 'gone.txt': 'D', 'new.txt': 'A', 'new-name.txt': 'R' });
    expect((r.body.files as Json[]).find((f) => f.path === 'new-name.txt')!.oldPath).toBe('old-name.txt');
    // the reverse direction swaps A and D
    expect(files(await call('GET', `/api/repos/${id}/compare?${q({ from: c2, to: c1 })}`))).toMatchObject({ 'gone.txt': 'A', 'new.txt': 'D' });
  });

  it('empty base lists every file of the commit as added (root commit range)', async () => {
    const { repo, c1 } = compareRepo();
    const id = await openRepo(repo);
    const r = await call('GET', `/api/repos/${id}/compare?${q({ from: 'empty', to: c1 })}`);
    expect(r.status).toBe(200);
    expect(files(r)).toEqual({ 'keep.txt': 'A', 'gone.txt': 'A', 'old-name.txt': 'A' });
  });

  it('workdir: tracked changes (unstaged, staged) are listed; untracked and ignored files are not', async () => {
    const { repo } = compareRepo();
    const from = commit(repo, { '.gitignore': 'ignored.log\n' }, 'Ignore file');
    writeFileSync(join(repo, 'keep.txt'), 'work\n'); // unstaged edit
    writeFileSync(join(repo, 'staged-new.txt'), 's\n');
    git(repo, ['add', 'staged-new.txt']);
    writeFileSync(join(repo, 'untracked.txt'), 'u\n');
    writeFileSync(join(repo, 'ignored.log'), 'i\n');
    const id = await openRepo(repo);
    const r = await call('GET', `/api/repos/${id}/compare?${q({ from, workdir: '1' })}`);
    expect(r.status).toBe(200);
    expect(files(r)).toEqual({ 'keep.txt': 'M', 'staged-new.txt': 'A' });
  });

  it('audit security 5 / design: truncates at 5000 files and says so', async () => {
    const repo = newRepo('viewing-big');
    const n = 5001;
    let stream = 'commit refs/heads/big\ncommitter Test Author <author@example.com> 1700000000 +0000\ndata 4\nbig\n';
    for (let i = 0; i < n; i++) stream += `M 100644 inline d/f${i}.txt\ndata 2\nx\n\n`;
    git(repo, ['fast-import', '--quiet'], stream);
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/big']);
    const sha = git(repo, ['rev-parse', 'refs/heads/big']).trim();
    const id = await openRepo(repo);
    const r = await call('GET', `/api/repos/${id}/compare?${q({ from: 'empty', to: sha })}`);
    expect(r.status).toBe(200);
    expect(r.body.files).toHaveLength(5000);
    expect(r.body.truncated).toBe(true);
  });

  it('refuses anything that is not a hex sha (or the literal "empty") BEFORE git: 400 and no file is written by an option smuggled in', async () => {
    const { repo, c1, c2 } = compareRepo();
    const id = await openRepo(repo);
    const marker = join(fresh('viewing-marker'), 'out.txt');
    const bad = ['HEAD', 'main', 'HEAD~1', `${c1}^`, '', '--output=' + fwd(marker), '-p', '--stat', 'EMPTY', 'empty ', ':/Compare', 'refs/heads/main', `${c1}..${c2}`, 'g'.repeat(40), 'a'.repeat(6), 'a'.repeat(65)];
    for (const b of bad) {
      expect((await call('GET', `/api/repos/${id}/compare?${q({ from: b, to: c2 })}`)).status, `from=${b}`).toBe(400);
      expect((await call('GET', `/api/repos/${id}/compare?${q({ from: c1, to: b })}`)).status, `to=${b}`).toBe(400);
      expect((await call('GET', `/api/repos/${id}/compare?${q({ from: b, workdir: '1' })}`)).status, `workdir from=${b}`).toBe(400);
    }
    expect(existsSync(marker)).toBe(false);
    expect((await call('GET', `/api/repos/${id}/compare?${q({ from: c1, to: c2 })}`)).status).toBe(200); // alive
  });

  it('valid-looking sha that is not in the repo is 404; missing params are 400; unknown repo is 404', async () => {
    const { repo, c1 } = compareRepo();
    const id = await openRepo(repo);
    expect((await call('GET', `/api/repos/${id}/compare?${q({ from: c1, to: 'e'.repeat(40) })}`)).status).toBe(404);
    expect((await call('GET', `/api/repos/${id}/compare?${q({ from: c1 })}`)).status).toBe(400);
    expect((await call('GET', `/api/repos/${id}/compare`)).status).toBe(400);
    expect((await call('GET', `/api/repos/0000000000000000/compare?${q({ from: c1, to: c1 })}`)).status).toBe(404);
  });
});

// =====================================================================================================================================
describe('diff with base / source=workdir', () => {
  /** f.txt: one / two / three; g.txt added in c2 and edited in c3. */
  function diffRepo(): { repo: string; c1: string; c2: string; c3: string } {
    const repo = newRepo('viewing-diffbase');
    const c1 = commit(repo, { 'f.txt': 'one\n', '.gitignore': '.env\n' }, 'Diff one');
    const c2 = commit(repo, { 'f.txt': 'two\n', 'g.txt': 'g1\n' }, 'Diff two');
    const c3 = commit(repo, { 'f.txt': 'three\n', 'g.txt': 'g2\n' }, 'Diff three');
    return { repo, c1, c2, c3 };
  }
  const contents = (id: string, o: Record<string, string>) => call('GET', `/api/repos/${id}/diff/contents?${q(o)}`);
  const diff = (id: string, o: Record<string, string>) => call('GET', `/api/repos/${id}/diff?${q(o)}`);

  it('base replaces the first parent: contents and diff are against the base, not the parent', async () => {
    const { repo, c1, c2, c3 } = diffRepo();
    const id = await openRepo(repo);
    const plain = await contents(id, { source: 'commit', sha: c3, path: 'f.txt' });
    expect(plain.body).toEqual({ old: 'two\n', new: 'three\n' });
    const based = await contents(id, { source: 'commit', sha: c3, base: c1, path: 'f.txt' });
    expect(based.body).toEqual({ old: 'one\n', new: 'three\n' });
    expect((await contents(id, { source: 'commit', sha: c3, base: 'empty', path: 'f.txt' })).body).toEqual({ old: '', new: 'three\n' });
    // g.txt does not exist in c1: against c1 it is an addition, against the parent (c2) it is a modification
    expect((await diff(id, { source: 'commit', sha: c3, path: 'g.txt' })).body.status).toBe('M');
    const added = await diff(id, { source: 'commit', sha: c3, base: c1, path: 'g.txt' });
    expect(added.status).toBe(200);
    expect(added.body.status).toBe('A');
    expect(c2).not.toBe(c1);
  });

  it('a bad base is 400 (same rule as sha): not hex, a ref name, an option, a revision expression', async () => {
    const { repo, c3 } = diffRepo();
    const id = await openRepo(repo);
    const marker = join(fresh('viewing-marker-diff'), 'out.txt');
    for (const base of ['HEAD', 'main', 'HEAD~1', '', '--output=' + fwd(marker), '-p', 'zz', 'EMPTY', `${c3}^`]) {
      expect((await contents(id, { source: 'commit', sha: c3, base, path: 'f.txt' })).status, `contents base=${base}`).toBe(400);
      expect((await diff(id, { source: 'commit', sha: c3, base, path: 'f.txt' })).status, `diff base=${base}`).toBe(400);
    }
    expect(existsSync(marker)).toBe(false);
    expect((await contents(id, { source: 'commit', sha: c3, base: 'd'.repeat(40), path: 'f.txt' })).status).toBe(404);
  });

  it('workdir: old side is the commit\'s file, new side is the working file', async () => {
    const { repo, c1 } = diffRepo();
    writeFileSync(join(repo, 'f.txt'), 'work\n');
    const id = await openRepo(repo);
    const r = await contents(id, { source: 'workdir', sha: c1, path: 'f.txt' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ old: 'one\n', new: 'work\n' });
    const d = await diff(id, { source: 'workdir', sha: c1, path: 'f.txt' });
    expect(d.status).toBe(200);
    expect(d.body.additions).toBeGreaterThan(0);
  });

  it('audit security 2: workdir refuses untracked and ignored files (an ignored .env is never read) and requires a hex sha', async () => {
    const { repo, c1 } = diffRepo();
    writeFileSync(join(repo, '.env'), 'SECRET=hunter2\n');
    writeFileSync(join(repo, 'untracked.txt'), 'UNTRACKED-TEXT\n');
    const id = await openRepo(repo);
    for (const path of ['.env', 'untracked.txt']) {
      for (const route of [contents, diff]) {
        const r = await route(id, { source: 'workdir', sha: c1, path });
        refused(r);
        expect(r.text).not.toContain('hunter2');
        expect(r.text).not.toContain('UNTRACKED-TEXT');
      }
    }
    for (const sha of ['', 'HEAD', 'main', '--output=x', 'zz']) {
      expect((await contents(id, { source: 'workdir', sha, path: 'f.txt' })).status, `sha=${sha}`).toBe(400);
    }
    expect((await contents(id, { source: 'workdir', path: 'f.txt' })).status).toBe(400); // no sha at all
    expect((await contents(id, { source: 'workdir', sha: c1, path: 'f.txt' })).status).toBe(200); // control: a tracked file works
  });

  it('workdir refuses a path that leaves the repository or uses a colon / backslash, like the other sources', async () => {
    const { repo, c1 } = diffRepo();
    const id = await openRepo(repo);
    for (const path of ['../f.txt', 'a/../../x', '/etc/passwd', ':0:f.txt', 'C:/Windows/win.ini', 'a\\b']) {
      expect((await contents(id, { source: 'workdir', sha: c1, path })).status, path).toBe(400);
    }
  });
});

// =====================================================================================================================================
describe('path and sha input checks (file-history, blame)', () => {
  it('a path that is empty, has "..", a leading colon, a backslash or an option shape never reaches git: 4xx and no file written', async () => {
    const repo = newRepo('viewing-paths');
    const sha = commit(repo, { 'f.txt': 'a\n' }, 'One');
    const id = await openRepo(repo);
    const marker = join(fresh('viewing-marker-path'), 'out.txt');
    const paths = ['', '..', '../f.txt', 'a/../../f.txt', ':f.txt', ':(top)f.txt', ':0:f.txt', '/abs', 'a\\b', 'f.txt\nx', '--output=' + fwd(marker), '-p'];
    for (const route of ['file-history', 'blame']) {
      for (const path of paths) {
        const r = await call('GET', `/api/repos/${id}/${route}?${q({ sha, path })}`);
        refused(r);
      }
    }
    expect(existsSync(marker)).toBe(false);
    expect((await call('GET', `/api/repos/${id}/file-history?${q({ sha, path: 'f.txt' })}`)).status).toBe(200);
    expect((await call('GET', `/api/repos/${id}/blame?${q({ sha, path: 'f.txt' })}`)).status).toBe(200);
  });

  it('a pathspec in the path is a literal name, not a glob: "*.txt" finds nothing (404), it never lists the real file', async () => {
    const repo = newRepo('viewing-glob');
    const sha = commit(repo, { 'f.txt': 'a\n' }, 'One');
    const id = await openRepo(repo);
    for (const path of ['*.txt', 'f.*', '?.txt', ':(glob)*.txt']) {
      const r = await call('GET', `/api/repos/${id}/file-history?${q({ sha, path })}`);
      refused(r);
      expect(r.body.entries).toBeUndefined();
    }
  });

  it('audit security 1: sha is checked against the hex rule first (400), for file-history and blame; no option or revision expression gets through', async () => {
    const repo = newRepo('viewing-shas');
    const sha = commit(repo, { 'f.txt': 'a\n' }, 'One');
    const id = await openRepo(repo);
    const marker = join(fresh('viewing-marker-sha'), 'out.txt');
    const bad = ['', 'HEAD', 'main', 'HEAD~0', `${sha}^`, `${sha}:f.txt`, `${sha}..${sha}`, '--output=' + fwd(marker), '--all', '-n1', ' ' + sha, sha + ' ', 'g'.repeat(40), 'a'.repeat(6), 'a'.repeat(65), ':/One'];
    for (const route of ['file-history', 'blame']) {
      for (const b of bad) {
        expect((await call('GET', `/api/repos/${id}/${route}?${q({ sha: b, path: 'f.txt' })}`)).status, `${route} sha=${b}`).toBe(400);
      }
      expect((await call('GET', `/api/repos/${id}/${route}?${q({ path: 'f.txt' })}`)).status, `${route} no sha`).toBe(400);
    }
    expect(existsSync(marker)).toBe(false);
    expect((await call('GET', `/api/repos/${id}/file-history?${q({ sha, path: 'f.txt' })}`)).status).toBe(200); // alive
  });
});
