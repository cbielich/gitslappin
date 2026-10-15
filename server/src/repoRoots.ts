import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

function real(p: string): string {
  const r = resolve(p);
  try {
    return realpathSync(r);
  } catch {
    return r;
  }
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** True when no roots are configured, or the real path of `path` is a root or inside one. */
export function isUnderRoots(path: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  const p = norm(real(path));
  return roots.some((root) => {
    const r = norm(real(root));
    const prefix = r.endsWith(sep) ? r : r + sep;
    return p === r || p.startsWith(prefix);
  });
}
