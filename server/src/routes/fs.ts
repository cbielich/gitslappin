import type { FastifyInstance } from 'fastify';
import type { FsListResult } from '@gitslappin/shared';
import { FsListError } from '../fsList';

/** GET /api/fs/list?path= — folders only. The token check is the app-wide onRequest hook. Paths are never logged. */
export function registerFsRoutes(app: FastifyInstance, lister: { list(path?: string): Promise<FsListResult> }): void {
  app.get('/api/fs/list', async (req, reply) => {
    const raw = (req.query as { path?: unknown } | null)?.path;
    try {
      return await lister.list(typeof raw === 'string' ? raw : undefined);
    } catch (e) {
      if (e instanceof FsListError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });
}
