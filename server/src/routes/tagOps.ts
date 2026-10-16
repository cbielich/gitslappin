import type { FastifyInstance, FastifyReply } from 'fastify';
import { scrubSecrets } from '../git/scrub';
import { deleteTagFromRemote, deleteTagLocal, pushTag, type TagResult } from '../git/tagOps';
import type { RepoRegistry } from '../state/registry';

const obj = (body: unknown): Record<string, unknown> | null => (typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null);

/** done is 200, a stale sha is 409, refused input is 400, a git failure is 500. Every text is scrubbed. */
function send(reply: FastifyReply, r: TagResult) {
  switch (r.outcome) {
    case 'done':
      return reply.send({ outcome: 'done' });
    case 'stale':
      return reply.code(409).send({ error: scrubSecrets(r.error ?? 'The tag has changed.'), stale: true });
    case 'refused':
      return reply.code(400).send({ error: scrubSecrets(r.error ?? 'Invalid request.') });
    default:
      return reply.code(500).send({ error: scrubSecrets(r.error ?? 'Request failed.'), ...(r.stderr !== undefined ? { stderr: scrubSecrets(r.stderr) } : {}) });
  }
}

export function registerTagOpsRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  const rootOf = (id: string, reply: FastifyReply): string | null => {
    const root = registry.rootOf(id);
    if (!root) void reply.code(404).send({ error: 'Unknown repository.' });
    return root ?? null;
  };
  const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'Invalid request.' });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/tag/push', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body) return invalid(reply);
    return send(reply, await pushTag(root, { name: body.name, sha: body.sha, remote: body.remote }));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/tag/delete', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body) return invalid(reply);
    return send(reply, await deleteTagLocal(root, { name: body.name, sha: body.sha }));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/tag/delete-remote', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body) return invalid(reply);
    return send(reply, await deleteTagFromRemote(root, { name: body.name, sha: body.sha, remote: body.remote }));
  });
}
