import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freshDir } from './repo';
import { merging, rebasing } from './mergeFixtures';

export {
  currentBranch,
  fileText,
  headSha,
  merging,
  parentCount,
  rebasing,
  refSha,
  stashList,
  subjects,
  unmergedPaths,
} from './mergeFixtures';

/*
 * Remote fixtures for phase 7: a bare origin plus two clones (A = the repo under test, B = "somebody else"), all over
 * file:// URLs inside os.tmpdir()/gitslappin-tests. Nothing here deletes anything.
 *
 * Isolation: every git call made by these helpers runs with GIT_CONFIG_NOSYSTEM=1, an EMPTY GIT_CONFIG_GLOBAL file,
 * a failing GIT_ASKPASS / SSH_ASKPASS and GCM_INTERACTIVE=never, so the user's insteadOf rules, credential helpers
 * and logins can never redirect or prompt. The clones carry their own identity and protocol rules in their local config
 * (protocol.allow=never, protocol.file.allow=always), because the app's own git calls do not read the empty global file
 * for identity.
 *
 * The webServer needs the same env (see the report): GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL (empty file), GIT_ASKPASS,
 * SSH_ASKPASS, GCM_INTERACTIVE. REMOTE_TEST_ENV below is exactly that set, for playwright.config.ts to reuse.
 */

const ROOT = resolve(join(tmpdir(), 'gitslappin-tests'));

const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
function assertUnderTestRoot(dir: string): string {
  if (!norm(dir).startsWith(norm(ROOT) + (process.platform === 'win32' ? '\\' : sep))) throw new Error(`Fixture dir is not under ${ROOT}: ${dir}`);
  return dir;
}

const CFG_DIR = freshDir('gitcfg-remote');
export const EMPTY_GLOBAL_CONFIG = join(CFG_DIR, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL_CONFIG, '');
/** A credential prompt must fail, never wait. */
export const FAILING_ASKPASS = join(CFG_DIR, process.platform === 'win32' ? 'fail-askpass.cmd' : 'fail-askpass.sh');
writeFileSync(FAILING_ASKPASS, process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });

/** Env that makes git ignore the machine's own configuration and never prompt. Same keys the webServer must get. */
export const REMOTE_TEST_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL_CONFIG,
  GIT_ASKPASS: FAILING_ASKPASS,
  SSH_ASKPASS: FAILING_ASKPASS,
  GCM_INTERACTIVE: 'never',
  GIT_TERMINAL_PROMPT: '0',
};

function gitEnv(who: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...REMOTE_TEST_ENV,
    GIT_AUTHOR_NAME: who,
    GIT_AUTHOR_EMAIL: `${who.toLowerCase().replace(/ /g, '.')}@example.com`,
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'author@example.com',
  };
  delete env.GITSLAPPIN_TOKEN;
  delete env.GIT_SSH;
  delete env.GIT_SSH_COMMAND;
  return env;
}

export function git(cwd: string, args: string[], who = 'Test Author'): string {
  assertUnderTestRoot(cwd);
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv(who), stdio: ['pipe', 'pipe', 'pipe'] });
}
export function tryGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  assertUnderTestRoot(cwd);
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv('Test Author') });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Throws unless every remote url / pushurl configured in `repo` is a file:// URL that points inside gitslappin-tests.
 * Called before any fetch / pull / push that the fixtures or a test starts.
 */
export function assertRemotesSafe(repo: string): void {
  const r = tryGit(repo, ['config', '--local', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']);
  const lines = (r.stdout ?? '').split('\n').filter(Boolean);
  for (const line of lines) {
    const url = line.slice(line.indexOf(' ') + 1).trim();
    if (!url.startsWith('file://')) throw new Error(`Unsafe remote URL (not file://): ${line}`);
    const path = fileURLToPath(url);
    if (!norm(path).startsWith(norm(ROOT) + sep)) throw new Error(`Remote URL is outside ${ROOT}: ${line}`);
  }
}

export function commitFile(repo: string, files: Record<string, string>, message: string, who = 'Test Author'): string {
  for (const [rel, text] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message], who);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

function configureClone(repo: string): void {
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'author@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'core.editor', 'false']); // an editor started by mistake fails instead of hanging
  git(repo, ['config', 'protocol.allow', 'never']);
  git(repo, ['config', 'protocol.file.allow', 'always']);
}

export interface RemoteFx {
  base: string;
  /** Bare repository path. */
  origin: string;
  originUrl: string;
  /** The repository under test (main tracks origin/main). */
  a: string;
  /** "Somebody else": a second clone used to change origin. */
  b: string;
  /** origin/main tip right after setup (== A's main). */
  baseSha: string;
}

export const BASE_SUBJECTS = ['Remote base 2', 'Remote base 1'];
export const CONFIG_BASE = 'title=base\n';
export const README_BASE = '# readme\n';

/**
 * origin (bare) with main = 2 commits ("Remote base 1", "Remote base 2"; src/config.js and README.md), pushed from A.
 * A is a clone with main tracking origin/main and push.followTags=true (so only --no-follow-tags keeps tags back).
 * B is a second clone. All three are clean and in sync.
 */
export function createRemoteFx(): RemoteFx {
  const base = freshDir('remote');
  const origin = join(base, 'origin.git');
  const a = join(base, 'a');
  const b = join(base, 'b');
  assertUnderTestRoot(origin);
  mkdirSync(origin);
  git(origin, ['init', '--bare', '-b', 'main']);
  const originUrl = pathToFileURL(origin).href;
  mkdirSync(a);
  git(a, ['init', '-b', 'main']);
  configureClone(a);
  git(a, ['remote', 'add', 'origin', originUrl]);
  assertRemotesSafe(a);
  commitFile(a, { 'src/config.js': CONFIG_BASE, 'README.md': README_BASE }, 'Remote base 1');
  const baseSha = commitFile(a, { 'docs.txt': 'docs\n' }, 'Remote base 2');
  git(a, ['push', '-u', 'origin', 'main']);
  git(a, ['config', 'push.followTags', 'true']);
  git(base, ['clone', originUrl, 'b']);
  configureClone(b);
  assertRemotesSafe(b);
  if (!existsSync(join(b, '.git'))) throw new Error('fixture: clone B was not created');
  return { base, origin, originUrl, a, b, baseSha };
}

/** B commits on main and pushes to origin (origin moves ahead of A). Returns the new origin/main sha. */
export function originAdvance(fx: RemoteFx, files: Record<string, string>, message: string, who = 'Other Author'): string {
  assertRemotesSafe(fx.b);
  git(fx.b, ['pull', '--ff-only', 'origin', 'main']);
  const sha = commitFile(fx.b, files, message, who);
  git(fx.b, ['push', 'origin', 'main']);
  return sha;
}

/** B creates branch `name` (one commit) and pushes it. Returns its sha. A has not fetched it yet. */
export function originBranch(fx: RemoteFx, name: string, files: Record<string, string> = { [`${name.replace(/\//g, '_')}.txt`]: 'x\n' }): string {
  assertRemotesSafe(fx.b);
  git(fx.b, ['switch', '-c', name]);
  const sha = commitFile(fx.b, files, `Branch ${name} commit`, 'Other Author');
  git(fx.b, ['push', 'origin', name]);
  git(fx.b, ['switch', 'main']);
  return sha;
}

/** B deletes branch `name` on origin. */
export function originDeleteBranch(fx: RemoteFx, name: string): void {
  assertRemotesSafe(fx.b);
  git(fx.b, ['push', 'origin', '--delete', name]);
}

/** A: fetch (fixture use, to get remote-tracking refs). */
export function fetchIn(repo: string): void {
  assertRemotesSafe(repo);
  git(repo, ['fetch', 'origin']);
}

/** A: local commit on the current branch, not pushed. */
export const localCommit = (fx: RemoteFx, files: Record<string, string>, message: string): string => commitFile(fx.a, files, message);

/** Origin ref sha (undefined when the ref does not exist). */
export function originRef(fx: RemoteFx, ref: string): string | undefined {
  const r = tryGit(fx.origin, ['rev-parse', '--verify', '--quiet', ref]);
  return r.status === 0 ? r.stdout.trim() : undefined;
}
/** Every ref in origin (branches AND tags) with its sha, one string; compare before/after to prove origin did not change. */
export const originSnapshot = (fx: RemoteFx): string => git(fx.origin, ['for-each-ref', '--format=%(refname) %(objectname)']);
export const originTags = (fx: RemoteFx): string[] => git(fx.origin, ['tag', '--list']).split('\n').filter(Boolean);
export const configGet = (repo: string, key: string): string | undefined => {
  const r = tryGit(repo, ['config', '--local', '--get', key]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};
export const hasRef = (repo: string, ref: string): boolean => tryGit(repo, ['show-ref', '--verify', '--quiet', ref]).status === 0;
export const stashCount = (repo: string): number => git(repo, ['stash', 'list']).split('\n').filter(Boolean).length;

/** A has a local-only branch `name` (one commit, no upstream) and is switched to it. */
export function createNoUpstreamBranch(fx: RemoteFx, name = 'feature/x'): string {
  git(fx.a, ['switch', '-c', name]);
  return commitFile(fx.a, { 'feature.txt': 'feature\n' }, `Local ${name} commit`);
}

export interface Diverged {
  localSha: string;
  remoteSha: string;
}
/** A has a local commit (local.txt) and origin has another (remote.txt). They merge/rebase without conflict. */
export function divergeClean(fx: RemoteFx): Diverged {
  const remoteSha = originAdvance(fx, { 'remote.txt': 'remote\n' }, 'Remote side commit');
  const localSha = localCommit(fx, { 'local.txt': 'local\n' }, 'Local side commit');
  return { localSha, remoteSha };
}
/** Both sides change src/config.js. */
export function divergeConflict(fx: RemoteFx): Diverged {
  const remoteSha = originAdvance(fx, { 'src/config.js': 'title=remote\n' }, 'Remote sets title');
  const localSha = localCommit(fx, { 'src/config.js': 'title=local\n' }, 'Local sets title');
  return { localSha, remoteSha };
}
/** A has an uncommitted edit to README.md; origin changed README.md too (so git must refuse to pull). */
export const DIRTY_EDIT = '# readme with an uncommitted local edit\n';
export function dirtyAndBehind(fx: RemoteFx): { remoteSha: string } {
  const remoteSha = originAdvance(fx, { 'README.md': '# readme changed on origin\n' }, 'Remote edits readme');
  writeFileSync(join(fx.a, 'README.md'), DIRTY_EDIT);
  return { remoteSha };
}

/** divergeConflict, then `git pull --no-rebase` (merge) in A, which stops on the conflict (MERGE_HEAD exists). */
export function createPullMergeInProgress(): RemoteFx & Diverged {
  const fx = createRemoteFx();
  const d = divergeConflict(fx);
  assertRemotesSafe(fx.a);
  const status = tryGit(fx.a, ['pull', '--no-rebase', '--no-edit']).status;
  if (status === 0 || !merging(fx.a)) throw new Error('fixture: the pull was expected to stop on a merge conflict');
  return { ...fx, ...d };
}

/** divergeConflict, then `git pull --rebase` in A, which stops on the conflict. */
export function createPullRebaseInProgress(): RemoteFx & Diverged {
  const fx = createRemoteFx();
  const d = divergeConflict(fx);
  assertRemotesSafe(fx.a);
  const status = tryGit(fx.a, ['-c', 'core.editor=true', 'pull', '--rebase']).status;
  if (status === 0 || !rebasing(fx.a)) throw new Error('fixture: the pull was expected to stop on a rebase conflict');
  return { ...fx, ...d };
}

/** A with a detached HEAD at its main tip. */
export function detachA(fx: RemoteFx): void {
  git(fx.a, ['switch', '--detach', 'main']);
}

/** A repository with commits and NO remote at all. */
export function createNoRemoteRepo(): string {
  const base = freshDir('remote-none');
  const repo = join(base, 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  configureClone(repo);
  commitFile(repo, { 'README.md': README_BASE }, 'Lonely commit');
  return repo;
}

export const SECRET = 's3cret-pw-9f2';

/**
 * UNREACHABLE-REMOTE FIXTURES. These URLs are NOT file:// URLs, so they break the "every remote is a file:// path
 * inside gitslappin-tests" rule on purpose: they exist only to prove the app refuses them / hides their credentials.
 * Tests using them must never let a fetch, pull or push reach the network (the app must refuse before contacting).
 * Use only with GET /remotes and with the fetch route that is expected to refuse.
 */
export function createCredentialRemoteRepo(): { repo: string; url: string } {
  const repo = createNoRemoteRepo();
  const url = `https://alice:${SECRET}@example.invalid/team/project.git`;
  git(repo, ['remote', 'add', 'creds', url]);
  return { repo, url };
}

/** A repo whose only remote is `ext::git init <marker>`, with the hostile repo-level setting protocol.ext.allow=always. */
export function createExtRemoteRepo(): { repo: string; marker: string; url: string } {
  const repo = createNoRemoteRepo();
  const markerParent = freshDir('remote-ext-marker');
  const marker = join(markerParent, 'ext-ran').replace(/\\/g, '/');
  const url = `ext::git init ${marker}`;
  git(repo, ['config', '--unset', 'protocol.allow']);
  git(repo, ['config', 'protocol.ext.allow', 'always']);
  git(repo, ['remote', 'add', 'evil', url]);
  return { repo, marker, url };
}
/** True when something ran the ext helper (git init created <marker>/.git). */
export const extRan = (marker: string): boolean => existsSync(join(marker, '.git')) || existsSync(join(marker, 'HEAD'));

/** A remote with credentials AND `::` in one URL (never contacted: refused by the app, and ext is never allowed anyway). */
export function createCredentialExtRemoteRepo(): { repo: string; url: string } {
  const repo = createNoRemoteRepo();
  const url = `ext::https://alice:${SECRET}@example.invalid/team/project.git`;
  git(repo, ['remote', 'add', 'evil', url]);
  return { repo, url };
}
