import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getHistory } from './history';
import { readOpState } from './opState';
import { stashApply, stashDrop, stashFiles, stashPush } from './stash';

/*
 * Contract the builder must export from server/src/git/stash.ts (every function takes the repo root, runs through
 * runExclusive + the runner, and never throws for a git failure; it returns a result):
 *   stashPush(root, opts?: { message?: string; fromTab?: boolean }): Promise<StashResult>
 *       no opts / no message  = toolbar form: `stash push --include-untracked` (git's own "WIP on <branch>: ..." message)
 *       fromTab: true         = Stash tab form: the server reads the STAGED paths itself and stashes only those
 *                               (`-m <message> --pathspec-from-file=- --pathspec-file-nul`, `--` before pathspecs)
 *       Returns sha = the new stash commit, base = HEAD at the time.
 *   stashApply(root, sha, pop: boolean): Promise<StashResult>      sha is resolved to stash@{n} inside the lock
 *   stashDrop(root, sha): Promise<StashResult>
 *   stashFiles(root, sha): Promise<{ outcome: 'done'; files: { path: string; status: 'M' | 'A' | 'D' | 'R'; oldPath?: string }[] } | { outcome: 'not-found' | 'invalid' }>
 *       tracked files from `diff-tree -r -z --name-status -M sha^1 sha`, untracked ones from `ls-tree sha^3` marked 'A'
 *   StashResult = { outcome: 'done' | 'conflict' | 'failed' | 'blocked' | 'refused' | 'not-found' | 'invalid';
 *                   error?: string; stderr?: string; sha?: string; base?: string }
 *       blocked   = an op is in progress or anything is unmerged (route 409), nothing changed
 *       refused   = a precondition failed (route 409): apply/pop with anything staged; Stash tab with nothing staged
 *       invalid   = bad input (route 400): sha not 40-64 lowercase hex, message over 8 KB / has NUL / not well formed
 *       not-found = sha is not in `stash list` (route 404)
 *       conflict  = apply/pop left unmerged entries (the route's {conflict:true}); a pop then keeps the stash
 *       failed    = git itself refused (e.g. a dirty tree it would overwrite)
 *   readOpState(root) (opState.ts) must report { kind: 'stash' } when the only unfinished thing is unmerged entries left by an apply/pop.
 *   Before every drop or pop the server runs `update-ref refs/gitslappin/stash-keep/<sha> <sha>`.
 *   getHistory (history.ts) must leave refs/gitslappin/* out of the walk (`--exclude=refs/gitslappin/*` before `--all`).
 * Real git in mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted.
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');

function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const GLOBAL_CFG = join(fresh('gitcfg-stash'), 'global.gitconfig');
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
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com' });

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): number | null => spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true }).status;

const head = (repo: string): string => git(repo, ['rev-parse', 'HEAD']).trim();
const stashShas = (repo: string): string[] => git(repo, ['stash', 'list', '--format=%H']).split('\n').filter(Boolean);
const text = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8');
const keepRef = (sha: string): string => `refs/gitslappin/stash-keep/${sha}`;
const staged = (repo: string): string[] => git(repo, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
const unmerged = (repo: string): string[] => git(repo, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
const body = (repo: string, sha: string): string => git(repo, ['log', '-1', '--format=%B', sha]).trimEnd();

function write(repo: string, files: Record<string, string>): void {
  for (const [rel, t] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, t);
  }
}
function commit(repo: string, files: Record<string, string>, msg: string): string {
  write(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', msg]);
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

/** Everything a refused call must leave alone: HEAD, all refs, the index, and the bytes of every file outside .git. */
function snap(repo: string): { head: string; refs: string; index: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const rel of readdirSync(repo, { recursive: true }) as string[]) {
    if (rel === '.git' || rel.startsWith('.git\\') || rel.startsWith('.git/')) continue;
    const full = join(repo, rel);
    if (statSync(full).isFile()) files[rel.replace(/\\/g, '/')] = readFileSync(full).toString('base64');
  }
  return {
    head: head(repo),
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
    index: git(repo, ['ls-files', '-s']),
    files,
  };
}

const BASE = { 'a.txt': 'a1\na2\na3\n', 'b.txt': 'b1\nb2\n', 'dir/c.txt': 'c1\n' };

/** main with one commit 'Base'. */
function baseRepo(): string {
  const repo = newRepo('stash-int');
  commit(repo, BASE, 'Base');
  return repo;
}
/** baseRepo plus: a.txt modified (unstaged), dir/c.txt deleted, u.txt untracked. */
function dirtyRepo(): string {
  const repo = baseRepo();
  write(repo, { 'a.txt': 'a1\na2 EDITED\na3\n', 'u.txt': 'untracked bytes\n' });
  git(repo, ['rm', '-q', '--', 'dir/c.txt']);
  git(repo, ['reset', '-q', '--', 'dir/c.txt']); // keep the delete unstaged
  return repo;
}
const DIRTY_A = 'a1\na2 EDITED\na3\n';

describe('stash push', () => {
  it('toolbar form: stashes tracked edits, a deletion and untracked files with git\'s default message, tree left clean', async () => {
    const repo = dirtyRepo();
    const base = head(repo);
    const r = await stashPush(repo);
    expect(r.outcome).toBe('done');
    expect(r.base).toBe(base);
    expect(stashShas(repo)).toEqual([r.sha]);
    expect(body(repo, r.sha!)).toMatch(/^WIP on main: [0-9a-f]{7,} Base$/);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(repo, 'u.txt'))).toBe(false);
    expect(text(repo, 'a.txt')).toBe(BASE['a.txt']);
    expect(existsSync(join(repo, 'dir/c.txt'))).toBe(true);
    // the untracked file is in the third parent
    expect(git(repo, ['ls-tree', '-r', '--name-only', `${r.sha}^3`]).trim()).toBe('u.txt');
    expect(head(repo)).toBe(base);
  });

  it('on a clean tree: nothing is created and nothing changes', async () => {
    const repo = baseRepo();
    const before = snap(repo);
    const r = await stashPush(repo);
    expect(r.outcome).not.toBe('done');
    expect(stashShas(repo)).toEqual([]);
    expect(snap(repo)).toEqual(before);
  });

  it('Stash tab form: stashes only the staged paths, other edits and untracked files stay', async () => {
    const repo = dirtyRepo();
    write(repo, { 'b.txt': 'b1\nb2 EDITED\n' });
    git(repo, ['add', '--', 'a.txt']);
    const r = await stashPush(repo, { message: 'Tab stash\n\nwith a description', fromTab: true });
    expect(r.outcome).toBe('done');
    expect(body(repo, r.sha!)).toBe('On main: Tab stash\n\nwith a description');
    expect(git(repo, ['diff-tree', '-r', '--name-only', '--no-commit-id', `${r.sha}^1`, r.sha!]).trim()).toBe('a.txt');
    expect(text(repo, 'a.txt')).toBe(BASE['a.txt']);
    expect(text(repo, 'b.txt')).toBe('b1\nb2 EDITED\n'); // not staged -> untouched
    expect(text(repo, 'u.txt')).toBe('untracked bytes\n');
    expect(staged(repo)).toEqual([]);
  });

  it('Stash tab form with partial staging: the whole file (staged and unstaged part) is stashed', async () => {
    const repo = baseRepo();
    write(repo, { 'a.txt': 'a1 STAGED\na2\na3\n' });
    git(repo, ['add', '--', 'a.txt']);
    write(repo, { 'a.txt': 'a1 STAGED\na2\na3 UNSTAGED\n' });
    const r = await stashPush(repo, { message: 'partial', fromTab: true });
    expect(r.outcome).toBe('done');
    expect(git(repo, ['show', `${r.sha}:a.txt`])).toBe('a1 STAGED\na2\na3 UNSTAGED\n');
    expect(text(repo, 'a.txt')).toBe(BASE['a.txt']);
  });

  it('Stash tab form with nothing staged is refused and changes nothing', async () => {
    const repo = dirtyRepo();
    const before = snap(repo);
    const r = await stashPush(repo, { message: 'nothing staged', fromTab: true });
    expect(['refused', 'failed']).toContain(r.outcome);
    expect(stashShas(repo)).toEqual([]);
    expect(snap(repo)).toEqual(before);
  });

  it('Stash tab form refuses staged conflicted files (unmerged) with a 409-style blocked result', async () => {
    const repo = baseRepo();
    git(repo, ['switch', '-c', 'side']);
    commit(repo, { 'a.txt': 'side\n' }, 'Side');
    git(repo, ['switch', 'main']);
    commit(repo, { 'a.txt': 'main\n' }, 'Main');
    expect(tryGit(repo, ['merge', 'side'])).not.toBe(0);
    const before = snap(repo);
    const r = await stashPush(repo, { message: 'x', fromTab: true });
    expect(r.outcome).toBe('blocked');
    expect((await stashPush(repo)).outcome).toBe('blocked');
    expect(stashShas(repo)).toEqual([]);
    expect(snap(repo)).toEqual(before);
  });

  it('message cap: exactly 8 KB is accepted, one byte more is invalid; NUL and lone surrogates are invalid; all leave the repo untouched', async () => {
    const repo = dirtyRepo();
    const before = snap(repo);
    for (const bad of ['a'.repeat(8193), 'has\0nul', 'lone \ud800 surrogate']) {
      const r = await stashPush(repo, { message: bad });
      expect(r.outcome).toBe('invalid');
      expect(stashShas(repo)).toEqual([]);
      expect(snap(repo)).toEqual(before);
    }
    const ok = await stashPush(repo, { message: 'a'.repeat(8192) });
    expect(ok.outcome).toBe('done'); // the invalid calls above did not consume or alter the changes
    expect(body(repo, ok.sha!)).toBe(`On main: ${'a'.repeat(8192)}`);
  });

  it('a message that looks like an option is stored literally (always the value after -m)', async () => {
    const repo = dirtyRepo();
    const r = await stashPush(repo, { message: '--all' });
    expect(r.outcome).toBe('done');
    expect(body(repo, r.sha!)).toBe('On main: --all');
    expect(stashShas(repo)).toHaveLength(1);
  });
});

describe('stash apply / pop', () => {
  it('apply round trip: tracked, deleted and untracked changes come back byte for byte, the stash stays', async () => {
    const repo = dirtyRepo();
    const original = snap(repo);
    const r = await stashPush(repo);
    const a = await stashApply(repo, r.sha!, false);
    expect(a.outcome).toBe('done');
    expect(stashShas(repo)).toEqual([r.sha]);
    expect(snap(repo).files).toEqual(original.files);
    expect(text(repo, 'u.txt')).toBe('untracked bytes\n');
  });

  it('pop round trip: changes come back, the entry is dropped, and the keep ref still holds the commit', async () => {
    const repo = dirtyRepo();
    const original = snap(repo);
    const r = await stashPush(repo);
    const p = await stashApply(repo, r.sha!, true);
    expect(p.outcome).toBe('done');
    expect(stashShas(repo)).toEqual([]);
    expect(snap(repo).files).toEqual(original.files);
    expect(git(repo, ['rev-parse', '--verify', keepRef(r.sha!)]).trim()).toBe(r.sha);
  });

  it('drop removes the entry but the keep ref exists and the commit can be read', async () => {
    const repo = dirtyRepo();
    const r = await stashPush(repo, { message: 'to drop' });
    const before = snap(repo);
    const d = await stashDrop(repo, r.sha!);
    expect(d.outcome).toBe('done');
    expect(stashShas(repo)).toEqual([]);
    expect(git(repo, ['rev-parse', '--verify', keepRef(r.sha!)]).trim()).toBe(r.sha);
    expect(tryGit(repo, ['cat-file', '-e', r.sha!])).toBe(0);
    expect(body(repo, r.sha!)).toBe('On main: to drop');
    expect({ ...snap(repo), refs: '' }).toEqual({ ...before, refs: '' }); // working tree, index, HEAD untouched by a drop
  });

  it('refs/gitslappin/* never shows up in the graph history (keep ref after a drop)', async () => {
    const repo = dirtyRepo();
    const r = await stashPush(repo, { message: 'hidden after drop' });
    const idx = git(repo, ['rev-parse', `${r.sha}^2`]).trim();
    const untrackedParent = git(repo, ['rev-parse', `${r.sha}^3`]).trim();
    await stashDrop(repo, r.sha!);
    expect(tryGit(repo, ['show-ref', '--verify', '--quiet', keepRef(r.sha!)])).toBe(0);
    const h = await getHistory(repo, `test-stash-hist-${r.sha}`);
    const shas = h.commits.map((c) => c.sha);
    expect(shas).toHaveLength(1); // just Base
    for (const hidden of [r.sha!, idx, untrackedParent]) expect(shas).not.toContain(hidden);
  });

  it('apply is refused while anything is staged: exact message, nothing changes, stash and refs untouched', async () => {
    const repo = dirtyRepo();
    const r = await stashPush(repo);
    write(repo, { 'b.txt': 'b1\nb2 STAGED\n' });
    git(repo, ['add', '--', 'b.txt']);
    const before = snap(repo);
    for (const pop of [false, true]) {
      const a = await stashApply(repo, r.sha!, pop);
      expect(a.outcome).toBe('refused');
      expect(a.error).toBe('Cannot apply stash while anything is staged. Stash, commit, or unstage first.'); // ErrorMessage-CannotApplyStashWhenFilesAreStaged
      expect(snap(repo)).toEqual(before);
    }
    expect(stashShas(repo)).toEqual([r.sha]);
  });

  it('git refuses a dirty apply: no force flags, local edits keep their bytes, the stash is kept', async () => {
    const repo = dirtyRepo();
    const r = await stashPush(repo);
    write(repo, { 'a.txt': 'local uncommitted edit\n' }); // would be overwritten by the stash
    const before = snap(repo);
    for (const pop of [false, true]) {
      const a = await stashApply(repo, r.sha!, pop);
      expect(a.outcome).toBe('failed');
      expect(snap(repo).files).toEqual(before.files);
      expect(snap(repo).index).toBe(before.index);
      expect(snap(repo).head).toBe(before.head);
      expect(stashShas(repo)).toEqual([r.sha]);
    }
    expect(text(repo, 'a.txt')).toBe('local uncommitted edit\n');
  });

  it('git refuses to overwrite an untracked file of the same name when applying ^3 files', async () => {
    const repo = dirtyRepo();
    const r = await stashPush(repo);
    write(repo, { 'u.txt': 'a different untracked file\n' });
    const before = snap(repo);
    const a = await stashApply(repo, r.sha!, true);
    expect(a.outcome).toBe('failed');
    expect(text(repo, 'u.txt')).toBe('a different untracked file\n');
    expect(snap(repo).files).toEqual(before.files);
    expect(stashShas(repo)).toEqual([r.sha]);
  });

  it('a dirty tree with unrelated edits is allowed (the client confirms first); the unrelated edit is kept', async () => {
    const repo = dirtyRepo();
    const r = await stashPush(repo);
    write(repo, { 'b.txt': 'b1\nb2 LOCAL\n' });
    const a = await stashApply(repo, r.sha!, false);
    expect(a.outcome).toBe('done');
    expect(text(repo, 'b.txt')).toBe('b1\nb2 LOCAL\n');
    expect(text(repo, 'a.txt')).toBe(DIRTY_A);
  });

  it('pop with a conflict reports conflict, keeps the stash, leaves unmerged entries, and readOpState says stash', async () => {
    const repo = baseRepo();
    write(repo, { 'a.txt': 'a1\nSTASHED\na3\n' });
    const r = await stashPush(repo);
    commit(repo, { 'a.txt': 'a1\nCOMMITTED\na3\n' }, 'Conflicting change');
    const p = await stashApply(repo, r.sha!, true);
    expect(p.outcome).toBe('conflict');
    expect(stashShas(repo)).toEqual([r.sha]); // git keeps the entry when the pop conflicts
    expect(unmerged(repo)).toEqual(['a.txt']);
    expect(git(repo, ['rev-parse', '--verify', keepRef(r.sha!)]).trim()).toBe(r.sha);
    expect((await readOpState(repo))?.kind).toBe('stash');
    // while unmerged, every further stash operation is blocked and changes nothing
    const before = snap(repo);
    expect((await stashApply(repo, r.sha!, false)).outcome).toBe('blocked');
    expect((await stashDrop(repo, r.sha!)).outcome).toBe('blocked');
    expect((await stashPush(repo)).outcome).toBe('blocked');
    expect(snap(repo)).toEqual(before);
  });

  it('pop by sha still hits the right entry after the indexes shift', async () => {
    const repo = baseRepo();
    write(repo, { 'a.txt': 'first stash\n' });
    const first = await stashPush(repo, { message: 'first' });
    write(repo, { 'b.txt': 'second stash\n' });
    const second = await stashPush(repo, { message: 'second' });
    expect(stashShas(repo)).toEqual([second.sha, first.sha]); // first is now stash@{1}
    const p = await stashApply(repo, first.sha!, true);
    expect(p.outcome).toBe('done');
    expect(text(repo, 'a.txt')).toBe('first stash\n');
    expect(text(repo, 'b.txt')).toBe(BASE['b.txt']);
    expect(stashShas(repo)).toEqual([second.sha]);
    // a third stash shifts the remaining one; drop by sha removes exactly that one
    write(repo, { 'a.txt': 'third stash\n' });
    const third = await stashPush(repo, { message: 'third' });
    expect(stashShas(repo)).toEqual([third.sha, second.sha]);
    expect((await stashDrop(repo, second.sha!)).outcome).toBe('done');
    expect(stashShas(repo)).toEqual([third.sha]);
  });

  it('a sha that is not in the stash list is not-found and changes nothing; malformed shas are invalid', async () => {
    const repo = dirtyRepo();
    const r = await stashPush(repo);
    const before = snap(repo);
    const regular = head(repo);
    expect((await stashApply(repo, regular, true)).outcome).toBe('not-found'); // a commit, but not a stash
    expect((await stashDrop(repo, '0'.repeat(40))).outcome).toBe('not-found');
    for (const bad of ['stash@{0}', '--all', r.sha!.slice(0, 7), r.sha!.slice(0, 39), r.sha!.toUpperCase(), `${r.sha}\n`, '']) {
      expect((await stashApply(repo, bad, true)).outcome).toBe('invalid');
      expect((await stashDrop(repo, bad)).outcome).toBe('invalid');
      expect((await stashFiles(repo, bad)).outcome).toBe('invalid');
    }
    expect(snap(repo)).toEqual(before);
    expect(stashShas(repo)).toEqual([r.sha]);
  });
});

describe('stash contents (GET /stash/:sha)', () => {
  it('lists tracked changes by status and untracked files from ^3 as added', async () => {
    const repo = dirtyRepo();
    git(repo, ['mv', 'b.txt', 'b-renamed.txt']);
    git(repo, ['reset', '-q']);
    write(repo, { 'only-untracked/deep/n.txt': 'n\n' });
    const r = await stashPush(repo);
    const res = await stashFiles(repo, r.sha!);
    if (res.outcome !== 'done') throw new Error(`expected done, got ${res.outcome}`);
    const byPath = new Map(res.files.map((f) => [f.path, f.status]));
    expect(byPath.get('a.txt')).toBe('M');
    expect(byPath.get('dir/c.txt')).toBe('D');
    expect(byPath.get('u.txt')).toBe('A');
    expect(byPath.get('only-untracked/deep/n.txt')).toBe('A');
    expect(res.files.filter((f) => f.path === 'u.txt')).toHaveLength(1);
  });

  it('a stash with only untracked files still lists them', async () => {
    const repo = baseRepo();
    write(repo, { 'new1.txt': '1\n', 'new2.txt': '2\n' });
    const r = await stashPush(repo);
    const res = await stashFiles(repo, r.sha!);
    if (res.outcome !== 'done') throw new Error(`expected done, got ${res.outcome}`);
    expect(res.files.map((f) => f.path).sort()).toEqual(['new1.txt', 'new2.txt']);
  });

  it('reading a sha that is no longer in the stash list is not-found even though the object and keep ref exist', async () => {
    const repo = dirtyRepo();
    const r = await stashPush(repo);
    await stashDrop(repo, r.sha!);
    expect(tryGit(repo, ['cat-file', '-e', r.sha!])).toBe(0);
    expect((await stashFiles(repo, r.sha!)).outcome).toBe('not-found');
  });
});

describe('409 while an operation is in progress', () => {
  it('merge in progress: push, apply, pop and drop are all blocked and change nothing', async () => {
    const repo = baseRepo();
    write(repo, { 'b.txt': 'to stash\n' });
    const r = await stashPush(repo);
    git(repo, ['switch', '-c', 'side']);
    commit(repo, { 'a.txt': 'side\n' }, 'Side');
    git(repo, ['switch', 'main']);
    commit(repo, { 'a.txt': 'main\n' }, 'Main');
    expect(tryGit(repo, ['merge', 'side'])).not.toBe(0);
    write(repo, { 'extra.txt': 'untracked during merge\n' });
    const before = snap(repo);
    expect((await stashPush(repo)).outcome).toBe('blocked');
    expect((await stashApply(repo, r.sha!, false)).outcome).toBe('blocked');
    expect((await stashApply(repo, r.sha!, true)).outcome).toBe('blocked');
    expect((await stashDrop(repo, r.sha!)).outcome).toBe('blocked');
    expect(snap(repo)).toEqual(before);
    expect(stashShas(repo)).toEqual([r.sha]);
  });
});

describe('phase 9 review fixes (apply/pop pre-check, Stash tab deletion)', () => {
  it.skipIf(process.platform !== 'win32')('1. the pre-check compares paths without regard to case on win32', async () => {
    const repo = baseRepo();
    commit(repo, { 'File.txt': 'f1\n' }, 'Add File.txt');
    write(repo, { 'File.txt': 'f1 stashed edit\n' });
    const r = await stashPush(repo);
    expect(r.outcome).toBe('done');
    git(repo, ['mv', 'File.txt', 'tmp-name.txt']);
    git(repo, ['mv', 'tmp-name.txt', 'file.txt']);
    git(repo, ['commit', '-m', 'Rename File.txt to file.txt (case only)']);
    write(repo, { 'file.txt': 'local edit under the other case\n' });
    const before = snap(repo);
    const a = await stashApply(repo, r.sha!, false);
    expect(a.outcome).toBe('failed');
    expect(snap(repo)).toEqual(before);
    expect(stashShas(repo)).toEqual([r.sha]);
  });

  it('2. a file where the stash needs a directory is refused before anything is applied (ENOTDIR)', async () => {
    const repo = baseRepo();
    write(repo, { 'a.txt': 'a1\na2 EDITED\na3\n', 'sub/inner.txt': 'inner untracked\n' });
    const r = await stashPush(repo);
    expect(r.outcome).toBe('done');
    write(repo, { sub: 'a plain file named like the stash directory\n' });
    const before = snap(repo);
    const a = await stashApply(repo, r.sha!, true);
    expect(a.outcome).toBe('failed');
    expect(a.stderr).toContain('sub/inner.txt');
    expect(snap(repo)).toEqual(before); // the tracked edit of a.txt was not applied either
    expect(stashShas(repo)).toEqual([r.sha]);
  });

  it('3. an ignored file at a path the stash changes counts as local data and blocks the apply', async () => {
    const repo = newRepo('stash-ignored');
    commit(repo, { '.gitignore': '*.dat\n', 'a.txt': 'a\n' }, 'Base');
    write(repo, { 'gen.dat': 'tracked gen\n' });
    git(repo, ['add', '-f', 'gen.dat']);
    git(repo, ['commit', '-m', 'Track gen.dat']);
    write(repo, { 'gen.dat': 'tracked gen edited\n' });
    const r = await stashPush(repo);
    expect(r.outcome).toBe('done');
    git(repo, ['rm', '--cached', '-q', 'gen.dat']);
    git(repo, ['commit', '-m', 'Untrack gen.dat']);
    write(repo, { 'gen.dat': 'my ignored bytes\n' });
    expect(git(repo, ['status', '--porcelain=v1', '--ignored']).includes('!! gen.dat')).toBe(true);
    const before = snap(repo);
    const a = await stashApply(repo, r.sha!, true);
    expect(a.outcome).toBe('failed');
    expect(a.stderr).toContain('gen.dat');
    expect(snap(repo)).toEqual(before);
    expect(text(repo, 'gen.dat')).toBe('my ignored bytes\n');
  });

  it('4. a staged deletion can be stashed from the Stash tab, and popping it brings the deletion back', async () => {
    const repo = baseRepo();
    git(repo, ['rm', '-q', '--', 'b.txt']);
    expect(git(repo, ['diff', '--cached', '--name-status']).trim()).toBe('D\tb.txt');
    const r = await stashPush(repo, { fromTab: true, message: 'drop b' });
    expect(r.outcome).toBe('done');
    expect(stashShas(repo)).toEqual([r.sha]);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(text(repo, 'b.txt')).toBe(BASE['b.txt']);
    const p = await stashApply(repo, r.sha!, true);
    expect(p.outcome).toBe('done');
    expect(existsSync(join(repo, 'b.txt'))).toBe(false);
    expect(stashShas(repo)).toEqual([]);
  });

  it('4b. a staged deletion together with other staged files: only the staged files are stashed, unstaged edits and untracked files stay', async () => {
    const repo = baseRepo();
    git(repo, ['rm', '-q', '--', 'b.txt']);
    write(repo, { 'new.txt': 'staged new\n' });
    git(repo, ['add', 'new.txt']);
    write(repo, { 'a.txt': 'a1\na2 UNSTAGED EDIT\na3\n', 'u.txt': 'untracked\n' });
    const r = await stashPush(repo, { fromTab: true, message: 'staged only' });
    expect(r.outcome).toBe('done');
    expect(git(repo, ['status', '--porcelain']).split('\n').filter(Boolean).sort()).toEqual([' M a.txt', '?? u.txt']);
    expect(text(repo, 'a.txt')).toBe('a1\na2 UNSTAGED EDIT\na3\n');
    expect(text(repo, 'b.txt')).toBe(BASE['b.txt']);
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
    expect(git(repo, ['diff', '--name-status', `${r.sha}^1`, r.sha!]).split('\n').filter(Boolean).sort()).toEqual(['A\tnew.txt', 'D\tb.txt']);
  });
});
