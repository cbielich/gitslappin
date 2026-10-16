import { describe, expect, it } from 'vitest';
import { cloneUrlProblem, repoNameFromUrl } from './cloneUrl';

/*
 * Contract the builder must export from shared/src/cloneUrl.ts (V1 design, Security 1; pure, no Node/DOM APIs):
 *   cloneUrlProblem(url: string): string | null   null = the URL is acceptable, otherwise the message to show
 *   repoNameFromUrl(url: string): string          last path segment, with .git and any trailing "/" stripped
 * Rules: trimmed, <= 2048 chars, no whitespace or control chars inside, no leading "-", no "::" anywhere.
 * Schemes https, http, ssh, git, file; scp-style user@host:path (but not a drive letter). file:// must be a local
 * absolute path (file:////host and file://host/ refused). A bare local path is refused.
 */

describe('cloneUrlProblem: accepted', () => {
  it.each([
    'https://github.com/owner/repo.git',
    'http://example.com/owner/repo',
    'ssh://git@example.com/owner/repo.git',
    'git://example.com/owner/repo.git',
    'file:///tmp/gitslappin-tests/origin.git',
    'file:///C:/Users/x/AppData/Local/Temp/gitslappin-tests/origin.git',
    'git@github.com:owner/repo.git',
    'user@host.example.com:some/path',
  ])('%s', (url) => {
    expect(cloneUrlProblem(url)).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(cloneUrlProblem('  https://example.com/a/b.git  ')).toBeNull();
  });

  it('allows exactly 2048 characters and refuses 2049', () => {
    const base = 'https://example.com/';
    expect(cloneUrlProblem(base + 'a'.repeat(2048 - base.length))).toBeNull();
    expect(typeof cloneUrlProblem(base + 'a'.repeat(2049 - base.length))).toBe('string');
  });
});

describe('cloneUrlProblem: refused (each returns a message string)', () => {
  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['inner space', 'https://example.com/a b'],
    ['tab inside', 'https://example.com/a\tb'],
    ['newline inside', 'https://example.com/a\nb'],
    ['NUL inside', 'https://example.com/a\0b'],
    ['leading dash (option injection)', '--upload-pack=calc'],
    ['leading dash with scheme-like tail', '-oProxyCommand=x https://a/b'],
    ['ext transport', 'ext::git init /tmp/x'],
    ['double colon anywhere', 'https://example.com/a::b'],
    ['fd transport', 'fd::17/foo'],
    ['ftp scheme', 'ftp://example.com/a.git'],
    ['javascript scheme', 'javascript://example.com/%0aalert(1)'],
    ['bare Windows path', 'C:\\Users\\x\\repo'],
    ['drive letter with slash', 'C:/Users/x/repo'],
    ['bare absolute posix path', '/tmp/repo'],
    ['relative path', './repo'],
    ['file UNC style (four slashes)', 'file:////server/share/repo'],
    ['file with a host', 'file://server/share/repo'],
  ])('%s', (_label, url) => {
    const problem = cloneUrlProblem(url);
    expect(typeof problem).toBe('string');
    expect(problem).not.toBe('');
  });
});

describe('repoNameFromUrl', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'repo'],
    ['https://github.com/owner/repo.git/', 'repo'],
    ['https://github.com/owner/repo', 'repo'],
    ['https://github.com/owner/repo/', 'repo'],
    ['git@github.com:owner/repo.git', 'repo'],
    ['ssh://git@host/a/b/c.git', 'c'],
    ['file:///C:/tmp/gitslappin-tests/x/origin.git', 'origin'],
    ['file:///tmp/gitslappin-tests/x/origin.git', 'origin'],
    ['https://example.com/a.git.git', 'a.git'],
  ])('%s -> %s', (url, name) => {
    expect(repoNameFromUrl(url)).toBe(name);
  });
});
