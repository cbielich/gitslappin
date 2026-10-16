import type { FastifyInstance } from 'fastify';
import type { CloneRequest, CloneStreamLine, InitRequest } from '@gitslappin/shared';
import { GENERIC_PHASE, PROGRESS_PHASES, type cloneRepo } from '../git/clone';
import { initRepo, listTemplates } from '../git/init';
import { runExclusive } from '../git/queue';
import { scrubSecrets } from '../git/scrub';
import type { PathPair } from '../pathMap';
import type { OpenRepoAt } from './repos';

export interface RepoCreateDeps {
  roots: string[];
  pathMap: PathPair[];
  openRepoAt: OpenRepoAt;
  /** null = git is new enough to clone (audit fix 7). */
  cloneVersionProblem: () => Promise<string | null>;
  cloneImpl: typeof cloneRepo;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown): string | undefined | null => (v === undefined ? undefined : typeof v === 'string' ? v : null);

/** Body of POST clone -> CloneRequest, or the reason it is not one. Only fields of the right type get through. */
function readCloneBody(body: unknown): CloneRequest | string {
  if (!isObj(body)) return 'Invalid request.';
  if (typeof body.parent !== 'string' || body.parent.trim() === '') return 'Choose the folder to clone into.';
  if (typeof body.url !== 'string') return 'Enter the URL of the repository to clone.';
  const req: CloneRequest = { parent: body.parent, url: body.url };
  if (body.shallow !== undefined) {
    const s = body.shallow;
    if (!isObj(s) || (s.by !== 'depth' && s.by !== 'since')) return 'Invalid shallow clone settings.';
    const branch = optStr(s.branch);
    const since = optStr(s.since);
    const flags = optStr(s.flags);
    if (branch === null || since === null || flags === null || (s.depth !== undefined && typeof s.depth !== 'number')) return 'Invalid shallow clone settings.';
    req.shallow = { by: s.by, ...(typeof s.depth === 'number' ? { depth: s.depth } : {}), ...(since !== undefined ? { since } : {}), ...(branch !== undefined ? { branch } : {}), ...(flags !== undefined ? { flags } : {}) };
  }
  if (body.sparse !== undefined) {
    const sp = body.sparse;
    if (!isObj(sp) || !Array.isArray(sp.paths) || !sp.paths.every((p) => typeof p === 'string') || typeof sp.blobless !== 'boolean') return 'Invalid sparse checkout settings.';
    req.sparse = { paths: sp.paths as string[], blobless: sp.blobless };
  }
  return req;
}

function readInitBody(body: unknown): InitRequest | string {
  if (!isObj(body)) return 'Invalid request.';
  if (typeof body.parent !== 'string' || body.parent.trim() === '') return 'Choose the folder to create it in.';
  if (typeof body.name !== 'string') return 'Enter a name.';
  const defaultBranch = optStr(body.defaultBranch);
  const gitignore = optStr(body.gitignore);
  const license = optStr(body.license);
  if (defaultBranch === null || gitignore === null || license === null) return 'Invalid request.';
  return { parent: body.parent, name: body.name, ...(defaultBranch !== undefined ? { defaultBranch } : {}), ...(gitignore !== undefined ? { gitignore } : {}), ...(license !== undefined ? { license } : {}) };
}

/** Clone, init and the template list (V1). All behind the app-wide token hook. */
export function registerRepoCreateRoutes(app: FastifyInstance, deps: RepoCreateDeps): void {
  let cloning = false;

  app.get('/api/repos/templates', async () => listTemplates());

  app.post('/api/repos/init', async (req, reply) => {
    const body = readInitBody(req.body);
    if (typeof body === 'string') return reply.code(400).send({ error: body });
    const res = await runExclusive(`init:${body.parent}:${body.name}`, () => initRepo(body, { roots: deps.roots, pathMap: deps.pathMap }));
    if (res.type === 'refused') return reply.code(400).send({ error: scrubSecrets(res.error) });
    if (res.type === 'commit-failed') return reply.code(422).send({ error: scrubSecrets(res.error), stderr: res.stderr, path: res.path });
    const opened = await deps.openRepoAt(res.path);
    if ('error' in opened) return reply.code(opened.status).send({ error: opened.error });
    return opened.info;
  });

  app.post('/api/repos/clone', async (req, reply) => {
    const body = readCloneBody(req.body);
    if (typeof body === 'string') return reply.code(400).send({ error: body });
    if (cloning) return reply.code(409).send({ error: 'A clone is already running. Wait for it to finish or cancel it.' });
    cloning = true;

    const res = reply.raw;
    const ac = new AbortController();
    let started = false;
    let finished = false;
    // The client pressed Cancel (the fetch was aborted) or went away: stop git.
    res.once('close', () => {
      if (!finished) ac.abort();
    });
    if (res.destroyed) ac.abort();
    const send = (line: CloneStreamLine): void => {
      if (!started) {
        started = true;
        reply.hijack(); // hooks do not run for a hijacked reply, so the headers are set here
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        res.flushHeaders();
      }
      if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(line)}\n`);
    };
    const fail = (error: string, stderr = ''): void => {
      try {
        send({ type: 'error', error: scrubSecrets(error), stderr: scrubSecrets(stderr) });
      } catch {
        // dead socket: nothing left to tell
      }
    };
    try {
      const versionProblem = await deps.cloneVersionProblem();
      if (versionProblem) {
        finished = true;
        return reply.code(400).send({ error: scrubSecrets(versionProblem) });
      }
      const key = `clone:${body.parent}:${body.url}`;
      const result = await runExclusive(key, () =>
        deps.cloneImpl(body, {
          roots: deps.roots,
          pathMap: deps.pathMap,
          signal: ac.signal,
          onProgress: (p) => {
            const phase = PROGRESS_PHASES.includes(p.phase) ? p.phase : GENERIC_PHASE;
            const percent = Number.isFinite(p.percent) ? Math.max(0, Math.min(100, Math.round(p.percent))) : 0;
            send({ type: 'progress', phase, percent });
          },
        }),
      );
      if (result.type === 'refused' && !started) {
        finished = true;
        return reply.code(400).send({ error: scrubSecrets(result.error) });
      }
      if (result.type === 'refused') fail(result.error);
      else if (result.type === 'error') fail(result.error, result.stderr);
      else if (result.type === 'cancelled') send({ type: 'cancelled', path: result.path });
      else {
        const opened = await deps.openRepoAt(result.path);
        if ('error' in opened) fail(opened.error);
        else send({ type: 'done', repo: opened.info });
      }
    } catch {
      if (!started) {
        finished = true;
        return reply.code(500).send({ error: 'Internal server error.' });
      }
      fail('The clone failed unexpectedly.');
    } finally {
      cloning = false;
    }
    finished = true;
    if (!res.destroyed && !res.writableEnded) res.end();
    return reply;
  });
}
