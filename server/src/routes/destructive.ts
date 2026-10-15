import type { FastifyInstance, FastifyReply } from 'fastify';
import { createTag, deleteBranch, discardFiles, discardHunk, forcePush, renameBranch, resetNeedsConfirm, resetTo, type DResult } from '../git/destructive';
import { cherryPick, cherryPickAbort, revert, revertAbort, type PickResult } from '../git/integrate';
import { scrubSecrets } from '../git/scrub';
import type { RepoRegistry } from '../state/registry';

const obj = (body: unknown): Record<string, unknown> | null => (typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null);

/**
 * done / noop / conflict are 200 (a conflict and a skipped empty pick are not errors). blocked is 409 (`opInProgress`), an unmerged
 * branch is 409 `{unmerged, stderr}`, a stale hunk is 409, other refused input is 400, a git failure is 500. Every text is scrubbed.
 */
function send(reply: FastifyReply, r: DResult | PickResult) {
  const stash = r.stash ? { stash: r.stash } : {};
  switch (r.outcome) {
    case 'done':
    case 'noop':
    case 'conflict':
      return reply.send({ outcome: r.outcome, ...stash });
    case 'blocked':
      return reply.code(409).send({ error: r.error ?? 'Another operation is in progress.', opInProgress: true });
    case 'unmerged':
      return reply.code(409).send({ error: scrubSecrets(r.error ?? 'The branch is not fully merged.'), stderr: scrubSecrets(r.stderr ?? ''), unmerged: true });
    case 'refused':
      return reply.code('stale' in r && r.stale ? 409 : 400).send({ error: scrubSecrets(r.error ?? 'Invalid request.') });
    case 'rejected':
      return reply.code(409).send({ error: scrubSecrets(r.error ?? 'Rejected.'), stderr: scrubSecrets(r.stderr ?? '') });
    default:
      return reply.code(500).send({
        error: scrubSecrets(r.error ?? 'Request failed.'),
        ...(r.stderr !== undefined ? { stderr: scrubSecrets(r.stderr) } : {}),
        ...('lease' in r && r.lease ? { leaseFailed: true } : {}),
        ...stash,
      });
  }
}

export function registerDestructiveRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  const rootOf = (id: string, reply: FastifyReply): string | null => {
    const root = registry.rootOf(id);
    if (!root) void reply.code(404).send({ error: 'Unknown repository.' });
    return root ?? null;
  };
  const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'Invalid request.' });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/discard', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body || !Array.isArray(body.paths) || body.paths.some((p) => typeof p !== 'string')) return invalid(reply);
    return send(reply, await discardFiles(root, body.paths as string[]));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/discard-hunk', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body || typeof body.path !== 'string' || typeof body.header !== 'string' || typeof body.hunk !== 'number') return invalid(reply);
    return send(reply, await discardHunk(root, { path: body.path, hunk: body.hunk, header: body.header }));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/reset', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body || typeof body.sha !== 'string' || typeof body.mode !== 'string') return invalid(reply);
    return send(reply, await resetTo(root, { sha: body.sha, mode: body.mode as 'hard' }));
  });

  /** Read-only: does a hard reset to this commit touch anything uncommitted or collide with an untracked or ignored file? */
  app.get<{ Params: { id: string }; Querystring: { sha?: string } }>('/api/repos/:id/reset-check', async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const sha = req.query.sha;
    if (typeof sha !== 'string') return invalid(reply);
    const r = await resetNeedsConfirm(root, sha);
    return 'error' in r ? reply.code(400).send({ error: r.error }) : r;
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/branch/rename', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body || typeof body.name !== 'string' || typeof body.newName !== 'string') return invalid(reply);
    return send(reply, await renameBranch(root, { name: body.name, newName: body.newName }));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/branch/delete', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body || typeof body.name !== 'string' || typeof body.expectSha !== 'string') return invalid(reply);
    // `force` and `remote` are passed on as they came: the function refuses anything that is not a boolean.
    return send(
      reply,
      await deleteBranch(root, {
        name: body.name,
        expectSha: body.expectSha,
        ...(body.force !== undefined ? { force: body.force as boolean } : {}),
        ...(body.remote !== undefined ? { remote: body.remote as boolean } : {}),
      }),
    );
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/push/force', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    // Only branch and expect are read: the remote and its branch come from the upstream configuration on the server.
    if (!body || typeof body.branch !== 'string' || typeof body.expect !== 'string') return invalid(reply);
    return send(reply, await forcePush(root, { branch: body.branch, expect: body.expect }));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/tag', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body || typeof body.name !== 'string' || typeof body.sha !== 'string' || (body.message !== undefined && typeof body.message !== 'string')) return invalid(reply);
    return send(reply, await createTag(root, { name: body.name, sha: body.sha, ...(typeof body.message === 'string' ? { message: body.message } : {}) }));
  });

  for (const [route, fn] of [['cherry-pick', cherryPick], ['revert', revert]] as const) {
    app.post<{ Params: { id: string }; Body: unknown }>(`/api/repos/:id/${route}`, { bodyLimit: 64 * 1024 }, async (req, reply) => {
      const root = rootOf(req.params.id, reply);
      if (!root) return reply;
      const body = obj(req.body);
      if (!body || typeof body.sha !== 'string') return invalid(reply);
      return send(reply, await fn(root, body.sha));
    });
  }
  app.post<{ Params: { id: string } }>('/api/repos/:id/cherry-pick/abort', async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    return root ? send(reply, await cherryPickAbort(root)) : reply;
  });
  app.post<{ Params: { id: string } }>('/api/repos/:id/revert/abort', async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    return root ? send(reply, await revertAbort(root)) : reply;
  });
}
