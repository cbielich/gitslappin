import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, type FileDiff } from './diff';
import { buildPatch } from './patch';

/*
 * Contract the builder must provide (shared/src/patch.ts, also re-exported from shared/src/index.ts):
 *   buildPatch(file: FileDiff, hunkIdx: number, selected: ReadonlySet<number> | undefined, reverse: boolean): string
 * `selected` holds indexes into file.hunks[hunkIdx].lines (undefined = the whole hunk).
 * forward (stage): base side = old side. reverse (unstage, patch is applied with -R): base side = new side.
 * Unselected lines that exist on the base side become context, the others are dropped. Counts are recomputed.
 */

const one = (text: string): FileDiff => {
  const files = parseUnifiedDiff(text);
  expect(files).toHaveLength(1);
  return files[0]!;
};

const hunkLines = (p: string): string[] => {
  const rows = p.split('\n');
  rows.pop(); // patch ends with a newline
  return rows.slice(rows.findIndex((r) => r.startsWith('@@')) + 1);
};
const header = (p: string): string => p.split('\n').find((r) => r.startsWith('@@'))!;
const sel = (...n: number[]) => new Set(n);

const modify = (hunks: string[], path = 'a.txt') =>
  one([`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`, ...hunks, ''].join('\n'));

const NOEOL = '\\ No newline at end of file';

describe('buildPatch whole hunk', () => {
  it('writes its own header and the hunk unchanged', () => {
    const f = modify(['@@ -1,3 +1,4 @@', ' one', ' two', '+new', ' three']);
    const p = buildPatch(f, 0, undefined, false);
    expect(p.startsWith('diff --git a/a.txt b/a.txt\n')).toBe(true);
    expect(p).toContain('\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n two\n+new\n three\n');
    expect(p.endsWith(' three\n')).toBe(true);
  });

  it('undefined selection equals selecting every line', () => {
    const f = modify(['@@ -1,3 +1,3 @@', ' a', '-old', '+new', ' c']);
    expect(buildPatch(f, 0, sel(0, 1, 2, 3), false)).toBe(buildPatch(f, 0, undefined, false));
    expect(buildPatch(f, 0, sel(0, 1, 2, 3), true)).toBe(buildPatch(f, 0, undefined, true));
  });

  it('builds only the requested hunk of a multi-hunk file', () => {
    const f = modify(['@@ -1,3 +1,4 @@', ' a', ' b', '+X', ' c', '@@ -20,3 +21,4 @@', ' t', ' u', '+Y', ' v']);
    const fwd = buildPatch(f, 1, undefined, false);
    expect(hunkLines(fwd)).toEqual([' t', ' u', '+Y', ' v']);
    expect(header(fwd)).toMatch(/^@@ -20,3 \+\d+,4 @@/);
    expect(fwd).not.toContain('+X');
    const rev = buildPatch(f, 1, undefined, true);
    expect(header(rev)).toMatch(/^@@ -\d+,3 \+21,4 @@/);
    expect(hunkLines(rev)).toEqual([' t', ' u', '+Y', ' v']);
  });
});

describe('buildPatch line selection', () => {
  const adds = () => modify(['@@ -1,2 +1,4 @@', ' a', '+X1', '+X2', ' b']);

  it('stage: an unselected add is dropped, counts recomputed', () => {
    const p1 = buildPatch(adds(), 0, sel(1), false);
    expect(hunkLines(p1)).toEqual([' a', '+X1', ' b']);
    expect(header(p1)).toBe('@@ -1,2 +1,3 @@');
    const p2 = buildPatch(adds(), 0, sel(2), false);
    expect(hunkLines(p2)).toEqual([' a', '+X2', ' b']);
    expect(header(p2)).toBe('@@ -1,2 +1,3 @@');
  });

  it('unstage: an unselected add becomes context', () => {
    const p = buildPatch(adds(), 0, sel(1), true);
    expect(hunkLines(p)).toEqual([' a', '+X1', ' X2', ' b']);
    expect(header(p)).toBe('@@ -1,3 +1,4 @@');
  });

  const mod = () => modify(['@@ -1,3 +1,3 @@', ' a', '-old', '+new', ' c']);

  it('stage only the removed line: the unselected add is dropped', () => {
    const p = buildPatch(mod(), 0, sel(1), false);
    expect(hunkLines(p)).toEqual([' a', '-old', ' c']);
    expect(header(p)).toBe('@@ -1,3 +1,2 @@');
  });

  it('stage only the added line: the unselected removed line becomes context', () => {
    const p = buildPatch(mod(), 0, sel(2), false);
    expect(hunkLines(p)).toEqual([' a', ' old', '+new', ' c']);
    expect(header(p)).toBe('@@ -1,3 +1,4 @@');
  });

  it('unstage only the removed line: the unselected add becomes context', () => {
    const p = buildPatch(mod(), 0, sel(1), true);
    expect(hunkLines(p)).toEqual([' a', '-old', ' new', ' c']);
    expect(header(p)).toBe('@@ -1,4 +1,3 @@');
  });

  it('unstage only the added line: the unselected removed line is dropped', () => {
    const p = buildPatch(mod(), 0, sel(2), true);
    expect(hunkLines(p)).toEqual([' a', '+new', ' c']);
    expect(header(p)).toBe('@@ -1,2 +1,3 @@');
  });
});

describe('buildPatch new and deleted files', () => {
  const added = () =>
    one(['diff --git a/n.txt b/n.txt', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+l1', '+l2', ''].join('\n'));
  const deleted = () =>
    one(['diff --git a/d.txt b/d.txt', 'deleted file mode 100644', 'index 1111111..0000000', '--- a/d.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-l1', '-l2', ''].join('\n'));

  it('whole new file keeps /dev/null and the new file mode', () => {
    const p = buildPatch(added(), 0, undefined, false);
    expect(p).toContain('new file mode 100644');
    expect(p).toContain('--- /dev/null\n+++ b/n.txt\n');
    expect(header(p)).toBe('@@ -0,0 +1,2 @@');
  });

  it('staging some lines of a new file: the old side is still empty, so /dev/null stays', () => {
    const p = buildPatch(added(), 0, sel(0), false);
    expect(p).toContain('new file mode 100644');
    expect(p).toContain('--- /dev/null\n+++ b/n.txt\n');
    expect(header(p)).toBe('@@ -0,0 +1,1 @@');
    expect(hunkLines(p)).toEqual(['+l1']);
  });

  it('unstaging some lines of a new file: the old side is not empty, so no /dev/null and no new-file mode', () => {
    const p = buildPatch(added(), 0, sel(0), true);
    expect(p).not.toContain('new file mode');
    expect(p).not.toContain('/dev/null');
    expect(p).toContain('--- a/n.txt\n+++ b/n.txt\n');
    expect(header(p)).toBe('@@ -1,1 +1,2 @@');
    expect(hunkLines(p)).toEqual(['+l1', ' l2']);
  });

  it('whole deleted file keeps /dev/null and the deleted file mode', () => {
    const p = buildPatch(deleted(), 0, undefined, false);
    expect(p).toContain('deleted file mode 100644');
    expect(p).toContain('--- a/d.txt\n+++ /dev/null\n');
    expect(header(p)).toBe('@@ -1,2 +0,0 @@');
  });

  it('staging only some removed lines: the new side is not empty, so no /dev/null and no deleted mode', () => {
    const p = buildPatch(deleted(), 0, sel(0), false);
    expect(p).not.toContain('deleted file mode');
    expect(p).not.toContain('/dev/null');
    expect(p).toContain('--- a/d.txt\n+++ b/d.txt\n');
    expect(header(p)).toBe('@@ -1,2 +1,1 @@');
    expect(hunkLines(p)).toEqual(['-l1', ' l2']);
  });
});

describe('buildPatch paths', () => {
  const plain = (path: string, oldPath?: string): FileDiff => ({
    path,
    ...(oldPath ? { oldPath } : {}),
    status: 'M',
    binary: false,
    headerLines: [],
    additions: 1,
    deletions: 0,
    tooLarge: false,
    hunks: [
      {
        header: '@@ -1 +1,2 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: [
          { kind: 'context', text: 'a', oldNo: 1, newNo: 1 },
          { kind: 'add', text: 'b', oldNo: null, newNo: 2 },
        ],
      },
    ],
  });

  it('a rename uses the new path on both sides and no rename lines', () => {
    const f = one(
      [
        'diff --git a/old.txt b/new.txt',
        'similarity index 90%',
        'rename from old.txt',
        'rename to new.txt',
        'index 1111111..2222222 100644',
        '--- a/old.txt',
        '+++ b/new.txt',
        '@@ -1,2 +1,2 @@',
        ' a',
        '-b',
        '+c',
        '',
      ].join('\n'),
    );
    expect(f.oldPath).toBe('old.txt');
    const p = buildPatch(f, 0, undefined, false);
    expect(p.startsWith('diff --git a/new.txt b/new.txt\n')).toBe(true);
    expect(p).toContain('--- a/new.txt\n+++ b/new.txt\n');
    expect(p).not.toContain('rename');
    expect(p).not.toContain('old.txt');
  });

  it('a path with a space is not quoted', () => {
    const p = buildPatch(plain('with space.txt'), 0, undefined, false);
    expect(p.startsWith('diff --git a/with space.txt b/with space.txt\n')).toBe(true);
  });

  it('a non-ASCII path is C-quoted with octal escapes', () => {
    const q = '"a/\\303\\274n\\303\\257/\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"';
    const qb = q.replace('"a/', '"b/');
    const p = buildPatch(plain('ünï/日本語.txt'), 0, undefined, false);
    expect(p.startsWith(`diff --git ${q} ${qb}\n`)).toBe(true);
    expect(p).toContain(`--- ${q}\n+++ ${qb}\n`);
  });

  it('a path with a double quote or tab is C-quoted', () => {
    const p = buildPatch(plain('a"b.txt'), 0, undefined, false);
    expect(p.startsWith('diff --git "a/a\\"b.txt" "b/a\\"b.txt"\n')).toBe(true);
    const t = buildPatch(plain('x\ty.txt'), 0, undefined, false);
    expect(t.startsWith('diff --git "a/x\\ty.txt" "b/x\\ty.txt"\n')).toBe(true);
  });
});

describe('buildPatch end-of-line details', () => {
  it('keeps the no-EOL marker on a kept line', () => {
    const f = modify(['@@ -1,1 +1,2 @@', ' a', '+b', NOEOL]);
    const p = buildPatch(f, 0, undefined, false);
    expect(hunkLines(p)).toEqual([' a', '+b', NOEOL]);
  });

  it('drops the no-EOL marker together with an unselected line', () => {
    const f = modify(['@@ -1,1 +1,3 @@', ' a', '+b', '+c', NOEOL]);
    const p = buildPatch(f, 0, sel(1), false);
    expect(hunkLines(p)).toEqual([' a', '+b']);
    expect(header(p)).toBe('@@ -1,1 +1,2 @@');
  });

  it('rewrites a no-EOL context line in the middle as -x / marker / +x', () => {
    // old file "a\nb" (no EOL), new file "a\nb\nc\n"; stage only the line c.
    const f = modify(['@@ -1,2 +1,3 @@', ' a', '-b', NOEOL, '+b', '+c']);
    const p = buildPatch(f, 0, sel(3), false);
    expect(hunkLines(p)).toEqual([' a', '-b', NOEOL, '+b', '+c']);
    expect(header(p)).toBe('@@ -1,2 +1,3 @@');
  });

  it('keeps CR at the end of lines', () => {
    const f = modify(['@@ -1,1 +1,2 @@', ' a\r', '+x\r']);
    const p = buildPatch(f, 0, undefined, false);
    expect(p).toContain(' a\r\n+x\r\n');
    expect(hunkLines(p)).toEqual([' a\r', '+x\r']);
  });
});
