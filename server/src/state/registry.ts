import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { RepoInfo } from '@gitslappin/shared';

export function repoIdFor(root: string): string {
  return createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 12);
}

export function repoInfoFor(root: string): RepoInfo {
  return { id: repoIdFor(root), root, name: basename(root) };
}

/** Known repos for this server run: id -> root. Later routes resolve /api/repos/:id through it. */
export class RepoRegistry {
  private roots = new Map<string, string>();

  register(info: RepoInfo): void {
    this.roots.set(info.id, info.root);
  }

  rootOf(id: string): string | undefined {
    return this.roots.get(id);
  }
}
