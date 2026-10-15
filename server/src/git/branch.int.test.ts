import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/*
 * Integration tests with REAL git, in fresh mkdtemp folders under os.tmpdir()/gitslappin-tests.
 * Nothing is ever deleted. They check the exact git command forms of the phase-5 design
 * (check-ref-format --branch, switch --no-guess / --track -c / --detach, branch, rev-parse ^{commit})
 * and what git does with them: tracking setup, refusal to overwrite, dirty-tree conflict.
 */

// Each test builds a fresh repo with real git (about 3 s on this Windows box); the slash-remote test builds two. The 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000 });

const ROOT = join(tmpdir(), 'gitslappin-tests');

function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const EMPTY_CONFIG = join(fresh('gitcfg-branch'), 'empty.gitconfig');
writeFileSync(EMPTY_CONFIG, '');

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
};
delete ENV.GITSLAPPIN_TOKEN;

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

const tryGit = (cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const rev = (cwd: string, ref: string): string => git(cwd, ['rev-parse', '--verify', ref]).trim();
const currentBranch = (cwd: string): string => git(cwd, ['branch', '--show-current']).trim();
const refExists = (cwd: string, ref: string): boolean => tryGit(cwd, ['show-ref', '--verify', '--quiet', ref]).status === 0;

interface Fx {
  repo: string;
  origin: string;
  shas: string[];
}

/** 3 commits on main; origin has main, remote-only (C2), same (C2, also local), dup (C3) while local dup is at C1. */
function makeRepo(): Fx {
  const base = fresh('branch-int');
  const origin = join(base, 'origin.git');
  const repo = join(base, 'r');
  mkdirSync(origin);
  mkdirSync(repo);
  git(origin, ['init', '--bare', '-b', 'main']);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  const shas: string[] = [];
  for (let i = 1; i <= 3; i++) {
    writeFileSync(join(repo, 'f.txt'), `v${i}\n`);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', `C${i}`]);
    shas.push(rev(repo, 'HEAD'));
  }
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', 'origin', 'main', `${shas[1]}:refs/heads/remote-only`, `${shas[1]}:refs/heads/same`, `${shas[2]}:refs/heads/dup`]);
  git(repo, ['fetch', 'origin']);
  git(repo, ['branch', 'same', shas[1]!]);
  git(repo, ['branch', 'dup', shas[0]!]);
  git(repo, ['branch', 'feature/one', shas[1]!]);
  return { repo, origin, shas };
}

describe('validBranchName: check-ref-format --branch', () => {
  it('prints the name for a valid one (exit 0, stdout equals the name)', () => {
    const { repo } = makeRepo();
    for (const n of ['good', 'feature/x', 'v1.0']) {
      const r = tryGit(repo, ['check-ref-format', '--branch', n]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(n);
    }
  });

  it('fails for invalid names', () => {
    const { repo } = makeRepo();
    for (const n of ['a..b', 'a b', 'x.lock', 'a~b', '-x']) {
      expect(tryGit(repo, ['check-ref-format', '--branch', n]).status, n).not.toBe(0);
    }
  });

  it('expands @{-1}, which is why the design also requires stdout to equal the name', () => {
    const { repo } = makeRepo();
    git(repo, ['switch', '--no-guess', '--end-of-options', 'same']);
    const r = tryGit(repo, ['check-ref-format', '--branch', '@{-1}']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('main');
    expect(r.stdout.trim()).not.toBe('@{-1}');
  });
});

describe('checkout local', () => {
  it('switch --no-guess switches to an existing local branch', () => {
    const { repo, shas } = makeRepo();
    git(repo, ['switch', '--no-guess', '--end-of-options', 'feature/one']);
    expect(currentBranch(repo)).toBe('feature/one');
    expect(rev(repo, 'HEAD')).toBe(shas[1]);
  });

  it('--no-guess does not create a tracking branch from a remote-only name', () => {
    const { repo } = makeRepo();
    const r = tryGit(repo, ['switch', '--no-guess', '--end-of-options', 'remote-only']);
    expect(r.status).not.toBe(0);
    expect(currentBranch(repo)).toBe('main');
    expect(refExists(repo, 'refs/heads/remote-only')).toBe(false);
  });
});

describe('checkout remote', () => {
  it('no local branch: switch --track -c creates it with upstream set', () => {
    const { repo, shas } = makeRepo();
    git(repo, ['switch', '--track', '-c', 'remote-only', '--end-of-options', 'origin/remote-only']);
    expect(currentBranch(repo)).toBe('remote-only');
    expect(rev(repo, 'HEAD')).toBe(shas[1]);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'remote-only@{upstream}']).trim()).toBe('origin/remote-only');
  });

  it('local branch at the same sha: plain switch to it', () => {
    const { repo, shas } = makeRepo();
    expect(rev(repo, 'refs/heads/same')).toBe(rev(repo, 'refs/remotes/origin/same'));
    git(repo, ['switch', '--no-guess', '--end-of-options', 'same']);
    expect(currentBranch(repo)).toBe('same');
    expect(rev(repo, 'HEAD')).toBe(shas[1]);
  });

  it('local branch at a different sha: shas differ, and switch --track -c refuses and leaves the branch alone (never -C)', () => {
    const { repo, shas } = makeRepo();
    expect(rev(repo, 'refs/heads/dup')).toBe(shas[0]);
    expect(rev(repo, 'refs/remotes/origin/dup')).toBe(shas[2]);
    const r = tryGit(repo, ['switch', '--track', '-c', 'dup', '--end-of-options', 'origin/dup']);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain('already exists');
    expect(rev(repo, 'refs/heads/dup')).toBe(shas[0]);
    expect(currentBranch(repo)).toBe('main');
  });

  it('remote whose name contains a slash: tracking branch is feat/x, not a/feat/x', () => {
    const { repo, shas } = makeRepo();
    const team = join(fresh('branch-int-team'), 'team.git');
    mkdirSync(team);
    git(team, ['init', '--bare', '-b', 'main']);
    git(repo, ['remote', 'add', 'team/a', team]);
    git(repo, ['push', 'team/a', `${shas[2]}:refs/heads/feat/x`]);
    git(repo, ['fetch', 'team/a']);
    const remotes = git(repo, ['remote']).split('\n').filter(Boolean);
    expect(remotes).toContain('team/a');
    expect(refExists(repo, 'refs/remotes/team/a/feat/x')).toBe(true);
    // Derive the local name the way the design says: strip the longest listed remote name + '/'.
    const full = 'team/a/feat/x';
    const remote = remotes.filter((r) => full.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0]!;
    const local = full.slice(remote.length + 1);
    expect(local).toBe('feat/x');
    git(repo, ['switch', '--track', '-c', local, '--end-of-options', full]);
    expect(currentBranch(repo)).toBe('feat/x');
    expect(rev(repo, 'HEAD')).toBe(shas[2]);
    expect(git(repo, ['config', '--get', 'branch.feat/x.remote']).trim()).toBe('team/a');
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'feat/x@{upstream}']).trim()).toBe('team/a/feat/x');
  });
});

describe('checkout commit', () => {
  it('switch --detach gives a detached HEAD at the sha', () => {
    const { repo, shas } = makeRepo();
    git(repo, ['switch', '--detach', '--end-of-options', shas[0]!]);
    expect(rev(repo, 'HEAD')).toBe(shas[0]);
    expect(tryGit(repo, ['symbolic-ref', '-q', 'HEAD']).status).toBe(1);
    expect(currentBranch(repo)).toBe('');
  });
});

describe('create branch', () => {
  it('with checkout: switch -c <name> --end-of-options <start>', () => {
    const { repo, shas } = makeRepo();
    git(repo, ['switch', '-c', 'made', '--end-of-options', shas[0]!]);
    expect(currentBranch(repo)).toBe('made');
    expect(rev(repo, 'HEAD')).toBe(shas[0]);
  });

  it('without checkout: branch --end-of-options <name> <start> leaves HEAD alone', () => {
    const { repo, shas } = makeRepo();
    git(repo, ['branch', '--end-of-options', 'made', shas[0]!]);
    expect(rev(repo, 'refs/heads/made')).toBe(shas[0]);
    expect(currentBranch(repo)).toBe('main');
    expect(rev(repo, 'HEAD')).toBe(shas[2]);
  });

  it('without start the branch is created at HEAD', () => {
    const { repo, shas } = makeRepo();
    git(repo, ['branch', '--end-of-options', 'at-head', 'HEAD']);
    expect(rev(repo, 'refs/heads/at-head')).toBe(shas[2]);
  });

  it('an existing name is refused and the branch is not moved (never -C or -f)', () => {
    const { repo, shas } = makeRepo();
    expect(tryGit(repo, ['branch', '--end-of-options', 'dup', 'HEAD']).status).not.toBe(0);
    expect(tryGit(repo, ['switch', '-c', 'dup', '--end-of-options', 'HEAD']).status).not.toBe(0);
    expect(rev(repo, 'refs/heads/dup')).toBe(shas[0]);
    expect(currentBranch(repo)).toBe('main');
  });
});

describe('start resolution: rev-parse --verify --end-of-options <x>^{commit}', () => {
  it('resolves a commit-ish to a full sha', () => {
    const { repo, shas } = makeRepo();
    expect(git(repo, ['rev-parse', '--verify', '--end-of-options', `${shas[0]}^{commit}`]).trim()).toBe(shas[0]);
    expect(git(repo, ['rev-parse', '--verify', '--end-of-options', 'origin/dup^{commit}']).trim()).toBe(shas[2]);
  });

  it('a blob path expression is not a commit', () => {
    const { repo } = makeRepo();
    expect(tryGit(repo, ['rev-parse', '--verify', '--end-of-options', 'HEAD:f.txt^{commit}']).status).not.toBe(0);
    expect(tryGit(repo, ['rev-parse', '--verify', '--end-of-options', ':f.txt^{commit}']).status).not.toBe(0);
  });

  it('a reflog expression resolves to a commit sha (so only the sha is passed on)', () => {
    const { repo } = makeRepo();
    const r = tryGit(repo, ['rev-parse', '--verify', '--end-of-options', 'HEAD@{1}^{commit}']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('an option-like value is not taken as an option', () => {
    const { repo } = makeRepo();
    expect(tryGit(repo, ['rev-parse', '--verify', '--end-of-options', '--all^{commit}']).status).not.toBe(0);
  });
});

describe('dirty-tree checkout conflict', () => {
  it('git refuses, says why on stderr, and the working file is untouched', () => {
    const base = fresh('branch-int-dirty');
    const repo = join(base, 'r');
    mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'f.txt'), 'base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'base']);
    git(repo, ['switch', '-c', 'other']);
    writeFileSync(join(repo, 'f.txt'), 'other\n');
    git(repo, ['commit', '-am', 'other change']);
    git(repo, ['switch', 'main']);
    writeFileSync(join(repo, 'f.txt'), 'local edit\n');
    const r = tryGit(repo, ['switch', '--no-guess', '--end-of-options', 'other']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('would be overwritten');
    expect(currentBranch(repo)).toBe('main');
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('local edit\n');
  });
});
