import type { FastifyInstance, FastifyReply } from 'fastify';
import { buildPatch, parseUnifiedDiff } from '@gitslappin/shared';
import { runExclusive } from '../git/queue';
import { runGit, type GitResult } from '../git/runner';
import { UnsafePathError, safeRepoPath } from '../git/safeRepoPath';
import { MAX_PATHS, applyCachedArgs, reDiffArgs, stageAllArgs, stagePathsArgs, unstagePathsArgs } from '../git/stageCommands';
import type { RepoRegistry } from '../state/registry';

const REDIFF_MAX_BYTES = 20 * 1024 * 1024;
const REDIFF_TIMEOUT_MS = 60_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first line of git's complaint, for the `error` field (the client shows the full `stderr`). */
const firstLine = (r: GitResult, fallback: string): string => (r.stderr.trim().split('\n')[0] ?? '') || fallback;

/** The part of a hunk header that only holds numbers; the function-context text after it can differ in encoding. */
const headerNumbers = (h: string): string => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(h)?.[0] ?? h;

export function registerStageRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  function fail(reply: FastifyReply, e: unknown) {
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message, ...(e.stderr !== undefined ? { stderr: e.stderr } : {}) });
    if (e instanceof UnsafePathError) return reply.code(400).send({ error: e.message });
    return reply.code(500).send({ error: e instanceof Error ? e.message : 'Request failed.' });
  }

  /** Validates a `paths` list: 1..MAX_PATHS strings, each a safe repo path. Never returns an empty list. */
  function readPaths(root: string, v: unknown): string[] {
    if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, 'No paths given.');
    if (v.length > MAX_PATHS) throw new HttpError(400, 'Too many paths.');
    for (const p of v) {
      if (typeof p !== 'string') throw new HttpError(400, 'Invalid path.');
      safeRepoPath(root, p);
    }
    return v as string[];
  }

  async function isUnborn(root: string, repoId: string): Promise<boolean> {
    const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, repoId });
    return head.code !== 0;
  }

  const nul = (paths: string[]): Buffer => Buffer.from(paths.join('\0'), 'utf8');

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/stage', { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      const body = req.body;
      if (!isObject(body)) throw new HttpError(400, 'Invalid request.');
      const all = body.all === true;
      if (body.all !== undefined && !all) throw new HttpError(400, 'Invalid request.');
      if (all && body.paths !== undefined) throw new HttpError(400, 'Invalid request.');
      const paths = all ? [] : readPaths(root, body.paths);
      const res = await runExclusive(repoId, () => runGit(all ? stageAllArgs() : stagePathsArgs(), { cwd: root, repoId, ...(all ? {} : { input: nul(paths) }) }));
      if (res.code !== 0) throw new HttpError(500, firstLine(res, 'git add failed.'), res.stderr);
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/unstage', { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      const body = req.body;
      if (!isObject(body)) throw new HttpError(400, 'Invalid request.');
      const paths = readPaths(root, body.paths);
      const res = await runExclusive(repoId, async () => runGit(unstagePathsArgs(await isUnborn(root, repoId)), { cwd: root, repoId, input: nul(paths) }));
      if (res.code !== 0) throw new HttpError(500, firstLine(res, 'git restore failed.'), res.stderr);
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });

  type LineSource = 'unstaged' | 'staged';

  /** The path must be an exact, unmerged-free entry of the index (a folder name would list the files inside it). */
  async function assertTrackedClean(root: string, repoId: string, path: string): Promise<void> {
    const res = await runGit(['--literal-pathspecs', 'ls-files', '-z', '--stage', '--error-unmatch', '--', path], { cwd: root, repoId });
    if (res.code !== 0) throw new HttpError(400, 'Not a tracked file.');
    let found = false;
    for (const entry of res.stdout.split('\0')) {
      const m = /^\d+ [0-9a-f]+ (\d)\t([\s\S]*)$/.exec(entry);
      if (!m || m[2] !== path) continue;
      if (m[1] !== '0') throw new HttpError(409, 'Merge conflicts detected');
      found = true;
    }
    if (!found) throw new HttpError(400, 'Not a tracked file.');
  }

  async function assertUntracked(root: string, repoId: string, path: string): Promise<void> {
    const res = await runGit(['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--end-of-options', '--', path], { cwd: root, repoId });
    if (res.code !== 0 || !res.stdout.split('\0').includes(path)) throw new HttpError(400, 'Not an untracked file.');
  }

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/stage-lines', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      const body = req.body;
      if (!isObject(body)) throw new HttpError(400, 'Invalid request.');
      const { source, path, oldPath, hunk, header, lines } = body;
      if (source !== 'unstaged' && source !== 'staged') throw new HttpError(400, 'Invalid source.');
      if (typeof path !== 'string') throw new HttpError(400, 'Missing path.');
      safeRepoPath(root, path);
      if (oldPath !== undefined) {
        if (typeof oldPath !== 'string') throw new HttpError(400, 'Invalid path.');
        safeRepoPath(root, oldPath);
      }
      const untracked = body.untracked === true;
      if (body.untracked !== undefined && typeof body.untracked !== 'boolean') throw new HttpError(400, 'Invalid request.');
      if (untracked && source !== 'unstaged') throw new HttpError(400, 'Invalid request.');
      if (typeof header !== 'string') throw new HttpError(400, 'Invalid request.');
      if (typeof hunk !== 'number' || !Number.isInteger(hunk) || hunk < 0) throw new HttpError(409, 'The hunk is out of date.');
      if (lines !== undefined && (!Array.isArray(lines) || lines.length === 0 || lines.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 0))) {
        throw new HttpError(409, 'The selected lines are out of date.');
      }

      const reverse = (source as LineSource) === 'staged';
      await runExclusive(repoId, async () => {
        if (source === 'unstaged') {
          if (untracked) await assertUntracked(root, repoId, path);
          else await assertTrackedClean(root, repoId, path);
        }
        const diffSource = untracked ? 'untracked' : (source as LineSource);
        const paths = diffSource === 'staged' && typeof oldPath === 'string' && oldPath !== path ? [oldPath, path] : [path];
        const diff = await runGit(reDiffArgs(diffSource, paths), { cwd: root, repoId, encoding: 'latin1', maxBuffer: REDIFF_MAX_BYTES, timeoutMs: REDIFF_TIMEOUT_MS });
        if (!(diff.code === 0 || (untracked && diff.code === 1))) throw new HttpError(500, firstLine(diff, 'git diff failed.'), diff.stderr);

        const matches = parseUnifiedDiff(diff.stdout).filter((f) => f.path === path);
        if (matches.length === 0) throw new HttpError(409, 'The file has changed.');
        // A file that changed type (for example file to symlink) shows as two blocks for one path.
        if (matches.length > 1) throw new HttpError(409, 'The type of this file changed. Stage the whole file instead.');
        const file = matches[0]!;
        if (file.binary) throw new HttpError(409, 'Binary file');
        const target = file.hunks[hunk];
        if (!target) throw new HttpError(409, 'The hunk is out of date.');
        if (headerNumbers(target.header) !== headerNumbers(header)) throw new HttpError(409, 'The hunk is out of date.');

        let selected: Set<number> | undefined;
        if (lines !== undefined) {
          selected = new Set<number>();
          for (const n of lines as number[]) {
            const l = target.lines[n];
            if (!l || l.kind === 'context') throw new HttpError(409, 'The selected lines are out of date.');
            selected.add(n);
          }
        }

        // Header path bytes are ASCII (non-ASCII is octal-escaped); the hunk text is latin1, so every byte round-trips.
        const patch = Buffer.from(buildPatch({ ...file, path }, hunk, selected, reverse), 'latin1');
        const check = await runGit(applyCachedArgs(reverse, true), { cwd: root, repoId, input: patch });
        if (check.code !== 0) throw new HttpError(409, firstLine(check, 'The change no longer applies.'), check.stderr);
        const done = await runGit(applyCachedArgs(reverse, false), { cwd: root, repoId, input: patch });
        if (done.code !== 0) throw new HttpError(500, firstLine(done, 'git apply failed.'), done.stderr);
      });
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });
}
