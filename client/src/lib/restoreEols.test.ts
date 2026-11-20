import { describe, expect, it } from 'vitest';
import { restoreEols } from './restoreEols';

/*
 * Contract the builder must implement (P3, spec C7): `restoreEols` generalised from `withEols` (client/src/components/merge/useMergeModel.ts:52).
 *   File: client/src/lib/restoreEols.ts (pure, no monaco / DOM imports)
 *   export function restoreEols(text: string, sources: ReadonlyArray<string | null | undefined>, eol: 'lf' | 'crlf'): string
 *   text    = the LF-only text from the editor model
 *   sources = file texts as they were on disk (raw EOLs), e.g. [original] for the editor, [info.a, info.b, info.base] for the merge tool
 *   eol     = the file's majority EOL
 * Rules (same as withEols): a line whose body appears in a source followed by an EOL keeps that EOL (when the sources disagree about it, the majority `eol` is used);
 * any other line uses `eol`; the last line has no EOL if `text` has none; null / undefined sources and a source's unterminated last line are ignored.
 * useMergeModel's `withEols(text, info)` stays and calls restoreEols(text, [info.a, info.b, info.base], info.eol), so its tests keep passing.
 */

describe('restoreEols', () => {
  it('LF file, no sources: text is unchanged', () => {
    expect(restoreEols('a\nb\n', [], 'lf')).toBe('a\nb\n');
    expect(restoreEols('', [], 'lf')).toBe('');
  });

  it('CRLF majority with no sources: every line break becomes CRLF', () => {
    expect(restoreEols('a\nb\n', [], 'crlf')).toBe('a\r\nb\r\n');
    expect(restoreEols('\n\n', [], 'crlf')).toBe('\r\n\r\n');
  });

  it('the last line keeps having no EOL when the text has none', () => {
    expect(restoreEols('a\nb', [], 'crlf')).toBe('a\r\nb');
    expect(restoreEols('only', [], 'crlf')).toBe('only');
    expect(restoreEols('a\nb', ['a\nb'], 'crlf')).toBe('a\nb');
  });

  it('a source\'s unterminated last line says nothing about its EOL', () => {
    expect(restoreEols('b\n', ['a\nb'], 'crlf')).toBe('b\r\n');
  });

  it('a line seen in a source keeps that source\'s EOL (mixed-EOL file round trip)', () => {
    const original = 'x\r\ny\nz\r\n';
    expect(restoreEols('x\ny\nz\n', [original], 'crlf')).toBe(original);
  });

  it('a new line gets the majority EOL while the old lines keep their own', () => {
    expect(restoreEols('x\ny\nnew\n', ['x\r\ny\nz\r\n'], 'crlf')).toBe('x\r\ny\nnew\r\n');
    expect(restoreEols('x\ny\nnew\n', ['x\r\ny\nz\r\n'], 'lf')).toBe('x\r\ny\nnew\n');
  });

  it('a body seen with both EOLs falls back to the majority EOL', () => {
    expect(restoreEols('same\n', ['same\r\nsame\n'], 'lf')).toBe('same\n');
    expect(restoreEols('same\n', ['same\r\nsame\n'], 'crlf')).toBe('same\r\n');
  });

  it('blank lines are handled like any other line', () => {
    expect(restoreEols('a\n\nb\n', ['a\r\n\r\nb\r\n'], 'crlf')).toBe('a\r\n\r\nb\r\n');
    expect(restoreEols('a\n\nb\n', ['a\n\r\nb\n'], 'lf')).toBe('a\n\r\nb\n');
  });

  it('null and undefined sources are skipped', () => {
    expect(restoreEols('a\nb\n', [null, undefined, 'a\r\n'], 'lf')).toBe('a\r\nb\n');
  });

  it('several sources are all consulted (merge tool: A, B and base)', () => {
    expect(restoreEols('p\nq\n', ['p\r\n', 'q\n'], 'crlf')).toBe('p\r\nq\n');
  });

  it('an edited line (no longer in any source) is not mistaken for an old one', () => {
    expect(restoreEols('b changed\n', ['b\r\n'], 'crlf')).toBe('b changed\r\n');
  });

  it('text with a lone CR inside a line is left alone (only "\\n" is a line break in the LF model)', () => {
    expect(restoreEols('a\rb\n', [], 'crlf')).toBe('a\rb\r\n');
  });
});
