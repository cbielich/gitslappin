import { describe, expect, it } from 'vitest';
import { UNSTAGE_CHUNK, chunk } from './chunk';

describe('chunk (review fix 7: Unstage All is sent in pieces)', () => {
  it('splits 12,001 paths into 5k, 5k and 2,001 without losing or reordering any', () => {
    const paths = Array.from({ length: 12_001 }, (_, i) => `f${i}.txt`);
    const parts = chunk(paths, UNSTAGE_CHUNK);
    expect(UNSTAGE_CHUNK).toBe(5000);
    expect(parts.map((p) => p.length)).toEqual([5000, 5000, 2001]);
    expect(parts.flat()).toEqual(paths);
  });
  it('an exact multiple has no empty tail, and an empty list gives no requests', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
    expect(chunk([], 5000)).toEqual([]);
  });
});
