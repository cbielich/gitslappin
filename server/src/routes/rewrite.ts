import type { FastifyInstance, FastifyReply } from 'fastify';
import { rewordCommit, squashCommits, type RewriteResult } from '../git/rewrite';
import { cherryPickMulti, interactivePlan, interactiveRebase, type RebaseRun } from '../git/rebaseInteractive';
import { scrubSecrets } from '../git/scrub';
import type { RepoRegistry } from '../state/registry';

/*
 * V4 History rewriting (part A). done is 200 `{outcome, sha}`. blocked (an operation is stopped) and a stale / unsuitable repository
 * state are 409; a malformed request is 400; a git failure is 500. A refusal never changes the repository.
 */

const obj = (body: unknown): Record<string, unknown> | null => (typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null);

function answer(reply: FastifyReply, r: RewriteResult): FastifyReply {
  switch (r.outcome) {
    case 'done':
      return reply.send({ outcome: 'done', ...(r.sha ? { sha: r.sha } : {}) });
    case 'blocked':
      return reply.code(409).send({ error: r.error ?? 'Another operation is in progress.', opInProgress: true });
    case 'refused':
      return reply.code(r.stale ? 409 : 400).send({ error: scrubSecrets(r.error ?? 'Invalid request.') });
    default:
      return reply.code(500).send({ error: scrubSecrets(r.error ?? 'Request failed.'), ...(r.stderr !== undefined ? { stderr: scrubSecrets(r.stderr) } : {}) });
  }
}

/** Interactive rebase and multi cherry-pick: done / conflict are 200, a stale request or a stopped operation 409, a malformed one 400, a git failure 500. */
function answerRun(reply: FastifyReply, r: RebaseRun): FastifyReply {
  if (r.outcome === 'done' || r.outcome === 'conflict') return reply.send({ outcome: r.outcome, ...(r.stash ? { stash: r.stash } : {}) });
  const body = { error: scrubSecrets(r.error ?? 'Request failed.'), ...(r.stderr !== undefined ? { stderr: scrubSecrets(r.stderr) } : {}), ...(r.stash ? { stash: r.stash } : {}) };
  if (r.outcome === 'blocked') return reply.code(409).send({ ...body, opInProgress: true });
  return reply.code(r.bad ? (r.stale ? 409 : 400) : 500).send(body);
}

export function registerRewriteRoutes(app: FastifyInstance, registry: RepoRegistry, dataDir: string): void {
  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/reword', async (req, reply) => {
    const root = registry.rootOf(req.params.id);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const b = obj(req.body);
    if (!b || typeof b.sha !== 'string' || typeof b.expectHead !== 'string' || typeof b.message !== 'string') return reply.code(400).send({ error: 'Invalid request.' });
    return answer(reply, await rewordCommit(root, { sha: b.sha, expectHead: b.expectHead, message: b.message }));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/squash', async (req, reply) => {
    const root = registry.rootOf(req.params.id);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const b = obj(req.body);
    if (!b || !Array.isArray(b.shas) || b.shas.some((s) => typeof s !== 'string') || typeof b.expectHead !== 'string') return reply.code(400).send({ error: 'Invalid request.' });
    return answer(reply, await squashCommits(root, { shas: b.shas as string[], expectHead: b.expectHead }));
  });

  app.get<{ Params: { id: string }; Querystring: { mode?: string; target?: string } }>('/api/repos/:id/rebase/interactive/plan', async (req, reply) => {
    const root = registry.rootOf(req.params.id);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const plan = await interactivePlan(root, req.query.mode, req.query.target);
    return 'commits' in plan ? plan : answerRun(reply, plan);
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/rebase/interactive', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const root = registry.rootOf(req.params.id);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const b = obj(req.body);
    if (!b) return reply.code(400).send({ error: 'Invalid request.' });
    return answerRun(reply, await interactiveRebase(root, dataDir, { upstream: b.upstream, onto: b.onto, expectHead: b.expectHead, steps: b.steps }));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/cherry-pick/multi', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const root = registry.rootOf(req.params.id);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const b = obj(req.body);
    if (!b) return reply.code(400).send({ error: 'Invalid request.' });
    return answerRun(reply, await cherryPickMulti(root, dataDir, { shas: b.shas, expectHead: b.expectHead }));
  });
}
