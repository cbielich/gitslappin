import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prefs, PullMode, TerminalCursor, TerminalShell, Theme } from '@gitslappin/shared';

export const PREFS_FILE = 'prefs.json';
export const DEFAULT_PREFS: Prefs = { pullMode: 'merge', theme: 'dark', zoom: 1, autoFetchMinutes: 1, terminalShell: 'powershell', terminalFontSize: 13, terminalCursor: 'block' };

const PULL_MODES: readonly PullMode[] = ['merge', 'ff-only', 'rebase'];
const isPullMode = (v: unknown): v is PullMode => typeof v === 'string' && (PULL_MODES as readonly string[]).includes(v);
const isTheme = (v: unknown): v is Theme => v === 'dark' || v === 'light';
/** 0.8 to 1.5 in 0.1 steps. */
const isZoom = (v: unknown): v is number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  const tenths = Math.round(v * 10);
  return tenths >= 8 && tenths <= 15 && tenths / 10 === v;
};

/** An integer from 0 to 60 (0 = auto-fetch off). */
const isAutoFetch = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 60;

const isTermShell = (v: unknown): v is TerminalShell => v === 'powershell' || v === 'bash';
const isTermCursor = (v: unknown): v is TerminalCursor => v === 'block' || v === 'underline' || v === 'bar';
const isTermFont = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 10 && v <= 24;

/** The stored prefs. A missing or corrupt file, or an invalid field, falls back to the default. Never throws. */
export function readPrefs(dataDir: string): Prefs {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, PREFS_FILE), 'utf8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      return {
        pullMode: isPullMode(o.pullMode) ? o.pullMode : DEFAULT_PREFS.pullMode,
        theme: isTheme(o.theme) ? o.theme : DEFAULT_PREFS.theme,
        zoom: isZoom(o.zoom) ? o.zoom : DEFAULT_PREFS.zoom,
        autoFetchMinutes: isAutoFetch(o.autoFetchMinutes) ? o.autoFetchMinutes : DEFAULT_PREFS.autoFetchMinutes,
        terminalShell: isTermShell(o.terminalShell) ? o.terminalShell : DEFAULT_PREFS.terminalShell,
        terminalFontSize: isTermFont(o.terminalFontSize) ? o.terminalFontSize : DEFAULT_PREFS.terminalFontSize,
        terminalCursor: isTermCursor(o.terminalCursor) ? o.terminalCursor : DEFAULT_PREFS.terminalCursor,
      };
    }
  } catch {
    // fall through to the defaults
  }
  return { ...DEFAULT_PREFS };
}

/** Only known keys with allowed values are taken (never spread). Any invalid value, or no known key at all, is refused. */
export function parsePrefsPatch(body: unknown): { ok: true; patch: Partial<Prefs> } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'Invalid request.' };
  const src = body as Record<string, unknown>;
  const patch: Partial<Prefs> = {};
  if (Object.prototype.hasOwnProperty.call(src, 'pullMode')) {
    if (!isPullMode(src.pullMode)) return { ok: false, error: 'Invalid pull mode.' };
    patch.pullMode = src.pullMode;
  }
  if (Object.prototype.hasOwnProperty.call(src, 'theme')) {
    if (!isTheme(src.theme)) return { ok: false, error: 'Invalid theme.' };
    patch.theme = src.theme;
  }
  if (Object.prototype.hasOwnProperty.call(src, 'zoom')) {
    if (!isZoom(src.zoom)) return { ok: false, error: 'Invalid zoom.' };
    patch.zoom = src.zoom;
  }
  if (Object.prototype.hasOwnProperty.call(src, 'autoFetchMinutes')) {
    if (!isAutoFetch(src.autoFetchMinutes)) return { ok: false, error: 'Invalid auto-fetch interval.' };
    patch.autoFetchMinutes = src.autoFetchMinutes;
  }
  if (Object.prototype.hasOwnProperty.call(src, 'terminalShell')) {
    if (!isTermShell(src.terminalShell)) return { ok: false, error: 'Invalid terminal.' };
    patch.terminalShell = src.terminalShell;
  }
  if (Object.prototype.hasOwnProperty.call(src, 'terminalFontSize')) {
    if (!isTermFont(src.terminalFontSize)) return { ok: false, error: 'Invalid font size.' };
    patch.terminalFontSize = src.terminalFontSize;
  }
  if (Object.prototype.hasOwnProperty.call(src, 'terminalCursor')) {
    if (!isTermCursor(src.terminalCursor)) return { ok: false, error: 'Invalid cursor style.' };
    patch.terminalCursor = src.terminalCursor;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to save.' };
  return { ok: true, patch };
}

/** Windows can refuse a rename for a moment while a scanner or reader holds the target; try again a few times. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

/** Merges the validated patch into the stored prefs. The write is atomic (temp file in the same folder, then rename). */
export function updatePrefs(dataDir: string, body: unknown): { ok: true; prefs: Prefs } | { ok: false; error: string } {
  const parsed = parsePrefsPatch(body);
  if (!parsed.ok) return parsed;
  const prefs: Prefs = { ...readPrefs(dataDir), ...parsed.patch };
  mkdirSync(dataDir, { recursive: true });
  const tmp = join(dataDir, `${PREFS_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(prefs, null, 2), 'utf8');
  renameWithRetry(tmp, join(dataDir, PREFS_FILE));
  return { ok: true, prefs };
}
