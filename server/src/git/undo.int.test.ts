import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stashApply, stashDrop, stashPush } from './stash';
import { clearRedo, forgetRepo, record, redo, undo, undoState } from './undo';

/*
 * Contract the builder must export from server/src/git/undo.ts. The journal is in memory, keyed by the repo ROOT string
 * the caller passes (never by anything the client sends). Every function runs inside runExclusive for that repo.
 *   record(root, entry: UndoEntry): void      what the mutating routes call after they succeeded (also clears that root's redo list)
 *     UndoEntry =
 *       | { kind: 'commit'; sha: string; prev: string | null; branch: string | null; subject: string }   prev = parent before the commit (null = root commit)
 *       | { kind: 'checkout'; from: { branch: string | null; sha: string }; to: { branch: string | null; sha: string }; createdBranch?: string }
 *       | { kind: 'create-branch'; name: string; sha: string; from: { branch: string | null; sha: string }; checkedOut: boolean }
 *     (stash, pop and drop entries are recorded by stash.ts itself, inside stashPush / stashApply / stashDrop)
 *   clearRedo(root): void                     what push / fetch / pull / merge / rebase / remote delete call (non-recorded mutations)
 *   undoState(root): { undo: { label: string } | null; redo: { label: string } | null }
 *   undo(root) / redo(root): Promise<UndoResult>
 *   forgetRepo(root): void                    drops the journal of that root only
 *   UndoResult = { outcome: 'done' | 'refused' | 'failed' | 'blocked'; label?: string; error?: string }
 *     refused = a precondition failed (route 409 with the reason in error), nothing changed; nothing to undo/redo is also 'refused'
 *     blocked = an op is in progress or anything is unmerged (route 409), nothing changed
 *   Labels (spec wording, UndoValidButtonTooltip = "Undo {0}"): "commit '<subject>'", "checkout '<branch>'" (the branch checked out;
 *     UNVERIFIED for a detached target: this file does not assert it), "create branch '<name>'", "stash", "pop stash", "delete stash".
 *   Journal limits: 100 entries per repo (oldest dropped), 20 repos (least recently used dropped).
 * Real git in mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted (the one gc below runs inside a throwaway repo).
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');

function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const GLOBAL_CFG = join(fresh('gitcfg-undo'), 'global.gitconfig');
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
const branchNow = (repo: string): string => git(repo, ['branch', '--show-current']).trim();
const refSha = (repo: string, ref: string): string | null => {
  const r = spawnSync('git', ['rev-parse', '--verify', '-q', ref], { cwd: repo, env: ENV, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};
const stashLines = (repo: string): string[] => git(repo, ['stash', 'list', '--format=%H %gs']).split('\n').filter(Boolean);
const text = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8');
const treeOf = (repo: string, rev: string): string => git(repo, ['rev-parse', `${rev}^{tree}`]).trim();
const dirty = (repo: string): string => git(repo, ['status', '--porcelain=v1', '-uall']);

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
function snap(repo: string): { head: string; branch: string; refs: string; index: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const rel of readdirSync(repo, { recursive: true }) as string[]) {
    if (rel === '.git' || rel.startsWith('.git\\') || rel.startsWith('.git/')) continue;
    const full = join(repo, rel);
    if (statSync(full).isFile()) files[rel.replace(/\\/g, '/')] = readFileSync(full).toString('base64');
  }
  return {
    head: head(repo),
    branch: branchNow(repo),
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
    index: git(repo, ['ls-files', '-s']),
    files,
  };
}

/** main: C1 'Base' (a.txt, b.txt). */
function baseRepo(): { repo: string; c1: string } {
  const repo = newRepo('undo-int');
  const c1 = commit(repo, { 'a.txt': 'a1\n', 'b.txt': 'b1\n' }, 'Base');
  return { repo, c1 };
}
/** main: Base, then a recorded commit "Fix login". */
function committed(): { repo: string; c1: string; c2: string } {
  const { repo, c1 } = baseRepo();
  const c2 = commit(repo, { 'a.txt': 'a1\na2 login fix\n' }, 'Fix login');
  record(repo, { kind: 'commit', sha: c2, prev: c1, branch: 'main', subject: 'Fix login' });
  return { repo, c1, c2 };
}

const MISSING = 'Undo information is missing - it has likely been garbage collected.'; // UndoRedo-InformationMissing
const NOT_FOUND = 'Reference or commit to checkout was not found'; // UndoRedo-UndoCheckoutNotFound

describe('commit', () => {
  it('round trip: undo is a soft reset (changes stay staged), redo commits the same tree and message', async () => {
    const { repo, c1, c2 } = committed();
    expect(undoState(repo)).toEqual({ undo: { label: "commit 'Fix login'" }, redo: null });
    const u = await undo(repo);
    expect(u.outcome).toBe('done');
    expect(head(repo)).toBe(c1);
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('a.txt'); // soft: still staged
    expect(text(repo, 'a.txt')).toBe('a1\na2 login fix\n');
    expect(undoState(repo)).toEqual({ undo: null, redo: { label: "commit 'Fix login'" } });
    const r = await redo(repo);
    expect(r.outcome).toBe('done');
    expect(treeOf(repo, 'HEAD')).toBe(treeOf(repo, c2));
    expect(git(repo, ['log', '-1', '--format=%B']).trim()).toBe('Fix login');
    expect(git(repo, ['rev-parse', 'HEAD^']).trim()).toBe(c1);
    expect(dirty(repo)).toBe('');
    expect(undoState(repo).undo).toEqual({ label: "commit 'Fix login'" });
    expect(undoState(repo).redo).toBeNull();
  });

  it('undo is refused (nothing changes) when HEAD moved on, the branch changed, or HEAD is not a child of prev', async () => {
    // HEAD moved on
    let fx = committed();
    commit(fx.repo, { 'b.txt': 'b2\n' }, 'Another commit made outside GitSlappin');
    let before = snap(fx.repo);
    let u = await undo(fx.repo);
    expect(u.outcome).toBe('refused');
    expect(u.error).toBeTruthy();
    expect(snap(fx.repo)).toEqual(before);
    // branch changed (same commit, other branch)
    fx = committed();
    git(fx.repo, ['switch', '-c', 'other']);
    before = snap(fx.repo);
    u = await undo(fx.repo);
    expect(u.outcome).toBe('refused');
    expect(snap(fx.repo)).toEqual(before);
    // HEAD amended outside GitSlappin: same branch, HEAD != recorded sha
    fx = committed();
    git(fx.repo, ['commit', '--amend', '-m', 'Fix login (amended elsewhere)']);
    before = snap(fx.repo);
    u = await undo(fx.repo);
    expect(u.outcome).toBe('refused');
    expect(snap(fx.repo)).toEqual(before);
  });

  it('a root commit cannot be undone', async () => {
    const repo = newRepo('undo-root');
    const c1 = commit(repo, { 'a.txt': 'a1\n' }, 'Root');
    record(repo, { kind: 'commit', sha: c1, prev: null, branch: 'main', subject: 'Root' });
    const before = snap(repo);
    const u = await undo(repo);
    expect(u.outcome).toBe('refused');
    expect(snap(repo)).toEqual(before);
  });

  it('redo is refused when the index no longer matches the commit tree, or HEAD is not prev; nothing changes', async () => {
    // index differs
    let fx = committed();
    await undo(fx.repo);
    write(fx.repo, { 'a.txt': 'a1\ndifferent staged content\n' });
    git(fx.repo, ['add', '-A']);
    let before = snap(fx.repo);
    let r = await redo(fx.repo);
    expect(r.outcome).toBe('refused');
    expect(snap(fx.repo)).toEqual(before);
    // HEAD moved (a commit made directly with git, which GitSlappin did not record)
    fx = committed();
    await undo(fx.repo);
    git(fx.repo, ['reset', '-q']);
    git(fx.repo, ['checkout', '-q', '--', 'a.txt']);
    commit(fx.repo, { 'b.txt': 'b2\n' }, 'Outside commit');
    write(fx.repo, { 'a.txt': 'a1\na2 login fix\n' });
    git(fx.repo, ['add', '-A']);
    before = snap(fx.repo);
    r = await redo(fx.repo);
    expect(r.outcome).toBe('refused');
    expect(snap(fx.repo)).toEqual(before);
  });

  it('with nothing recorded, undo and redo are refused with the "Cannot undo" / "Cannot redo" texts', async () => {
    const { repo } = baseRepo();
    const before = snap(repo);
    expect(undoState(repo)).toEqual({ undo: null, redo: null });
    const u = await undo(repo);
    const r = await redo(repo);
    expect([u.outcome, u.error]).toEqual(['refused', 'Cannot undo']); // UndoCannotButtonTooltip
    expect([r.outcome, r.error]).toEqual(['refused', 'Cannot redo']); // RedoCannotButtonTooltip
    expect(snap(repo)).toEqual(before);
  });
});

describe('checkout', () => {
  function checkedOut(): { repo: string; c1: string; c2: string } {
    const { repo, c1 } = baseRepo();
    git(repo, ['switch', '-c', 'feature']);
    const c2 = commit(repo, { 'b.txt': 'b on feature\n' }, 'Feature work');
    git(repo, ['switch', 'main']);
    git(repo, ['switch', 'feature']);
    record(repo, { kind: 'checkout', from: { branch: 'main', sha: c1 }, to: { branch: 'feature', sha: c2 } });
    return { repo, c1, c2 };
  }

  it('round trip: undo switches back, redo switches again, without force', async () => {
    const { repo, c1, c2 } = checkedOut();
    expect(undoState(repo).undo).toEqual({ label: "checkout 'feature'" });
    expect((await undo(repo)).outcome).toBe('done');
    expect([branchNow(repo), head(repo)]).toEqual(['main', c1]);
    expect(undoState(repo).redo).toEqual({ label: "checkout 'feature'" });
    expect((await redo(repo)).outcome).toBe('done');
    expect([branchNow(repo), head(repo)]).toEqual(['feature', c2]);
  });

  it('undo is refused on a dirty tree (git is never forced) and keeps every byte', async () => {
    const { repo } = checkedOut();
    write(repo, { 'a.txt': 'a1\nuncommitted edit\n', 'untracked.txt': 'u\n' });
    const before = snap(repo);
    const u = await undo(repo);
    expect(u.outcome).toBe('refused');
    expect(snap(repo)).toEqual(before);
  });

  it('undo is refused when HEAD or the branch is no longer what the checkout produced', async () => {
    let fx = checkedOut();
    commit(fx.repo, { 'b.txt': 'moved on\n' }, 'Commit after checkout');
    let before = snap(fx.repo);
    expect((await undo(fx.repo)).outcome).toBe('refused');
    expect(snap(fx.repo)).toEqual(before);
    fx = checkedOut();
    git(fx.repo, ['switch', '--detach', 'HEAD']);
    before = snap(fx.repo);
    expect((await undo(fx.repo)).outcome).toBe('refused');
    expect(snap(fx.repo)).toEqual(before);
  });

  it('undo when the previous branch was deleted: refused with the not-found text, nothing changes', async () => {
    const { repo } = checkedOut();
    git(repo, ['branch', '-D', 'main']);
    const before = snap(repo);
    const u = await undo(repo);
    expect(u.outcome).toBe('refused');
    expect(u.error).toBe(NOT_FOUND);
    expect(snap(repo)).toEqual(before);
  });

  it('checking out a commit (detached) can be undone back to the branch', async () => {
    const { repo, c1 } = baseRepo();
    const c2 = commit(repo, { 'b.txt': 'b2\n' }, 'Second');
    git(repo, ['switch', '--detach', c1]);
    record(repo, { kind: 'checkout', from: { branch: 'main', sha: c2 }, to: { branch: null, sha: c1 } });
    expect((await undo(repo)).outcome).toBe('done');
    expect([branchNow(repo), head(repo)]).toEqual(['main', c2]);
    expect((await redo(repo)).outcome).toBe('done');
    expect([branchNow(repo), head(repo)]).toEqual(['', c1]);
  });

  it('a checkout that created a branch: undo also removes that branch (compare-and-swap), redo recreates it', async () => {
    const { repo, c1 } = baseRepo();
    git(repo, ['switch', '-c', 'made-by-checkout']);
    record(repo, { kind: 'checkout', from: { branch: 'main', sha: c1 }, to: { branch: 'made-by-checkout', sha: c1 }, createdBranch: 'made-by-checkout' });
    expect((await undo(repo)).outcome).toBe('done');
    expect(branchNow(repo)).toBe('main');
    expect(refSha(repo, 'refs/heads/made-by-checkout')).toBeNull();
    expect(refSha(repo, 'main')).toBe(c1);
    expect((await redo(repo)).outcome).toBe('done');
    expect([branchNow(repo), head(repo)]).toEqual(['made-by-checkout', c1]);
  });
});

describe('create branch', () => {
  it('round trip: undo deletes the branch, redo recreates it at the same commit', async () => {
    const { repo, c1 } = baseRepo();
    git(repo, ['branch', 'topic', c1]);
    record(repo, { kind: 'create-branch', name: 'topic', sha: c1, from: { branch: 'main', sha: c1 }, checkedOut: false });
    expect(undoState(repo).undo).toEqual({ label: "create branch 'topic'" });
    expect((await undo(repo)).outcome).toBe('done');
    expect(refSha(repo, 'refs/heads/topic')).toBeNull();
    expect(undoState(repo).redo).toEqual({ label: "create branch 'topic'" });
    expect((await redo(repo)).outcome).toBe('done');
    expect(refSha(repo, 'refs/heads/topic')).toBe(c1);
  });

  it('when the new branch is checked out, undo switches back first', async () => {
    const { repo, c1 } = baseRepo();
    git(repo, ['switch', '-c', 'topic']);
    record(repo, { kind: 'create-branch', name: 'topic', sha: c1, from: { branch: 'main', sha: c1 }, checkedOut: true });
    expect((await undo(repo)).outcome).toBe('done');
    expect(branchNow(repo)).toBe('main');
    expect(refSha(repo, 'refs/heads/topic')).toBeNull();
    expect((await redo(repo)).outcome).toBe('done');
    expect(refSha(repo, 'refs/heads/topic')).toBe(c1);
  });

  it('undo is refused when the branch has moved: its commits are never thrown away', async () => {
    const { repo, c1 } = baseRepo();
    git(repo, ['branch', 'topic', c1]);
    record(repo, { kind: 'create-branch', name: 'topic', sha: c1, from: { branch: 'main', sha: c1 }, checkedOut: false });
    git(repo, ['switch', 'topic']);
    const c2 = commit(repo, { 'b.txt': 'work on topic\n' }, 'Work on topic');
    git(repo, ['switch', 'main']);
    const before = snap(repo);
    const u = await undo(repo);
    expect(u.outcome).toBe('refused');
    expect(snap(repo)).toEqual(before);
    expect(refSha(repo, 'refs/heads/topic')).toBe(c2);
  });
});

describe('stash, pop, drop', () => {
  function dirtyRepo(): string {
    const { repo } = baseRepo();
    write(repo, { 'a.txt': 'a1\nstashed edit\n', 'u.txt': 'untracked\n' });
    return repo;
  }

  it('stash: undo pops it back (untracked file too), redo stashes again with the same message', async () => {
    const repo = dirtyRepo();
    const before = snap(repo);
    const s = await stashPush(repo, { message: 'My stash' });
    expect(s.outcome).toBe('done');
    expect(undoState(repo).undo).toEqual({ label: 'stash' });
    expect((await undo(repo)).outcome).toBe('done');
    expect(snap(repo).files).toEqual(before.files);
    expect(stashLines(repo)).toEqual([]);
    expect(undoState(repo).redo).toEqual({ label: 'stash' });
    expect((await redo(repo)).outcome).toBe('done');
    expect(dirty(repo)).toBe('');
    const lines = stashLines(repo);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('On main: My stash');
  });

  it('stash undo is refused when the stash is gone, HEAD moved off the base, or the tree is dirty; nothing changes', async () => {
    // stash dropped outside GitSlappin
    let repo = dirtyRepo();
    let s = await stashPush(repo, { message: 's1' });
    git(repo, ['stash', 'drop', '-q']);
    let before = snap(repo);
    expect((await undo(repo)).outcome).toBe('refused');
    expect(snap(repo)).toEqual(before);
    // HEAD moved
    repo = dirtyRepo();
    s = await stashPush(repo, { message: 's2' });
    commit(repo, { 'b.txt': 'b2\n' }, 'Outside commit');
    before = snap(repo);
    expect((await undo(repo)).outcome).toBe('refused');
    expect(snap(repo)).toEqual(before);
    expect(stashLines(repo)).toHaveLength(1);
    // dirty tree
    repo = dirtyRepo();
    s = await stashPush(repo, { message: 's3' });
    write(repo, { 'b.txt': 'dirty again\n' });
    before = snap(repo);
    expect((await undo(repo)).outcome).toBe('refused');
    expect(snap(repo)).toEqual(before);
    expect(s.outcome).toBe('done');
  });

  it('pop: recorded when the tree was clean; undo stashes the result again, redo pops that new stash', async () => {
    const repo = dirtyRepo();
    const s = await stashPush(repo, { message: 'Pop me' });
    // the stash push is itself undoable; pop on top of it
    expect((await stashApply(repo, s.sha!, true)).outcome).toBe('done');
    expect(undoState(repo).undo).toEqual({ label: 'pop stash' });
    const afterPop = snap(repo);
    expect((await undo(repo)).outcome).toBe('done');
    expect(dirty(repo)).toBe('');
    expect(stashLines(repo)).toHaveLength(1);
    expect(undoState(repo).redo).toEqual({ label: 'pop stash' });
    expect((await redo(repo)).outcome).toBe('done');
    expect(snap(repo).files).toEqual(afterPop.files);
    expect(stashLines(repo)).toEqual([]);
  });

  it('pop is not recorded when the tree was dirty or the pop conflicted', async () => {
    // dirty tree before the pop
    const repo = dirtyRepo();
    const s = await stashPush(repo, { message: 'dirty pop' });
    clearJournal(repo);
    write(repo, { 'b.txt': 'local dirt\n' });
    expect((await stashApply(repo, s.sha!, true)).outcome).toBe('done');
    expect(undoState(repo).undo).toBeNull();
    // conflicting pop
    const fx = baseRepo();
    write(fx.repo, { 'a.txt': 'stashed\n' });
    const s2 = await stashPush(fx.repo, { message: 'conflict pop' });
    clearJournal(fx.repo);
    commit(fx.repo, { 'a.txt': 'committed\n' }, 'Conflicting');
    const p = await stashApply(fx.repo, s2.sha!, true);
    expect(p.outcome).toBe('conflict');
    expect(undoState(fx.repo).undo).toBeNull();
    expect(stashLines(fx.repo)).toHaveLength(1); // git kept it
  });

  it('pop undo is refused when HEAD, the tree or the untracked set changed since the pop; nothing changes', async () => {
    const make = async (): Promise<string> => {
      const repo = dirtyRepo();
      const s = await stashPush(repo, { message: 'p' });
      clearJournal(repo);
      await stashApply(repo, s.sha!, true);
      expect(undoState(repo).undo).toEqual({ label: 'pop stash' });
      return repo;
    };
    for (const change of [
      (r: string) => write(r, { 'a.txt': 'edited after the pop\n' }),
      (r: string) => write(r, { 'new-untracked.txt': 'x\n' }),
      (r: string) => {
        git(r, ['add', '-A']);
        git(r, ['commit', '-q', '-m', 'commit after pop']);
      },
    ]) {
      const repo = await make();
      change(repo);
      const before = snap(repo);
      expect((await undo(repo)).outcome).toBe('refused');
      expect(snap(repo)).toEqual(before);
    }
  });

  it('drop: undo stores the stash back with the same sha and message, redo drops it again; keep ref exists throughout', async () => {
    const repo = dirtyRepo();
    const s = await stashPush(repo, { message: 'Droppable' });
    clearJournal(repo);
    expect((await stashDrop(repo, s.sha!)).outcome).toBe('done');
    expect(stashLines(repo)).toEqual([]);
    expect(refSha(repo, `refs/gitslappin/stash-keep/${s.sha}`)).toBe(s.sha);
    expect(undoState(repo).undo).toEqual({ label: 'delete stash' });
    expect((await undo(repo)).outcome).toBe('done');
    expect(stashLines(repo)).toEqual([`${s.sha} On main: Droppable`]);
    expect(undoState(repo).redo).toEqual({ label: 'delete stash' });
    expect((await redo(repo)).outcome).toBe('done');
    expect(stashLines(repo)).toEqual([]);
    expect(refSha(repo, `refs/gitslappin/stash-keep/${s.sha}`)).toBe(s.sha);
  });

  it('drop undo: when the stash commit is really gone, 409 with the information-missing text and nothing changes', async () => {
    const repo = dirtyRepo();
    const s = await stashPush(repo, { message: 'Gone' });
    clearJournal(repo);
    await stashDrop(repo, s.sha!);
    // simulate garbage collection of the commit, inside this throwaway repo only
    git(repo, ['update-ref', '-d', `refs/gitslappin/stash-keep/${s.sha}`]);
    git(repo, ['reflog', 'expire', '--expire=now', '--all']);
    git(repo, ['gc', '--prune=now', '-q']);
    expect(tryGit(repo, ['cat-file', '-e', s.sha!])).not.toBe(0);
    const before = snap(repo);
    const u = await undo(repo);
    expect(u.outcome).toBe('refused');
    expect(u.error).toBe(MISSING);
    expect(snap(repo)).toEqual(before);
  });
});

/** Empties the undo side of the journal by undoing everything that is recorded; used to start a scenario from a known state. */
function clearJournal(repo: string): void {
  forgetRepo(repo);
}

describe('journal rules', () => {
  it('is keyed by repo root: another repo has its own (empty) history and cannot undo this one', async () => {
    const a = committed();
    const b = baseRepo();
    expect(undoState(b.repo)).toEqual({ undo: null, redo: null });
    const beforeB = snap(b.repo);
    expect((await undo(b.repo)).outcome).toBe('refused');
    expect(snap(b.repo)).toEqual(beforeB);
    expect(undoState(a.repo).undo).toEqual({ label: "commit 'Fix login'" });
    forgetRepo(b.repo);
    expect(undoState(a.repo).undo).toEqual({ label: "commit 'Fix login'" });
    forgetRepo(a.repo);
    expect(undoState(a.repo)).toEqual({ undo: null, redo: null });
  });

  it('a new recorded action clears the redo list', async () => {
    const { repo, c1 } = committed();
    await undo(repo);
    expect(undoState(repo).redo).not.toBeNull();
    git(repo, ['branch', 'topic', c1]);
    record(repo, { kind: 'create-branch', name: 'topic', sha: c1, from: { branch: 'main', sha: c1 }, checkedOut: false });
    expect(undoState(repo).redo).toBeNull();
    expect(undoState(repo).undo).toEqual({ label: "create branch 'topic'" });
  });

  it('a non-recorded mutation (push, fetch, merge...) clears the redo list but keeps the undo list', async () => {
    const { repo, c1 } = baseRepo();
    git(repo, ['branch', 'topic', c1]);
    record(repo, { kind: 'create-branch', name: 'topic', sha: c1, from: { branch: 'main', sha: c1 }, checkedOut: false });
    const c2 = commit(repo, { 'a.txt': 'a1\nmore\n' }, 'Second');
    record(repo, { kind: 'commit', sha: c2, prev: c1, branch: 'main', subject: 'Second' });
    await undo(repo);
    expect(undoState(repo).redo).toEqual({ label: "commit 'Second'" });
    clearRedo(repo);
    expect(undoState(repo).redo).toBeNull();
    expect(undoState(repo).undo).toEqual({ label: "create branch 'topic'" });
    const before = snap(repo);
    expect((await redo(repo)).outcome).toBe('refused');
    expect(snap(repo)).toEqual(before);
  });

  it('a recorded stash action also clears redo', async () => {
    const { repo, c1 } = baseRepo();
    git(repo, ['branch', 'topic', c1]);
    record(repo, { kind: 'create-branch', name: 'topic', sha: c1, from: { branch: 'main', sha: c1 }, checkedOut: false });
    await undo(repo);
    expect(undoState(repo).redo).not.toBeNull();
    write(repo, { 'b.txt': 'to stash\n' });
    expect((await stashPush(repo, { message: 'clears redo' })).outcome).toBe('done');
    expect(undoState(repo).redo).toBeNull();
    expect(undoState(repo).undo).toEqual({ label: 'stash' });
  });

  it('undo and redo are blocked (nothing changes) while a merge is unresolved', async () => {
    const { repo, c1, c2 } = committed();
    git(repo, ['switch', '-c', 'side', c1]);
    commit(repo, { 'a.txt': 'side\n' }, 'Side');
    git(repo, ['switch', 'main']);
    expect(c2).toBe(head(repo));
    expect(tryGit(repo, ['merge', 'side'])).not.toBe(0);
    const before = snap(repo);
    expect((await undo(repo)).outcome).toBe('blocked');
    expect((await redo(repo)).outcome).toBe('blocked');
    expect(snap(repo)).toEqual(before);
  });

  it('keeps at most 100 entries per repo: the oldest are dropped', async () => {
    const { repo, c1 } = baseRepo();
    for (let i = 0; i < 101; i++) {
      git(repo, ['branch', `b${i}`, c1]);
      record(repo, { kind: 'create-branch', name: `b${i}`, sha: c1, from: { branch: 'main', sha: c1 }, checkedOut: false });
    }
    let done = 0;
    while ((await undo(repo)).outcome === 'done' && done < 200) done++;
    expect(done).toBe(100);
    expect(refSha(repo, 'refs/heads/b0')).toBe(c1); // the oldest entry was dropped, so its branch stays
    expect(refSha(repo, 'refs/heads/b1')).toBeNull();
    expect(refSha(repo, 'refs/heads/b100')).toBeNull();
  }, 180_000);

  it('keeps at most 20 repos: the least recently used journal is dropped', () => {
    const roots = Array.from({ length: 21 }, (_, i) => join(ROOT, `undo-lru-fake-${i}`));
    for (const r of roots) record(r, { kind: 'create-branch', name: 'x', sha: 'a'.repeat(40), from: { branch: 'main', sha: 'a'.repeat(40) }, checkedOut: false });
    expect(undoState(roots[0]!)).toEqual({ undo: null, redo: null });
    expect(undoState(roots[20]!).undo).toEqual({ label: "create branch 'x'" });
    expect(undoState(roots[1]!).undo).not.toBeNull();
    for (const r of roots) forgetRepo(r);
  });
});
