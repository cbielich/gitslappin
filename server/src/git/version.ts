import { execFile } from 'node:child_process';

/** The oldest git GitSlappin supports (`restore`, `switch`, `--pathspec-from-file` and `--pathspec-file-nul` arrived by 2.26). */
export const MIN_GIT = { major: 2, minor: 26 } as const;

/** "git version 2.56.0.windows.2" -> {2, 56}; null when the text is not a git version line. */
export function parseGitVersion(text: string): { major: number; minor: number } | null {
  const m = /^git version (\d+)\.(\d+)/.exec(text.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

export function isSupportedGit(v: { major: number; minor: number }): boolean {
  return v.major > MIN_GIT.major || (v.major === MIN_GIT.major && v.minor >= MIN_GIT.minor);
}

export type ExecVersion = (cb: (err: Error | null, stdout: string) => void) => void;

const realExec: ExecVersion = (cb) => {
  execFile('git', ['--version'], { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (err, stdout) => cb(err, String(stdout ?? '')));
};

/** null when git is new enough, otherwise the error text to print. */
export function gitVersionProblem(exec: ExecVersion = realExec): Promise<string | null> {
  return new Promise((resolve) => {
    exec((err, stdout) => {
      if (err) return resolve('GitSlappin needs git (version 2.26 or newer), but "git --version" could not be run. Install git and make sure it is on the PATH.');
      const v = parseGitVersion(stdout);
      if (!v) return resolve(`GitSlappin could not read the git version from: ${stdout.trim().slice(0, 100)}. Version 2.26 or newer is required.`);
      if (!isSupportedGit(v)) return resolve(`GitSlappin needs git 2.26 or newer, but this is git ${v.major}.${v.minor}. Update git and start GitSlappin again.`);
      return resolve(null);
    });
  });
}
