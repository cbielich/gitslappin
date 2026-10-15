import type { FastifyInstance } from 'fastify';
import type { WatchHub } from '../git/watch';
import type { RepoRegistry } from '../state/registry';

const KEEP_ALIVE_MS = 15_000;
const MAX_PER_REPO = 8;
const MAX_TOTAL = 32;

/** Live auto-refresh stream. Behind the app-wide token hook. Lines are `data: {"type":...}` only: no paths, no content. */
export function registerEventRoutes(app: FastifyInstance, registry: RepoRegistry, hub: WatchHub): void {
  const perRepo = new Map<string, number>();
  let total = 0;
  const open = new Set<() => void>();
  // On app close end every open stream, so close does not wait for them.
  app.addHook('onClose', async () => {
    for (const end of [...open]) end();
  });

  app.get<{ Params: { id: string } }>('/api/repos/:id/events', (req, reply) => {
    const id = req.params.id;
    const root = registry.rootOf(id);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    if (total >= MAX_TOTAL || (perRepo.get(id) ?? 0) >= MAX_PER_REPO) return reply.code(429).send({ error: 'Too many open streams.' });

    reply.hijack(); // hooks do not run for a hijacked reply, so the headers are set here
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.flushHeaders();
    total++;
    perRepo.set(id, (perRepo.get(id) ?? 0) + 1);
    const write = (chunk: string): void => {
      if (!res.destroyed && !res.writableEnded) res.write(chunk);
    };
    const timer = setInterval(() => write(': keep-alive\n\n'), KEEP_ALIVE_MS);
    const unsubscribe = hub.subscribe(id, root, (e) => write(`data: ${JSON.stringify({ type: e.type })}\n\n`));
    const end = (): void => {
      if (!res.destroyed && !res.writableEnded) res.end();
    };
    open.add(end);
    res.once('close', () => {
      open.delete(end);
      clearInterval(timer);
      unsubscribe();
      total--;
      const left = (perRepo.get(id) ?? 1) - 1;
      if (left > 0) perRepo.set(id, left);
      else perRepo.delete(id);
    });
  });
}
