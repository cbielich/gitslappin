import { describe, expect, it } from 'vitest';
import { applyCachedArgs, commitArgs, reDiffArgs, stageAllArgs, stagePathsArgs, unstagePathsArgs } from './stageCommands';

describe('fixed argv builders (data safety)', () => {
  it('apply always has --cached, with or without -R and --check', () => {
    for (const reverse of [false, true]) {
      for (const check of [false, true]) {
        const a = applyCachedArgs(reverse, check);
        expect(a[0]).toBe('apply');
        expect(a).toContain('--cached');
        expect(a.includes('-R')).toBe(reverse);
        expect(a.includes('--check')).toBe(check);
        expect(a.at(-1)).toBe('-');
      }
    }
  });

  it('unstage is restore --staged, or rm --cached on an unborn HEAD; never a plain restore or rm', () => {
    const normal = unstagePathsArgs(false);
    expect(normal).toContain('restore');
    expect(normal).toContain('--staged');
    const unborn = unstagePathsArgs(true);
    expect(unborn).toContain('rm');
    expect(unborn).toContain('--cached');
    for (const a of [normal, unborn]) {
      expect(a).toContain('--pathspec-from-file=-');
      expect(a).toContain('--pathspec-file-nul');
      expect(a[0]).toBe('--literal-pathspecs');
    }
  });

  it('stage by path is literal and reads from stdin; add -A exists only as its own builder', () => {
    const a = stagePathsArgs();
    expect(a).toEqual(['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul']);
    expect(a).not.toContain('-A');
    expect(stageAllArgs()).toEqual(['add', '-A']);
  });

  it('the re-diff uses quotepath=on and never a whitespace flag', () => {
    for (const source of ['unstaged', 'staged', 'untracked'] as const) {
      const a = reDiffArgs(source, ['x.txt']);
      expect(a.slice(0, 2)).toEqual(['-c', 'core.quotepath=on']);
      for (const flag of ['-w', '-b', '--ignore-space-at-eol', '--ignore-all-space', '--ignore-space-change', '--ignore-blank-lines']) {
        expect(a).not.toContain(flag);
      }
      expect(a.indexOf('--')).toBeLessThan(a.indexOf('x.txt'));
    }
  });

  it('commit reads the message from stdin', () => {
    expect(commitArgs(false)).toEqual(['commit', '-F', '-']);
    expect(commitArgs(true)).toEqual(['commit', '--amend', '-F', '-']);
  });
});
