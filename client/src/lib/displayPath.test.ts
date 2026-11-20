import { describe, expect, it } from 'vitest';
import { displayPath } from './displayPath';

/*
 * Contract (spec C6, section 3 "Every {0} path goes through displayPath()"): client/src/lib/displayPath.ts, `export function displayPath(p: string): string`.
 * Control and bidi characters become visible escapes; everything else is untouched. The exact escape syntax is the builder's choice, but it must
 * (1) contain no raw control / bidi character, (2) be longer than the input, (3) name the code point in hex (so `\x1b`, `\u001b`, `\u{1b}`, `<U+001B>` all pass),
 * (4) differ per character.
 */

const FORBIDDEN = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;
const hex = (c: string): string => (c.codePointAt(0) ?? 0).toString(16).padStart(2, '0');

describe('displayPath', () => {
  it('leaves normal paths unchanged', () => {
    for (const p of ['src/app.js', 'README.md', 'docs/read me (1).md', 'a.b/c-d_e/f+g.txt', 'ünïcödé/日本語.txt', 'emoji/😀.txt', '', '.hidden/.file']) {
      expect(displayPath(p), p).toBe(p);
    }
  });

  it('shows bidi override and isolate characters as visible escapes', () => {
    for (const c of ['‮', '‭', '‪', '‫', '‬', '⁦', '⁧', '⁨', '⁩', '‎', '‏']) {
      const out = displayPath(`evil${c}gpj.txt`);
      expect(FORBIDDEN.test(out), hex(c)).toBe(false);
      expect(out.length).toBeGreaterThan('evilgpj.txt'.length);
      expect(out.toLowerCase(), hex(c)).toContain(hex(c));
      expect(out.startsWith('evil')).toBe(true);
      expect(out.endsWith('gpj.txt')).toBe(true);
    }
  });

  it('shows control characters as visible escapes', () => {
    for (const c of ['\u0000', '\u0007', '\u001b', '\u007f', '\u0085', '\u009f']) {
      const out = displayPath(`a${c}b`);
      expect(FORBIDDEN.test(out), hex(c)).toBe(false);
      expect(out.length).toBeGreaterThan(3);
      expect(out.toLowerCase(), hex(c)).toContain(hex(c));
      expect(out.startsWith('a') && out.endsWith('b')).toBe(true);
    }
  });

  it('escapes invisible format and separator characters as <U+XXXX> (soft hyphen, zero-width, word joiner, line/paragraph separator, BOM)', () => {
    const invisible = ['\u00ad', '\u200b', '\u200c', '\u200d', '\u2060', '\u2028', '\u2029', '\ufeff'];
    const RAW = /[\u00ad\u200b-\u200d\u2060\u2028\u2029\ufeff]/;
    for (const c of invisible) {
      const code = (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      const out = displayPath(`a${c}b`);
      expect(out, code).toBe(`a<U+${code}>b`);
      expect(RAW.test(out), code).toBe(false);
    }
    const all = displayPath(`x${invisible.join('')}y`);
    expect(RAW.test(all)).toBe(false);
    expect(all.match(/<U\+[0-9A-F]{4}>/g)).toHaveLength(invisible.length);
  });

  it('different characters give different escapes', () => {
    const seen = new Set(['‮', '‭', '⁦', '‏', '\u001b', '\u0007'].map((c) => displayPath(c)));
    expect(seen.size).toBe(6);
  });

  it('escapes every occurrence, not just the first', () => {
    const out = displayPath('‮a‮b‮');
    expect(FORBIDDEN.test(out)).toBe(false);
    expect(out.toLowerCase().split('202e').length - 1).toBe(3);
  });

  it('a path with a newline (a legal file name on Linux) cannot spread over two lines', () => {
    const out = displayPath('line1\nline2');
    expect(out).not.toContain('\n');
    expect(out.toLowerCase()).toContain('0a');
  });
});
