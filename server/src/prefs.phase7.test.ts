import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREFS_FILE, parsePrefsPatch, readPrefs, updatePrefs } from './prefs';

// Phase 7 shape of prefs.json: only {pullMode}. (server/src/prefs.test.ts is the later phase 12/13 contract.)
function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitslappin-test-prefs7-'));
  if (readdirSync(dir).length !== 0) throw new Error(`not fresh: ${dir}`);
  return dir;
}

describe('pullMode prefs (phase 7)', () => {
  it('defaults to merge when there is no file', () => {
    expect(readPrefs(freshDataDir())).toEqual({ pullMode: 'merge', theme: 'dark', zoom: 1, autoFetchMinutes: 1, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' });
  });

  it('a corrupt file or an invalid stored value falls back to merge without throwing', () => {
    for (const text of ['', '{oops', 'null', '[]', '"rebase"', '\u0000\u0000', JSON.stringify({ pullMode: 'force' }), JSON.stringify({ pullMode: 7 })]) {
      const dir = freshDataDir();
      writeFileSync(join(dir, PREFS_FILE), text);
      expect(readPrefs(dir), JSON.stringify(text)).toEqual({ pullMode: 'merge', theme: 'dark', zoom: 1, autoFetchMinutes: 1, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' });
    }
  });

  it('a corrupt file is repaired by the next valid update', () => {
    const dir = freshDataDir();
    writeFileSync(join(dir, PREFS_FILE), '{oops');
    expect(updatePrefs(dir, { pullMode: 'rebase' })).toEqual({ ok: true, prefs: { pullMode: 'rebase', theme: 'dark', zoom: 1, autoFetchMinutes: 1, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' } });
    expect(JSON.parse(readFileSync(join(dir, PREFS_FILE), 'utf8'))).toEqual({ pullMode: 'rebase', theme: 'dark', zoom: 1, autoFetchMinutes: 1, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' });
  });

  it('accepts only the enum; extra keys are dropped, bad bodies change nothing', () => {
    for (const pullMode of ['merge', 'ff-only', 'rebase']) expect(parsePrefsPatch({ pullMode })).toEqual({ ok: true, patch: { pullMode } });
    expect(parsePrefsPatch({ pullMode: 'rebase', evil: 1 })).toEqual({ ok: true, patch: { pullMode: 'rebase' } });
    for (const b of [null, undefined, 5, 'x', [], {}, { evil: 1 }, { pullMode: 'force' }, { pullMode: '' }, { pullMode: 'MERGE' }, { pullMode: null }, { pullMode: ['merge'] }]) {
      expect(parsePrefsPatch(b).ok, JSON.stringify(b)).toBe(false);
    }
    const dir = freshDataDir();
    expect(updatePrefs(dir, { pullMode: 'force' }).ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes atomically: only prefs.json is left behind and it is valid JSON after every write', () => {
    const dir = freshDataDir();
    const modes = ['merge', 'ff-only', 'rebase'] as const;
    for (let i = 0; i < 30; i++) {
      expect(updatePrefs(dir, { pullMode: modes[i % 3] }).ok).toBe(true);
      expect(readdirSync(dir)).toEqual([PREFS_FILE]);
      expect(JSON.parse(readFileSync(join(dir, PREFS_FILE), 'utf8'))).toEqual({ pullMode: modes[i % 3], theme: 'dark', zoom: 1, autoFetchMinutes: 1, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' });
    }
  });
});
