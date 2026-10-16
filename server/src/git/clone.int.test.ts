import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cloneRepo } from './clone';

/*
 * Contract the builder must export from server/src/git/clone.ts (V1 design + audit fixes 1, 2, 5, 6):
 *   cloneRepo(req: CloneRequest, opts: CloneOptions): Promise<CloneResult>
 *     CloneRequest = { parent: string; url: string; shallow?: {...}; sparse?: {...} }   (same shapes as buildCloneArgs; the folder name is repoNameFromUrl(url))
 *     CloneOptions = { roots: string[]; pathMap?: PathPair[]; signal?: AbortSignal; onProgress?: (p: { phase: string; percent: number }) => void }
 *     CloneResult  = { type: 'done'; path: string }
 *                  | { type: 'error'; error: string; stderr: string }      git ran and failed (both fields scrubbed)
 *                  | { type: 'cancelled'; path: string }                   the signal aborted; the partial folder is kept
 *                  | { type: 'refused'; error: string }                    validation failed; git was NOT spawned, nothing was created
 *   It validates parent / target / URL exactly as the design says (realpath under roots, target missing or an EMPTY plain directory,
 *   lstat not a junction/symlink, roots-mode file:// goes through realpath + isUnderRoots), then runs git through runGitProgress.
 *
 * Real git on file:// origins in mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted. The one non-file URL
 * (credentials test) points at 127.0.0.1:9, which refuses the connection locally; it never leaves this machine.
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

const CFG_DIR = fresh('gitcfg-clone-int');
const EMPTY_GLOBAL = join(CFG_DIR, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL, '');
const ASKPASS = join(CFG_DIR, process.platform === 'win32' ? 'fail-askpass.cmd' : 'fail-askpass.sh');
writeFileSync(ASKPASS, process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
Object.assign(process.env, {
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
});
delete process.env.GITSLAPPIN_TOKEN;
delete process.env.GIT_SSH;
delete process.env.GIT_SSH_COMMAND;

const git = (cwd: string, args: string[], when?: string): string =>
  execFileSync('git', args, {
    cwd,
    env: when ? { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : process.env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const tryGit = (cwd: string, args: string[]): { status: number | null; stdout: string } => {
  const r = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout };
};
const count = (repo: string): number => Number(git(repo, ['rev-list', '--count', 'HEAD']).trim());

function commitIn(work: string, files: Record<string, string | Buffer>, msg: string, when: string): void {
  for (const [rel, data] of Object.entries(files)) {
    const full = join(work, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, data);
  }
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', msg], when);
}

interface Origin {
  base: string;
  /** bare repo path; its folder name is "srcrepo.git" so a clone lands in "srcrepo" */
  bare: string;
  url: string;
}
/** main: c1 (2020) README+src/a.txt+docs/b.txt, c2 (2026-01-01) edits src/a.txt, c3 (2026-01-02) root.txt. dev: one more commit with dev.txt. */
function makeOrigin(extra?: (work: string) => void): Origin {
  const base = fresh('clone-origin');
  const bare = join(base, 'srcrepo.git');
  mkdirSync(bare);
  git(bare, ['init', '--bare', '-b', 'main']);
  git(bare, ['config', 'uploadpack.allowFilter', 'true']);
  git(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const work = join(base, 'work');
  mkdirSync(work);
  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'core.autocrlf', 'false']);
  commitIn(work, { 'README.md': '# origin\n', 'src/a.txt': 'a1\n', 'docs/b.txt': 'b\n' }, 'c1', '2020-01-01T10:00:00+00:00');
  commitIn(work, { 'src/a.txt': 'a2\n' }, 'c2', '2026-01-01T10:00:00+00:00');
  commitIn(work, { 'root.txt': 'root\n' }, 'c3', '2026-01-02T10:00:00+00:00');
  git(work, ['switch', '-c', 'dev']);
  commitIn(work, { 'dev.txt': 'dev\n' }, 'd1', '2026-01-03T10:00:00+00:00');
  git(work, ['switch', 'main']);
  extra?.(work);
  const url = pathToFileURL(bare).href;
  git(work, ['remote', 'add', 'origin', url]);
  git(work, ['push', 'origin', 'main', 'dev']);
  if (!url.startsWith('file://') || !underRoot(bare)) throw new Error('fixture origin must be file:// inside gitslappin-tests');
  return { base, bare, url };
}

/** A clone parent that lives next to the origin under one roots folder. */
function setup(): { o: Origin; roots: string[]; parent: string; target: string } {
  const o = makeOrigin();
  const parent = join(o.base, 'parent');
  mkdirSync(parent);
  return { o, roots: [o.base], parent, target: join(parent, 'srcrepo') };
}

const cfg = (repo: string, key: string): string | undefined => {
  const r = tryGit(repo, ['config', '--local', '--get', key]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const sameDir = (a: string, b: string): boolean => norm(a) === norm(b);

describe('cloneRepo: clones over file://', () => {
  it('full clone: all commits, no .git/shallow, origin set, progress phases are strings', async () => {
    const { o, roots, parent, target } = setup();
    const seen: { phase: string; percent: number }[] = [];
    const res = await cloneRepo({ parent, url: o.url }, { roots, onProgress: (p) => seen.push(p) });
    expect(res.type).toBe('done');
    if (res.type !== 'done') return;
    expect(sameDir(res.path, target)).toBe(true);
    expect(count(target)).toBe(3);
    expect(existsSync(join(target, '.git', 'shallow'))).toBe(false);
    expect(readFileSync(join(target, 'src', 'a.txt'), 'utf8')).toBe('a2\n');
    expect(cfg(target, 'remote.origin.url')).toBe(o.url);
    for (const p of seen) {
      expect(typeof p.phase).toBe('string');
      expect(p.percent).toBeGreaterThanOrEqual(0);
      expect(p.percent).toBeLessThanOrEqual(100);
    }
  });

  it('depth 1: .git/shallow exists and one commit', async () => {
    const { o, roots, parent, target } = setup();
    const res = await cloneRepo({ parent, url: o.url, shallow: { by: 'depth', depth: 1 } }, { roots });
    expect(res.type).toBe('done');
    expect(existsSync(join(target, '.git', 'shallow'))).toBe(true);
    expect(count(target)).toBe(1);
  });

  it('since 2025-01-01: only the two 2026 commits', async () => {
    const { o, roots, parent, target } = setup();
    const res = await cloneRepo({ parent, url: o.url, shallow: { by: 'since', since: '2025-01-01' } }, { roots });
    expect(res.type).toBe('done');
    expect(count(target)).toBe(2);
    expect(existsSync(join(target, '.git', 'shallow'))).toBe(true);
  });

  it('branch dev: HEAD is dev and dev.txt is checked out', async () => {
    const { o, roots, parent, target } = setup();
    const res = await cloneRepo({ parent, url: o.url, shallow: { by: 'depth', depth: 1, branch: 'dev' } }, { roots });
    expect(res.type).toBe('done');
    expect(git(target, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('dev');
    expect(existsSync(join(target, 'dev.txt'))).toBe(true);
  });

  it('sparse src: only src/ and the root files are checked out', async () => {
    const { o, roots, parent, target } = setup();
    const res = await cloneRepo({ parent, url: o.url, sparse: { paths: ['src'], blobless: false } }, { roots });
    expect(res.type).toBe('done');
    expect(existsSync(join(target, 'src', 'a.txt'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    expect(existsSync(join(target, 'root.txt'))).toBe(true);
    expect(existsSync(join(target, 'docs'))).toBe(false);
  });

  it('blobless: the remote is a promisor with partialclonefilter blob:none', async () => {
    const { o, roots, parent, target } = setup();
    const res = await cloneRepo({ parent, url: o.url, sparse: { paths: [], blobless: true } }, { roots });
    expect(res.type).toBe('done');
    expect(cfg(target, 'remote.origin.promisor')).toBe('true');
    expect(cfg(target, 'remote.origin.partialclonefilter')).toBe('blob:none');
  });

  it('with no roots set, a file:// origin anywhere is fine (no change to non-roots mode)', async () => {
    const o = makeOrigin();
    const parent = fresh('clone-noroots-parent');
    const res = await cloneRepo({ parent, url: o.url }, { roots: [] });
    expect(res.type).toBe('done');
    expect(count(join(parent, 'srcrepo'))).toBe(3);
  });
});

describe('cloneRepo: the target folder', () => {
  it('a non-empty target is refused before git runs and is left untouched; an empty one is accepted', async () => {
    const { o, roots, parent, target } = setup();
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'mine\n');
    const refused = await cloneRepo({ parent, url: o.url }, { roots });
    expect(refused.type).toBe('refused');
    expect(readdirSync(target)).toEqual(['keep.txt']);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('mine\n');

    const parent2 = join(o.base, 'parent2');
    mkdirSync(join(parent2, 'srcrepo'), { recursive: true });
    const accepted = await cloneRepo({ parent: parent2, url: o.url }, { roots });
    expect(accepted.type).toBe('done');
    expect(count(join(parent2, 'srcrepo'))).toBe(3);
  });

  it('an existing git repository as target is refused and its HEAD does not move', async () => {
    const { o, roots, parent, target } = setup();
    mkdirSync(target);
    git(target, ['init', '-b', 'main']);
    writeFileSync(join(target, 'f.txt'), 'x\n');
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'mine']);
    const before = git(target, ['rev-parse', 'HEAD']).trim();
    expect((await cloneRepo({ parent, url: o.url }, { roots })).type).toBe('refused');
    expect(git(target, ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(cfg(target, 'remote.origin.url')).toBeUndefined();
  });

  it('audit fix 1: a junction/symlink target to an empty directory outside the roots is refused, and that directory stays empty', async () => {
    const { o, roots, parent, target } = setup();
    const outside = fresh('clone-junction-outside'); // a sibling mkdtemp folder, not inside roots
    symlinkSync(outside, target, 'junction');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    const res = await cloneRepo({ parent, url: o.url }, { roots });
    expect(res.type).toBe('refused');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('the parent must exist, be a folder and be under the roots', async () => {
    const { o, roots, parent } = setup();
    const file = join(o.base, 'afile.txt');
    writeFileSync(file, 'x');
    const outsideParent = fresh('clone-parent-outside');
    for (const bad of [join(o.base, 'missing'), file, outsideParent, '\\\\server\\share\\x', 'relative/parent']) {
      const res = await cloneRepo({ parent: bad, url: o.url }, { roots });
      expect(res.type, bad).toBe('refused');
    }
    expect(readdirSync(outsideParent)).toEqual([]);
    expect((await cloneRepo({ parent, url: o.url }, { roots })).type).toBe('done'); // the same call with a good parent works
  });

  it('a folder name derived from the URL that is not a legal name is refused (reserved name, "..")', async () => {
    const { roots, parent } = setup();
    for (const url of ['https://example.invalid/o/CON.git', 'https://example.invalid/o/NUL', 'https://example.invalid/o/..']) {
      const res = await cloneRepo({ parent, url }, { roots });
      expect(res.type, url).toBe('refused');
    }
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe('cloneRepo: file:// and local URLs in roots mode (audit fix 2)', () => {
  it('a file:// origin outside the roots is refused, and nothing is created', async () => {
    const outsideOrigin = makeOrigin(); // a different mkdtemp folder
    const { roots, parent } = setup();
    const res = await cloneRepo({ parent, url: outsideOrigin.url }, { roots });
    expect(res.type).toBe('refused');
    expect(readdirSync(parent)).toEqual([]);
  });

  it('a file:// origin inside the roots that is really a junction to a folder outside them is refused (realpath)', async () => {
    const outsideOrigin = makeOrigin();
    const { roots, parent, o } = setup();
    const link = join(o.base, 'srcrepo.git.link');
    symlinkSync(outsideOrigin.bare, link, 'junction');
    const res = await cloneRepo({ parent, url: pathToFileURL(link).href }, { roots });
    expect(res.type).toBe('refused');
    expect(readdirSync(parent)).toEqual([]);
  });

  it('a bare local path and the file://host form are refused whatever the roots', async () => {
    const { o, roots, parent } = setup();
    for (const url of [o.bare, `file://localhost${pathToFileURL(o.bare).pathname}`, `file:////${o.bare.replace(/\\/g, '/')}`]) {
      expect((await cloneRepo({ parent, url }, { roots })).type, url).toBe('refused');
      expect((await cloneRepo({ parent, url }, { roots: [] })).type, `${url} (no roots)`).toBe('refused');
    }
    expect(readdirSync(parent)).toEqual([]);
  });

  it('ext:: is refused before anything runs (marker never created)', async () => {
    const { roots, parent } = setup();
    const marker = join(fresh('clone-ext-marker'), 'ext-ran').replace(/\\/g, '/');
    const res = await cloneRepo({ parent, url: `ext::git init ${marker}` }, { roots });
    expect(res.type).toBe('refused');
    expect(existsSync(join(marker, '.git')) || existsSync(join(marker, 'HEAD'))).toBe(false);
  });
});

describe('cloneRepo: cancel and errors', () => {
  it('abort: reports cancelled with the target path; on Windows the partial folder is kept (nothing is deleted)', async () => {
    // A heavier origin so the clone is still running when the first progress line arrives.
    const o = makeOrigin((work) => {
      const files: Record<string, Buffer> = {};
      for (let i = 0; i < 25; i++) files[`blob/f${i}.bin`] = randomBytes(1024 * 1024);
      commitIn(work, files, 'big', '2026-01-04T10:00:00+00:00');
    });
    const parent = join(o.base, 'parent');
    mkdirSync(parent);
    const ac = new AbortController();
    let progressSeen = 0;
    const res = await cloneRepo(
      { parent, url: o.url },
      {
        roots: [o.base],
        signal: ac.signal,
        onProgress: () => {
          progressSeen++;
          ac.abort();
        },
      },
    );
    expect(progressSeen, 'the clone must have reported progress before the abort').toBeGreaterThan(0);
    expect(res.type).toBe('cancelled');
    if (res.type !== 'cancelled') return;
    expect(sameDir(res.path, join(parent, 'srcrepo'))).toBe(true);
    // UNVERIFIED on POSIX: plain SIGTERM lets git clean its own folder up; Windows taskkill /F cannot.
    if (process.platform === 'win32') expect(existsSync(res.path)).toBe(true);
  });

  it('git failing gives type error with scrubbed error and stderr (credentials never come back)', async () => {
    const { parent } = setup();
    const SECRET = 'sup3r-s3cret-pw';
    const res = await cloneRepo({ parent, url: `https://alice:${SECRET}@127.0.0.1:9/nope.git` }, { roots: [] });
    expect(res.type).toBe('error'); // git really ran and failed
    if (res.type !== 'error') return;
    expect(res.stderr.length).toBeGreaterThan(0);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });
});
