import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');
const files = (dir: string, ext: string) => readdirSync(join(src, dir), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);

describe('phase 13 fix 1: no hard-coded colours outside the theme files', () => {
  const COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
  for (const f of [...files('styles', '.css'), ...files('components', '.tsx')]) {
    it(f, () => {
      const hits = read(f)
        .split('\n')
        .filter((l) => COLOUR.test(l.replace(/\/\*.*?\*\//g, '')));
      expect(hits).toEqual([]);
    });
  }

  const defs = (f: string) => [...read(f).matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]!);

  it('dark.css and light.css define the same tokens', () => {
    const dark = new Set(defs('theme/dark.css'));
    const light = new Set(defs('theme/light.css'));
    expect([...dark].filter((v) => !light.has(v))).toEqual([]);
    expect([...light].filter((v) => !dark.has(v))).toEqual([]);
  });

  it('every var(--x) used is defined somewhere (theme files or the style sheets)', () => {
    const used = new Set<string>();
    for (const f of [...files('styles', '.css'), ...files('components', '.tsx')]) for (const m of read(f).matchAll(/var\((--[\w-]+)/g)) used.add(m[1]!);
    const defined = new Set([...files('styles', '.css'), ...files('theme', '.css')].flatMap(defs));
    // a name ending in "-" is a prefix built in code (var(--graph-color-${n})); a few sizes are set inline by components
    const missing = [...used].filter((v) => !v.endsWith('-') && !defined.has(v));
    expect(missing).toEqual(missing.filter((v) => /^--(col-|lane|row|graph-)/.test(v)));
  });
});
