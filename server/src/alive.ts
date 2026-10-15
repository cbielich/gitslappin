/*
 * Auto-exit (phase 12). The window holds `GET /api/alive` open. When the last one drops the server waits `graceMs`;
 * with no window at all within `noWindowMs` of arm() it also gives up. Either way the decision is: stop accepting git
 * jobs, wait until every job (a multi-step block counts as one) has finished, and only then exit.
 */

export const ALIVE_COMMENT_MS = 15_000;

export interface AutoExitOptions {
  pendingCount: () => number;
  stopAccepting: () => void;
  exit: () => void;
  graceMs?: number;
  noWindowMs?: number;
  pollMs?: number;
}

export interface AutoExit {
  arm(): void;
  connect(): () => void;
}

export function createAutoExit(opts: AutoExitOptions): AutoExit {
  const { pendingCount, stopAccepting, exit, graceMs = 10_000, noWindowMs = 60_000, pollMs = 100 } = opts;
  let armed = false;
  let decided = false;
  let conns = 0;
  let noWindowTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const decide = () => {
    if (decided) return;
    decided = true;
    clearTimeout(noWindowTimer);
    clearTimeout(graceTimer);
    stopAccepting();
    let exited = false;
    const drain = () => {
      if (exited) return;
      if (pendingCount() <= 0) {
        exited = true;
        exit();
      } else setTimeout(drain, pollMs);
    };
    drain();
  };

  return {
    arm() {
      if (armed || decided) return;
      armed = true;
      if (conns === 0) noWindowTimer = setTimeout(() => conns === 0 && decide(), noWindowMs);
    },
    connect() {
      conns++;
      clearTimeout(noWindowTimer);
      clearTimeout(graceTimer);
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        conns--;
        if (conns === 0 && armed && !decided) graceTimer = setTimeout(() => conns === 0 && decide(), graceMs);
      };
    },
  };
}

/** One open /api/alive response: counts as a connection and writes a comment line every 15 s until it closes. */
export function aliveStream(opts: { tracker: Pick<AutoExit, 'connect'>; write: (chunk: string) => void; onClose: (cb: () => void) => void }): void {
  const drop = opts.tracker.connect();
  const timer = setInterval(() => opts.write(': keep-alive\n\n'), ALIVE_COMMENT_MS);
  opts.onClose(() => {
    clearInterval(timer);
    drop();
  });
}
