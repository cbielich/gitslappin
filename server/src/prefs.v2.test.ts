import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, PREFS_FILE, parsePrefsPatch, readPrefs, updatePrefs } from './prefs';

/*
 * V2: Prefs gets `autoFetchMinutes`: an integer from 0 to 60, default 1 (0 = auto-fetch off). Same rules as the other keys: strict
 * validation, never spread, invalid stored value falls back per field, atomic write.
 * NOTE for the builder: prefs.test.ts, prefs.phase7.test.ts and tests/e2e/remotes.spec.ts assert the stored shape {pullMode, theme, zoom};
 * they will need `autoFetchMinutes: 1` added once this key exists (they are not changed here).
 */

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitslappin-test-prefs-v2-'));
  if (!dir.startsWith(tmpdir()) || readdirSync(dir).length !== 0) throw new Error(`not fresh: ${dir}`);
  return dir;
}
const file = (dir: string) => join(dir, PREFS_FILE);
const stored = (dir: string) => JSON.parse(readFileSync(file(dir), 'utf8')) as Record<string, unknown>;

describe('autoFetchMinutes default', () => {
  it('is 1 in DEFAULT_PREFS and when there is no file', () => {
    expect(DEFAULT_PREFS).toEqual({ pullMode: 'merge', theme: 'dark', zoom: 1, autoFetchMinutes: 1, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' });
    expect(readPrefs(freshDataDir())).toEqual(DEFAULT_PREFS);
  });

  it('a corrupt file falls back to 1 without throwing', () => {
    for (const text of ['', '{oops', 'null', '[]', '"x"', '\u0000\u0000']) {
      const dir = freshDataDir();
      writeFileSync(file(dir), text);
      expect(readPrefs(dir).autoFetchMinutes, JSON.stringify(text)).toBe(1);
    }
  });

  it('a stored value that is invalid falls back to 1 per field and keeps the valid fields', () => {
    for (const bad of [61, -1, 1.5, '1', null, 1e9, [5]]) {
      const dir = freshDataDir();
      writeFileSync(file(dir), JSON.stringify({ pullMode: 'rebase', theme: 'light', zoom: 1.2, autoFetchMinutes: bad }));
      expect(readPrefs(dir), JSON.stringify(bad)).toEqual({ pullMode: 'rebase', theme: 'light', zoom: 1.2, autoFetchMinutes: 1, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' });
    }
  });

  it('an older prefs.json without the key reads as 1 and keeps its other values', () => {
    const dir = freshDataDir();
    writeFileSync(file(dir), JSON.stringify({ pullMode: 'ff-only', theme: 'light', zoom: 0.9 }));
    expect(readPrefs(dir)).toEqual({ pullMode: 'ff-only', theme: 'light', zoom: 0.9, autoFetchMinutes: 1, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' });
  });

  it('a stored valid value is read back (0 and 60 included)', () => {
    for (const v of [0, 1, 7, 60]) {
      const dir = freshDataDir();
      writeFileSync(file(dir), JSON.stringify({ autoFetchMinutes: v }));
      expect(readPrefs(dir).autoFetchMinutes).toBe(v);
    }
  });
});

describe('autoFetchMinutes validation', () => {
  it('accepts every integer from 0 to 60', () => {
    for (let n = 0; n <= 60; n++) expect(parsePrefsPatch({ autoFetchMinutes: n }), String(n)).toEqual({ ok: true, patch: { autoFetchMinutes: n } });
  });

  it('rejects 61, -1, fractions, strings, NaN, Infinity, null, arrays, objects, booleans', () => {
    const bad: unknown[] = [
      { autoFetchMinutes: 61 }, { autoFetchMinutes: -1 }, { autoFetchMinutes: 1.5 }, { autoFetchMinutes: 0.5 }, { autoFetchMinutes: 60.0001 },
      { autoFetchMinutes: '1' }, { autoFetchMinutes: '' }, { autoFetchMinutes: NaN }, { autoFetchMinutes: Infinity }, { autoFetchMinutes: -Infinity },
      { autoFetchMinutes: null }, { autoFetchMinutes: [1] }, { autoFetchMinutes: { a: 1 } }, { autoFetchMinutes: true }, { autoFetchMinutes: 1e21 },
    ];
    for (const b of bad) expect(parsePrefsPatch(b).ok, JSON.stringify(b)).toBe(false);
  });

  it('a valid key next to an invalid autoFetchMinutes rejects the whole patch and writes nothing', () => {
    const dir = freshDataDir();
    expect(updatePrefs(dir, { theme: 'light', autoFetchMinutes: 61 }).ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('unknown keys are still dropped (no spreading)', () => {
    const res = parsePrefsPatch(JSON.parse('{"autoFetchMinutes":5,"evil":"x","__proto__":{"polluted":true}}'));
    expect(res).toEqual({ ok: true, patch: { autoFetchMinutes: 5 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('autoFetchMinutes merge and storage', () => {
  it('updates only its own key and keeps the others; the stored file has exactly the four keys', () => {
    const dir = freshDataDir();
    updatePrefs(dir, { pullMode: 'rebase', theme: 'light', zoom: 1.3 });
    const res = updatePrefs(dir, { autoFetchMinutes: 0 });
    expect(res).toEqual({ ok: true, prefs: { pullMode: 'rebase', theme: 'light', zoom: 1.3, autoFetchMinutes: 0, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' } });
    expect(Object.keys(stored(dir)).sort()).toEqual(['autoFetchMinutes', 'pullMode', 'terminalCursor', 'terminalFontSize', 'terminalShell', 'theme', 'zoom']);
    expect(stored(dir).autoFetchMinutes).toBe(0); // 0 is stored as 0, not turned into the default
    expect(readPrefs(dir).autoFetchMinutes).toBe(0);
  });

  it('a theme-only update keeps a saved autoFetchMinutes of 60', () => {
    const dir = freshDataDir();
    updatePrefs(dir, { autoFetchMinutes: 60 });
    expect(updatePrefs(dir, { theme: 'light' })).toEqual({ ok: true, prefs: { pullMode: 'merge', theme: 'light', zoom: 1, autoFetchMinutes: 60, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' } });
  });

  it('a rejected update leaves the stored file byte for byte unchanged', () => {
    const dir = freshDataDir();
    updatePrefs(dir, { autoFetchMinutes: 5 });
    const before = readFileSync(file(dir), 'utf8');
    expect(updatePrefs(dir, { autoFetchMinutes: -1 }).ok).toBe(false);
    expect(readFileSync(file(dir), 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual([PREFS_FILE]);
  });
});
