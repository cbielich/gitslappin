import type { FastifyInstance } from 'fastify';
import { aliveStream, type AutoExit } from '../alive';

/** Both routes sit behind the app-wide token hook (header only; a token in the query string is not read). */
export function registerSystemRoutes(app: FastifyInstance, tracker: Pick<AutoExit, 'connect'>, desktop: () => boolean = () => false, terminal: () => { terminal: boolean; terminalBash: boolean } = () => ({ terminal: false, terminalBash: false })): void {
  app.get('/api/ping', async () => ({ app: 'gitslappin', pid: process.pid, desktop: desktop(), ...terminal() }));

  // A response that is never finished: the window holds it open, and its closing is how the server learns the window is gone.
  app.get('/api/alive', (_req, reply) => {
    reply.hijack(); // hooks do not run for a hijacked reply, so the headers are set here
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.write(': connected\n\n');
    aliveStream({
      tracker,
      write: (chunk) => {
        if (!res.destroyed && !res.writableEnded) res.write(chunk);
      },
      onClose: (cb) => void res.once('close', cb), // not req 'close': for a request without a body that fires as soon as it was read
    });
  });
}
