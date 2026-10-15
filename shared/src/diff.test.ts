import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './diff';

const one = (text: string) => {
  const files = parseUnifiedDiff(text);
  expect(files).toHaveLength(1);
  return files[0]!;
};

describe('parseUnifiedDiff', () => {
  it('parses a modify with numbered lines and counts', () => {
    const f = one(
      [
        'diff --git a/a.txt b/a.txt',
        'index 1111111..2222222 100644',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,3 +1,4 @@',
        ' one',
        ' two',
        '+new',
        ' three',
        '',
      ].join('\n'),
    );
    expect(f.path).toBe('a.txt');
    expect(f.oldPath).toBeUndefined();
    expect(f.status).toBe('M');
    expect(f.binary).toBe(false);
    expect(f.tooLarge).toBe(false);
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(0);
    expect(f.hunks).toHaveLength(1);
    const h = f.hunks[0]!;
    expect(h.header).toBe('@@ -1,3 +1,4 @@');
    expect([h.oldStart, h.oldLines, h.newStart, h.newLines]).toEqual([1, 3, 1, 4]);
    expect(h.lines.map((l) => l.kind)).toEqual(['context', 'context', 'add', 'context']);
    expect(h.lines.map((l) => l.oldNo)).toEqual([1, 2, null, 3]);
    expect(h.lines.map((l) => l.newNo)).toEqual([1, 2, 3, 4]);
    expect(h.lines.map((l) => l.text)).toEqual(['one', 'two', 'new', 'three']);
  });

  it('parses an add', () => {
    const f = one(
      [
        'diff --git a/n.txt b/n.txt',
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/n.txt',
        '@@ -0,0 +1,2 @@',
        '+x',
        '+y',
        '',
      ].join('\n'),
    );
    expect(f.status).toBe('A');
    expect(f.path).toBe('n.txt');
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(0);
    expect(f.hunks[0]!.lines.map((l) => l.oldNo)).toEqual([null, null]);
    expect(f.hunks[0]!.lines.map((l) => l.newNo)).toEqual([1, 2]);
  });

  it('parses a delete', () => {
    const f = one(
      [
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        'index 1111111..0000000',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-x',
        '-y',
        '',
      ].join('\n'),
    );
    expect(f.status).toBe('D');
    expect(f.path).toBe('gone.txt');
    expect(f.deletions).toBe(2);
    expect(f.hunks[0]!.lines.map((l) => l.newNo)).toEqual([null, null]);
    expect(f.hunks[0]!.lines.map((l) => l.oldNo)).toEqual([1, 2]);
  });

  it('parses a rename with edits', () => {
    const f = one(
      [
        'diff --git a/old.txt b/new.txt',
        'similarity index 80%',
        'rename from old.txt',
        'rename to new.txt',
        'index 1111111..2222222 100644',
        '--- a/old.txt',
        '+++ b/new.txt',
        '@@ -1,2 +1,2 @@',
        ' keep',
        '-before',
        '+after',
        '',
      ].join('\n'),
    );
    expect(f.status).toBe('R');
    expect(f.oldPath).toBe('old.txt');
    expect(f.path).toBe('new.txt');
    expect(f.similarity).toBe(80);
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
  });

  it('parses a pure rename with no hunks', () => {
    const f = one(
      ['diff --git a/old.txt b/new.txt', 'similarity index 100%', 'rename from old.txt', 'rename to new.txt', ''].join('\n'),
    );
    expect(f.status).toBe('R');
    expect(f.oldPath).toBe('old.txt');
    expect(f.path).toBe('new.txt');
    expect(f.similarity).toBe(100);
    expect(f.hunks).toEqual([]);
    expect(f.additions + f.deletions).toBe(0);
  });

  it('parses a copy', () => {
    const f = one(
      ['diff --git a/src.txt b/dup.txt', 'similarity index 100%', 'copy from src.txt', 'copy to dup.txt', ''].join('\n'),
    );
    expect(f.status).toBe('C');
    expect(f.oldPath).toBe('src.txt');
    expect(f.path).toBe('dup.txt');
  });

  it('parses a mode-only change', () => {
    const f = one(['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n'));
    expect(f.status).toBe('M');
    expect(f.oldMode).toBe('100644');
    expect(f.newMode).toBe('100755');
    expect(f.hunks).toEqual([]);
  });

  it('flags a binary file', () => {
    const f = one(
      ['diff --git a/x.bin b/x.bin', 'index 1111111..2222222 100644', 'Binary files a/x.bin and b/x.bin differ', ''].join('\n'),
    );
    expect(f.binary).toBe(true);
    expect(f.hunks).toEqual([]);
    expect(f.path).toBe('x.bin');
  });

  it('parses an empty new file (no hunks)', () => {
    const f = one(['diff --git a/empty.txt b/empty.txt', 'new file mode 100644', 'index 0000000..e69de29', ''].join('\n'));
    expect(f.status).toBe('A');
    expect(f.hunks).toEqual([]);
    expect(f.binary).toBe(false);
    expect(f.additions).toBe(0);
  });

  it('marks no-EOL on the old side only', () => {
    const f = one(
      [
        'diff --git a/e.txt b/e.txt',
        '--- a/e.txt',
        '+++ b/e.txt',
        '@@ -1 +1,2 @@',
        '-a',
        '\\ No newline at end of file',
        '+a',
        '+b',
        '',
      ].join('\n'),
    );
    const lines = f.hunks[0]!.lines;
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => !!l.noEol)).toEqual([true, false, false]);
  });

  it('marks no-EOL on the new side only', () => {
    const f = one(
      [
        'diff --git a/e.txt b/e.txt',
        '--- a/e.txt',
        '+++ b/e.txt',
        '@@ -1,2 +1 @@',
        '-a',
        '-b',
        '+a',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
    const lines = f.hunks[0]!.lines;
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => !!l.noEol)).toEqual([false, false, true]);
  });

  it('marks no-EOL on both sides', () => {
    const f = one(
      [
        'diff --git a/e.txt b/e.txt',
        '--- a/e.txt',
        '+++ b/e.txt',
        '@@ -1 +1 @@',
        '-a',
        '\\ No newline at end of file',
        '+b',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
    const lines = f.hunks[0]!.lines;
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => !!l.noEol)).toEqual([true, true]);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('keeps CR from CRLF lines exactly', () => {
    const f = one(
      ['diff --git a/w.txt b/w.txt', '--- a/w.txt', '+++ b/w.txt', '@@ -1 +1 @@', '-a\r', '+b\r', ''].join('\n'),
    );
    expect(f.hunks[0]!.lines.map((l) => l.text)).toEqual(['a\r', 'b\r']);
  });

  it('keeps a unicode path as is', () => {
    const f = one(
      ['diff --git a/日本語/ünï.txt b/日本語/ünï.txt', '--- a/日本語/ünï.txt', '+++ b/日本語/ünï.txt', '@@ -1 +1 @@', '-a', '+b', ''].join('\n'),
    );
    expect(f.path).toBe('日本語/ünï.txt');
  });

  it('decodes a C-quoted path', () => {
    const f = one(
      [
        'diff --git "a/caf\\303\\251 \\"q\\".txt" "b/caf\\303\\251 \\"q\\".txt"',
        '--- "a/caf\\303\\251 \\"q\\".txt"',
        '+++ "b/caf\\303\\251 \\"q\\".txt"',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n'),
    );
    expect(f.path).toBe('café "q".txt');
  });

  it('parses several hunks with a section header and correct numbering', () => {
    const f = one(
      [
        'diff --git a/m.js b/m.js',
        '--- a/m.js',
        '+++ b/m.js',
        '@@ -2,3 +2,3 @@ function first() {',
        ' a',
        '-b',
        '+B',
        ' c',
        '@@ -40,2 +40,3 @@ function second() {',
        ' x',
        '+y',
        ' z',
        '',
      ].join('\n'),
    );
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[0]!.section).toBe('function first() {');
    expect(f.hunks[1]!.section).toBe('function second() {');
    expect(f.hunks[1]!.oldStart).toBe(40);
    expect(f.hunks[1]!.lines.map((l) => l.newNo)).toEqual([40, 41, 42]);
    expect(f.hunks[1]!.lines.map((l) => l.oldNo)).toEqual([40, null, 41]);
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
  });

  it('treats omitted line counts as 1', () => {
    const f = one(['diff --git a/o.txt b/o.txt', '--- a/o.txt', '+++ b/o.txt', '@@ -5 +5 @@', '-a', '+b', ''].join('\n'));
    const h = f.hunks[0]!;
    expect([h.oldStart, h.oldLines, h.newStart, h.newLines]).toEqual([5, 1, 5, 1]);
    expect(h.section).toBeUndefined();
  });

  it('parses multiple files in one stream', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/b.txt b/b.txt',
        '--- a/b.txt',
        '+++ b/b.txt',
        '@@ -1 +1 @@',
        '-c',
        '+d',
        '',
      ].join('\n'),
    );
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('returns no files for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
