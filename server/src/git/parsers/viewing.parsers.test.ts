import { describe, expect, it } from 'vitest';
import { parseBlamePorcelain } from './blame';
import { parseFileHistory } from './fileHistory';

/*
 * V5b parsers. Names the builder must implement:
 *   server/src/git/parsers/blame.ts        parseBlamePorcelain(stdout: string) -> { commits: Record<string, { summary: string; authorName: string; authorEmail: string; authorTime: number /* epoch seconds *\/ }>; lines: string[] /* one full sha per file line *\/ }
 *   server/src/git/parsers/fileHistory.ts  parseFileHistory(stdout: string) -> FileHistoryEntry[]  (newest first, every entry carries its OWN path)
 *        FileHistoryEntry = { sha, authorName, authorEmail, authorDate, summary, status: 'A'|'M'|'D'|'R'|'C'|'T', path: string, oldPath?: string }
 *        input = output of  log --follow -M --name-status -z --format=%x1e%H%x00%an%x00%ae%x00%aI%x00%s
 *        A record that does not start with a 40/64-hex sha is skipped (audit security 6). R/C scores ("R087") become the letter; oldPath only for R/C.
 * UNVERIFIED: the exact bytes git prints between the subject and the first name-status token with -z (nothing, or a newline). The tests accept both; the builder must check against
 *   real git output (the int test file viewing.int.test.ts runs the real thing).
 */

const A40 = 'a'.repeat(40);
const B40 = 'b'.repeat(40);
const C40 = 'c'.repeat(40);

describe('parseBlamePorcelain', () => {
  const text = [
    `${A40} 1 1 2`,
    'author Ann Author',
    'author-mail <ann@example.com>',
    'author-time 1700000000',
    'author-tz +0000',
    'committer Ann Author',
    'committer-mail <ann@example.com>',
    'committer-time 1700000000',
    'committer-tz +0000',
    'summary First version',
    'filename f.txt',
    '\tline one',
    `${A40} 2 2`,
    '\tline two',
    `${B40} 3 3 1`,
    'author Bob Builder',
    'author-mail <bob@example.com>',
    'author-time 1700003600',
    'author-tz +0200',
    'committer Bob Builder',
    'committer-mail <bob@example.com>',
    'committer-time 1700003600',
    'committer-tz +0200',
    'summary Change the third line',
    'previous ' + C40 + ' f.txt',
    'filename f.txt',
    '\tline THREE',
    `${A40} 4 4 1`,
    '\t\ttabbed line with a leading tab',
    '',
  ].join('\n');

  it('gives one sha per file line, in file order', () => {
    expect(parseBlamePorcelain(text).lines).toEqual([A40, A40, B40, A40]);
  });

  it('reads each commit header once (later lines of the same commit have no header)', () => {
    const r = parseBlamePorcelain(text);
    expect(Object.keys(r.commits).sort()).toEqual([A40, B40]);
    expect(r.commits[A40]).toEqual({ summary: 'First version', authorName: 'Ann Author', authorEmail: 'ann@example.com', authorTime: 1700000000 });
    expect(r.commits[B40]).toEqual({ summary: 'Change the third line', authorName: 'Bob Builder', authorEmail: 'bob@example.com', authorTime: 1700003600 });
  });

  it('empty output is no lines and no commits', () => {
    expect(parseBlamePorcelain('')).toEqual({ commits: {}, lines: [] });
  });

  it('a line of file text that looks like a header does not create a commit', () => {
    const evil = [`${A40} 1 1 1`, 'author A', 'author-mail <a@example.com>', 'author-time 1', 'summary S', 'filename f', `\t${B40} 9 9 9`, ''].join('\n');
    const r = parseBlamePorcelain(evil);
    expect(r.lines).toEqual([A40]);
    expect(Object.keys(r.commits)).toEqual([A40]);
  });
});

describe('parseFileHistory', () => {
  // Newest first: M (b.txt), R (a.txt -> b.txt), M (a.txt), A (a.txt)
  const rec = (sha: string, name: string, when: string, subject: string, ...tail: string[]): string => `\x1e${sha}\0${name}\0${name.toLowerCase().replace(/ /g, '.')}@example.com\0${when}\0${subject}\0${tail.join('\0')}\0`;
  const D1 = 'd'.repeat(40);
  const E1 = 'e'.repeat(40);
  const build = (gap: string): string =>
    [
      rec(A40, 'Ann Author', '2026-01-04T10:00:00+00:00', 'Edit b', gap + 'M', 'b.txt'),
      rec(B40, 'Bob Builder', '2026-01-03T10:00:00+00:00', 'Rename a to b', gap + 'R087', 'a.txt', 'b.txt'),
      rec(C40, 'Ann Author', '2026-01-02T10:00:00+00:00', 'Edit a', gap + 'M', 'a.txt'),
      rec(D1, 'Ann Author', '2026-01-01T10:00:00+00:00', 'Add a', gap + 'A', 'a.txt'),
    ].join('');

  for (const [label, gap] of [['no gap after the subject', ''], ['a newline after the subject', '\n']] as const) {
    it(`parses plain, rename and added records with each entry's own path (${label})`, () => {
      const r = parseFileHistory(build(gap));
      expect(r.map((e) => e.sha)).toEqual([A40, B40, C40, D1]);
      expect(r[0]).toEqual({ sha: A40, authorName: 'Ann Author', authorEmail: 'ann.author@example.com', authorDate: '2026-01-04T10:00:00+00:00', summary: 'Edit b', status: 'M', path: 'b.txt' });
      expect(r[1]).toMatchObject({ sha: B40, status: 'R', path: 'b.txt', oldPath: 'a.txt', summary: 'Rename a to b', authorName: 'Bob Builder' });
      expect(r[2]).toMatchObject({ status: 'M', path: 'a.txt' });
      expect(r[2]!.oldPath).toBeUndefined();
      expect(r[3]).toMatchObject({ sha: D1, status: 'A', path: 'a.txt' });
    });
  }

  it('a subject containing odd characters survives (html, unicode, a tab)', () => {
    const r = parseFileHistory(rec(E1, 'Zoe Ünï', '2026-02-01T10:00:00+00:00', '<img src=x onerror=1>\tÄ', 'M', 'x.txt'));
    expect(r[0]).toMatchObject({ summary: '<img src=x onerror=1>\tÄ', authorName: 'Zoe Ünï', path: 'x.txt' });
  });

  it('a 64-hex (sha-256) sha is accepted', () => {
    const long = 'f'.repeat(64);
    expect(parseFileHistory(rec(long, 'A', '2026-01-01T10:00:00+00:00', 'S', 'A', 'x'))[0]!.sha).toBe(long);
  });

  it('a record that does not start with a 40/64-hex sha is skipped, the good ones stay', () => {
    const bad = ['nothex', 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), '--output=/tmp/x', ''].map((s) => rec(s, 'Eve', '2026-01-01T10:00:00+00:00', 'bad', 'M', 'evil.txt')).join('');
    const r = parseFileHistory(bad + rec(A40, 'Ann', '2026-01-01T10:00:00+00:00', 'good', 'M', 'ok.txt'));
    expect(r.map((e) => e.sha)).toEqual([A40]);
  });

  it('empty output is no entries', () => {
    expect(parseFileHistory('')).toEqual([]);
  });
});
