import { MAX_REWRITE_COMMITS, joinMessages } from '@gitslappin/shared';
import { repoIdFor } from '../state/registry';
import { readOpState } from './opState';
import { runExclusive } from './queue';
import { runGit, type EnvOverride, type GitResult } from './runner';
import { scrubSecrets } from './scrub';
import { pin } from './snapshot';
import { record } from './undo';
import { rewriteLabel } from './rewriteUndo';

/*
 * V4 part A: reword and squash of HEAD's first-parent line, with plumbing only. The tip's tree never changes, so the index, the staged
 * changes and the worktree are untouched (it works on a dirty tree). Steps, all inside one lock: check HEAD (a branch, tip = expectHead),
 * pin the old tip (fail closed), read the commits byte-exact, `commit-tree` the target and every descendant, read each new commit
 * back and check its tree, author bytes, message bytes and parent are exactly the intended ones, then `update-ref` with the old tip as the compare value. No hooks run and GPG signatures are
 * dropped (accepted in the design). The pieces below are exported so part B (interactive rebase) reuses them.
 */

export interface RewriteResult {
  outcome: 'done' | 'refused' | 'failed' | 'blocked';
  error?: string;
  stderr?: string;
  /** With `refused`: the request was well formed but the repository is not in the state it assumed (the route answers 409). */
  stale?: boolean;
  /** The new branch tip. */
  sha?: string;
}

const TIMEOUT_MS = 5 * 60 * 1000;
const SHA = /^[0-9a-f]{40,64}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } as const;
const CAP = `The limit is ${MAX_REWRITE_COMMITS} commits.`;

export type Run = (args: string[], opts?: { input?: string | Buffer; latin1?: boolean; env?: EnvOverride }) => Promise<GitResult>;
export const runner =
  (root: string, repoId: string): Run =>
  (args, opts = {}) =>
    runGit(args, {
      cwd: root,
      repoId,
      timeoutMs: TIMEOUT_MS,
      env: { ...NO_EDITOR, ...(opts.env ?? {}) },
      ...(opts.input === undefined ? {} : { input: opts.input }),
      ...(opts.latin1 ? { encoding: 'latin1' as const } : {}),
    });

const bad = (error: string): RewriteResult => ({ outcome: 'refused', error });
const stale = (error: string): RewriteResult => ({ outcome: 'refused', error, stale: true });
function failedWith(res: GitResult, fallback: string): RewriteResult {
  const text = scrubSecrets(`${res.stderr}${res.stdout}`.trim());
  return { outcome: 'failed', error: text.split('\n')[0] || fallback, stderr: text || `git exited with code ${res.code}.` };
}

/** One commit as git stores it. Strings are latin1 (one char per byte), so nothing is lost on the way back. */
export interface RawCommit {
  sha: string;
  tree: string;
  parents: string[];
  /** The author header without the `author ` key: `Name <email> epoch tz`. */
  author: string;
  message: string;
  hasEncoding: boolean;
}

function parseCommit(sha: string, content: string): RawCommit | null {
  const split = content.indexOf('\n\n');
  const head = split < 0 ? content : content.slice(0, split);
  const message = split < 0 ? '' : content.slice(split + 2);
  let tree = '';
  let author: string | null = null;
  let hasEncoding = false;
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith(' ')) continue; // a continuation line (gpgsig, mergetag)
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree' && tree === '') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author' && author === null) author = val;
    else if (key === 'encoding') hasEncoding = true;
  }
  if (!SHA.test(tree) || author === null || !parents.every((p) => SHA.test(p))) return null;
  return { sha, tree, parents, author, message, hasEncoding };
}

/** The commits, in the order asked (one `cat-file --batch`). null = one is missing or unreadable. */
export async function readCommits(run: Run, shas: string[]): Promise<RawCommit[] | null> {
  if (shas.length === 0) return [];
  const res = await run(['cat-file', '--batch'], { input: `${shas.join('\n')}\n`, latin1: true });
  if (res.code !== 0) return null;
  const out: RawCommit[] = [];
  let pos = 0;
  for (const sha of shas) {
    const nl = res.stdout.indexOf('\n', pos);
    if (nl < 0) return null;
    const [, type, size] = res.stdout.slice(pos, nl).split(' ');
    const len = Number(size);
    if (type !== 'commit' || !Number.isInteger(len)) return null;
    const c = parseCommit(sha, res.stdout.slice(nl + 1, nl + 1 + len));
    if (!c) return null;
    out.push(c);
    pos = nl + 1 + len + 1;
  }
  return out;
}

/**
 * Name, email and date of an author header as the environment git reads them. Decoded as UTF-8 (a header that is not valid UTF-8 is
 * refused). A name or email holding `<`, `>`, a newline or NUL is refused, never mangled. null = refuse.
 */
export function authorEnv(author: string): EnvOverride | null {
  const bytes = Buffer.from(author, 'latin1');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null;
  const m = /^(.*) <([^\n]*)> (\d+) ([+-]\d{4})$/.exec(text);
  if (!m) return null;
  const [, name = '', email = '', epoch = '', tz = ''] = m;
  if (/[<>\n\0]/.test(name) || /[<>\n\0]/.test(email)) return null;
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: `@${epoch} ${tz}` };
}

/** HEAD: a branch whose tip equals `expectHead`. Everything refuses (409) when it is not. */
export async function headFor(run: Run, expectHead: string): Promise<{ tip: string; ref: string; branch: string } | RewriteResult> {
  const [sha, sym] = await Promise.all([run(['rev-parse', '-q', '--verify', 'HEAD']), run(['symbolic-ref', '-q', 'HEAD'])]);
  const ref = sym.code === 0 ? sym.stdout.trim() : '';
  if (sha.code !== 0 || !ref.startsWith('refs/heads/')) return stale('A branch must be checked out.');
  const tip = sha.stdout.trim();
  if (tip !== expectHead) return stale('The branch has changed. Reload and try again.');
  return { tip, ref, branch: ref.slice('refs/heads/'.length) };
}

interface LineCommit {
  sha: string;
  parents: string[];
}

/** HEAD's first-parent line, newest first, at most MAX + 2 commits (a longer line is told apart by its length). */
async function firstParentLine(run: Run, tip: string): Promise<LineCommit[] | null> {
  const res = await run(['rev-list', '--first-parent', '--parents', `--max-count=${MAX_REWRITE_COMMITS + 2}`, '--end-of-options', tip]);
  if (res.code !== 0) return null;
  return res.stdout
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [sha = '', ...parents] = l.split(' ');
      return { sha, parents };
    });
}

export interface Step {
  tree: string;
  author: string;
  message: Buffer;
}

/** Builds the chain `steps` (oldest first) on top of `baseParent`, then checks it and moves the branch. */
export async function buildAndMove(run: Run, h: { tip: string; ref: string; branch: string }, baseParent: string | null, steps: Step[], label: string, root: string): Promise<RewriteResult> {
  const repoId = repoIdFor(root);
  const envs = steps.map((s) => authorEnv(s.author));
  if (envs.some((e) => e === null)) return bad('A commit has an author name or email that cannot be rewritten safely.');
  if (!(await pin(root, repoId, h.tip))) return failedWith({ code: 1, stdout: '', stderr: 'Could not protect the current tip (nothing was changed).' }, 'Could not protect the current tip.');
  let parent = baseParent;
  const made: string[] = [];
  for (const [i, s] of steps.entries()) {
    const args = ['-c', 'commit.gpgsign=false', '-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', s.tree, ...(parent ? ['-p', parent] : []), '-F', '-'];
    const res = await run(args, { input: s.message, env: envs[i] as EnvOverride });
    const sha = res.stdout.trim();
    if (res.code !== 0 || !SHA.test(sha)) return failedWith(res, 'git commit-tree failed (nothing was changed).');
    made.push(sha);
    parent = sha;
  }
  // Every new commit must have kept its tree and its author bytes (git trims some characters of a name), or nothing moves.
  const back = await readCommits(run, made);
  if (!back) return failedWith({ code: 1, stdout: '', stderr: 'Could not read back the new commits (nothing was changed).' }, 'Could not read back the new commits.');
  for (const [i, c] of back.entries()) {
    const s = steps[i]!;
    const wantParent = i === 0 ? baseParent : made[i - 1]!;
    const parentsOk = c.parents.length === (wantParent ? 1 : 0) && (wantParent === null || c.parents[0] === wantParent);
    if (c.tree !== s.tree || c.author !== s.author || c.hasEncoding || !parentsOk || c.message !== s.message.toString('latin1')) {
      return bad('A commit would not keep its author, message and parent exactly, so nothing was changed.');
    }
  }
  const newTip = made[made.length - 1]!;
  const mv = await run(['update-ref', '-m', `gitslappin: ${label}`.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 200), h.ref, newTip, h.tip]);
  if (mv.code !== 0) return failedWith(mv, 'git update-ref failed.');
  record(root, { kind: 'rewrite', branch: h.branch, oldTip: h.tip, newTip, sameTree: true, label });
  return { outcome: 'done', sha: newTip };
}

const msgBuf = (m: string): Buffer => Buffer.from(m.endsWith('\n') ? m : `${m}\n`, 'utf8');
const shaOk = (v: unknown): v is string => typeof v === 'string' && SHA.test(v);

/** New message for `sha`, which must be on HEAD's first-parent line with no merge between it and HEAD. The commits above it are rebuilt. */
export function rewordCommit(root: string, opts: { sha: string; expectHead: string; message: string }): Promise<RewriteResult> {
  const repoId = repoIdFor(root);
  return runExclusive<RewriteResult>(repoId, async () => {
    const run = runner(root, repoId);
    if ((await readOpState(root)) !== undefined) return { outcome: 'blocked', error: 'Another operation is in progress.' };
    const { sha, expectHead, message } = opts;
    if (!shaOk(sha) || !shaOk(expectHead)) return bad('Invalid commit id.');
    if (typeof message !== 'string' || message.trim() === '') return bad('The message cannot be empty.');
    if (message.includes('\0') || Buffer.from(message, 'utf8').toString('utf8') !== message) return bad('The message is not valid text.');
    if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) return bad('The message is too long (64 KB at most).');
    const h = await headFor(run, expectHead);
    if ('outcome' in h) return h;

    const line = await firstParentLine(run, h.tip);
    if (!line) return failedWith({ code: 1, stdout: '', stderr: 'git rev-list failed.' }, 'git rev-list failed.');
    const idx = line.findIndex((c) => c.sha === sha);
    if (idx < 0) return stale(line.length > MAX_REWRITE_COMMITS + 1 ? `The commit is too far back. ${CAP}` : 'The commit is not on the current branch line.');
    if (idx > MAX_REWRITE_COMMITS) return bad(`Too many commits above it would be rebuilt. ${CAP}`);
    const chain = line.slice(0, idx + 1).reverse(); // oldest (the target) first
    if (chain.some((c) => c.parents.length > 1)) return stale('A merge commit is in the way, so this history cannot be rewritten here.');

    const commits = await readCommits(run, chain.map((c) => c.sha));
    if (!commits) return failedWith({ code: 1, stdout: '', stderr: 'Could not read the commits.' }, 'Could not read the commits.');
    if (commits.some((c) => c.hasEncoding)) return bad('A commit has an encoding header, which is not supported.');
    const steps: Step[] = commits.map((c, i) => ({ tree: c.tree, author: c.author, message: i === 0 ? msgBuf(message) : Buffer.from(c.message, 'latin1') }));
    const subject = message.split('\n')[0] ?? '';
    return buildAndMove(run, h, commits[0]!.parents[0] ?? null, steps, rewriteLabel('reword', subject), root);
  });
}

/** Squashes 2 or more consecutive commits of HEAD's first-parent line into one (the oldest's author and parent, the newest's tree). */
export function squashCommits(root: string, opts: { shas: string[]; expectHead: string }): Promise<RewriteResult> {
  const repoId = repoIdFor(root);
  return runExclusive<RewriteResult>(repoId, async () => {
    const run = runner(root, repoId);
    if ((await readOpState(root)) !== undefined) return { outcome: 'blocked', error: 'Another operation is in progress.' };
    const { shas, expectHead } = opts;
    if (!Array.isArray(shas) || !shaOk(expectHead) || !shas.every(shaOk)) return bad('Invalid commit id.');
    if (shas.length > MAX_REWRITE_COMMITS) return bad(`Too many commits. ${CAP}`);
    if (shas.length < 2) return bad('Select at least two commits to squash.');
    if (new Set(shas).size !== shas.length) return bad('A commit is listed twice.');
    const h = await headFor(run, expectHead);
    if ('outcome' in h) return h;

    const line = await firstParentLine(run, h.tip);
    if (!line) return failedWith({ code: 1, stdout: '', stderr: 'git rev-list failed.' }, 'git rev-list failed.');
    const idxs = shas.map((s) => line.findIndex((c) => c.sha === s));
    if (idxs.some((i) => i < 0)) return stale(line.length > MAX_REWRITE_COMMITS + 1 ? `A commit is too far back. ${CAP}` : 'A commit is not on the current branch line.');
    const young = Math.min(...idxs); // newest-first indexes
    const old = Math.max(...idxs);
    if (old - young + 1 !== shas.length) return bad('The commits are not consecutive.');
    if (old > MAX_REWRITE_COMMITS) return bad(`Too many commits would be rebuilt. ${CAP}`);
    const chain = line.slice(0, old + 1).reverse(); // oldest first, up to HEAD
    if (chain.some((c) => c.parents.length > 1)) return stale('A merge commit is in the way, so this history cannot be rewritten here.');

    const commits = await readCommits(run, chain.map((c) => c.sha));
    if (!commits) return failedWith({ code: 1, stdout: '', stderr: 'Could not read the commits.' }, 'Could not read the commits.');
    if (commits.some((c) => c.hasEncoding)) return bad('A commit has an encoding header, which is not supported.');
    const range = commits.slice(0, shas.length); // oldest .. youngest of the range
    const last = range[range.length - 1]!;
    const merged: Step = { tree: last.tree, author: range[0]!.author, message: Buffer.from(`${joinMessages(range.map((c) => c.message))}\n`, 'latin1') };
    const steps: Step[] = [merged, ...commits.slice(shas.length).map((c) => ({ tree: c.tree, author: c.author, message: Buffer.from(c.message, 'latin1') }))];
    return buildAndMove(run, h, range[0]!.parents[0] ?? null, steps, `squash ${shas.length} commits`, root);
  });
}
