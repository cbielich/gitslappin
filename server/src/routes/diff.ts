import { readFileSync, statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { parseUnifiedDiff, type DiffContents, type DiffSource, type DiffStatus, type FileDiff } from '@gitslappin/shared';
import { pickFile, statusFromNameStatus, sumNumstat } from '../git/diffParse';
import { SHA_RE } from '../git/parsers/commit';
import { runGit } from '../git/runner';
import { isStashSha } from '../git/stash';
import { UnsafePathError, assertWorkingTreeFile, safeRepoPath } from '../git/safeRepoPath';
import type { RepoRegistry } from '../state/registry';

/** Over this many changed lines the diff comes back with stats only until the client asks with full=1. */
const MAX_CHANGED_LINES = 2000;
const FULL_DIFF_MAX_BYTES = 20 * 1024 * 1024;
const FULL_DIFF_TIMEOUT_MS = 60_000;
const CONTENT_MAX_BYTES = 5 * 1024 * 1024;
const SOURCES: readonly string[] = ['commit', 'unstaged', 'staged', 'stash', 'workdir'];
const STASH_SHA = /^[0-9a-f]{40,64}$/;

interface DiffQuery {
  source?: string;
  path?: string;
  oldPath?: string;
  sha?: string;
  base?: string;
  full?: string;
  untracked?: string;
  ws?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Parsed {
  source: DiffSource;
  path: string;
  oldPath?: string;
  sha?: string;
  /** Commit source only: compare against this commit (or the literal "empty") instead of the first parent. */
  base?: string;
  full: boolean;
  untracked: boolean;
  ws: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function registerDiffRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  function fail(reply: FastifyReply, e: unknown) {
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof UnsafePathError) return reply.code(400).send({ error: e.message });
    return reply.code(500).send({ error: e instanceof Error ? e.message : 'Diff failed.' });
  }

  function parse(root: string, q: DiffQuery): Parsed {
    const source = str(q.source);
    if (!source || !SOURCES.includes(source)) throw new HttpError(400, 'Invalid source.');
    const path = str(q.path);
    if (path === undefined) throw new HttpError(400, 'Missing path.');
    safeRepoPath(root, path);
    const oldPath = str(q.oldPath);
    if (oldPath !== undefined) safeRepoPath(root, oldPath);
    const sha = str(q.sha);
    if ((source === 'commit' || source === 'workdir') && (!sha || !(SHA_RE.test(sha) || (source === 'workdir' && sha === 'empty')))) throw new HttpError(400, 'Invalid commit id.');
    const base = str(q.base);
    if (base !== undefined && (source !== 'commit' || (base !== 'empty' && !SHA_RE.test(base)))) throw new HttpError(400, 'Invalid commit id.');
    if (source === 'stash' && (!sha || !STASH_SHA.test(sha))) throw new HttpError(400, 'Invalid stash.');
    const untracked = q.untracked === '1';
    if (untracked && source !== 'unstaged') throw new HttpError(400, 'Invalid request.');
    return {
      source: source as DiffSource,
      path,
      ...(oldPath !== undefined ? { oldPath } : {}),
      ...((source === 'commit' || source === 'stash' || source === 'workdir') && sha ? { sha } : {}),
      ...(base !== undefined ? { base } : {}),
      full: q.full === '1',
      untracked,
      ws: q.ws === '1',
    };
  }

  async function resolveCommit(root: string, repoId: string, sha: string): Promise<string> {
    const res = await runGit(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`], { cwd: root, repoId });
    const full = res.stdout.trim();
    if (res.code !== 0 || !/^[0-9a-f]{40,64}$/.test(full)) throw new HttpError(404, 'Commit not found.');
    return full;
  }

  /** First parent of a commit, or null for a root commit. */
  async function firstParent(root: string, repoId: string, sha: string): Promise<string | null> {
    const res = await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^1^{commit}`], { cwd: root, repoId });
    const p = res.stdout.trim();
    return res.code === 0 && /^[0-9a-f]{40,64}$/.test(p) ? p : null;
  }

  /** The empty tree id (works for SHA-1 and SHA-256 repos). */
  async function emptyTree(root: string, repoId: string): Promise<string> {
    const empty = await runGit(['hash-object', '-t', 'tree', '--stdin'], { cwd: root, repoId, input: '' });
    const id = empty.stdout.trim();
    if (empty.code !== 0 || !/^[0-9a-f]{40,64}$/.test(id)) throw new HttpError(500, 'Could not read the repository.');
    return id;
  }

  /** HEAD, or the empty tree when HEAD is unborn. */
  async function headOrEmptyTree(root: string, repoId: string): Promise<string> {
    const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, repoId });
    if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
    return emptyTree(root, repoId);
  }

  /** A workdir diff may only read tracked files (an ignored .env or an untracked file is refused); a file that is gone from the folder is fine. */
  async function assertTrackedOrGone(root: string, repoId: string, path: string): Promise<void> {
    try {
      await indexConflicted(root, repoId, path);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      if (assertWorkingTreeFile(root, safeRepoPath(root, path))) throw e;
    }
  }

  async function assertUntracked(root: string, repoId: string, path: string): Promise<void> {
    const res = await runGit(['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--end-of-options', '--', path], { cwd: root, repoId });
    if (res.code !== 0 || !res.stdout.split('\0').includes(path)) throw new HttpError(400, 'Not an untracked file.');
  }

  function pathspecs(r: Parsed): string[] {
    return r.oldPath !== undefined && r.oldPath !== r.path ? [r.oldPath, r.path] : [r.path];
  }

  /** A tracked file must be in the index. Returns true when it is unmerged (a merge conflict). */
  async function indexConflicted(root: string, repoId: string, path: string): Promise<boolean> {
    const res = await runGit(['--literal-pathspecs', 'ls-files', '-z', '--stage', '--error-unmatch', '--', path], { cwd: root, repoId });
    if (res.code !== 0) throw new HttpError(400, 'Not a tracked file.');
    let found = false;
    let conflicted = false;
    for (const entry of res.stdout.split('\0')) {
      const m = /^\d+ [0-9a-f]+ (\d)\t([\s\S]*)$/.exec(entry);
      if (!m || m[2] !== path) continue; // a pathspec naming a folder lists the files inside it
      found = true;
      if (m[1] !== '0') conflicted = true;
    }
    if (!found) throw new HttpError(400, 'Not a tracked file.');
    return conflicted;
  }

  /**
   * Which side of a stash holds the file: `sha^3` (untracked) or the tracked change between `sha^1` and `sha`.
   * The sha must be in the stash list right now (404 otherwise).
   */
  async function stashSide(root: string, repoId: string, sha: string, path: string): Promise<'tracked' | 'untracked'> {
    if (!(await isStashSha(root, sha))) throw new HttpError(404, 'That stash no longer exists.');
    const res = await runGit(['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', `${sha}^3`, '--', path], { cwd: root, repoId });
    return res.code === 0 && res.stdout.split('\0').includes(path) ? 'untracked' : 'tracked';
  }

  /** Builds the git args for `mode` (['-p'] for the patch, numstat / name-status with -z for stats). */
  async function buildArgs(root: string, repoId: string, r: Parsed, mode: readonly string[]): Promise<string[]> {
    const flags = ['--no-ext-diff', '--no-textconv', '--no-color', ...(r.ws ? ['-b'] : [])];
    if (r.source === 'workdir') {
      const sha = r.sha === 'empty' ? await emptyTree(root, repoId) : await resolveCommit(root, repoId, r.sha as string); // 'empty' (a root-chain compare) is the empty tree, never given to rev-parse
      return ['--literal-pathspecs', 'diff', ...mode, '-M', ...flags, '--end-of-options', sha, '--', ...pathspecs(r)];
    }
    if (r.source === 'commit') {
      const sha = await resolveCommit(root, repoId, r.sha as string);
      if (r.base !== undefined) {
        const base = r.base === 'empty' ? await emptyTree(root, repoId) : await resolveCommit(root, repoId, r.base);
        return ['--literal-pathspecs', 'diff-tree', '-r', ...mode, '-M', '--no-commit-id', ...flags, '--end-of-options', base, sha, '--', ...pathspecs(r)];
      }
      const parent = await firstParent(root, repoId, sha);
      return [
        '--literal-pathspecs',
        'diff-tree',
        '-r',
        ...mode,
        '-M',
        '--no-commit-id',
        ...flags,
        ...(parent ? [] : ['--root']),
        '--end-of-options',
        ...(parent ? [parent, sha] : [sha]),
        '--',
        ...pathspecs(r),
      ];
    }
    if (r.source === 'stash') {
      const sha = r.sha as string;
      const side = await stashSide(root, repoId, sha, r.path);
      return [
        '--literal-pathspecs',
        'diff-tree',
        '-r',
        ...mode,
        '-M',
        '--no-commit-id',
        ...flags,
        ...(side === 'untracked' ? ['--root'] : []),
        '--end-of-options',
        ...(side === 'untracked' ? [`${sha}^3`] : [`${sha}^1`, sha]),
        '--',
        ...pathspecs(r),
      ];
    }
    if (r.source === 'staged') {
      const base = await headOrEmptyTree(root, repoId);
      return ['--literal-pathspecs', 'diff-index', ...mode, '-M', '--cached', ...flags, '--end-of-options', base, '--', ...pathspecs(r)];
    }
    if (r.untracked) {
      await assertUntracked(root, repoId, r.path);
      return ['--literal-pathspecs', 'diff', '--no-index', ...mode, ...flags, '--', '/dev/null', r.path];
    }
    return ['--literal-pathspecs', 'diff-files', ...mode, ...flags, '--end-of-options', '--', r.path];
  }

  function checkWorkingFile(root: string, r: Parsed): void {
    if (r.source === 'unstaged' || r.source === 'workdir') assertWorkingTreeFile(root, safeRepoPath(root, r.path));
  }

  /** The real status for the fallback and too-large answers (never a guessed one). */
  async function realStatus(root: string, repoId: string, r: Parsed): Promise<DiffStatus> {
    if (r.untracked) return 'A';
    try {
      const out = await runGit(await buildArgs(root, repoId, r, ['--name-status', '-z']), { cwd: root, repoId });
      if (out.code === 0) return statusFromNameStatus(out.stdout, r.path) ?? 'M';
    } catch {
      // fall through
    }
    return 'M';
  }

  app.get<{ Params: { id: string }; Querystring: DiffQuery }>('/api/repos/:id/diff', async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      const r = parse(root, req.query);
      checkWorkingFile(root, r);
      if (r.source === 'workdir') await assertTrackedOrGone(root, repoId, r.path);
      const base = { path: r.path, ...(r.oldPath !== undefined && r.oldPath !== r.path ? { oldPath: r.oldPath } : {}) };
      // An unstaged diff of a tracked file needs the path in the index; an unmerged path has no diff.
      if (r.source === 'unstaged' && !r.untracked && (await indexConflicted(root, repoId, r.path))) {
        return { ...base, status: 'M', binary: false, headerLines: [], hunks: [], additions: 0, deletions: 0, tooLarge: false, conflicted: true } satisfies FileDiff;
      }
      // git exits 1 for `diff --no-index` when the files differ.
      const okCode = (code: number) => code === 0 || (r.untracked && code === 1);

      const stats = await runGit(await buildArgs(root, repoId, r, ['--numstat', '-z']), { cwd: root, repoId });
      if (!okCode(stats.code)) throw new HttpError(500, stats.stderr.trim() || 'git diff failed.');
      const { additions, deletions } = sumNumstat(stats.stdout, r.path);
      if (!r.full && additions + deletions > MAX_CHANGED_LINES) {
        return {
          ...base,
          status: await realStatus(root, repoId, r),
          binary: false,
          headerLines: [],
          hunks: [],
          additions,
          deletions,
          tooLarge: true,
        } satisfies FileDiff;
      }

      const res = await runGit(await buildArgs(root, repoId, r, ['-p']), {
        cwd: root,
        repoId,
        maxBuffer: FULL_DIFF_MAX_BYTES,
        timeoutMs: FULL_DIFF_TIMEOUT_MS,
      });
      if (res.code === -1) throw new HttpError(413, 'The diff is too large to show.');
      if (!okCode(res.code)) throw new HttpError(500, res.stderr.trim() || 'git diff failed.');
      const file = pickFile(parseUnifiedDiff(res.stdout), r.path);
      if (file) return file;
      return {
        ...base,
        status: await realStatus(root, repoId, r),
        binary: false,
        headerLines: [],
        hunks: [],
        additions: 0,
        deletions: 0,
        tooLarge: false,
      } satisfies FileDiff;
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** Reads a blob/index entry. null = the object is not there (added or deleted side). */
  async function readObject(root: string, repoId: string, spec: string): Promise<string | null> {
    const size = await runGit(['cat-file', '-s', spec], { cwd: root, repoId });
    if (size.code !== 0) return null;
    if (Number(size.stdout.trim()) > CONTENT_MAX_BYTES) throw new HttpError(413, 'The file is too large to show.');
    const res = await runGit(['cat-file', 'blob', spec], { cwd: root, repoId, maxBuffer: CONTENT_MAX_BYTES * 2 });
    if (res.code !== 0) return null;
    return res.stdout;
  }

  function readWorkingFile(root: string, path: string): string | null {
    const abs = safeRepoPath(root, path);
    if (!assertWorkingTreeFile(root, abs)) return null;
    if (statSync(abs).size > CONTENT_MAX_BYTES) throw new HttpError(413, 'The file is too large to show.');
    return readFileSync(abs, 'utf8');
  }

  app.get<{ Params: { id: string }; Querystring: DiffQuery }>('/api/repos/:id/diff/contents', async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      const r = parse(root, req.query);
      const oldPath = r.oldPath ?? r.path;
      let before: string | null;
      let after: string | null;
      if (r.source === 'workdir') {
        const sha = r.sha === 'empty' ? null : await resolveCommit(root, repoId, r.sha as string);
        await assertTrackedOrGone(root, repoId, r.path);
        before = sha ? await readObject(root, repoId, `${sha}:${oldPath}`) : null;
        after = readWorkingFile(root, r.path);
      } else if (r.source === 'commit') {
        const sha = await resolveCommit(root, repoId, r.sha as string);
        const parent = r.base === undefined ? await firstParent(root, repoId, sha) : r.base === 'empty' ? null : await resolveCommit(root, repoId, r.base);
        before = parent ? await readObject(root, repoId, `${parent}:${oldPath}`) : null;
        after = await readObject(root, repoId, `${sha}:${r.path}`);
      } else if (r.source === 'stash') {
        const sha = r.sha as string;
        if ((await stashSide(root, repoId, sha, r.path)) === 'untracked') {
          before = null;
          after = await readObject(root, repoId, `${sha}^3:${r.path}`);
        } else {
          before = await readObject(root, repoId, `${sha}^1:${oldPath}`);
          after = await readObject(root, repoId, `${sha}:${r.path}`);
        }
      } else if (r.source === 'staged') {
        const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, repoId });
        before = head.code === 0 ? await readObject(root, repoId, `HEAD:${oldPath}`) : null;
        after = await readObject(root, repoId, `:0:${r.path}`);
      } else {
        if (r.untracked) {
          await assertUntracked(root, repoId, r.path);
          before = null;
        } else {
          if (await indexConflicted(root, repoId, r.path)) throw new HttpError(409, 'Merge conflicts detected');
          before = await readObject(root, repoId, `:0:${r.path}`);
        }
        after = readWorkingFile(root, r.path);
      }
      const isBinary = (s: string | null) => s !== null && s.slice(0, 8192).includes('\0');
      if (isBinary(before) || isBinary(after)) return reply.code(415).send({ error: 'Binary file' });
      return { old: before ?? '', new: after ?? '' } satisfies DiffContents;
    } catch (e) {
      return fail(reply, e);
    }
  });
}
