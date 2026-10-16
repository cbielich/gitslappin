import { describe, expect, it } from 'vitest';
import { reduceSelection, type RowRef, type SelState } from './selection';

/*
 * V4 contract (client/src/lib/selection.ts, pure):
 *   type RowRef = { kind: 'commit'; sha: string } | { kind: 'wip' } | { kind: 'stash'; sha: string }
 *   type Selection = { kind: 'wip' } | { kind: 'commit'; sha: string } | { kind: 'stash'; sha: string } | { kind: 'multi'; shas: string[]; wip: boolean }
 *   interface SelState { selection: Selection | null; anchor: RowRef | null }
 *   reduceSelection(prev: SelState, click: { row: RowRef; shift: boolean; ctrl: boolean }, rows: RowRef[]): SelState
 *     rows = the loaded rows top to bottom (newest first; the WIP row first when it is shown; stash rows where the graph shows them).
 *   Rules:
 *     plain click                  -> single selection of that row; anchor = that row.
 *     ctrl+click on a commit/WIP   -> toggles that row in the set (the WIP row included); anchor = that row.
 *                                     Two or more items -> { kind: 'multi', shas (in ROWS order), wip }.
 *                                     Back to one item -> the plain single selection ({kind:'commit'} or {kind:'wip'}); to none -> null.
 *     shift+click                  -> the range of loaded rows from the anchor to the clicked row, inclusive, in either direction; the anchor stays.
 *                                     The WIP row inside the range sets wip:true; stash rows inside the range are skipped.
 *                                     No anchor, or the anchor is no longer in rows -> behaves like a plain click.
 *     any click with shift/ctrl on a stash row, or while a stash is selected -> plain single selection (stash rows are single-select).
 */

const c = (sha: string): RowRef => ({ kind: 'commit', sha });
const WIP: RowRef = { kind: 'wip' };
const st = (sha: string): RowRef => ({ kind: 'stash', sha });
const rows: RowRef[] = [WIP, c('c5'), c('c4'), st('s1'), c('c3'), c('c2'), c('c1')];
const NONE: SelState = { selection: null, anchor: null };
const click = (prev: SelState, row: RowRef, mods: { shift?: boolean; ctrl?: boolean } = {}): SelState =>
  reduceSelection(prev, { row, shift: mods.shift === true, ctrl: mods.ctrl === true }, rows);

describe('plain click', () => {
  it('selects one commit, the WIP row, or a stash, and sets the anchor', () => {
    expect(click(NONE, c('c4'))).toEqual({ selection: { kind: 'commit', sha: 'c4' }, anchor: c('c4') });
    expect(click(NONE, WIP)).toEqual({ selection: { kind: 'wip' }, anchor: WIP });
    expect(click(NONE, st('s1'))).toEqual({ selection: { kind: 'stash', sha: 's1' }, anchor: st('s1') });
  });
  it('replaces a multi selection', () => {
    const multi = click(click(NONE, c('c5')), c('c3'), { ctrl: true });
    expect(multi.selection?.kind).toBe('multi');
    expect(click(multi, c('c1')).selection).toEqual({ kind: 'commit', sha: 'c1' });
  });
});

describe('ctrl+click toggles', () => {
  it('adds a second commit: multi with shas in rows order (not click order)', () => {
    const s = click(click(NONE, c('c3')), c('c5'), { ctrl: true });
    expect(s.selection).toEqual({ kind: 'multi', shas: ['c5', 'c3'], wip: false });
  });
  it('toggles the WIP row in and out', () => {
    const one = click(NONE, c('c4'));
    const withWip = click(one, WIP, { ctrl: true });
    expect(withWip.selection).toEqual({ kind: 'multi', shas: ['c4'], wip: true });
    const back = click(withWip, WIP, { ctrl: true });
    expect(back.selection).toEqual({ kind: 'commit', sha: 'c4' });
  });
  it('removing a commit from a multi of three leaves a multi of two; down to one collapses to a single selection; to none -> null', () => {
    let s = click(NONE, c('c5'));
    s = click(s, c('c4'), { ctrl: true });
    s = click(s, c('c3'), { ctrl: true });
    expect(s.selection).toEqual({ kind: 'multi', shas: ['c5', 'c4', 'c3'], wip: false });
    s = click(s, c('c4'), { ctrl: true });
    expect(s.selection).toEqual({ kind: 'multi', shas: ['c5', 'c3'], wip: false });
    s = click(s, c('c5'), { ctrl: true });
    expect(s.selection).toEqual({ kind: 'commit', sha: 'c3' });
    s = click(s, c('c3'), { ctrl: true });
    expect(s.selection).toBeNull();
  });
  it('WIP alone after removing the commits collapses to {kind:wip}', () => {
    let s = click(NONE, WIP);
    s = click(s, c('c4'), { ctrl: true });
    expect(s.selection).toEqual({ kind: 'multi', shas: ['c4'], wip: true });
    s = click(s, c('c4'), { ctrl: true });
    expect(s.selection).toEqual({ kind: 'wip' });
  });
});

describe('shift+click selects the range of loaded rows', () => {
  it('from the anchor downwards, inclusive, skipping stash rows', () => {
    const s = click(click(NONE, c('c5')), c('c2'), { shift: true });
    expect(s.selection).toEqual({ kind: 'multi', shas: ['c5', 'c4', 'c3', 'c2'], wip: false });
    expect(s.anchor).toEqual(c('c5')); // the anchor stays
  });
  it('upwards works the same, and includes the WIP row when the range reaches it', () => {
    const s = click(click(NONE, c('c4')), WIP, { shift: true });
    expect(s.selection).toEqual({ kind: 'multi', shas: ['c5', 'c4'], wip: true });
  });
  it('a second shift+click re-ranges from the same anchor', () => {
    let s = click(click(NONE, c('c5')), c('c2'), { shift: true });
    s = click(s, c('c4'), { shift: true });
    expect(s.selection).toEqual({ kind: 'multi', shas: ['c5', 'c4'], wip: false });
  });
  it('no anchor, or an anchor that is not loaded any more, acts like a plain click', () => {
    expect(click(NONE, c('c3'), { shift: true }).selection).toEqual({ kind: 'commit', sha: 'c3' });
    const gone: SelState = { selection: { kind: 'commit', sha: 'zz' }, anchor: c('zz') };
    expect(click(gone, c('c3'), { shift: true }).selection).toEqual({ kind: 'commit', sha: 'c3' });
  });
  it('a range of one row is a single selection, not a multi', () => {
    const s = click(click(NONE, c('c4')), c('c4'), { shift: true });
    expect(s.selection).toEqual({ kind: 'commit', sha: 'c4' });
  });
});

describe('stash rows are single-select', () => {
  it('ctrl+click or shift+click on a stash row selects only that stash', () => {
    const base = click(NONE, c('c5'));
    expect(click(base, st('s1'), { ctrl: true }).selection).toEqual({ kind: 'stash', sha: 's1' });
    expect(click(base, st('s1'), { shift: true }).selection).toEqual({ kind: 'stash', sha: 's1' });
  });
  it('ctrl+click on a commit while a stash is selected selects only that commit', () => {
    const base = click(NONE, st('s1'));
    expect(click(base, c('c3'), { ctrl: true }).selection).toEqual({ kind: 'commit', sha: 'c3' });
  });
});
