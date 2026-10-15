import { describe, expect, it } from 'vitest';
import { emptyGraphState, layoutGraph, type GraphInput, type GraphRow } from './graph';
import { identicon } from './identicon';

const c = (sha: string, ...parents: string[]): GraphInput => ({ sha, parents });

describe('layoutGraph', () => {
  it('keeps a linear history in one lane with one color', () => {
    const { rows } = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
    expect(rows[0]!.incoming).toEqual([]);
    expect(rows[1]!.incoming).toEqual([{ lane: 0, color: rows[0]!.color }]);
    expect(rows[2]!.outgoing).toEqual([]);
    expect(rows.every((r) => r.through.length === 0)).toBe(true);
  });

  it('draws branch + merge with elbows', () => {
    // m merges f into main; f and b both descend from a
    const { rows } = layoutGraph([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')]);
    const [m, f, b, a] = rows as [GraphRow, GraphRow, GraphRow, GraphRow];
    expect(m.merge).toBe(true);
    expect(m.lane).toBe(0);
    expect(m.outgoing.map((e) => e.lane)).toEqual([0, 1]);
    expect(f.lane).toBe(1);
    expect(f.through).toEqual([{ lane: 0, color: m.color }]);
    expect(b.lane).toBe(0);
    expect(b.through.map((t) => t.lane)).toEqual([1]);
    // a is awaited by lanes 0 and 1 -> node in lane 0, lane 1 merges in
    expect(a.lane).toBe(0);
    expect(a.incoming.map((e) => e.lane).sort()).toEqual([0, 1]);
  });

  it('handles an octopus merge', () => {
    const { rows } = layoutGraph([c('o', 'a', 'b', 'c'), c('c', 'r'), c('b', 'r'), c('a', 'r'), c('r')]);
    expect(rows[0]!.outgoing.map((e) => e.lane)).toEqual([0, 1, 2]);
    expect(new Set(rows[0]!.outgoing.map((e) => e.color)).size).toBe(3);
    expect(rows[4]!.incoming.map((e) => e.lane).sort()).toEqual([0, 1, 2]);
    expect(rows[4]!.laneCount).toBe(3);
  });

  it('handles criss-cross merges', () => {
    // x merges (a1, b1) and y merges (b1, a1) - crossed
    const { rows } = layoutGraph([c('x', 'a1', 'b1'), c('y', 'b1', 'a1'), c('a1', 'r'), c('b1', 'r'), c('r')]);
    expect(rows[0]!.lane).toBe(0);
    expect(rows[1]!.lane).toBe(2);
    // y's first parent continues in y's lane; its second parent already has lane 0
    expect(rows[1]!.outgoing.map((e) => e.lane)).toEqual([2, 0]);
    expect(rows[2]!.lane).toBe(0);
    expect(rows[3]!.lane).toBe(1);
    expect(rows[4]!.incoming.length).toBe(2);
  });

  it('reuses freed lanes', () => {
    const { rows, state } = layoutGraph([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a', 'z'), c('n', 'z'), c('z')]);
    // after a merges lane 1 back, a lone tip n takes the leftmost free lane
    expect(rows[4]!.lane).toBe(1);
    expect(state.lanes.length).toBeLessThanOrEqual(2);
  });

  it('flags stash nodes and treats them as single-parent', () => {
    const { rows } = layoutGraph([{ sha: 's', parents: ['a'], stash: true }, c('a')]);
    expect(rows[0]!.stash).toBe(true);
    expect(rows[0]!.merge).toBe(false);
  });

  it('marks the lane from a stash down to its base commit as dashed, through rows and the base row', () => {
    const { rows } = layoutGraph([{ sha: 's', parents: ['a'], stash: true }, c('t', 'a'), c('a')]);
    expect(rows[0]!.outgoing[0]!.parentSha).toBe('a');
    // row 1 is another tip: the stash lane runs through it, dashed
    expect(rows[1]!.through.some((l) => l.dashed === true)).toBe(true);
    // row 2 is the base commit: the stash lane arrives dashed, the ordinary lane does not
    expect(rows[2]!.incoming.some((l) => l.dashed === true)).toBe(true);
    expect(rows[2]!.incoming.some((l) => l.dashed !== true)).toBe(true);
  });

  it('gives the same rows when split into pages', () => {
    const all: GraphInput[] = [
      c('m2', 'm1', 'g'),
      c('g', 'e'),
      c('m1', 'd', 'f'),
      c('f', 'e'),
      c('d', 'c'),
      c('e', 'c'),
      c('c', 'b'),
      c('b', 'a'),
      c('a'),
    ];
    const whole = layoutGraph(all).rows;
    for (const size of [1, 2, 3, 4, 7]) {
      let state = emptyGraphState();
      const rows: GraphRow[] = [];
      for (let i = 0; i < all.length; i += size) {
        const r = layoutGraph(all.slice(i, i + size), state);
        state = r.state;
        rows.push(...r.rows);
      }
      expect(rows).toEqual(whole);
    }
  });

  it('does not mutate the previous state', () => {
    const first = layoutGraph([c('b', 'a')]);
    const snapshot = JSON.stringify(first.state);
    layoutGraph([c('a')], first.state);
    expect(JSON.stringify(first.state)).toBe(snapshot);
  });
});

describe('identicon', () => {
  it('is deterministic, case-insensitive and mirrored', () => {
    const a = identicon('Ann@Example.com');
    expect(identicon('ann@example.com')).toEqual(a);
    for (const row of a.cells) expect([row[0], row[1]]).toEqual([row[4], row[3]]);
    expect(identicon('bob@example.com')).not.toEqual(a);
  });
});
