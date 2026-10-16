import { createHash } from 'node:crypto';
import { repoIdFor } from '../state/registry';
import { readOpState } from './opState';
import { redoIgnore, undoIgnore, type IgnoreEntry } from './ignoreUndo';
import { moveRewrite, type RewriteEntry } from './rewriteUndo';
import { runExclusive, setMutationHook } from './queue';
import { hasExtUrl, net, readRemotes } from './remote';
import { runGit, type GitResult } from './runner';
import { scrubSecrets } from './scrub';
import { preState, restoreFile, stateOf, type PinnedFile } from './snapshot';
import { setStashRecorder, type StashEvent } from './stash';

/*
 * Undo / redo (phase 10). A journal per repo, in memory, keyed by the repo root (never by anything a client sends).
 * Every precondition is checked with git inside the repo lock before anything runs; a refusal changes nothing.
 * No command here forces anything: no -f / --force, no `branch -D`. Undo of create-branch is the compare-and-swap
 * `update-ref -d refs/heads/<n> <sha>`. The one `reset --hard` is the undo of a hard reset (phase 11), and it runs only on a clean tree.
 */

interface Head {
  branch: string | null;
  sha: string;
}

/** Entries the mutating routes record (the commit, checkout and branch routes call `record`). */
export type UndoEntry =
  | { kind: 'commit'; sha: string; prev: string | null; branch: string | null; subject: string; amend?: boolean }
  | { kind: 'checkout'; from: Head; to: Head; createdBranch?: string }
  | { kind: 'create-branch'; name: string; sha: string; from: Head; checkedOut: boolean }
  // Phase 11 (destructive.ts records these inside its own lock). None of them has a redo.
  | { kind: 'discard'; head: string; snap: string | null; files: PinnedFile[]; indexAfter: string }
  | { kind: 'reset'; mode: 'soft' | 'mixed' | 'hard'; branch: string; prev: string; to: string; snap: string | null; files: PinnedFile[]; indexAfter: string }
  | { kind: 'delete-branch'; name: string; sha: string; config: { remote?: string; merge?: string }; remote?: { name: string; rb: string; sha: string } }
  // V2: a local tag delete. `sha` is the tag object (the commit for a lightweight tag), pinned under refs/gitslappin/undo/ before the delete.
  | { kind: 'delete-tag'; name: string; sha: string }
  // V3: a .gitignore append (ignore.ts records it inside its own lock).
  | IgnoreEntry
  // V4: reword / squash (and, in part B, interactive rebase and multi cherry-pick). Both directions are kept.
  | RewriteEntry;

interface Snap {
  head: string;
  tree: string;
  diff: string;
  untracked: string;
}

/** Stash entries are recorded by stash.ts itself (through the recorder installed below). */
type Entry =
  | UndoEntry
  | { kind: 'stash'; sha: string; base: string; message: string; paths?: string[] }
  | { kind: 'pop'; sha: string; message: string; head: string; after: Snap; restashed?: string }
  | { kind: 'drop'; sha: string; message: string };

export interface UndoResult {
  outcome: 'done' | 'refused' | 'failed' | 'blocked';
  label?: string;
  error?: string;
  stderr?: string;
}

export interface UndoState {
  undo: { label: string } | null;
  redo: { label: string } | null;
}

const MAX_ENTRIES = 100;
const MAX_REPOS = 20;
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_SUBJECT = 200;
/** Cap for the `paths` of a stash entry and the `untracked` list of a pop snapshot: over it, the entry is not stored at all. */
export const MAX_LIST = 5000;
const TIMEOUT_MS = 5 * 60 * 1000;
const SHA = /^[0-9a-f]{40,64}$/;

/** Texts: UndoRedo-InformationMissing, UndoRedo-UndoCheckoutNotFound, UndoCannotButtonTooltip, RedoCannotButtonTooltip. */
export const MISSING = 'Undo information is missing - it has likely been garbage collected.';
export const NOT_FOUND = 'Reference or commit to checkout was not found';
const CANNOT_UNDO = 'Cannot undo';
const CANNOT_REDO = 'Cannot redo';

interface Journal {
  undo: Entry[];
  redo: Entry[];
}

/** Insertion order is the recency order (a touched repo is moved to the end). */
const journals = new Map<string, Journal>();
const keyOf = (root: string): string => repoIdFor(root);

function journalFor(root: string, create: boolean): Journal | undefined {
  const key = keyOf(root);
  let j = journals.get(key);
  if (j) {
    if (create) {
      journals.delete(key);
      journals.set(key, j);
    }
    return j;
  }
  if (!create) return undefined;
  j = { undo: [], redo: [] };
  journals.set(key, j);
  while (journals.size > MAX_REPOS) journals.delete(journals.keys().next().value as string);
  return j;
}

function push(list: Entry[], e: Entry): void {
  list.push(e);
  while (list.length > MAX_ENTRIES) list.shift();
}

function add(root: string, e: Entry): void {
  const j = journalFor(root, true)!;
  j.redo = [];
  push(j.undo, e);
}

/** What the commit, checkout and branch routes call after they succeeded (inside their lock). Also clears the redo list. */
export function record(root: string, entry: UndoEntry): void {
  add(root, entry.kind === 'commit' ? { ...entry, subject: clipSubject(entry.subject) } : entry);
}

/** A recorded subject is cut to 200 characters (the journal lives in memory). */
export function clipSubject(s: string): string {
  const chars = Array.from(s);
  return chars.length > MAX_SUBJECT ? chars.slice(0, MAX_SUBJECT).join('') : s;
}

/** What every mutation that is not recorded calls: the redo list is no longer valid. */
export function clearRedo(root: string): void {
  const j = journalFor(root, false);
  if (j) j.redo = [];
}

/** Drops the journal of that root only. */
export function forgetRepo(root: string): void {
  journals.delete(keyOf(root));
}

const clean = (s: string): string => s.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
const cut = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

function labelOf(e: Entry): string {
  switch (e.kind) {
    case 'commit':
      return `commit '${cut(clean(e.subject))}'`;
    case 'checkout':
      return `checkout '${cut(clean(e.to.branch ?? e.to.sha.slice(0, 7)))}'`;
    case 'create-branch':
      return `create branch '${cut(clean(e.name))}'`;
    case 'stash':
      return 'stash';
    case 'pop':
      return 'pop stash';
    case 'drop':
      return 'delete stash';
    case 'discard':
      return 'discard changes';
    case 'reset':
      return `reset '${cut(clean(e.branch))}'`;
    case 'delete-branch':
      return `delete branch '${cut(clean(e.name))}'`;
    case 'delete-tag':
      return `delete tag '${cut(clean(e.name))}'`;
    case 'ignore':
      return e.label;
    case 'rewrite':
      return e.label;
  }
}

export function undoState(root: string): UndoState {
  const j = journalFor(root, false);
  const u = j?.undo[j.undo.length - 1];
  const r = j?.redo[j.redo.length - 1];
  return { undo: u ? { label: labelOf(u) } : null, redo: r ? { label: labelOf(r) } : null };
}

// ---- git helpers (all run inside the repo lock) ----

const run = (root: string, repoId: string, args: string[], input?: string | Buffer, extra: { latin1?: boolean; maxBuffer?: number } = {}): Promise<GitResult> =>
  runGit(args, {
    cwd: root,
    repoId,
    timeoutMs: TIMEOUT_MS,
    env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    ...(input === undefined ? {} : { input }),
    ...(extra.latin1 ? { encoding: 'latin1' as const } : {}),
    ...(extra.maxBuffer ? { maxBuffer: extra.maxBuffer } : {}),
  });

const refused = (error: string): UndoResult => ({ outcome: 'refused', error });

function failed(res: GitResult, fallback: string): UndoResult {
  const text = scrubSecrets(`${res.stderr}${res.stdout}`.trim());
  return { outcome: 'failed', error: text.split('\n')[0] || fallback, stderr: text || `git exited with code ${res.code}.` };
}

async function headNow(root: string, repoId: string): Promise<{ sha: string | null; branch: string | null }> {
  const [sha, sym] = await Promise.all([run(root, repoId, ['rev-parse', '-q', '--verify', 'HEAD']), run(root, repoId, ['symbolic-ref', '-q', '--short', 'HEAD'])]);
  return { sha: sha.code === 0 ? sha.stdout.trim() : null, branch: sym.code === 0 ? sym.stdout.trim() : null };
}

/** No staged or unstaged change to a tracked file (untracked files do not count: git itself refuses a switch that would overwrite one). */
async function trackedClean(root: string, repoId: string): Promise<boolean> {
  const res = await run(root, repoId, ['status', '--porcelain', '--untracked-files=no', '-z']);
  return res.code === 0 && res.stdout === '';
}

async function treeIsClean(root: string, repoId: string): Promise<boolean> {
  const res = await run(root, repoId, ['status', '--porcelain', '--untracked-files=all', '-z']);
  return res.code === 0 && res.stdout === '';
}

async function writeTree(root: string, repoId: string): Promise<string | null> {
  const res = await run(root, repoId, ['write-tree']);
  return res.code === 0 && SHA.test(res.stdout.trim()) ? res.stdout.trim() : null;
}

async function exists(root: string, repoId: string, rev: string): Promise<boolean> {
  return (await run(root, repoId, ['cat-file', '-e', `${rev}^{commit}`])).code === 0;
}

async function branchTip(root: string, repoId: string, name: string): Promise<string | null> {
  const res = await run(root, repoId, ['rev-parse', '-q', '--verify', `refs/heads/${name}^{commit}`]);
  return res.code === 0 ? res.stdout.trim() : null;
}

/**
 * How many worktrees (the main one included) have `refs/heads/<name>` checked out. null = git could not say, which counts as "yes".
 * Undo deletes a branch only when at most the current worktree (if it is on it) has it checked out.
 */
async function checkedOutCount(root: string, repoId: string, name: string): Promise<number | null> {
  const res = await run(root, repoId, ['worktree', 'list', '--porcelain']); // no -z: it needs git 2.36 and the minimum is 2.26; a branch name has no newline
  if (res.code !== 0) return null;
  return res.stdout.split('\n').filter((l) => l.replace(/\r$/, '') === `branch refs/heads/${name}`).length;
}

async function branchBusyElsewhere(root: string, repoId: string, name: string, cur: Cur): Promise<boolean> {
  const n = await checkedOutCount(root, repoId, name);
  return n === null || n > (cur.branch === name ? 1 : 0);
}

const BUSY_WORKTREE = (name: string): string => `The branch '${cut(clean(name))}' is checked out in another worktree, so it was not deleted.`;

/** HEAD, the index tree, a hash of the working-tree changes and the untracked names: the state right after a pop. */
async function snapshot(root: string, repoId: string): Promise<Snap | null> {
  const head = (await headNow(root, repoId)).sha;
  const tree = await writeTree(root, repoId);
  const diff = await run(root, repoId, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'], undefined, { latin1: true, maxBuffer: 64 * 1024 * 1024 });
  const others = await run(root, repoId, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!head || !tree || diff.code !== 0 || others.code !== 0) return null;
  const names = others.stdout.split('\0').filter(Boolean);
  if (names.length > MAX_LIST) return null; // too many to keep: the caller records nothing (at undo time it also differs from what was recorded)
  return { head, tree, diff: createHash('sha1').update(diff.stdout, 'latin1').digest('hex'), untracked: names.sort().join('\0') };
}

const sameSnap = (a: Snap, b: Snap): boolean => a.head === b.head && a.tree === b.tree && a.diff === b.diff && a.untracked === b.untracked;

interface StashRow {
  n: number;
  sha: string;
  message: string;
}

async function listStashes(root: string, repoId: string): Promise<StashRow[]> {
  const res = await run(root, repoId, ['stash', 'list', '--format=%H%x00%gs%x1e']);
  if (res.code !== 0) return [];
  const out: StashRow[] = [];
  for (const rec of res.stdout.split('\x1e')) {
    const text = rec.replace(/^\n+/, '');
    if (!text) continue;
    const [sha = '', message = ''] = text.split('\0');
    if (SHA.test(sha)) out.push({ n: out.length, sha, message });
  }
  return out;
}

/** Keeps the stash commit reachable before it is popped or dropped. */
async function keep(root: string, repoId: string, sha: string): Promise<boolean> {
  return (await run(root, repoId, ['update-ref', `refs/gitslappin/stash-keep/${sha}`, sha])).code === 0;
}

/** The text after git's own "On <branch>: " prefix; undefined for the default "WIP on ..." message (git writes it again). */
function userMessage(message: string): string | undefined {
  const m = /^On [^:\n]*: ([\s\S]*)$/.exec(message);
  return m ? m[1] : undefined;
}

const messageOk = (m: string): boolean => !m.includes('\0') && Buffer.from(m, 'utf8').toString('utf8') === m && Buffer.byteLength(m, 'utf8') <= MAX_MESSAGE_BYTES;

/** Paths a stash holds: tracked changes (sha^1 to sha) and untracked files (sha^3). */
async function stashPaths(root: string, repoId: string, sha: string): Promise<string[] | undefined> {
  const nul = async (args: string[]): Promise<string[]> => {
    const r = await run(root, repoId, args);
    return r.code === 0 ? r.stdout.split('\0').filter((p) => p !== '') : [];
  };
  const tracked = await nul(['diff-tree', '-r', '-z', '--name-only', '--no-commit-id', '--no-renames', `${sha}^1`, sha]);
  const untracked = await nul(['ls-tree', '-r', '-z', '--name-only', `${sha}^3`]);
  const all = [...new Set([...tracked, ...untracked])];
  return all.length > MAX_LIST ? undefined : all;
}

async function switchTo(root: string, repoId: string, target: Head): Promise<UndoResult | null> {
  if (target.branch !== null) {
    if ((await branchTip(root, repoId, target.branch)) === null) return refused(NOT_FOUND);
    const res = await run(root, repoId, ['switch', '--no-guess', '--end-of-options', target.branch]);
    return res.code === 0 ? null : failed(res, 'git switch failed.');
  }
  if (!SHA.test(target.sha) || !(await exists(root, repoId, target.sha))) return refused(NOT_FOUND);
  const res = await run(root, repoId, ['switch', '--detach', '--end-of-options', target.sha]);
  return res.code === 0 ? null : failed(res, 'git switch failed.');
}

// ---- undo ----

async function undoEntry(root: string, repoId: string, e: Entry): Promise<{ result: UndoResult; next?: Entry }> {
  const cur = await headNow(root, repoId);
  switch (e.kind) {
    case 'commit': {
      if (e.prev === null) return { result: refused('The first commit of a repository cannot be undone.') };
      if (cur.sha !== e.sha || cur.branch !== e.branch) return { result: refused('The branch has changed since this commit was made.') };
      if (e.amend) {
        if (!SHA.test(e.prev) || !(await exists(root, repoId, e.prev))) return { result: refused(MISSING) };
      } else {
        const parent = await run(root, repoId, ['rev-parse', '-q', '--verify', `${e.sha}^`]);
        if (parent.code !== 0 || parent.stdout.trim() !== e.prev) return { result: refused('The branch has changed since this commit was made.') };
      }
      const res = await run(root, repoId, ['reset', '--soft', e.prev]);
      return res.code === 0 ? { result: { outcome: 'done' }, next: e } : { result: failed(res, 'git reset failed.') };
    }
    case 'checkout': {
      if (cur.sha !== e.to.sha || cur.branch !== e.to.branch) return { result: refused('HEAD has changed since this checkout.') };
      if (!(await trackedClean(root, repoId))) return { result: refused('There are uncommitted changes.') };
      if (e.createdBranch !== undefined && (await branchTip(root, repoId, e.createdBranch)) !== e.to.sha) return { result: refused('The branch has changed since this checkout.') };
      if (e.createdBranch !== undefined && (await branchBusyElsewhere(root, repoId, e.createdBranch, cur))) return { result: refused(BUSY_WORKTREE(e.createdBranch)) };
      const back = await switchTo(root, repoId, e.from);
      if (back) return { result: back };
      if (e.createdBranch !== undefined) {
        // Compare-and-swap: only deletes the branch if it still points where the checkout created it.
        const del = await run(root, repoId, ['update-ref', '-d', `refs/heads/${e.createdBranch}`, e.to.sha]);
        if (del.code !== 0) return { result: failed(del, 'Could not remove the created branch.') };
      }
      return { result: { outcome: 'done' }, next: e };
    }
    case 'create-branch': {
      if (!SHA.test(e.sha)) return { result: refused(MISSING) };
      if ((await branchTip(root, repoId, e.name)) !== e.sha) return { result: refused(`The branch '${cut(clean(e.name))}' has changed, so it was not deleted.`) };
      if (await branchBusyElsewhere(root, repoId, e.name, cur)) return { result: refused(BUSY_WORKTREE(e.name)) };
      if (cur.branch === e.name) {
        if (!(await trackedClean(root, repoId))) return { result: refused('There are uncommitted changes.') };
        const back = await switchTo(root, repoId, e.from);
        if (back) return { result: back };
      }
      const del = await run(root, repoId, ['update-ref', '-d', `refs/heads/${e.name}`, e.sha]);
      return del.code === 0 ? { result: { outcome: 'done' }, next: e } : { result: failed(del, 'Could not delete the branch.') };
    }
    case 'stash': {
      const row = (await listStashes(root, repoId)).find((s) => s.sha === e.sha);
      if (!row) return { result: refused('That stash no longer exists.') };
      if (cur.sha !== e.base) return { result: refused('HEAD has changed since the stash was made.') };
      if (!(await treeIsClean(root, repoId))) return { result: refused('There are uncommitted changes.') };
      if (!(await keep(root, repoId, e.sha))) return { result: refused('Could not protect the stash before popping it.') };
      const paths = await stashPaths(root, repoId, e.sha);
      const res = await run(root, repoId, ['stash', 'pop', `stash@{${row.n}}`]);
      if (res.code !== 0) return { result: failed(res, 'git stash pop failed.') };
      return paths ? { result: { outcome: 'done' }, next: { ...e, paths } } : { result: { outcome: 'done' } }; // over the cap: no redo for this entry
    }
    case 'pop': {
      if (cur.sha !== e.head) return { result: refused('HEAD has changed since the stash was popped.') };
      const now = await snapshot(root, repoId);
      if (!now || !sameSnap(now, e.after)) return { result: refused('The working tree has changed since the stash was popped.') };
      const msg = userMessage(e.message);
      if (msg !== undefined && !messageOk(msg)) return { result: refused('Invalid stash message.') };
      const before = (await listStashes(root, repoId))[0]?.sha;
      const res = await run(root, repoId, ['stash', 'push', '--include-untracked', ...(msg ? ['-m', msg] : [])]);
      if (res.code !== 0) return { result: failed(res, 'git stash failed.') };
      const top = (await listStashes(root, repoId))[0];
      if (!top || top.sha === before) return { result: refused('No local changes to save.') };
      return { result: { outcome: 'done' }, next: { ...e, restashed: top.sha } };
    }
    case 'drop': {
      if (!SHA.test(e.sha) || !(await exists(root, repoId, e.sha))) return { result: refused(MISSING) };
      if ((await listStashes(root, repoId)).some((s) => s.sha === e.sha)) return { result: refused('That stash already exists.') };
      if (!messageOk(e.message)) return { result: refused('Invalid stash message.') };
      const res = await run(root, repoId, ['stash', 'store', '-m', e.message, e.sha]);
      return res.code === 0 ? { result: { outcome: 'done' }, next: e } : { result: failed(res, 'git stash store failed.') };
    }
    case 'discard':
      return { result: await undoDiscard(root, repoId, e, cur) };
    case 'reset':
      return { result: await undoReset(root, repoId, e, cur) };
    case 'delete-branch':
      return { result: await undoDeleteBranch(root, repoId, e) };
    case 'delete-tag': {
      const bad = await tagEntryProblem(root, repoId, e);
      if (bad) return { result: bad };
      if ((await run(root, repoId, ['show-ref', '--verify', '--quiet', `refs/tags/${e.name}`])).code === 0) return { result: refused(`A tag named '${cut(clean(e.name))}' already exists.`) };
      // The empty old value means "only if it does not exist": nothing is overwritten.
      const res = await run(root, repoId, ['update-ref', `refs/tags/${e.name}`, e.sha, '']);
      return res.code === 0 ? { result: { outcome: 'done' }, next: e } : { result: failed(res, 'git update-ref failed.') };
    }
    case 'ignore': {
      const r = await undoIgnore(root, repoId, e);
      return r.outcome === 'done' ? { result: r, next: e } : { result: r };
    }
    case 'rewrite': {
      const r = await moveRewrite(root, repoId, e, 'undo', cur);
      return r.outcome === 'done' ? { result: r, next: e } : { result: r };
    }
  }
}

/** A saved tag entry is only used when its name and sha are still well formed and the pinned object is still there. */
async function tagEntryProblem(root: string, repoId: string, e: { name: string; sha: string }): Promise<UndoResult | null> {
  if (!SHA.test(e.sha) || (await run(root, repoId, ['cat-file', '-e', e.sha])).code !== 0) return refused(MISSING);
  if (e.name === '' || e.name.startsWith('-') || e.name.includes('+') || CTRL.test(e.name)) return refused('The saved tag name is not valid.');
  if ((await run(root, repoId, ['check-ref-format', `refs/tags/${e.name}`])).code !== 0) return refused('The saved tag name is not valid.');
  return null;
}

type Cur = { sha: string | null; branch: string | null };
const nulList = (paths: string[]): string => `${paths.join('\0')}\0`;

/** Restores each pinned path, then the index entries of the tracked ones from the snapshot's index commit. */
async function undoDiscard(root: string, repoId: string, e: Extract<Entry, { kind: 'discard' }>, cur: Cur): Promise<UndoResult> {
  if (cur.sha !== e.head) return refused('HEAD has changed since the changes were discarded.');
  if ((await writeTree(root, repoId)) !== e.indexAfter) return refused('The index has changed since the changes were discarded.');
  for (const f of e.files) {
    const now = await stateOf(root, repoId, f.path);
    // Only the state the discard left (or the original, after an undo that stopped half way) may be overwritten.
    if (now !== f.post && now !== preState(f)) return refused(`'${cut(clean(f.path))}' has changed since the changes were discarded.`);
  }
  const tracked = e.files.filter((f) => f.tracked).map((f) => f.path);
  if (tracked.length > 0 && (!e.snap || !SHA.test(e.snap) || !(await exists(root, repoId, e.snap)))) return refused(MISSING);
  for (const f of e.files) {
    if (f.blob !== null && (await run(root, repoId, ['cat-file', '-e', f.blob])).code !== 0) return refused(MISSING);
  }
  for (const f of e.files) {
    const err = await restoreFile(root, repoId, f);
    if (err) return { outcome: 'failed', error: err };
  }
  if (tracked.length > 0) {
    const res = await run(root, repoId, ['--literal-pathspecs', 'restore', `--source=${e.snap}^2`, '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'], nulList(tracked));
    if (res.code !== 0) return failed(res, 'git restore failed.');
  }
  return { outcome: 'done' };
}

async function undoReset(root: string, repoId: string, e: Extract<Entry, { kind: 'reset' }>, cur: Cur): Promise<UndoResult> {
  if (cur.branch !== e.branch || cur.sha !== e.to) return refused('The branch has moved since the reset.');
  if (!SHA.test(e.prev) || !(await exists(root, repoId, e.prev))) return refused(MISSING);
  if (e.snap && (!SHA.test(e.snap) || !(await exists(root, repoId, e.snap)))) return refused(MISSING);

  if (e.mode === 'soft') {
    const res = await run(root, repoId, ['reset', '--soft', e.prev, '--']);
    return res.code === 0 ? { outcome: 'done' } : failed(res, 'git reset failed.');
  }

  if (e.mode === 'mixed') {
    if ((await writeTree(root, repoId)) !== e.indexAfter) return refused('The index has changed since the reset.');
    if (e.snap) {
      // The old index comes back first (HEAD has not moved yet), then HEAD moves without touching index or files.
      const rt = await run(root, repoId, ['read-tree', `${e.snap}^2`]);
      if (rt.code !== 0) return failed(rt, 'git read-tree failed.');
      const res = await run(root, repoId, ['reset', '--soft', e.prev, '--']);
      return res.code === 0 ? { outcome: 'done' } : failed(res, 'git reset failed.');
    }
    const res = await run(root, repoId, ['reset', '--mixed', e.prev, '--']);
    return res.code === 0 ? { outcome: 'done' } : failed(res, 'git reset failed.');
  }

  // hard: the files are written by git, so the tree must be clean (nothing of the user's can be lost by the way back).
  if (!(await trackedClean(root, repoId))) return refused('There are uncommitted changes.');
  if (e.snap) {
    // The snapshot is applied on top of the old HEAD: no untracked or ignored file may sit on a path it adds.
    const paths = new Set<string>();
    for (const rev of [e.snap, `${e.snap}^2`]) {
      const r = await run(root, repoId, ['diff-tree', '-r', '-z', '--name-only', '--no-commit-id', '--no-renames', e.prev, rev]);
      if (r.code !== 0) return failed(r, 'git diff-tree failed.');
      for (const p of r.stdout.split('\0')) if (p !== '') paths.add(p);
    }
    const [others, ignored] = await Promise.all([
      run(root, repoId, ['ls-files', '--others', '--exclude-standard', '-z']),
      run(root, repoId, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
    ]);
    if (others.code !== 0 || ignored.code !== 0) return failed(others.code !== 0 ? others : ignored, 'git ls-files failed.');
    const there = new Set([...others.stdout.split('\0'), ...ignored.stdout.split('\0')].filter((p) => p !== ''));
    for (const p of paths) if (there.has(p)) return refused(`'${cut(clean(p))}' exists in the working tree, so the changes cannot be put back.`);
  }
  const res = await run(root, repoId, ['reset', '--hard', e.prev, '--']);
  if (res.code !== 0) return failed(res, 'git reset failed.');
  if (e.snap) {
    const ap = await run(root, repoId, ['stash', 'apply', '--index', e.snap]);
    if (ap.code !== 0) return failed(ap, 'git stash apply failed.');
  }
  // Raw bytes: untracked and ignored files the reset overwrote, and the exact bytes of the tracked edits (no line-ending conversion).
  for (const f of e.files) {
    if (f.blob === null) continue;
    const err = await restoreFile(root, repoId, f);
    if (err) return { outcome: 'failed', error: err };
  }
  return { outcome: 'done' };
}

const CTRL = /[\u0000-\u001F\u007F]/;

async function undoDeleteBranch(root: string, repoId: string, e: Extract<Entry, { kind: 'delete-branch' }>): Promise<UndoResult> {
  if (!SHA.test(e.sha) || !(await exists(root, repoId, e.sha))) return refused(MISSING);
  if ((await branchTip(root, repoId, e.name)) !== null) return refused(`A branch named '${cut(clean(e.name))}' already exists.`);
  const cfg = e.config;
  if (cfg.remote !== undefined || cfg.merge !== undefined) {
    if (cfg.remote === undefined || cfg.merge === undefined || CTRL.test(cfg.remote) || CTRL.test(cfg.merge) || cfg.remote.startsWith('-') || !cfg.merge.startsWith('refs/')) return refused('The saved upstream is not valid.');
  }
  if (e.remote) {
    // Additive only: the remote branch is pushed back as it was; git refuses it when the name was taken by another history.
    const remotes = await readRemotes(root, repoId);
    const remote = remotes.find((r) => r.name === e.remote!.name);
    if (!remote || remote.name.startsWith('-')) return refused('That remote no longer exists.');
    if (hasExtUrl(remote)) return refused(`The remote '${cut(clean(remote.name))}' has a URL that is not supported.`);
    if (CTRL.test(e.remote.rb) || e.remote.rb.startsWith('-')) return refused('The saved remote branch is not valid.');
    const push = await net(root, repoId, ['push', '--porcelain', '--no-follow-tags', '--end-of-options', remote.name, `${e.remote.sha}:refs/heads/${e.remote.rb}`]);
    if (push.code !== 0) return failed(push, 'git push failed.');
  }
  const res = await run(root, repoId, ['branch', '--end-of-options', e.name, e.sha]);
  if (res.code !== 0) return failed(res, 'git branch failed.');
  if (cfg.remote !== undefined && cfg.merge !== undefined) {
    const a = await run(root, repoId, ['config', '--local', `branch.${e.name}.remote`, cfg.remote]);
    if (a.code !== 0) return failed(a, 'git config failed.');
    const b = await run(root, repoId, ['config', '--local', `branch.${e.name}.merge`, cfg.merge]);
    if (b.code !== 0) return failed(b, 'git config failed.');
  }
  return { outcome: 'done' };
}

// ---- redo ----

async function redoEntry(root: string, repoId: string, e: Entry): Promise<{ result: UndoResult; next?: Entry }> {
  const cur = await headNow(root, repoId);
  switch (e.kind) {
    case 'commit': {
      if (e.prev === null) return { result: refused(CANNOT_REDO) };
      if (cur.sha !== e.prev || cur.branch !== e.branch) return { result: refused('The branch has changed since the commit was undone.') };
      const tree = await run(root, repoId, ['rev-parse', '-q', '--verify', `${e.sha}^{tree}`]);
      if (tree.code !== 0) return { result: refused(MISSING) };
      if ((await writeTree(root, repoId)) !== tree.stdout.trim()) return { result: refused('The staged changes are no longer the ones of this commit.') };
      const res = await run(root, repoId, ['commit', ...(e.amend ? ['--amend'] : []), '-C', e.sha]);
      if (res.code !== 0) return { result: failed(res, 'git commit failed.') };
      const head = await headNow(root, repoId);
      return { result: { outcome: 'done' }, next: head.sha ? { ...e, sha: head.sha } : e };
    }
    case 'checkout': {
      if (!(await trackedClean(root, repoId))) return { result: refused('There are uncommitted changes.') };
      if (cur.branch !== e.from.branch || (e.from.branch === null && cur.sha !== e.from.sha)) return { result: refused('HEAD has changed since the checkout was undone.') };
      if (e.createdBranch !== undefined) {
        if ((await branchTip(root, repoId, e.createdBranch)) !== null) return { result: refused(`A branch named '${cut(clean(e.createdBranch))}' already exists.`) };
        if (!SHA.test(e.to.sha) || !(await exists(root, repoId, e.to.sha))) return { result: refused(NOT_FOUND) };
        const res = await run(root, repoId, ['switch', '-c', e.createdBranch, '--end-of-options', e.to.sha]);
        return res.code === 0 ? { result: { outcome: 'done' }, next: e } : { result: failed(res, 'git switch failed.') };
      }
      const go = await switchTo(root, repoId, e.to);
      return go ? { result: go } : { result: { outcome: 'done' }, next: e };
    }
    case 'create-branch': {
      if (!SHA.test(e.sha) || !(await exists(root, repoId, e.sha))) return { result: refused(NOT_FOUND) };
      if ((await branchTip(root, repoId, e.name)) !== null) return { result: refused(`A branch named '${cut(clean(e.name))}' already exists.`) };
      const res = await run(root, repoId, ['branch', '--end-of-options', e.name, e.sha]);
      return res.code === 0 ? { result: { outcome: 'done' }, next: e } : { result: failed(res, 'git branch failed.') };
    }
    case 'stash': {
      if (cur.sha !== e.base) return { result: refused('HEAD has changed since the stash was undone.') };
      if (!e.paths || e.paths.length === 0) return { result: refused(MISSING) };
      if (await treeIsClean(root, repoId)) return { result: refused('No local changes to save.') };
      const msg = userMessage(e.message);
      if (msg !== undefined && !messageOk(msg)) return { result: refused('Invalid stash message.') };
      const before = (await listStashes(root, repoId))[0]?.sha;
      const res = await run(
        root,
        repoId,
        ['--literal-pathspecs', 'stash', 'push', '--include-untracked', ...(msg ? ['-m', msg] : []), '--pathspec-from-file=-', '--pathspec-file-nul'],
        `${e.paths.join('\0')}\0`,
      );
      if (res.code !== 0) return { result: failed(res, 'git stash failed.') };
      const top = (await listStashes(root, repoId))[0];
      if (!top || top.sha === before) return { result: refused('No local changes to save.') };
      return { result: { outcome: 'done' }, next: { kind: 'stash', sha: top.sha, base: e.base, message: top.message } };
    }
    case 'pop': {
      if (!e.restashed) return { result: refused(CANNOT_REDO) };
      const row = (await listStashes(root, repoId)).find((s) => s.sha === e.restashed);
      if (!row) return { result: refused('That stash no longer exists.') };
      if (cur.sha !== e.head) return { result: refused('HEAD has changed since the pop was undone.') };
      if (!(await treeIsClean(root, repoId))) return { result: refused('There are uncommitted changes.') };
      if (!(await keep(root, repoId, row.sha))) return { result: refused('Could not protect the stash before popping it.') };
      const res = await run(root, repoId, ['stash', 'pop', `stash@{${row.n}}`]);
      if (res.code !== 0) return { result: failed(res, 'git stash pop failed.') };
      const after = await snapshot(root, repoId);
      if (!after) return { result: { outcome: 'done' } }; // popped, but its state cannot be recorded: nothing to undo afterwards
      return { result: { outcome: 'done' }, next: { kind: 'pop', sha: row.sha, message: row.message, head: e.head, after } };
    }
    case 'drop': {
      const row = (await listStashes(root, repoId)).find((s) => s.sha === e.sha);
      if (!row) return { result: refused('That stash no longer exists.') };
      if (!(await keep(root, repoId, e.sha))) return { result: refused('Could not protect the stash before deleting it.') };
      const res = await run(root, repoId, ['stash', 'drop', `stash@{${row.n}}`]);
      return res.code === 0 ? { result: { outcome: 'done' }, next: e } : { result: failed(res, 'git stash drop failed.') };
    }
    case 'discard':
    case 'reset':
    case 'delete-branch':
      return { result: refused(CANNOT_REDO) }; // never recorded on the redo side: undoing these leaves no redo
    case 'delete-tag': {
      const bad = await tagEntryProblem(root, repoId, e);
      if (bad) return { result: bad };
      // Compare-and-swap: only deletes the tag if it still is the object that was restored.
      const res = await run(root, repoId, ['update-ref', '-d', `refs/tags/${e.name}`, e.sha]);
      return res.code === 0 ? { result: { outcome: 'done' }, next: e } : { result: refused(`The tag '${cut(clean(e.name))}' has changed, so it was not deleted.`) };
    }
    case 'ignore': {
      const r = await redoIgnore(root, repoId, e);
      return r.outcome === 'done' ? { result: r, next: e } : { result: r };
    }
    case 'rewrite': {
      const r = await moveRewrite(root, repoId, e, 'redo', cur);
      return r.outcome === 'done' ? { result: r, next: e } : { result: r };
    }
  }
}

async function step(root: string, direction: 'undo' | 'redo'): Promise<UndoResult> {
  const repoId = repoIdFor(root);
  return runExclusive<UndoResult>(repoId, async () => {
    if ((await readOpState(root)) !== undefined) return { outcome: 'blocked', error: 'Another operation is in progress.' };
    const j = journalFor(root, false);
    const from = direction === 'undo' ? j?.undo : j?.redo;
    const e = from?.[from.length - 1];
    if (!j || !from || !e) return refused(direction === 'undo' ? CANNOT_UNDO : CANNOT_REDO);
    const label = labelOf(e);
    let out: { result: UndoResult; next?: Entry };
    try {
      out = direction === 'undo' ? await undoEntry(root, repoId, e) : await redoEntry(root, repoId, e);
    } catch (err) {
      return { outcome: 'failed', error: scrubSecrets(err instanceof Error ? err.message : 'Request failed.') };
    }
    if (out.result.outcome === 'done') {
      from.pop();
      if (out.next) push(direction === 'undo' ? j.redo : j.undo, out.next);
      journalFor(root, true);
      return { ...out.result, label };
    }
    return out.result;
  }, { keepRedo: true });
}

export const undo = (root: string): Promise<UndoResult> => step(root, 'undo');
export const redo = (root: string): Promise<UndoResult> => step(root, 'redo');

// Every other runExclusive block clears the redo list inside its lock (the journal key is the repo id).
setMutationHook((repoId) => {
  const j = journals.get(repoId);
  if (j) j.redo = [];
});

// ---- stash.ts records through this ----

setStashRecorder(async (root: string, ev: StashEvent): Promise<void> => {
  const repoId = repoIdFor(root);
  if (ev.kind === 'stash') add(root, { kind: 'stash', sha: ev.sha, base: ev.base, message: ev.message });
  else if (ev.kind === 'drop') add(root, { kind: 'drop', sha: ev.sha, message: ev.message });
  else {
    // A pop is recorded only if the tree was clean before it and its state afterwards can be captured.
    const after = ev.cleanBefore ? await snapshot(root, repoId) : null;
    if (!after) clearRedo(root);
    else add(root, { kind: 'pop', sha: ev.sha, message: ev.message, head: after.head, after });
  }
});
