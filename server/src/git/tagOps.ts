import { repoIdFor } from '../state/registry';
import { runExclusive } from './queue';
import { hasExtUrl, net, readRemotes } from './remote';
import { runGit, type GitResult } from './runner';
import { scrubSecrets } from './scrub';
import { pin } from './snapshot';
import { record } from './undo';

/*
 * V2 tag operations: push a tag, delete it locally (journaled, pinned first), delete it from a remote. Every function runs inside one
 * runExclusive for the repo. The request carries the sha the UI shows; inside the lock it must equal the tag's commit, else 'stale' (409).
 * Never `+`, never -f. The remote delete is a scoped exception to phase 7's no-`--delete` rule: one tag, guarded by a lease on the
 * local tag object, and only while the local tag exists.
 */

export interface TagResult {
  /** refused = bad input or a failed precondition (nothing changed). stale = the sha is out of date (409). failed = git ran and failed. */
  outcome: 'done' | 'refused' | 'stale' | 'failed';
  error?: string;
  stderr?: string;
}

const SHA = /^[0-9a-f]{40,64}$/;
const run = (root: string, repoId: string, args: string[]): Promise<GitResult> => runGit(args, { cwd: root, repoId });
const refused = (error: string): TagResult => ({ outcome: 'refused', error });
function failed(res: GitResult, fallback: string): TagResult {
  const text = scrubSecrets(`${res.stderr}${res.stdout}`.trim());
  return { outcome: 'failed', error: text.split('\n')[0] || fallback, stderr: text || `git exited with code ${res.code}.` };
}

interface Checked {
  name: string;
  /** The tag object (the commit itself for a lightweight tag). */
  tagObj: string;
}

/** Name, sha and existence checks, all inside the lock. */
async function checkTag(root: string, repoId: string, name: unknown, sha: unknown): Promise<Checked | TagResult> {
  // eslint-disable-next-line no-control-regex
  if (typeof name !== 'string' || name === '' || name.length > 255 || name.startsWith('-') || name.includes('+') || /[\x00-\x1f\x7f]/.test(name)) return refused('The given tag name is not valid');
  if (typeof sha !== 'string' || !SHA.test(sha)) return refused('Invalid commit id.');
  if ((await run(root, repoId, ['check-ref-format', `refs/tags/${name}`])).code !== 0) return refused('The given tag name is not valid');
  if ((await run(root, repoId, ['show-ref', '--verify', '--quiet', `refs/tags/${name}`])).code !== 0) return refused('That is not an existing tag.');
  const commit = await run(root, repoId, ['rev-parse', '--verify', '--end-of-options', `refs/tags/${name}^{commit}`]);
  if (commit.code !== 0 || commit.stdout.trim() !== sha) return { outcome: 'stale', error: 'The tag has changed. Reload and try again.' };
  const obj = await run(root, repoId, ['rev-parse', '--verify', '--end-of-options', `refs/tags/${name}`]);
  if (obj.code !== 0 || !SHA.test(obj.stdout.trim())) return refused('That is not an existing tag.');
  return { name, tagObj: obj.stdout.trim() };
}
const isChecked = (c: Checked | TagResult): c is Checked => 'tagObj' in c;

/** The remote must exist, must not look like an option, and must not use a "::" helper URL. */
async function checkRemote(root: string, repoId: string, remote: unknown): Promise<string | TagResult> {
  if (typeof remote !== 'string' || remote === '' || remote.startsWith('-')) return refused('That is not an existing remote.');
  const found = (await readRemotes(root, repoId)).find((r) => r.name === remote);
  if (!found) return refused('That is not an existing remote.');
  if (hasExtUrl(found)) return refused(`The remote '${found.name}' has a URL that is not supported.`);
  return found.name;
}

export function pushTag(root: string, opts: { name: unknown; sha: unknown; remote: unknown }): Promise<TagResult> {
  const repoId = repoIdFor(root);
  return runExclusive<TagResult>(repoId, async () => {
    const tag = await checkTag(root, repoId, opts.name, opts.sha);
    if (!isChecked(tag)) return tag;
    const remote = await checkRemote(root, repoId, opts.remote);
    if (typeof remote !== 'string') return remote;
    // One explicit refspec, never `+`: a remote tag of that name with another value is refused by git.
    const res = await net(root, repoId, ['push', '--porcelain', '--end-of-options', remote, `refs/tags/${tag.name}:refs/tags/${tag.name}`]);
    return res.code === 0 ? { outcome: 'done' } : failed(res, 'git push failed.');
  });
}

export function deleteTagLocal(root: string, opts: { name: unknown; sha: unknown }): Promise<TagResult> {
  const repoId = repoIdFor(root);
  return runExclusive<TagResult>(repoId, async () => {
    const tag = await checkTag(root, repoId, opts.name, opts.sha);
    if (!isChecked(tag)) return tag;
    // Fail closed: the tag object is pinned first; when that fails the tag is not deleted.
    if (!(await pin(root, repoId, tag.tagObj))) {
      return failed({ code: 1, stdout: '', stderr: `The tag '${tag.name}' could not be saved, so it was not deleted.` }, 'The tag could not be saved (nothing was changed).');
    }
    const del = await run(root, repoId, ['tag', '-d', tag.name]);
    if (del.code !== 0) return failed(del, 'git tag failed.');
    record(root, { kind: 'delete-tag', name: tag.name, sha: tag.tagObj });
    return { outcome: 'done' };
  });
}

export function deleteTagFromRemote(root: string, opts: { name: unknown; sha: unknown; remote: unknown }): Promise<TagResult> {
  const repoId = repoIdFor(root);
  return runExclusive<TagResult>(repoId, async () => {
    const tag = await checkTag(root, repoId, opts.name, opts.sha); // also proves the local tag exists
    if (!isChecked(tag)) return tag;
    const remote = await checkRemote(root, repoId, opts.remote);
    if (typeof remote !== 'string') return remote;
    // The lease is the local tag object: git refuses when the remote tag is not that. --delete goes before --end-of-options.
    const res = await net(root, repoId, [
      'push', '--porcelain', `--force-with-lease=refs/tags/${tag.name}:${tag.tagObj}`, '--delete', '--end-of-options', remote, `refs/tags/${tag.name}`,
    ]);
    return res.code === 0 ? { outcome: 'done' } : failed(res, 'git push failed.');
  });
}
