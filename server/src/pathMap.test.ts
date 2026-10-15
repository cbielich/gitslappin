import { describe, expect, it } from 'vitest';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from './config';
import { mapOpenPath, parsePathMap } from './pathMap';
import { isUnderRoots } from './repoRoots';

const MAP = parsePathMap('C:/repos=/repos');
const ok = (input: string, map = MAP) => {
  const r = mapOpenPath(input, map);
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  return r.path;
};

describe('parsePathMap', () => {
  it('empty or unset gives no pairs', () => {
    expect(parsePathMap('')).toEqual([]);
    expect(parsePathMap(undefined)).toEqual([]);
  });
  it('normalises slashes and trailing slashes, and splits pairs on ";"', () => {
    expect(parsePathMap('C:\\repos\\=/repos/; D:/work=/repos/work')).toEqual([
      { host: 'C:/repos', container: '/repos' },
      { host: 'D:/work', container: '/repos/work' },
    ]);
  });
  it('a pair without "=" or with an empty side throws', () => {
    expect(() => parsePathMap('C:/repos')).toThrow();
    expect(() => parsePathMap('=/repos')).toThrow();
    expect(() => parsePathMap('C:/repos=')).toThrow();
  });
  it('loadConfig exposes config.pathMap (empty when unset)', () => {
    expect(loadConfig({}).pathMap).toEqual([]);
    expect(loadConfig({ GITSLAPPIN_PATH_MAP: 'C:/repos=/repos' }).pathMap).toEqual([{ host: 'C:/repos', container: '/repos' }]);
  });
});

describe('mapOpenPath', () => {
  it('with no map, nothing changes (native mode)', () => {
    expect(mapOpenPath('C:\\repos\\demo', [])).toEqual({ path: 'C:\\repos\\demo' });
    expect(mapOpenPath('D:\\x', [])).toEqual({ path: 'D:\\x' });
  });
  it('maps backslashes', () => {
    expect(ok('C:\\repos\\demo')).toBe('/repos/demo');
    expect(ok('C:/repos/demo\\sub')).toBe('/repos/demo/sub');
  });
  it('matches the drive and folders case-insensitively', () => {
    expect(ok('c:\\REPOS\\Demo')).toBe('/repos/Demo');
  });
  it('trims and strips quotes', () => {
    expect(ok('  "C:\\repos\\demo"  ')).toBe('/repos/demo');
  });
  it('handles the bare host folder and a trailing slash', () => {
    expect(ok('C:\\repos')).toBe('/repos');
    expect(ok('C:\\repos\\')).toBe('/repos/');
    expect(ok('C:\\repos\\demo\\')).toBe('/repos/demo/');
  });
  it('matches whole segments only: C:/reposX is not under C:/repos', () => {
    const r = mapOpenPath('C:\\reposX\\demo', MAP);
    expect('error' in r).toBe(true);
  });
  it('a path that escapes with .. after mapping is refused by the roots check', () => {
    const mapped = ok('C:\\repos\\..\\Windows');
    expect(mapped).toBe('/repos/../Windows');
    expect(isUnderRoots(resolve(mapped), [resolve('/repos')])).toBe(false);
  });
  it('a container path passes through unchanged', () => {
    expect(ok('/repos/demo')).toBe('/repos/demo');
    expect(ok('/etc')).toBe('/etc');
  });
  it('UNC input passes through so the existing UNC refusal sees it', () => {
    expect(ok('\\\\server\\share\\x')).toBe('\\\\server\\share\\x');
  });
  it('several pairs: each maps to its own container folder, first match wins', () => {
    const map = parsePathMap('C:/repos=/repos;D:/work=/mnt/work');
    expect(ok('C:\\repos\\a', map)).toBe('/repos/a');
    expect(ok('d:\\Work\\b', map)).toBe('/mnt/work/b');
  });
  it('an unmapped drive is refused, and the message lists every mapping', () => {
    const one = mapOpenPath('D:\\other', MAP);
    expect(one).toEqual({ error: 'In Docker, GitSlappin can only open folders under the mounted folders (/repos = C:/repos).' });
    const map = parsePathMap('C:/repos=/repos;D:/work=/mnt/work');
    const two = mapOpenPath('E:\\x', map);
    expect(two).toEqual({ error: 'In Docker, GitSlappin can only open folders under the mounted folders (/repos = C:/repos, /mnt/work = D:/work).' });
  });
  it('sanity: output of a mapped path is absolute in the container', () => {
    expect(isAbsolute(ok('C:\\repos\\demo'))).toBe(true);
  });
});
