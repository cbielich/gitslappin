import type { FastifyInstance } from 'fastify';
import { runExclusive } from '../git/queue';
import { readOpState } from '../git/opState';
import { runGit } from '../git/runner';
import { clearRedo, record } from '../git/undo';
import { commitArgs } from '../git/stageCommands';
import type { RepoRegistry } from '../state/registry';

const MAX_MESSAGE_BYTES = 1024 * 1024;
const COMMIT_TIMEOUT_MS = 5 * 60 * 1000;

async function headState(root: string, repoId: string): Promise<{ sha: string | null; branch: string | null }> {
  const [sha, sym] = await Promise.all([
    runGit(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root, repoId }),
    runGit(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, repoId }),
  ]);
  return { sha: sha.code === 0 ? sha.stdout.trim() : null, branch: sym.code === 0 ? sym.stdout.trim() : null };
}

export function registerCommitRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  /** The HEAD commit's message, for the Amend checkbox. */
  app.get<{ Params: { id: string } }>('/api/repos/:id/head-message', async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const res = await runGit(['log', '-1', '--format=%B', '--end-of-options', 'HEAD'], { cwd: root, repoId });
    if (res.code !== 0) return reply.code(404).send({ error: 'There is no commit to amend.' });
    return { message: res.stdout.replace(/\s+$/, '') };
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/commit', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply.code(400).send({ error: 'Invalid request.' });
    const { message, amend } = body as Record<string, unknown>;
    if (typeof message !== 'string' || typeof amend !== 'boolean') return reply.code(400).send({ error: 'Invalid request.' });
    if (message.trim() === '') return reply.code(400).send({ error: 'The commit message is empty.' });
    if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) return reply.code(413).send({ error: 'The commit message is too large.' });

    // Hooks run (this is a normal commit). The message goes in on stdin, never on the command line.
    const res = await runExclusive(repoId, async () => {
      // Phase 6: no commit while a rebase is stopped (continue it instead); a merge commit strips the "#" lines.
      const op = await readOpState(root);
      if (op?.kind === 'rebase') return null;
      const before = await headState(root, repoId);
      // A concluding cherry-pick or revert strips the "#" lines too (git's own prepared message has them).
      const strip = op?.kind === 'merge' || op?.kind === 'cherry-pick' || op?.kind === 'revert';
      const done = await runGit(commitArgs(amend, op?.kind === 'merge', strip), { cwd: root, repoId, input: message, timeoutMs: COMMIT_TIMEOUT_MS });
      if (done.code === 0) {
        // Phase 10: recorded inside the lock. A commit that concludes a merge, cherry-pick or revert is not undoable here.
        // One call: the new HEAD, its parents and its subject. It is only recorded if it really is the commit made above.
        const info = await runGit(['log', '-1', '--format=%H%x00%P%x00%s', '--end-of-options', 'HEAD'], { cwd: root, repoId });
        const [sha = '', parents = '', subject = ''] = info.code === 0 ? info.stdout.replace(/\n$/, '').split('\0') : [];
        const parentOk = amend || (before.sha === null ? parents === '' : parents === before.sha);
        if (op !== undefined || !/^[0-9a-f]{40,64}$/.test(sha) || sha === before.sha || !parentOk) clearRedo(root);
        else {
          record(root, {
            kind: 'commit',
            sha,
            prev: before.sha,
            branch: before.branch,
            subject: subject.trim() || message.trim().split('\n')[0]!,
            ...(amend ? { amend: true } : {}),
          });
        }
      }
      return done;
    });
    if (res === null) return reply.code(409).send({ error: 'A rebase is in progress.' });
    if (res.code !== 0) {
      const text = `${res.stderr}${res.stdout}`.trim();
      return reply.code(500).send({ error: text.split('\n')[0] || 'git commit failed.', stderr: text || `git exited with code ${res.code}.` });
    }
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: root, repoId });
    return { sha: head.stdout.trim() };
  });
}
