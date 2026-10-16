import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitFile, createRemoteFx, fetchIn, git, originAdvance, originBranch, type RemoteFx } from './remoteFixtures';
import { createRepo } from './repo';

/*
 * Fixtures for the V6 (Interaction) specs. Everything lives under os.tmpdir()/gitslappin-tests (the helpers they build on assert that); nothing is deleted.
 * Remote fixtures reuse helpers/remoteFixtures.ts (bare origin over file://, isolated git config).
 */

export const FEATURE_SUBJECT = 'Feature x commit';
export const MOVED_SUBJECT = 'Main moved on';

export interface DndFx extends RemoteFx {
  featureSha: string;
  mainMoved: string;
}

/**
 * RemoteFx plus: local branch `feature/x` (one commit, from the base tip) and a newer commit on main, so the two have diverged (a merge makes a merge commit,
 * a rebase of feature/x onto main rewrites its commit). HEAD is `main` unless opts.checkout says otherwise. Working tree clean.
 */
export function createDndFx(opts: { checkout?: 'main' | 'feature/x' } = {}): DndFx {
  const fx = createRemoteFx();
  git(fx.a, ['switch', '-c', 'feature/x']);
  const featureSha = commitFile(fx.a, { 'feature.txt': 'feature\n' }, FEATURE_SUBJECT);
  git(fx.a, ['switch', 'main']);
  const mainMoved = commitFile(fx.a, { 'main-moved.txt': 'moved\n' }, MOVED_SUBJECT);
  if (opts.checkout === 'feature/x') git(fx.a, ['switch', 'feature/x']);
  return { ...fx, featureSha, mainMoved };
}

export interface PushDndFx extends RemoteFx {
  /** Local branch `x2` (not tracking anything), one commit ahead of origin/x. */
  x2Sha: string;
  /** origin/x (the target of the drop) as fetched into A. */
  originXSha: string;
}

/**
 * origin has branch `x`; A fetched it; A has local `x2` = origin/x + one commit, created with --no-track (no upstream). HEAD stays on main.
 * With diverge:true origin/x then moves on (pushed by B, NOT fetched into A), so pushing x2 to x is not a fast-forward.
 */
export function createPushDndFx(opts: { diverge?: boolean } = {}): PushDndFx & { originXNow: string } {
  const fx = createRemoteFx();
  const originXSha = originBranch(fx, 'x');
  fetchIn(fx.a);
  git(fx.a, ['switch', '-c', 'x2', '--no-track', 'origin/x']);
  const x2Sha = commitFile(fx.a, { 'x2.txt': 'x2\n' }, 'x2 local commit');
  git(fx.a, ['switch', 'main']);
  let originXNow = originXSha;
  if (opts.diverge) {
    git(fx.b, ['fetch', 'origin']);
    git(fx.b, ['switch', 'x']);
    originXNow = commitFile(fx.b, { 'x-theirs.txt': 'theirs\n' }, 'x on origin moved', 'Other Author');
    git(fx.b, ['push', 'origin', 'x']);
    git(fx.b, ['switch', 'main']);
  }
  return { ...fx, x2Sha, originXSha, originXNow };
}

/** Re-export so specs need one import. */
export { originAdvance };

const AT = (when: string): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: when,
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: when,
  GIT_TERMINAL_PROMPT: '0',
});
function gitAt(repo: string, args: string[], when: string): void {
  execFileSync('git', args, { cwd: repo, env: AT(when), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

export const LANE = { base: 'Lane base', main2: 'Lane main 2', side: 'Lane side 1', main3: 'Lane main 3' } as const;

/**
 * Graph rows, newest first: "Lane main 3", "Lane side 1", "Lane main 2", "Lane base" (explicit dates).
 * main = base -> main2 -> main3; `side` = base -> side1 (a second lane). HEAD = main. Clean tree.
 * Shift+Down from "Lane main 3" must land on "Lane main 2" (first parent, same lane); plain Down lands on "Lane side 1".
 */
export function createLaneRepo(): string {
  const repo = createRepo('lanes-e2e', [
    { message: LANE.base, files: { 'README.md': '# lanes\n' }, date: '2026-02-01T10:00:00+00:00' },
    { message: LANE.main2, files: { 'm2.txt': 'm2\n' }, date: '2026-02-01T11:00:00+00:00' },
  ]);
  gitAt(repo, ['switch', '-c', 'side', 'HEAD~1'], '2026-02-01T12:00:00+00:00');
  writeFileSync(join(repo, 's1.txt'), 's1\n');
  gitAt(repo, ['add', '-A'], '2026-02-01T12:00:00+00:00');
  gitAt(repo, ['commit', '-m', LANE.side], '2026-02-01T12:00:00+00:00');
  gitAt(repo, ['switch', 'main'], '2026-02-01T12:30:00+00:00');
  writeFileSync(join(repo, 'm3.txt'), 'm3\n');
  gitAt(repo, ['add', '-A'], '2026-02-01T13:00:00+00:00');
  gitAt(repo, ['commit', '-m', LANE.main3], '2026-02-01T13:00:00+00:00');
  return repo;
}
