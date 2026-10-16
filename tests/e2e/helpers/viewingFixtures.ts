import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createBareOrigin, createRepo } from './repo';

/*
 * V5 fixture. Fresh dir under os.tmpdir()/gitslappin-tests/ (createRepo -> freshDir, asserted new and empty). Nothing is deleted by tests;
 * the one file removal below is a `git rm` that is part of a fixture commit (the "D" in the compare tests).
 *
 * Graph (newest first, all dated 2026-01-01 + hours):
 *   Extra work            feature/extra   (parent: Add search box)
 *   Final polish          main (HEAD), origin/main     README.md M
 *   Rename and prune                                    README.md M, docs/notes.md A, src/app.js D
 *   Debounce search input                               src/search.js M
 *   Add search box        tag v1.0                      src/search.js A
 *   Side work             feature/side    (parent: Initial commit)
 *   Initial commit                                      README.md, src/app.js
 * Refs: local main + feature/side + feature/extra (3), remote origin/main (1), tag v1.0 (1)  => "Viewing 5" (local + remote + tags), no stashes.
 * Working folder: src/search.js modified (unstaged), untracked-note.txt untracked.
 */

const at = (hour: number): string => `2026-01-01T${String(10 + hour).padStart(2, '0')}:00:00+00:00`;

function run(cwd: string, args: string[], date: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'author@example.com',
      GIT_COMMITTER_DATE: date,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'false',
    },
  });
}
function write(dir: string, file: string, content: string): void {
  const full = join(dir, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function commitAll(dir: string, message: string, date: string): void {
  run(dir, ['add', '-A'], date);
  run(dir, ['commit', '-m', message], date);
}

export const SEARCH_V1 = 'export function search(q) {}\n';
export const SEARCH_V2 = 'export function search(q) {}\n// debounce\n';

export function createViewingRepo(): string {
  const dir = createRepo('viewing', [
    { message: 'Initial commit', files: { 'README.md': '# viewing\n', 'src/app.js': 'console.log(1);\n' }, date: at(0) },
    { message: 'Add search box', files: { 'src/search.js': SEARCH_V1 }, date: at(2) },
    { message: 'Debounce search input', files: { 'src/search.js': SEARCH_V2 }, date: at(4) },
  ]);
  const initial = run(dir, ['rev-list', '--max-parents=0', 'HEAD'], at(4)).trim();
  const addSearch = run(dir, ['rev-parse', 'HEAD~1'], at(4)).trim();
  run(dir, ['tag', 'v1.0', addSearch], at(2));

  run(dir, ['switch', '-c', 'feature/side', initial], at(1));
  write(dir, 'side.txt', 'side\n');
  commitAll(dir, 'Side work', at(1));

  run(dir, ['switch', '-c', 'feature/extra', addSearch], at(7));
  write(dir, 'extra.txt', 'extra\n');
  commitAll(dir, 'Extra work', at(7));

  run(dir, ['switch', 'main'], at(4));
  run(dir, ['rm', '-q', 'src/app.js'], at(5));
  write(dir, 'docs/notes.md', '# notes\n');
  write(dir, 'README.md', '# viewing\nsecond line\n');
  commitAll(dir, 'Rename and prune', at(5));
  write(dir, 'README.md', '# viewing\nsecond line\nthird line\n');
  commitAll(dir, 'Final polish', at(6));

  const origin = createBareOrigin('viewing-origin');
  run(dir, ['remote', 'add', 'origin', origin], at(6));
  run(dir, ['push', '-u', 'origin', 'main'], at(6));

  write(dir, 'src/search.js', SEARCH_V2 + '// working copy edit\n');
  write(dir, 'untracked-note.txt', 'untracked\n');
  return dir;
}
