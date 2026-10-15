import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDir } from './repo';
import { commitFile, createRemoteFx, divergeClean, fetchIn, git, headSha, originRef, tryGit, type RemoteFx } from './remoteFixtures';

export {
  assertRemotesSafe,
  createRemoteFx,
  currentBranch,
  fetchIn,
  fileText,
  git,
  hasRef,
  headSha,
  originAdvance,
  originRef,
  originSnapshot,
  refSha,
  stashList,
  subjects,
  tryGit,
} from './remoteFixtures';
export { createHunkRepo } from './stagingFixtures';

/*
 * Fixtures for phase 11 (discard, reset, rename, delete, force push, cherry-pick, revert, tags). Every repo is a fresh
 * mkdtemp folder under os.tmpdir()/gitslappin-tests (freshDir asserts it is new and empty). All git calls go through remoteFixtures'
 * `git`, which asserts the cwd is under that root and runs with GIT_CONFIG_NOSYSTEM + an EMPTY GIT_CONFIG_GLOBAL, a failing
 * askpass and GCM_INTERACTIVE=never. Remotes are file:// inside the test root (createRemoteFx asserts it). Nothing here deletes anything.
 */

function newRepo(prefix: string): string {
  const repo = join(freshDir(prefix), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'author@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'core.editor', 'false']); // an editor started by mistake fails instead of hanging
  git(repo, ['config', 'gc.auto', '0']);
  return repo;
}
const commit = (repo: string, files: Record<string, string>, message: string, who?: string): string => {
  if (who) return commitFile(repo, files, message, who);
  return commitFile(repo, files, message);
};

const GIT_DIR_RE = /(^|[\\/])\.git([\\/]|$)/;
export interface RepoState {
  head: string | null;
  branch: string;
  refs: string;
  index: string;
  status: string;
  stashes: string;
  files: Record<string, string>;
}
/**
 * Everything a Cancel (or a refused action) must leave alone: HEAD, branch, every ref except refs/gitslappin/*, the index, the status
 * (ignored files included) and the bytes of every file outside .git. Compare with toEqual before and after.
 */
export function repoState(repo: string): RepoState {
  const files: Record<string, string> = {};
  for (const rel of readdirSync(repo, { recursive: true }) as string[]) {
    if (GIT_DIR_RE.test(rel)) continue;
    const full = join(repo, rel);
    const st = lstatSync(full);
    const key = rel.replace(/\\/g, '/');
    if (st.isSymbolicLink()) files[key] = `link:${readlinkSync(full)}`;
    else if (st.isFile()) files[key] = readFileSync(full).toString('base64');
  }
  const head = tryGit(repo, ['rev-parse', '--verify', '-q', 'HEAD']);
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    branch: git(repo, ['branch', '--show-current']).trim(),
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes', 'refs/stash']),
    index: git(repo, ['ls-files', '-s']),
    status: git(repo, ['status', '--porcelain=v1', '-uall', '--ignored']),
    stashes: git(repo, ['stash', 'list', '--format=%H %gs']),
    files,
  };
}
/** Number of refs pinned under refs/gitslappin/undo/ (the safety snapshots). */
export const pinCount = (repo: string): number => git(repo, ['for-each-ref', 'refs/gitslappin/undo/']).split('\n').filter(Boolean).length;
export const exists = (repo: string, rel: string): boolean => existsSync(join(repo, rel));
export const readText = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8');
export const objectType = (repo: string, ref: string): string => git(repo, ['cat-file', '-t', ref]).trim();
export const tagMessage = (repo: string, tag: string): string => git(repo, ['tag', '-l', tag, '--format=%(contents)']);
export const tagNames = (repo: string): string[] => git(repo, ['tag', '--list']).split('\n').filter(Boolean);
export const marker = (repo: string, name: string): boolean => existsSync(join(repo, '.git', name));
export const lastSubject = (repo: string): string => git(repo, ['log', '-1', '--format=%s']).trim();
export const lastAuthor = (repo: string): string => git(repo, ['log', '-1', '--format=%an']).trim();
export const configGet = (repo: string, key: string): string | undefined => {
  const r = tryGit(repo, ['config', '--local', '--get', key]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};

// --- discard ---------------------------------------------------------------------------------------------------------
export const DISCARD = {
  a: 'a.txt', // modified, unstaged
  b: 'src/b.txt', // modified, staged
  c: 'src/c.txt', // modified, unstaged (second file for multi-select)
  untracked: 'new.txt',
  ignored: 'x.log',
  clean: 'README.md',
} as const;
export const DISCARD_ORIGINAL = { a: 'a1\na2\na3\n', b: 'b1\n', c: 'c1\n' } as const;
export const DISCARD_EDITED = { a: 'a1\na2 EDITED\na3\n', b: 'b1\nb staged edit\n', c: 'c1\nc edited\n', untracked: 'brand new untracked bytes\n' } as const;

/**
 * Clean base commit, then: a.txt, src/c.txt edited (unstaged), src/b.txt edited and staged, new.txt untracked,
 * x.log ignored (.gitignore has *.log). README.md is clean. Current branch main.
 */
export function createDiscardRepo(): string {
  const repo = newRepo('destr-discard');
  commit(repo, { [DISCARD.a]: DISCARD_ORIGINAL.a, [DISCARD.b]: DISCARD_ORIGINAL.b, [DISCARD.c]: DISCARD_ORIGINAL.c, [DISCARD.clean]: '# readme\n', '.gitignore': '*.log\n' }, 'Discard base');
  writeFileSync(join(repo, DISCARD.a), DISCARD_EDITED.a);
  writeFileSync(join(repo, DISCARD.c), DISCARD_EDITED.c);
  writeFileSync(join(repo, DISCARD.b), DISCARD_EDITED.b);
  git(repo, ['add', DISCARD.b]);
  writeFileSync(join(repo, DISCARD.untracked), DISCARD_EDITED.untracked);
  writeFileSync(join(repo, DISCARD.ignored), 'ignored bytes\n');
  return repo;
}

/** One committed file with two hunks is in stagingFixtures.createHunkRepo (hunks.txt: lines 2 and 28 changed, unstaged). */

// --- reset -----------------------------------------------------------------------------------------------------------
export interface ResetFx {
  repo: string;
  shas: string[]; // oldest first: R1, R2, R3
}
export const RESET_SUBJECTS = ['Reset one', 'Reset two', 'Reset three'] as const;
/** main: R1 (a.txt=a1), R2 (a.txt=a2), R3 (a.txt=a3). With `dirty`: a.txt has a staged edit plus an unstaged edit on top. */
export function createResetRepo(opts: { dirty?: boolean } = {}): ResetFx {
  const repo = newRepo('destr-reset');
  const shas = [
    commit(repo, { 'a.txt': 'a1\n', 'b.txt': 'b1\n' }, RESET_SUBJECTS[0]),
    commit(repo, { 'a.txt': 'a2\n' }, RESET_SUBJECTS[1]),
    commit(repo, { 'a.txt': 'a3\n' }, RESET_SUBJECTS[2]),
  ];
  if (opts.dirty) {
    writeFileSync(join(repo, 'a.txt'), 'a staged edit\n');
    git(repo, ['add', 'a.txt']);
    writeFileSync(join(repo, 'a.txt'), 'a staged edit\nplus an unstaged line\n');
  }
  return { repo, shas };
}

// --- branches: rename, delete ------------------------------------------------------------------------------------------
export interface BranchFx {
  repo: string;
  baseSha: string;
  /** Tip of `wip`: NOT merged into main (git branch -d refuses). */
  wipSha: string;
  /** Tip of `done`: fully merged into main (== baseSha). */
  doneSha: string;
}
/** main (2 commits) and the local branches wip (unmerged, one extra commit) and done (merged). Clean tree, on main. */
export function createBranchDeleteRepo(): BranchFx {
  const repo = newRepo('destr-branches');
  commit(repo, { 'file.txt': 'one\n' }, 'Branch base one');
  const baseSha = commit(repo, { 'file.txt': 'two\n' }, 'Branch base two');
  git(repo, ['switch', '-c', 'wip']);
  const wipSha = commit(repo, { 'wip.txt': 'wip\n' }, 'WIP commit not merged');
  git(repo, ['switch', 'main']);
  git(repo, ['branch', 'done', baseSha]);
  return { repo, baseSha, wipSha, doneSha: baseSha };
}

export interface RemoteBranchFx extends RemoteFx {
  /** Tip of `feature`, pushed with -u to origin (upstream origin/feature). A is on main. */
  featureSha: string;
}
/** createRemoteFx plus A's branch `feature` pushed with -u. */
export function createRemoteBranchFx(): RemoteBranchFx {
  const fx = createRemoteFx();
  git(fx.a, ['switch', '-c', 'feature']);
  const featureSha = commitFile(fx.a, { 'feature.txt': 'feature\n' }, 'Feature commit on origin');
  git(fx.a, ['push', '-u', 'origin', 'feature']);
  git(fx.a, ['switch', 'main']);
  if (originRef(fx, 'refs/heads/feature') !== featureSha) throw new Error('fixture: feature was not pushed');
  return { ...fx, featureSha };
}

// --- force push -------------------------------------------------------------------------------------------------------
export interface RejectedPushFx extends RemoteFx {
  localSha: string;
  /** origin/main as A has it fetched (what the lease will expect). */
  remoteSha: string;
}
/** A has a local commit, origin has B's commit, and A has FETCHED it: a plain push is rejected as non-fast-forward. */
export function createRejectedPushFx(): RejectedPushFx {
  const fx = createRemoteFx();
  const d = divergeClean(fx);
  fetchIn(fx.a);
  return { ...fx, localSha: d.localSha, remoteSha: d.remoteSha };
}

// --- cherry-pick / revert -----------------------------------------------------------------------------------------------
export const PICK = {
  t1: 'T1 add topic file',
  t2: 'T2 change c',
  t3: 'T3 change a',
  m1: 'M1 change a',
  m2: 'M2 change b',
  m3: 'M3 change a again',
  m4: 'M4 change c',
  m5: 'M5 change c back',
  merge: 'Merge side into main',
  author: 'Topic Author',
} as const;
export const PICK_DIRTY = '# readme with an uncommitted edit\n';
export interface PickFx {
  repo: string;
  c1: string;
  t1: string;
  t3: string;
  m1: string;
  m2: string;
  m4: string;
  mergeSha: string;
}
/**
 * main: Base, M1 (a.txt='a main'), M2 (b.txt='b main'), M3 (a.txt='a main 3'), M4 (c.txt='c x'), M5 (c.txt back to 'c1'),
 * then a merge commit of branch `side` (adds side.txt). topic (from Base): T1 adds topic.txt (author PICK.author), T2 c.txt, T3 a.txt.
 *  - cherry-pick T1: clean. cherry-pick T3: conflicts on a.txt. cherry-pick T1 twice: second is a noop.
 *  - revert M2: clean. revert M1: conflicts on a.txt (M3 changed the line later). revert M4: noop (M5 already reverted it).
 * Current branch main, clean; `dirty` leaves README.md edited (PICK_DIRTY) so an auto-stash is needed.
 */
export function createPickRepo(opts: { dirty?: boolean } = {}): PickFx {
  const repo = newRepo('destr-pick');
  const c1 = commit(repo, { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n', 'README.md': '# readme\n' }, 'Base');
  git(repo, ['switch', '-c', 'topic']);
  const t1 = commit(repo, { 'topic.txt': 'topic\n' }, PICK.t1, PICK.author);
  commit(repo, { 'c.txt': 'c topic\n' }, PICK.t2, PICK.author);
  const t3 = commit(repo, { 'a.txt': 'a topic\n' }, PICK.t3, PICK.author);
  git(repo, ['switch', 'main']);
  const m1 = commit(repo, { 'a.txt': 'a main\n' }, PICK.m1);
  const m2 = commit(repo, { 'b.txt': 'b main\n' }, PICK.m2);
  commit(repo, { 'a.txt': 'a main 3\n' }, PICK.m3);
  const m4 = commit(repo, { 'c.txt': 'c x\n' }, PICK.m4);
  commit(repo, { 'c.txt': 'c1\n' }, PICK.m5);
  git(repo, ['switch', '-c', 'side', c1]);
  commit(repo, { 'side.txt': 'side\n' }, 'Side change');
  git(repo, ['switch', 'main']);
  git(repo, ['merge', '--no-ff', '-m', PICK.merge, 'side']);
  const mergeSha = headSha(repo);
  if (opts.dirty) writeFileSync(join(repo, 'README.md'), PICK_DIRTY);
  return { repo, c1, t1, t3, m1, m2, m4, mergeSha };
}
