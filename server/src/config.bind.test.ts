import { describe, expect, it } from 'vitest';
import { loadConfig, startupUrl } from './config';

// Docker mode design + security audit 1, 2, 9 (docs/specs/build-notes.md).
// Expected Config additions: `bind: string`, `repoRoots: string[]`; new export `startupUrl(config): string`.
// Env names: GITSLAPPIN_BIND, GITSLAPPIN_REPO_ROOTS (a single root here; the separator for several is not asserted).

const TOKEN = 'a'.repeat(40);
const docker = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  GITSLAPPIN_BIND: '0.0.0.0',
  GITSLAPPIN_NO_OPEN: '1',
  GITSLAPPIN_TOKEN: TOKEN,
  ...extra,
});

describe('config.bind', () => {
  it('defaults to 127.0.0.1', () => {
    expect(loadConfig({}).bind).toBe('127.0.0.1');
    expect(loadConfig({ GITSLAPPIN_BIND: '127.0.0.1' }).bind).toBe('127.0.0.1');
  });

  it('accepts 0.0.0.0 with GITSLAPPIN_NO_OPEN=1 and a 40-char token', () => {
    expect(loadConfig(docker()).bind).toBe('0.0.0.0');
  });

  it('accepts a token of exactly 32 chars and refuses 31', () => {
    expect(loadConfig(docker({ GITSLAPPIN_TOKEN: 'b'.repeat(32) })).bind).toBe('0.0.0.0');
    expect(() => loadConfig(docker({ GITSLAPPIN_TOKEN: 'b'.repeat(31) }))).toThrow();
  });

  it('refuses 0.0.0.0 without GITSLAPPIN_NO_OPEN=1', () => {
    expect(() => loadConfig(docker({ GITSLAPPIN_NO_OPEN: undefined }))).toThrow();
    expect(() => loadConfig(docker({ GITSLAPPIN_NO_OPEN: '0' }))).toThrow();
    expect(() => loadConfig(docker({ GITSLAPPIN_NO_OPEN: 'true' }))).toThrow();
  });

  it('refuses 0.0.0.0 without an explicit token', () => {
    expect(() => loadConfig(docker({ GITSLAPPIN_TOKEN: undefined }))).toThrow();
    expect(() => loadConfig(docker({ GITSLAPPIN_TOKEN: '' }))).toThrow();
  });

  it('refuses a token that is the placeholder pattern from .env.example', () => {
    // Must equal the GITSLAPPIN_TOKEN placeholder in .env.example.
    const PLACEHOLDERS = ['change-me-to-a-long-random-token-0000'];
    for (const p of PLACEHOLDERS) {
      expect(p.length).toBeGreaterThanOrEqual(32);
      expect(() => loadConfig(docker({ GITSLAPPIN_TOKEN: p }))).toThrow();
    }
  });

  it.each(['localhost', '::', '::1', '192.168.1.5', '10.0.0.1', '0.0.0.1', '0', '', ' 0.0.0.0', '0.0.0.0 ', 'evil.com', '127.0.0.2'])(
    'throws for any other bind value (%j) even with a valid token and GITSLAPPIN_NO_OPEN=1',
    (bind) => {
      // '' means "unset" for most env readers; keep it out of the throw list when it is empty.
      if (bind === '') {
        expect(loadConfig(docker({ GITSLAPPIN_BIND: '' })).bind).toBe('127.0.0.1');
        return;
      }
      expect(() => loadConfig(docker({ GITSLAPPIN_BIND: bind }))).toThrow();
    },
  );

  it('startup URL has the token under the default bind', () => {
    const cfg = loadConfig({ GITSLAPPIN_TOKEN: 'tok', GITSLAPPIN_PORT: '4519' });
    const url = startupUrl(cfg);
    expect(url).toBe('http://127.0.0.1:4519/?token=tok');
  });

  it('startup URL omits the token under bind 0.0.0.0', () => {
    const cfg = loadConfig(docker({ GITSLAPPIN_PORT: '4519' }));
    const url = startupUrl(cfg);
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain('token');
    expect(url).toContain('4519');
    expect(url.startsWith('http://127.0.0.1:4519') || url.startsWith('http://localhost:4519')).toBe(true);
  });

  it('GITSLAPPIN_REPO_ROOTS sets repoRoots, and is empty when unset', () => {
    expect(loadConfig({}).repoRoots).toEqual([]);
    const cfg = loadConfig({ GITSLAPPIN_REPO_ROOTS: '/repos' });
    expect(cfg.repoRoots).toHaveLength(1);
    expect(cfg.repoRoots[0]).toMatch(/repos$/);
  });

  it('several GITSLAPPIN_REPO_ROOTS are separated by ";" (blanks ignored)', () => {
    const cfg = loadConfig({ GITSLAPPIN_REPO_ROOTS: '/repos; /other ;;' });
    expect(cfg.repoRoots).toHaveLength(2);
    expect(cfg.repoRoots[0]).toMatch(/repos$/);
    expect(cfg.repoRoots[1]).toMatch(/other$/);
  });
});
