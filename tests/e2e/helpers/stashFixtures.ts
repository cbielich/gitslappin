import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gitOut } from './branchFixtures';
import { createRepo } from './repo';

export { currentBranch, gitOut, headSha, refSha } from './branchFixtures';
export { cachedNames, commitCount, headMessage } from './stagingFixtures';

export const fileText = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8');
export const fileExists = (repo: string, rel: string): boolean => existsSync(join(repo, rel));
export const stashShas = (repo: string): string[] => gitOut(repo, ['stash', 'list', '--format=%H']).split('\n').filter(Boolean);
/** Full message of every stash, newest first (e.g. "On main: First stash"). */
export const stashSubjects = (repo: string): string[] => gitOut(repo, ['stash', 'list', '--format=%s']).split('\n').filter(Boolean);
export const porcelain = (repo: string): string => gitOut(repo, ['status', '--porcelain=v1', '-uall']);
export const stagedNames = (repo: string): string[] => gitOut(repo, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean).sort();
export const keepRefSha = (repo: string, sha: string): string | null => {
  try {
    return gitOut(repo, ['rev-parse', '--verify', '-q', `refs/gitslappin/stash-keep/${sha}`]).trim();
  } catch {
    return null;
  }
};

export const SUBJECTS = ['Stash fixture 1', 'Stash fixture 2'] as const;
export const ORIGINAL = { app: 'app v1\n', util: 'util v1\n', readme: '# stash fixture\n' } as const;
export const EDITED_APP = 'app v1\napp EDITED for the stash\n';
export const EDITED_UTIL = 'util v1\nutil EDITED\n';
export const UNTRACKED_NAME = 'notes/todo.txt';
export const UNTRACKED_TEXT = 'untracked line one\nuntracked line two\n';
export const FIRST_STASH = 'First stash';
export const SECOND_STASH = 'Second stash';

function write(repo: string, rel: string, text: string): void {
  const full = join(repo, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

/** main with two commits (src/app.js, src/util.js, README.md), clean working tree. */
export function createStashRepo(): string {
  const repo = createRepo('stash-e2e', [
    { message: SUBJECTS[0], files: { 'src/app.js': ORIGINAL.app, 'src/util.js': ORIGINAL.util, 'README.md': ORIGINAL.readme } },
    { message: SUBJECTS[1], files: { 'README.md': `${ORIGINAL.readme}second\n` } },
  ]);
  // The app runs git without the machine's core.autocrlf (the test server isolates the global config), so the fixture must too:
  // otherwise a stash made here restores CRLF files and the app sees them as modified.
  gitOut(repo, ['config', 'core.autocrlf', 'false']);
  return repo;
}

/** createStashRepo plus: src/app.js edited (unstaged) and notes/todo.txt untracked. Nothing staged. */
export function createDirtyStashRepo(): string {
  const repo = createStashRepo();
  write(repo, 'src/app.js', EDITED_APP);
  write(repo, UNTRACKED_NAME, UNTRACKED_TEXT);
  return repo;
}

/**
 * Two stashes made with plain git, working tree clean afterwards:
 *  - older (stash@{1}, message FIRST_STASH): src/app.js edited + untracked notes/todo.txt
 *  - newer (stash@{0}, message SECOND_STASH): src/util.js edited
 * shas are [older, newer].
 */
export function createStashedRepo(): { repo: string; shas: [string, string] } {
  const repo = createStashRepo();
  write(repo, 'src/app.js', EDITED_APP);
  write(repo, UNTRACKED_NAME, UNTRACKED_TEXT);
  gitOut(repo, ['stash', 'push', '--include-untracked', '-m', FIRST_STASH]);
  write(repo, 'src/util.js', EDITED_UTIL);
  gitOut(repo, ['stash', 'push', '--include-untracked', '-m', SECOND_STASH]);
  const [newer, older] = stashShas(repo);
  return { repo, shas: [older!, newer!] };
}

/** createStashedRepo, then a local edit to README.md so the tree is dirty but does not overlap the stashes. */
export function createStashedDirtyRepo(): { repo: string; shas: [string, string] } {
  const fx = createStashedRepo();
  write(fx.repo, 'README.md', `${ORIGINAL.readme}second\nlocal edit\n`);
  return fx;
}

export const LOCAL_APP = 'app LOCAL edit that the stash would overwrite\n';
/** createStashedRepo, then src/app.js (also changed by the older stash) is edited locally, so git refuses to apply it. */
export function createOverlapRepo(): { repo: string; shas: [string, string] } {
  const fx = createStashedRepo();
  write(fx.repo, 'src/app.js', LOCAL_APP);
  return fx;
}

/** createStashedRepo, then README.md is staged. */
export function createStagedWithStashRepo(): { repo: string; shas: [string, string] } {
  const fx = createStashedRepo();
  write(fx.repo, 'README.md', `${ORIGINAL.readme}second\nstaged edit\n`);
  gitOut(fx.repo, ['add', '--', 'README.md']);
  return fx;
}

export const PARTIAL_STAGED = 'app staged line\n';
export const PARTIAL_FINAL = 'app staged line\nand an extra unstaged line\n';
/** src/app.js has a staged change AND a further unstaged change (partial staging); src/util.js is edited and unstaged. */
export function createPartialStagingRepo(): string {
  const repo = createStashRepo();
  write(repo, 'src/app.js', PARTIAL_STAGED);
  gitOut(repo, ['add', '--', 'src/app.js']);
  write(repo, 'src/app.js', PARTIAL_FINAL);
  write(repo, 'src/util.js', EDITED_UTIL);
  return repo;
}

/** Two files staged, nothing else: for the plural button label. */
export function createTwoStagedRepo(): string {
  const repo = createStashRepo();
  write(repo, 'src/app.js', EDITED_APP);
  write(repo, 'src/util.js', EDITED_UTIL);
  gitOut(repo, ['add', '--', 'src/app.js', 'src/util.js']);
  return repo;
}

/** A pop of the older stash conflicts: HEAD changed src/app.js differently after the stash was made. */
export function createPopConflictRepo(): { repo: string; sha: string } {
  const repo = createStashRepo();
  write(repo, 'src/app.js', EDITED_APP);
  gitOut(repo, ['stash', 'push', '-m', 'Conflicting stash']);
  const sha = gitOut(repo, ['rev-parse', 'stash@{0}']).trim();
  write(repo, 'src/app.js', 'app v1\napp COMMITTED differently\n');
  gitOut(repo, ['commit', '-am', 'Change app after stashing']);
  return { repo, sha };
}

/** Matching a clean repo that just had a stash pushed: used by undo tests. */
export function createUndoStashRepo(): string {
  return createDirtyStashRepo();
}
