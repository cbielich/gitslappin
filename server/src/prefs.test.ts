import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Phase 12/13 (not built yet). Expected exports of ./prefs (stored in <dataDir>\prefs.json as {pullMode, theme, zoom}):
//   PREFS_FILE = 'prefs.json'
//   DEFAULT_PREFS = {pullMode:'merge', theme:'dark', zoom:1}
//   readPrefs(dataDir): Prefs                     (missing or corrupt file -> DEFAULT_PREFS; invalid stored fields fall back per field)
//   parsePrefsPatch(body: unknown): {ok:true, patch: Partial<Prefs>} | {ok:false, error:string}
//        accepts only pullMode 'merge'|'ff-only'|'rebase', theme 'dark'|'light', zoom 0.8..1.5 in 0.1 steps; unknown keys are ignored (never spread);
//        any invalid value for a known key, or no valid key at all, is {ok:false}
//   updatePrefs(dataDir, body: unknown): {ok:true, prefs: Prefs} | {ok:false, error:string}   (merges the validated subset into the stored prefs; atomic write: temp file + rename)
import { DEFAULT_PREFS, PREFS_FILE, parsePrefsPatch, readPrefs, updatePrefs } from './prefs';

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitslappin-test-prefs-'));
  if (!dir.startsWith(tmpdir()) || readdirSync(dir).length !== 0) throw new Error(`not fresh: ${dir}`);
  return dir;
}
const file = (dir: string) => join(dir, PREFS_FILE);
const stored = (dir: string) => JSON.parse(readFileSync(file(dir), 'utf8')) as Record<string, unknown>;

describe('defaults and corrupt file', () => {
  it('defaults when there is no file', () => {
    expect(PREFS_FILE).toBe('prefs.json');
    expect(DEFAULT_PREFS).toEqual({ pullMode: 'merge', theme: 'dark', zoom: 1 });
    expect(readPrefs(freshDataDir())).toEqual(DEFAULT_PREFS);
  });

  it('a corrupt file falls back to the defaults without throwing', () => {
    for (const text of ['', '{oops', 'null', '[]', '"light"', '\u0000\u0000']) {
      const dir = freshDataDir();
      writeFileSync(file(dir), text);
      expect(readPrefs(dir), JSON.stringify(text)).toEqual(DEFAULT_PREFS);
    }
  });

  it('invalid stored values fall back per field and keep the valid ones', () => {
    const dir = freshDataDir();
    writeFileSync(file(dir), JSON.stringify({ pullMode: 'rebase', theme: 'neon', zoom: 9 }));
    expect(readPrefs(dir)).toEqual({ pullMode: 'rebase', theme: 'dark', zoom: 1 });
  });

  it('a corrupt file is repaired by the next valid update', () => {
    const dir = freshDataDir();
    writeFileSync(file(dir), '{oops');
    const res = updatePrefs(dir, { theme: 'light' });
    expect(res).toEqual({ ok: true, prefs: { pullMode: 'merge', theme: 'light', zoom: 1 } });
    expect(stored(dir)).toEqual({ pullMode: 'merge', theme: 'light', zoom: 1 });
  });
});

describe('validation', () => {
  it('accepts every allowed value', () => {
    for (const pullMode of ['merge', 'ff-only', 'rebase']) expect(parsePrefsPatch({ pullMode })).toEqual({ ok: true, patch: { pullMode } });
    for (const theme of ['dark', 'light']) expect(parsePrefsPatch({ theme })).toEqual({ ok: true, patch: { theme } });
    for (const zoom of [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]) expect(parsePrefsPatch({ zoom }), String(zoom)).toEqual({ ok: true, patch: { zoom } });
  });

  it('rejects bad pullMode, theme and zoom values', () => {
    const bad: unknown[] = [
      { pullMode: 'force' }, { pullMode: 'MERGE' }, { pullMode: 7 }, { pullMode: null }, { pullMode: ['merge'] },
      { theme: 'Dark' }, { theme: 'blue' }, { theme: '' }, { theme: 1 }, { theme: null },
      { zoom: 0.7 }, { zoom: 1.6 }, { zoom: 0 }, { zoom: -1 }, { zoom: 1.05 }, { zoom: 1.15 }, { zoom: '1' }, { zoom: NaN }, { zoom: Infinity }, { zoom: null }, { zoom: [1] },
    ];
    for (const b of bad) expect(parsePrefsPatch(b).ok, JSON.stringify(b)).toBe(false);
  });

  it('a valid key next to an invalid one rejects the whole patch (nothing is stored)', () => {
    const dir = freshDataDir();
    expect(updatePrefs(dir, { theme: 'light', zoom: 3 }).ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]); // nothing written at all
  });

  it('non-object bodies and empty patches are rejected', () => {
    for (const b of [null, undefined, 5, 'x', [], [{ theme: 'light' }], {}, { evil: 1 }]) expect(parsePrefsPatch(b).ok, JSON.stringify(b)).toBe(false);
  });

  it('unknown keys are dropped and never spread (no prototype pollution)', () => {
    const body = JSON.parse('{"theme":"light","evil":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    const res = parsePrefsPatch(body);
    expect(res).toEqual({ ok: true, patch: { theme: 'light' } });
    const dir = freshDataDir();
    updatePrefs(dir, body);
    expect(Object.keys(stored(dir)).sort()).toEqual(['pullMode', 'theme', 'zoom']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('merge rule', () => {
  it('a theme-only update keeps pullMode and zoom', () => {
    const dir = freshDataDir();
    expect(updatePrefs(dir, { pullMode: 'rebase' }).ok).toBe(true);
    expect(updatePrefs(dir, { zoom: 1.3 }).ok).toBe(true);
    const res = updatePrefs(dir, { theme: 'light' });
    expect(res).toEqual({ ok: true, prefs: { pullMode: 'rebase', theme: 'light', zoom: 1.3 } });
    expect(readPrefs(dir)).toEqual({ pullMode: 'rebase', theme: 'light', zoom: 1.3 });
    expect(stored(dir)).toEqual({ pullMode: 'rebase', theme: 'light', zoom: 1.3 });
  });

  it('a pullMode-only update keeps theme and zoom', () => {
    const dir = freshDataDir();
    updatePrefs(dir, { theme: 'light', zoom: 0.8 });
    expect(updatePrefs(dir, { pullMode: 'ff-only' })).toEqual({ ok: true, prefs: { pullMode: 'ff-only', theme: 'light', zoom: 0.8 } });
  });

  it('a rejected update leaves the stored file byte-for-byte unchanged', () => {
    const dir = freshDataDir();
    updatePrefs(dir, { theme: 'light' });
    const before = readFileSync(file(dir), 'utf8');
    expect(updatePrefs(dir, { zoom: 2 }).ok).toBe(false);
    expect(readFileSync(file(dir), 'utf8')).toBe(before);
  });
});

describe('atomic write', () => {
  it('leaves only prefs.json in the data dir (no temp file) and valid JSON after each write', () => {
    const dir = freshDataDir();
    for (const theme of ['light', 'dark', 'light'] as const) {
      expect(updatePrefs(dir, { theme }).ok).toBe(true);
      expect(readdirSync(dir)).toEqual([PREFS_FILE]);
      expect(stored(dir).theme).toBe(theme);
    }
  });

  it('many back-to-back updates never leave a partial file', () => {
    const dir = freshDataDir();
    const zooms = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
    for (let i = 0; i < 40; i++) {
      updatePrefs(dir, { zoom: zooms[i % zooms.length] });
      expect(() => stored(dir)).not.toThrow();
    }
    expect(readdirSync(dir)).toEqual([PREFS_FILE]);
  });

  it('does not write outside the data dir', () => {
    const dir = freshDataDir();
    updatePrefs(dir, { theme: 'light' });
    expect(readdirSync(dir)).toEqual([PREFS_FILE]);
  });
});
