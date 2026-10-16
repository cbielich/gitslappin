import { describe, expect, it } from 'vitest';
import { parseVisibility } from './visibility';

/*
 * V5c. Names the builder must implement: server/src/visibility.ts
 *   parseVisibility(input: unknown): { hidden: string[]; solo: string[]; hideStashes: boolean } | null     (null = refuse; a refused PUT body is a 400)
 * Rules (design V5c): hidden and solo are arrays of <= 5000 strings; each entry starts with refs/heads/, refs/remotes/ or refs/tags/, is <= 1024 characters and has
 * no control characters; hideStashes is a boolean. The same function is used for the PUT body and for the entries read back from graph-visibility.json.
 */

const ok = { hidden: ['refs/heads/a', 'refs/remotes/origin/a', 'refs/tags/v1'], solo: ['refs/heads/b'], hideStashes: true };

describe('parseVisibility', () => {
  it('accepts a good value and returns it unchanged', () => {
    expect(parseVisibility(ok)).toEqual(ok);
    expect(parseVisibility({ hidden: [], solo: [], hideStashes: false })).toEqual({ hidden: [], solo: [], hideStashes: false });
  });

  it('refuses an entry with a bad prefix', () => {
    for (const bad of ['heads/a', 'refs/stash', 'refs/notes/x', 'refs/gitslappin/undo/abc', 'refs/heads', 'HEAD', 'main', '', ' refs/heads/a', '-refs/heads/a', '--all']) {
      expect(parseVisibility({ ...ok, hidden: [bad] }), `hidden ${JSON.stringify(bad)}`).toBeNull();
      expect(parseVisibility({ ...ok, solo: [bad] }), `solo ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('refuses control characters anywhere in an entry', () => {
    for (const ch of ['\0', '\n', '\r', '\t', '\u001b', '\u001f']) {
      expect(parseVisibility({ ...ok, hidden: [`refs/heads/a${ch}b`] }), JSON.stringify(ch)).toBeNull();
      expect(parseVisibility({ ...ok, solo: [`refs/tags/${ch}`] }), JSON.stringify(ch)).toBeNull();
    }
  });

  it('refuses an entry longer than 1024 characters and accepts exactly 1024', () => {
    const at = (n: number): string => `refs/heads/${'a'.repeat(n - 'refs/heads/'.length)}`;
    expect(parseVisibility({ ...ok, hidden: [at(1024)] })).not.toBeNull();
    expect(parseVisibility({ ...ok, hidden: [at(1025)] })).toBeNull();
    expect(parseVisibility({ ...ok, solo: [at(1025)] })).toBeNull();
  });

  it('refuses more than 5000 entries in either array and accepts exactly 5000', () => {
    const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `refs/tags/t${i}`);
    expect(parseVisibility({ ...ok, hidden: many(5000) })).not.toBeNull();
    expect(parseVisibility({ ...ok, hidden: many(5001) })).toBeNull();
    expect(parseVisibility({ ...ok, solo: many(5001) })).toBeNull();
  });

  it('refuses wrong types', () => {
    for (const bad of [null, undefined, 5, 'x', [], true, [ok]]) expect(parseVisibility(bad), JSON.stringify(bad)).toBeNull();
    expect(parseVisibility({ ...ok, hidden: 'refs/heads/a' })).toBeNull();
    expect(parseVisibility({ ...ok, hidden: { 0: 'refs/heads/a' } })).toBeNull();
    expect(parseVisibility({ ...ok, hidden: [1] })).toBeNull();
    expect(parseVisibility({ ...ok, hidden: [null] })).toBeNull();
    expect(parseVisibility({ ...ok, hidden: [['refs/heads/a']] })).toBeNull();
    expect(parseVisibility({ ...ok, solo: 'x' })).toBeNull();
    expect(parseVisibility({ ...ok, solo: [{}] })).toBeNull();
    expect(parseVisibility({ ...ok, hideStashes: 'yes' })).toBeNull();
    expect(parseVisibility({ ...ok, hideStashes: 1 })).toBeNull();
    expect(parseVisibility({ hidden: ok.hidden, solo: ok.solo })).toBeNull(); // hideStashes missing
  });

  it('a prototype-polluting body does not leak into the result', () => {
    const r = parseVisibility(JSON.parse('{"hidden":[],"solo":[],"hideStashes":false,"__proto__":{"hidden":["refs/heads/x"]},"constructor":{"x":1}}'));
    expect(r).toEqual({ hidden: [], solo: [], hideStashes: false });
    expect(({} as Record<string, unknown>).hidden).toBeUndefined();
  });
});
