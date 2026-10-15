import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRepo } from './repo';

export const EVIL_CONTENT = '<img src=x onerror=alert(1)>';
export const UNICODE_PATH = 'ünï/日本語.txt';

export const SUBJECTS = {
  modify: 'Modify a-mod and multi',
  binary: 'Add binary file',
  big: 'Add big file',
  unicode: 'Add unicode file',
  evil: 'Add evil file',
} as const;

const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`): string =>
  Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/**
 * Throwaway repo (fresh dir under os.tmpdir()/gitslappin-tests/, via createRepo) with commits:
 *  - SUBJECTS.modify: a-mod.txt 3 -> 4 lines (hunk "@@ -1,3 +1,4 @@"); multi.txt changed at lines 2 and 38 (2 hunks)
 *  - SUBJECTS.binary: bin/blob.bin (contains NUL)
 *  - SUBJECTS.big: big.txt with 3000 added lines
 *  - SUBJECTS.unicode: UNICODE_PATH
 *  - SUBJECTS.evil: evil.html containing EVIL_CONTENT
 * Working tree afterwards:
 *  - unstaged modify: wip-unstaged.txt
 *  - staged modify: wip-staged.txt
 *  - staged rename with an edit: rename-old.txt -> rename-new.txt
 *  - untracked: untracked.txt (2 lines)
 *  - ignored (untracked, in .gitignore): ignored.log
 */
export function createDiffRepo(): string {
  const multiBefore = lines(40);
  const multiAfter = lines(40, (i) => (i === 2 ? 'line 2 CHANGED' : i === 38 ? 'line 38 CHANGED' : `line ${i}`));
  const dir = createRepo('diff', [
    {
      message: 'Initial files',
      files: {
        '.gitignore': 'ignored.log\n',
        'a-mod.txt': 'one\ntwo\nthree\n',
        'multi.txt': multiBefore,
        'rename-old.txt': lines(10, (i) => `rename body ${i}`),
        'wip-unstaged.txt': 'u1\nu2\n',
        'wip-staged.txt': 's1\ns2\n',
      },
    },
    { message: SUBJECTS.modify, files: { 'a-mod.txt': 'one\ntwo\nnew line\nthree\n', 'multi.txt': multiAfter } },
    { message: SUBJECTS.binary, files: { 'bin/blob.bin': 'PNG\u0000\u0000\u0001\u0002binary' } },
    { message: SUBJECTS.big, files: { 'big.txt': lines(3000, (i) => `big line ${i}`) } },
    { message: SUBJECTS.unicode, files: { [UNICODE_PATH]: 'héllo\n' } },
    { message: SUBJECTS.evil, files: { 'evil.html': `${EVIL_CONTENT}\n` } },
  ]);

  writeFileSync(join(dir, 'wip-unstaged.txt'), 'u1\nu2 edited\n');
  writeFileSync(join(dir, 'wip-staged.txt'), 's1\ns2 staged edit\n');
  git(dir, ['add', 'wip-staged.txt']);
  git(dir, ['mv', 'rename-old.txt', 'rename-new.txt']);
  writeFileSync(join(dir, 'rename-new.txt'), lines(10, (i) => (i === 5 ? 'rename body 5 EDITED' : `rename body ${i}`)));
  git(dir, ['add', 'rename-new.txt']);
  writeFileSync(join(dir, 'untracked.txt'), 'fresh 1\nfresh 2\n');
  writeFileSync(join(dir, 'ignored.log'), 'secret log\n');
  return dir;
}
