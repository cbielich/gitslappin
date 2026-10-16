import { execFile } from 'node:child_process';
import { GIT_PATH } from './runner';

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
  execFile(GIT_PATH, ['--version'], { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (err, stdout) => cb(err, String(stdout ?? '')));
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

/** Clone needs git 2.39.2 or newer (the local-clone fixes of CVE-2023-22490 and related). The rest of the app keeps MIN_GIT. */
export const MIN_CLONE_GIT = { major: 2, minor: 39, patch: 2 } as const;

/** null when git can clone safely, otherwise the message to show. */
export function cloneGitProblem(exec: ExecVersion = realExec): Promise<string | null> {
  const need = `${MIN_CLONE_GIT.major}.${MIN_CLONE_GIT.minor}.${MIN_CLONE_GIT.patch}`;
  return new Promise((resolve) => {
    exec((err, stdout) => {
      if (err) return resolve(`Clone needs git ${need} or newer, but "git --version" could not be run.`);
      const m = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(stdout.trim());
      if (!m) return resolve(`Clone needs git ${need} or newer, but the git version could not be read from: ${stdout.trim().slice(0, 100)}.`);
      const found = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
      const min = [MIN_CLONE_GIT.major, MIN_CLONE_GIT.minor, MIN_CLONE_GIT.patch];
      for (let i = 0; i < 3; i++) {
        if (found[i]! > min[i]!) return resolve(null);
        if (found[i]! < min[i]!) return resolve(`Clone needs git ${need} or newer, but this is git ${found.join('.')}. Update git to clone.`);
      }
      return resolve(null);
    });
  });
}

/** Interactive rebase (V4) needs git 2.38 or newer (`--no-update-refs`). The rest of the app keeps MIN_GIT. null = fine. */
export function interactiveRebaseGitProblem(exec: ExecVersion = realExec): Promise<string | null> {
  return new Promise((resolve) => {
    exec((err, stdout) => {
      if (err) return resolve('Interactive rebase needs git 2.38 or newer, but "git --version" could not be run.');
      const v = parseGitVersion(stdout);
      if (!v) return resolve('Interactive rebase needs git 2.38 or newer, but the git version could not be read.');
      if (v.major > 2 || (v.major === 2 && v.minor >= 38)) return resolve(null);
      return resolve(`Interactive rebase needs git 2.38 or newer, but this is git ${v.major}.${v.minor}. Update git to use it.`);
    });
  });
}
