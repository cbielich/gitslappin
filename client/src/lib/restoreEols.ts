import { splitLines } from '@gitslappin/shared';

/**
 * LF text (from an editor model) back to the file's bytes. A line whose body appears in one of the `sources` (the file texts as they
 * were on disk) followed by an EOL keeps that EOL; when the sources disagree about it, or the line is new, `eol` (the file's majority
 * EOL) is used. The last line has no EOL if `text` has none. A source's unterminated last line says nothing about its EOL.
 */
export function restoreEols(text: string, sources: ReadonlyArray<string | null | undefined>, eol: 'lf' | 'crlf'): string {
  const known = new Map<string, string | null>();
  for (const src of sources) {
    for (const line of splitLines(src ?? '')) {
      if (!line.endsWith('\n')) continue;
      const own = line.endsWith('\r\n') ? '\r\n' : '\n';
      const body = line.slice(0, line.length - own.length);
      if (!known.has(body)) known.set(body, own);
      else if (known.get(body) !== own) known.set(body, null);
    }
  }
  const majority = eol === 'crlf' ? '\r\n' : '\n';
  const parts = text.split('\n');
  return parts.map((p, i) => (i === parts.length - 1 ? p : p + (known.get(p) ?? majority))).join('');
}
