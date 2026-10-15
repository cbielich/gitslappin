import type { FastifyInstance } from 'fastify';
import { branchNameProblem, type BranchActionResult, type HeadState } from '@gitslappin/shared';
import { guardOp } from '../git/guardOp';
import { runExclusive } from '../git/queue';
import { runGit } from '../git/runner';
import { clearRedo, record } from '../git/undo';
import type { RepoRegistry } from '../state/registry';

const TIMEOUT_MS = 5 * 60 * 1000;
const SHA_FULL_RE = /^[0-9a-f]{40,64}$/;

interface Reply {
  code: number;
  body: unknown;
}

const bad = (error: string): Reply => ({ code: 400, body: { error } });

function failure(res: { code: number; stdout: string; stderr: string }, fallback: string): Reply {
  const text = `${res.stderr}${res.stdout}`.trim();
  return { code: 500, body: { error: text.split('\n')[0] || fallback, stderr: text || `git exited with code ${res.code}.` } };
}

function obj(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export function registerBranchRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  async function headState(root: string, repoId: string): Promise<HeadState> {
    const [sym, sha] = await Promise.all([
      runGit(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, repoId }),
      runGit(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root, repoId }),
    ]);
    return { branch: sym.code === 0 ? sym.stdout.trim() : null, sha: sha.code === 0 ? sha.stdout.trim() : null };
  }

  /** Pure checks, then git's own rule. check-ref-format --branch expands @{-1}, so its stdout must equal the name. */
  async function validBranchName(root: string, repoId: string, name: string): Promise<boolean> {
    if (branchNameProblem(name) !== null) return false;
    const res = await runGit(['check-ref-format', '--branch', name], { cwd: root, repoId });
    return res.code === 0 && res.stdout.trim() === name;
  }

  /** short name (prefix removed) -> sha. */
  async function refMap(root: string, repoId: string, prefix: string): Promise<Map<string, string>> {
    const res = await runGit(['for-each-ref', '--format=%(refname)%1f%(objectname)', prefix], { cwd: root, repoId });
    const out = new Map<string, string>();
    if (res.code !== 0) return out;
    for (const line of res.stdout.split('\n')) {
      const [ref, sha] = line.split('\x1f');
      if (ref && sha && ref.startsWith(prefix)) out.set(ref.slice(prefix.length), sha);
    }
    return out;
  }

  async function resolveCommit(root: string, repoId: string, rev: string): Promise<string | null> {
    const res = await runGit(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`], { cwd: root, repoId });
    const sha = res.stdout.trim();
    return res.code === 0 && SHA_FULL_RE.test(sha) ? sha : null;
  }

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/checkout', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const body = obj(req.body);
    if (!body) return reply.code(400).send({ error: 'Invalid request.' });
    const { kind, name, sha } = body;

    const out = await runExclusive<Reply>(repoId, async () => {
      const blocked = await guardOp(root);
      if (blocked) return blocked;
      const opts = { cwd: root, repoId, timeoutMs: TIMEOUT_MS };
      let args: string[];
      let tracking: { name: string; sha: string } | undefined;
      if (kind === 'local') {
        if (typeof name !== 'string' || !(await refMap(root, repoId, 'refs/heads/')).has(name)) return bad('That is not an existing local branch.');
        args = ['switch', '--no-guess', '--end-of-options', name];
      } else if (kind === 'remote') {
        const remotes = await refMap(root, repoId, 'refs/remotes/');
        if (typeof name !== 'string' || name.endsWith('/HEAD') || !remotes.has(name)) return bad('That is not an existing remote branch.');
        const list = await runGit(['remote'], opts);
        const names = list.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        const matching = names.filter((r) => name.startsWith(`${r}/`));
        // `origin` and `origin/x` both prefix-match `origin/x/main`: there is no safe way to tell which one is meant.
        if (matching.length > 1) return bad('ambiguous remote');
        const remote = matching[0];
        if (!remote) return bad('That is not an existing remote branch.');
        const local = name.slice(remote.length + 1);
        if (!(await validBranchName(root, repoId, local))) return bad('The given branch name is not valid');
        const have = (await refMap(root, repoId, 'refs/heads/')).get(local);
        if (have === undefined) {
          args = ['switch', '--track', '-c', local, '--end-of-options', name];
          tracking = { name: local, sha: remotes.get(name) ?? '' };
        }
        else if (have === remotes.get(name)) args = ['switch', '--no-guess', '--end-of-options', local];
        else return { code: 409, body: { error: `A local '${local}' already exists.`, exists: local } };
      } else if (kind === 'commit') {
        if (typeof sha !== 'string' || !SHA_FULL_RE.test(sha)) return bad('Invalid commit id.');
        const full = await resolveCommit(root, repoId, sha);
        if (!full) return bad('Invalid commit id.');
        args = ['switch', '--detach', '--end-of-options', full];
      } else {
        return bad('Invalid request.');
      }
      const prev = await headState(root, repoId);
      const res = await runGit(args, opts);
      if (res.code !== 0) return failure(res, 'git switch failed.');
      const done: BranchActionResult = { prev, head: await headState(root, repoId), ...(tracking ? { created: tracking, createdTracking: true } : {}) };
      // Phase 10: recorded inside the lock (a switch to where HEAD already was is not an action).
      if (prev.sha && done.head.sha && (prev.sha !== done.head.sha || prev.branch !== done.head.branch)) {
        record(root, {
          kind: 'checkout',
          from: { branch: prev.branch, sha: prev.sha },
          to: { branch: done.head.branch, sha: done.head.sha },
          ...(tracking ? { createdBranch: tracking.name } : {}),
        });
      } else clearRedo(root);
      return { code: 200, body: done };
    });
    return reply.code(out.code).send(out.body);
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/branch', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const body = obj(req.body);
    if (!body) return reply.code(400).send({ error: 'Invalid request.' });
    const { name, start, checkout } = body;
    if (typeof name !== 'string' || typeof checkout !== 'boolean' || (start !== undefined && typeof start !== 'string')) {
      return reply.code(400).send({ error: 'Invalid request.' });
    }

    const out = await runExclusive<Reply>(repoId, async () => {
      const blocked = await guardOp(root);
      if (blocked) return blocked;
      if (!(await validBranchName(root, repoId, name))) return bad('The given branch name is not valid');
      // Only the resolved sha is ever passed on, never the raw start text.
      const at = await resolveCommit(root, repoId, start ?? 'HEAD');
      if (!at) return bad('Invalid start point.');
      const prev = await headState(root, repoId);
      const args = checkout ? ['switch', '-c', name, '--end-of-options', at] : ['branch', '--end-of-options', name, at];
      const res = await runGit(args, { cwd: root, repoId, timeoutMs: TIMEOUT_MS });
      if (res.code !== 0) return failure(res, 'git branch failed.');
      const head = await headState(root, repoId);
      if (prev.sha) record(root, { kind: 'create-branch', name, sha: at, from: { branch: prev.branch, sha: prev.sha }, checkedOut: checkout });
      else clearRedo(root);
      return { code: 200, body: { prev, head, created: { name, sha: at } } satisfies BranchActionResult };
    });
    return reply.code(out.code).send(out.body);
  });
}
