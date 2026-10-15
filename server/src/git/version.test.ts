import { describe, expect, it } from 'vitest';
import { gitVersionProblem, isSupportedGit, parseGitVersion, type ExecVersion } from './version';

const answer = (err: Error | null, out: string): ExecVersion => (cb) => cb(err, out);

describe('git version check', () => {
  it('parses the usual version lines', () => {
    expect(parseGitVersion('git version 2.56.0.windows.2\n')).toEqual({ major: 2, minor: 56 });
    expect(parseGitVersion('git version 2.26.0')).toEqual({ major: 2, minor: 26 });
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toEqual({ major: 2, minor: 39 });
    expect(parseGitVersion('something else')).toBeNull();
    expect(parseGitVersion('')).toBeNull();
  });

  it('requires 2.26 or newer', () => {
    expect(isSupportedGit({ major: 2, minor: 25 })).toBe(false);
    expect(isSupportedGit({ major: 2, minor: 26 })).toBe(true);
    expect(isSupportedGit({ major: 2, minor: 56 })).toBe(true);
    expect(isSupportedGit({ major: 3, minor: 0 })).toBe(true);
    expect(isSupportedGit({ major: 1, minor: 99 })).toBe(false);
  });

  it('gives no problem for a new git, and a clear message for an old git, a missing git and garbage output', async () => {
    expect(await gitVersionProblem(answer(null, 'git version 2.56.0.windows.2'))).toBeNull();
    expect(await gitVersionProblem(answer(null, 'git version 2.25.1'))).toMatch(/2\.26 or newer.*2\.25/);
    expect(await gitVersionProblem(answer(new Error('ENOENT'), ''))).toMatch(/needs git/);
    expect(await gitVersionProblem(answer(null, 'nonsense'))).toMatch(/could not read the git version/);
  });

  it('the real git on this machine passes', async () => {
    expect(await gitVersionProblem()).toBeNull();
  });
});
