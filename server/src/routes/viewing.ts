import type { FastifyInstance, FastifyReply } from 'fastify';
import type { BlameResult, CompareResult, FileHistoryEntry, FileHistoryPage } from '@gitslappin/shared';
import { parseBlamePorcelain } from '../git/parsers/blame';
import { SHA_RE, parseNameStatusZ } from '../git/parsers/commit';
import { parseFileHistory } from '../git/parsers/fileHistory';
import { runGit } from '../git/runner';
import { UnsafePathError, safeRepoPath } from '../git/safeRepoPath';
import type { RepoRegistry } from '../state/registry';

const MAX_FILES = 5000;
const TIMEOUT_MS = 120_000;
const BLAME_MAX_BYTES = 5 * 1024 * 1024;
const BLAME_MAX_BUFFER = 64 * 1024 * 1024;
const FULL_SHA = /^[0-9a-f]{40,64}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_SKIP = 100_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A strict non-negative integer from a query value, or the fallback when absent. */
function intParam(v: unknown, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !/^\d{1,9}$/.test(v)) throw new HttpError(400, 'Invalid request.');
  const n = Number(v);
  if (n < min || n > max) throw new HttpError(400, 'Invalid request.');
  return n;
}

export function registerViewingRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  // One request in flight per repo and route kind: a newer one aborts the older (409).
  const inflight = new Map<string, AbortController>();
  function begin(kind: string, repoId: string): { ctl: AbortController; done: () => void } {
    const key = `${kind}:${repoId}`;
    inflight.get(key)?.abort();
    const ctl = new AbortController();
    inflight.set(key, ctl);
    return {
      ctl,
      done: () => {
        if (inflight.get(key) === ctl) inflight.delete(key);
      },
    };
  }

  function fail(reply: FastifyReply, e: unknown, ctl: AbortController, fallback: string) {
    if (ctl.signal.aborted) return reply.code(409).send({ error: 'Superseded by a newer request.' });
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof UnsafePathError) return reply.code(400).send({ error: e.message });
    return reply.code(500).send({ error: e instanceof Error ? e.message : fallback });
  }

  async function resolveCommit(root: string, repoId: string, sha: string, ctl: AbortController): Promise<string> {
    const res = await runGit(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`], { cwd: root, repoId, signal: ctl.signal });
    const full = res.stdout.trim();
    if (res.code !== 0 || !FULL_SHA.test(full)) throw new HttpError(404, 'Commit not found.');
    return full;
  }

  async function emptyTree(root: string, repoId: string, ctl: AbortController): Promise<string> {
    const res = await runGit(['hash-object', '-t', 'tree', '--stdin'], { cwd: root, repoId, signal: ctl.signal, input: '' });
    const id = res.stdout.trim();
    if (res.code !== 0 || !FULL_SHA.test(id)) throw new HttpError(500, 'Could not read the repository.');
    return id;
  }

  /** The path must be a file in that commit (else 404). */
  async function assertBlobAt(root: string, repoId: string, sha: string, path: string, ctl: AbortController): Promise<void> {
    const res = await runGit(['cat-file', '-t', `${sha}:${path}`], { cwd: root, repoId, signal: ctl.signal });
    if (res.code !== 0 || res.stdout.trim() !== 'blob') throw new HttpError(404, 'File not found in that commit.');
  }

  // ---- compare ---------------------------------------------------------------------------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; workdir?: string } }>('/api/repos/:id/compare', async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const { ctl, done } = begin('compare', repoId);
    try {
      const from = str(req.query.from);
      const to = str(req.query.to);
      const workdir = req.query.workdir === '1';
      if (!from || (from !== 'empty' && !SHA_RE.test(from))) throw new HttpError(400, 'Invalid commit id.');
      if (!workdir && (!to || !SHA_RE.test(to))) throw new HttpError(400, 'Invalid commit id.');
      const a = from === 'empty' ? await emptyTree(root, repoId, ctl) : await resolveCommit(root, repoId, from, ctl);
      const common = ['-z', '--name-status', '-M', '--no-ext-diff'];
      let args: string[];
      if (workdir) args = ['diff', ...common, '--no-textconv', '--end-of-options', a, '--'];
      else args = ['diff-tree', '-r', ...common, '--end-of-options', a, await resolveCommit(root, repoId, to as string, ctl)];
      const res = await runGit(args, { cwd: root, repoId, signal: ctl.signal, timeoutMs: TIMEOUT_MS });
      if (ctl.signal.aborted) throw new HttpError(409, 'Superseded by a newer request.');
      if (res.code !== 0) throw new HttpError(500, res.stderr.trim() || 'git diff failed.');
      const all = parseNameStatusZ(res.stdout);
      return { files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES } satisfies CompareResult;
    } catch (e) {
      return fail(reply, e, ctl, 'Compare failed.');
    } finally {
      done();
    }
  });

  // ---- file history ----------------------------------------------------------------------------------------------------------------
  // One slot per repo: the whole `log --follow` list for (sha, path); skip/limit are served from memory.
  const historyCache = new Map<string, { key: string; entries: FileHistoryEntry[] }>();

  app.get<{ Params: { id: string }; Querystring: { sha?: string; path?: string; skip?: string; limit?: string } }>('/api/repos/:id/file-history', async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const { ctl, done } = begin('file-history', repoId);
    try {
      const sha = str(req.query.sha);
      if (!sha || !SHA_RE.test(sha)) throw new HttpError(400, 'Invalid commit id.');
      const path = str(req.query.path);
      if (path === undefined) throw new HttpError(400, 'Missing path.');
      safeRepoPath(root, path);
      const skip = intParam(req.query.skip, 0, MAX_SKIP, 0);
      const limit = intParam(req.query.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
      const full = await resolveCommit(root, repoId, sha, ctl);
      await assertBlobAt(root, repoId, full, path, ctl);
      const key = `${full}\0${path}`;
      const slot = historyCache.get(repoId);
      let entries = slot && slot.key === key ? slot.entries : null;
      if (!entries) {
        const res = await runGit(
          ['--literal-pathspecs', 'log', '--follow', '-M', '--name-status', '-z', '--format=%x1e%H%x00%an%x00%ae%x00%aI%x00%s', '--end-of-options', full, '--', path],
          { cwd: root, repoId, signal: ctl.signal, timeoutMs: TIMEOUT_MS },
        );
        if (ctl.signal.aborted) throw new HttpError(409, 'Superseded by a newer request.');
        if (res.code !== 0) throw new HttpError(500, res.stderr.trim() || 'git log failed.');
        entries = parseFileHistory(res.stdout);
        historyCache.set(repoId, { key, entries });
      }
      const page = entries.slice(skip, skip + limit);
      const nextSkip = skip + page.length;
      return { entries: page, nextSkip, hasMore: nextSkip < entries.length } satisfies FileHistoryPage;
    } catch (e) {
      return fail(reply, e, ctl, 'File history failed.');
    } finally {
      done();
    }
  });

  // ---- blame -----------------------------------------------------------------------------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { sha?: string; path?: string } }>('/api/repos/:id/blame', async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const { ctl, done } = begin('blame', repoId);
    try {
      const sha = str(req.query.sha);
      if (!sha || !SHA_RE.test(sha)) throw new HttpError(400, 'Invalid commit id.');
      const path = str(req.query.path);
      if (path === undefined) throw new HttpError(400, 'Missing path.');
      safeRepoPath(root, path);
      const full = await resolveCommit(root, repoId, sha, ctl);
      await assertBlobAt(root, repoId, full, path, ctl);
      const size = await runGit(['cat-file', '-s', `${full}:${path}`], { cwd: root, repoId, signal: ctl.signal });
      if (size.code !== 0) throw new HttpError(404, 'File not found in that commit.');
      if (Number(size.stdout.trim()) > BLAME_MAX_BYTES) throw new HttpError(413, 'The file is too large to blame.');
      // No --end-of-options here: git 2.56 blame rejects it before a -- ("bad revision"). The sha is a resolved full hex id, so it can never be an option.
      const res = await runGit(['blame', '--porcelain', '--no-textconv', full, '--', path], {
        cwd: root,
        repoId,
        signal: ctl.signal,
        timeoutMs: TIMEOUT_MS,
        maxBuffer: BLAME_MAX_BUFFER,
      });
      if (ctl.signal.aborted) throw new HttpError(409, 'Superseded by a newer request.');
      if (res.code === -1) throw new HttpError(413, 'The blame output is too large.');
      if (res.code !== 0) throw new HttpError(500, res.stderr.trim() || 'git blame failed.');
      return parseBlamePorcelain(res.stdout) satisfies BlameResult;
    } catch (e) {
      return fail(reply, e, ctl, 'Blame failed.');
    } finally {
      done();
    }
  });
}
