import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, PREFS_FILE, parsePrefsPatch, readPrefs, updatePrefs } from './prefs';

/*
 * V6b prefs "In-App Terminal" (screen 42e). Three new keys on Prefs (shared/src/git.ts) and in prefs.ts, same rules as the others
 * (strict validation, never spread, invalid stored value falls back per field, atomic write):
 *   terminalShell:    'powershell' | 'bash'                 default 'powershell'   (Default In-App Terminal)
 *   terminalFontSize: integer 10..24                        default 13
 *   terminalCursor:   'block' | 'underline' | 'bar'         default 'block'
 * NOTE for the builder: prefs.test.ts, prefs.phase7.test.ts, prefs.v2.test.ts and tests/e2e/remotes.spec.ts assert the exact stored/default shape
 * (four keys); they need the three new keys added. This file only checks the new keys, so it is not affected by the other keys.
 */

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitslappin-test-prefs-term-'));
  if (!dir.startsWith(tmpdir()) || readdirSync(dir).length !== 0) throw new Error(`not fresh: ${dir}`);
  return dir;
}
const file = (dir: string) => join(dir, PREFS_FILE);
const stored = (dir: string) => JSON.parse(readFileSync(file(dir), 'utf8')) as Record<string, unknown>;
const KEYS = ['terminalShell', 'terminalFontSize', 'terminalCursor'] as const;

describe('terminal prefs defaults', () => {
  it('DEFAULT_PREFS and a missing file give powershell, 13, block', () => {
    for (const p of [DEFAULT_PREFS, readPrefs(freshDataDir())]) {
      expect(p).toMatchObject({ terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' });
    }
  });

  it('a corrupt file falls back without throwing', () => {
    for (const text of ['', '{oops', 'null', '[]', '"x"']) {
      const dir = freshDataDir();
      writeFileSync(file(dir), text);
      expect(readPrefs(dir), JSON.stringify(text)).toMatchObject({ terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' });
    }
  });

  it('an invalid stored value falls back per field and keeps the valid ones', () => {
    const dir = freshDataDir();
    writeFileSync(file(dir), JSON.stringify({ theme: 'light', terminalShell: 'cmd', terminalFontSize: 99, terminalCursor: 'bar' }));
    expect(readPrefs(dir)).toMatchObject({ theme: 'light', terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'bar' });
  });

  it('an older prefs.json without the keys reads as the defaults and keeps its other values', () => {
    const dir = freshDataDir();
    writeFileSync(file(dir), JSON.stringify({ pullMode: 'rebase', theme: 'light', zoom: 1.2 }));
    expect(readPrefs(dir)).toMatchObject({ pullMode: 'rebase', theme: 'light', zoom: 1.2, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' });
  });

  it('stored valid values are read back (font size 10 and 24 included)', () => {
    for (const v of [10, 13, 24]) {
      const dir = freshDataDir();
      writeFileSync(file(dir), JSON.stringify({ terminalFontSize: v, terminalShell: 'bash', terminalCursor: 'underline' }));
      expect(readPrefs(dir)).toMatchObject({ terminalFontSize: v, terminalShell: 'bash', terminalCursor: 'underline' });
    }
  });
});

describe('terminal prefs validation', () => {
  it('accepts every font size 10..24, both shells and all three cursors', () => {
    for (let n = 10; n <= 24; n++) expect(parsePrefsPatch({ terminalFontSize: n }), String(n)).toEqual({ ok: true, patch: { terminalFontSize: n } });
    for (const s of ['powershell', 'bash']) expect(parsePrefsPatch({ terminalShell: s })).toEqual({ ok: true, patch: { terminalShell: s } });
    for (const c of ['block', 'underline', 'bar']) expect(parsePrefsPatch({ terminalCursor: c })).toEqual({ ok: true, patch: { terminalCursor: c } });
  });

  it('rejects bad font sizes', () => {
    const bad: unknown[] = [9, 25, 0, -13, 13.5, '13', '', NaN, Infinity, null, [13], { a: 1 }, true, 1e21];
    for (const v of bad) expect(parsePrefsPatch({ terminalFontSize: v }).ok, JSON.stringify(v)).toBe(false);
  });

  it('rejects bad shells: anything but the two names, so a path can never be stored', () => {
    const bad: unknown[] = ['cmd', 'PowerShell', 'C:\\Windows\\System32\\cmd.exe', '/bin/sh', '', null, 1, ['bash'], { a: 1 }, true];
    for (const v of bad) expect(parsePrefsPatch({ terminalShell: v }).ok, JSON.stringify(v)).toBe(false);
  });

  it('rejects bad cursors', () => {
    const bad: unknown[] = ['Block', 'line', 'beam', '', null, 0, [], {}];
    for (const v of bad) expect(parsePrefsPatch({ terminalCursor: v }).ok, JSON.stringify(v)).toBe(false);
  });

  it('a valid key next to an invalid terminal key rejects the whole patch and writes nothing', () => {
    const dir = freshDataDir();
    expect(updatePrefs(dir, { theme: 'light', terminalFontSize: 99 }).ok).toBe(false);
    expect(updatePrefs(dir, { terminalCursor: 'bar', terminalShell: 'cmd' }).ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('unknown keys are still dropped (no spreading)', () => {
    const res = parsePrefsPatch(JSON.parse('{"terminalFontSize":14,"evil":"x","__proto__":{"polluted":true}}'));
    expect(res).toEqual({ ok: true, patch: { terminalFontSize: 14 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('the cut options are not accepted: dim-when-unfocused and autocomplete are unknown keys', () => {
    expect(parsePrefsPatch({ terminalDim: true })).toEqual({ ok: false, error: expect.any(String) });
    expect(parsePrefsPatch({ terminalAutocomplete: true }).ok).toBe(false);
  });
});

describe('terminal prefs merge and storage', () => {
  it('updates only its own key, keeps the others, and stores the three keys', () => {
    const dir = freshDataDir();
    updatePrefs(dir, { theme: 'light', pullMode: 'rebase' });
    const res = updatePrefs(dir, { terminalFontSize: 18 });
    expect(res.ok).toBe(true);
    expect(readPrefs(dir)).toMatchObject({ theme: 'light', pullMode: 'rebase', terminalFontSize: 18, terminalShell: 'powershell', terminalCursor: 'block' });
    for (const k of KEYS) expect(Object.keys(stored(dir))).toContain(k);
  });

  it('a theme-only update keeps saved terminal values', () => {
    const dir = freshDataDir();
    updatePrefs(dir, { terminalFontSize: 24, terminalCursor: 'bar', terminalShell: 'bash' });
    updatePrefs(dir, { theme: 'light' });
    expect(readPrefs(dir)).toMatchObject({ theme: 'light', terminalFontSize: 24, terminalCursor: 'bar', terminalShell: 'bash' });
  });

  it('a rejected update leaves the stored file byte for byte unchanged', () => {
    const dir = freshDataDir();
    updatePrefs(dir, { terminalFontSize: 15 });
    const before = readFileSync(file(dir), 'utf8');
    expect(updatePrefs(dir, { terminalFontSize: 9 }).ok).toBe(false);
    expect(readFileSync(file(dir), 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual([PREFS_FILE]);
  });
});
