import type { Fingerprint } from './watch';

const tails = new Map<string, Promise<unknown>>();
/** Live auto-refresh (installed by the watch hub): the fingerprint of the repo right after a mutation, taken inside the lock. */
export function setSettleFingerprint(fn: ((repoId: string) => Promise<Fingerprint | undefined>) | undefined): void {
  settleFingerprint = fn;
}

/** True while a runExclusive block for this repo runs or waits. */
export function repoBusy(repoId: string): boolean {
  return (busy.get(repoId) ?? 0) > 0 || settling.has(repoId);
}

/** Runs cb once, after the repo's last queued mutation settled (success or failure); at once (next tick) when none is running. */
export function onSettled(repoId: string, cb: (expected?: Fingerprint) => void): void {
  if (!repoBusy(repoId)) {
    queueMicrotask(() => cb());
    return;
  }
  const list = settleCbs.get(repoId) ?? [];
  list.push(cb);
  settleCbs.set(repoId, list);
}

async function settle(repoId: string): Promise<void> {
  const left = (busy.get(repoId) ?? 1) - 1;
  if (left > 0) busy.set(repoId, left);
  else busy.delete(repoId);
  if (left > 0) return;
  if (!settleCbs.has(repoId)) return;
  // Still "busy" while the post-action fingerprint is taken, so a timer armed during the mutation cannot check against the old baseline.
  settling.add(repoId);
  let expected: Fingerprint | undefined;
  if (settleFingerprint) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<undefined>((ok) => {
      timer = setTimeout(() => ok(undefined), SETTLE_CAP_MS);
    });
    expected = await Promise.race([settleFingerprint(repoId).catch(() => undefined), cap]);
    clearTimeout(timer);
  }
  const cbs = settleCbs.get(repoId) ?? [];
  settleCbs.delete(repoId);
  settling.delete(repoId);
  for (const cb of cbs) {
    try {
      cb(expected);
    } catch {
      /* a listener must not break the queue */
    }
  }
}

/** Running plus waiting blocks per repo (live auto-refresh: the watcher waits while this is above zero). */
const busy = new Map<string, number>();
const settling = new Set<string>();
/** The caller of a mutation never waits longer than this for the post-action fingerprint. */
const SETTLE_CAP_MS = 2000;
const settleCbs = new Map<string, ((expected?: Fingerprint) => void)[]>();
let settleFingerprint: ((repoId: string) => Promise<Fingerprint | undefined>) | undefined;

let pending = 0;
let closed = false;
let onMutation: ((repoId: string) => void) | undefined;

/** Phase 10 hook (installed by undo.ts): called inside the lock before every block except an undo / redo step, so a redo list never survives a change that was not recorded. */
export function setMutationHook(fn: (repoId: string) => void): void {
  onMutation = fn;
}

/** Running plus waiting runExclusive blocks. A multi-step block counts as one until it has finished. */
export function pendingCount(): number {
  return pending;
}

/** Phase 12 (auto-exit): from now on runExclusive rejects. Blocks already counted still run to the end. */
export function stopAccepting(): void {
  closed = true;
}

/** Background work (the V2 auto-fetch) that must give way when a user action wants the same repo's lock. */
const yielders = new Map<string, Set<() => void>>();
export function registerYield(repoId: string, abort: () => void): () => void {
  const set = yielders.get(repoId) ?? new Set();
  set.add(abort);
  yielders.set(repoId, set);
  return () => {
    set.delete(abort);
    if (set.size === 0 && yielders.get(repoId) === set) yielders.delete(repoId);
  };
}

/**
 * Runs fn after all earlier mutations for the same repo have settled. `keepRedo` is only for the undo / redo step itself and for
 * background work. `background` marks the V2 auto-fetch: every other caller first asks registered background work for this repo to abort.
 */
export function runExclusive<T>(repoId: string, fn: () => Promise<T>, opts: { keepRedo?: boolean; background?: boolean } = {}): Promise<T> {
  if (closed) return Promise.reject(new Error('GitSlappin is shutting down.'));
  if (!opts.background) for (const abort of [...(yielders.get(repoId) ?? [])]) abort();
  pending++;
  busy.set(repoId, (busy.get(repoId) ?? 0) + 1);
  const prev = tails.get(repoId) ?? Promise.resolve();
  const body = async (): Promise<T> => {
    try {
      if (!opts.keepRedo) onMutation?.(repoId);
      return await fn();
    } finally {
      await settle(repoId);
    }
  };
  const next = prev.then(body, body).finally(() => {
    pending--;
  });
  tails.set(repoId, next.catch(() => undefined));
  return next;
}
