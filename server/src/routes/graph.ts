import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CommitDetail, LocateResult, LogPage, RefsInfo, SearchResult, StashInfo, TreeListing } from '@gitslappin/shared';
import { getHistory } from '../git/history';
import { readOpState } from '../git/opState';
import { OWN_REF_EXCLUDES } from '../git/ownRefs';
import { runGit } from '../git/runner';
import { COMMIT_FORMAT, SHA_RE, parseCommitMeta, parseNameStatusZ } from '../git/parsers/commit';
import { REFS_FORMAT, STASH_FORMAT, parseForEachRef, parseStashList } from '../git/parsers/refs';
import { parseStatusV2 } from '../git/parsers/status';
import type { RepoRegistry } from '../state/registry';
import type { VisibilityStore } from '../visibility';

const DEFAULT_LIMIT = 500;
/** One request may load up to this many commits (a jump to a far commit loads everything up to it). */
const MAX_LIMIT = 50_000;
const MAX_FILES = 5000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SEARCH_RESULTS = 5000;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function fetchStashes(root: string, repoId: string): Promise<StashInfo[]> {
  const res = await runGit(['stash', 'list', `--format=${STASH_FORMAT}`], { cwd: root, repoId });
  return res.code === 0 ? parseStashList(res.stdout) : [];
}

export function registerGraphRoutes(app: FastifyInstance, registry: RepoRegistry, visibility: VisibilityStore): void {
  function rootOrFail(id: string, reply: FastifyReply): string | null {
    const root = registry.rootOf(id);
    if (!root) {
      void reply.code(404).send({ error: 'Unknown repository.' });
      return null;
    }
    return root;
  }

  app.get<{ Params: { id: string }; Querystring: { skip?: string; limit?: string } }>('/api/repos/:id/log', async (req, reply) => {
    const root = rootOrFail(req.params.id, reply);
    if (!root) return reply;
    const skip = clampInt(req.query.skip, 0, 100_000_000, 0);
    const limit = clampInt(req.query.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
    let history;
    try {
      history = await getHistory(root, req.params.id, visibility.get(req.params.id));
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'git log failed.' });
    }
    const commits = history.commits.slice(skip, skip + limit);
    const nextSkip = skip + commits.length;
    return { commits, nextSkip, hasMore: nextSkip < history.commits.length, total: history.commits.length } satisfies LogPage;
  });

  app.get<{ Params: { id: string; sha: string } }>('/api/repos/:id/locate/:sha', async (req, reply) => {
    const root = rootOrFail(req.params.id, reply);
    if (!root) return reply;
    const { sha } = req.params;
    if (!SHA_RE.test(sha)) return reply.code(400).send({ error: 'Invalid commit id.' });
    try {
      const history = await getHistory(root, req.params.id, visibility.get(req.params.id));
      return { index: history.indexBySha.get(sha.toLowerCase()) ?? -1 } satisfies LocateResult;
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'git log failed.' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/repos/:id/refs', async (req, reply) => {
    const root = rootOrFail(req.params.id, reply);
    if (!root) return reply;
    const repoId = req.params.id;
    const [fer, stashes, sym, head, remoteList] = await Promise.all([
      runGit(['for-each-ref', `--format=${REFS_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'], { cwd: root, repoId }),
      fetchStashes(root, repoId),
      runGit(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, repoId }),
      runGit(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root, repoId }),
      runGit(['remote'], { cwd: root, repoId }),
    ]);
    if (fer.code !== 0) return reply.code(500).send({ error: fer.stderr.trim() || 'git for-each-ref failed.' });
    const remoteNames = remoteList.code === 0 ? remoteList.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    const parsed = parseForEachRef(fer.stdout, remoteNames);
    const branch = sym.code === 0 ? sym.stdout.trim() : null;
    const headSha = head.code === 0 ? head.stdout.trim() : null;
    return {
      branch,
      detached: branch === null && headSha !== null,
      headSha,
      ...parsed,
      stashes,
    } satisfies RefsInfo;
  });


  /** Resolves user input to a full commit sha, or null. `--end-of-options` keeps it from being read as a flag. */
  async function resolveCommit(root: string, repoId: string, sha: string): Promise<string | null> {
    if (!SHA_RE.test(sha)) return null;
    const res = await runGit(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`], { cwd: root, repoId });
    const full = res.stdout.trim();
    return res.code === 0 && /^[0-9a-f]{40,64}$/.test(full) ? full : null;
  }

  app.get<{ Params: { id: string; sha: string } }>('/api/repos/:id/commit/:sha', async (req, reply) => {
    const root = rootOrFail(req.params.id, reply);
    if (!root) return reply;
    const repoId = req.params.id;
    if (!SHA_RE.test(req.params.sha)) return reply.code(400).send({ error: 'Invalid commit id.' });
    const sha = await resolveCommit(root, repoId, req.params.sha);
    if (!sha) return reply.code(404).send({ error: 'Commit not found.' });

    const meta = await runGit(['log', '-1', `--format=${COMMIT_FORMAT}`, '--end-of-options', sha], { cwd: root, repoId });
    const parsed = meta.code === 0 ? parseCommitMeta(meta.stdout) : null;
    if (!parsed) return reply.code(404).send({ error: 'Commit not found.' });

    // Merge commits are shown against the first parent.
    const first = parsed.parents[0];
    const diffArgs = first
      ? ['diff-tree', '-r', '-z', '--name-status', '-M', '--no-commit-id', first, parsed.sha]
      : ['diff-tree', '-r', '-z', '--name-status', '--no-commit-id', '--root', parsed.sha];
    const diff = await runGit(diffArgs, { cwd: root, repoId });
    if (diff.code !== 0) return reply.code(500).send({ error: diff.stderr.trim() || 'git diff-tree failed.' });

    const allFiles = parseNameStatusZ(diff.stdout);
    let message = parsed.message;
    let truncated = allFiles.length > MAX_FILES;
    if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
      message = Buffer.from(message).subarray(0, MAX_MESSAGE_BYTES).toString('utf8').replace(/�$/, '');
      truncated = true;
    }
    return { ...parsed, message, files: allFiles.slice(0, MAX_FILES), ...(truncated ? { truncated: true } : {}) } satisfies CommitDetail;
  });

  app.get<{ Params: { id: string; sha: string } }>('/api/repos/:id/commit/:sha/tree', async (req, reply) => {
    const root = rootOrFail(req.params.id, reply);
    if (!root) return reply;
    const repoId = req.params.id;
    if (!SHA_RE.test(req.params.sha)) return reply.code(400).send({ error: 'Invalid commit id.' });
    const sha = await resolveCommit(root, repoId, req.params.sha);
    if (!sha) return reply.code(404).send({ error: 'Commit not found.' });
    const res = await runGit(['ls-tree', '-r', '--name-only', '-z', '--end-of-options', sha], { cwd: root, repoId });
    if (res.code !== 0) return reply.code(500).send({ error: res.stderr.trim() || 'git ls-tree failed.' });
    const all = res.stdout.split('\0').filter(Boolean);
    return { files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES } satisfies TreeListing;
  });

  // One in-flight search per repo: a newer search aborts the older one.
  const searches = new Map<string, AbortController>();

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/repos/:id/search', async (req, reply) => {
    const root = rootOrFail(req.params.id, reply);
    if (!root) return reply;
    const repoId = req.params.id;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    // eslint-disable-next-line no-control-regex
    if (q.length > 200 || /[\u0000-\u001f]/.test(q)) return reply.code(400).send({ error: 'Invalid search text.' });
    const none = { shas: [], indexes: [] } satisfies SearchResult;
    if (!q) return none;

    searches.get(repoId)?.abort();
    const ctl = new AbortController();
    searches.set(repoId, ctl);
    const superseded = () => reply.code(409).send({ error: 'Superseded by a newer search.' });
    try {
      const history = await getHistory(root, repoId, visibility.get(repoId));
      if (ctl.signal.aborted) return superseded();
      const base = ['log', '--fixed-strings', '--regexp-ignore-case', '--format=%H', '--exclude=refs/stash', ...OWN_REF_EXCLUDES, '--all'];
      const opts = { cwd: root, repoId, signal: ctl.signal };
      const [byMessage, byAuthor] = await Promise.all([
        runGit([...base, `--grep=${q}`, '--end-of-options'], opts),
        runGit([...base, `--author=${q}`, '--end-of-options'], opts),
      ]);
      if (ctl.signal.aborted) return superseded();
      const matched = new Set<string>();
      for (const r of [byMessage, byAuthor]) {
        if (r.code === 0) for (const line of r.stdout.split('\n')) if (line) matched.add(line.trim());
      }
      const prefix = SHA_RE.test(q) ? q.toLowerCase() : null;
      const shas: string[] = [];
      const indexes: number[] = [];
      // Graph order and index come from the cached history; the git walks above only decide who matches.
      history.commits.forEach((c, i) => {
        if (shas.length >= MAX_SEARCH_RESULTS) return;
        if (matched.has(c.sha) || (prefix && c.sha.startsWith(prefix))) {
          shas.push(c.sha);
          indexes.push(i);
        }
      });
      return { shas, indexes } satisfies SearchResult;
    } catch (e) {
      if (ctl.signal.aborted) return superseded();
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'Search failed.' });
    } finally {
      if (searches.get(repoId) === ctl) searches.delete(repoId);
    }
  });

  app.get<{ Params: { id: string } }>('/api/repos/:id/status-summary', async (req, reply) => {
    const root = rootOrFail(req.params.id, reply);
    if (!root) return reply;
    const res = await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: root, repoId: req.params.id });
    if (res.code !== 0) return reply.code(500).send({ error: res.stderr.trim() || 'git status failed.' });
    const summary = parseStatusV2(res.stdout);
    const op = await readOpState(root);
    return op ? { ...summary, op } : summary;
  });
}
