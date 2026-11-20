import { win32 } from 'node:path';

/*
 * "Open file in default program" and "Open in external editor" (Commit File Menu and Editor, S5 and decision 8).
 * Pure functions: no disk, no process. The route (routes/open.ts) injects `exists` and reads %PATHEXT% itself.
 */

/** File types that run as a program (or are one step from it), refused for "Open file in default program". Lowercase, each with its dot. */
export const DEFAULT_OPEN_DENY: readonly string[] = [
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.ps1xml', '.psc1', '.vb', '.vbs', '.vbe', '.js', '.jse', '.ws', '.wsf', '.wsh', '.wsc',
  '.msi', '.msp', '.mst', '.lnk', '.url', '.website', '.hta', '.scr', '.cpl', '.jar', '.reg', '.pif', '.application', '.appref-ms', '.gadget',
  '.msc', '.scf', '.inf', '.xll', '.appx', '.appxbundle', '.msix', '.msixbundle', '.diagcab', '.rdp', '.settingcontent-ms', '.library-ms',
  '.search-ms', '.searchconnector-ms', '.docm', '.dotm', '.xlsm', '.xltm', '.xlam', '.pptm', '.potm', '.ppam', '.sldm', '.chm', '.hlp', '.iqy',
  '.slk', '.sct', '.shs', '.mde', '.mda', '.ade', '.adp', '.accde', '.py', '.pyw', '.sh', '.cer', '.crt',
  // Added 2026-11-20 (security audit, user's "anything except program types"): Monad shell, Java web start, scheduled jobs, update packages,
  // themes, disk images (auto-mount), web archives, Internet settings.
  '.msh', '.msh1', '.msh2', '.mshxml', '.msh1xml', '.msh2xml', '.ps2', '.ps2xml', '.psc2', '.jnlp', '.job', '.msu', '.theme', '.themepack', '.deskthemepack',
  '.vhd', '.vhdx', '.iso', '.img', '.mht', '.mhtml', '.ins', '.isp',
];

const DENY = new Set(DEFAULT_OPEN_DENY);

/** Windows ignores trailing dots and spaces on a name. */
const stripTrail = (s: string): string => s.replace(/[. ]+$/, '');

/** The extension of the last '/' segment (trailing dots and spaces stripped first), lowercased, with its dot. '' when there is none. */
function extensionOf(name: string): string {
  const seg = stripTrail(name.slice(name.lastIndexOf('/') + 1));
  const dot = seg.lastIndexOf('.');
  return dot === -1 ? '' : seg.slice(dot).toLowerCase();
}

/** True when the file type is in the fixed deny list or in `pathext` (a %PATHEXT% string: ';' separated, compared lowercased, empty entries ignored). */
export function isProgramFileType(name: string, pathext?: string): boolean {
  const ext = extensionOf(name);
  if (ext === '') return false;
  if (DENY.has(ext)) return true;
  for (const raw of (pathext ?? '').split(';')) {
    const entry = raw.trim().toLowerCase();
    if (entry !== '' && entry === ext) return true;
  }
  return false;
}

const NOT_FOUND = 'The configured external editor was not found';
const DRIVE_ABS = /^[a-zA-Z]:[\\/]/;
const BAD_CHARS = /[\u0000-\u001f"<>|*?]/;

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key === undefined ? undefined : env[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * The editor to start. '' (or only spaces) or `code` = VS Code's Code.exe from its standard install folders (user install first).
 * Anything else must be an absolute Windows path to an .exe that `exists`; a .cmd or .bat (anything that is not an .exe) is refused,
 * as is a relative path or a bare name (never looked up through PATH or the working folder). Only absolute paths reach `exists`.
 */
export function resolveEditor(value: string, env: NodeJS.ProcessEnv, exists: (absPath: string) => boolean): { ok: true; file: string } | { ok: false; error: string } {
  const v = value.trim();
  if (v === '' || v.toLowerCase() === 'code') {
    const local = envGet(env, 'LOCALAPPDATA');
    const programFiles = envGet(env, 'ProgramFiles');
    const candidates = [local ? win32.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe') : '', programFiles ? win32.join(programFiles, 'Microsoft VS Code', 'Code.exe') : ''];
    for (const file of candidates) {
      if (DRIVE_ABS.test(file) && exists(file)) return { ok: true, file };
    }
    return { ok: false, error: NOT_FOUND };
  }
  if (!DRIVE_ABS.test(v) || BAD_CHARS.test(v) || v.slice(2).includes(':')) return { ok: false, error: 'The configured external editor must be the absolute path of an .exe file.' };
  if (stripTrail(v) !== v || !v.toLowerCase().endsWith('.exe')) return { ok: false, error: 'The configured external editor must be an .exe file.' };
  return exists(v) ? { ok: true, file: v } : { ok: false, error: NOT_FOUND };
}
