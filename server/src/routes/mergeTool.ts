import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { MergeSideInfo, MergeToolBackup, MergeToolInfo } from '@gitslappin/shared';
import { readBlobBytes, unmergedStages, type UnmergedEntry } from '../git/blobs';
import { readOpState } from '../git/opState';
import { runExclusive } from '../git/queue';
import { runGit } from '../git/runner';
import { UnsafePathError, safeRepoPath } from '../git/safeRepoPath';
import { stagePathsArgs } from '../git/stageCommands';
import { BOM, HASH_RE, HttpError, assertParentInside, backup, decode, hasBom, isBinary, isObject, majorityEol, readWorking as readWorkingFile, renameWithRetry, resolveBom, sha256, tempDirFor } from '../git/workingFile';
import type { RepoRegistry } from '../state/registry';

const MAX_SIDE_BYTES = 5 * 1024 * 1024;
const MAX_WORKING_BYTES = 64 * 1024 * 1024;
const EXTERNAL_TIMEOUT_MS = 30 * 60 * 1000;

/** Paths whose external merge tool is running: save and take answer 409 for them (the repo itself is not locked). */
const externalBusy = new Set<string>();
const busyKey = (repoId: string, path: string): string => `${repoId}\0${path}`;

export function registerMergeToolRoutes(app: FastifyInstance, registry: RepoRegistry): void {
  function fail(reply: FastifyReply, e: unknown) {
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message, ...(e.stderr !== undefined ? { stderr: e.stderr } : {}) });
    if (e instanceof UnsafePathError) return reply.code(400).send({ error: e.message });
    return reply.code(500).send({ error: e instanceof Error ? e.message : 'Request failed.' });
  }

  /** Path rules, then "still unmerged" and "a regular file entry" (symlinks and gitlinks never take text). */
  async function checkConflicted(root: string, repoId: string, path: unknown): Promise<{ path: string; abs: string; stages: UnmergedEntry[] }> {
    if (typeof path !== 'string') throw new HttpError(400, 'Missing path.');
    const abs = safeRepoPath(root, path);
    const stages = await unmergedStages(root, repoId, path);
    if (stages.length === 0) throw new HttpError(409, 'The file is not in conflict.');
    if (stages.some((s) => s.mode !== '100644' && s.mode !== '100755')) throw new HttpError(400, 'Only regular files can be merged here.');
    return { path, abs, stages };
  }

  const readWorking = (root: string, abs: string): Promise<Buffer | null> => readWorkingFile(root, abs, MAX_WORKING_BYTES);

  async function readStage(root: string, repoId: string, stages: UnmergedEntry[], n: 1 | 2 | 3): Promise<Buffer | null> {
    const e = stages.find((s) => s.stage === n);
    if (!e) return null;
    const b = await readBlobBytes(root, repoId, e.oid, MAX_SIDE_BYTES);
    if (b === 'too-large') throw new HttpError(413, 'The file is too large to merge here.');
    return b;
  }

  async function mergeToolConfigured(root: string, repoId: string): Promise<boolean> {
    const r = await runGit(['config', '--get', 'merge.tool'], { cwd: root, repoId });
    return r.code === 0 && r.stdout.trim() !== '';
  }

  async function shaOf(root: string, repoId: string, rev: string): Promise<string> {
    const r = await runGit(['rev-parse', '--verify', '-q', '--end-of-options', `${rev}^{commit}`], { cwd: root, repoId });
    return r.code === 0 ? r.stdout.trim().slice(0, 7) : '';
  }

  async function stateFileSha(root: string, repoId: string, name: string): Promise<string> {
    const p = await runGit(['rev-parse', '--git-path', name], { cwd: root, repoId });
    if (p.code !== 0) return '';
    try {
      const text = (await readFile(resolvePath(root, p.stdout.trim()), 'utf8')).trim();
      return /^[0-9a-f]{40,64}$/.test(text) ? text.slice(0, 7) : '';
    } catch {
      return '';
    }
  }

  async function headerInfo(root: string, repoId: string): Promise<{ aInfo: MergeSideInfo; bInfo: MergeSideInfo }> {
    const op = await readOpState(root);
    const info = (sha: string, branch?: string): MergeSideInfo => ({ sha, ...(branch ? { branch } : {}) });
    if (op?.kind === 'rebase') {
      const onto = (await stateFileSha(root, repoId, 'rebase-merge/onto')) || (await stateFileSha(root, repoId, 'rebase-apply/onto'));
      return { aInfo: info(onto, op.onto), bInfo: info(await shaOf(root, repoId, 'REBASE_HEAD'), op.head) };
    }
    const head = await shaOf(root, repoId, 'HEAD');
    if (op?.kind === 'stash') return { aInfo: info(head, op.head), bInfo: { sha: '', stash: true } };
    if (op?.kind === 'merge') return { aInfo: info(head, op.head), bInfo: info(await shaOf(root, repoId, 'MERGE_HEAD'), op.other) };
    if (op?.kind === 'cherry-pick' || op?.kind === 'revert') {
      return { aInfo: info(head, op.head), bInfo: info(await shaOf(root, repoId, op.kind === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD')) };
    }
    return { aInfo: info(head), bInfo: info('') };
  }

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/repos/:id/merge-tool', async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      const { abs, stages } = await checkConflicted(root, repoId, req.query.path);
      const [base, a, b] = [await readStage(root, repoId, stages, 1), await readStage(root, repoId, stages, 2), await readStage(root, repoId, stages, 3)];
      const working = await readWorking(root, abs);
      const binary = [base, a, b].some((x) => x !== null && isBinary(x));
      const text = (x: Buffer | null): string | null => (x === null ? null : binary ? '' : decode(x));
      const aText = text(a);
      const eolSource = working && !isBinary(working) ? decode(working) : (aText ?? '');
      const info: MergeToolInfo = {
        binary,
        bom: resolveBom(working ? hasBom(working) : null, a ? hasBom(a) : null, b ? hasBom(b) : null),
        eol: majorityEol(eolSource),
        base: text(base),
        a: aText,
        b: text(b),
        ...(await headerInfo(root, repoId)),
        external: stages.length === 3 && (await mergeToolConfigured(root, repoId)),
        workingHash: working ? sha256(working) : 'missing',
      };
      return info;
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** expectHash: required, 64 hex characters or "missing". */
  function readExpectHash(v: unknown): string {
    if (v === undefined || v === null) throw new HttpError(409, 'The file may have changed. Open it again.');
    if (typeof v !== 'string' || !(v === 'missing' || HASH_RE.test(v))) throw new HttpError(400, 'Invalid request.');
    return v;
  }

  /**
   * Writes `bytes` over the file (temp file in the same directory, then rename; `wx` when it does not exist) and stages it.
   * Everything runs in one runExclusive. The backup of the old bytes is made first.
   */
  async function writeAndStage(root: string, repoId: string, abs: string, path: string, expectHash: string, getBytes: () => Promise<Buffer>, check: () => Promise<void>): Promise<MergeToolBackup> {
    return runExclusive(repoId, async () => {
      if (externalBusy.has(busyKey(repoId, path))) throw new HttpError(409, 'An external merge tool is running for this file.');
      await check(); // still unmerged, still a regular entry
      const bytes = await getBytes();
      const working = await readWorking(root, abs);
      if ((working ? sha256(working) : 'missing') !== expectHash) throw new HttpError(409, 'The file changed on disk since it was opened. Open it again.');
      const kept = await backup(root, repoId, working);

      if (working === null) {
        // The file is missing: its real parent must be inside the real root before anything is created there.
        await assertParentInside(root, abs);
        try {
          await writeFile(abs, bytes, { flag: 'wx' });
        } catch {
          throw new HttpError(409, 'The file changed on disk since it was opened. Open it again.');
        }
      } else {
        const st = await lstat(abs);
        if (!st.isFile()) throw new HttpError(400, 'Only regular files can be merged here.');
        const tmp = join(await tempDirFor(root, repoId, abs), `.gitslappin-merge-${randomBytes(6).toString('hex')}.tmp`);
        const fh = await open(tmp, 'wx', st.mode & 0o777);
        try {
          await fh.chmod(st.mode & 0o777);
          await fh.writeFile(bytes);
        } finally {
          await fh.close();
        }
        try {
          // Right before the rename: still the same regular file with the same bytes.
          const again = await readWorking(root, abs);
          if (again === null || sha256(again) !== expectHash) throw new HttpError(409, 'The file changed on disk since it was opened. Open it again.');
          await renameWithRetry(tmp, abs);
        } catch (e) {
          // The temp file is ours and was never renamed: it is overwritten with nothing and left for the user to see rather than deleted.
          await writeFile(tmp, '').catch(() => undefined);
          throw e;
        }
      }
      // The real parent must still be inside the real root and the file must be where we meant it.
      const realRoot = await realpath(root);
      const realParent = await realpath(dirname(abs));
      const expected = join(realParent, basename(abs));
      const real = await realpath(abs);
      if (!(realParent + sep).startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep) || real !== expected) throw new HttpError(500, 'The file ended up outside the repository.');

      const added = await runGit(stagePathsArgs(), { cwd: root, repoId, input: Buffer.from(path, 'utf8') });
      if (added.code !== 0) throw new HttpError(500, (added.stderr.trim().split('\n')[0] ?? '') || 'git add failed.', added.stderr);
      return { backup: kept ?? '' };
    });
  }

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/merge-tool/save', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      if (!isObject(req.body)) throw new HttpError(400, 'Invalid request.');
      const { path, text } = req.body;
      const { abs } = await checkConflicted(root, repoId, path);
      const p = path as string;
      if (typeof text !== 'string' || text.includes('\0') || !(text as string & { isWellFormed(): boolean }).isWellFormed()) throw new HttpError(400, 'The text is not valid.');
      if (Buffer.byteLength(text, 'utf8') > MAX_SIDE_BYTES) throw new HttpError(413, 'The text is too large.');
      const expectHash = readExpectHash(req.body.expectHash);
      if (externalBusy.has(busyKey(repoId, p))) throw new HttpError(409, 'An external merge tool is running for this file.');

      const stages = await unmergedStages(root, repoId, p);
      const [base, a, b] = [await readStage(root, repoId, stages, 1), await readStage(root, repoId, stages, 2), await readStage(root, repoId, stages, 3)];
      // A file that is take-only (binary, not UTF-8, or with a lone CR) is never written from text.
      if ([base, a, b].some((x) => x !== null && isBinary(x))) throw new HttpError(400, 'This file can only be taken from one side.');
      const working = await readWorking(root, abs);
      const bom = resolveBom(working ? hasBom(working) : null, a ? hasBom(a) : null, b ? hasBom(b) : null);
      const body = Buffer.from(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, 'utf8');
      const bytes = bom ? Buffer.concat([BOM, body]) : body;
      return await writeAndStage(root, repoId, abs, p, expectHash, async () => bytes, async () => void (await checkConflicted(root, repoId, p)));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/merge-tool/take', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      if (!isObject(req.body)) throw new HttpError(400, 'Invalid request.');
      const { path, side } = req.body;
      const { abs, stages } = await checkConflicted(root, repoId, path);
      const p = path as string;
      if (side !== 'a' && side !== 'b') throw new HttpError(400, 'Invalid side.');
      const expectHash = readExpectHash(req.body.expectHash);
      if (externalBusy.has(busyKey(repoId, p))) throw new HttpError(409, 'An external merge tool is running for this file.');
      // Take is for binary files only; a text file goes through the editor and Save.
      const blobs = await Promise.all(([1, 2, 3] as const).map((n) => readStage(root, repoId, stages, n)));
      if (!blobs.some((x) => x !== null && isBinary(x))) throw new HttpError(400, 'Take is only for binary files.');
      // A side that does not exist (deleted there) is never taken: the file is not removed from here.
      if (!stages.some((s) => s.stage === (side === 'a' ? 2 : 3))) throw new HttpError(409, 'That side has no file.');
      const stage = side === 'a' ? 2 : 3;
      return await writeAndStage(
        root,
        repoId,
        abs,
        p,
        expectHash,
        async () => {
          const entry = (await unmergedStages(root, repoId, p)).find((e) => e.stage === stage);
          if (!entry) throw new HttpError(409, 'That side has no file.');
          const blob = await readBlobBytes(root, repoId, entry.oid, MAX_SIDE_BYTES * 10);
          if (blob === null || blob === 'too-large') throw new HttpError(blob === null ? 409 : 413, 'The file could not be read.');
          return blob;
        },
        async () => void (await checkConflicted(root, repoId, p)),
      );
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/merge-tool/external', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      if (!isObject(req.body)) throw new HttpError(400, 'Invalid request.');
      const { abs, stages, path } = await checkConflicted(root, repoId, req.body.path);
      if (stages.length !== 3) throw new HttpError(409, 'The external merge tool needs all three versions of the file.');
      if (!(await mergeToolConfigured(root, repoId))) throw new HttpError(409, 'There is no merge tool configured in your settings'); // ErrorMessage-NoMergeToolSet
      const key = busyKey(repoId, path);
      if (externalBusy.has(key)) throw new HttpError(409, 'An external merge tool is already running for this file.');
      // The backup is taken under the repo lock, and the busy flag is set in the same step, so a save cannot slip in between.
      const kept = await runExclusive(repoId, async () => {
        if (externalBusy.has(key)) throw new HttpError(409, 'An external merge tool is already running for this file.');
        const k = await backup(root, repoId, await readWorking(root, abs));
        externalBusy.add(key);
        return k;
      });
      try {
        // No tool, -c or --tool parameter: only the user's own git config decides. Literal pathspecs, no prompt, no stdin.
        const res = await runGit(['--literal-pathspecs', 'mergetool', '--no-prompt', '--', path], { cwd: root, repoId, input: '', timeoutMs: EXTERNAL_TIMEOUT_MS });
        if (res.code !== 0) {
          const text = `${res.stderr}${res.stdout}`.trim();
          throw new HttpError(500, text.split('\n')[0] || 'The merge tool failed.', text || `git exited with code ${res.code}.`);
        }
        return { backup: kept ?? '' } satisfies MergeToolBackup;
      } finally {
        externalBusy.delete(key);
      }
    } catch (e) {
      return fail(reply, e);
    }
  });
}
