/* V4 History rewriting: pure helpers shared by the server (validation) and the client (menus, panel). No Node/DOM APIs. */

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'drop';
export interface RebaseStep {
  sha: string;
  action: RebaseAction;
  message?: string;
}

/** Caps (audit security item 3): reword descendants, squash range, plan and multi cherry-pick shas. */
export const MAX_REWRITE_COMMITS = 500;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ACTIONS: readonly string[] = ['pick', 'reword', 'squash', 'drop'];
const VERB: Record<RebaseAction, string> = { pick: 'pick', reword: 'pick', squash: 'fixup', drop: 'drop' };

/**
 * The todo of an interactive rebase. `plan` and `steps` are both OLDEST FIRST. A reword target is rebuilt first, so git only
 * picks it; a squash becomes `fixup` (its message is joined by the server). Only fixed verbs and full hex shas are ever written.
 */
export function planTodo(plan: string[], steps: RebaseStep[]): { ok: true; lines: string[] } | { ok: false; error: string } {
  if (!plan.every((s) => FULL_SHA.test(s))) return { ok: false, error: 'Invalid commit id.' };
  if (steps.length !== plan.length || steps.length === 0) return { ok: false, error: 'The steps are not the commits of the plan.' };
  const inPlan = new Set(plan);
  const seen = new Set<string>();
  for (const s of steps) {
    if (typeof s.sha !== 'string' || !inPlan.has(s.sha) || seen.has(s.sha)) return { ok: false, error: 'The steps are not the commits of the plan.' };
    if (!ACTIONS.includes(s.action)) return { ok: false, error: 'Unknown action.' };
    seen.add(s.sha);
  }
  if (steps[0]!.action === 'squash') return { ok: false, error: 'The oldest commit cannot be squashed: there is nothing to squash it into.' };
  return { ok: true, lines: steps.map((s) => `${VERB[s.action]} ${s.sha}`) };
}

/** Squash message: oldest first, trailing newlines trimmed, one blank line between. (UNVERIFIED against GitKraken.) */
export function joinMessages(messages: string[]): string {
  return messages.map((m) => m.replace(/\n+$/, '')).join('\n\n');
}

/**
 * True when the shas (any order, no duplicates, at least 1) form one first-parent chain with no merge: exactly one has no first
 * parent inside the set, every other one's first parent is in the set, and no two share a first parent.
 */
export function isConsecutiveChain(shas: string[], parents: Record<string, string[]>): boolean {
  if (shas.length === 0) return false;
  const set = new Set(shas);
  if (set.size !== shas.length) return false;
  const usedParents = new Set<string>();
  let roots = 0;
  for (const s of shas) {
    const ps = parents[s];
    if (!ps || ps.length > 1) return false;
    const p = ps[0];
    if (p !== undefined && set.has(p)) {
      if (usedParents.has(p)) return false;
      usedParents.add(p);
    } else roots++;
  }
  return roots === 1;
}

/** GET /rebase/interactive/plan: the commits an interactive rebase would replay, newest first. `upstream` goes back as `upstream` and `onto` of the start call. */
export interface RebasePlanCommit {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
}
export interface RebasePlan {
  branch: string;
  head: string;
  upstream: string;
  ontoLabel: string;
  commits: RebasePlanCommit[];
}
