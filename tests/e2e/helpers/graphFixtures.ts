import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createBareOrigin, createRepo, freshDir } from './repo';

export const EVIL_SUBJECT = '<img src=x onerror=alert(1)>';

function run(cwd: string, args: string[], date: string, input?: string): string {
  return execFileSync('git', args, {
    cwd,
    input,
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
      // The app runs with no system or global git config (playwright.config.ts), so files must not be checked out with this
      // machine's core.autocrlf=true either (a stash restore would leave CRLF files that the app sees as modified).
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

const at = (hour: number) => `2026-01-01T${String(10 + hour).padStart(2, '0')}:00:00+00:00`;

/**
 * Repo with: main, feature/login (merged with --no-ff), bugfix/header, tag v1.0, origin remote
 * (origin/main one commit behind), a commit whose subject is an HTML payload, one stash,
 * and a dirty tree (1 modified README.md, 1 untracked new-file.txt).
 */
export function createGraphRepo(): string {
  const dir = createRepo(
    'graph',
    [
      { message: 'Initial commit', files: { 'README.md': '# graph\n', 'src/app.js': 'console.log(1);\n' }, date: at(0) },
      { message: 'Add header component', files: { 'src/header.js': 'export const h = 1;\n' }, date: at(1) },
    ],
  );
  run(dir, ['branch', 'bugfix/header'], at(1));
  run(dir, ['checkout', '-b', 'feature/login'], at(1));
  write(dir, 'src/login.js', 'export const login = 1;\n');
  run(dir, ['add', '-A'], at(2));
  run(dir, ['commit', '-m', 'Add login form'], at(2));
  write(dir, 'src/login.js', 'export const login = 2;\n');
  run(dir, ['add', '-A'], at(3));
  run(dir, ['commit', '-m', 'Validate login input'], at(3));
  run(dir, ['checkout', 'main'], at(3));
  write(dir, 'docs/guide.md', '# guide\n');
  run(dir, ['add', '-A'], at(4));
  run(dir, ['commit', '-m', 'Add user guide'], at(4));
  run(dir, ['tag', 'v1.0'], at(4));
  run(dir, ['merge', '--no-ff', '-m', "Merge branch 'feature/login'", 'feature/login'], at(5));

  const origin = createBareOrigin('graph-origin');
  run(dir, ['remote', 'add', 'origin', origin], at(5));
  run(dir, ['push', '-u', 'origin', 'main'], at(5));

  write(dir, 'evil.txt', 'x\n');
  run(dir, ['add', '-A'], at(6));
  run(dir, ['commit', '-m', EVIL_SUBJECT], at(6));

  write(dir, 'src/app.js', 'console.log(2);\n');
  run(dir, ['stash', 'push', '-m', 'stash one'], at(7));

  write(dir, 'README.md', '# graph changed\n');
  write(dir, 'new-file.txt', 'new\n');
  return dir;
}

export interface BigRepo {
  dir: string;
  count: number;
}

/**
 * Builds `count` linear commits quickly with `git fast-import`. The oldest commit is
 * "Root marker zzroot" and has the branch `ancient`; the others are "Commit N". HEAD is main.
 */
export function createBigRepo(count = 1200): BigRepo {
  const dir = join(freshDir('big'), 'big');
  mkdirSync(dir);
  run(dir, ['init', '-b', 'scratch'], at(0));
  const base = 1767261600; // 2026-01-01T10:00:00Z
  let stream = '';
  for (let i = 1; i <= count; i++) {
    const msg = i === 1 ? 'Root marker zzroot' : `Commit ${i}`;
    const ts = base + i * 60;
    const body = `line ${i}\n`;
    stream += `commit refs/heads/main\nmark :${i}\n`;
    stream += `author Test Author <author@example.com> ${ts} +0000\n`;
    stream += `committer Test Author <author@example.com> ${ts} +0000\n`;
    stream += `data ${Buffer.byteLength(msg)}\n${msg}\n`;
    if (i > 1) stream += `from :${i - 1}\n`;
    stream += `M 100644 inline f${i % 25}.txt\ndata ${Buffer.byteLength(body)}\n${body}\n`;
  }
  run(dir, ['fast-import', '--quiet'], at(0), stream);
  run(dir, ['checkout', 'main'], at(0));
  const root = run(dir, ['rev-list', '--max-parents=0', 'main'], at(0)).trim();
  run(dir, ['branch', 'ancient', root], at(0));
  return { dir, count };
}
