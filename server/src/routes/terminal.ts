import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { TerminalHub, UpgradeResult, WsLike } from '../terminal/hub';
import { TERMINAL_MAX_PAYLOAD } from '../terminal/hub';

/**
 * The one request that skips the token header (V6b audit 1): GET on exactly the matched route /api/terminal, with an Upgrade: websocket header.
 * Its credential is the single-use ticket, checked here with the Origin and Host rules of the terminal hub.
 */
export function isTerminalUpgrade(req: FastifyRequest): boolean {
  const up = req.headers.upgrade;
  return req.method === 'GET' && req.routeOptions?.url === '/api/terminal' && typeof up === 'string' && up.toLowerCase() === 'websocket';
}

export function checkTerminalUpgrade(hub: TerminalHub, req: FastifyRequest): UpgradeResult {
  let ticket: string | undefined;
  try {
    const all = new URL(req.url, 'http://x').searchParams.getAll('ticket');
    if (all.length === 1) ticket = all[0];
  } catch {
    ticket = undefined;
  }
  return hub.acceptUpgrade({ ticket, origin: req.headers.origin, host: req.headers.host });
}

export async function registerTerminalRoutes(app: FastifyInstance, hub: TerminalHub): Promise<void> {
  await app.register(fastifyWebsocket, { options: { maxPayload: TERMINAL_MAX_PAYLOAD } });
  // Behind the normal token hook.
  app.post('/api/terminal/ticket', async (_req, reply) => {
    const t = hub.issueTicket();
    if (!t.ok) return reply.code(t.status).send({ error: t.status === 429 ? 'Too many requests.' : 'Not available on this server.' });
    return { ticket: t.ticket };
  });
  // The upgrade itself was already checked by the app hook (ticket, Origin, Host, gates, socket cap).
  app.get('/api/terminal', { websocket: true }, (socket) => {
    hub.attach(socket as unknown as WsLike);
  });
}
