import type { FastifyInstance, FastifyReply } from 'fastify';
import { stashApply, stashDrop, stashFiles, stashPush, type StashResult } from '../git/stash';
import { scrubSecrets } from '../git/scrub';
import type { RepoRegistry } from '../state/registry';

const obj = (body: unknown): Record<string, unknown> | null => (typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null);

/**
 * done 200 (`conflict` outcome is also 200 with `conflict: true`), bad input 400, unknown stash 404, blocked or refused 409,
 * a git failure 500. Texts are scrubbed.
 */
function send(reply: FastifyReply, r: StashResult) {
  const err = { error: scrubSecrets(r.error ?? 'Request failed.'), ...(r.stderr !== undefined ? { stderr: scrubSecrets(r.stderr) } : {}) };
  switch (r.outcome) {
    case 'done':
      return reply.send({ ...(r.sha ? { sha: r.sha } : {}), ...(r.base ? { base: r.base } : {}) });
    case 'conflict':
      return reply.send({ conflict: true });
    case 'invalid':
      return reply.code(400).send(err);
    case 'not-found':
      return reply.code(404).send(err);
    case 'blocked':
      return reply.code(409).send({ ...err, opInProgress: true });
    case 'refused':
      return reply.code(409).send(err);
    default:
      return reply.code(500).send(err);
  }
}

export function registerStashRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  const rootOf = (id: string, reply: FastifyReply): string | null => {
    const root = registry.rootOf(id);
    if (!root) void reply.code(404).send({ error: 'Unknown repository.' });
    return root ?? null;
  };
  const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'Invalid request.' });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/stash', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body) ?? {};
    if ((body.message !== undefined && typeof body.message !== 'string') || (body.fromTab !== undefined && typeof body.fromTab !== 'boolean')) return bad(reply);
    return send(reply, await stashPush(root, { ...(typeof body.message === 'string' ? { message: body.message } : {}), fromTab: body.fromTab === true }));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/stash/apply', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body || typeof body.sha !== 'string' || typeof body.pop !== 'boolean') return bad(reply);
    return send(reply, await stashApply(root, body.sha, body.pop));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/stash/drop', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body || typeof body.sha !== 'string') return bad(reply);
    return send(reply, await stashDrop(root, body.sha));
  });

  app.get<{ Params: { id: string; sha: string } }>('/api/repos/:id/stash/:sha', async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const r = await stashFiles(root, req.params.sha);
    if (r.outcome !== 'done') return r.outcome === 'invalid' ? reply.code(400).send({ error: 'Invalid stash.' }) : reply.code(404).send({ error: 'That stash no longer exists.' });
    return { files: r.files, ...(r.truncated ? { truncated: true } : {}) };
  });
}
