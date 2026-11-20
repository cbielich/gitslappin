import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, PREFS_FILE, parsePrefsPatch, readPrefs, updatePrefs } from './prefs';

/*
 * Commit File Menu and Editor, P1 "Prefs": `promptBeforeRestoreFile: boolean`, default true (shared/src/git.ts Prefs, prefs.ts DEFAULT_PREFS,
 * readPrefs, parsePrefsPatch). Same rules as the other keys: strict validation, invalid stored value falls back to the default, never spread.
 * Fixtures: mkdtemp under os.tmpdir() only; nothing is deleted.
 */

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitslappin-test-prefs-restorefile-'));
  if (!dir.startsWith(tmpdir()) || readdirSync(dir).length !== 0) throw new Error(`not fresh: ${dir}`);
  return dir;
}
const file = (dir: string) => join(dir, PREFS_FILE);
const stored = (dir: string) => JSON.parse(readFileSync(file(dir), 'utf8')) as Record<string, unknown>;

describe('promptBeforeRestoreFile', () => {
  it('is true in DEFAULT_PREFS and when there is no file', () => {
    expect(DEFAULT_PREFS.promptBeforeRestoreFile).toBe(true);
    expect(readPrefs(freshDataDir()).promptBeforeRestoreFile).toBe(true);
  });

  it('a corrupt file falls back to true without throwing', () => {
    for (const text of ['', '{oops', 'null', '[]', '"x"']) {
      const dir = freshDataDir();
      writeFileSync(file(dir), text);
      expect(readPrefs(dir).promptBeforeRestoreFile, JSON.stringify(text)).toBe(true);
    }
  });

  it('a stored false is read back as false; an invalid stored value falls back to true per field', () => {
    const dir = freshDataDir();
    writeFileSync(file(dir), JSON.stringify({ theme: 'light', promptBeforeRestoreFile: false }));
    expect(readPrefs(dir)).toMatchObject({ theme: 'light', promptBeforeRestoreFile: false });
    for (const bad of ['false', 'no', 0, 1, null, [], {}]) {
      const d = freshDataDir();
      writeFileSync(file(d), JSON.stringify({ theme: 'light', promptBeforeRestoreFile: bad }));
      expect(readPrefs(d), JSON.stringify(bad)).toMatchObject({ theme: 'light', promptBeforeRestoreFile: true });
    }
  });

  it('parsePrefsPatch accepts only booleans', () => {
    expect(parsePrefsPatch({ promptBeforeRestoreFile: false })).toEqual({ ok: true, patch: { promptBeforeRestoreFile: false } });
    expect(parsePrefsPatch({ promptBeforeRestoreFile: true })).toEqual({ ok: true, patch: { promptBeforeRestoreFile: true } });
    for (const bad of ['false', 'true', 0, 1, null, undefined, [], {}, 'yes']) {
      expect(parsePrefsPatch({ promptBeforeRestoreFile: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('updatePrefs stores false atomically, keeps the other keys, and a bad value stores nothing', () => {
    const dir = freshDataDir();
    expect(updatePrefs(dir, { theme: 'light' }).ok).toBe(true);
    const res = updatePrefs(dir, { promptBeforeRestoreFile: false });
    expect(res).toEqual({ ok: true, prefs: { ...DEFAULT_PREFS, theme: 'light', promptBeforeRestoreFile: false } });
    expect(stored(dir)).toMatchObject({ theme: 'light', promptBeforeRestoreFile: false });
    expect(updatePrefs(dir, { promptBeforeRestoreFile: 'nope' }).ok).toBe(false);
    expect(readPrefs(dir).promptBeforeRestoreFile).toBe(false); // the refused patch changed nothing
  });
});
