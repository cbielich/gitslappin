export type IgnoreMode = 'file' | 'ext' | 'folder';

/** Escapes the glob metacharacters * ? [ ] \ @ { } + with a backslash, then a LEADING '#' or '!'. Forward slashes are kept. */
export function escapePath(p: string): string {
  return p.replace(/[*?[\]\\@{}+]/g, '\\$&').replace(/^[#!]/, '\\$&').replace(/ $/, '\\ ');
}

/** The .gitignore line for one path, or null (never a throw) for an empty path, a NUL/CR/LF, no extension (ext) or a top-level file (folder). */
export function ignorePattern(path: string, mode: IgnoreMode): string | null {
  if (path === '' || /[\0\r\n]/.test(path)) return null;
  if (mode === 'file') return escapePath(path);
  const slash = path.lastIndexOf('/');
  if (mode === 'ext') {
    const base = path.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    const ext = base.slice(dot);
    return dot > 0 && dot < base.length - 1 && !/[*?[\]\\]/.test(ext) ? `*${ext}` : null;
  }
  return slash > 0 ? escapePath(`${path.slice(0, slash)}/`) : null;
}

/** Exactly old bytes + eol + pattern + eol (old === null = the file is missing). No dedupe, no final-newline fix-up. */
export function appendIgnore(old: Uint8Array | null, pattern: string, eol: '\n' | '\r\n'): Uint8Array {
  const prefix = old ?? new Uint8Array(0);
  const tail = new TextEncoder().encode(`${eol}${pattern}${eol}`);
  const out = new Uint8Array(prefix.length + tail.length);
  out.set(prefix, 0);
  out.set(tail, prefix.length);
  return out;
}
