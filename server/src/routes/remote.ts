import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RemoteResponse } from '@gitslappin/shared';
import { fetchAll, listRemotes, pullRemote, pushRemote, setUpstream, type RemoteResult } from '../git/remote';
import { scrubSecrets } from '../git/scrub';
import { readPrefs, updatePrefs } from '../prefs';
import type { RepoRegistry } from '../state/registry';

const obj = (body: unknown): Record<string, unknown> | null => (typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null);
const optString = (v: unknown): boolean => v === undefined || typeof v === 'string';

/**
 * done / conflict are 200 (a conflict is not an error). A push refused as non-fast-forward is 409 with `rejected` and
 * `expect`. No upstream is 409 `needsUpstream`. Blocked is 409 (`opInProgress` or `detached`). Refused input and no remote
 * are 400. A git failure is 500. Every text is scrubbed.
 */
function send(reply: FastifyReply, r: RemoteResult) {
  switch (r.outcome) {
    case 'done':
      return reply.send({ outcome: 'done' } satisfies RemoteResponse);
    case 'conflict':
      return reply.send({ outcome: 'conflict', ...(r.op ? { op: r.op } : {}) });
    case 'needs-upstream':
      return reply.code(409).send({ error: 'No upstream is set.', needsUpstream: true, remotes: r.remotes ?? [] });
    case 'rejected':
      return reply.code(409).send({ error: scrubSecrets(r.error ?? 'Push rejected.'), stderr: scrubSecrets(r.stderr ?? ''), rejected: 'non-ff', ...(r.target ? { target: r.target } : {}), ...(r.expect ? { expect: r.expect } : {}), ...(r.fetchFirst ? { fetchFirst: true } : {}) });
    case 'blocked':
      return reply.code(409).send({ error: r.error ?? 'Another operation is in progress.', ...(r.blockedBy === 'detached' ? { detached: true } : { opInProgress: true }) });
    case 'no-remote':
      return reply.code(400).send({ error: r.error ?? 'There are no remotes.', noRemote: true });
    case 'refused':
      return reply.code(400).send({ error: scrubSecrets(r.error ?? 'Invalid request.') });
    default:
      return reply.code(500).send({ error: scrubSecrets(r.error ?? 'Request failed.'), ...(r.stderr !== undefined ? { stderr: scrubSecrets(r.stderr) } : {}) });
  }
}

export function registerRemoteRoutes(app: FastifyInstance, registry: RepoRegistry, dataDir: string): void {
  const rootOf = (id: string, reply: FastifyReply): string | null => {
    const root = registry.rootOf(id);
    if (!root) void reply.code(404).send({ error: 'Unknown repository.' });
    return root ?? null;
  };
  const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'Invalid request.' });

  app.get<{ Params: { id: string } }>('/api/repos/:id/remotes', async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    return root ? await listRemotes(root) : reply;
  });

  app.post<{ Params: { id: string } }>('/api/repos/:id/fetch', async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    return root ? send(reply, await fetchAll(root)) : reply;
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/pull', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body || typeof body.mode !== 'string' || !optString(body.branch)) return invalid(reply);
    return send(reply, await pullRemote(root, { mode: body.mode as 'merge', ...(typeof body.branch === 'string' ? { branch: body.branch } : {}) }));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/push', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body) ?? {};
    if (!optString(body.branch) || !optString(body.remote) || !optString(body.remoteBranch)) return invalid(reply);
    return send(
      reply,
      await pushRemote(root, {
        ...(typeof body.branch === 'string' ? { branch: body.branch } : {}),
        ...(typeof body.remote === 'string' ? { remote: body.remote } : {}),
        ...(typeof body.remoteBranch === 'string' ? { remoteBranch: body.remoteBranch } : {}),
      }),
    );
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/upstream', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const root = rootOf(req.params.id, reply);
    if (!root) return reply;
    const body = obj(req.body);
    if (!body || typeof body.branch !== 'string' || typeof body.remote !== 'string' || typeof body.remoteBranch !== 'string') return invalid(reply);
    return send(reply, await setUpstream(root, { branch: body.branch, remote: body.remote, remoteBranch: body.remoteBranch }));
  });

  app.get('/api/prefs', async () => readPrefs(dataDir));
  app.put<{ Body: unknown }>('/api/prefs', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const res = updatePrefs(dataDir, req.body);
    return res.ok ? res.prefs : reply.code(400).send({ error: res.error });
  });
}
