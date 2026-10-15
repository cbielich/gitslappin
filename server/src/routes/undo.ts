import type { FastifyInstance, FastifyReply } from 'fastify';
import { scrubSecrets } from '../git/scrub';
import { clearRedo, redo, undo, undoState, type UndoResult } from '../git/undo';
import type { RepoRegistry } from '../state/registry';

/** done 200, a refused or blocked step 409 (nothing changed; the reason is in `error`), a git failure 500. */
function send(reply: FastifyReply, r: UndoResult) {
  const error = scrubSecrets(r.error ?? 'Request failed.');
  switch (r.outcome) {
    case 'done':
      return reply.send({ ...(r.label ? { label: r.label } : {}) });
    case 'blocked':
      return reply.code(409).send({ error, opInProgress: true });
    case 'refused':
      return reply.code(409).send({ error });
    default:
      return reply.code(500).send({ error, ...(r.stderr !== undefined ? { stderr: scrubSecrets(r.stderr) } : {}) });
  }
}

export function registerUndoRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  // Any mutating request that is not Undo/Redo itself makes the redo list invalid (recorded actions clear it too).
  // Cleared when the request starts, so a failed or refused action only ever errs on the safe side.
  app.addHook('preHandler', async (req) => {
    if (req.method !== 'POST') return;
    // The matched route pattern, not the raw path: an encoded spelling (`/%75ndo`) reaches the same route.
    const pattern = req.routeOptions.url ?? '';
    const prefix = '/api/repos/:id/';
    if (!pattern.startsWith(prefix)) return;
    const tail = pattern.slice(prefix.length);
    if (tail === 'undo' || tail === 'redo') return;
    const id = (req.params as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string') return;
    const root = registry.rootOf(id);
    if (root) clearRedo(root);
  });

  app.get<{ Params: { id: string } }>('/api/repos/:id/undo-state', async (req, reply) => {
    const root = registry.rootOf(req.params.id);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    return undoState(root);
  });

  // No body is read: what to undo comes only from the server's own journal.
  app.post<{ Params: { id: string } }>('/api/repos/:id/undo', async (req, reply) => {
    const root = registry.rootOf(req.params.id);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    return send(reply, await undo(root));
  });

  app.post<{ Params: { id: string } }>('/api/repos/:id/redo', async (req, reply) => {
    const root = registry.rootOf(req.params.id);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    return send(reply, await redo(root));
  });
}
