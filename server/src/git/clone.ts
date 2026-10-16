import { fileURLToPath, pathToFileURL } from 'node:url';
import { branchNameProblem, cloneUrlProblem, repoNameFromUrl, type CloneRequest } from '@gitslappin/shared';
import { mapOpenPath, type PathPair } from '../pathMap';
import { isUnderRoots } from '../repoRoots';
import { isUncOrDevicePath } from '../security';
import { runExclusive } from './queue';
import { SAFE_ARGS } from './remote';
import { runGit, runGitProgress } from './runner';
import { scrubSecrets } from './scrub';
import { folderNameProblem, resolveParent, targetPath, targetProblem } from './target';

export type CloneArgsInput = Pick<CloneRequest, 'shallow' | 'sparse'> & { url: string; target: string };

/** git's own progress phase names; anything else is reported as GENERIC_PHASE so odd text never reaches the stream. */
export const PROGRESS_PHASES: readonly string[] = [
  'Enumerating objects',
  'Counting objects',
  'Compressing objects',
  'Receiving objects',
  'Resolving deltas',
  'Updating files',
  'Checking out files',
  'Filtering content',
  'Checking connectivity',
];
export const GENERIC_PHASE = 'Working';

/** "Receiving objects:  45% (9/20), ..." -> {phase, percent}; null when the line is not a percent line. */
export function parseProgress(line: string): { phase: string; percent: number } | null {
  const m = /^(?:remote:\s*)?(.*?):\s+(\d{1,3})%/.exec(line.trim().slice(0, 2000));
  if (!m) return null;
  const text = m[1]!.trim();
  return { phase: PROGRESS_PHASES.includes(text) ? text : GENERIC_PHASE, percent: Math.min(100, Number(m[2])) };
}

const ALLOWED_FLAGS = ['--no-tags', '--single-branch', '--no-single-branch', '--filter=blob:none', '--filter=tree:0'];
const MAX_SPARSE_PATHS = 200;

function parseFlags(flags: string | undefined): { flags: string[] } | { error: string } {
  const text = (flags ?? '').trim();
  if (text === '') return { flags: [] };
  const list = `Allowed flags: ${ALLOWED_FLAGS.join(', ')}.`;
  if (/["'`]/.test(text)) return { error: `Quotes are not allowed in custom flags. ${list}` };
  const out: string[] = [];
  for (const f of text.split(/\s+/)) {
    if (!ALLOWED_FLAGS.includes(f)) return { error: `The flag "${f.slice(0, 60)}" is not allowed. ${list}` };
    out.push(f);
  }
  return { flags: out };
}

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

function sparsePathProblem(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return 'A sparse checkout path is empty.';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return 'A sparse checkout path contains a control character.';
  if (p.startsWith('-') || p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return `Sparse checkout paths must be relative and must not start with "-" or "/": ${p.slice(0, 60)}`;
  if (p.split(/[/\\]/).includes('..')) return `Sparse checkout paths must not contain "..": ${p.slice(0, 60)}`;
  return null;
}

/** Pure: validates everything and builds the argv. Nothing is spawned. The sparse paths are never part of it (they go to stdin). */
export function buildCloneArgs(input: CloneArgsInput): { ok: true; args: string[] } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  const urlProblem = cloneUrlProblem(input.url);
  if (urlProblem) return bad(urlProblem);
  const args: string[] = [...SAFE_ARGS, 'clone', '--progress'];
  let custom: string[] = [];
  const s = input.shallow;
  if (s) {
    if (s.by === 'depth') {
      if (typeof s.depth !== 'number' || !Number.isInteger(s.depth) || s.depth < 1 || s.depth > 1_000_000) return bad('Depth must be a whole number from 1 to 1000000.');
      args.push('--depth', String(s.depth));
    } else if (s.by === 'since') {
      if (typeof s.since !== 'string' || !validDate(s.since)) return bad("Enter a valid date in 'YYYY-MM-DD' format");
      if (s.since > new Date().toISOString().slice(0, 10)) return bad('Date cannot be in the future');
      args.push(`--shallow-since=${s.since}`);
    } else {
      return bad('Limit history by depth or by date.');
    }
    if (s.branch !== undefined && s.branch !== '') {
      if (typeof s.branch !== 'string' || s.branch.includes('+') || branchNameProblem(s.branch) !== null) return bad('Invalid branch name.');
      args.push('--branch', s.branch);
    }
    const f = parseFlags(s.flags);
    if ('error' in f) return bad(f.error);
    custom = f.flags;
  }
  const sp = input.sparse;
  if (sp) {
    if (!Array.isArray(sp.paths) || sp.paths.length > MAX_SPARSE_PATHS) return bad(`At most ${MAX_SPARSE_PATHS} sparse checkout paths are allowed.`);
    for (const p of sp.paths) {
      const problem = sparsePathProblem(p);
      if (problem) return bad(problem);
    }
    args.push('--sparse');
    if (sp.blobless) args.push('--filter=blob:none');
  }
  args.push(...custom, '--', input.url, input.target);
  return { ok: true, args };
}

export interface CloneOptions {
  roots: string[];
  pathMap?: PathPair[];
  signal?: AbortSignal;
  onProgress?: (p: { phase: string; percent: number }) => void;
}

export type CloneResult =
  | { type: 'done'; path: string }
  | { type: 'error'; error: string; stderr: string }
  | { type: 'cancelled'; path: string }
  | { type: 'refused'; error: string };

const CAP_MS = 60 * 60 * 1000;
const STDERR_CAP = 64 * 1024;

/** Roots mode: a file:// origin is mapped, must not be UNC, and its real path must be under the roots. Returns the URL git should use. */
function checkFileUrl(url: string, roots: string[], pathMap: PathPair[]): { url: string } | { error: string } {
  if (roots.length === 0 || !/^file:/i.test(url)) return { url };
  let local: string;
  try {
    local = fileURLToPath(url);
  } catch {
    return { error: 'That file:// URL is not a local path.' };
  }
  const mapped = mapOpenPath(local, pathMap);
  const path = 'error' in mapped ? local : mapped.path; // an unmapped drive path simply fails the roots check below
  if (isUncOrDevicePath(path)) return { error: 'UNC and device paths are not supported.' };
  if (!isUnderRoots(path, roots)) return { error: 'That repository is outside the folders GitSlappin may open.' };
  return { url: pathMap.length > 0 && path !== local ? pathToFileURL(path).href : url };
}

/** Validates, then runs `git clone` with progress. Never deletes anything: a cancelled clone leaves its partial folder. */
export async function cloneRepo(req: CloneRequest, opts: CloneOptions): Promise<CloneResult> {
  const pathMap = opts.pathMap ?? [];
  const refused = (error: string): CloneResult => ({ type: 'refused', error });
  const urlProblem = typeof req?.url === 'string' ? cloneUrlProblem(req.url) : 'Enter the URL of the repository to clone.';
  if (urlProblem) return refused(urlProblem);
  const url = req.url.trim();
  const name = repoNameFromUrl(url);
  const nameProblem = folderNameProblem(name);
  if (nameProblem) return refused(`The folder name taken from the URL is not usable. ${nameProblem}`);
  const parent = resolveParent(req.parent, opts.roots, pathMap);
  if (!parent.ok) return refused(parent.error);
  const target = targetPath(parent.dir, name);
  const tp = targetProblem(target, opts.roots, parent.dir);
  if (tp) return refused(tp);
  const fileUrl = checkFileUrl(url, opts.roots, pathMap);
  if ('error' in fileUrl) return refused(fileUrl.error);
  const built = buildCloneArgs({ url: fileUrl.url, target, ...(req.shallow ? { shallow: req.shallow } : {}), ...(req.sparse ? { sparse: req.sparse } : {}) });
  if (!built.ok) return refused(built.error);
  const branch = req.shallow?.branch;
  if (branch) {
    const ref = await runGit(['check-ref-format', '--branch', branch], { cwd: parent.dir });
    if (ref.code !== 0 || ref.stdout.trim() !== branch) return refused('Invalid branch name.');
  }

  return runExclusive(`clone:${target}`, async (): Promise<CloneResult> => {
    let stderr = '';
    const run = await runGitProgress(built.args, {
      cwd: parent.dir,
      timeoutMs: CAP_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
      onLine: (line) => {
        const p = parseProgress(line);
        if (p) opts.onProgress?.(p);
        else if (stderr.length < STDERR_CAP) stderr += `${line}\n`;
      },
    });
    if (run.aborted && run.code !== 0) return { type: 'cancelled', path: target };
    if (run.timedOut) return { type: 'error', error: 'The clone took longer than 60 minutes and was stopped.', stderr: scrubSecrets(stderr) };
    if (run.code !== 0) {
      const clean = scrubSecrets(stderr.trim());
      const lines = clean.split('\n');
      const first = lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.find((l) => l.trim() !== '') ?? `git exited with code ${run.code}.`;
      return { type: 'error', error: first, stderr: clean || `git exited with code ${run.code}.` };
    }
    const paths = req.sparse?.paths ?? [];
    if (paths.length > 0) {
      const set = await runGit(['sparse-checkout', 'set', '--cone', '--stdin'], { cwd: target, input: `${paths.join('\n')}\n` });
      if (set.code !== 0) {
        const clean = scrubSecrets(`${set.stderr}${set.stdout}`.trim());
        return { type: 'error', error: 'The repository was cloned, but setting the sparse checkout paths failed.', stderr: clean };
      }
    }
    return { type: 'done', path: target };
  }).catch((e: unknown) => ({ type: 'error' as const, error: scrubSecrets(e instanceof Error ? e.message : String(e)), stderr: '' }));
}
