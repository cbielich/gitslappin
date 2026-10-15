import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { discardFiles } from './destructive';
import { getHistory, refsFingerprint } from './history';
import { undo } from './undo';

vi.setConfig({ testTimeout: 90_000 });

/*
 * Data safety after the GitGit -> GitSlappin rename: repos used before it hold safety snapshots under refs/gitgit/*.
 * They must stay restorable (the objects stay reachable through the old refs), and stay out of the graph, like the new refs/gitslappin/*.
 * Real git in fresh mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing here deletes a file; the only `git gc` runs inside a throwaway repo.
 */

const ROOT = resolve(join(tmpdir(), 'gitslappin-tests'));
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.toLowerCase().startsWith(ROOT.toLowerCase()) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const CFG_DIR = fresh('gitcfg-ownrefs-int');
const EMPTY_GLOBAL = join(CFG_DIR, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL, '');
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
});
delete process.env.GITSLAPPIN_TOKEN;

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

function newRepo(): string {
  const repo = join(fresh('ownrefs-int'), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  for (const [k, v] of [['user.name', 'Test Author'], ['user.email', 'author@example.com'], ['core.autocrlf', 'false'], ['gc.auto', '0']]) git(repo, ['config', k!, v!]);
  writeFileSync(join(repo, 'a.txt'), 'a1\na2\n');
  writeFileSync(join(repo, 'b.txt'), 'b1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'Base']);
  return repo;
}

const refLines = (repo: string, prefix: string): string[] => git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', prefix]).split('\n').filter(Boolean);
const NEW_NS = 'refs/gitslappin/';
const OLD_NS = 'refs/gitgit/';

describe('old refs/gitgit/* snapshots after the rename', () => {
  it('an old-namespace undo snapshot can still be restored, and it is hidden from the graph (like the new namespace)', async () => {
    const repo = newRepo();
    writeFileSync(join(repo, 'a.txt'), 'a edited\n');
    writeFileSync(join(repo, 'u.txt'), 'untracked bytes\n');
    expect((await discardFiles(repo, ['a.txt', 'u.txt'])).outcome).toBe('done');
    expect(existsSync(join(repo, 'u.txt'))).toBe(false);

    // New writes go to the new namespace only.
    const pins = refLines(repo, `${NEW_NS}undo/`);
    expect(pins.length).toBeGreaterThan(0);
    expect(refLines(repo, `${OLD_NS}undo/`)).toEqual([]);

    // Make this repo look like one used before the rename: the same objects pinned under the OLD namespace only.
    for (const line of pins) {
      const [name, sha] = line.split(' ');
      git(repo, ['update-ref', name!.replace(NEW_NS, OLD_NS), sha!]);
      git(repo, ['update-ref', '-d', name!]);
    }
    expect(refLines(repo, `${NEW_NS}undo/`)).toEqual([]);
    expect(refLines(repo, `${OLD_NS}undo/`).length).toBe(pins.length);

    // The graph never shows a snapshot commit from either namespace.
    const snapshotCommits = refLines(repo, `${OLD_NS}undo/`).map((l) => l.split(' ')).filter(([n]) => git(repo, ['cat-file', '-t', n!]).trim() === 'commit').map(([, s]) => s!);
    expect(snapshotCommits.length).toBeGreaterThan(0);
    const before = await getHistory(repo, 'ownrefs-old');
    for (const sha of snapshotCommits) expect(before.commits.some((c) => c.sha === sha)).toBe(false);
    expect(before.commits.length).toBe(1);

    // Only the old refs keep the snapshot alive: expire and prune inside this throwaway repo, then undo.
    git(repo, ['reflog', 'expire', '--expire=now', '--all']);
    git(repo, ['gc', '--prune=now', '-q']);
    expect((await undo(repo)).outcome).toBe('done');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a edited\n');
    expect(readFileSync(join(repo, 'u.txt'), 'utf8')).toBe('untracked bytes\n');
  });

  it('the refs fingerprint and the graph ignore both namespaces (so a new pin never refreshes or changes the graph)', async () => {
    const repo = newRepo();
    const base = await refsFingerprint(repo, 'ownrefs-fp');
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['update-ref', `${OLD_NS}undo/${sha}`, sha]);
    git(repo, ['update-ref', `${NEW_NS}stash-keep/${sha}`, sha]);
    const after = await refsFingerprint(repo, 'ownrefs-fp');
    expect(after.fingerprint).toBe(base.fingerprint);
    expect(after.empty).toBe(false);
    expect((await getHistory(repo, 'ownrefs-fp2')).commits.map((c) => c.sha)).toEqual([sha]);
  });

  it('a commit reachable only through an own ref (either namespace) is not a graph node', async () => {
    const repo = newRepo();
    const main = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['checkout', '-q', '--detach']);
    writeFileSync(join(repo, 'b.txt'), 'b2\n');
    git(repo, ['commit', '-qam', 'Hidden one']);
    const hiddenOld = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'Hidden two']);
    const hiddenNew = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['update-ref', `${OLD_NS}undo/${hiddenOld}`, hiddenOld]);
    git(repo, ['update-ref', `${NEW_NS}undo/${hiddenNew}`, hiddenNew]);
    git(repo, ['checkout', '-q', 'main']);
    const shas = (await getHistory(repo, 'ownrefs-reach')).commits.map((c) => c.sha);
    expect(shas).toEqual([main]);
  });
});
