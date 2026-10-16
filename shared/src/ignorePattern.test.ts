import { describe, expect, it } from 'vitest';
import { appendIgnore, escapePath, ignorePattern } from './ignorePattern';

/*
 * Contract the builder must export from shared/src/ignorePattern.ts (pure, no Node/DOM APIs; build notes "V3 design (Ignore)"):
 *   export function escapePath(p: string): string
 *       escapes the glob metacharacters * ? [ ] \ @ { } + with a backslash, then escapes a LEADING '#' or '!' (forward slashes kept).
 *   export type IgnoreMode = 'file' | 'ext' | 'folder';
 *   export function ignorePattern(path: string, mode: IgnoreMode): string | null
 *       file   -> escapePath(path)                       (not anchored)
 *       ext    -> '*' + extension of the file name, raw  (null when the file has no extension)
 *       folder -> escapePath(<parent dir> + '/')         (null when the parent is the top level)
 *       null is also returned (never throws) when path holds NUL, CR or LF, or is empty.
 *   export function appendIgnore(old: Uint8Array | null, pattern: string, eol: '\n' | '\r\n'): Uint8Array
 *       returns the old bytes unchanged as an exact prefix, then eol + pattern + eol. old === null (file missing) = empty prefix.
 *       No dedupe here and no final-newline fix-up: the bytes are exactly old + eol + pattern + eol.
 * UNVERIFIED (chosen here, builder may ask to change): null (not a throw) for refused input; ext of a name with several dots is the last one.
 */

describe('escapePath', () => {
  it.each([
    ['*', '\\*'],
    ['?', '\\?'],
    ['[', '\\['],
    [']', '\\]'],
    ['\\', '\\\\'],
    ['@', '\\@'],
    ['{', '\\{'],
    ['}', '\\}'],
    ['+', '\\+'],
  ])('escapes the metacharacter %s', (ch, out) => {
    expect(escapePath(`a${ch}b.txt`)).toBe(`a${out}b.txt`);
  });

  it('escapes every metacharacter in one path and keeps forward slashes', () => {
    expect(escapePath('d/x*y?z[1]{2}+@.txt')).toBe('d/x\\*y\\?z\\[1\\]\\{2\\}\\+\\@.txt');
  });

  it('escapes a leading # or ! only', () => {
    expect(escapePath('#notes.txt')).toBe('\\#notes.txt');
    expect(escapePath('!keep.txt')).toBe('\\!keep.txt');
    expect(escapePath('a#b!c.txt')).toBe('a#b!c.txt');
  });

  it('leaves a plain path alone', () => {
    expect(escapePath('src/app.js')).toBe('src/app.js');
  });
});

describe('ignorePattern', () => {
  it('file: the escaped path, not anchored (no leading slash)', () => {
    expect(ignorePattern('src/app.js', 'file')).toBe('src/app.js');
    expect(ignorePattern('a+b.log', 'file')).toBe('a\\+b.log');
  });

  it('ext: * plus the extension, raw (no escaping)', () => {
    expect(ignorePattern('src/app.js', 'ext')).toBe('*.js');
    expect(ignorePattern('a.test.ts', 'ext')).toBe('*.ts');
    expect(ignorePattern('weird+name.c++', 'ext')).toBe('*.c++');
  });

  it('ext: null when the extension has glob metacharacters', () => {
    for (const n of ['a.[x]', 'a.t*', 'a.t?', 'a.t\\x']) expect(ignorePattern(n, 'ext'), n).toBeNull();
  });

  it('escapePath escapes a trailing space', () => {
    expect(escapePath('a/b ')).toBe('a/b\\ ');
  });

  it('ext: null when the file has no extension', () => {
    expect(ignorePattern('Makefile', 'ext')).toBeNull();
    expect(ignorePattern('src/Makefile', 'ext')).toBeNull();
  });

  it('folder: the escaped parent dir with a trailing slash', () => {
    expect(ignorePattern('src/lib/app.js', 'folder')).toBe('src/lib/');
    expect(ignorePattern('src/app.js', 'folder')).toBe('src/');
    expect(ignorePattern('s+rc/app.js', 'folder')).toBe('s\\+rc/');
  });

  it('folder: null when the parent is the top level', () => {
    expect(ignorePattern('app.js', 'folder')).toBeNull();
  });

  it('refuses (null) a path holding a newline, carriage return, NUL, or nothing', () => {
    for (const mode of ['file', 'ext', 'folder'] as const) {
      expect(ignorePattern('a\nb.txt', mode)).toBeNull();
      expect(ignorePattern('d/a\rb.txt', mode)).toBeNull();
      expect(ignorePattern('d/a\0b.txt', mode)).toBeNull();
      expect(ignorePattern('', mode)).toBeNull();
    }
  });
});

describe('appendIgnore', () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
  const str = (b: Uint8Array): string => new TextDecoder().decode(b);

  it('CRLF: old bytes, then CRLF pattern CRLF', () => {
    expect(str(appendIgnore(bytes('a\r\nb\r\n'), '*.log', '\r\n'))).toBe('a\r\nb\r\n\r\n*.log\r\n');
  });

  it('LF', () => {
    expect(str(appendIgnore(bytes('a\nb\n'), '*.log', '\n'))).toBe('a\nb\n\n*.log\n');
  });

  it('old file without a final newline is kept as an exact prefix', () => {
    const out = appendIgnore(bytes('a\nb'), 'x/', '\n');
    expect(str(out)).toBe('a\nb\nx/\n');
    expect(Array.from(out.slice(0, 3))).toEqual(Array.from(bytes('a\nb')));
  });

  it('keeps non-UTF8 / odd bytes in the old file byte for byte', () => {
    const old = new Uint8Array([0xff, 0xfe, 0x00, 0x0d, 0x0a, 0x80]);
    const out = appendIgnore(old, 'x', '\n');
    expect(Array.from(out.slice(0, old.length))).toEqual(Array.from(old));
    expect(str(out.slice(old.length))).toBe('\nx\n');
  });

  it('empty old file', () => {
    expect(str(appendIgnore(new Uint8Array(0), 'x', '\n'))).toBe('\nx\n');
  });

  it('missing file (null): eol pattern eol', () => {
    expect(str(appendIgnore(null, 'x', '\r\n'))).toBe('\r\nx\r\n');
  });
});
