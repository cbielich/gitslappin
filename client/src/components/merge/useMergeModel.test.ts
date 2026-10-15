import { describe, expect, it } from 'vitest';
import { reconcileTakes, takeText } from './useMergeModel';

const c = { a: ['A1\n', 'A2\n'], b: ['B1\n'] };
const none = { a: false, b: false };

describe('takeText', () => {
  it('joins the taken sides in A then B order', () => {
    expect(takeText(c, { a: true, b: true })).toBe('A1\nA2\nB1\n');
    expect(takeText(c, { a: false, b: true })).toBe('B1\n');
    expect(takeText(c, none)).toBe('');
  });
  it('puts a newline between A and B when A ends without an EOL', () => {
    expect(takeText({ a: ['A last'], b: ['B1\n'] }, { a: true, b: true })).toBe('A last\nB1\n');
    expect(takeText({ a: ['A last'], b: ['B1\n'] }, { a: true, b: false })).toBe('A last');
  });
});

describe('reconcileTakes (Undo inside the output)', () => {
  it('clears a take whose text no longer matches (undo back to empty)', () => {
    const r = reconcileTakes([c], [{ a: true, b: false }], [false], [0], ['']);
    expect(r.takes[0]).toEqual(none);
    expect(r.edited[0]).toBe(false); // empty and not ticked: unresolved
  });
  it('moves the take to the side whose text matches', () => {
    const r = reconcileTakes([c], [{ a: true, b: true }], [false], [0], ['A1\nA2\n']);
    expect(r.takes[0]).toEqual({ a: true, b: false });
  });
  it('keeps a take whose text still matches', () => {
    const r = reconcileTakes([c], [{ a: false, b: true }], [false], [0], ['B1\n']);
    expect(r.takes[0]).toEqual({ a: false, b: true });
  });
  it('typed text that matches no take clears the tick and counts as edited', () => {
    const r = reconcileTakes([c], [{ a: true, b: false }], [false], [0], ['A1\nmine\n']);
    expect(r.takes[0]).toEqual(none);
    expect(r.edited[0]).toBe(true);
  });
  it('an edited region emptied again is unresolved', () => {
    const r = reconcileTakes([c], [none], [true], [0], ['']);
    expect(r.edited[0]).toBe(false);
  });
  it('regions the change did not touch keep their edited flag', () => {
    const r = reconcileTakes([c, c], [none, none], [true, false], [1], ['x', 'B1\n']);
    expect(r.edited).toEqual([true, false]);
    expect(r.takes[1]).toEqual({ a: false, b: true });
  });
  it('a take of an empty side stays ticked while the region is empty', () => {
    const r = reconcileTakes([{ a: [], b: ['B\n'] }], [{ a: true, b: false }], [false], [0], ['']);
    expect(r.takes[0]).toEqual({ a: true, b: false });
  });
});
