import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, join, parse as parsePath, sep } from 'node:path';
import { runGit } from './runner';

/*
 * Working-file helpers shared by the merge tool (routes/mergeTool.ts) and the file editor (routes/fileActions.ts).
 * Moved out of mergeTool.ts unchanged, except that readWorking takes the size cap as a parameter.
 */

export const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const RENAME_RETRIES = 5;
export const HASH_RE = /^[0-9a-f]{64}$/;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
export const hasBom = (b: Buffer): boolean => b.length >= 3 && b.subarray(0, 3).equals(BOM);

/** Not mergeable as text: has a NUL, is not UTF-8, or has a lone CR (a CR not followed by LF, which would be split as a line break by editors). Such files are take-only. */
export function isBinary(b: Buffer): boolean {
  if (b.subarray(0, 8192).includes(0)) return true;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
    return /\r(?!\n)/.test(text);
  } catch {
    return true;
  }
}
export const decode = (b: Buffer): string => {
  const t = new TextDecoder('utf-8', { ignoreBOM: true }).decode(b);
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
};

/** The EOL most lines use ("crlf" when CRLF lines outnumber bare LF lines). */
export function majorityEol(text: string): 'lf' | 'crlf' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? 'crlf' : 'lf';
}

/** BOM rule: when the working file and the sides agree that is it; when they disagree A's wins (without A: the working file's, then B's). */
export function resolveBom(working: boolean | null, a: boolean | null, b: boolean | null): boolean {
  const present = [working, a, b].filter((v): v is boolean => v !== null);
  if (present.length === 0) return false;
  if (present.every((v) => v === present[0])) return present[0]!;
  return a ?? working ?? b ?? false;
}

/** The working file's bytes (null when it does not exist). Regular file only, real location inside the real root. Over `maxBytes` is a 413. */
export async function readWorking(root: string, abs: string, maxBytes: number): Promise<Buffer | null> {
  let st;
  try {
    st = await lstat(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new HttpError(400, 'Cannot read file.');
  }
  if (!st.isFile()) throw new HttpError(400, 'Only regular files can be merged here.');
  if (st.size > maxBytes) throw new HttpError(413, 'The file is too large.');
  const realRoot = await realpath(root);
  const real = await realpath(abs);
  if (!(real + sep).startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) throw new HttpError(400, 'Path is outside the repository.');
  return readFile(abs);
}

/** Stores the current working bytes as a blob (only adds an object). null when there is no working file. */
export async function backup(root: string, repoId: string, working: Buffer | null): Promise<string | null> {
  if (working === null) return null;
  const r = await runGit(['hash-object', '-w', '--no-filters', '--stdin'], { cwd: root, repoId, input: working });
  const sha = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new HttpError(500, 'The backup of the current file could not be made, so nothing was changed.', r.stderr);
  return sha;
}

export async function assertParentInside(root: string, abs: string): Promise<void> {
  let realParent: string;
  try {
    realParent = await realpath(dirname(abs));
  } catch {
    throw new HttpError(409, 'The file changed on disk since it was opened. Open it again.');
  }
  const realRoot = await realpath(root);
  if (!(realParent + sep).startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) throw new HttpError(400, 'Path is outside the repository.');
}

/** `<gitdir>/gitslappin-tmp` when it is on the same volume as the target (a leftover is then never an untracked file), else the target's own directory. */
export async function tempDirFor(root: string, repoId: string, abs: string): Promise<string> {
  const g = await runGit(['rev-parse', '--absolute-git-dir'], { cwd: root, repoId });
  const next = dirname(abs);
  if (g.code !== 0 || g.stdout.trim() === '') return next;
  try {
    const gitDir = await realpath(g.stdout.trim());
    const volume = (p: string): string => parsePath(p).root.toLowerCase();
    if (volume(gitDir) !== volume(await realpath(next))) return next;
    const dir = join(gitDir, 'gitslappin-tmp');
    await mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return next;
  }
}

/** rename that retries on EPERM, EBUSY and EACCES (antivirus, indexers) up to 5 times, then answers 503. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
      if (attempt >= RENAME_RETRIES) throw new HttpError(503, 'The file is in use by another program, so it was not changed. Try again in a moment.');
      await new Promise((r) => setTimeout(r, Math.min(250, 50 + attempt * 50)));
    }
  }
}
