import type { LogCommit } from './git';

export type CompareModeName = 'pair' | 'range' | 'wip' | 'wipRange' | 'none';

export interface CompareMode {
  mode: CompareModeName;
  /** The "from" side: a sha, or 'empty' for the empty tree. */
  base?: string;
  /** The newest commit of the comparison (not set for 'wip'). */
  head?: string;
}

/** What a multi selection of graph rows compares. `commits` are the loaded graph rows, newest first. */
export function compareMode(sel: { kind: 'multi'; shas: string[]; wip: boolean }, commits: LogCommit[], headSha: string | null): CompareMode {
  const index = new Map<string, number>();
  commits.forEach((c, i) => index.set(c.sha, i));
  const rows: LogCommit[] = [];
  for (const s of new Set(sel.shas)) {
    const i = index.get(s);
    if (i === undefined) return { mode: 'none' };
    rows.push(commits[i]!);
  }
  rows.sort((a, b) => index.get(a.sha)! - index.get(b.sha)!);

  if (sel.wip) {
    if (rows.length === 1) return { mode: 'wip', base: rows[0]!.sha };
    if (rows.length < 2 || rows[0]!.sha !== headSha || !isChain(rows)) return { mode: 'none' };
    return { mode: 'wipRange', base: rows[rows.length - 1]!.parents[0] ?? 'empty', head: rows[0]!.sha };
  }
  if (rows.length === 2) return { mode: 'pair', base: rows[1]!.sha, head: rows[0]!.sha };
  if (rows.length > 2 && isChain(rows)) return { mode: 'range', base: rows[rows.length - 1]!.parents[0] ?? 'empty', head: rows[0]!.sha };
  return { mode: 'none' };
}

/** Newest first: every commit's first parent is the next one. */
function isChain(rows: LogCommit[]): boolean {
  for (let i = 0; i + 1 < rows.length; i++) if (rows[i]!.parents[0] !== rows[i + 1]!.sha) return false;
  return true;
}
