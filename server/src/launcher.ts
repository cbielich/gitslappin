import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The app window (phase 12): the first browser found, in this order: Edge (x86, then x64), then Chrome (Program Files,
 * x86, LOCALAPPDATA). Opened with --app and a profile folder of its own inside the data folder. Spawned detached.
 */

/** The places to look, in order. Windows only. */
export function browserCandidates(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] {
  if (platform !== 'win32') return [];
  const pf = env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA;
  return [
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...(local ? [join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
  ];
}

export function pickBrowser(exists: (p: string) => boolean = existsSync, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  return browserCandidates(env, platform).find((p) => exists(p)) ?? null;
}

export function windowArgs(url: string, dataDir: string): string[] {
  return [`--app=${url}`, `--user-data-dir=${join(dataDir, 'browser')}`, '--no-first-run', '--no-default-browser-check'];
}

/** Opens the window. false when there is no browser to open it with (the caller then prints the URL). */
export function launchWindow(url: string, dataDir: string, browser: string | null = pickBrowser()): boolean {
  if (!browser) return false;
  try {
    const child = spawn(browser, windowArgs(url, dataDir), { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
