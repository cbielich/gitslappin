import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsLister, FsListError, MAX_ENTRIES, sanitizeDisplay } from './fsList';
import { toHostPath } from './pathMap';

// ASSUMED API (the builder must match it; the conductor can adjust the tests if the design differs):
//   server/src/fsList.ts exports
//     MAX_ENTRIES = 2000
//     class FsListError extends Error { status: 400 | 503 }
//     sanitizeDisplay(s: string): string            // strips control chars (C0, DEL, C1) and bidi chars (U+200E/F, U+202A-E, U+2066-9)
//     createFsLister(opts: { mode: 'native' | 'roots'; roots: string[]; pathMap?: PathPair[]; drives?: string[] }):
//       { list(path?: string): Promise<FsListResult> }
//       - mode 'roots' with roots=[] throws synchronously from createFsLister (fail at startup).
//       - `drives` (native mode) is the fixed-drive list found once at startup (injected here, so no PowerShell in tests).
//       - list(undefined) lists the start folder (native: C:\repos if it exists else home; roots: roots[0]).
//       - Refusals/errors reject with FsListError status 400; a listing that starts while another is in flight rejects with status 503
//         (the lock is taken synchronously at the top of list(), before the first await).
//     FsListResult = { path, display, parent: string | null, entries: {name (sanitized, display only), path (raw absolute child path), isRepo}[], roots: {path, display}[], truncated }
//   server/src/pathMap.ts additionally exports toHostPath(path: string, pairs: PathPair[]): string  (reverse of mapOpenPath, forward slashes, whole segments).
// Fixtures: mkdtemp under os.tmpdir()/gitslappin-tests/. Nothing is deleted. Junctions are used for links (no privilege needed on Windows).

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}
const names = (r: { entries: { name: string }[] }) => r.entries.map((e) => e.name);
const link = (target: string, at: string) => symlinkSync(target, at, 'junction');
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as FsListError;
  }
  throw new Error('expected the listing to be refused');
};
const nativeLister = () => createFsLister({ mode: 'native', roots: [], drives: ['C:'] });
const rootsLister = (roots: string[], pathMap: { host: string; container: string }[] = []) => createFsLister({ mode: 'roots', roots, pathMap });

describe('listing', () => {
  it('lists folders only, hides dot/$/System Volume Information names, sorts case-insensitively', async () => {
    const dir = fresh('gitslappin-fs-basic');
    for (const n of ['banana', 'Apple', 'cherry', '.hidden', '$Recycle.Bin', 'System Volume Information']) mkdirSync(join(dir, n));
    writeFileSync(join(dir, 'a-file.txt'), 'x');
    const r = await nativeLister().list(dir);
    expect(names(r)).toEqual(['Apple', 'banana', 'cherry']);
    expect(r.truncated).toBe(false);
    expect(r.path.toLowerCase()).toBe(dir.toLowerCase());
    expect(r.parent?.toLowerCase()).toBe(dirname(dir).toLowerCase());
    expect(r.roots.map((x) => x.path.toUpperCase())).toContain('C:');
  });

  it('isRepo is true for a .git directory and a .git file, false otherwise', async () => {
    const dir = fresh('gitslappin-fs-repo');
    mkdirSync(join(dir, 'dir-repo', '.git'), { recursive: true });
    mkdirSync(join(dir, 'file-repo'));
    writeFileSync(join(dir, 'file-repo', '.git'), 'gitdir: ../elsewhere\n');
    mkdirSync(join(dir, 'plain'));
    const r = await nativeLister().list(dir);
    expect(r.entries.map(({ name, isRepo }) => ({ name, isRepo }))).toEqual([
      { name: 'dir-repo', isRepo: true },
      { name: 'file-repo', isRepo: true },
      { name: 'plain', isRepo: false },
    ]);
    for (const e of r.entries) expect(Object.keys(e).sort()).toEqual(['isRepo', 'name', 'path']);
  });

  it('each entry has a raw absolute path (the real child path, used for navigation) even when the name is sanitized', async () => {
    const dir = fresh('gitslappin-fs-entrypath');
    mkdirSync(join(dir, 'plain'));
    mkdirSync(join(dir, 'ev‮il'));
    const r = await nativeLister().list(dir);
    const plain = r.entries.find((e) => e.name === 'plain')!;
    expect(plain.path.toLowerCase()).toBe(join(dir, 'plain').toLowerCase());
    const bidi = r.entries.find((e) => e.name === 'evil')!;
    expect(bidi.path.toLowerCase()).toBe(join(dir, 'ev‮il').toLowerCase());
    expect((await nativeLister().list(bidi.path)).path.toLowerCase()).toBe(join(dir, 'ev‮il').toLowerCase());
  });

  it('stops at 2000 entries and sets truncated', async () => {
    const dir = fresh('gitslappin-fs-many');
    for (let i = 0; i < MAX_ENTRIES + 1; i++) mkdirSync(join(dir, `d${String(i).padStart(5, '0')}`));
    const r = await nativeLister().list(dir);
    expect(MAX_ENTRIES).toBe(2000);
    expect(r.entries).toHaveLength(2000);
    expect(r.truncated).toBe(true);
  });

  it('follows a junction to a local folder in native mode', async () => {
    const dir = fresh('gitslappin-fs-link');
    const target = fresh('gitslappin-fs-linktarget');
    link(target, join(dir, 'jump'));
    expect(names(await nativeLister().list(dir))).toEqual(['jump']);
  });

  it('strips bidi characters from entry names and control/bidi characters from display', async () => {
    const dir = fresh('gitslappin-fs-bidi');
    mkdirSync(join(dir, 'ev\u202Eil'));
    const r = await nativeLister().list(dir);
    expect(names(r)).toEqual(['evil']);
    expect(sanitizeDisplay('a\u0000b\u0007c\u001bd\u202Ee\u2066f\u200Fg')).toBe('abcdefg');
    expect(sanitizeDisplay('Z:/host/ok name')).toBe('Z:/host/ok name');
  });

  it('listing the same folder twice at once: one succeeds, the other is 503 (one listing at a time)', async () => {
    const dir = fresh('gitslappin-fs-busy');
    mkdirSync(join(dir, 'x'));
    const lister = nativeLister();
    const results = await Promise.allSettled([lister.list(dir), lister.list(dir)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as FsListError).status).toBe(503);
    // the lock is released afterwards
    expect(names(await lister.list(dir))).toEqual(['x']);
  });
});

describe('refusals (all 400)', () => {
  it.each([
    ['a NUL byte', () => `${fresh('gitslappin-fs-nul')}\0x`],
    ['more than 4096 characters', () => join(fresh('gitslappin-fs-long'), 'a'.repeat(4100))],
    ['a relative path', () => 'some\\relative\\dir'],
    ['a UNC path', () => '\\\\server\\share\\dir'],
    ['a device path', () => '\\\\.\\C:\\'],
    ['a \\\\?\\ path', () => '\\\\?\\C:\\Windows'],
    ['a missing folder (realpath fails)', () => join(fresh('gitslappin-fs-missing'), 'does-not-exist')],
  ])('native mode refuses %s', async (_label, make) => {
    const e = await fail(nativeLister().list(make()));
    expect(e).toBeInstanceOf(FsListError);
    expect(e.status).toBe(400);
    expect(e.message.length).toBeGreaterThan(0);
  });

  it('a file path (not a folder) is refused', async () => {
    const dir = fresh('gitslappin-fs-file');
    writeFileSync(join(dir, 'f.txt'), 'x');
    expect((await fail(nativeLister().list(join(dir, 'f.txt')))).status).toBe(400);
  });

  it('C:/repos/../Windows is refused after mapping (roots mode)', async () => {
    const mount = fresh('gitslappin-fs-mapmount');
    const lister = rootsLister([mount], [{ host: 'C:/repos', container: mount.replace(/\\/g, '/') }]);
    expect((await fail(lister.list('C:/repos/../Windows'))).status).toBe(400);
    expect((await fail(lister.list('C:\\repos\\..\\..'))).status).toBe(400);
    // proves the mapping ran: the plain mapped path works
    expect((await lister.list('C:/repos')).path.toLowerCase()).toBe(mount.toLowerCase());
  });

  it('a link to a drive letter not in the fixed-drive list is skipped and refused', async () => {
    const dir = fresh('gitslappin-fs-drivelink');
    mkdirSync(join(dir, 'real'));
    link('Z:\\share', join(dir, 'mapped'));
    const r = await nativeLister().list(dir);
    expect(names(r)).toEqual(['real']);
    expect((await fail(nativeLister().list(join(dir, 'mapped')))).status).toBe(400);
  });

  it('a nested link chain is followed hop by hop: local chain works, chain ending on another drive is refused', async () => {
    const dir = fresh('gitslappin-fs-chain');
    mkdirSync(join(dir, 'c'));
    link(join(dir, 'c'), join(dir, 'b'));
    link(join(dir, 'b'), join(dir, 'a'));
    expect(names(await nativeLister().list(dir))).toEqual(['a', 'b', 'c']);
    link('Z:\\share', join(dir, 'y'));
    link(join(dir, 'y'), join(dir, 'x'));
    link(join(dir, 'x'), join(dir, 'w'));
    expect((await fail(nativeLister().list(join(dir, 'w')))).status).toBe(400);
    expect(names(await nativeLister().list(dir))).not.toContain('w');
  });

  it('a chain of more than 16 links is refused', async () => {
    const dir = fresh('gitslappin-fs-longchain');
    mkdirSync(join(dir, 'l0'));
    for (let i = 1; i <= 18; i++) link(join(dir, `l${i - 1}`), join(dir, `l${i}`));
    expect((await fail(nativeLister().list(join(dir, 'l18')))).status).toBe(400);
    expect(names(await nativeLister().list(join(dir, 'l1')))).toEqual([]);
  });

  it('an unmapped drive is refused when a path map is set', async () => {
    const mount = fresh('gitslappin-fs-unmapped');
    const lister = rootsLister([mount], [{ host: 'Z:/gitslappin-host', container: mount.replace(/\\/g, '/') }]);
    expect((await fail(lister.list('C:\\Windows'))).status).toBe(400);
  });
});

describe('roots mode', () => {
  it('an empty roots list fails at startup', () => {
    expect(() => createFsLister({ mode: 'roots', roots: [] })).toThrow();
  });

  it('start folder is roots[0]; parent is null at a root; parent of a child is the root', async () => {
    const root = fresh('gitslappin-fs-root');
    mkdirSync(join(root, 'child'));
    const lister = rootsLister([root]);
    const top = await lister.list();
    expect(top.path.toLowerCase()).toBe(root.toLowerCase());
    expect(top.parent).toBeNull();
    expect(names(top)).toEqual(['child']);
    expect(top.roots.map((x) => x.path.toLowerCase())).toEqual([root.toLowerCase()]);
    const child = await lister.list(join(root, 'child'));
    expect(child.parent?.toLowerCase()).toBe(root.toLowerCase());
  });

  it('a folder outside the roots is 400', async () => {
    const root = fresh('gitslappin-fs-in');
    const outside = fresh('gitslappin-fs-out');
    expect((await fail(rootsLister([root]).list(outside))).status).toBe(400);
    expect((await fail(rootsLister([root]).list(parse(root).root))).status).toBe(400);
    expect((await fail(rootsLister([root]).list(join(root, '..')))).status).toBe(400);
  });

  it('a junction leaving the roots is dropped from the list and refused when listed directly', async () => {
    const root = fresh('gitslappin-fs-jroot');
    const outside = fresh('gitslappin-fs-jout');
    mkdirSync(join(outside, 'secret-child'));
    mkdirSync(join(root, 'real'));
    link(outside, join(root, 'escape'));
    const lister = rootsLister([root]);
    expect(names(await lister.list(root))).toEqual(['real']); // 'real' listed proves the listing ran
    expect((await fail(lister.list(join(root, 'escape')))).status).toBe(400);
  });

  it('a junction that stays inside the roots is kept', async () => {
    const root = fresh('gitslappin-fs-jin');
    mkdirSync(join(root, 'real'));
    link(join(root, 'real'), join(root, 'alias'));
    expect(names(await rootsLister([root]).list(root))).toEqual(['alias', 'real']);
  });

  it('display uses the host path from the path map', async () => {
    const mount = fresh('gitslappin-fs-disp');
    mkdirSync(join(mount, 'sub'));
    const lister = rootsLister([mount], [{ host: 'Z:/gitslappin-host', container: mount.replace(/\\/g, '/') }]);
    const r = await lister.list(join(mount, 'sub'));
    expect(r.display).toBe('Z:/gitslappin-host/sub');
    expect(r.roots[0].display).toBe('Z:/gitslappin-host');
    expect(JSON.stringify(r)).not.toContain('\u202E');
  });
});

describe('toHostPath', () => {
  const pairs = [{ host: 'Z:/gitslappin-host', container: 'C:/gitslappin-tests/mnt' }];
  it('swaps the container prefix for the host prefix on whole segments only', () => {
    expect(toHostPath('C:\\gitslappin-tests\\mnt\\sub\\x', pairs)).toBe('Z:/gitslappin-host/sub/x');
    expect(toHostPath('C:/gitslappin-tests/mnt', pairs)).toBe('Z:/gitslappin-host');
    expect(toHostPath('C:/gitslappin-tests/mntX/sub', pairs)).not.toMatch(/^Z:/);
  });
});
