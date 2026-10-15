import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// client/public/theme-boot.js runs before the app on every load. It copies the old GitGit localStorage keys to the GitSlappin names.
const SRC = readFileSync(fileURLToPath(new URL('../../public/theme-boot.js', import.meta.url)), 'utf8');

function fakeStorage(init: Record<string, string>): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  } as Storage;
}
function run(ls: Storage): { attrs: Record<string, string>; zoom: string } {
  const attrs: Record<string, string> = {};
  const doc = { documentElement: { setAttribute: (k: string, v: string) => void (attrs[k] = v), style: { zoom: '' } } };
  new Function('localStorage', 'document', SRC)(ls, doc);
  return { attrs, zoom: doc.documentElement.style.zoom };
}
const dump = (ls: Storage): Record<string, string | null> => Object.fromEntries(Array.from({ length: ls.length }, (_, i) => ls.key(i)!).map((k) => [k, ls.getItem(k)]));

describe('theme-boot.js localStorage copy (gitgit-* -> gitslappin-*)', () => {
  it('copies every old key (also per-repo keys), keeps the old ones, and applies the copied theme and zoom', () => {
    const ls = fakeStorage({ 'gitgit-theme': 'light', 'gitgit-zoom': '1.2', 'gitgit-graph-columns': '{"a":1}', 'gitgit-sidebar-open:abc': '1', other: 'x' });
    const r = run(ls);
    expect(dump(ls)).toEqual({
      'gitgit-theme': 'light', 'gitgit-zoom': '1.2', 'gitgit-graph-columns': '{"a":1}', 'gitgit-sidebar-open:abc': '1', other: 'x',
      'gitslappin-theme': 'light', 'gitslappin-zoom': '1.2', 'gitslappin-graph-columns': '{"a":1}', 'gitslappin-sidebar-open:abc': '1',
    });
    expect(r.attrs['data-theme']).toBe('light');
    expect(r.zoom).toBe('1.2');
  });

  it('never overwrites a new key that already exists', () => {
    const ls = fakeStorage({ 'gitgit-theme': 'light', 'gitslappin-theme': 'dark', 'gitgit-wip-split': '0.4' });
    const r = run(ls);
    expect(ls.getItem('gitslappin-theme')).toBe('dark');
    expect(ls.getItem('gitslappin-wip-split')).toBe('0.4');
    expect(r.attrs['data-theme']).toBe('dark');
  });

  it('does nothing without old keys, and survives blocked storage', () => {
    const ls = fakeStorage({ 'gitslappin-theme': 'dark' });
    run(ls);
    expect(dump(ls)).toEqual({ 'gitslappin-theme': 'dark' });
    const blocked = { get length(): number { throw new Error('blocked'); } } as unknown as Storage;
    expect(() => run(blocked)).not.toThrow();
  });
});
