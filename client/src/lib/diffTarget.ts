import type { DiffSource, FileStatus, WipFile } from '@gitslappin/shared';

/** What the diff viewer is asked to show. */
export interface DiffTarget {
  source: DiffSource;
  /** Commit sha, for source 'commit'. */
  sha?: string;
  path: string;
  oldPath?: string;
  /** Unstaged only: the file is untracked (the whole file shows as added). */
  untracked?: boolean;
  /** Status from the file list (for the header icon). */
  status: FileStatus | WipFile['status'] | null;
}

export const diffTargetKey = (t: DiffTarget): string => [t.source, t.sha ?? '', t.path, t.oldPath ?? '', t.untracked ? 1 : 0].join('|');

export function diffQuery(t: DiffTarget, extra: { full?: boolean; ws?: boolean } = {}): string {
  const q = new URLSearchParams({ source: t.source, path: t.path });
  if (t.oldPath && t.oldPath !== t.path) q.set('oldPath', t.oldPath);
  if (t.sha) q.set('sha', t.sha);
  if (t.untracked) q.set('untracked', '1');
  if (extra.full) q.set('full', '1');
  if (extra.ws) q.set('ws', '1');
  return q.toString();
}
