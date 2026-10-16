import { describe, expect, it } from 'vitest';
import { GENERIC_PHASE, PROGRESS_PHASES, buildCloneArgs, parseProgress } from './clone';
import { SAFE_ARGS } from './remote';

/*
 * Contract the builder must export (V1 design "Server modules" + audit fix 6). Pure functions, nothing is spawned.
 *
 * server/src/git/remote.ts:   export const SAFE_ARGS  (currently not exported)
 * server/src/git/clone.ts:
 *   export interface CloneArgsInput {
 *     url: string; target: string;
 *     shallow?: { branch?: string; by: 'depth' | 'since'; depth?: number; since?: string; flags?: string };
 *     sparse?: { paths: string[]; blobless: boolean };
 *   }
 *   buildCloneArgs(input): { ok: true; args: string[] } | { ok: false; error: string }
 *       args = [...SAFE_ARGS, 'clone', '--progress', [--depth N | --shallow-since=YYYY-MM-DD], [--branch b], [--sparse],
 *               [--filter=blob:none], ...allowedFlags, '--', url, target]
 *       The sparse paths are NEVER in args (they go to `sparse-checkout set --cone --stdin` on stdin).
 *       { ok:false } is returned (git never spawned) for a bad URL, flag, branch, depth, since or sparse path.
 *   export const PROGRESS_PHASES: readonly string[]   git's own phase names (fix 6 whitelist)
 *   export const GENERIC_PHASE: string                what every other phase text is mapped to (not in PROGRESS_PHASES)
 *   parseProgress(line: string): { phase: string; percent: number } | null    null when the line is not a "<phase>: NN%" line
 */

const URL = 'file:///tmp/gitslappin-tests/origin.git';
const TARGET = '/tmp/gitslappin-tests/parent/clone-target';
const ok = (input: Parameters<typeof buildCloneArgs>[0]): string[] => {
  const r = buildCloneArgs(input);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.args;
};
const adjacent = (args: string[], a: string, b: string): boolean => args.some((x, i) => x === a && args[i + 1] === b);
const tomorrow = (): string => new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10);

describe('buildCloneArgs: shape', () => {
  it('plain clone: SAFE_ARGS first, then clone --progress, then "--" url target last', () => {
    const args = ok({ url: URL, target: TARGET });
    expect(args.slice(0, SAFE_ARGS.length)).toEqual(SAFE_ARGS);
    expect(args[SAFE_ARGS.length]).toBe('clone');
    expect(args).toContain('--progress');
    expect(args.slice(-3)).toEqual(['--', URL, TARGET]);
    expect(args).not.toContain('--depth');
    expect(args).not.toContain('--sparse');
    expect(args.some((a) => a.startsWith('--shallow-since'))).toBe(false);
    expect(args.some((a) => a.startsWith('--filter'))).toBe(false);
  });
});

describe('buildCloneArgs: shallow / branch / sparse / blobless', () => {
  it('depth', () => {
    const args = ok({ url: URL, target: TARGET, shallow: { by: 'depth', depth: 5 } });
    expect(adjacent(args, '--depth', '5')).toBe(true);
    expect(args.some((a) => a.startsWith('--shallow-since'))).toBe(false);
  });

  it('since', () => {
    const args = ok({ url: URL, target: TARGET, shallow: { by: 'since', since: '2025-01-01' } });
    expect(args).toContain('--shallow-since=2025-01-01');
    expect(args).not.toContain('--depth');
  });

  it('branch', () => {
    const args = ok({ url: URL, target: TARGET, shallow: { by: 'depth', depth: 1, branch: 'release/1.x' } });
    expect(adjacent(args, '--branch', 'release/1.x')).toBe(true);
  });

  it('sparse adds --sparse and keeps the paths out of argv', () => {
    const args = ok({ url: URL, target: TARGET, sparse: { paths: ['src/', 'docs/'], blobless: false } });
    expect(args).toContain('--sparse');
    expect(args.some((a) => a.includes('src/') || a.includes('docs/'))).toBe(false);
    expect(args.some((a) => a.startsWith('--filter'))).toBe(false);
  });

  it('blobless adds --filter=blob:none', () => {
    const args = ok({ url: URL, target: TARGET, sparse: { paths: [], blobless: true } });
    expect(args).toContain('--filter=blob:none');
  });

  it('allowed custom flags are passed through, before the "--"', () => {
    const args = ok({ url: URL, target: TARGET, shallow: { by: 'depth', depth: 1, flags: '--no-tags  --single-branch --filter=tree:0' } });
    for (const f of ['--no-tags', '--single-branch', '--filter=tree:0']) {
      expect(args).toContain(f);
      expect(args.indexOf(f)).toBeLessThan(args.indexOf('--'));
    }
  });

  it('each allowed flag alone is accepted', () => {
    for (const f of ['--no-tags', '--single-branch', '--no-single-branch', '--filter=blob:none', '--filter=tree:0']) {
      expect(ok({ url: URL, target: TARGET, shallow: { by: 'depth', depth: 1, flags: f } })).toContain(f);
    }
  });
});

describe('buildCloneArgs: refused before git is spawned', () => {
  const refusedFlags = [
    '-c core.fsmonitor=calc',
    '-ccore.sshCommand=calc',
    '--config core.sshCommand=calc',
    '--config=core.sshCommand=calc',
    '-u calc',
    '--upload-pack=calc',
    '--upload-pack calc',
    '--template=/tmp/evil',
    '--separate-git-dir=/tmp/x',
    '--reference /tmp/x',
    '--reference-if-able=/tmp/x',
    '--recurse-submodules',
    '--bare',
    '--mirror',
    '--local',
    '--no-hardlinks',
    '--origin=evil',
    '--depth=1',
    '--filter=blob:limit=1',
    '--no-tags --bare', // one good flag does not excuse a bad one
    'not-a-flag',
  ];
  it.each(refusedFlags)('flags: %s', (flags) => {
    const r = buildCloneArgs({ url: URL, target: TARGET, shallow: { by: 'depth', depth: 1, flags } });
    expect(r.ok).toBe(false);
  });

  it('the flag error lists the allowed flags', () => {
    const r = buildCloneArgs({ url: URL, target: TARGET, shallow: { by: 'depth', depth: 1, flags: '--bare' } });
    if (r.ok) throw new Error('expected a refusal');
    for (const f of ['--no-tags', '--single-branch', '--no-single-branch', '--filter=blob:none', '--filter=tree:0']) expect(r.error).toContain(f);
  });

  it.each(['"--no-tags"', "'--no-tags'", '--no-tags "--single-branch"', "--filter='blob:none'"])('quotes are refused: %s', (flags) => {
    expect(buildCloneArgs({ url: URL, target: TARGET, shallow: { by: 'depth', depth: 1, flags } }).ok).toBe(false);
  });

  it.each(['', 'ext::git init /tmp/x', '-oProxyCommand=calc', 'https://a/b c', '/tmp/bare-local-path', 'C:\\bare\\path'])('url: %j', (url) => {
    expect(buildCloneArgs({ url, target: TARGET }).ok).toBe(false);
  });

  it.each(['bad..name', 'a b', '-x', 'ends.lock', 'we~ird', '@{x}'])('branch: %j', (branch) => {
    expect(buildCloneArgs({ url: URL, target: TARGET, shallow: { by: 'depth', depth: 1, branch } }).ok).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, 1_000_001, Number.POSITIVE_INFINITY])('depth: %s', (depth) => {
    expect(buildCloneArgs({ url: URL, target: TARGET, shallow: { by: 'depth', depth } }).ok).toBe(false);
  });

  it('depth bounds 1 and 1,000,000 are accepted', () => {
    expect(adjacent(ok({ url: URL, target: TARGET, shallow: { by: 'depth', depth: 1 } }), '--depth', '1')).toBe(true);
    expect(adjacent(ok({ url: URL, target: TARGET, shallow: { by: 'depth', depth: 1_000_000 } }), '--depth', '1000000')).toBe(true);
  });

  it.each(['', '2026-02-30', '2026-13-01', '2025-1-1', 'yesterday', '01/02/2025', '2025-01-01T00:00:00', tomorrow()])('since: %j', (since) => {
    expect(buildCloneArgs({ url: URL, target: TARGET, shallow: { by: 'since', since } }).ok).toBe(false);
  });

  it.each([
    ['201 paths', Array.from({ length: 201 }, (_, i) => `d${i}/`)],
    ['dot-dot', ['../outside']],
    ['dot-dot inside', ['a/../../b']],
    ['leading slash', ['/etc']],
    ['leading dash', ['-rf']],
    ['control character', ['a\x01b']],
    ['newline', ['a\nb']],
  ])('sparse paths: %s', (_label, paths) => {
    expect(buildCloneArgs({ url: URL, target: TARGET, sparse: { paths, blobless: false } }).ok).toBe(false);
  });

  it('200 sparse paths are accepted', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `d${i}/`);
    expect(buildCloneArgs({ url: URL, target: TARGET, sparse: { paths, blobless: false } }).ok).toBe(true);
  });
});

describe('parseProgress', () => {
  it('Receiving objects with a throughput tail', () => {
    expect(parseProgress('Receiving objects:  45% (9/20), 1.20 MiB | 2.00 MiB/s')).toEqual({ phase: 'Receiving objects', percent: 45 });
  });

  it('a "remote: " prefix is dropped', () => {
    expect(parseProgress('remote: Counting objects:  50% (1/2)')).toEqual({ phase: 'Counting objects', percent: 50 });
    expect(parseProgress('remote: Compressing objects: 100% (3/3), done.')).toEqual({ phase: 'Compressing objects', percent: 100 });
  });

  it('every whitelisted phase is passed through unchanged', () => {
    expect(PROGRESS_PHASES.length).toBeGreaterThanOrEqual(5);
    for (const p of ['Counting objects', 'Compressing objects', 'Receiving objects', 'Resolving deltas', 'Updating files']) {
      expect(PROGRESS_PHASES).toContain(p);
      expect(parseProgress(`${p}:  10% (1/10)`)).toEqual({ phase: p, percent: 10 });
    }
  });

  it('an unknown phase text maps to the generic phase, and never echoes the text (audit fix 6)', () => {
    expect(PROGRESS_PHASES).not.toContain(GENERIC_PHASE);
    for (const text of ['Evil phase', 'https://alice:s3cret@example.com/x', '<script>alert(1)</script>', 'a'.repeat(500)]) {
      const p = parseProgress(`${text}:  50% (1/2)`);
      expect(p, text).toEqual({ phase: GENERIC_PHASE, percent: 50 });
    }
  });

  it('lines that are not progress give null', () => {
    for (const line of ["Cloning into 'x'...", 'done.', '', 'fatal: repository not found', 'Receiving objects: (no percent)']) {
      expect(parseProgress(line), line).toBeNull();
    }
  });

  it('percent is a number between 0 and 100', () => {
    for (const n of [0, 7, 100]) expect(parseProgress(`Resolving deltas: ${String(n).padStart(3)}% (1/1)`)?.percent).toBe(n);
  });
});
