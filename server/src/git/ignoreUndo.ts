import { randomBytes } from 'node:crypto';
import { lstat, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit, type GitResult } from './runner';
import { safeRepoPath } from './safeRepoPath';
import { hashBytes, inspectParents } from './snapshot';
import type { UndoResult } from './undo';

/*
 * V3 Ignore: the .gitignore write and the undo / redo of it. Nothing here ever deletes a file: a .gitignore GitSlappin created is
 * truncated to empty on undo (and only while its hash still equals `after`), and a failed write leaves its temp file where it is.
 */

export interface IgnoreRemoved {
  mode: string;
  sha: string;
  path: string;
}

/** `before` / `after` are blob hashes of the whole .gitignore (both pinned under refs/gitslappin/undo/). before null = we created the file. */
export interface IgnoreEntry {
  kind: 'ignore';
  before: string | null;
  after: string;
  removed: IgnoreRemoved[];
  label: string;
}

const SHA = /^[0-9a-f]{40,64}$/;
const MODE = /^(?:100644|100755|120000|160000)$/;
const TIMEOUT_MS = 5 * 60 * 1000;
const MISSING = 'Undo information is missing - it has likely been garbage collected.';

const run = (root: string, repoId: string, args: string[], input?: string | Buffer, latin1 = false): Promise<GitResult> =>
  runGit(args, { cwd: root, repoId, timeoutMs: TIMEOUT_MS, ...(input === undefined ? {} : { input }), ...(latin1 ? { encoding: 'latin1' as const } : {}) });

const refused = (error: string): UndoResult => ({ outcome: 'refused', error });
const failed = (res: GitResult, fallback: string): UndoResult => ({
  outcome: 'failed',
  error: res.stderr.trim().split('\n')[0] || fallback,
  stderr: res.stderr.trim() || `git exited with code ${res.code}.`,
});

/** The .gitignore as it is: missing, a regular file with its bytes, or null (a link, a directory, unreadable, unsafe parent: fail closed). */
export async function readGitignore(root: string): Promise<{ kind: 'none' } | { kind: 'file'; bytes: Buffer } | null> {
  if ((await inspectParents(root, '.gitignore')) !== 'ok') return null;
  const abs = join(root, '.gitignore');
  try {
    if (!(await lstat(abs)).isFile()) return null;
    // Read through one handle and re-check it, so a link swapped in after the lstat is not followed.
    const fh = await open(abs, 'r');
    try {
      if (!(await fh.stat()).isFile()) return null;
      const now = await lstat(abs);
      if (!now.isFile()) return null;
      return { kind: 'file', bytes: await fh.readFile() };
    } finally {
      await fh.close();
    }
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'none' } : null;
  }
}

/**
 * Temp file (wx, random name, in the repo root, so a planted link is never followed) + rename. On any failure the temp file is LEFT
 * in place (data safety wins over tidiness) and the error text is returned. null = written.
 */
export async function writeGitignore(root: string, bytes: Buffer): Promise<string | null> {
  if ((await inspectParents(root, '.gitignore')) !== 'ok') return 'The folder of .gitignore is not safe to write to.';
  const tmp = join(root, `.gitslappin-ignore-${randomBytes(16).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, bytes, { flag: 'wx', mode: 0o644 });
    await rename(tmp, join(root, '.gitignore'));
    return null;
  } catch (e) {
    return `.gitignore could not be written (${(e as NodeJS.ErrnoException).code ?? 'error'}).`;
  }
}

/** Every stage of every index entry: path -> entries. null = git failed. */
async function indexEntries(root: string, repoId: string): Promise<Map<string, { mode: string; sha: string; stage: string }[]> | null> {
  const res = await run(root, repoId, ['ls-files', '-s', '-z']);
  if (res.code !== 0) return null;
  const out = new Map<string, { mode: string; sha: string; stage: string }[]>();
  for (const rec of res.stdout.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(rec);
    if (!m) continue;
    out.set(m[4]!, [...(out.get(m[4]!) ?? []), { mode: m[1]!, sha: m[2]!, stage: m[3]! }]);
  }
  return out;
}

function removedOk(root: string, removed: IgnoreRemoved[]): boolean {
  return removed.every((r) => {
    if (!MODE.test(r.mode) || !SHA.test(r.sha)) return false;
    try {
      safeRepoPath(root, r.path);
      return true;
    } catch {
      return false;
    }
  });
}

const exists = async (root: string, repoId: string, sha: string): Promise<boolean> => SHA.test(sha) && (await run(root, repoId, ['cat-file', '-e', sha])).code === 0;

async function blobBytes(root: string, repoId: string, sha: string): Promise<Buffer | null> {
  const res = await run(root, repoId, ['cat-file', 'blob', sha], undefined, true);
  return res.code === 0 ? Buffer.from(res.stdout, 'latin1') : null;
}

export async function undoIgnore(root: string, repoId: string, e: IgnoreEntry): Promise<UndoResult> {
  if (!SHA.test(e.after) || (e.before !== null && !SHA.test(e.before)) || !removedOk(root, e.removed)) return refused(MISSING);
  if (!(await exists(root, repoId, e.after)) || (e.before !== null && !(await exists(root, repoId, e.before)))) return refused(MISSING);
  const cur = await readGitignore(root);
  if (!cur || cur.kind !== 'file') return refused('The .gitignore has changed since it was written.');
  // Hash equality with `after` is the only thing that lets this undo overwrite (or, for a file we created, truncate) the .gitignore.
  if ((await hashBytes(root, repoId, cur.bytes, false)) !== e.after) return refused('The .gitignore has changed since it was written.');
  const old = e.before === null ? Buffer.alloc(0) : await blobBytes(root, repoId, e.before);
  if (!old) return refused(MISSING);

  if (e.removed.length > 0) {
    const idx = await indexEntries(root, repoId);
    if (!idx) return refused('The index could not be read.');
    if (e.removed.some((r) => idx.has(r.path))) return refused('A file that was removed from the index has been added again.');
    const input = e.removed.map((r) => `${r.mode} ${r.sha}\t${r.path}\0`).join('');
    const res = await run(root, repoId, ['update-index', '-z', '--index-info'], input);
    if (res.code !== 0) return failed(res, 'git update-index failed.');
  }
  // A .gitignore we created is emptied, never unlinked. Written via temp + rename (not truncate), so a link swapped in is replaced, not followed.
  const err = await writeGitignore(root, old);
  return err ? { outcome: 'failed', error: err } : { outcome: 'done' };
}

export async function redoIgnore(root: string, repoId: string, e: IgnoreEntry): Promise<UndoResult> {
  if (!SHA.test(e.after) || (e.before !== null && !SHA.test(e.before)) || !removedOk(root, e.removed)) return refused(MISSING);
  if (!(await exists(root, repoId, e.after))) return refused(MISSING);
  const cur = await readGitignore(root);
  if (!cur) return refused('The .gitignore has changed since the ignore was undone.');
  if (cur.kind === 'none') {
    if (e.before !== null) return refused('The .gitignore has changed since the ignore was undone.');
  } else {
    const have = await hashBytes(root, repoId, cur.bytes, false);
    const want = e.before ?? (await hashBytes(root, repoId, Buffer.alloc(0), false));
    if (have !== want) return refused('The .gitignore has changed since the ignore was undone.');
  }
  if (e.removed.length > 0) {
    const idx = await indexEntries(root, repoId);
    if (!idx) return refused('The index could not be read.');
    for (const r of e.removed) {
      const hit = idx.get(r.path);
      if (!hit || hit.length !== 1 || hit[0]!.stage !== '0' || hit[0]!.sha !== r.sha || hit[0]!.mode !== r.mode) return refused('The index has changed since the ignore was undone.');
    }
  }
  const next = await blobBytes(root, repoId, e.after);
  if (!next) return refused(MISSING);
  const err = await writeGitignore(root, next);
  if (err) return { outcome: 'failed', error: err };
  if (e.removed.length > 0) {
    const res = await run(root, repoId, ['--literal-pathspecs', 'rm', '--cached', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], `${e.removed.map((r) => r.path).join('\0')}\0`);
    if (res.code !== 0) return failed(res, 'git rm failed.');
  }
  return { outcome: 'done' };
}
