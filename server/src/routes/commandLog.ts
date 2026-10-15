import type { FastifyInstance } from 'fastify';
import { getCommandLog } from '../git/commandLog';
import type { RepoRegistry } from '../state/registry';

/** The log resolves only through the id of an open repo. Entries were scrubbed and capped when they were recorded. */
export function registerCommandLogRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  app.get<{ Params: { id: string }; Querystring: { after?: string | string[] } }>('/api/repos/:id/command-log', async (req, reply) => {
    if (!registry.rootOf(req.params.id)) return reply.code(404).send({ error: 'Unknown repository.' });
    const raw = req.query.after;
    // A non-negative integer of at most 15 digits; nothing else (no sign, decimal point, exponent, hex or list).
    if (raw !== undefined && (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw))) return reply.code(400).send({ error: 'Invalid request.' });
    return { entries: getCommandLog(req.params.id, raw === undefined ? 0 : Number(raw)) };
  });
}
