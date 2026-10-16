import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { RepoInfo, TabsState } from '@gitslappin/shared';
import { TOKEN_HEADER } from '@gitslappin/shared';
import type { AutoExit } from './alive';
import type { Config } from './config';
import { createFsLister } from './fsList';
import { writeAskpass } from './git/askpass';
import { cloneRepo } from './git/clone';
import { setLogToken } from './git/commandLog';
import { onSettled, repoBusy, setSettleFingerprint } from './git/queue';
import { scrubSecrets } from './git/scrub';
import { cloneGitProblem } from './git/version';
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
import { isDesktop, registerOpenRoutes, type OpenSpawn } from './routes/open';
import { checkTerminalUpgrade, isTerminalUpgrade, registerTerminalRoutes } from './routes/terminal';
import { createRealTerminalHub, killOnExit } from './terminal/real';
import type { TerminalHub } from './terminal/hub';
import { registerRemoteRoutes } from './routes/remote';
import { registerRepoCreateRoutes } from './routes/repoCreate';
import { registerRepoRoutes } from './routes/repos';
import { registerIgnoreRoutes } from './routes/ignore';
import { registerRewriteRoutes } from './routes/rewrite';
import { registerStageRoutes } from './routes/stage';
import { registerViewingRoutes } from './routes/viewing';
import { registerVisibilityRoutes } from './routes/visibility';
import { VisibilityStore } from './visibility';
import { registerStashRoutes } from './routes/stash';
import { registerTagOpsRoutes } from './routes/tagOps';
import { registerSystemRoutes } from './routes/system';
import { registerUndoRoutes } from './routes/undo';
import { isAllowedHost, isAllowedOrigin, isApiRequest, isValidToken } from './security';
import { JsonStore } from './state/jsonStore';
import { RepoRegistry } from './state/registry';

/** No unsafe-eval. Inline styles stay allowed (React style props, Monaco). Monaco workers are same-origin or blob. */
const CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export async function buildApp(
  config: Config,
  opts: { tracker?: Pick<AutoExit, 'connect'>; drives?: string[]; cloneVersionProblem?: () => Promise<string | null>; cloneImpl?: typeof cloneRepo; openSpawn?: OpenSpawn; openPlatform?: NodeJS.Platform; terminalHub?: TerminalHub } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  setLogToken(config.token);

  // Anything a route throws: the message is scrubbed; a server-side failure never leaks text, only a generic 500.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const code = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(code).send({ error: code === 500 ? 'Internal server error.' : scrubSecrets(String(err.message)) });
  });

  const registry = new RepoRegistry();
  const terminalHub = opts.terminalHub ?? createRealTerminalHub(config, registry);

  app.addHook('onRequest', async (req, reply) => {
    // The terminal upgrade is the one request without the token header: its ticket (single use) replaces it (V6b audit 1).
    if (isTerminalUpgrade(req)) {
      const r = checkTerminalUpgrade(terminalHub, req);
      if (!r.ok) {
        reply.raw.once('finish', () => req.raw.socket?.destroy()); // the plugin's own cleanup hook never runs for a refused upgrade
        return reply.code(r.status).send({ error: r.status === 409 ? 'Not available on this server.' : 'Forbidden.' });
      }
      return;
    }
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

  const recent = new JsonStore<RepoInfo[]>(config.dataDir, 'recent.json', () => []);
  const tabs = new JsonStore<TabsState>(config.dataDir, 'tabs.json', () => ({ tabs: [], activeId: null }));
  registerUndoRoutes(app, registry); // first: its redo-clearing hook must see every route after it
  const openRepoAt = registerRepoRoutes(app, registry, recent, tabs, config.repoRoots, config.pathMap);
  registerRepoCreateRoutes(app, {
    roots: config.repoRoots ?? [],
    pathMap: config.pathMap,
    openRepoAt,
    cloneVersionProblem: opts.cloneVersionProblem ?? (() => cloneGitProblem()),
    cloneImpl: opts.cloneImpl ?? cloneRepo,
  });
  registerFsRoutes(
    app,
    createFsLister({
      mode: (config.repoRoots?.length ?? 0) > 0 ? 'roots' : 'native',
      roots: config.repoRoots ?? [],
      pathMap: config.pathMap,
      drives: opts.drives ?? ['C:'],
    }),
  );
  const visibility = new VisibilityStore(config.dataDir);
  registerGraphRoutes(app, registry, visibility);
  registerVisibilityRoutes(app, registry, visibility);
  registerDiffRoutes(app, registry);
  registerViewingRoutes(app, registry);
  registerStageRoutes(app, registry);
  registerCommitRoutes(app, registry);
  registerBranchRoutes(app, registry);
  registerIntegrateRoutes(app, registry);
  registerMergeToolRoutes(app, registry);
  // The failing credential helper for auto-fetch, rewritten with fixed content on every start.
  registerRemoteRoutes(app, registry, config.dataDir, { askpass: writeAskpass(config.dataDir), roots: config.repoRoots ?? [], pathMap: config.pathMap });
  registerTagOpsRoutes(app, registry);
  registerStashRoutes(app, registry);
  registerDestructiveRoutes(app, registry);
  registerIgnoreRoutes(app, registry);
  registerRewriteRoutes(app, registry, config.dataDir);
  registerCommandLogRoutes(app, registry);
  const hub = createWatchHub(realWatchDeps(config.watch ?? 'events', { repoBusy, onSettled }));
  setSettleFingerprint((id) => hub.currentFingerprint(id));
  registerEventRoutes(app, registry, hub);
  app.addHook('onClose', async () => {
    hub.closeAll();
    setSettleFingerprint(undefined);
  });
  await registerTerminalRoutes(app, terminalHub);
  const stopKillOnExit = killOnExit(terminalHub);
  app.addHook('onClose', async () => {
    stopKillOnExit();
    terminalHub.killAll();
  });
  const openPlatform = opts.openPlatform ?? process.platform;
  registerOpenRoutes(app, registry, { bind: config.bind, platform: openPlatform, spawn: opts.openSpawn ?? (spawn as OpenSpawn) });
  registerSystemRoutes(app, opts.tracker ?? { connect: () => () => undefined }, () => isDesktop(config.bind, openPlatform), () => ({ terminal: terminalHub.available(), terminalBash: terminalHub.bashAvailable() }));

  if (existsSync(config.clientDist)) {
    await app.register(fastifyStatic, { root: config.clientDist });
  }
  return app;
}
