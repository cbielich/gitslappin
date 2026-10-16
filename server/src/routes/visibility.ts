import type { FastifyInstance } from 'fastify';
import { runGit } from '../git/runner';
import type { RepoRegistry } from '../state/registry';
import { type VisibilityStore, parseVisibility } from '../visibility';

/** Two arrays of 5000 entries of 1024 characters (JSON-escaped worst case stays well under this). */
const BODY_LIMIT = 12 * 1024 * 1024;

export function registerVisibilityRoutes(app: FastifyInstance, registry: RepoRegistry, store: VisibilityStore): void {
  app.get<{ Params: { id: string } }>('/api/repos/:id/visibility', async (req, reply) => {
    const root = registry.rootOf(req.params.id);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const cur = store.get(req.params.id);
    if (cur.hidden.length === 0 && cur.solo.length === 0) return cur;
    // Drop entries for refs that no longer exist (a deleted soloed branch ends soloing; a recreated ref is visible again).
    const res = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], { cwd: root, repoId: req.params.id });
    if (res.code !== 0) return cur;
    const live = new Set(res.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
    const next = { ...cur, hidden: cur.hidden.filter((r) => live.has(r)), solo: cur.solo.filter((r) => live.has(r)) };
    if (next.hidden.length === cur.hidden.length && next.solo.length === cur.solo.length) return cur;
    try {
      store.set(req.params.id, next);
    } catch {
      // not persisted; the pruned value is still returned
    }
    return next;
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/visibility', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    if (!registry.rootOf(req.params.id)) return reply.code(404).send({ error: 'Unknown repository.' });
    const v = parseVisibility(req.body);
    if (!v) return reply.code(400).send({ error: 'Invalid request.' });
    try {
      store.set(req.params.id, v);
    } catch {
      return reply.code(500).send({ error: 'Could not save.' });
    }
    return v;
  });
}
