import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freshDir } from './repo';
import { commitFile, git } from './remoteFixtures';

export { createExtRemoteRepo, extRan, git, tryGit } from './remoteFixtures';
export { freshDir };

/*
 * Fixtures for the V1 clone/create screens. The origin is a bare repo reached over a file:// URL, asserted to be inside
 * os.tmpdir()/gitslappin-tests before use. Nothing here deletes anything. Git isolation (empty global config, failing askpass)
 * comes from remoteFixtures, which also exports REMOTE_TEST_ENV for the webServer.
 */

const ROOT = resolve(join(tmpdir(), 'gitslappin-tests'));
const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

export const CLONE_SUBJECTS = ['Clone base 3', 'Clone base 2', 'Clone base 1'];

export interface CloneFx {
  /** bare origin; its folder is named clonesrc.git so a clone lands in "clonesrc" */
  origin: string;
  /** file:// URL of the origin */
  url: string;
  /** a fresh EMPTY folder to clone into */
  parent: string;
  /** folder name the clone gets (repoNameFromUrl) */
  name: string;
  /** where the clone must appear */
  target: string;
}

/** Bare origin with main = 3 commits (README.md, src/a.txt, docs/b.txt), plus an empty parent folder. */
export function createCloneFx(): CloneFx {
  const base = freshDir('clone-fx');
  const origin = join(base, 'clonesrc.git');
  const work = join(base, 'work');
  mkdirSync(origin);
  mkdirSync(work);
  git(origin, ['init', '--bare', '-b', 'main']);
  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'user.name', 'Test Author']);
  git(work, ['config', 'user.email', 'author@example.com']);
  commitFile(work, { 'README.md': '# clonesrc\n', 'src/a.txt': 'a\n' }, 'Clone base 1');
  commitFile(work, { 'docs/b.txt': 'b\n' }, 'Clone base 2');
  commitFile(work, { 'src/a.txt': 'a changed\n' }, 'Clone base 3');
  const url = pathToFileURL(origin).href;
  if (!url.startsWith('file://') || !norm(origin).startsWith(norm(ROOT) + sep)) throw new Error(`Fixture origin must be file:// inside ${ROOT}: ${origin}`);
  git(work, ['remote', 'add', 'origin', url]);
  git(work, ['push', 'origin', 'main']);
  const parent = freshDir('clone-parent');
  return { origin, url, parent, name: 'clonesrc', target: join(parent, 'clonesrc') };
}

/** A fresh EMPTY folder to create a repo in, with one sub-folder "inner" for the pick-mode Browse test. */
export function createPickFx(): { parent: string; inner: string } {
  const parent = freshDir('create-parent');
  const inner = join(parent, 'inner');
  mkdirSync(inner);
  if (!existsSync(inner)) throw new Error('fixture: inner folder missing');
  return { parent, inner };
}
