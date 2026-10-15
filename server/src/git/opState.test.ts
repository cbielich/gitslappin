import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOpState } from './opState';

/*
 * Contract the builder must export from server/src/git/opState.ts:
 *   readOpState(root: string): Promise<OpState | undefined>   (undefined = no operation in progress)
 *   OpState = { kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert'; head: string; other?: string; onto?: string;
 *               step?: number; total?: number; message: string; truncated?: boolean }
 *   merge: head = current branch name, other = the branch being merged (name, not sha)
 *   rebase: head = branch being rebased (no refs/heads/), onto = target name, step/total from rebase-merge/msgnum and end
 * Real git in mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted (files are renamed or overwritten).
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');

function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

const GLOBAL_CFG = join(fresh('gitcfg-opstate'), 'global.gitconfig');
writeFileSync(GLOBAL_CFG, '[core]\n\teditor = false\n');

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
// readOpState may spawn git itself; give it the same identity
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com' });

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): number | null => spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true }).status;

function write(repo: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
}
function commit(repo: string, files: Record<string, string>, msg: string): string {
  write(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}
function newRepo(prefix: string): string {
  const repo = join(fresh(prefix), 'r');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  return repo;
}

/** main: base, "Set title to Conflict B", "Third change"; feature/conflict: base, "Set title to Conflict A". */
function conflictRepo(): { repo: string; feature: string } {
  const repo = newRepo('opstate');
  commit(repo, { 'src/config.js': 'title=base\n' }, 'Base');
  git(repo, ['switch', '-c', 'feature/conflict']);
  const feature = commit(repo, { 'src/config.js': 'title=feature\n' }, 'Set title to Conflict A');
  git(repo, ['switch', 'main']);
  commit(repo, { 'a.txt': 'a\n' }, 'First change');
  commit(repo, { 'src/config.js': 'title=main\n' }, 'Set title to Conflict B');
  commit(repo, { 'c.txt': 'c\n' }, 'Third change');
  return { repo, feature };
}
function mergeInProgress(): string {
  const { repo } = conflictRepo();
  expect(tryGit(repo, ['merge', '--no-ff', '--no-edit', 'feature/conflict'])).not.toBe(0);
  expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
  return repo;
}

describe('readOpState', () => {
  it('returns undefined when nothing is in progress', async () => {
    const { repo } = conflictRepo();
    expect(await readOpState(repo)).toBeUndefined();
  });

  it('merge conflict: kind, head and other are branch names', async () => {
    const repo = mergeInProgress();
    const op = await readOpState(repo);
    expect(op).toBeDefined();
    expect(op!.kind).toBe('merge');
    expect(op!.head).toBe('main');
    expect(op!.other).toBe('feature/conflict');
  });

  it('merge message has its "#" lines stripped', async () => {
    const repo = mergeInProgress();
    // path ran: git itself wrote the commented conflict list into MERGE_MSG
    const raw = readFileLines(repo, 'MERGE_MSG');
    expect(raw.some((l) => l.startsWith('#'))).toBe(true);
    const op = await readOpState(repo);
    expect(op!.message).toContain("Merge branch 'feature/conflict'");
    expect(op!.message.split('\n').some((l) => l.startsWith('#'))).toBe(false);
  });

  it('rebase stopped at step 2 of 3 (rebase-merge wins over any other state file)', async () => {
    const { repo } = conflictRepo();
    expect(tryGit(repo, ['rebase', 'feature/conflict'])).not.toBe(0);
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(true);
    const op = await readOpState(repo);
    expect(op).toBeDefined();
    expect(op!.kind).toBe('rebase');
    expect(op!.step).toBe(2);
    expect(op!.total).toBe(3);
    expect(op!.head).toBe('main');
    expect(op!.onto).toBe('feature/conflict');
    expect(op!.message).toContain('Set title to Conflict B');
  });

  it('rebase message keeps its "#" lines', async () => {
    const { repo } = conflictRepo();
    expect(tryGit(repo, ['rebase', 'feature/conflict'])).not.toBe(0);
    const op = await readOpState(repo);
    // UNVERIFIED by the author: git writes the "# Conflicts:" comment into the message of a stopped pick (GitKraken shows it, 14a)
    expect(op!.message).toContain('# Conflicts:');
  });

  it('cherry-pick conflict', async () => {
    const { repo, feature } = conflictRepo();
    expect(tryGit(repo, ['cherry-pick', feature])).not.toBe(0);
    expect(existsSync(join(repo, '.git', 'CHERRY_PICK_HEAD'))).toBe(true);
    expect((await readOpState(repo))!.kind).toBe('cherry-pick');
  });

  it('revert conflict', async () => {
    const repo = newRepo('opstate-revert');
    commit(repo, { 'f.txt': 'v0\n' }, 'Base');
    const c1 = commit(repo, { 'f.txt': 'v1\n' }, 'Change one');
    commit(repo, { 'f.txt': 'v2\n' }, 'Change two');
    expect(tryGit(repo, ['revert', '--no-edit', c1])).not.toBe(0);
    expect(existsSync(join(repo, '.git', 'REVERT_HEAD'))).toBe(true);
    expect((await readOpState(repo))!.kind).toBe('revert');
  });

  it('git am in progress (rebase-apply/applying) counts as no operation', async () => {
    const { repo, feature } = conflictRepo();
    const patch = join(fresh('opstate-patch'), 'a.patch');
    writeFileSync(patch, git(repo, ['format-patch', '-1', '--stdout', feature]));
    expect(tryGit(repo, ['am', patch])).not.toBe(0);
    expect(existsSync(join(repo, '.git', 'rebase-apply', 'applying'))).toBe(true); // the code path under test exists
    expect(await readOpState(repo)).toBeUndefined();
  });

  it('a MERGE_MSG that is a symlink is not followed', async (ctx) => {
    const repo = mergeInProgress();
    const secret = join(fresh('opstate-secret'), 'secret.txt');
    writeFileSync(secret, 'TOP-SECRET-CONTENT\n');
    const msg = join(repo, '.git', 'MERGE_MSG');
    renameSync(msg, `${msg}.orig`);
    try {
      symlinkSync(secret, msg);
    } catch {
      ctx.skip(); // creating symlinks needs a privilege on Windows
      return;
    }
    const op = await readOpState(repo);
    expect(op?.message ?? '').not.toContain('TOP-SECRET');
  });

  it('a huge MERGE_MSG is capped at 64 KB and flagged', async () => {
    const repo = mergeInProgress();
    writeFileSync(join(repo, '.git', 'MERGE_MSG'), `Merge branch 'feature/conflict'\n\n${'x'.repeat(10) + 'line of text\n'.repeat(40_000)}`);
    const op = await readOpState(repo);
    expect(op).toBeDefined();
    expect(op!.message.length).toBeLessThanOrEqual(64 * 1024);
    expect(op!.truncated).toBe(true);
  });

  it('NUL and control characters are stripped from the message (newline and tab stay)', async () => {
    const repo = mergeInProgress();
    writeFileSync(join(repo, '.git', 'MERGE_MSG'), 'Subject\u0000with\u001b[31mcontrol\u0007\n\nbody\tline\n');
    const op = await readOpState(repo);
    expect(op!.message).toContain('Subject');
    expect(op!.message).toContain('body\tline');
    expect(op!.message).not.toMatch(/[\u0000\u0007\u001b]/);
  });
});

function readFileLines(repo: string, name: string): string[] {
  const rel = execFileSync('git', ['rev-parse', '--git-path', name], { cwd: repo, env: ENV, encoding: 'utf8' }).trim();
  return readFileSync(join(repo, rel), 'utf8').split('\n');
}
