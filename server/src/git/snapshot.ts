import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runGit, type GitResult } from './runner';

/*
 * Safety snapshots (phase 11). Taken before a discard, a hunk discard or a reset that could lose data. Every object is
 * pinned with `update-ref refs/gitslappin/undo/<sha> <sha>` (a blob target works, proved by destructive.int.test.ts), and these refs
 * are never deleted. Every step fails closed: the caller aborts when one returns null / ok:false, before anything is changed.
 */

const SHA = /^[0-9a-f]{40,64}$/;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const TIMEOUT_MS = 5 * 60 * 1000;

/** One path as it was before an operation: the pinned raw bytes (or link target text), the exec bit, and what it holds afterwards. */
export interface PinnedFile {
  path: string;
  /** Pinned blob of the raw bytes (a file) or of the link target text (a symlink). null = the path did not exist. */
  blob: string | null;
  symlink: boolean;
  exec: boolean;
  /** Tracked paths get their index entry restored from the snapshot commit on undo. */
  tracked: boolean;
  /** What the path holds after the operation (see stateOf). Set by the caller once the operation is over. */
  post?: string;
}

const run = (root: string, repoId: string, args: string[], extra: { input?: string | Buffer; latin1?: boolean } = {}): Promise<GitResult> =>
  runGit(args, {
    cwd: root,
    repoId,
    timeoutMs: TIMEOUT_MS,
    env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    ...(extra.input === undefined ? {} : { input: extra.input }),
    ...(extra.latin1 ? { encoding: 'latin1' as const } : {}),
  });

const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (real: string, realRoot: string): boolean => {
  const a = norm(real) + sep;
  const b = norm(realRoot);
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/** The hash git gives these bytes as a blob (no filters). write=true also stores the object. */
export async function hashBytes(root: string, repoId: string, bytes: Buffer, write: boolean): Promise<string | null> {
  const r = await run(root, repoId, ['hash-object', '--no-filters', ...(write ? ['-w'] : []), '--stdin'], { input: bytes });
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : null;
}

/** Pins an object so no gc can remove it. Never deleted. */
export async function pin(root: string, repoId: string, sha: string): Promise<boolean> {
  if (!SHA.test(sha)) return false;
  return (await run(root, repoId, ['update-ref', `refs/gitslappin/undo/${sha}`, sha])).code === 0;
}

/**
 * Where the parent directories of a repo-relative path lead: 'ok' (all are real directories), 'missing' (one does not exist, so
 * neither does the path) or 'bad' (a file, a link or something else sits where a directory should be).
 */
export async function inspectParents(root: string, rel: string): Promise<'ok' | 'missing' | 'bad'> {
  const segs = rel.split('/').slice(0, -1);
  let cur = root;
  for (const s of segs) {
    cur = join(cur, s);
    try {
      if (!(await lstat(cur)).isDirectory()) return 'bad';
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'bad';
    }
  }
  try {
    const [realDir, realRoot] = await Promise.all([realpath(dirname(join(root, rel))), realpath(root)]);
    return inside(realDir, realRoot) ? 'ok' : 'bad';
  } catch {
    return 'bad';
  }
}

/** Reads the raw content of one path without following links. null = cannot be read safely (fail closed). */
async function readRaw(root: string, rel: string): Promise<{ kind: 'none' } | { kind: 'file' | 'link'; bytes: Buffer; exec: boolean } | null> {
  const parents = await inspectParents(root, rel);
  if (parents === 'bad') return null;
  if (parents === 'missing') return { kind: 'none' };
  const abs = join(root, rel);
  let st;
  try {
    st = await lstat(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'none' } : null;
  }
  try {
    if (st.isSymbolicLink()) return { kind: 'link', bytes: Buffer.from(await readlink(abs), 'utf8'), exec: false };
    if (st.isFile()) {
      if (st.size > MAX_FILE_BYTES) return null;
      return { kind: 'file', bytes: await readFile(abs), exec: process.platform !== 'win32' && (st.mode & 0o111) !== 0 };
    }
  } catch {
    return null;
  }
  return null; // a directory or something special: never captured
}

/** Pins one path's current bytes. null = the snapshot could not be made (the operation must not run). */
export async function captureFile(root: string, repoId: string, rel: string, tracked: boolean): Promise<PinnedFile | null> {
  const raw = await readRaw(root, rel);
  if (!raw) return null;
  if (raw.kind === 'none') return { path: rel, blob: null, symlink: false, exec: false, tracked };
  const sha = await hashBytes(root, repoId, raw.bytes, true);
  if (!sha || !(await pin(root, repoId, sha))) return null;
  return { path: rel, blob: sha, symlink: raw.kind === 'link', exec: raw.exec, tracked };
}

/** 'none' | 'f:<blob hash>' | 'l:<blob hash of the link text>' | 'other' (a directory, a special file, unreadable). */
export async function stateOf(root: string, repoId: string, rel: string): Promise<string> {
  const raw = await readRaw(root, rel);
  if (!raw) return 'other';
  if (raw.kind === 'none') return 'none';
  const sha = await hashBytes(root, repoId, raw.bytes, false);
  return sha ? `${raw.kind === 'link' ? 'l' : 'f'}:${sha}` : 'other';
}

/** The state a captured path had before the operation, in the same notation as stateOf. */
export const preState = (f: PinnedFile): string => (f.blob === null ? 'none' : `${f.symlink ? 'l' : 'f'}:${f.blob}`);

/** `git stash create` pinned. sha null = there was nothing tracked to save. ok:false = it failed (fail closed). */
export async function stashSnapshot(root: string, repoId: string): Promise<{ ok: true; sha: string | null } | { ok: false; res: GitResult }> {
  const r = await run(root, repoId, ['stash', 'create']);
  if (r.code !== 0) return { ok: false, res: r };
  const sha = r.stdout.trim();
  if (sha === '') return { ok: true, sha: null };
  if (!SHA.test(sha) || !(await pin(root, repoId, sha))) return { ok: false, res: { code: 1, stdout: '', stderr: 'The safety snapshot could not be pinned.' } };
  return { ok: true, sha };
}

export async function writeTree(root: string, repoId: string): Promise<string | null> {
  const r = await run(root, repoId, ['write-tree']);
  return r.code === 0 && SHA.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

/**
 * Puts one captured path back exactly as pinned (temp file + rename, parents checked, exec bit restored). A path that did not
 * exist is removed instead (it holds what the operation put there). Returns an error text, or null when it is done.
 * Idempotent: a path that already holds the pinned content is left alone.
 */
export async function restoreFile(root: string, repoId: string, f: PinnedFile): Promise<string | null> {
  if ((await stateOf(root, repoId, f.path)) === preState(f)) return null;
  const abs = join(root, ...f.path.split('/'));
  if (f.blob === null) {
    const parents = await inspectParents(root, f.path);
    if (parents === 'bad') return `The folder of '${f.path}' is not safe to write to.`;
    try {
      await unlink(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return `'${f.path}' could not be removed.`;
    }
    return null;
  }
  const content = await run(root, repoId, ['cat-file', 'blob', f.blob], { latin1: true });
  if (content.code !== 0) return 'Undo information is missing - it has likely been garbage collected.';
  const bytes = Buffer.from(content.stdout, 'latin1');

  // Parents: create the missing ones one by one, never through a link, then re-check where the folder really is.
  const segs = f.path.split('/').slice(0, -1);
  let cur = root;
  try {
    for (const s of segs) {
      cur = join(cur, s);
      try {
        if (!(await lstat(cur)).isDirectory()) return `The folder of '${f.path}' is not safe to write to.`;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return `The folder of '${f.path}' is not safe to write to.`;
        await mkdir(cur);
      }
    }
    const [realDir, realRoot] = await Promise.all([realpath(dirname(abs)), realpath(root)]);
    if (!inside(realDir, realRoot)) return `The folder of '${f.path}' is outside the repository.`;

    if (f.symlink) {
      try {
        await unlink(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return `'${f.path}' could not be replaced.`;
      }
      await symlink(bytes.toString('utf8'), abs);
      return null;
    }
    const tmp = join(dirname(abs), `.gitslappin-undo-${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, bytes, { flag: 'wx', mode: f.exec ? 0o755 : 0o644 });
      if (f.exec && process.platform !== 'win32') await chmod(tmp, 0o755);
      await rename(tmp, abs);
    } catch (e) {
      await unlink(tmp).catch(() => undefined); // only ever our own temp file
      return `'${f.path}' could not be written (${(e as NodeJS.ErrnoException).code ?? 'error'}).`;
    }
    return null;
  } catch (e) {
    return `'${f.path}' could not be restored (${(e as NodeJS.ErrnoException).code ?? 'error'}).`;
  }
}
