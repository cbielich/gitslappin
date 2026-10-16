import type { GraphVisibility, LogCommit, RefLabel } from '@gitslappin/shared';

const fullName = (l: RefLabel): string | null => (l.kind === 'local' ? `refs/heads/${l.name}` : l.kind === 'remote' ? `refs/remotes/${l.name}` : l.kind === 'tag' ? `refs/tags/${l.name}` : null);

/**
 * The hide/solo view of the full cached walk, built in memory (no git). Keeps the walk order (a subsequence),
 * keeps every commit reachable from a visible tip, and strips hidden labels. The checked-out branch / HEAD is never hidden.
 * Relies on the walk listing children before parents (git log --date-order does).
 */
export function buildVisibleView(commits: LogCommit[], vis: GraphVisibility): LogCommit[] {
  const hidden = new Set(vis.hidden);
  const solo = new Set(vis.solo);
  const soloing = solo.size > 0;
  const labelVisible = (l: RefLabel): boolean => {
    if (l.current || l.kind === 'head') return true;
    const f = fullName(l);
    if (f === null) return true;
    return soloing ? solo.has(f) : !hidden.has(f); // an explicit solo wins over hidden
  };
  const showStashes = !vis.hideStashes && !soloing;

  // Commits some other commit lists as a parent: the rest are the heads of the walk.
  const hasChild = new Set<string>();
  if (!soloing) for (const c of commits) for (const p of c.parents) hasChild.add(p);

  const keep = new Set<string>();
  const out: LogCommit[] = [];
  for (const c of commits) {
    let tip: boolean;
    if (c.stash !== undefined) tip = showStashes;
    else tip = c.refs.some(labelVisible) || (!soloing && c.refs.length === 0 && !hasChild.has(c.sha)); // an unlabelled head came from another ref namespace, kept as with --all
    if (!tip && !keep.has(c.sha)) continue;
    for (const p of c.parents) keep.add(p);
    const refs = c.refs.filter(labelVisible);
    out.push(refs.length === c.refs.length ? c : { ...c, refs });
  }
  return out;
}
