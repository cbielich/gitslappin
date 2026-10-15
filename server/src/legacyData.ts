import { constants, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The only files carried over from the old GitGit data folder. instance.json (a stale lock) and browser/ (the old window profile) stay behind on purpose. */
export const MIGRATED_FILES = ['recent.json', 'tabs.json', 'prefs.json'] as const;

/** Default data folder and the folder GitGit used before the rename (`%APPDATA%\GitGit`, or `~/.gitgit` without APPDATA). */
export function defaultDataDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): { current: string; legacy: string } {
  return env.APPDATA
    ? { current: join(env.APPDATA, 'GitSlappin'), legacy: join(env.APPDATA, 'GitGit') }
    : { current: join(home, '.gitslappin'), legacy: join(home, '.gitgit') };
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * First start after the rename: when the new folder does not exist and the old one does, COPY the three settings files across.
 * Never moves or deletes anything, never overwrites a file, never touches an existing new folder. Returns the names copied.
 */
export function copyLegacyData(current: string, legacy: string): string[] {
  if (existsSync(current) || !isDir(legacy)) return [];
  const copied: string[] = [];
  try {
    mkdirSync(current, { recursive: true });
  } catch {
    return copied;
  }
  for (const name of MIGRATED_FILES) {
    try {
      const from = join(legacy, name);
      if (!statSync(from).isFile()) continue;
      copyFileSync(from, join(current, name), constants.COPYFILE_EXCL);
      copied.push(name);
    } catch {
      // missing or unreadable: skip it, the app starts with its defaults for that file
    }
  }
  return copied;
}
