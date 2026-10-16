import { MAX_REWRITE_COMMITS, joinMessages, planTodo, type RebasePlan, type RebaseStep } from '@gitslappin/shared';
import { repoIdFor } from '../state/registry';
import { autoStash, branchRef, isResult, stashMessageRebase, type IntegrateResult } from './integrate';
import { readOpState } from './opState';
import { runExclusive } from './queue';
import { runGit, type GitResult } from './runner';
import { authorEnv, headFor, readCommits, runner, type RawCommit, type Run } from './rewrite';
import { rewriteLabel } from './rewriteUndo';
import { clearPending, setPending } from './rewritePending';
import { removeTodoFile, writeTodoFile } from './seqEditor';
import { scrubSecrets } from './scrub';
import { pin } from './snapshot';
import { record } from './undo';
import { interactiveRebaseGitProblem } from './version';

/*
 * V4 part B: the interactive rebase engine (a real `git rebase -i`, so conflicts use the phase 6 flow) and the multi cherry-pick that
 * runs through the same engine. git's own todo is replaced by one this server wrote (seq-editor.mjs copies it): only `pick`, `fixup` and
 * `drop` lines with full shas. Reword and squash targets are rebuilt first with commit-tree (same tree and parents, new message), so
 * git never has to ask for a message. Hooks run, as in any rebase.
 */

export interface RebaseRun extends IntegrateResult {
  /** With `bad`: the repository is not in the state the request assumed (the route answers 409 instead of 400). */
  stale?: boolean;
}

const REBASE_TIMEOUT_MS = 10 * 60 * 1000;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CAP = `The limit is ${MAX_REWRITE_COMMITS} commits.`;
const MAX_MESSAGE_BYTES = 64 * 1024;
const REBASE_FLAGS = ['rebase', '-i', '--no-autostash', '--no-autosquash', '--no-update-refs', '--empty=drop'];

const bad = (error: string): RebaseRun => ({ outcome: 'failed', error, stderr: error, bad: true });
const stale = (error: string): RebaseRun => ({ outcome: 'failed', error, stderr: error, bad: true, stale: true });
function failedWith(res: GitResult, fallback: string, stash?: { message: string }): RebaseRun {
  const text = scrubSecrets(`${res.stderr}${res.stdout}`.trim());
  return { outcome: 'failed', error: text.split('\n')[0] || fallback, stderr: text || `git exited with code ${res.code}.`, ...(stash ? { stash } : {}) };
}
const fail = (stderr: string, fallback: string): RebaseRun => failedWith({ code: 1, stdout: '', stderr }, fallback);
/** headFor / the stash step return their own refusal shapes; the route reads the same fields from them. */
const asRun = (r: { outcome: string; error?: string; stale?: boolean }): RebaseRun => ({ outcome: 'failed', error: r.error ?? 'Request refused.', stderr: r.error ?? 'Request refused.', bad: true, ...(r.stale ? { stale: true } : {}) });

let versionProblem: Promise<string | null> | undefined;
const gitProblem = (): Promise<string | null> => (versionProblem ??= interactiveRebaseGitProblem());

/** A full commit sha (verified with rev-parse) or an existing branch. `target` is what git is given: the sha, or the full ref. */
async function resolveRef(root: string, repoId: string, x: unknown): Promise<{ sha: string; target: string } | null> {
  if (typeof x !== 'string' || x === '' || x.includes('\0')) return null;
  if (FULL_SHA.test(x)) {
    const v = await runGit(['rev-parse', '--verify', '--end-of-options', `${x}^{commit}`], { cwd: root, repoId });
    return v.code === 0 && v.stdout.trim() === x ? { sha: x, target: x } : null;
  }
  const found = await branchRef(root, repoId, x);
  return found ? { sha: found.sha, target: found.ref } : null;
}

interface PlanCommit {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
}

/** The commits of `upstream..tip`, newest first (topological). A merge or more than 500 commits is refused. */
async function planRange(root: string, repoId: string, upstream: string, tip: string): Promise<PlanCommit[] | RebaseRun> {
  const res = await runGit(['log', '-z', '--topo-order', `--max-count=${MAX_REWRITE_COMMITS + 1}`, '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%s', '--end-of-options', `${upstream}..${tip}`], { cwd: root, repoId });
  if (res.code !== 0) return failedWith(res, 'git log failed.');
  const out: PlanCommit[] = [];
  for (const rec of res.stdout.split('\0')) {
    if (rec.trim() === '') continue;
    const [sha = '', parents = '', authorName = '', authorEmail = '', subject = ''] = rec.replace(/^\n/, '').split('\x1f');
    if (parents.includes(' ')) return bad('A merge commit is in the way, so this history cannot be rewritten here.');
    out.push({ sha, subject, authorName, authorEmail });
  }
  if (out.length > MAX_REWRITE_COMMITS) return bad(`Too many commits. ${CAP}`);
  if (out.length === 0) return bad('There are no commits to rebase.');
  return out;
}

/** GET plan (read-only, so no lock and no redo clearing): mode `children` (target = a commit on HEAD's line, the plan is the commits above it) or `onto` (target = branch or full sha). */
export function interactivePlan(root: string, mode: unknown, target: unknown): Promise<RebasePlan | RebaseRun> {
  const repoId = repoIdFor(root);
  return (async (): Promise<RebasePlan | RebaseRun> => {
    const run = runner(root, repoId);
    const problem = await gitProblem();
    if (problem) return bad(problem);
    if (mode !== 'children' && mode !== 'onto') return bad('Invalid request.');
    if (await readOpState(root)) return { outcome: 'blocked', error: 'Another operation is in progress.' };
    const head = (await run(['rev-parse', '-q', '--verify', 'HEAD'])).stdout.trim();
    const h = await headFor(run, head);
    if ('outcome' in h) return asRun(h);
    const t = await resolveRef(root, repoId, target);
    if (!t) return bad(mode === 'children' ? 'Invalid commit id.' : 'That is not an existing branch or commit.');
    if (mode === 'children') {
      if (!FULL_SHA.test(target as string)) return bad('Invalid commit id.');
      if ((await run(['merge-base', '--is-ancestor', t.sha, h.tip])).code !== 0) return stale('The commit is not on the current branch line.');
    }
    const commits = await planRange(root, repoId, t.sha, h.tip);
    if (!Array.isArray(commits)) return commits;
    const ontoLabel = mode === 'children' || FULL_SHA.test(target as string) ? t.sha.slice(0, 7) : (target as string);
    return { branch: h.branch, head: h.tip, upstream: target as string, ontoLabel, commits };
  })();
}

const msgText = (m: string): string => Buffer.from(m, 'utf8').toString('latin1');

interface Group {
  leader: number;
  members: number[];
}

/** pick/reword start a group; squash joins the nearest group before it (a drop in between is skipped). null = a squash with nothing to join. */
function groupSteps(steps: RebaseStep[]): Group[] | null {
  const groups: Group[] = [];
  for (const [i, s] of steps.entries()) {
    if (s.action === 'drop') continue;
    if (s.action === 'squash') {
      const g = groups[groups.length - 1];
      if (!g) return null;
      g.members.push(i);
    } else groups.push({ leader: i, members: [] });
  }
  return groups;
}

/** Rebuilds the reword / squash leaders with commit-tree and pins them. Returns old sha -> new sha, or a refusal. */
async function rebuild(root: string, repoId: string, run: Run, plan: Map<string, RawCommit>, steps: RebaseStep[], groups: Group[]): Promise<Map<string, string> | RebaseRun> {
  const out = new Map<string, string>();
  const todo = groups.filter((g) => steps[g.leader]!.action === 'reword' || g.members.length > 0);
  if (todo.length === 0) return out;
  const jobs = todo.map((g) => {
    const lead = plan.get(steps[g.leader]!.sha)!;
    const members = g.members.map((i) => plan.get(steps[i]!.sha)!);
    const reword = steps[g.leader]!.action === 'reword' ? steps[g.leader]!.message! : null;
    const own = reword === null ? lead.message : msgText(reword);
    const text = g.members.length > 0 ? joinMessages([own, ...members.map((m) => m.message)]) : own;
    const body = g.members.length > 0 || text.endsWith('\n') ? `${text.replace(/\n+$/, '')}\n` : `${text}\n`;
    return { lead, members, message: Buffer.from(body, 'latin1'), env: authorEnv(lead.author) };
  });
  if (jobs.some((j) => j.lead.hasEncoding || j.members.some((m) => m.hasEncoding))) return bad('A commit has an encoding header, which is not supported.');
  if (jobs.some((j) => j.env === null)) return bad('A commit has an author name or email that cannot be rewritten safely.');
  const made: string[] = [];
  for (const j of jobs) {
    const args = ['-c', 'commit.gpgsign=false', '-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', j.lead.tree, ...j.lead.parents.flatMap((p) => ['-p', p]), '-F', '-'];
    const res = await run(args, { input: j.message, env: j.env! });
    const sha = res.stdout.trim();
    if (res.code !== 0 || !FULL_SHA.test(sha)) return failedWith(res, 'git commit-tree failed (nothing was changed).');
    made.push(sha);
    out.set(j.lead.sha, sha);
  }
  const back = await readCommits(run, made);
  if (!back) return fail('Could not read back the new commits (nothing was changed).', 'Could not read back the new commits.');
  for (const [i, c] of back.entries()) {
    const j = jobs[i]!;
    if (c.tree !== j.lead.tree || c.author !== j.lead.author || c.hasEncoding || c.message !== j.message.toString('latin1') || c.parents.join(' ') !== j.lead.parents.join(' ')) {
      return bad('A commit would not keep its author, message and parent exactly, so nothing was changed.');
    }
  }
  for (const sha of made) if (!(await pin(root, repoId, sha))) return fail('Could not protect the new commits (nothing was changed).', 'Could not protect the new commits.');
  return out;
}

/** Runs `git rebase -i` with the todo, then settles: done (journaled), conflict (pending entry) or failed. */
async function runTodo(root: string, repoId: string, dataDir: string, lines: string[], tail: string[], head: { tip: string; branch: string }, label: string, stash: { message: string } | undefined): Promise<RebaseRun> {
  let file: Awaited<ReturnType<typeof writeTodoFile>> = null;
  try {
    file = await writeTodoFile(dataDir, lines);
    if (!file) return failedWith({ code: 1, stdout: '', stderr: 'The data folder path cannot be used for the rebase todo (a quote or control character in it).' }, 'The rebase todo could not be prepared.', stash);
    // The time limit goes through an abort signal so the whole process tree is killed (git.exe may be a launcher); execFile's own
    // timeout is a later backstop that would kill only the direct child.
    const res = await runGit([...REBASE_FLAGS, ...tail], {
      cwd: root,
      repoId,
      signal: AbortSignal.timeout(REBASE_TIMEOUT_MS),
      timeoutMs: REBASE_TIMEOUT_MS + 60_000,
      env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: file.command },
    });
    const withStash = stash ? { stash } : {};
    if (res.code === 0) {
      const tip = (await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: root, repoId })).stdout.trim();
      if (FULL_SHA.test(tip) && tip !== head.tip) {
        const [a, b] = await Promise.all([runGit(['rev-parse', `${head.tip}^{tree}`], { cwd: root, repoId }), runGit(['rev-parse', `${tip}^{tree}`], { cwd: root, repoId })]);
        record(root, { kind: 'rewrite', branch: head.branch, oldTip: head.tip, newTip: tip, sameTree: a.code === 0 && a.stdout.trim() === b.stdout.trim(), label });
      }
      return { outcome: 'done', ...withStash };
    }
    // A conflict, and also a timeout that left the rebase in progress: the user sees the rebase state, never a plain failure.
    if ((await readOpState(root))?.kind === 'rebase') {
      setPending(root, { branch: head.branch, oldTip: head.tip, label });
      return { outcome: 'conflict', ...withStash };
    }
    return failedWith(res, 'git rebase failed.', stash);
  } catch (e) {
    return failedWith({ code: 1, stdout: '', stderr: e instanceof Error ? e.message : 'The rebase could not be started.' }, 'The rebase could not be started.', stash);
  } finally {
    if (file) await removeTodoFile(file.path);
  }
}

export interface InteractiveOpts {
  upstream: unknown;
  onto: unknown;
  expectHead: unknown;
  steps: unknown;
}

export function interactiveRebase(root: string, dataDir: string, opts: InteractiveOpts): Promise<RebaseRun> {
  const repoId = repoIdFor(root);
  return runExclusive<RebaseRun>(repoId, async () => {
    const run = runner(root, repoId);
    if (await readOpState(root)) return { outcome: 'blocked', error: 'Another operation is in progress.' };
    clearPending(root);
    const problem = await gitProblem();
    if (problem) return bad(problem);
    const { expectHead, steps: raw } = opts;
    if (typeof expectHead !== 'string' || !FULL_SHA.test(expectHead) || !Array.isArray(raw)) return bad('Invalid request.');
    if (raw.length > MAX_REWRITE_COMMITS) return bad(`Too many commits. ${CAP}`);
    const steps: RebaseStep[] = [];
    for (const s of raw as unknown[]) {
      const o = typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : null;
      if (!o || typeof o.sha !== 'string' || typeof o.action !== 'string') return bad('Invalid request.');
      if (o.message !== undefined && typeof o.message !== 'string') return bad('Invalid request.');
      steps.push({ sha: o.sha, action: o.action as RebaseStep['action'], ...(o.message === undefined ? {} : { message: o.message }) });
    }
    for (const s of steps) {
      if (s.action !== 'reword') continue;
      const m = s.message;
      if (m === undefined || m.trim() === '') return bad('The message cannot be empty.');
      if (m.includes('\0') || Buffer.from(m, 'utf8').toString('utf8') !== m) return bad('The message is not valid text.');
      if (Buffer.byteLength(m, 'utf8') > MAX_MESSAGE_BYTES) return bad('The message is too long (64 KB at most).');
    }
    const h = await headFor(run, expectHead);
    if ('outcome' in h) return asRun(h);
    const up = await resolveRef(root, repoId, opts.upstream);
    const onto = await resolveRef(root, repoId, opts.onto);
    if (!up || !onto) return bad('The upstream and the onto target must be a full commit id or an existing branch.');

    const range = await planRange(root, repoId, up.sha, h.tip);
    if (!Array.isArray(range)) return range;
    const planShas = range.map((c) => c.sha).reverse(); // oldest first
    const todo = planTodo(planShas, steps);
    if (!todo.ok) return bad(todo.error);
    const groups = groupSteps(steps);
    if (!groups) return bad('A squash needs a commit before it to squash into.');

    const needed = [...new Set(groups.flatMap((g) => (steps[g.leader]!.action === 'reword' || g.members.length > 0 ? [g.leader, ...g.members] : [])).map((i) => steps[i]!.sha))];
    const read = await readCommits(run, needed);
    if (!read) return fail('Could not read the commits.', 'Could not read the commits.');
    const byShas = new Map(read.map((c) => [c.sha, c]));

    // Nothing has changed so far. From here on the old tip is protected first (fail closed).
    if (!(await pin(root, repoId, h.tip))) return fail('Could not protect the current tip (nothing was changed).', 'Could not protect the current tip.');
    const rebuilt = await rebuild(root, repoId, run, byShas, steps, groups);
    if (!(rebuilt instanceof Map)) return rebuilt;
    const lines = todo.lines.map((l) => {
      const sp = l.indexOf(' ');
      return `${l.slice(0, sp)} ${rebuilt.get(l.slice(sp + 1)) ?? l.slice(sp + 1)}`;
    });

    const ontoName = typeof opts.onto === 'string' ? opts.onto : onto.sha;
    const stash = await autoStash(root, repoId, stashMessageRebase(h.branch, ontoName));
    if (isResult(stash)) return stash;
    return runTodo(root, repoId, dataDir, lines, ['--onto', onto.target, '--end-of-options', up.target], h, rewriteLabel('rebase', h.branch), stash);
  });
}

/** Multi cherry-pick: `rebase -i HEAD` with a todo of `pick` lines (oldest first), so conflicts are the rebase conflicts. */
export function cherryPickMulti(root: string, dataDir: string, opts: { shas: unknown; expectHead: unknown }): Promise<RebaseRun> {
  const repoId = repoIdFor(root);
  return runExclusive<RebaseRun>(repoId, async () => {
    const run = runner(root, repoId);
    if (await readOpState(root)) return { outcome: 'blocked', error: 'Another operation is in progress.' };
    clearPending(root);
    const problem = await gitProblem();
    if (problem) return bad(problem);
    const { shas, expectHead } = opts;
    if (typeof expectHead !== 'string' || !FULL_SHA.test(expectHead) || !Array.isArray(shas) || !shas.every((s) => typeof s === 'string' && FULL_SHA.test(s))) return bad('Invalid commit id.');
    if (shas.length === 0) return bad('Select at least one commit.');
    if (shas.length > MAX_REWRITE_COMMITS) return bad(`Too many commits. ${CAP}`);
    if (new Set(shas).size !== shas.length) return bad('A commit is listed twice.');
    const list = shas as string[];
    const h = await headFor(run, expectHead);
    if ('outcome' in h) return asRun(h);
    const commits = await readCommits(run, list);
    if (!commits) return bad('Invalid commit id.');
    if (commits.some((c) => c.parents.length > 1)) return bad('A merge commit cannot be cherry-picked.');
    if (!(await pin(root, repoId, h.tip))) return fail('Could not protect the current tip (nothing was changed).', 'Could not protect the current tip.');
    const stash = await autoStash(root, repoId, `Auto stash before cherry pick of "${list[0]!.slice(0, 7)}"`);
    if (isResult(stash)) return stash;
    return runTodo(root, repoId, dataDir, list.map((s) => `pick ${s}`), ['--end-of-options', h.tip], h, `cherry pick ${list.length} commit${list.length === 1 ? '' : 's'}`, stash);
  });
}
