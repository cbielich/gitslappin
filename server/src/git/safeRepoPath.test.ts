import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeRepoPath } from './safeRepoPath';

// Nothing is created on disk: only the pure string rules are exercised.
const root = join(tmpdir(), 'gitslappin-tests', 'safe-root-not-created');

describe('safeRepoPath rejects', () => {
  const bad: [string, string][] = [
    ['empty string', ''],
    ['NUL byte', 'a\0b.txt'],
    ['backslash', 'a\\b.txt'],
    ['backslash traversal', '..\\x'],
    ['drive letter', 'C:\\x'],
    ['drive letter with slash', 'C:/x'],
    ['leading slash', '/etc/passwd'],
    ['parent segment at start', '../x'],
    ['parent segment in the middle', 'a/../../x'],
    ['parent segment only', '..'],
    ['parent segment at the end', 'a/..'],
    ['leading colon', ':secret'],
    ['newline', 'a\nb.txt'],
    ['carriage return in name via newline', 'a\r\nb.txt'],
    ['over 4096 characters', 'a'.repeat(4097)],
    ['.git segment', '.git/config'],
    ['.git segment, other case', 'a/.GIT/hooks/pre-commit'],
    ['.git as the whole path', '.Git'],
    ['.git with a trailing dot', '.git./config'],
    ['colon in the middle', 'a:b.txt'],
    ['alternate data stream', 'a/b.txt:stream'],
    ['revision syntax', 'dir/:0:x'],
    ['CONIN$', 'CONIN$'],
    ['CONOUT$ with an extension', 'a/conout$.txt'],
    ['superscript COM name', 'COM¹.txt'],
    ['superscript LPT name', 'lpt²'],
    ['short-name shape a~1.txt', 'a~1.txt'],
    ['short-name shape PROGRA~1', 'PROGRA~1'],
  ];
  for (const [name, p] of bad) {
    it(name, () => {
      expect(() => safeRepoPath(root, p)).toThrow();
    });
  }
});

describe('safeRepoPath accepts', () => {
  it('a plain file name', () => {
    expect(() => safeRepoPath(root, 'README.md')).not.toThrow();
  });
  it('a nested path', () => {
    const r = safeRepoPath(root, 'src/components/deep/File.tsx');
    expect(String(r).replace(/\\/g, '/')).toMatch(/src\/components\/deep\/File\.tsx$/);
  });
  it('a unicode path', () => {
    expect(() => safeRepoPath(root, '日本語/ünï.txt')).not.toThrow();
  });
  it('a name with dots that is not a parent segment', () => {
    expect(() => safeRepoPath(root, 'a/..b/c...txt')).not.toThrow();
  });
  it('names with a tilde that are not short-name shapes', () => {
    expect(() => safeRepoPath(root, 'longername~1.txt')).not.toThrow();
    expect(() => safeRepoPath(root, 'notes~backup.txt')).not.toThrow();
    expect(() => safeRepoPath(root, 'a~1.text')).not.toThrow();
  });
  it('names that only start with .git', () => {
    expect(() => safeRepoPath(root, '.gitignore')).not.toThrow();
    expect(() => safeRepoPath(root, '.github/workflows/ci.yml')).not.toThrow();
    expect(() => safeRepoPath(root, 'a/.gitattributes')).not.toThrow();
  });
  it('a path of exactly 4096 characters', () => {
    expect(() => safeRepoPath(root, 'a'.repeat(4096))).not.toThrow();
  });
});
