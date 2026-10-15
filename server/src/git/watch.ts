import { createHash } from 'node:crypto';
import { watch as fsWatch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { isOwnRef } from './ownRefs';
import { runGit, runGitStream } from './runner';

/** Live auto-refresh: one watcher per open repo that turns "something changed" into typed, content-free events. */

export interface Fingerprint {
  head: string;
  refs: string;
  op: string;
  status: string;
}

export interface WatchEvent {
  type: 'status' | 'refs' | 'head' | 'op' | 'off';
}

export interface WatchDeps {
  mode: 'events' | 'poll';
  /** Rejects with an Error whose .code is 'timeout' or 'overflow'. lite = status with -uno. */
  fingerprint(root: string, o: { lite: boolean }): Promise<Fingerprint>;
  /** Throws when the watcher cannot be started at all (that repo then polls). */
  watchFs(root: string, h: { onEvent(filename: string | null): void; onError(): void }): { close(): void };
  repoBusy(repoId: string): boolean;
  onSettled(repoId: string, cb: (expected?: Fingerprint) => void): void;
  /** Folders outside the worktree whose changes matter (a linked worktree's git dir and the common git dir). */
  extraWatchDirs?(root: string): Promise<string[]>;
}

export interface WatchHub {
  subscribe(repoId: string, root: string, listener: (e: WatchEvent) => void): () => void;
  /** The repo's fingerprint now, taken the way its watcher takes it (undefined when it is not watched). */
  currentFingerprint(repoId: string): Promise<Fingerprint | undefined>;
  closeAll(): void;
}

const DEBOUNCE_MS = 400;
const MIN_GAP_MS = 1000;
const POLL_MS = 3000;
const POLL_MARGIN_MS = 50;
const SLOW_MS = 1000;
const GRACE_MS = 5000;
const OFF_BACKOFF_MS = 30_000;
const MAX_REPOS = 8;
const FIELDS = ['head', 'refs', 'op', 'status'] as const;

/** False for noise: .git/objects, *.lock, node_modules, and any .git path that is not one of the state files. null = unknown = true. */
export function isWatchedPath(filename: string | null): boolean {
  if (filename === null) return true;
  const segs = filename.split(/[\\/]+/).filter(Boolean);
  if (segs.includes('node_modules')) return false;
  const last = segs[segs.length - 1] ?? '';
  if (last.endsWith('.lock')) return false;
  if (segs[0] !== '.git') return true;
  const top = segs[1];
  if (top === undefined) return false;
  if (top === 'HEAD' || top === 'index' || top === 'packed-refs') return segs.length === 2;
  if (top === 'refs' || top === 'sequencer') return true;
  return top.startsWith('rebase-') || top.startsWith('MERGE_') || top.endsWith('_HEAD');
}

interface Watched {
  repoId: string;
  root: string;
  listeners: Set<(e: WatchEvent) => void>;
  closers: { close(): void }[];
  mode: 'events' | 'poll';
  baseline?: Fingerprint;
  lite: boolean;
  running: boolean;
  dirty: boolean;
  closed: boolean;
  lastStart: number;
  nextAllowed: number;
  debounce?: ReturnType<typeof setTimeout>;
  wait?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
  settleRegistered: boolean;
  /** A timeout or overflow made the watcher report off; cleared by the next good check. */
  off: boolean;
  pending?: { expected?: Fingerprint };
}

export function createWatchHub(deps: WatchDeps): WatchHub {
  const repos = new Map<string, Watched>();

  const emit = (w: Watched, e: WatchEvent): void => {
    for (const l of [...w.listeners]) {
      try {
        l(e);
      } catch {
        /* one broken listener must not stop the others */
      }
    }
  };

  function armPoll(w: Watched, delay: number): void {
    if (w.mode !== 'poll' || w.closed) return;
    clearTimeout(w.poll);
    w.poll = setTimeout(() => {
      w.poll = undefined;
      if (!tryRun(w)) armPoll(w, POLL_MS + POLL_MARGIN_MS);
    }, delay);
  }

  function registerSettle(w: Watched): void {
    if (w.settleRegistered) return;
    w.settleRegistered = true;
    deps.onSettled(w.repoId, (expected) => {
      w.settleRegistered = false;
      if (w.closed) return;
      w.pending = { expected };
      tryRun(w);
    });
  }

  /** Starts a check now if allowed; otherwise defers (busy, running, rate limit, backoff). Returns true when one started. */
  function tryRun(w: Watched): boolean {
    if (w.closed) return false;
    if (deps.repoBusy(w.repoId)) {
      registerSettle(w);
      return false;
    }
    if (w.running) {
      w.dirty = true;
      return false;
    }
    const now = Date.now();
    const earliest = Math.max(w.lastStart + MIN_GAP_MS, w.nextAllowed);
    if (now < earliest) {
      clearTimeout(w.wait);
      w.wait = setTimeout(() => {
        w.wait = undefined;
        tryRun(w);
      }, earliest - now);
      return false;
    }
    void run(w);
    return true;
  }

  async function run(w: Watched): Promise<void> {
    const isBaseline = w.baseline === undefined;
    const pending = w.pending;
    w.pending = undefined;
    w.running = true;
    w.dirty = false;
    clearTimeout(w.wait);
    w.wait = undefined;
    const started = Date.now();
    w.lastStart = started;
    let fp: Fingerprint | undefined;
    let failure: 'timeout' | 'overflow' | undefined;
    try {
      fp = await deps.fingerprint(w.root, { lite: w.lite });
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code === 'timeout' || code === 'overflow') failure = code;
    }
    w.running = false;
    if (w.closed) return;
    const ended = Date.now();
    const took = ended - started;
    let next = POLL_MS + POLL_MARGIN_MS;

    if (took > SLOW_MS) {
      if (w.mode === 'poll') next = Math.max(5000, 5 * took) + POLL_MARGIN_MS;
      w.nextAllowed = Math.max(w.nextAllowed, ended + 3 * took);
    }
    if (failure === 'timeout' && !w.lite) {
      w.lite = true; // the next check leaves untracked files out
      w.dirty = true;
    } else if (failure) {
      emit(w, { type: 'off' });
      w.off = true;
      w.nextAllowed = Math.max(w.nextAllowed, ended + OFF_BACKOFF_MS);
      next = Math.max(next, OFF_BACKOFF_MS);
    }

    if (fp) {
      w.off = false;
      const from = pending?.expected ?? w.baseline;
      if (from && !isBaseline) for (const k of FIELDS) if (fp[k] !== from[k]) emit(w, { type: k });
      w.baseline = fp;
    }
    if (w.mode === 'poll') armPoll(w, next);
    if (w.dirty) {
      w.dirty = false;
      tryRun(w);
    }
  }

  function trigger(w: Watched): void {
    if (w.closed) return;
    if (deps.repoBusy(w.repoId)) registerSettle(w);
    clearTimeout(w.debounce);
    w.debounce = setTimeout(() => {
      w.debounce = undefined;
      tryRun(w);
    }, DEBOUNCE_MS);
  }

  function addFs(w: Watched, dir: string, prefix: string, retried = false): void {
    let handle: { close(): void } | undefined;
    handle = deps.watchFs(dir, {
      // The path filter runs first: an ignored path allocates and schedules nothing.
      onEvent: (f) => {
        if (isWatchedPath(f === null || prefix === '' ? f : `${prefix}${f}`)) trigger(w);
      },
      onError: () => {
        trigger(w); // one forced check
        if (w.closed) return;
        if (retried) {
          w.mode = 'poll'; // the replacement died as well
          armPoll(w, POLL_MS + POLL_MARGIN_MS);
          return;
        }
        // The watcher that errored may be dead: replace it once; if that fails the repo polls.
        try {
          handle?.close();
        } catch {
          /* already closed */
        }
        w.closers = w.closers.filter((c) => c !== handle);
        try {
          addFs(w, dir, prefix, true);
        } catch {
          w.mode = 'poll';
          armPoll(w, POLL_MS + POLL_MARGIN_MS);
        }
      },
    });
    w.closers.push(handle);
  }

  function start(w: Watched): void {
    if (w.mode === 'events') {
      try {
        addFs(w, w.root, '');
      } catch {
        w.mode = 'poll'; // the watcher cannot be started at all
      }
    }
    if (w.mode === 'events' && deps.extraWatchDirs) {
      void deps
        .extraWatchDirs(w.root)
        .then((dirs) => {
          if (w.closed) return;
          for (const d of dirs) {
            try {
              addFs(w, d, '.git/');
            } catch {
              /* the worktree watcher still works */
            }
          }
        })
        .catch(() => undefined);
    }
    void run(w); // silent baseline; arms the poll timer in poll mode
  }

  function close(w: Watched): void {
    w.closed = true;
    clearTimeout(w.debounce);
    clearTimeout(w.wait);
    clearTimeout(w.poll);
    clearTimeout(w.grace);
    for (const c of w.closers) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
    }
    w.closers = [];
    w.listeners.clear();
    if (repos.get(w.repoId) === w) repos.delete(w.repoId);
  }

  return {
    subscribe(repoId, root, listener) {
      let w = repos.get(repoId);
      if (!w) {
        if (repos.size >= MAX_REPOS) {
          listener({ type: 'off' });
          return () => undefined;
        }
        w = {
          repoId,
          root,
          listeners: new Set(),
          closers: [],
          mode: deps.mode,
          lite: false,
          running: false,
          dirty: false,
          closed: false,
          lastStart: Date.now(),
          nextAllowed: 0,
          settleRegistered: false,
          off: false,
        };
        repos.set(repoId, w);
        w.listeners.add(listener);
        start(w);
      } else {
        clearTimeout(w.grace);
        w.grace = undefined;
        w.listeners.add(listener);
      }
      const watched = w;
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        watched.listeners.delete(listener);
        if (watched.listeners.size === 0 && !watched.closed) {
          clearTimeout(watched.grace);
          watched.grace = setTimeout(() => close(watched), GRACE_MS);
        }
      };
    },
    async currentFingerprint(repoId) {
      const w = repos.get(repoId);
      if (!w || w.closed || w.off) return undefined; // off: do not make the caller wait
      return deps.fingerprint(w.root, { lite: w.lite });
    },
    closeAll() {
      for (const w of [...repos.values()]) close(w);
    },
  };
}

// ---- real dependencies ------------------------------------------------------------------------------------------

const FP_TIMEOUT_MS = 10_000;
const FP_MAX_BYTES = 8 * 1024 * 1024;
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
const failWith = (code: 'timeout' | 'overflow'): Error => Object.assign(new Error(`watch fingerprint ${code}`), { code });

async function statState(path: string): Promise<string> {
  try {
    const st = await lstat(path);
    return `${st.isDirectory() ? 'd' : 'f'}${Math.floor(st.mtimeMs)}`;
  } catch {
    return '-';
  }
}

/** The four fingerprints of a repo. Read-only, no repoId (so nothing reaches the command log), runner only. */
export async function takeFingerprint(root: string, o: { lite: boolean }): Promise<Fingerprint> {
  const opts = { cwd: root, timeoutMs: FP_TIMEOUT_MS };
  const statusHash = createHash('sha1');
  const [sym, sha, fer, paths, status] = await Promise.all([
    runGit(['symbolic-ref', '-q', 'HEAD'], opts),
    runGit(['rev-parse', '-q', '--verify', 'HEAD'], opts),
    runGit(['for-each-ref', '--format=%(refname) %(objectname)'], opts),
    runGit(['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply'], opts),
    runGitStream(['status', '--porcelain=v2', '-z', o.lite ? '--untracked-files=no' : '--untracked-files=normal'], {
      cwd: root,
      timeoutMs: FP_TIMEOUT_MS,
      maxBytes: FP_MAX_BYTES,
      onData: (c) => void statusHash.update(c),
    }),
  ]);
  if (status.timedOut) throw failWith('timeout');
  if (status.overflow) throw failWith('overflow');
  if (status.code !== 0 || fer.code !== 0 || paths.code !== 0) throw new Error('watch git call failed'); // never hash a failure as empty
  const states = paths.code === 0 ? await Promise.all(paths.stdout.split('\n').filter(Boolean).map((p) => statState(resolve(root, p)))) : [];
  const refLines = fer.stdout.split('\n').filter((l) => !isOwnRef(l)).join('\n');
  const headSha = sha.code === 0 ? sha.stdout.trim() : '';
  return {
    head: sha1(`${sym.code === 0 ? sym.stdout.trim() : ''}\n${headSha}`),
    refs: sha1(refLines),
    op: states.join(','),
    status: statusHash.digest('hex'),
  };
}

/** Folders outside the worktree that hold repo state (linked worktree: its own git dir and the shared one). */
async function extraWatchDirs(root: string): Promise<string[]> {
  const res = await runGit(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: root, timeoutMs: FP_TIMEOUT_MS });
  if (res.code !== 0) return [];
  const out: string[] = [];
  for (const line of res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const dir = resolve(line);
    const rel = relative(resolve(root), dir);
    const inside = rel === '' || (!rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel) && !rel.startsWith('/') && !rel.startsWith('\\'));
    if (!inside && !out.includes(dir)) out.push(dir);
  }
  return out;
}

export function realWatchDeps(mode: 'events' | 'poll', queue: Pick<WatchDeps, 'repoBusy' | 'onSettled'>): WatchDeps {
  return {
    mode,
    fingerprint: takeFingerprint,
    watchFs(root, h) {
      const w = fsWatch(root, { recursive: true }, (_ev, name) => h.onEvent(name == null ? null : String(name)));
      w.on('error', () => h.onError());
      return { close: () => w.close() };
    },
    repoBusy: queue.repoBusy,
    onSettled: queue.onSettled,
    extraWatchDirs,
  };
}
