import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '@gitslappin/shared';
import { pickFile, statusFromNameStatus, sumNumstat } from './diffParse';

describe('sumNumstat', () => {
  it('counts only the requested path', () => {
    const out = '3\t1\ta.txt\0' + '10\t20\tb.txt\0';
    expect(sumNumstat(out, 'b.txt')).toEqual({ additions: 10, deletions: 20 });
    expect(sumNumstat(out, 'a.txt')).toEqual({ additions: 3, deletions: 1 });
  });
  it('a rename counts under the new path, an unpaired old path is ignored', () => {
    const out = '2\t2\t\0old.txt\0new.txt\0' + '0\t7\told2.txt\0';
    expect(sumNumstat(out, 'new.txt')).toEqual({ additions: 2, deletions: 2 });
    expect(sumNumstat(out, 'old.txt')).toEqual({ additions: 0, deletions: 0 });
    expect(sumNumstat(out, 'old2.txt')).toEqual({ additions: 0, deletions: 7 });
  });
  it('binary files count as zero', () => {
    expect(sumNumstat('-\t-\tbin.dat\0', 'bin.dat')).toEqual({ additions: 0, deletions: 0 });
  });
});

describe('statusFromNameStatus', () => {
  it('reads the real status for the path', () => {
    const out = 'A\0added.txt\0D\0gone.txt\0R100\0old.txt\0moved.txt\0M\0m.txt\0';
    expect(statusFromNameStatus(out, 'added.txt')).toBe('A');
    expect(statusFromNameStatus(out, 'gone.txt')).toBe('D');
    expect(statusFromNameStatus(out, 'moved.txt')).toBe('R');
    expect(statusFromNameStatus(out, 'm.txt')).toBe('M');
    expect(statusFromNameStatus(out, 'other.txt')).toBeNull();
  });
  it('a type change reads as modified', () => {
    expect(statusFromNameStatus('T\0link\0', 'link')).toBe('M');
  });
});

describe('pickFile', () => {
  const two = parseUnifiedDiff(
    [
      'diff --git a/x.txt b/x.txt',
      'index 1..2 100644',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/y.txt b/y.txt',
      'index 1..2 100644',
      '--- a/y.txt',
      '+++ b/y.txt',
      '@@ -1 +1 @@',
      '-c',
      '+d',
      '',
    ].join('\n'),
  );
  it('takes the file with the requested path, not the first one', () => {
    expect(pickFile(two, 'y.txt')?.path).toBe('y.txt');
  });
  it('falls back to the first file', () => {
    expect(pickFile(two, 'zzz.txt')?.path).toBe('x.txt');
    expect(pickFile([], 'x.txt')).toBeUndefined();
  });
});
