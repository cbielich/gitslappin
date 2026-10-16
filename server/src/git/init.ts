import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { branchNameProblem, type InitRequest, type TemplateList } from '@gitslappin/shared';
import type { PathPair } from '../pathMap';
import { runGit } from './runner';
import { scrubSecrets } from './scrub';
import { folderNameProblem, resolveParent, targetPath, targetProblem } from './target';

/** The bundled GitKraken templates (server/templates). Their text is never edited or written by hand. */
const DEFAULT_TEMPLATES = fileURLToPath(new URL('../../templates', import.meta.url));

export interface InitOptions {
  roots: string[];
  pathMap?: PathPair[];
  templatesDir?: string;
}

export type InitResult =
  | { type: 'done'; path: string }
  | { type: 'refused'; error: string }
  | { type: 'commit-failed'; path: string; error: string; stderr: string };

export function listTemplates(templatesDir: string = DEFAULT_TEMPLATES): TemplateList {
  const gitignore = readdirSync(join(templatesDir, 'gitignore'))
    .filter((f) => f.endsWith('.gitignore'))
    .map((f) => f.slice(0, -'.gitignore'.length))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const index = JSON.parse(readFileSync(join(templatesDir, 'license', 'index.json'), 'utf8')) as { id: string; title: string }[];
  const license = index.filter((i) => existsSync(join(templatesDir, 'license', `${i.id}.txt`))).map((i) => ({ id: i.id, title: i.title }));
  return { gitignore, license };
}

/** git init, then README.md (+ .gitignore, LICENSE.md) and one "Initial commit". Nothing is deleted or overwritten ('wx'). */
export async function initRepo(req: InitRequest, opts: InitOptions): Promise<InitResult> {
  const refused = (error: string): InitResult => ({ type: 'refused', error });
  const dir = opts.templatesDir ?? DEFAULT_TEMPLATES;
  const nameProblem = folderNameProblem(req?.name);
  if (nameProblem) return refused(nameProblem);
  const branch = req.defaultBranch === undefined || req.defaultBranch === '' ? 'main' : req.defaultBranch;
  if (typeof branch !== 'string' || branch.includes('+') || branchNameProblem(branch) !== null) return refused('Invalid branch name.');
  const templates = listTemplates(dir);
  if (req.gitignore !== undefined && req.gitignore !== '' && !(typeof req.gitignore === 'string' && templates.gitignore.includes(req.gitignore))) return refused('Unknown .gitignore template.');
  if (req.license !== undefined && req.license !== '' && !(typeof req.license === 'string' && templates.license.some((l) => l.id === req.license))) return refused('Unknown license.');
  const parent = resolveParent(req.parent, opts.roots, opts.pathMap ?? []);
  if (!parent.ok) return refused(parent.error);
  const full = targetPath(parent.dir, req.name);
  const tp = targetProblem(full, opts.roots, parent.dir);
  if (tp) return refused(tp);
  const ref = await runGit(['check-ref-format', '--branch', branch], { cwd: parent.dir });
  if (ref.code !== 0 || ref.stdout.trim() !== branch) return refused('Invalid branch name.');

  const failed = (error: string, stderr: string): InitResult => ({ type: 'commit-failed', path: full, error, stderr: scrubSecrets(stderr) });
  const init = await runGit(['init', '--', full], { cwd: parent.dir });
  if (init.code !== 0) return refused(scrubSecrets(init.stderr.trim()) || 'git init failed.');
  const head = await runGit(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: full });
  if (head.code !== 0) return failed('The repository was created, but its default branch could not be set.', head.stderr);

  const files: string[] = [];
  try {
    writeFileSync(join(full, 'README.md'), `# ${req.name}\n`, { flag: 'wx' });
    files.push('README.md');
    if (req.gitignore) {
      writeFileSync(join(full, '.gitignore'), readFileSync(join(dir, 'gitignore', `${req.gitignore}.gitignore`)), { flag: 'wx' });
      files.push('.gitignore');
    }
    if (req.license) {
      const user = await runGit(['config', 'user.name'], { cwd: full });
      const username = user.code === 0 ? user.stdout.trim() : '';
      let text = readFileSync(join(dir, 'license', `${req.license}.txt`), 'utf8').split('[year]').join(String(new Date().getFullYear()));
      if (username !== '') text = text.split('[username]').join(username);
      writeFileSync(join(full, 'LICENSE.md'), text, { flag: 'wx' });
      files.push('LICENSE.md');
    }
  } catch (e) {
    return failed('The repository was created, but its files could not be written.', e instanceof Error ? e.message : String(e));
  }
  const add = await runGit(['add', '--', ...files], { cwd: full });
  if (add.code !== 0) return failed('The repository was created, but its files could not be staged.', add.stderr);
  const commit = await runGit(['commit', '-m', 'Initial commit'], { cwd: full, timeoutMs: 120_000 });
  if (commit.code !== 0) {
    const text = scrubSecrets(`${commit.stderr}${commit.stdout}`.trim());
    return failed(text.split('\n').find((l) => l.trim() !== '') ?? 'The initial commit failed.', text || `git exited with code ${commit.code}.`);
  }
  return { type: 'done', path: full };
}
