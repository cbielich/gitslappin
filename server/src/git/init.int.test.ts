import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initRepo, listTemplates } from './init';

/*
 * Contract the builder must export from server/src/git/init.ts (V1 design "API" init steps + audit fix 1):
 *   initRepo(req: { parent: string; name: string; defaultBranch?: string; gitignore?: string; license?: string },
 *            opts: { roots: string[]; pathMap?: PathPair[]; templatesDir?: string }): Promise<InitResult>
 *     templatesDir defaults to server/templates (the tests read the same folder: server/src/git/../../templates).
 *     InitResult = { type: 'done'; path: string }                                          repo created and "Initial commit" made
 *                | { type: 'refused'; error: string }                                      validation failed; NOTHING was created or changed
 *                | { type: 'commit-failed'; path: string; error: string; stderr: string }  repo + files stay, commit failed (e.g. no identity)
 *     Steps: `init -- <full>`, `symbolic-ref HEAD refs/heads/<branch>` (default "main"), write README.md ("# <name>\n"), .gitignore, LICENSE.md
 *     with the 'wx' flag, `add -- <only the files written>`, `commit -m "Initial commit"`.
 *   listTemplates(templatesDir?): { gitignore: string[]; license: { id: string; title: string }[] }
 *     gitignore = ids (file names without ".gitignore"), license = index.json {id,title}. initRepo accepts only these ids.
 *   License text = template with [year] -> current year and [username] -> `git config user.name` (placeholder left when unset); [email]/[project] untouched.
 *
 * Real git, mkdtemp folders only. Nothing is deleted. Tests that need a different identity/config swap GIT_CONFIG_GLOBAL
 * (and restore it in finally); tests in this file run one after another.
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

const CFG_DIR = fresh('gitcfg-init-int');
const EMPTY_GLOBAL = join(CFG_DIR, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL, '');
const NAMED_GLOBAL = join(CFG_DIR, 'named.gitconfig');
writeFileSync(NAMED_GLOBAL, '[user]\n\tname = Tester Name\n\temail = tester@example.com\n');
const STRICT_GLOBAL = join(CFG_DIR, 'strict.gitconfig');
writeFileSync(STRICT_GLOBAL, '[user]\n\tuseConfigOnly = true\n');
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

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const tryGit = (cwd: string, args: string[]): { status: number | null; stdout: string } => {
  const r = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout };
};
const TEMPLATES = resolve(__dirname, '..', '..', 'templates');
const tplGitignore = (id: string): Buffer => readFileSync(join(TEMPLATES, 'gitignore', `${id}.gitignore`));
const tplLicense = (id: string): string => readFileSync(join(TEMPLATES, 'license', `${id}.txt`), 'utf8');

const setup = (): { base: string; roots: string[]; parent: string } => {
  const base = fresh('init-base');
  const parent = join(base, 'parent');
  mkdirSync(parent);
  return { base, roots: [base], parent };
};

describe('listTemplates', () => {
  it('returns the bundled ids: 127 gitignore ids (Node among them) and the 17 licenses with their index.json titles', () => {
    const t = listTemplates();
    expect(t.gitignore).toHaveLength(127);
    expect(t.gitignore).toContain('Node');
    expect(t.license).toHaveLength(17);
    const index = JSON.parse(readFileSync(join(TEMPLATES, 'license', 'index.json'), 'utf8')) as { id: string; title: string }[];
    expect(t.license).toContainEqual({ id: 'mit-license', title: index.find((i) => i.id === 'mit-license')!.title });
    expect(Object.keys(t.license[0]!).sort()).toEqual(['id', 'title']);
  });
});

describe('initRepo: the happy path', () => {
  it('Node + MIT: one "Initial commit" with exactly README.md, .gitignore and LICENSE.md; bytes equal the bundled templates', async () => {
    const { roots, parent } = setup();
    const res = await withEnv({ GIT_CONFIG_GLOBAL: NAMED_GLOBAL }, () => initRepo({ parent, name: 'newrepo', gitignore: 'Node', license: 'mit-license' }, { roots }));
    expect(res.type).toBe('done');
    if (res.type !== 'done') return;
    const repo = join(parent, 'newrepo');
    expect(norm(res.path)).toBe(norm(repo));
    expect(git(repo, ['log', '--format=%s']).trim().split('\n')).toEqual(['Initial commit']);
    expect(git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n').sort()).toEqual(['.gitignore', 'LICENSE.md', 'README.md']);
    expect(readFileSync(join(repo, 'README.md')).equals(Buffer.from('# newrepo\n'))).toBe(true);
    expect(readFileSync(join(repo, '.gitignore')).equals(tplGitignore('Node'))).toBe(true);
    const expectedLicense = tplLicense('mit-license').split('[year]').join(String(new Date().getFullYear())).split('[username]').join('Tester Name');
    expect(readFileSync(join(repo, 'LICENSE.md'), 'utf8')).toBe(expectedLicense);
    expect(git(repo, ['status', '--porcelain']).trim()).toBe('');
  });

  it('[username] stays as the placeholder when git has no user.name', async () => {
    const { roots, parent } = setup();
    const res = await initRepo({ parent, name: 'noname', license: 'mit-license' }, { roots }); // empty global config, identity only in env
    expect(res.type).toBe('done');
    const lic = readFileSync(join(parent, 'noname', 'LICENSE.md'), 'utf8');
    expect(lic).toContain('[username]');
    expect(lic).not.toContain('[year]');
    expect(lic).toContain(String(new Date().getFullYear()));
  });

  it('no templates: only README.md is written and committed', async () => {
    const { roots, parent } = setup();
    expect((await initRepo({ parent, name: 'plain' }, { roots })).type).toBe('done');
    const repo = join(parent, 'plain');
    expect(git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']).trim()).toBe('README.md');
    expect(readdirSync(repo).sort()).toEqual(['.git', 'README.md']);
  });

  it('HEAD branch: "main" by default, or the one asked for', async () => {
    const { roots, parent } = setup();
    await initRepo({ parent, name: 'b-default' }, { roots });
    await initRepo({ parent, name: 'b-trunk', defaultBranch: 'trunk' }, { roots });
    expect(git(join(parent, 'b-default'), ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main');
    const trunk = join(parent, 'b-trunk');
    expect(git(trunk, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/trunk');
    expect(git(trunk, ['rev-parse', '--verify', 'refs/heads/trunk']).trim()).toMatch(/^[0-9a-f]{40,64}$/); // the commit is on that branch
  });

  it('an existing EMPTY directory is accepted', async () => {
    const { roots, parent } = setup();
    mkdirSync(join(parent, 'emptydir'));
    expect((await initRepo({ parent, name: 'emptydir' }, { roots })).type).toBe('done');
    expect(existsSync(join(parent, 'emptydir', '.git'))).toBe(true);
  });
});

describe('initRepo: refusals create nothing', () => {
  it.each([
    ['empty', ''],
    ['dot', '.'],
    ['dot-dot', '..'],
    ['slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['colon', 'a:b'],
    ['star', 'a*b'],
    ['question', 'a?b'],
    ['quote', 'a"b'],
    ['less-than', 'a<b'],
    ['greater-than', 'a>b'],
    ['pipe', 'a|b'],
    ['control char', 'a\x01b'],
    ['trailing dot', 'repo.'],
    ['trailing space', 'repo '],
    ['reserved CON', 'CON'],
    ['reserved nul (any case)', 'nul'],
    ['reserved COM1', 'COM1'],
    ['256 characters', 'x'.repeat(256)],
  ])('bad name: %s', async (_label, name) => {
    const { roots, parent } = setup();
    const res = await initRepo({ parent, name }, { roots });
    expect(res.type).toBe('refused');
    expect(readdirSync(parent)).toEqual([]);
  });

  it('255 characters and ordinary names are fine (so the refusals above mean something)', async () => {
    const { roots, parent } = setup();
    expect((await initRepo({ parent, name: 'my-repo.v2' }, { roots })).type).toBe('done');
    expect((await initRepo({ parent, name: 'x'.repeat(100) }, { roots })).type).toBe('done');
  });

  it.each(['bad..name', 'a b', '-x', 'we~ird', 'ends.lock', '@{x}'])('bad default branch %j', async (defaultBranch) => {
    const { roots, parent } = setup();
    const res = await initRepo({ parent, name: 'r', defaultBranch }, { roots });
    expect(res.type).toBe('refused');
    expect(readdirSync(parent)).toEqual([]);
  });

  it('unknown template ids (and path tricks) are refused', async () => {
    const { roots, parent } = setup();
    for (const [gitignore, license] of [['NoSuchTemplate', undefined], ['../license/index', undefined], ['Node/../../x', undefined], [undefined, 'nope'], [undefined, '../gitignore/Node'], [undefined, 'index']] as const) {
      const res = await initRepo({ parent, name: 'r', gitignore, license }, { roots });
      expect(res.type, `${gitignore}/${license}`).toBe('refused');
    }
    expect(readdirSync(parent)).toEqual([]);
  });

  it('a parent that is missing, a file, outside the roots, UNC or relative is refused', async () => {
    const { base, roots, parent } = setup();
    const file = join(base, 'afile.txt');
    writeFileSync(file, 'x');
    const outside = fresh('init-parent-outside');
    for (const bad of [join(base, 'missing'), file, outside, '\\\\server\\share\\x', 'relative/parent']) {
      expect((await initRepo({ parent: bad, name: 'r' }, { roots })).type, bad).toBe('refused');
    }
    expect(readdirSync(outside)).toEqual([]);
    expect((await initRepo({ parent, name: 'r' }, { roots })).type).toBe('done');
  });

  it('a parent that is a junction inside the roots to a folder outside them is refused (realpath)', async () => {
    const { base, roots } = setup();
    const outside = fresh('init-parent-junction-outside');
    const link = join(base, 'parentlink');
    symlinkSync(outside, link, 'junction');
    expect((await initRepo({ parent: link, name: 'r' }, { roots })).type).toBe('refused');
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('initRepo: the target folder (audit fix 1)', () => {
  it('init on an existing repo is refused; its HEAD, README and files are unchanged and no commit is added', async () => {
    const { roots, parent } = setup();
    const repo = join(parent, 'existing');
    mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'README.md'), 'mine\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'mine']);
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    const res = await initRepo({ parent, name: 'existing', gitignore: 'Node', license: 'mit-license' }, { roots });
    expect(res.type).toBe('refused');
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('mine\n');
    expect(existsSync(join(repo, 'LICENSE.md'))).toBe(false);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  it('a non-empty plain folder is refused and left untouched (wx never overwrites)', async () => {
    const { roots, parent } = setup();
    mkdirSync(join(parent, 'busy'));
    writeFileSync(join(parent, 'busy', 'README.md'), 'keep me\n');
    expect((await initRepo({ parent, name: 'busy' }, { roots })).type).toBe('refused');
    expect(readdirSync(join(parent, 'busy'))).toEqual(['README.md']);
    expect(readFileSync(join(parent, 'busy', 'README.md'), 'utf8')).toBe('keep me\n');
  });

  it('a junction/symlink to an EMPTY directory outside the roots is refused and that directory stays empty', async () => {
    const { roots, parent } = setup();
    const outside = fresh('init-junction-outside');
    symlinkSync(outside, join(parent, 'jl'), 'junction');
    expect(lstatSync(join(parent, 'jl')).isSymbolicLink()).toBe(true);
    const res = await initRepo({ parent, name: 'jl' }, { roots });
    expect(res.type).toBe('refused');
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('initRepo: the commit fails', () => {
  it('without an identity the repo and files stay and the error carries git stderr', async () => {
    const { roots, parent } = setup();
    const res = await withEnv(
      { GIT_CONFIG_GLOBAL: STRICT_GLOBAL, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined, EMAIL: undefined },
      () => initRepo({ parent, name: 'noident', gitignore: 'Node' }, { roots }),
    );
    expect(res.type).toBe('commit-failed');
    if (res.type !== 'commit-failed') return;
    expect(res.stderr.length).toBeGreaterThan(0);
    const repo = join(parent, 'noident');
    expect(norm(res.path)).toBe(norm(repo));
    expect(existsSync(join(repo, '.git'))).toBe(true);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# noident\n');
    expect(existsSync(join(repo, '.gitignore'))).toBe(true);
    expect(tryGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).status).not.toBe(0); // no commit was made
  });
});
