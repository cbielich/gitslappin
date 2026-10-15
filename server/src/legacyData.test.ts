import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyLegacyData, defaultDataDirs, MIGRATED_FILES } from './legacyData';

const ROOT = resolve(join(tmpdir(), 'gitslappin-tests'));
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.toLowerCase().startsWith(ROOT.toLowerCase()) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}

function legacyFolder(base: string): string {
  const old = join(base, 'GitGit');
  mkdirSync(join(old, 'browser'), { recursive: true });
  writeFileSync(join(old, 'recent.json'), '[{"id":"r1"}]');
  writeFileSync(join(old, 'tabs.json'), '{"tabs":[],"activeId":null}');
  writeFileSync(join(old, 'prefs.json'), '{"pullMode":"rebase"}');
  writeFileSync(join(old, 'instance.json'), '{"pid":1}'); // a stale lock: never copied
  writeFileSync(join(old, 'browser', 'Local State'), 'profile');
  return old;
}

describe('copyLegacyData (%APPDATA%\\GitGit -> %APPDATA%\\GitSlappin)', () => {
  it('copies only recent, tabs and prefs; leaves instance.json and browser/ behind; the old folder is untouched', () => {
    const base = fresh('legacy-data');
    const old = legacyFolder(base);
    const cur = join(base, 'GitSlappin');
    expect(copyLegacyData(cur, old).sort()).toEqual(['prefs.json', 'recent.json', 'tabs.json']);
    expect(readdirSync(cur).sort()).toEqual(['prefs.json', 'recent.json', 'tabs.json']);
    expect(readFileSync(join(cur, 'prefs.json'), 'utf8')).toBe('{"pullMode":"rebase"}');
    expect(readFileSync(join(cur, 'recent.json'), 'utf8')).toBe('[{"id":"r1"}]');
    expect(existsSync(join(cur, 'instance.json'))).toBe(false);
    expect(existsSync(join(cur, 'browser'))).toBe(false);
    expect(readdirSync(old).sort()).toEqual(['browser', 'instance.json', 'prefs.json', 'recent.json', 'tabs.json']);
    expect(readFileSync(join(old, 'prefs.json'), 'utf8')).toBe('{"pullMode":"rebase"}');
  });

  it('never touches an existing new folder (nothing copied, nothing overwritten)', () => {
    const base = fresh('legacy-data');
    const old = legacyFolder(base);
    const cur = join(base, 'GitSlappin');
    mkdirSync(cur);
    writeFileSync(join(cur, 'prefs.json'), '{"pullMode":"ff-only"}');
    expect(copyLegacyData(cur, old)).toEqual([]);
    expect(readdirSync(cur)).toEqual(['prefs.json']);
    expect(readFileSync(join(cur, 'prefs.json'), 'utf8')).toBe('{"pullMode":"ff-only"}');
  });

  it('does nothing and creates nothing when there is no old folder, and skips a missing file', () => {
    const base = fresh('legacy-data');
    const cur = join(base, 'GitSlappin');
    expect(copyLegacyData(cur, join(base, 'GitGit'))).toEqual([]);
    expect(existsSync(cur)).toBe(false);
    const old = join(base, 'old2');
    mkdirSync(old);
    writeFileSync(join(old, 'tabs.json'), '{"tabs":[],"activeId":null}');
    expect(copyLegacyData(join(base, 'new2'), old)).toEqual(['tabs.json']);
  });

  it('lists exactly the three settings files', () => {
    expect([...MIGRATED_FILES]).toEqual(['recent.json', 'tabs.json', 'prefs.json']);
  });
});

describe('defaultDataDirs', () => {
  it('uses %APPDATA%\\GitSlappin with %APPDATA%\\GitGit as the old folder', () => {
    expect(defaultDataDirs({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'C:\\Users\\x')).toEqual({
      current: join('C:\\Users\\x\\AppData\\Roaming', 'GitSlappin'),
      legacy: join('C:\\Users\\x\\AppData\\Roaming', 'GitGit'),
    });
  });
  it('falls back to ~/.gitslappin with ~/.gitgit as the old folder when there is no APPDATA', () => {
    expect(defaultDataDirs({}, '/home/x')).toEqual({ current: join('/home/x', '.gitslappin'), legacy: join('/home/x', '.gitgit') });
  });
});
