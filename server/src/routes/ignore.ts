import type { FastifyInstance } from 'fastify';
import { ignorePaths } from '../git/ignore';
import { scrubSecrets } from '../git/scrub';
import type { RepoRegistry } from '../state/registry';

const obj = (body: unknown): Record<string, unknown> | null => (typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null);

export function registerIgnoreRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  // The pattern text is built on the server from `paths` + `mode`; any other field in the body (a "pattern") is never read.
  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/ignore', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const root = registry.rootOf(req.params.id);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const body = obj(req.body);
    if (!body || !Array.isArray(body.paths) || body.paths.some((p) => typeof p !== 'string')) return reply.code(400).send({ error: 'Invalid request.' });
    if (body.mode !== 'file' && body.mode !== 'ext' && body.mode !== 'folder') return reply.code(400).send({ error: 'Invalid request.' });
    if (typeof body.untrack !== 'boolean') return reply.code(400).send({ error: 'Invalid request.' });
    const r = await ignorePaths(root, { paths: body.paths as string[], mode: body.mode, untrack: body.untrack });
    switch (r.outcome) {
      case 'done':
      case 'noop':
        return reply.send({ outcome: r.outcome });
      case 'blocked':
        return reply.code(409).send({ error: r.error ?? 'Another operation is in progress.', opInProgress: true });
      case 'refused':
        return reply.code(400).send({ error: scrubSecrets(r.error ?? 'Invalid request.') });
      default:
        return reply.code(500).send({ error: scrubSecrets(r.error ?? 'Request failed.'), ...(r.stderr !== undefined ? { stderr: scrubSecrets(r.stderr) } : {}) });
    }
  });
}
