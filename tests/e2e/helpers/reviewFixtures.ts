import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepo } from './repo';

const ROOT = join(tmpdir(), 'gitslappin-tests');

function git(cwd: string, args: string[], allowFail = false): void {
  if (!cwd.startsWith(ROOT + '\\') && !cwd.startsWith(ROOT + '/')) throw new Error(`Fixture dir is not under ${ROOT}: ${cwd}`);
  try {
    execFileSync('git', args, {
      cwd,
      windowsHide: true,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test Author',
        GIT_AUTHOR_EMAIL: 'author@example.com',
        GIT_COMMITTER_NAME: 'Test Author',
        GIT_COMMITTER_EMAIL: 'author@example.com',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  } catch (e) {
    if (!allowFail) throw e;
  }
}

/** One committed .js file, then an unstaged edit that adds a line with a keyword, a string and a comment. */
export function createHighlightRepo(): string {
  const repo = createRepo('highlight', [{ message: 'Initial files', files: { 'code.js': 'const a = 1;\n' } }]);
  writeFileSync(join(repo, 'code.js'), "const a = 1;\nexport const title = 'Demo'; // a note\n");
  return repo;
}

/** A merge that stops with a conflict in c.txt (unmerged, shows in the unstaged list). */
export function createConflictRepo(): string {
  const repo = createRepo('conflict', [{ message: 'Base', files: { 'c.txt': 'one\n' } }]);
  git(repo, ['checkout', '-b', 'feature']);
  writeFileSync(join(repo, 'c.txt'), 'feature side\n');
  git(repo, ['commit', '-a', '-m', 'Feature change']);
  git(repo, ['checkout', 'main']);
  writeFileSync(join(repo, 'c.txt'), 'main side\n');
  git(repo, ['commit', '-a', '-m', 'Main change']);
  git(repo, ['merge', 'feature'], true); // exits 1 on purpose: the conflict is the fixture
  return repo;
}
