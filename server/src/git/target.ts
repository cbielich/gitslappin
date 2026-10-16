import { lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { folderNameProblem } from '@gitslappin/shared';
import { mapOpenPath, type PathPair } from '../pathMap';
import { isUnderRoots } from '../repoRoots';
import { isUncOrDevicePath } from '../security';

/** Shared by clone and init: where a new repository may be created. Nothing here writes or deletes. folderNameProblem lives in shared. */
export { folderNameProblem };

/** The parent folder: mapped (Docker), not UNC/device, absolute, an existing folder, and its real path under the roots. */
export function resolveParent(parent: unknown, roots: string[], pathMap: PathPair[]): { ok: true; dir: string } | { ok: false; error: string } {
  if (typeof parent !== 'string' || parent.trim() === '') return { ok: false, error: 'Choose the folder to create it in.' };
  const mapped = mapOpenPath(parent, pathMap);
  if ('error' in mapped) return { ok: false, error: mapped.error };
  if (isUncOrDevicePath(mapped.path)) return { ok: false, error: 'UNC and device paths are not supported. Use a local folder.' };
  if (!isAbsolute(mapped.path)) return { ok: false, error: 'The folder must be an absolute path.' };
  const dir = resolve(mapped.path);
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    return { ok: false, error: `Folder does not exist: ${dir}` };
  }
  if (!isDir) return { ok: false, error: `Not a folder: ${dir}` };
  if (!isUnderRoots(dir, roots)) return { ok: false, error: 'That folder is outside the folders GitSlappin may open.' };
  return { ok: true, dir };
}

/** null when `full` may be used as a new repository folder: missing, or a plain (not link) empty directory under the roots. */
export function targetProblem(full: string, roots: string[], parentDir?: string): string | null {
  // Second guard behind folderNameProblem: the target must sit directly in the parent and under the roots, even when it doesn't exist yet.
  if (parentDir !== undefined && dirname(resolve(full)) !== resolve(parentDir)) return 'The name must be one folder name.';
  if (!isUnderRoots(resolve(full), roots)) return 'That folder is outside the folders GitSlappin may open.';
  let st;
  try {
    st = lstatSync(full);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : `Cannot use that folder: ${full}`;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${full} already exists and is not a plain folder.`;
  if (readdirSync(full).length > 0) return `${full} already exists and is not empty.`;
  if (!isUnderRoots(full, roots)) return 'That folder is outside the folders GitSlappin may open.';
  return null;
}

export const targetPath = (parentDir: string, name: string): string => join(parentDir, name);
