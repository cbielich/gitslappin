import { describe, expect, it } from 'vitest';
import { isConsecutiveChain, joinMessages, planTodo, type RebaseStep } from './rewrite';

/*
 * V4 contract (shared/src/rewrite.ts, pure, no Node/DOM; the builder must also export it from shared/src/index.ts):
 *   type RebaseAction = 'pick' | 'reword' | 'squash' | 'drop'
 *   interface RebaseStep { sha: string; action: RebaseAction; message?: string }
 *   planTodo(plan: string[], steps: RebaseStep[]): { ok: true; lines: string[] } | { ok: false; error: string }
 *     plan  = the shas of the plan set, OLDEST FIRST (rev-list --reverse upstream..HEAD)
 *     steps = the user's rows in TODO order, OLDEST FIRST (the panel shows newest first and reverses before calling)
 *     lines = `pick <sha>` for pick and reword (a reword target is rebuilt first, so git only picks it), `fixup <sha>` for squash,
 *             `drop <sha>` for drop. Nothing else ever appears (design: "todo holds only pick/fixup/drop").
 *     refused (ok:false, lines absent): steps are not a permutation of exactly `plan` (missing, extra, duplicate, unknown sha),
 *             an unknown action, or the FIRST (oldest) row is a squash.
 *   joinMessages(messages: string[]): string     messages OLDEST FIRST, trailing newlines trimmed, joined by one blank line.
 *     (UNVERIFIED against GitKraken per the design; the trimming rule is the test author's choice.)
 *   isConsecutiveChain(shas: string[], parents: Record<string, string[]>): boolean
 *     true when the shas (any order, no duplicates, at least 1) form one first-parent chain: exactly one of them has no
 *     first parent inside the set (the oldest), each other one's first parent is in the set, no two share a first parent,
 *     and none is a merge (parents.length > 1). `parents` maps every sha in the set to its parents.
 */

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const step = (sha: string, action: RebaseStep['action'], message?: string): RebaseStep => ({ sha, action, ...(message === undefined ? {} : { message }) });

describe('planTodo', () => {
  it('maps pick / reword / squash / drop to pick / pick / fixup / drop, in the given (oldest first) order', () => {
    const r = planTodo([A, B, C, D], [step(A, 'pick'), step(B, 'squash'), step(C, 'drop'), step(D, 'reword', 'new words')]);
    expect(r).toEqual({ ok: true, lines: [`pick ${A}`, `fixup ${B}`, `drop ${C}`, `pick ${D}`] });
  });

  it('a reordered permutation is accepted and keeps the new order', () => {
    const r = planTodo([A, B, C], [step(C, 'pick'), step(A, 'pick'), step(B, 'pick')]);
    expect(r).toEqual({ ok: true, lines: [`pick ${C}`, `pick ${A}`, `pick ${B}`] });
  });

  it('only fixed verbs plus 40 or 64 hex shas ever appear', () => {
    const sha64 = 'e'.repeat(64);
    const r = planTodo([A, sha64], [step(A, 'reword', 'x\ny'), step(sha64, 'squash')]);
    expect(r.ok).toBe(true);
    if (r.ok) for (const l of r.lines) expect(l).toMatch(/^(pick|fixup|drop) ([0-9a-f]{40}|[0-9a-f]{64})$/);
  });

  it('refuses a squash as the OLDEST row, and says so (nothing to squash into)', () => {
    const r = planTodo([A, B], [step(A, 'squash'), step(B, 'pick')]);
    expect(r.ok).toBe(false);
    expect('lines' in r).toBe(false);
  });

  it('a squash that is not the oldest row is fine, also right after a drop is not tested here (git decides)', () => {
    expect(planTodo([A, B], [step(A, 'pick'), step(B, 'squash')]).ok).toBe(true);
  });

  it('refuses steps that are not a permutation of the plan: missing, extra, duplicate, unknown sha', () => {
    expect(planTodo([A, B, C], [step(A, 'pick'), step(B, 'pick')]).ok).toBe(false); // missing C
    expect(planTodo([A, B], [step(A, 'pick'), step(B, 'pick'), step(C, 'pick')]).ok).toBe(false); // extra C
    expect(planTodo([A, B], [step(A, 'pick'), step(A, 'pick')]).ok).toBe(false); // duplicate, B missing
    expect(planTodo([A, B], [step(A, 'pick'), step(D, 'pick')]).ok).toBe(false); // unknown D
    expect(planTodo([A], []).ok).toBe(false);
  });

  it('refuses an unknown action', () => {
    expect(planTodo([A], [{ sha: A, action: 'exec' as never }]).ok).toBe(false);
    expect(planTodo([A], [{ sha: A, action: 'fixup' as never }]).ok).toBe(false);
  });

  it('a sha that is not plain hex is never put in a todo line', () => {
    const evil = 'abc\nexec calc';
    expect(planTodo([evil], [step(evil, 'pick')]).ok).toBe(false);
  });
});

describe('joinMessages', () => {
  it('joins oldest first with one blank line', () => {
    expect(joinMessages(['One', 'Two', 'Three'])).toBe('One\n\nTwo\n\nThree');
  });
  it('trims trailing newlines of each message before joining', () => {
    expect(joinMessages(['One\n', 'Two\n\n'])).toBe('One\n\nTwo');
  });
  it('keeps a multi-line body as it is', () => {
    expect(joinMessages(['Summary\n\nBody line', 'Other'])).toBe('Summary\n\nBody line\n\nOther');
  });
  it('one message is returned as it is (minus trailing newlines)', () => {
    expect(joinMessages(['Only\n'])).toBe('Only');
  });
});

describe('isConsecutiveChain', () => {
  const parents = { [D]: [C], [C]: [B], [B]: [A], [A]: [] as string[] };
  it('accepts adjacent commits in any order', () => {
    expect(isConsecutiveChain([B, C, D], parents)).toBe(true);
    expect(isConsecutiveChain([D, B, C], parents)).toBe(true);
    expect(isConsecutiveChain([C, D], parents)).toBe(true);
  });
  it('refuses a gap', () => {
    expect(isConsecutiveChain([B, D], parents)).toBe(false);
    expect(isConsecutiveChain([A, C, D], parents)).toBe(false);
  });
  it('refuses a duplicate and an empty set', () => {
    expect(isConsecutiveChain([B, B], parents)).toBe(false);
    expect(isConsecutiveChain([], parents)).toBe(false);
  });
  it('refuses a merge commit in the set', () => {
    const X = 'f'.repeat(40);
    const withMerge = { [C]: [B, X], [B]: [A], [A]: [] as string[], [X]: [] as string[] };
    expect(isConsecutiveChain([B, C], withMerge)).toBe(false);
  });
  it('refuses two commits that share a parent (siblings)', () => {
    const X = 'f'.repeat(40);
    const siblings = { [B]: [A], [X]: [A], [A]: [] as string[] };
    expect(isConsecutiveChain([B, X], siblings)).toBe(false);
  });
});
