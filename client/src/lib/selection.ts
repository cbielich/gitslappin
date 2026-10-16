/* V4 graph selection: single, or a multi selection of commits (and the WIP row). Pure; the graph view feeds it clicks. */

export type RowRef = { kind: 'commit'; sha: string } | { kind: 'wip' } | { kind: 'stash'; sha: string };

export type Selection = { kind: 'wip' } | { kind: 'commit'; sha: string } | { kind: 'stash'; sha: string } | { kind: 'multi'; shas: string[]; wip: boolean };

export interface SelState {
  selection: Selection | null;
  anchor: RowRef | null;
}

const same = (a: RowRef, b: RowRef): boolean => a.kind === b.kind && (a.kind === 'wip' || (b.kind !== 'wip' && a.sha === b.sha));

const single = (row: RowRef): SelState => ({ selection: row.kind === 'wip' ? { kind: 'wip' } : { kind: row.kind, sha: row.sha }, anchor: row });

/** Builds the selection for a set; shas are put in ROWS order. One item is a plain single selection, none is null. */
function fromSet(shas: Set<string>, wip: boolean, rows: RowRef[]): Selection | null {
  const ordered = rows.flatMap((r) => (r.kind === 'commit' && shas.has(r.sha) ? [r.sha] : []));
  if (ordered.length + (wip ? 1 : 0) === 0) return null;
  if (ordered.length === 0) return { kind: 'wip' };
  if (ordered.length === 1 && !wip) return { kind: 'commit', sha: ordered[0]! };
  return { kind: 'multi', shas: ordered, wip };
}

export function reduceSelection(prev: SelState, click: { row: RowRef; shift: boolean; ctrl: boolean }, rows: RowRef[]): SelState {
  const { row } = click;
  if (row.kind === 'stash' || prev.selection?.kind === 'stash' || (!click.shift && !click.ctrl)) return single(row);

  if (click.ctrl) {
    const cur = prev.selection;
    const shas = new Set<string>(cur?.kind === 'commit' ? [cur.sha] : cur?.kind === 'multi' ? cur.shas : []);
    let wip = cur?.kind === 'wip' || (cur?.kind === 'multi' && cur.wip);
    if (row.kind === 'wip') wip = !wip;
    else if (shas.has(row.sha)) shas.delete(row.sha);
    else shas.add(row.sha);
    return { selection: fromSet(shas, wip, rows), anchor: row };
  }

  // shift: the range of loaded rows from the anchor to the clicked row
  const a = prev.anchor ? rows.findIndex((r) => same(r, prev.anchor!)) : -1;
  const b = rows.findIndex((r) => same(r, row));
  if (a < 0 || b < 0 || prev.anchor?.kind === 'stash') return single(row);
  const range = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
  const shas = new Set(range.flatMap((r) => (r.kind === 'commit' ? [r.sha] : [])));
  return { selection: fromSet(shas, range.some((r) => r.kind === 'wip'), rows), anchor: prev.anchor };
}

/** The shas a selection holds (commits only). */
export const selectedShas = (s: Selection | null): string[] => (s?.kind === 'commit' ? [s.sha] : s?.kind === 'multi' ? s.shas : []);
