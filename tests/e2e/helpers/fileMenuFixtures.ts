import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freshDir } from './repo';

/*
 * Fixtures for the commit file menu (P2) and the in-app file editor (P3). Fresh dir under os.tmpdir()/gitslappin-tests/ (freshDir asserts it is new and empty).
 * Nothing here deletes anything; the one file removal is a `git rm` that is part of a fixture commit.
 * core.autocrlf is forced to false (env and repo config) so the CRLF / BOM / binary bytes below are committed exactly as written.
 *
 * createFileMenuRepo graph (newest first):
 *   Change files   (HEAD)  src/app.js M, docs/guide.md M, crlf.txt M, bin.dat M, src/new.txt A, src/gone.txt D
 *   Initial commit         README.md, src/app.js, src/gone.txt, docs/guide.md, crlf.txt, bin.dat
 * Working folder after creation: clean (no staged, unstaged or untracked changes).
 */

const at = (hour: number): string => `2026-01-01T${String(10 + hour).padStart(2, '0')}:00:00+00:00`;

export const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
export const APP_V1 = 'one\ntwo\n';
export const APP_V2 = 'one\ntwo changed\n';
export const GUIDE_V1 = '# guide\n';
export const GUIDE_V2 = '# guide\nmore\n';
export const CRLF_V1 = Buffer.concat([BOM, Buffer.from('a\r\nb\r\nc\r\n')]);
export const CRLF_V2 = Buffer.concat([BOM, Buffer.from('a\r\nb changed\r\nc\r\n')]);
export const BIN_V1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
export const BIN_V2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x08, 0xfe]);
/** A tracked file name with a right-to-left override character in it (valid on NTFS and in git). */
export const BIDI_NAME = 'bidi‮gpj.txt';

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
function write(dir: string, file: string, content: string | Buffer): void {
  const full = join(dir, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function commitAll(dir: string, message: string, date: string): void {
  run(dir, ['add', '-A'], date);
  run(dir, ['commit', '-m', message], date);
}
function initRepo(name: string): string {
  const dir = join(freshDir(name), name);
  mkdirSync(dir);
  run(dir, ['init', '-b', 'main'], at(0));
  run(dir, ['config', 'core.autocrlf', 'false'], at(0));
  return dir;
}

export interface FileMenuRepo {
  repo: string;
  /** sha of "Initial commit" */
  initial: string;
  /** sha of "Change files" (HEAD) */
  head: string;
}

export function createFileMenuRepo(): FileMenuRepo {
  const dir = initRepo('filemenu');
  write(dir, 'README.md', '# files\n');
  write(dir, 'src/app.js', APP_V1);
  write(dir, 'src/gone.txt', 'gone\n');
  write(dir, 'docs/guide.md', GUIDE_V1);
  write(dir, 'crlf.txt', CRLF_V1);
  write(dir, 'bin.dat', BIN_V1);
  commitAll(dir, 'Initial commit', at(0));
  write(dir, 'src/app.js', APP_V2);
  run(dir, ['rm', '-q', 'src/gone.txt'], at(1));
  write(dir, 'docs/guide.md', GUIDE_V2);
  write(dir, 'crlf.txt', CRLF_V2);
  write(dir, 'bin.dat', BIN_V2);
  write(dir, 'src/new.txt', 'new\n');
  commitAll(dir, 'Change files', at(1));
  return { repo: dir, initial: run(dir, ['rev-parse', 'HEAD~1'], at(1)).trim(), head: run(dir, ['rev-parse', 'HEAD'], at(1)).trim() };
}

/** One commit whose only file has a bidi override character in its name. */
export function createBidiRepo(): string {
  const dir = initRepo('filemenu-bidi');
  write(dir, 'README.md', '# bidi\n');
  write(dir, BIDI_NAME, 'bidi\n');
  commitAll(dir, 'Add bidi file', at(0));
  return dir;
}

/** Exact bytes of a file's blob at a commit (Buffer, not decoded). */
export function blobBytes(repo: string, rev: string, path: string): Buffer {
  return execFileSync('git', ['cat-file', 'blob', `${rev}:${path}`], { cwd: repo, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

export const readBytes = (repo: string, rel: string): Buffer => readFileSync(join(repo, rel));

/** Every file under <gitdir>/gitslappin-trash as {rel: path inside its <ts>-<rand> folder, abs}. Empty when the folder does not exist. Read-only. */
export function trashFiles(repo: string): { rel: string; abs: string }[] {
  const root = join(repo, '.git', 'gitslappin-trash');
  const out: { rel: string; abs: string }[] = [];
  const walk = (dir: string, rel: string[]): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), [...rel, e.name]);
      else out.push({ rel: rel.slice(1).concat(e.name).join('/'), abs: join(dir, e.name) });
    }
  };
  try {
    walk(root, []);
  } catch {
    return [];
  }
  return out;
}
