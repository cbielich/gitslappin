import { isAbsolute, resolve } from 'node:path';
import { isLocalRemoteUrl } from '@gitslappin/shared';
import { mapOpenPath, type PathPair } from '../pathMap';
import { isUnderRoots } from '../repoRoots';
import { isUncOrDevicePath } from '../security';

/**
 * Roots mode (Docker): a file:// URL or an absolute local path given as a remote goes through mapOpenPath, then the UNC refusal, then
 * the real path (links and ".." resolved), and must be under the roots. null = fine (also when no roots are set, or the URL is not local).
 */
export function remoteUrlRootsProblem(url: string, roots: string[], pathMap: PathPair[]): string | null {
  if (roots.length === 0 || !isLocalRemoteUrl(url)) return null;
  const outside = 'That folder is outside the folders GitSlappin may open.';
  let path = url;
  if (/^file:\/\//i.test(url)) {
    let rest: string;
    try {
      rest = decodeURIComponent(url.slice('file:///'.length));
    } catch {
      return 'The file:// URL is not valid.';
    }
    path = /^[A-Za-z]:[\\/]/.test(rest) ? rest : `/${rest}`;
  }
  const mapped = mapOpenPath(path, pathMap);
  if ('error' in mapped) return mapped.error;
  if (isUncOrDevicePath(mapped.path)) return 'UNC and device paths are not supported. Use a local folder.';
  if (!isAbsolute(mapped.path)) return outside;
  return isUnderRoots(resolve(mapped.path), roots) ? null : outside;
}
