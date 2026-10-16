import { MAX_REWRITE_COMMITS } from '@gitslappin/shared';

/** What the graph menu needs to know about a commit on HEAD's first-parent line (V4). */
export interface LineInfo {
  /** Commits above it up to HEAD (0 = the tip). */
  dist: number;
  /** No merge commit from HEAD down to it, itself included: the server rewrites only such a line. */
  clean: boolean;
}

/** HEAD's first-parent line over the LOADED commits, newest first. Stops at the first parent that is not loaded or past the server's cap. */
export function headLine(commits: { sha: string; parents: string[] }[], headSha: string | null): Map<string, LineInfo> {
  const out = new Map<string, LineInfo>();
  if (!headSha) return out;
  const by = new Map(commits.map((c) => [c.sha, c]));
  let cur = by.get(headSha);
  let clean = true;
  for (let dist = 0; cur && dist <= MAX_REWRITE_COMMITS && !out.has(cur.sha); dist++) {
    if (cur.parents.length > 1) clean = false;
    out.set(cur.sha, { dist, clean });
    cur = cur.parents[0] ? by.get(cur.parents[0]) : undefined;
  }
  return out;
}
