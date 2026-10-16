import { describe, expect, it } from 'vitest';
import { gitVersionProblem, type ExecVersion } from './version';
import { cloneGitProblem } from './version';

/*
 * Audit fix 7: the clone route needs git >= 2.39.2; below that it refuses with a clear message while the rest of the app
 * keeps MIN_GIT 2.26. Contract the builder must export from server/src/git/version.ts:
 *   cloneGitProblem(exec?: ExecVersion): Promise<string | null>   null = git is new enough; otherwise the message (mentions 2.39.2 and the found version)
 * The existing ExecVersion type is reused, so the version is injected here and no real git is called.
 */

const says = (text: string): ExecVersion => (cb) => cb(null, text);

describe('cloneGitProblem (injected version)', () => {
  it.each(['git version 2.39.2', 'git version 2.39.5', 'git version 2.40.0', 'git version 2.56.0.windows.2', 'git version 3.0.0', 'git version 2.100.1'])('%s is accepted', async (text) => {
    expect(await cloneGitProblem(says(text))).toBeNull();
  });

  it.each(['git version 2.39.1', 'git version 2.39.0', 'git version 2.38.9', 'git version 2.30.0', 'git version 2.26.0', 'git version 1.9.5'])('%s is refused with a message naming 2.39.2', async (text) => {
    const problem = await cloneGitProblem(says(text));
    expect(typeof problem).toBe('string');
    expect(problem).toContain('2.39.2');
  });

  it('a version line git did not print, or git failing to run, is refused too', async () => {
    expect(typeof (await cloneGitProblem(says('banana')))).toBe('string');
    expect(typeof (await cloneGitProblem((cb) => cb(new Error('ENOENT'), '')))).toBe('string');
  });

  it('the general check keeps MIN_GIT 2.26: 2.30 is fine for the app but refused for clone', async () => {
    expect(await gitVersionProblem(says('git version 2.30.0'))).toBeNull();
    expect(typeof (await cloneGitProblem(says('git version 2.30.0')))).toBe('string');
  });
});
