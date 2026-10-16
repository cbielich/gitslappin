import { describe, expect, it } from 'vitest';
import { remoteUrlProblem } from './remoteUrl';

/*
 * V2 contract (shared/src/remoteUrl.ts, also re-exported from the shared index):
 *   export function remoteUrlProblem(url: string): string | null;
 * null = no problem found by the pure checks; otherwise a short non-empty reason (the exact text is not asserted).
 * Pure: no fs, no git. Applied to the pull URL and the push URL of Add Remote.
 * Refused: empty, longer than 2048, NUL / control characters, a leading '-', any '::', UNC (\\ or //), file://host/..., schemes other than
 * https / http / ssh / git / file.  Allowed: https / http / ssh / git URLs, scp-style (user@host:path), file:///..., absolute local paths.
 * (V1's cloneUrlProblem differs in one place only: it refuses absolute local paths. That one is not tested here.)
 */

const refused = (url: string, label = url.slice(0, 60)): void => {
  const p = remoteUrlProblem(url);
  expect(typeof p === 'string' && p.length > 0, `should be refused: ${JSON.stringify(label)}`).toBe(true);
};
const allowed = (url: string): void => {
  expect(remoteUrlProblem(url), `should be allowed: ${url}`).toBeNull();
};

describe('remoteUrlProblem: refused', () => {
  it('an empty url', () => refused(''));

  it('a url longer than 2048 characters (2048 itself is fine)', () => {
    refused(`https://example.com/${'a'.repeat(2049)}`, 'over 2048');
    allowed(`https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`);
  });

  it('NUL and other control characters anywhere', () => {
    for (const bad of ['https://example.com/a\u0000b', 'https://example.com/a\nb', 'https://example.com/a\rb', 'https://example.com/a\tb', 'https://example.com/a\u001bb', 'https://example.com/a\u007fb', '\nhttps://example.com/x']) {
      refused(bad, JSON.stringify(bad));
    }
  });

  it('a leading dash (option injection)', () => {
    for (const bad of ['-oProxyCommand=touch x', '--upload-pack=touch x', '-u', '--', '-']) refused(bad);
  });

  it('any "::" (remote helpers such as ext:: and fd::)', () => {
    for (const bad of ['ext::sh -c touch% x', 'ext::git init /tmp/x', 'fd::3', 'ext::', 'https://example.com/a::b', 'ssh://host/path::x', 'git@host:a::b', 'foo::https://example.com/x']) refused(bad);
  });

  it('UNC paths', () => {
    for (const bad of ['\\\\server\\share\\repo', '\\\\server\\share', '//server/share/repo', '//server', '\\\\?\\C:\\x', '\\\\.\\pipe\\x']) refused(bad);
  });

  it('file:// with a host (only file:/// is allowed)', () => {
    for (const bad of ['file://host/path', 'file://server/share/repo.git', 'file://localhost/x', 'FILE://host/path']) refused(bad);
  });

  it('schemes other than https, http, ssh, git, file', () => {
    for (const bad of ['ftp://example.com/x', 'ftps://example.com/x', 'javascript:alert(1)', 'data:text/plain,x', 'ext://x', 'rsync://host/x', 'telnet://host/x', 'gopher://host/x', 'svn://host/x', 'ws://host/x']) refused(bad);
  });
});

describe('remoteUrlProblem: allowed', () => {
  it('https, http, ssh and git urls', () => {
    for (const ok of [
      'https://github.com/team/project.git',
      'http://example.com/team/project.git',
      'https://user@example.com/team/project.git',
      'ssh://git@example.com/team/project.git',
      'ssh://git@example.com:2222/team/project.git',
      'git://example.com/team/project.git',
      'HTTPS://example.com/team/project.git',
    ]) {
      allowed(ok);
    }
  });

  it('scp-style urls', () => {
    for (const ok of ['git@github.com:team/project.git', 'user@host.example.com:path/to/repo', 'host.example.com:team/project.git']) allowed(ok);
  });

  it('file:/// urls', () => {
    for (const ok of ['file:///C:/tmp/gitslappin-tests/origin.git', 'file:///tmp/gitslappin-tests/origin.git', 'file:///srv/git/project.git']) allowed(ok);
  });

  it('absolute local paths (Windows and POSIX)', () => {
    for (const ok of ['C:\\tmp\\gitslappin-tests\\origin.git', 'D:/tmp/gitslappin-tests/origin.git', '/srv/git/project.git', '/tmp/a b/project.git']) allowed(ok);
  });
});
