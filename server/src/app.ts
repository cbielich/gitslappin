import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { RepoInfo, TabsState } from '@gitslappin/shared';
import { TOKEN_HEADER } from '@gitslappin/shared';
import type { AutoExit } from './alive';
import type { Config } from './config';
import { createFsLister } from './fsList';
import { setLogToken } from './git/commandLog';
import { onSettled, repoBusy, setSettleFingerprint } from './git/queue';
import { scrubSecrets } from './git/scrub';
import { createWatchHub, realWatchDeps } from './git/watch';
import { registerBranchRoutes } from './routes/branch';
import { registerCommandLogRoutes } from './routes/commandLog';
import { registerCommitRoutes } from './routes/commit';
import { registerDestructiveRoutes } from './routes/destructive';
import { registerDiffRoutes } from './routes/diff';
import { registerEventRoutes } from './routes/events';
import { registerFsRoutes } from './routes/fs';
import { registerGraphRoutes } from './routes/graph';
import { registerIntegrateRoutes } from './routes/integrate';
import { registerMergeToolRoutes } from './routes/mergeTool';
import { registerRemoteRoutes } from './routes/remote';
import { registerRepoRoutes } from './routes/repos';
import { registerStageRoutes } from './routes/stage';
import { registerStashRoutes } from './routes/stash';
import { registerSystemRoutes } from './routes/system';
import { registerUndoRoutes } from './routes/undo';
import { isAllowedHost, isAllowedOrigin, isApiRequest, isValidToken } from './security';
import { JsonStore } from './state/jsonStore';
import { RepoRegistry } from './state/registry';

/** No unsafe-eval. Inline styles stay allowed (React style props, Monaco). Monaco workers are same-origin or blob. */
const CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export async function buildApp(config: Config, opts: { tracker?: Pick<AutoExit, 'connect'>; drives?: string[] } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  setLogToken(config.token);

  // Anything a route throws: the message is scrubbed; a server-side failure never leaks text, only a generic 500.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const code = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(code).send({ error: code === 500 ? 'Internal server error.' : scrubSecrets(String(err.message)) });
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host, config.port)) {
      return reply.code(403).send({ error: 'Forbidden host.' });
    }
    if (!isAllowedOrigin(req.headers.origin, config.port)) {
      return reply.code(403).send({ error: 'Forbidden origin.' });
    }
    if (isApiRequest(req.url, req.routeOptions?.url) && !isValidToken(req.headers[TOKEN_HEADER.toLowerCase()], config.token)) {
      return reply.code(403).send({ error: 'Missing or invalid token.' });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (isApiRequest(req.url, req.routeOptions?.url)) reply.header('Cache-Control', 'no-store');
    else if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) reply.header('Content-Security-Policy', CSP);
    return payload;
  });

  const registry = new RepoRegistry();
  const recent = new JsonStore<RepoInfo[]>(config.dataDir, 'recent.json', () => []);
  const tabs = new JsonStore<TabsState>(config.dataDir, 'tabs.json', () => ({ tabs: [], activeId: null }));
  registerUndoRoutes(app, registry); // first: its redo-clearing hook must see every route after it
  registerRepoRoutes(app, registry, recent, tabs, config.repoRoots, config.pathMap);
  registerFsRoutes(
    app,
    createFsLister({
      mode: (config.repoRoots?.length ?? 0) > 0 ? 'roots' : 'native',
      roots: config.repoRoots ?? [],
      pathMap: config.pathMap,
      drives: opts.drives ?? ['C:'],
    }),
  );
  registerGraphRoutes(app, registry);
  registerDiffRoutes(app, registry);
  registerStageRoutes(app, registry);
  registerCommitRoutes(app, registry);
  registerBranchRoutes(app, registry);
  registerIntegrateRoutes(app, registry);
  registerMergeToolRoutes(app, registry);
  registerRemoteRoutes(app, registry, config.dataDir);
  registerStashRoutes(app, registry);
  registerDestructiveRoutes(app, registry);
  registerCommandLogRoutes(app, registry);
  const hub = createWatchHub(realWatchDeps(config.watch ?? 'events', { repoBusy, onSettled }));
  setSettleFingerprint((id) => hub.currentFingerprint(id));
  registerEventRoutes(app, registry, hub);
  app.addHook('onClose', async () => {
    hub.closeAll();
    setSettleFingerprint(undefined);
  });
  registerSystemRoutes(app, opts.tracker ?? { connect: () => () => undefined });

  if (existsSync(config.clientDist)) {
    await app.register(fastifyStatic, { root: config.clientDist });
  }
  return app;
}
