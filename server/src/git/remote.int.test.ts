import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readOpState } from './opState';
import { fetchAll, listRemotes, pullRemote, pushRemote, setUpstream } from './remote';

/*
 * Contract the builder must export from server/src/git/remote.ts (every function takes the repo root, runs through
 * runExclusive + the runner with -c protocol.ext.allow=never, and returns a result; none throws for a git failure):
 *   listRemotes(root): Promise<{ name: string; url: string }[]>        (url scrubbed of user:pass@)
 *   fetchAll(root): Promise<RemoteResult>                               (fetch --all --prune)
 *   pullRemote(root, { mode: 'merge' | 'ff-only' | 'rebase'; branch?: string }): Promise<RemoteResult>
 *   pushRemote(root, { branch?: string; remote?: string; remoteBranch?: string }): Promise<RemoteResult>
 *       no upstream and no remote given -> { outcome: 'needs-upstream', remotes: string[] } and nothing is pushed;
 *       remote given -> push -u with refs/heads/<branch>:refs/heads/<remoteBranch ?? branch>
 *   setUpstream(root, { branch: string; remote: string; remoteBranch: string }): Promise<RemoteResult>
 *   RemoteResult = { outcome: 'done' | 'conflict' | 'failed' | 'blocked' | 'refused' | 'no-remote' | 'needs-upstream' | 'rejected';
 *                    error?: string; stderr?: string; stdout?: string; remotes?: string[]; rejected?: 'non-ff'; op?: OpState }
 *   'blocked'  = HEAD detached or another operation in progress (the route's 409); nothing changed.
 *   'refused'  = input validation failed (bad ref name, unknown remote, empty or missing local branch, `::` URL); git never ran.
 *   'no-remote' = `git remote` is empty.   'conflict' = pull stopped on a conflict, op = readOpState().
 *   'rejected' = push refused as non-fast-forward (rejected: 'non-ff').
 *
 * Real git on file:// remotes only, in mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted.
 * GIT_CONFIG_NOSYSTEM + an empty GIT_CONFIG_GLOBAL, a failing GIT_ASKPASS/SSH_ASKPASS and GCM_INTERACTIVE=never are set on
 * process.env so the code under test inherits them (the runner must pass them through). Identity and protocol rules live in
 * each clone's own config. Before any fetch/pull/push every remote URL is asserted to be file:// inside gitslappin-tests, except in
 * the ext:: tests (see there), where the app is expected to refuse before contacting anything.
 */

const ROOT = resolve(join(tmpdir(), 'gitslappin-tests'));
const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const underRoot = (p: string): boolean => norm(p).startsWith(norm(ROOT) + (process.platform === 'win32' ? '\\' : sep));

function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!underRoot(dir) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const CFG_DIR = fresh('gitcfg-remote-int');
const EMPTY_GLOBAL = join(CFG_DIR, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL, '');
const ASKPASS = join(CFG_DIR, process.platform === 'win32' ? 'fail-askpass.cmd' : 'fail-askpass.sh');
writeFileSync(ASKPASS, process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });

const ISOLATION: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
  GIT_ASKPASS: ASKPASS,
  SSH_ASKPASS: ASKPASS,
  GCM_INTERACTIVE: 'never',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
};
// The code under test inherits this environment.
Object.assign(process.env, ISOLATION);
delete process.env.GITSLAPPIN_TOKEN;
delete process.env.GIT_SSH;
delete process.env.GIT_SSH_COMMAND;

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

function assertRemotesSafe(repo: string): void {
  const r = tryGit(repo, ['config', '--local', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']);
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const url = line.slice(line.indexOf(' ') + 1).trim();
    if (!url.startsWith('file://')) throw new Error(`Unsafe remote URL (not file://): ${line}`);
    if (!underRoot(fileURLToPath(url))) throw new Error(`Remote URL is outside ${ROOT}: ${line}`);
  }
}

const head = (repo: string): string => git(repo, ['rev-parse', 'HEAD']).trim();
const rev = (repo: string, ref: string): string => git(repo, ['rev-parse', '--verify', ref]).trim();
const refOrUndef = (repo: string, ref: string): string | undefined => {
  const r = tryGit(repo, ['rev-parse', '--verify', '--quiet', ref]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const subjects = (repo: string): string[] => git(repo, ['log', '--format=%s']).split('\n').filter(Boolean);
const parents = (repo: string, ref = 'HEAD'): string[] => git(repo, ['log', '-1', '--format=%P', ref]).trim().split(' ').filter(Boolean);
const stashes = (repo: string): string[] => git(repo, ['stash', 'list']).split('\n').filter(Boolean);
const cfg = (repo: string, key: string): string | undefined => {
  const r = tryGit(repo, ['config', '--local', '--get', key]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const merging = (repo: string): boolean => existsSync(join(repo, '.git', 'MERGE_HEAD'));
const rebasing = (repo: string): boolean => existsSync(join(repo, '.git', 'rebase-merge'));
const text = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8');

function commit(repo: string, files: Record<string, string>, msg: string, who = 'Test Author'): string {
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

function configure(repo: string): void {
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'author@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'core.editor', 'false']); // an editor started by mistake fails instead of hanging
  git(repo, ['config', 'protocol.allow', 'never']);
  git(repo, ['config', 'protocol.file.allow', 'always']);
}

interface Fx {
  base: string;
  origin: string;
  a: string;
  b: string;
  baseSha: string;
}

/** origin (bare) main = 2 commits; A (clone under test, tracking origin/main, push.followTags=true); B (another clone). */
function makeFx(): Fx {
  const base = fresh('remote-int');
  const origin = join(base, 'origin.git');
  const a = join(base, 'a');
  const b = join(base, 'b');
  mkdirSync(origin);
  git(origin, ['init', '--bare', '-b', 'main']);
  const url = pathToFileURL(origin).href;
  mkdirSync(a);
  git(a, ['init', '-b', 'main']);
  configure(a);
  git(a, ['remote', 'add', 'origin', url]);
  assertRemotesSafe(a);
  commit(a, { 'src/config.js': 'title=base\n', 'README.md': '# readme\n' }, 'Remote base 1');
  const baseSha = commit(a, { 'docs.txt': 'docs\n' }, 'Remote base 2');
  git(a, ['push', '-u', 'origin', 'main']);
  git(a, ['config', 'push.followTags', 'true']);
  git(base, ['clone', url, 'b']);
  configure(b);
  assertRemotesSafe(b);
  return { base, origin, a, b, baseSha };
}

function originAdvance(fx: Fx, files: Record<string, string>, msg: string): string {
  assertRemotesSafe(fx.b);
  git(fx.b, ['pull', '--ff-only', 'origin', 'main']);
  const sha = commit(fx.b, files, msg, 'Other Author');
  git(fx.b, ['push', 'origin', 'main']);
  return sha;
}
function originBranch(fx: Fx, name: string): string {
  assertRemotesSafe(fx.b);
  git(fx.b, ['switch', '-c', name]);
  const sha = commit(fx.b, { [`${name}.txt`]: `${name}\n` }, `Branch ${name} commit`, 'Other Author');
  git(fx.b, ['push', 'origin', name]);
  git(fx.b, ['switch', 'main']);
  return sha;
}
const originSnapshot = (fx: Fx): string => git(fx.origin, ['for-each-ref', '--format=%(refname) %(objectname)']);
const originRef = (fx: Fx, ref: string): string | undefined => refOrUndef(fx.origin, ref);

function guarded<T>(fx: Fx, fn: () => T): T {
  assertRemotesSafe(fx.a);
  return fn();
}

describe('listRemotes and no remote', () => {
  it('lists origin with its file:// url', async () => {
    const fx = makeFx();
    const remotes = await listRemotes(fx.a);
    expect(remotes.map((r) => r.name)).toEqual(['origin']);
    expect(remotes[0]!.url.startsWith('file://')).toBe(true);
  });

  it('hides credentials in listed urls', async () => {
    const fx = makeFx();
    git(fx.a, ['remote', 'add', 'creds', 'https://alice:s3cret-pw@example.invalid/p.git']); // listed only, never contacted
    const remotes = await listRemotes(fx.a);
    const creds = remotes.find((r) => r.name === 'creds')!;
    expect(creds.url).toContain('https://***@example.invalid/p.git');
    expect(JSON.stringify(remotes)).not.toContain('s3cret-pw');
  });

  it('fetch, pull and push report no-remote when the repo has no remote', async () => {
    const base = fresh('remote-int-none');
    const repo = join(base, 'r');
    mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    configure(repo);
    commit(repo, { 'a.txt': 'a\n' }, 'Lonely');
    expect((await fetchAll(repo)).outcome).toBe('no-remote');
    expect((await pullRemote(repo, { mode: 'merge' })).outcome).toBe('no-remote');
    expect((await pushRemote(repo, {})).outcome).toBe('no-remote');
  });
});

describe('fetchAll', () => {
  it('fetches new commits into origin/main without touching the local branch', async () => {
    const fx = makeFx();
    const sha = originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    const res = await guarded(fx, () => fetchAll(fx.a));
    expect(res.outcome).toBe('done');
    expect(rev(fx.a, 'origin/main')).toBe(sha);
    expect(head(fx.a)).toBe(fx.baseSha);
    expect(existsSync(join(fx.a, 'new.txt'))).toBe(false);
  });

  it('prunes stale remote-tracking refs and keeps the local branch of the same name', async () => {
    const fx = makeFx();
    originBranch(fx, 'old');
    git(fx.a, ['fetch', 'origin']);
    git(fx.a, ['branch', '--track', 'old', 'origin/old']);
    expect(refOrUndef(fx.a, 'refs/remotes/origin/old')).toBeDefined();
    git(fx.b, ['push', 'origin', '--delete', 'old']);
    const res = await guarded(fx, () => fetchAll(fx.a));
    expect(res.outcome).toBe('done');
    expect(refOrUndef(fx.a, 'refs/remotes/origin/old')).toBeUndefined();
    expect(refOrUndef(fx.a, 'refs/heads/old')).toBeDefined(); // prune never deletes local branches
    expect(refOrUndef(fx.a, 'refs/remotes/origin/main')).toBeDefined();
  });
});

describe('pullRemote on the current branch', () => {
  it('merge mode fast-forwards when it can (no merge commit)', async () => {
    const fx = makeFx();
    const sha = originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    const res = await guarded(fx, () => pullRemote(fx.a, { mode: 'merge' }));
    expect(res.outcome).toBe('done');
    expect(head(fx.a)).toBe(sha);
    expect(parents(fx.a)).toHaveLength(1);
  });

  it('merge mode makes a merge commit when the branches diverged, without opening an editor', async () => {
    const fx = makeFx();
    const remote = originAdvance(fx, { 'remote.txt': 'r\n' }, 'Remote side commit');
    const local = commit(fx.a, { 'local.txt': 'l\n' }, 'Local side commit');
    const res = await guarded(fx, () => pullRemote(fx.a, { mode: 'merge' }));
    expect(res.outcome).toBe('done');
    expect(parents(fx.a).sort()).toEqual([local, remote].sort());
    expect(existsSync(join(fx.a, 'remote.txt')) && existsSync(join(fx.a, 'local.txt'))).toBe(true);
    expect(merging(fx.a)).toBe(false);
  });

  it('ff-only fast-forwards when it can', async () => {
    const fx = makeFx();
    const sha = originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    const res = await guarded(fx, () => pullRemote(fx.a, { mode: 'ff-only' }));
    expect(res.outcome).toBe('done');
    expect(head(fx.a)).toBe(sha);
  });

  it('ff-only fails on divergence and changes nothing', async () => {
    const fx = makeFx();
    originAdvance(fx, { 'remote.txt': 'r\n' }, 'Remote side commit');
    const local = commit(fx.a, { 'local.txt': 'l\n' }, 'Local side commit');
    const res = await guarded(fx, () => pullRemote(fx.a, { mode: 'ff-only' }));
    expect(res.outcome).toBe('failed');
    expect((res.stderr ?? '').length).toBeGreaterThan(0);
    expect(head(fx.a)).toBe(local);
    expect(merging(fx.a)).toBe(false);
    expect(rebasing(fx.a)).toBe(false);
    expect(existsSync(join(fx.a, 'remote.txt'))).toBe(false);
  });

  it('rebase mode puts the local commit on top of origin (linear history)', async () => {
    const fx = makeFx();
    const remote = originAdvance(fx, { 'remote.txt': 'r\n' }, 'Remote side commit');
    commit(fx.a, { 'local.txt': 'l\n' }, 'Local side commit');
    const res = await guarded(fx, () => pullRemote(fx.a, { mode: 'rebase' }));
    expect(res.outcome).toBe('done');
    expect(parents(fx.a)).toEqual([remote]);
    expect(subjects(fx.a).slice(0, 2)).toEqual(['Local side commit', 'Remote side commit']);
    expect(rebasing(fx.a)).toBe(false);
  });

  it('a merge conflict returns outcome conflict with the merge op, leaving MERGE_HEAD for the phase 6 screens', async () => {
    const fx = makeFx();
    originAdvance(fx, { 'src/config.js': 'title=remote\n' }, 'Remote sets title');
    commit(fx.a, { 'src/config.js': 'title=local\n' }, 'Local sets title');
    const res = await guarded(fx, () => pullRemote(fx.a, { mode: 'merge' }));
    expect(res.outcome).toBe('conflict');
    expect(res.op?.kind).toBe('merge');
    expect(merging(fx.a)).toBe(true);
    expect((await readOpState(fx.a))?.kind).toBe('merge');
    expect(stashes(fx.a)).toEqual([]);
  });

  it('a rebase conflict returns outcome conflict with the rebase op', async () => {
    const fx = makeFx();
    originAdvance(fx, { 'src/config.js': 'title=remote\n' }, 'Remote sets title');
    commit(fx.a, { 'src/config.js': 'title=local\n' }, 'Local sets title');
    const res = await guarded(fx, () => pullRemote(fx.a, { mode: 'rebase' }));
    expect(res.outcome).toBe('conflict');
    expect(res.op?.kind).toBe('rebase');
    expect(rebasing(fx.a)).toBe(true);
  });

  it.each(['merge', 'ff-only', 'rebase'] as const)('%s with a dirty tree is refused by git: edits kept, nothing stashed, head unchanged', async (mode) => {
    const fx = makeFx();
    originAdvance(fx, { 'README.md': '# readme changed on origin\n' }, 'Remote edits readme');
    writeFileSync(join(fx.a, 'README.md'), '# readme with an uncommitted local edit\n');
    const before = head(fx.a);
    const res = await guarded(fx, () => pullRemote(fx.a, { mode }));
    expect(res.outcome).toBe('failed');
    expect((res.stderr ?? '').length).toBeGreaterThan(0);
    expect(text(fx.a, 'README.md')).toBe('# readme with an uncommitted local edit\n');
    expect(stashes(fx.a)).toEqual([]);
    expect(head(fx.a)).toBe(before);
    expect(merging(fx.a)).toBe(false);
    expect(rebasing(fx.a)).toBe(false);
  });

  it('is blocked (nothing changed) while a merge is in progress', async () => {
    const fx = makeFx();
    originAdvance(fx, { 'src/config.js': 'title=remote\n' }, 'Remote sets title');
    commit(fx.a, { 'src/config.js': 'title=local\n' }, 'Local sets title');
    assertRemotesSafe(fx.a);
    tryGit(fx.a, ['pull', '--no-rebase', '--no-edit']); // stops on the conflict
    expect(merging(fx.a)).toBe(true);
    const before = head(fx.a);
    const res = await pullRemote(fx.a, { mode: 'merge' });
    expect(res.outcome).toBe('blocked');
    expect(head(fx.a)).toBe(before);
    expect(merging(fx.a)).toBe(true);
  });

  it('is blocked when HEAD is detached', async () => {
    const fx = makeFx();
    originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    git(fx.a, ['switch', '--detach', 'main']);
    const res = await pullRemote(fx.a, { mode: 'merge' });
    expect(res.outcome).toBe('blocked');
    expect(head(fx.a)).toBe(fx.baseSha);
    expect(refOrUndef(fx.a, 'refs/remotes/origin/main')).toBe(fx.baseSha); // not even fetched
  });

  it('refuses an unknown mode and a hostile branch value without running git', async () => {
    const fx = makeFx();
    expect((await pullRemote(fx.a, { mode: 'force' as never })).outcome).toBe('refused');
    expect((await pullRemote(fx.a, { mode: 'merge', branch: '--upload-pack=x' })).outcome).toBe('refused');
    expect((await pullRemote(fx.a, { mode: 'merge', branch: 'main:other' })).outcome).toBe('refused');
    expect(head(fx.a)).toBe(fx.baseSha);
  });
});

describe('pullRemote on a branch that is not current (menu pull)', () => {
  function featureFx(): { fx: Fx; tip1: string } {
    const fx = makeFx();
    const tip1 = originBranch(fx, 'feature');
    git(fx.a, ['fetch', 'origin']);
    git(fx.a, ['branch', '--track', 'feature', 'origin/feature']);
    return { fx, tip1 };
  }
  function advanceFeature(fx: Fx): string {
    git(fx.b, ['switch', 'feature']);
    const sha = commit(fx.b, { 'more.txt': 'm\n' }, 'Feature advances', 'Other Author');
    git(fx.b, ['push', 'origin', 'feature']);
    git(fx.b, ['switch', 'main']);
    return sha;
  }

  it('fast-forwards the local branch only; HEAD and the working tree stay on main', async () => {
    const { fx } = featureFx();
    const tip2 = advanceFeature(fx);
    const res = await guarded(fx, () => pullRemote(fx.a, { mode: 'merge', branch: 'feature' }));
    expect(res.outcome).toBe('done');
    expect(rev(fx.a, 'refs/heads/feature')).toBe(tip2);
    expect(git(fx.a, ['branch', '--show-current']).trim()).toBe('main');
    expect(head(fx.a)).toBe(fx.baseSha);
    expect(existsSync(join(fx.a, 'more.txt'))).toBe(false);
  });

  it('never rewrites a diverged local branch (no + in the refspec)', async () => {
    const { fx } = featureFx();
    advanceFeature(fx);
    git(fx.a, ['switch', 'feature']);
    const local = commit(fx.a, { 'mine.txt': 'x\n' }, 'Local feature work');
    git(fx.a, ['switch', 'main']);
    const res = await guarded(fx, () => pullRemote(fx.a, { mode: 'merge', branch: 'feature' }));
    expect(res.outcome).toBe('failed');
    expect(rev(fx.a, 'refs/heads/feature')).toBe(local);
  });
});

describe('pushRemote', () => {
  function featureBranch(fx: Fx, name = 'feature/x'): string {
    git(fx.a, ['switch', '-c', name]);
    return commit(fx.a, { 'feature.txt': 'f\n' }, `Local ${name} commit`);
  }

  it('first push with no upstream asks for one and pushes nothing', async () => {
    const fx = makeFx();
    featureBranch(fx);
    const before = originSnapshot(fx);
    const res = await guarded(fx, () => pushRemote(fx.a, {}));
    expect(res.outcome).toBe('needs-upstream');
    expect(res.remotes).toEqual(['origin']);
    expect(originSnapshot(fx)).toBe(before);
  });

  it('push with a chosen remote and branch pushes it and sets the upstream (-u)', async () => {
    const fx = makeFx();
    const sha = featureBranch(fx);
    const res = await guarded(fx, () => pushRemote(fx.a, { remote: 'origin', remoteBranch: 'feature/x' }));
    expect(res.outcome).toBe('done');
    expect(originRef(fx, 'refs/heads/feature/x')).toBe(sha);
    expect(cfg(fx.a, 'branch.feature/x.remote')).toBe('origin');
    expect(cfg(fx.a, 'branch.feature/x.merge')).toBe('refs/heads/feature/x');
  });

  it('can push to a differently named remote branch', async () => {
    const fx = makeFx();
    const sha = featureBranch(fx);
    const res = await guarded(fx, () => pushRemote(fx.a, { remote: 'origin', remoteBranch: 'other-name' }));
    expect(res.outcome).toBe('done');
    expect(originRef(fx, 'refs/heads/other-name')).toBe(sha);
    expect(originRef(fx, 'refs/heads/feature/x')).toBeUndefined();
    expect(cfg(fx.a, 'branch.feature/x.merge')).toBe('refs/heads/other-name');
  });

  it('pushes new commits on a branch that already has an upstream', async () => {
    const fx = makeFx();
    const sha = commit(fx.a, { 'more.txt': 'm\n' }, 'Local ahead');
    const res = await guarded(fx, () => pushRemote(fx.a, {}));
    expect(res.outcome).toBe('done');
    expect(originRef(fx, 'refs/heads/main')).toBe(sha);
  });

  it('a non-fast-forward push is rejected, origin and local stay as they were, and nothing is forced', async () => {
    const fx = makeFx();
    const remote = originAdvance(fx, { 'remote.txt': 'r\n' }, 'Remote side commit');
    const local = commit(fx.a, { 'local.txt': 'l\n' }, 'Local side commit');
    const before = originSnapshot(fx);
    const res = await guarded(fx, () => pushRemote(fx.a, {}));
    expect(res.outcome).toBe('rejected');
    expect(res.rejected).toBe('non-ff');
    expect(originSnapshot(fx)).toBe(before);
    expect(originRef(fx, 'refs/heads/main')).toBe(remote);
    expect(head(fx.a)).toBe(local);
  });

  it('does not push tags even with push.followTags=true (annotated tag on the pushed commit)', async () => {
    const fx = makeFx();
    expect(cfg(fx.a, 'push.followTags')).toBe('true'); // proves the trap is armed
    commit(fx.a, { 'more.txt': 'm\n' }, 'Tagged commit');
    git(fx.a, ['tag', '-a', 'v1.0', '-m', 'release']);
    const res = await guarded(fx, () => pushRemote(fx.a, {}));
    expect(res.outcome).toBe('done');
    expect(originRef(fx, 'refs/heads/main')).toBe(head(fx.a)); // the push really happened
    expect(git(fx.origin, ['tag', '--list']).trim()).toBe('');
  });

  it('refuses an empty source so a remote branch can never be deleted', async () => {
    const fx = makeFx();
    const before = originSnapshot(fx);
    for (const branch of ['', ' ']) {
      expect((await pushRemote(fx.a, { branch, remote: 'origin', remoteBranch: 'main' })).outcome).toBe('refused');
    }
    expect((await pushRemote(fx.a, { branch: 'does-not-exist', remote: 'origin', remoteBranch: 'main' })).outcome).toBe('refused');
    expect(originSnapshot(fx)).toBe(before);
    expect(originRef(fx, 'refs/heads/main')).toBe(fx.baseSha);
  });

  const BAD_NAMES = ['a:b', 'a+b', 'a*b', 'a^b', 'a?b', 'a[b', 'a\\b', 'a~b', 'a..b', 'a@{b', '-x', 'a\u0001b', 'a/', 'x.lock', 'main:refs/heads/evil', '+main', ':main'];

  it.each(BAD_NAMES)('refuses the ref name %j as source and as destination; origin is unchanged', async (bad) => {
    const fx = makeFx();
    const before = originSnapshot(fx);
    expect((await pushRemote(fx.a, { branch: bad, remote: 'origin', remoteBranch: 'main' })).outcome).toBe('refused');
    expect((await pushRemote(fx.a, { branch: 'main', remote: 'origin', remoteBranch: bad })).outcome).toBe('refused');
    expect(originSnapshot(fx)).toBe(before);
  });

  it('refuses remotes that are unknown or look like options', async () => {
    const fx = makeFx();
    const before = originSnapshot(fx);
    for (const remote of ['nope', '--upload-pack=touch x', '-oProxyCommand=x', '', 'origin:x']) {
      expect((await pushRemote(fx.a, { branch: 'main', remote, remoteBranch: 'main' })).outcome, remote).toBe('refused');
    }
    expect(originSnapshot(fx)).toBe(before);
  });
});

describe('setUpstream', () => {
  it('uses the tracking ref when it exists', async () => {
    const fx = makeFx();
    originBranch(fx, 'topic');
    git(fx.a, ['fetch', 'origin']);
    git(fx.a, ['switch', '-c', 'topic-local']);
    const res = await setUpstream(fx.a, { branch: 'topic-local', remote: 'origin', remoteBranch: 'topic' });
    expect(res.outcome).toBe('done');
    expect(cfg(fx.a, 'branch.topic-local.remote')).toBe('origin');
    expect(cfg(fx.a, 'branch.topic-local.merge')).toBe('refs/heads/topic');
  });

  it('writes the config when the remote branch does not exist yet, and pushes nothing', async () => {
    const fx = makeFx();
    git(fx.a, ['switch', '-c', 'later']);
    const before = originSnapshot(fx);
    const res = await setUpstream(fx.a, { branch: 'later', remote: 'origin', remoteBranch: 'later' });
    expect(res.outcome).toBe('done');
    expect(cfg(fx.a, 'branch.later.remote')).toBe('origin');
    expect(cfg(fx.a, 'branch.later.merge')).toBe('refs/heads/later');
    expect(originSnapshot(fx)).toBe(before);
  });

  it('refuses a missing branch, bad names and an unknown remote; config unchanged', async () => {
    const fx = makeFx();
    git(fx.a, ['switch', '-c', 'later']);
    expect((await setUpstream(fx.a, { branch: 'ghost', remote: 'origin', remoteBranch: 'x' })).outcome).toBe('refused');
    expect((await setUpstream(fx.a, { branch: 'later', remote: 'origin', remoteBranch: 'a:b' })).outcome).toBe('refused');
    expect((await setUpstream(fx.a, { branch: 'later', remote: 'origin', remoteBranch: '-x' })).outcome).toBe('refused');
    expect((await setUpstream(fx.a, { branch: 'later', remote: 'nope', remoteBranch: 'x' })).outcome).toBe('refused');
    expect(cfg(fx.a, 'branch.later.remote')).toBeUndefined();
    expect(cfg(fx.a, 'branch.later.merge')).toBeUndefined();
  });
});

describe('hostile remotes (ext:: and credentials)', () => {
  const marker = (): string => join(fresh('remote-int-marker'), 'ext-ran').replace(/\\/g, '/');
  const ran = (m: string): boolean => existsSync(join(m, '.git')) || existsSync(join(m, 'HEAD'));
  function extRepo(m: string, url = `ext::git init ${m}`): string {
    const base = fresh('remote-int-ext');
    const repo = join(base, 'r');
    mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    configure(repo);
    git(repo, ['config', '--unset', 'protocol.allow']);
    git(repo, ['config', 'protocol.ext.allow', 'always']); // a hostile repo that enables ext in its own config
    commit(repo, { 'a.txt': 'a\n' }, 'First');
    git(repo, ['remote', 'add', 'evil', url]);
    return repo;
  }

  it('control: plain git DOES run the ext helper in this fixture (so the next test can mean something)', () => {
    const m = marker();
    const repo = extRepo(m);
    tryGit(repo, ['fetch', 'evil']); // its own failure afterwards is irrelevant; the helper command is what we look for
    expect(ran(m)).toBe(true);
  });

  it('fetchAll refuses a remote whose url contains :: and never runs the helper', async () => {
    const m = marker();
    const repo = extRepo(m);
    const res = await fetchAll(repo);
    expect(['refused', 'failed']).toContain(res.outcome);
    expect(res.outcome).not.toBe('done');
    expect(ran(m)).toBe(false);
  });

  it('pull and push do not run it either', async () => {
    const m = marker();
    const repo = extRepo(m);
    git(repo, ['config', 'branch.main.remote', 'evil']);
    git(repo, ['config', 'branch.main.merge', 'refs/heads/main']);
    expect((await pullRemote(repo, { mode: 'merge' })).outcome).not.toBe('done');
    expect((await pushRemote(repo, { branch: 'main', remote: 'evil', remoteBranch: 'main' })).outcome).not.toBe('done');
    expect(ran(m)).toBe(false);
  });

  it('an insteadOf rewrite to an ext:: helper is refused and the helper never runs', async () => {
    const m = marker();
    const repo = extRepo(m, 'https://rewrite.invalid/p.git');
    git(repo, ['config', `url.ext::git init ${m} #.insteadOf`, 'https://rewrite.invalid/']);
    const res = await fetchAll(repo);
    expect(res.outcome).toBe('refused');
    expect(ran(m)).toBe(false);
    git(repo, ['config', 'branch.main.remote', 'evil']);
    git(repo, ['config', 'branch.main.merge', 'refs/heads/main']);
    expect((await pullRemote(repo, { mode: 'merge' })).outcome).toBe('refused');
    expect((await pushRemote(repo, { branch: 'main', remote: 'evil', remoteBranch: 'main' })).outcome).toBe('refused');
    expect(ran(m)).toBe(false);
  });

  it('never leaks credentials from the url in any result field', async () => {
    const m = marker();
    const repo = extRepo(m, 'ext::https://alice:s3cret-pw@example.invalid/p.git');
    const res = await fetchAll(repo);
    expect(res.outcome).not.toBe('done'); // the refusal path ran
    expect(JSON.stringify(res)).not.toContain('s3cret-pw');
    expect(ran(m)).toBe(false);
  });
});
