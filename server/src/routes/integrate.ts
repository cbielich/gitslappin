import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IntegrateResponse } from '@gitslappin/shared';
import { mergeAbort, mergeBranch, rebaseAbort, rebaseContinue, rebaseOnto, rebaseSkip, type IntegrateResult } from '../git/integrate';
import { readOpState } from '../git/opState';
import { runGit } from '../git/runner';
import type { RepoRegistry } from '../state/registry';

const obj = (body: unknown): Record<string, unknown> | null => (typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null);

/** done / conflict are 200 (a conflict is not an error), blocked is 409, a bad request 400, a git failure 500. */
function send(reply: FastifyReply, r: IntegrateResult) {
  if (r.outcome === 'done' || r.outcome === 'conflict') return reply.send({ outcome: r.outcome, ...(r.stash ? { stash: r.stash } : {}) } satisfies IntegrateResponse);
  const body = { error: r.error ?? 'Request failed.', ...(r.stderr !== undefined ? { stderr: r.stderr } : {}), ...(r.stash ? { stash: r.stash } : {}) };
  return reply.code(r.outcome === 'blocked' ? 409 : r.bad ? 400 : 500).send(body);
}

export function registerIntegrateRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  const rootOf = (id: string, reply: FastifyReply): string | null => {
    const root = registry.rootOf(id);
    if (!root) void reply.code(404).send({ error: 'Unknown repository.' });
    return root ?? null;
  };

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/merge', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body || typeof body.name !== 'string' || (body.ffOnly !== undefined && typeof body.ffOnly !== 'boolean')) return reply.code(400).send({ error: 'Invalid request.' });
    return send(reply, await mergeBranch(root, body.name, { ffOnly: body.ffOnly === true }));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/rebase', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    const onto = body && (typeof body.name === 'string' ? body.name : typeof body.sha === 'string' ? body.sha : null);
    if (!body || onto === null || (body.name !== undefined && body.sha !== undefined)) return reply.code(400).send({ error: 'Invalid request.' });
    return send(reply, await rebaseOnto(root, onto));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/rebase/continue', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body) ?? {};
    if (body.message !== undefined && typeof body.message !== 'string') return reply.code(400).send({ error: 'Invalid request.' });
    if (body.step !== undefined && (typeof body.step !== 'number' || !Number.isInteger(body.step) || body.step < 1)) return reply.code(400).send({ error: 'Invalid request.' });
    return send(reply, await rebaseContinue(root, { ...(body.message === undefined ? {} : { message: body.message }), ...(body.step === undefined ? {} : { step: body.step }) }));
  });

  app.post<{ Params: { id: string } }>('/api/repos/:id/rebase/skip', async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    return root ? send(reply, await rebaseSkip(root)) : reply;
  });
  app.post<{ Params: { id: string } }>('/api/repos/:id/rebase/abort', async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    return root ? send(reply, await rebaseAbort(root)) : reply;
  });
  app.post<{ Params: { id: string } }>('/api/repos/:id/merge/abort', async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    return root ? send(reply, await mergeAbort(root)) : reply;
  });

  /** For the menu: is HEAD an ancestor of this branch (and not the same commit), so Fast-forward applies? */
  app.get<{ Params: { id: string }; Querystring: { name?: string } }>('/api/repos/:id/can-fast-forward', async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const name = req.query.name;
    if (typeof name !== 'string' || name === '' || name.startsWith('-') || name.includes('\0')) return reply.code(400).send({ error: 'Invalid request.' });
    const repoId = req.params.id;
    if (await readOpState(root)) return { canFastForward: false };
    const refs = await runGit(['for-each-ref', '--format=%(refname)%1f%(objectname)', 'refs/heads', 'refs/remotes'], { cwd: root, repoId });
    let sha: string | undefined;
    for (const line of refs.stdout.split('\n')) {
      const [ref, obj1] = line.split('\x1f');
      if (ref === `refs/heads/${name}` || (ref === `refs/remotes/${name}` && !name.endsWith('/HEAD'))) sha = obj1;
    }
    if (!sha) return reply.code(400).send({ error: 'That is not an existing branch.' });
    const head = await runGit(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root, repoId });
    if (head.code !== 0 || head.stdout.trim() === sha) return { canFastForward: false };
    const anc = await runGit(['merge-base', '--is-ancestor', head.stdout.trim(), sha], { cwd: root, repoId });
    return { canFastForward: anc.code === 0 };
  });
}
