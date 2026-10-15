import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_PATH_CHARS = 4096;

export class UnsafePathError extends Error {}

/**
 * Validates a repo-relative path from the client. Pure string rules plus a "stays inside root" check;
 * nothing is read from disk. Returns the absolute path. Throws UnsafePathError on rejection.
 */
export function safeRepoPath(root: string, p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new UnsafePathError('Empty path.');
  if (p.length > MAX_PATH_CHARS) throw new UnsafePathError('Path too long.');
  if (p.includes('\0')) throw new UnsafePathError('Invalid path.');
  if (p.includes('\\')) throw new UnsafePathError('Invalid path.');
  if (p.includes('\n') || p.includes('\r')) throw new UnsafePathError('Invalid path.');
  // A colon anywhere is refused: drive letters, NTFS alternate data streams and git's `:0:path` revision syntax.
  if (p.includes(':') || p.startsWith('/')) throw new UnsafePathError('Invalid path.');
  const segs = p.split('/');
  if (segs.some((seg) => seg === '..')) throw new UnsafePathError('Invalid path.');
  // Nothing inside .git (any case; Windows ignores trailing dots and spaces).
  if (segs.some((seg) => seg.replace(/[. ]+$/, '').toLowerCase() === '.git')) throw new UnsafePathError('Invalid path.');
  // Windows device names (CON, NUL, COM1-9, ...: the part before the first dot, trailing dots and spaces ignored) and 8.3 short names.
  // (CONIN$, CONOUT$ and the superscript COM/LPT names are reserved too; the 8.3 rule is only for real short-name shapes like PROGRA~1 or a~1.txt.)
  if (segs.some((seg) => /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(seg.replace(/[. ]+$/, '').split('.')[0]!.replace(/[. ]+$/, '')) || /^[^.~]{1,6}~\d{1,6}(?:\.[^.]{0,3})?$/.test(seg))) throw new UnsafePathError('Invalid path.');
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new UnsafePathError('Path is outside the repository.');
  return abs;
}

/**
 * For working-tree reads: a regular file (not a symlink) whose real location is still inside the real root.
 * Returns false when the file does not exist (a deleted file); throws for anything else that is not safe.
 */
export function assertWorkingTreeFile(root: string, abs: string): boolean {
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw new UnsafePathError('Cannot read file.');
  }
  if (!st.isFile()) throw new UnsafePathError('Only regular files can be shown.');
  const realRoot = realpathSync(root);
  const real = realpathSync(abs);
  if (!(real + sep).startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) throw new UnsafePathError('Path is outside the repository.');
  return true;
}
