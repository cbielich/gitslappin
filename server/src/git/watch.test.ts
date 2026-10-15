import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createWatchHub, isWatchedPath, type Fingerprint, type WatchDeps, type WatchEvent } from './watch';
import { onSettled, repoBusy, runExclusive } from './queue';

/*
 * ASSUMED API (the builder must export exactly this; nothing here runs real git or touches any repo or disk).
 *
 * server/src/git/watch.ts
 *   type Fingerprint = { head: string; refs: string; op: string; status: string }
 *   type WatchEvent  = { type: 'status' | 'refs' | 'head' | 'op' | 'off' }          (no other keys: no paths, no content)
 *   isWatchedPath(filename: string | null): boolean
 *       filename is relative to the watched root, '/' or '\' separators; null = unknown = true.
 *       false for: .git/objects/**, anything ending .lock, any node_modules segment, and any .git path not in the allowlist
 *       (HEAD, index, refs/**, packed-refs, *_HEAD, rebase-*, MERGE_*, sequencer/**).
 *   createWatchHub(deps: WatchDeps): { subscribe(repoId: string, root: string, listener: (e: WatchEvent) => void): () => void }
 *       subscribe starts that repo's watcher (first subscriber) and takes a silent baseline fingerprint at once; the returned
 *       function unsubscribes; the watcher is closed 5000 ms after the last subscriber left (a new subscriber inside the grace keeps it).
 *       At most 8 repos are watched: the 9th repo's listener gets { type: 'off' } and no watcher is started for it.
 *   WatchDeps = {
 *     mode: 'events' | 'poll';
 *     fingerprint(root: string, o: { lite: boolean }): Promise<Fingerprint>;   // lite = status with -uno
 *         rejects with an Error whose .code is 'timeout' (10 s) or 'overflow' (8 MB cap).
 *     watchFs(root: string, h: { onEvent(filename: string | null): void; onError(): void }): { close(): void };
 *         throws when the watcher cannot be started at all (-> that repo uses poll mode).
 *     repoBusy(repoId: string): boolean;                    // queue.ts
 *     onSettled(repoId: string, cb: (expected?: Fingerprint) => void): void;   // queue.ts; cb runs once, after the running mutation settled.
 *         `expected` is the fingerprint the action itself produced; the watcher takes its own fingerprint after the action and
 *         re-baselines silently only if it equals `expected`, otherwise it emits the events for the fields that differ.
 *   }
 *   Check rules: baseline is the first fingerprint call. Debounce 400 ms (trailing, each event restarts it), starts of two checks at
 *   least 1000 ms apart, single-flight with ONE dirty rerun. Events mode backoff: a check that took more than 1 s delays the next
 *   one to 3x that duration after it ended. Poll mode: a check every 3000 ms; after a check that took more than 1 s, 5x that duration.
 *   Watcher onError() or a null filename forces ONE check (no switch to poll). fingerprint timeout on a non-lite call -> next call
 *   uses lite:true (no 'off'); timeout on a lite call or overflow -> { type: 'off' } for that repo and a backoff.
 *
 * server/src/git/queue.ts (existing runExclusive stays): repoBusy(repoId): boolean, onSettled(repoId, cb: (expected?: Fingerprint) => void): void.
 * server/src/config.ts: loadConfig(env).watch: 'events' | 'poll' from GITSLAPPIN_WATCH (default 'events', anything else throws).
 */

const FP0: Fingerprint = { head: 'h1', refs: 'r1', op: 'o1', status: 's1' };

interface Harness {
  deps: WatchDeps;
  fp: Fingerprint;
  fs: Map<string, { onEvent: (f: string | null) => void; onError: () => void; closed: boolean }>;
  events: WatchEvent[];
  calls: () => number;
  lite: () => boolean[];
  busy: { v: boolean };
  settled: { repoId: string; cb: (e?: Fingerprint) => void }[];
  setCost: (ms: number) => void;
  hub: ReturnType<typeof createWatchHub>;
}

function harness(over: Partial<WatchDeps> = {}): Harness {
  const h = {} as Harness;
  h.fp = { ...FP0 };
  h.fs = new Map();
  h.events = [];
  h.busy = { v: false };
  h.settled = [];
  let cost = 0;
  h.setCost = (ms) => (cost = ms);
  const fingerprint = vi.fn(async (_root: string, _o: { lite: boolean }) => {
    if (cost > 0) await new Promise((r) => setTimeout(r, cost));
    return { ...h.fp };
  });
  h.deps = {
    mode: 'events',
    fingerprint,
    watchFs: vi.fn((root: string, handlers: { onEvent: (f: string | null) => void; onError: () => void }) => {
      const entry = { ...handlers, closed: false };
      h.fs.set(root, entry);
      return { close: () => void (entry.closed = true) };
    }),
    repoBusy: () => h.busy.v,
    onSettled: (repoId: string, cb: (e?: Fingerprint) => void) => void h.settled.push({ repoId, cb }),
    ...over,
  };
  h.calls = () => fingerprint.mock.calls.length;
  h.lite = () => fingerprint.mock.calls.map((c) => c[1].lite);
  h.hub = createWatchHub(h.deps);
  return h;
}

/** Subscribes and lets the silent baseline finish and the 1 s rate limit pass. */
async function start(h: Harness, repoId = 'repo-a', root = '/fake/a'): Promise<() => void> {
  const unsub = h.hub.subscribe(repoId, root, (e) => h.events.push(e));
  await vi.advanceTimersByTimeAsync(1100);
  expect(h.calls()).toBeGreaterThanOrEqual(1); // baseline ran
  expect(h.events).toEqual([]); // and was silent
  return unsub;
}
const fire = (h: Harness, name: string | null, root = '/fake/a') => h.fs.get(root)!.onEvent(name);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('isWatchedPath', () => {
  it('allows worktree files and the .git state files', () => {
    for (const p of ['src/a.txt', 'README.md', '.gitignore', '.git/HEAD', '.git/index', '.git/refs/heads/main', '.git/packed-refs', '.git/MERGE_HEAD', '.git/CHERRY_PICK_HEAD', '.git/REVERT_HEAD', '.git/MERGE_MSG', '.git/rebase-merge/head-name', '.git/rebase-apply/next', '.git/sequencer/todo', '.git\\refs\\heads\\main']) {
      expect(isWatchedPath(p), p).toBe(true);
    }
  });
  it('ignores .git/objects, other .git files, *.lock and node_modules', () => {
    for (const p of ['.git/objects/ab/cdef', '.git/objects', '.git\\objects\\ab\\cd', '.git/index.lock', '.git/refs/heads/main.lock', 'src/x.lock', 'package.lock', 'node_modules/a/b.js', 'client/node_modules/a/b.js', '.git/COMMIT_EDITMSG', '.git/logs/HEAD', '.git/hooks/pre-commit', '.git/config']) {
      expect(isWatchedPath(p), p).toBe(false);
    }
  });
  it('a null filename is relevant', () => {
    expect(isWatchedPath(null)).toBe(true);
  });
});

describe('check scheduling', () => {
  it('debounces 400 ms, and each new event restarts the wait', async () => {
    const h = harness();
    await start(h);
    const base = h.calls();
    fire(h, 'a.txt');
    await vi.advanceTimersByTimeAsync(399);
    expect(h.calls() - base).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls() - base).toBe(1);

    await vi.advanceTimersByTimeAsync(1500);
    const b2 = h.calls();
    fire(h, 'a.txt');
    await vi.advanceTimersByTimeAsync(300);
    fire(h, 'b.txt');
    await vi.advanceTimersByTimeAsync(399);
    expect(h.calls() - b2).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls() - b2).toBe(1);
  });

  it('starts at most one check per second', async () => {
    const h = harness();
    await start(h);
    const base = h.calls();
    fire(h, 'a.txt');
    await vi.advanceTimersByTimeAsync(400); // check 1 at +400
    expect(h.calls() - base).toBe(1);
    fire(h, 'b.txt'); // debounce would fire at +800, the rate limit says +1400
    await vi.advanceTimersByTimeAsync(999); // +1399
    expect(h.calls() - base).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls() - base).toBe(2);
  });

  it('single flight: triggers during a run give exactly one rerun', async () => {
    const h = harness();
    await start(h);
    const base = h.calls();
    h.setCost(3000);
    fire(h, 'a.txt');
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls() - base).toBe(1); // in flight
    fire(h, 'b.txt');
    fire(h, 'c.txt');
    fire(h, 'd.txt');
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls() - base).toBe(1); // still the first run: no parallel check
    h.setCost(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls() - base).toBe(2); // one rerun, not three
  });
});

describe('path filter', () => {
  it('ignored paths start no timer and no check; allowed ones do', async () => {
    const h = harness();
    await start(h);
    const base = h.calls();
    const timers = vi.getTimerCount();
    for (const p of ['.git/objects/ab/cd', 'x.lock', '.git/index.lock', 'node_modules/p/i.js', '.git/COMMIT_EDITMSG']) fire(h, p);
    expect(vi.getTimerCount()).toBe(timers); // the filter ran before any timer was set
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.calls() - base).toBe(0);
    fire(h, '.git/refs/heads/main');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls() - base).toBe(1); // the path ran, so the zero above means something
  });

  it('a null filename triggers a check', async () => {
    const h = harness();
    await start(h);
    const base = h.calls();
    fire(h, null);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls() - base).toBe(1);
  });

  it('a watcher error forces one check and does not switch to poll mode', async () => {
    const h = harness();
    await start(h);
    const base = h.calls();
    h.fs.get('/fake/a')!.onError();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls() - base).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls() - base).toBe(1); // no polling afterwards
    fire(h, 'a.txt'); // events still work
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls() - base).toBe(2);
  });

  it('poll mode is used only when the watcher cannot start at all', async () => {
    const h = harness({
      watchFs: vi.fn(() => {
        throw new Error('ENOSPC');
      }),
    });
    await start(h);
    const base = h.calls();
    await vi.advanceTimersByTimeAsync(3100);
    expect(h.calls() - base).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.calls() - base).toBe(2);
  });
});

describe('fingerprint diff to typed events', () => {
  const cases: [string, Partial<Fingerprint>, string[]][] = [
    ['status', { status: 's2' }, ['status']],
    ['refs', { refs: 'r2' }, ['refs']],
    ['head', { head: 'h2' }, ['head']],
    ['op', { op: 'o2' }, ['op']],
    ['head and refs together', { head: 'h2', refs: 'r2' }, ['head', 'refs']],
  ];
  for (const [name, change, types] of cases) {
    it(`${name} change emits ${types.join('+')} with no other keys`, async () => {
      const h = harness();
      await start(h);
      Object.assign(h.fp, change);
      fire(h, 'a.txt');
      await vi.advanceTimersByTimeAsync(500);
      expect(h.events.map((e) => e.type).sort()).toEqual([...types].sort());
      for (const e of h.events) expect(Object.keys(e)).toEqual(['type']);
    });
  }

  it('an unchanged fingerprint emits nothing (the check did run)', async () => {
    const h = harness();
    await start(h);
    const base = h.calls();
    fire(h, 'a.txt');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls() - base).toBe(1);
    expect(h.events).toEqual([]);
  });

  it('the new fingerprint becomes the baseline (no repeat event)', async () => {
    const h = harness();
    await start(h);
    h.fp.status = 's2';
    fire(h, 'a.txt');
    await vi.advanceTimersByTimeAsync(500);
    fire(h, 'b.txt');
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.events.map((e) => e.type)).toEqual(['status']);
  });
});

describe('busy deferral and re-baseline', () => {
  it('a trigger while a mutation runs waits for onSettled; a matching fingerprint re-baselines silently', async () => {
    const h = harness();
    await start(h);
    h.busy.v = true;
    const base = h.calls();
    fire(h, 'a.txt');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.calls() - base).toBe(0); // deferred
    expect(h.settled.length).toBeGreaterThanOrEqual(1);
    expect(h.settled[0]!.repoId).toBe('repo-a');

    h.busy.v = false;
    h.fp.status = 's2'; // the action's own result
    h.settled[0]!.cb({ ...h.fp });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.calls() - base).toBe(1); // the post-action fingerprint was taken
    expect(h.events).toEqual([]);

    fire(h, 'b.txt'); // a later ordinary check must not report the action's change again
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.calls() - base).toBe(2);
    expect(h.events).toEqual([]);
  });

  it('an outside change that landed during the action is emitted', async () => {
    const h = harness();
    await start(h);
    h.busy.v = true;
    fire(h, 'a.txt');
    await vi.advanceTimersByTimeAsync(1000);
    h.busy.v = false;
    const expected = { ...h.fp, status: 's2' };
    h.fp.status = 's3'; // somebody else wrote a file as well
    h.settled[0]!.cb(expected);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.events.map((e) => e.type)).toEqual(['status']);
  });
});

describe('caps, grace and failures', () => {
  it('watches at most 8 repos: the 9th gets off and no watcher', async () => {
    const h = harness();
    const evs: Record<string, WatchEvent[]> = {};
    for (let i = 1; i <= 9; i++) {
      evs[`r${i}`] = [];
      h.hub.subscribe(`r${i}`, `/fake/${i}`, (e) => evs[`r${i}`]!.push(e));
    }
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.fs.size).toBe(8);
    expect(h.fs.has('/fake/9')).toBe(false);
    expect(evs['r9']).toEqual([{ type: 'off' }]);
    for (let i = 1; i <= 8; i++) expect(evs[`r${i}`], `r${i}`).toEqual([]);
  });

  it('stops 5 s after the last subscriber leaves; a new one inside the grace keeps it', async () => {
    const h = harness();
    const unsub = await start(h);
    unsub();
    await vi.advanceTimersByTimeAsync(4900);
    expect(h.fs.get('/fake/a')!.closed).toBe(false);
    const again = h.hub.subscribe('repo-a', '/fake/a', () => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.fs.get('/fake/a')!.closed).toBe(false);
    expect(h.deps.watchFs).toHaveBeenCalledTimes(1);
    again();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.fs.get('/fake/a')!.closed).toBe(true);
  });

  it('a timeout on the full status falls back to lite (-uno) without off', async () => {
    const h = harness();
    await start(h);
    const orig = h.deps.fingerprint as ReturnType<typeof vi.fn>;
    orig.mockImplementationOnce(async () => {
      throw Object.assign(new Error('t'), { code: 'timeout' });
    });
    fire(h, 'a.txt');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.lite().slice(-1)).toEqual([true]);
    expect(h.events.find((e) => e.type === 'off')).toBeUndefined();
  });

  it('an overflow emits off', async () => {
    const h = harness();
    await start(h);
    (h.deps.fingerprint as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw Object.assign(new Error('o'), { code: 'overflow' });
    });
    fire(h, 'a.txt');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.events).toContainEqual({ type: 'off' });
  });
});

describe('backoff', () => {
  it('events mode: a 2 s check delays the next to 3x (6 s after it ended)', async () => {
    const h = harness();
    await start(h);
    h.setCost(2000);
    fire(h, 'a.txt');
    await vi.advanceTimersByTimeAsync(400 + 2000); // check ran and ended
    const base = h.calls();
    h.setCost(0);
    fire(h, 'b.txt');
    await vi.advanceTimersByTimeAsync(5800);
    expect(h.calls() - base).toBe(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls() - base).toBe(1);
  });

  it('poll mode: every 3 s, but 5x after a 2 s check (10 s)', async () => {
    const h = harness({ mode: 'poll' });
    h.hub.subscribe('repo-a', '/fake/a', () => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const t0 = h.calls();
    expect(t0).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(3100);
    expect(h.calls()).toBeGreaterThan(t0); // a fast check: next after 3 s
    h.setCost(2000);
    await vi.advanceTimersByTimeAsync(3100); // slow check starts and ends
    await vi.advanceTimersByTimeAsync(2000);
    const base = h.calls();
    h.setCost(0);
    await vi.advanceTimersByTimeAsync(9800);
    expect(h.calls() - base).toBe(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls() - base).toBe(1);
  });
});

describe('queue: repoBusy and onSettled', () => {
  it('repoBusy is true only for the repo whose mutation runs, and onSettled fires once after it settled', async () => {
    expect(repoBusy('unit-q1')).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = runExclusive('unit-q1', () => gate);
    expect(repoBusy('unit-q1')).toBe(true);
    expect(repoBusy('unit-q2')).toBe(false);
    const cb = vi.fn();
    onSettled('unit-q1', cb);
    expect(cb).not.toHaveBeenCalled();
    release();
    await run;
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(repoBusy('unit-q1')).toBe(false);
  });

  it('onSettled also fires when the mutation failed', async () => {
    const cb = vi.fn();
    const run = runExclusive('unit-q3', async () => {
      throw new Error('boom');
    });
    onSettled('unit-q3', cb);
    await run.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('GITSLAPPIN_WATCH config', () => {
  it('defaults to events; accepts events and poll', () => {
    expect(loadConfig({}).watch).toBe('events');
    expect(loadConfig({ GITSLAPPIN_WATCH: 'events' }).watch).toBe('events');
    expect(loadConfig({ GITSLAPPIN_WATCH: 'poll' }).watch).toBe('poll');
  });
  it('anything else throws at startup', () => {
    for (const v of ['bogus', 'off', 'true', '1']) expect(() => loadConfig({ GITSLAPPIN_WATCH: v }), v).toThrow();
  });
});

describe('watch.ts git access', () => {
  it('goes through the runner only (no execFile / spawn / child_process)', () => {
    const src = readFileSync(join(__dirname, 'watch.ts'), 'utf8');
    expect(src).toMatch(/runGit(Stream)?\b/); // the file exists and does use the runner
    expect(src).not.toMatch(/\bexecFile(Sync)?\b/);
    expect(src).not.toMatch(/\bspawn(Sync)?\b/);
    expect(src).not.toMatch(/child_process/);
  });
});
