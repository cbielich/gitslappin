import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FileActionResult, FileEditInfo } from '@gitslappin/shared';
import { recordCommand } from '../git/commandLog';
import { readOpState } from '../git/opState';
import { runExclusive } from '../git/queue';
import { runGit } from '../git/runner';
import { UnsafePathError, safeRepoPath } from '../git/safeRepoPath';
import { captureFile, hashBytes, inspectParents, pin, preState, stateOf, writeTree, type PinnedFile } from '../git/snapshot';
import { clearRedo, record } from '../git/undo';
import { BOM, HASH_RE, HttpError, decode, hasBom, isBinary, isObject, majorityEol, readWorking, renameWithRetry, sha256, tempDirFor } from '../git/workingFile';
import type { RepoRegistry } from '../state/registry';

/*
 * Commit file menu and in-app editor (spec "Commit File Menu and Editor" S1-S4): read a tracked file for editing, save it, restore it from a
 * commit, move it to the trash. Every change pins the old bytes first and fails closed (nothing changes when a pin fails), runs inside the
 * repo lock, never stages a save, and never unlinks anything: a delete is a rename into <gitdir>/gitslappin-trash. Every answer is one of our own
 * texts: an unexpected error is a generic 500 (no exception text, no git output, no path).
 */

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
/** Same cap as snapshot.ts (captureFile refuses bigger files). */
const DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const SHA = /^[0-9a-f]{40,64}$/;
const REGULAR_MODES = new Set(['100644', '100755']);
const TRASH_DIR = 'gitslappin-trash';
const NOT_SAVED = 'The old version could not be saved, so nothing was changed.';

export interface FileActionOptions {
  /** The largest working file (bytes) that save, restore and delete will pin. Bigger is refused and nothing is changed. */
  maxCaptureBytes?: number;
}

/** `real` is `base` or below it (both real paths; case-insensitive on Windows). */
function isInside(real: string, base: string): boolean {
  const n = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const b = n(base).endsWith(sep) ? n(base) : n(base) + sep;
  return (n(real) + sep).startsWith(b);
}

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof UnsafePathError) return reply.code(400).send({ error: e.message });
  return reply.code(500).send({ error: 'Request failed.' });
}

export function registerFileActionRoutes(app: FastifyInstance, registry: RepoRegistry, options: FileActionOptions = {}): void {
  const maxCapture = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  /** Save reads and re-reads only files the editor can open (5 MB), and never more than it can pin. */
  const saveLimit = Math.min(MAX_EDIT_BYTES, maxCapture);

  const git = (root: string, repoId: string, args: string[], input?: string | Buffer) =>
    runGit(args, { cwd: root, repoId, timeoutMs: 60_000, env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' }, ...(input === undefined ? {} : { input }) });

  /** The repo-relative path from the body or query: a string that passes safeRepoPath. */
  function pathOf(root: string, v: unknown): { path: string; abs: string } {
    if (typeof v !== 'string') throw new HttpError(400, 'Missing path.');
    return { path: v, abs: safeRepoPath(root, v) };
  }

  /** An exact, stage-0, regular-file (100644 / 100755) entry of the index with this very path: no directory, no link, no gitlink, no glob, no case variant. */
  async function assertTrackedRegular(root: string, repoId: string, path: string): Promise<void> {
    const r = await git(root, repoId, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', path]);
    if (r.code !== 0) throw new HttpError(500, 'The file list could not be read.');
    const rows = r.stdout
      .split('\0')
      .filter((x) => x !== '')
      .map((x) => /^(\d{6}) [0-9a-f]+ (\d)\t([\s\S]*)$/.exec(x))
      .filter((m): m is RegExpExecArray => m !== null && m[3] === path);
    if (rows.length === 0) throw new HttpError(400, 'Not a tracked file.');
    if (rows.some((m) => m[2] !== '0')) throw new HttpError(409, 'The file has merge conflicts.');
    if (rows.length !== 1 || !REGULAR_MODES.has(rows[0]![1]!)) throw new HttpError(400, 'Only regular files can be used here.');
  }

  const assertNoOperation = async (root: string): Promise<void> => {
    if ((await readOpState(root)) !== undefined) throw new HttpError(409, 'Another operation is in progress.');
  };

  async function headSha(root: string, repoId: string): Promise<string | null> {
    const r = await git(root, repoId, ['rev-parse', '-q', '--verify', 'HEAD']);
    return r.code === 0 && SHA.test(r.stdout.trim()) ? r.stdout.trim() : null;
  }

  /** What the working path is: 'missing', 'file' (a regular file, not a link) or 'other'. A file over `limit` bytes is a 413. */
  async function workingKind(abs: string, limit: number): Promise<'missing' | 'file' | 'other'> {
    try {
      const st = await lstat(abs);
      if (!st.isFile()) return 'other';
      if (st.size > limit) throw new HttpError(413, 'The file is too large to back up, so nothing was changed.');
      return 'file';
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'other';
    }
  }

  /** A working path that exists must be a regular file (a link or folder where the index has a file is a type change). A missing path is left to the caller. */
  async function assertEditableKind(abs: string): Promise<void> {
    try {
      if (!(await lstat(abs)).isFile()) throw new HttpError(400, 'Only regular files can be edited here.');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new HttpError(400, 'Cannot read file.');
    }
  }

  /** Records the change so Undo can reverse it. false when it could not be recorded (the backup sha is then the only way back). */
  async function journal(root: string, repoId: string, head: string | null, file: PinnedFile, label: string, indexTree?: string): Promise<boolean> {
    file.post = await stateOf(root, repoId, file.path);
    const indexAfter = await writeTree(root, repoId);
    if (!head || !indexAfter) {
      clearRedo(root);
      return false;
    }
    record(root, { kind: 'discard', head, snap: null, files: [file], indexAfter, label, ...(indexTree ? { indexTree } : {}) });
    return true;
  }

  const logSaved = (repoId: string, sha: string): void => recordCommand(repoId, { at: Date.now(), args: ['previous version saved as', sha], code: 0, durationMs: 0 });

  // ---- S1: read ----
  app.get<{ Params: { id: string }; Querystring: { path?: unknown } }>('/api/repos/:id/file-edit', async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      const { path, abs } = pathOf(root, req.query.path);
      await assertTrackedRegular(root, repoId, path);
      await assertEditableKind(abs);
      const bytes = await readWorking(root, abs, MAX_EDIT_BYTES);
      if (bytes === null) throw new HttpError(404, 'The file does not exist in the working folder.');
      if (isBinary(bytes)) throw new HttpError(415, 'Binary File');
      const text = decode(bytes);
      const info: FileEditInfo = { text, hash: sha256(bytes), bom: hasBom(bytes), eol: majorityEol(text) };
      return info;
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ---- S2: save ----
  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/file-edit/save', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      if (!isObject(req.body)) throw new HttpError(400, 'Invalid request.');
      const { path, abs } = pathOf(root, req.body.path);
      const text = req.body.text;
      if (typeof text !== 'string' || text.includes('\0') || !(text as string & { isWellFormed(): boolean }).isWellFormed()) throw new HttpError(400, 'The text is not valid.');
      if (Buffer.byteLength(text, 'utf8') > MAX_EDIT_BYTES) throw new HttpError(413, 'The text is too large.');
      const expect = req.body.expectHash;
      if (expect === undefined || expect === null) throw new HttpError(409, 'The file may have changed. Open it again.');
      if (typeof expect !== 'string' || !HASH_RE.test(expect)) throw new HttpError(400, 'Invalid request.');
      const stale = (): HttpError => new HttpError(409, 'The file changed on disk since it was opened. Open it again.');

      const result = await runExclusive<FileActionResult>(repoId, async () => {
        await assertNoOperation(root);
        await assertTrackedRegular(root, repoId, path);
        await assertEditableKind(abs);
        const working = await readWorking(root, abs, saveLimit);
        if (working === null) throw new HttpError(404, 'The file does not exist in the working folder.'); // a save never creates a file
        if (sha256(working) !== expect) throw stale();
        if (isBinary(working)) throw new HttpError(415, 'Binary File');
        const body = Buffer.from(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, 'utf8');
        const bytes = hasBom(working) ? Buffer.concat([BOM, body]) : body;

        // The old bytes are pinned first; they must be the bytes that were just checked (fail closed).
        const head = await headSha(root, repoId);
        const pinned = await captureFile(root, repoId, path, false);
        if (!pinned || pinned.blob === null) throw new HttpError(500, NOT_SAVED);
        if (pinned.blob !== (await hashBytes(root, repoId, working, false))) throw stale();

        const st = await lstat(abs);
        if (!st.isFile()) throw new HttpError(400, 'Only regular files can be edited here.');
        const tmp = join(await tempDirFor(root, repoId, abs), `.gitslappin-edit-${randomBytes(6).toString('hex')}.tmp`);
        const fh = await open(tmp, 'wx', st.mode & 0o777);
        try {
          await fh.chmod(st.mode & 0o777);
          await fh.writeFile(bytes);
        } finally {
          await fh.close();
        }
        // Right before the rename: still the same regular file with the same bytes. A temp file of a failed save is left where it is.
        const again = await readWorking(root, abs, saveLimit);
        if (again === null || sha256(again) !== expect) throw stale();
        await renameWithRetry(tmp, abs);

        logSaved(repoId, pinned.blob);
        // Afterwards: the real parent is still inside the real root and the file is where it was meant to be.
        const realRoot = await realpath(root);
        const realParent = await realpath(dirname(abs));
        if (!isInside(realParent, realRoot) || (await realpath(abs)) !== join(realParent, basename(abs))) throw new HttpError(500, 'The file ended up outside the repository.');
        const undoable = await journal(root, repoId, head, pinned, `edit file '${path}'`);
        return { backup: pinned.blob, undoable };
      });
      return result;
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ---- S3: restore from a commit ----
  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/file/restore', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      if (!isObject(req.body)) throw new HttpError(400, 'Invalid request.');
      const { path, abs } = pathOf(root, req.body.path);
      const sha = req.body.sha;
      if (typeof sha !== 'string' || !SHA.test(sha)) throw new HttpError(400, 'Invalid commit.');

      const result = await runExclusive<FileActionResult>(repoId, async () => {
        await assertNoOperation(root);
        const commit = await git(root, repoId, ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]);
        if (commit.code !== 0 || commit.stdout.trim() !== sha) throw new HttpError(404, 'That commit was not found.');
        // The commit's own entry for exactly this path, a regular file only (never a directory, a link or a submodule).
        const tree = await git(root, repoId, ['--literal-pathspecs', 'ls-tree', '-z', sha, '--', path]);
        if (tree.code !== 0) throw new HttpError(500, 'The commit could not be read.');
        const entry = tree.stdout
          .split('\0')
          .map((x) => /^(\d{6}) (\w+) [0-9a-f]+\t([\s\S]*)$/.exec(x))
          .find((m) => m !== null && m[3] === path);
        if (!entry) throw new HttpError(404, 'File not found. This may occur in repositories using sparse checkout.');
        if (entry[1] === '160000') throw new HttpError(400, 'Cannot restore submodules');
        if (!REGULAR_MODES.has(entry[1]!)) throw new HttpError(400, 'Only regular files can be restored.');
        if ((await workingKind(abs, maxCapture)) === 'other') throw new HttpError(400, 'Only regular files can be restored here.');

        // An intent-to-add entry cannot be pinned or put back exactly: refused, untouched.
        const added = await git(root, repoId, ['--literal-pathspecs', 'diff-files', '--name-status', '-z', '--no-renames', '--', path]);
        if (added.code !== 0) throw new HttpError(500, 'The index could not be read.');
        if (added.stdout.split('\0')[0] === 'A') throw new HttpError(409, 'The index has an intent-to-add entry for this file, so it cannot be restored.');

        // Pin the index (the staged change) and the working bytes. Any step failing stops here, before anything is changed.
        const head = await headSha(root, repoId);
        const indexTree = await writeTree(root, repoId);
        if (!indexTree || !(await pin(root, repoId, indexTree))) throw new HttpError(500, NOT_SAVED);
        const pinned = await captureFile(root, repoId, path, true);
        if (!pinned) throw new HttpError(500, NOT_SAVED);
        if (pinned.blob !== null) logSaved(repoId, pinned.blob);

        const res = await git(root, repoId, ['--literal-pathspecs', 'restore', `--source=${sha}`, '--staged', '--worktree', '--', path]);

        // Recorded whenever anything changed, also after a failure half way, so Undo can put it back.
        pinned.post = await stateOf(root, repoId, path);
        const indexAfter = await writeTree(root, repoId);
        const changed = pinned.post !== preState(pinned) || indexAfter !== indexTree;
        let undoable = false;
        if (changed && head && indexAfter) {
          record(root, { kind: 'discard', head, snap: null, files: [pinned], indexAfter, label: `restore file '${path}'`, indexTree });
          undoable = true;
        } else clearRedo(root);
        if (res.code !== 0) throw new HttpError(500, 'The file could not be restored.');
        return { backup: pinned.blob ?? '', undoable, indexBackup: indexTree, ...(changed ? {} : { changed: false }) };
      });
      return result;
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ---- S4: delete (move to the trash) ----
  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/file/delete', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    try {
      if (!isObject(req.body)) throw new HttpError(400, 'Invalid request.');
      const { path, abs } = pathOf(root, req.body.path);

      const result = await runExclusive<FileActionResult>(repoId, async () => {
        await assertNoOperation(root);
        await assertTrackedRegular(root, repoId, path);
        const kind = await workingKind(abs, maxCapture);
        if (kind === 'missing') throw new HttpError(404, 'The file does not exist in the working folder.');
        if (kind === 'other' || (await inspectParents(root, path)) !== 'ok') throw new HttpError(400, 'Only regular files can be deleted here.');

        // The trash lives inside the git folder and must be on the same volume (a rename, never a copy and delete): checked before any folder is made.
        const g = await git(root, repoId, ['rev-parse', '--absolute-git-dir']);
        if (g.code !== 0 || g.stdout.trim() === '') throw new HttpError(500, 'The git folder could not be found, so nothing was changed.');
        const gitDir = await realpath(g.stdout.trim());
        const volume = (p: string): string => parsePath(p).root.toLowerCase();
        if (volume(gitDir) !== volume(await realpath(dirname(abs)))) throw new HttpError(409, 'The file is on another drive than the git folder, so it cannot be moved to the trash.');

        const head = await headSha(root, repoId);
        const pinned = await captureFile(root, repoId, path, false);
        if (!pinned) throw new HttpError(500, NOT_SAVED);
        if (pinned.blob === null) throw new HttpError(404, 'The file does not exist in the working folder.');

        const stamp = `${Date.now()}-${randomBytes(4).toString('hex')}`;
        const dest = join(gitDir, TRASH_DIR, stamp, ...path.split('/'));
        try {
          // The trash folder must be a real folder inside the git folder (not a file, link or junction that leads elsewhere). This is checked, and
          // gitslappin-trash itself made only when it is absent, BEFORE anything is created below it, so nothing can ever be created outside.
          const trashRoot = join(gitDir, TRASH_DIR);
          const checkTrash = async (): Promise<boolean> => {
            const st = await lstat(trashRoot);
            return st.isDirectory() && !st.isSymbolicLink() && isInside(await realpath(trashRoot), gitDir);
          };
          let present = true;
          try {
            await lstat(trashRoot);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            present = false;
          }
          if (present && !(await checkTrash())) throw new Error('outside');
          if (!present) {
            await mkdir(trashRoot);
            if (!(await checkTrash())) throw new Error('outside');
          }
          await mkdir(dirname(dest), { recursive: true });
          if (!isInside(await realpath(dirname(dest)), gitDir)) throw new Error('outside');
        } catch {
          throw new HttpError(500, 'The trash folder could not be made, so nothing was changed.');
        }

        // Just before the move: no operation started, the parents are still real folders inside the repo, and the file still holds the pinned bytes.
        await assertNoOperation(root);
        if ((await stateOf(root, repoId, path)) !== preState(pinned)) throw new HttpError(409, 'The file changed on disk. Nothing was deleted.');
        try {
          await renameWithRetry(abs, dest);
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(500, 'The file could not be moved to the trash, so nothing was changed.');
        }

        // The move is confirmed: the path is gone and the trash copy holds the pinned bytes.
        let confirmed = false;
        try {
          confirmed = (await stateOf(root, repoId, path)) === 'none' && pinned.blob === (await hashBytes(root, repoId, await readFile(dest), false));
        } catch {
          confirmed = false;
        }

        // The rename happened, so the log line and the journal entry (best effort) come first, whether or not the move was confirmed.
        logSaved(repoId, pinned.blob);
        const undoable = await journal(root, repoId, head, pinned, `delete file '${path}'`);
        // Reported relative to the repo (e.g. .git/gitslappin-trash/<stamp>/<path>), never as an absolute path.
        const relGit = await realpath(root).then((r) => relative(r, gitDir).split(sep).join('/'), () => '..');
        const trashPath = `${relGit === '' || relGit.startsWith('..') || isAbsolute(relGit) ? '<git folder>' : relGit}/${TRASH_DIR}/${stamp}/${path}`;
        if (!confirmed) throw new HttpError(500, `The move to the trash could not be confirmed. The file may be at ${trashPath}. The previous version is saved as ${pinned.blob}.`);
        return { backup: pinned.blob, undoable, trashPath };
      });
      return result;
    } catch (e) {
      return fail(reply, e);
    }
  });
}
