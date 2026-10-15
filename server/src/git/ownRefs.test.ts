import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isOwnRef, OWN_REF_EXCLUDES, OWN_REF_PREFIXES } from './ownRefs';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const sources = (readdirSync(SRC, { recursive: true }) as string[])
  .map((r) => r.replace(/\\/g, '/'))
  .filter((r) => r.endsWith('.ts') && !r.endsWith('.test.ts'))
  .map((r) => ({ rel: r, lines: readFileSync(join(SRC, r), 'utf8').split(/\r?\n/) }));

describe('own ref namespaces (refs/gitslappin/* and the old refs/gitgit/*)', () => {
  it('names both namespaces', () => {
    expect([...OWN_REF_PREFIXES]).toEqual(['refs/gitslappin/', 'refs/gitgit/']);
    expect(OWN_REF_EXCLUDES).toEqual(['--exclude=refs/gitslappin/*', '--exclude=refs/gitgit/*']);
    expect(isOwnRef('refs/gitslappin/undo/abc')).toBe(true);
    expect(isOwnRef('refs/gitgit/stash-keep/abc 0123')).toBe(true);
    expect(isOwnRef('refs/heads/main')).toBe(false);
    expect(isOwnRef('refs/gitslappinx/y')).toBe(false);
  });

  it('every `--all` walk in the server source excludes both namespaces (grep check)', () => {
    const walks = sources.flatMap((s) => s.lines.map((l, i) => ({ where: `${s.rel}:${i + 1}`, l }))).filter(({ l }) => l.includes("'--all'") && !/'fetch'|get-url/.test(l));
    expect(walks.length).toBeGreaterThanOrEqual(2); // history.ts and the search in routes/graph.ts
    for (const w of walks) expect(w.l, w.where).toContain('...OWN_REF_EXCLUDES');
  });

  it('every for-each-ref walk is limited to refs/heads|remotes|tags (or a caller-chosen prefix), except the fingerprint, which filters both namespaces', () => {
    const calls = sources.flatMap((s) => s.lines.map((l, i) => ({ rel: s.rel, where: `${s.rel}:${i + 1}`, l }))).filter(({ l }) => /'for-each-ref'|`for-each-ref|for-each-ref',/.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**'));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      if (/refs\/(heads|remotes|tags)|prefix|--points-at/.test(c.l)) continue;
      expect(c.rel, c.where).toBe('git/history.ts');
      expect(readFileSync(join(SRC, c.rel), 'utf8')).toContain('isOwnRef(');
    }
  });
});
