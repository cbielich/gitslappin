import { describe, expect, it } from 'vitest';
import { SHA_RE, parseCommitMeta, parseNameStatusZ } from './commit';
import { parseDecorations, parseLog } from './log';
import { parseForEachRef, parseStashList, parseTrack } from './refs';
import { MAX_STATUS_FILES, parseStatusV2 } from './status';

describe('parseDecorations', () => {
  it('classifies refs from --decorate=full output', () => {
    const refs = parseDecorations(
      'HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/heads/feature/x, refs/stash',
    );
    expect(refs).toEqual([
      { name: 'main', kind: 'local', current: true },
      { name: 'v1.0', kind: 'tag' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'feature/x', kind: 'local' },
    ]);
  });
  it('handles detached HEAD and empty input', () => {
    expect(parseDecorations('HEAD')).toEqual([{ name: 'HEAD', kind: 'head', current: true }]);
    expect(parseDecorations('')).toEqual([]);
  });
});

describe('parseLog', () => {
  const rec = (sha: string, parents: string, subject: string, refs = '') =>
    [sha, parents, 'Ann', 'ann@example.com', '2026-01-01T10:00:00+00:00', subject, refs].join('\0') + '\x1e';

  it('parses records with parents, subject and refs', () => {
    const out = parseLog('\n' + rec('a'.repeat(40), 'b'.repeat(40) + ' ' + 'c'.repeat(40), 'Merge x', 'HEAD -> refs/heads/main') + '\n' + rec('b'.repeat(40), '', 'Root'));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ sha: 'a'.repeat(40), authorName: 'Ann', authorEmail: 'ann@example.com', subject: 'Merge x' });
    expect(out[0]!.parents).toHaveLength(2);
    expect(out[0]!.refs[0]).toMatchObject({ name: 'main', current: true });
    expect(out[1]!.parents).toEqual([]);
  });
  it('keeps hostile subjects as plain text', () => {
    const out = parseLog(rec('d'.repeat(40), '', '<img src=x onerror=alert(1)>'));
    expect(out[0]!.subject).toBe('<img src=x onerror=alert(1)>');
  });
  it('returns nothing for empty output', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('refs parsers', () => {
  it('parses track info', () => {
    expect(parseTrack('[ahead 2, behind 3]')).toEqual({ ahead: 2, behind: 3, gone: false });
    expect(parseTrack('[gone]')).toEqual({ ahead: 0, behind: 0, gone: true });
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, gone: false });
  });
  it('groups for-each-ref output', () => {
    const s = '\x1f';
    const out = parseForEachRef(
      [
        ['refs/heads/main', 'a1', '', 'origin/main', '[ahead 1]', '*', 'commit', ''].join(s),
        ['refs/heads/feature/x', 'b2', '', '', '', ' ', 'commit', ''].join(s),
        ['refs/remotes/origin/main', 'a0', '', '', '', ' ', 'commit', ''].join(s),
        ['refs/remotes/origin/HEAD', 'a0', '', '', '', ' ', 'commit', ''].join(s),
        ['refs/remotes/up/dev', 'c3', '', '', '', ' ', 'commit', ''].join(s),
        ['refs/remotes/team/a/dev', 'c4', '', '', '', ' ', 'commit', ''].join(s),
        ['refs/tags/v1', 't1', 'c1', '', '', ' ', 'tag', 'commit'].join(s),
        ['refs/tags/light', 'c2', '', '', '', ' ', 'commit', ''].join(s),
        ['refs/tags/tree-tag', 'x1', '', '', '', ' ', 'tree', ''].join(s),
        ['refs/tags/blob-tag', 'x2', 'x3', '', '', ' ', 'tag', 'blob'].join(s),
      ].join('\n') + '\n',
      ['origin', 'team/a', 'up'],
    );
    expect(out.local).toEqual([
      { name: 'main', sha: 'a1', upstream: 'origin/main', ahead: 1, behind: 0, gone: false, current: true },
      { name: 'feature/x', sha: 'b2', upstream: null, ahead: 0, behind: 0, gone: false, current: false },
    ]);
    expect(out.remotes.map((r) => [r.name, r.branches.map((b) => b.name)])).toEqual([
      ['origin', ['origin/main']],
      ['up', ['up/dev']],
      ['team/a', ['team/a/dev']],
    ]);
    expect(out.tags).toEqual([
      { name: 'v1', sha: 'c1' },
      { name: 'light', sha: 'c2' },
    ]);
  });
  it('parses stash list', () => {
    const out = parseStashList(['s1', 'p1 p2 p3', 'stash@{0}', 'On main: wip'].join('\0') + '\x1e\n' + ['s0', 'q1 q2', 'stash@{1}', 'WIP on main'].join('\0') + '\x1e');
    expect(out).toEqual([
      { index: 0, ref: 'stash@{0}', sha: 's1', parents: ['p1', 'p2', 'p3'], message: 'On main: wip' },
      { index: 1, ref: 'stash@{1}', sha: 's0', parents: ['q1', 'q2'], message: 'WIP on main' },
    ]);
  });
});

describe('commit parsers', () => {
  it('validates sha params', () => {
    expect(SHA_RE.test('abcdef1')).toBe(true);
    expect(SHA_RE.test('a'.repeat(40))).toBe(true);
    expect(SHA_RE.test('--output=x')).toBe(false);
    expect(SHA_RE.test('abc')).toBe(false);
    expect(SHA_RE.test('abcdef')).toBe(false);
    expect(SHA_RE.test('--end-of-options')).toBe(false);
    expect(SHA_RE.test('HEAD')).toBe(false);
  });
  it('parses commit meta with a multi-line message', () => {
    const raw = ['s', 'p', 'Ann', 'a@x', '2026-01-01T10:00:00+00:00', 'Cy', 'c@x', '2026-01-02T10:00:00+00:00', 'Subject\n\nBody line\n'].join('\0');
    const m = parseCommitMeta(raw)!;
    expect(m.message).toBe('Subject\n\nBody line');
    expect(m.committerName).toBe('Cy');
    expect(m.parents).toEqual(['p']);
    expect(parseCommitMeta('')).toBeNull();
  });
  it('parses name-status -z including renames', () => {
    const out = parseNameStatusZ('M\0src/a.ts\0A\0b.txt\0D\0c.txt\0R087\0old/n.ts\0new/n.ts\0');
    expect(out).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'b.txt' },
      { status: 'D', path: 'c.txt' },
      { status: 'R', path: 'new/n.ts', oldPath: 'old/n.ts' },
    ]);
    expect(parseNameStatusZ('')).toEqual([]);
  });
});

describe('parseStatusV2', () => {
  it('counts modified, added, deleted, untracked and handles renames', () => {
    const out = parseStatusV2(
      [
        '# branch.oid abc',
        '1 .M N... 100644 100644 100644 h h src/a b.ts',
        '1 A. N... 000000 100644 100644 0 h new.ts',
        '1 .D N... 100644 100644 000000 h h gone.ts',
        '2 R. N... 100644 100644 100644 h h R100 renamed.ts',
        'orig.ts',
        'u UU N... 100644 100644 100644 100644 h h h conflict.ts',
        '? untracked file.txt',
        '! ignored.log',
      ].join('\0') + '\0',
    );
    expect(out).toMatchObject({ modified: 2, added: 1, deleted: 1, untracked: 1, conflicted: 1, total: 6 });
    expect(out.files.find((f) => f.status === '?')!.path).toBe('untracked file.txt');
    expect(out.files[0]!.path).toBe('src/a b.ts');
    expect(out.files.find((f) => f.path === 'renamed.ts')!.staged).toBe(true);
  });
  it('keeps each side of the status and counts staged and unstaged files', () => {
    const out = parseStatusV2(
      ['1 MM N... 100644 100644 100644 h h both.txt', '1 A. N... 100644 100644 100644 h h added.txt', '1 .D N... 100644 100644 100644 h h gone.txt', '? new.txt', ''].join('\0'),
    );
    const f = (p: string) => out.files.find((x) => x.path === p)!;
    expect([f('both.txt').indexStatus, f('both.txt').worktreeStatus]).toEqual(['M', 'M']);
    expect([f('added.txt').indexStatus, f('added.txt').worktreeStatus]).toEqual(['A', '.']);
    expect([f('gone.txt').indexStatus, f('gone.txt').worktreeStatus]).toEqual(['.', 'D']);
    expect([f('new.txt').indexStatus, f('new.txt').worktreeStatus]).toEqual(['.', '?']);
    expect(out.stagedCount).toBe(2);
    expect(out.unstagedCount).toBe(3);
  });
  it('is empty for a clean tree', () => {
    expect(parseStatusV2('').total).toBe(0);
  });

  it('caps the file list but keeps exact counts', () => {
    const n = MAX_STATUS_FILES + 5;
    const out = parseStatusV2(Array.from({ length: n }, (_, i) => `? f${i}.txt`).join('\0') + '\0');
    expect(out.total).toBe(n);
    expect(out.untracked).toBe(n);
    expect(out.files).toHaveLength(MAX_STATUS_FILES);
    expect(out.truncated).toBe(true);
  });
});
