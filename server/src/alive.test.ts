import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Phase 12 (not built yet). Expected exports of ./alive:
//   createAutoExit({pendingCount, stopAccepting, exit, graceMs = 10_000, noWindowMs = 60_000, pollMs = 100}) -> {arm(): void, connect(): () => void}
//     arm(): starts the no-window timer (not armed when GITSLAPPIN_NO_OPEN is set: the caller simply never calls arm()).
//     connect(): a client holds /api/alive open; the returned function is called when it drops.
//     When the last connection drops: wait graceMs; if still none, decide: stopAccepting() once, poll pendingCount() every pollMs until 0, then exit() once.
//     No connection within noWindowMs of arm(): same decision + drain.
//   ALIVE_COMMENT_MS = 15_000
//   aliveStream({tracker, write, onClose}): connects to the tracker, calls write(': keep-alive\n') every ALIVE_COMMENT_MS, and on close
//     disconnects and stops writing. (onClose registers a callback fired when the HTTP response/socket closes.)
// And in ./git/queue: pendingCount() (counts running + waiting runExclusive blocks, multi-step blocks as one until they finish), stopAccepting() (later runExclusive calls reject).
import { ALIVE_COMMENT_MS, aliveStream, createAutoExit } from './alive';

function make(over: { pending?: () => number } = {}) {
  const calls: string[] = [];
  const exit = vi.fn(() => void calls.push('exit'));
  const stopAccepting = vi.fn(() => void calls.push('stop'));
  const pendingCount = vi.fn(over.pending ?? (() => 0));
  const t = createAutoExit({ pendingCount, stopAccepting, exit, graceMs: 10_000, noWindowMs: 60_000, pollMs: 50 });
  return { t, exit, stopAccepting, pendingCount, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('auto-exit', () => {
  it('does nothing until armed, however long we wait', async () => {
    const m = make();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(m.exit).not.toHaveBeenCalled();
    expect(m.stopAccepting).not.toHaveBeenCalled();
  });

  it('exits after 60 s with no window (grace not before), draining first', async () => {
    const m = make();
    m.t.arm();
    await vi.advanceTimersByTimeAsync(59_900);
    expect(m.exit).not.toHaveBeenCalled();
    expect(m.stopAccepting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(m.calls).toEqual(['stop', 'exit']);
  });

  it('a connection within 60 s cancels the no-window exit', async () => {
    const m = make();
    m.t.arm();
    await vi.advanceTimersByTimeAsync(30_000);
    m.t.connect();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(m.exit).not.toHaveBeenCalled();
  });

  it('waits 10 s after the last connection drops, then exits', async () => {
    const m = make();
    m.t.arm();
    const drop = m.t.connect();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(m.exit).not.toHaveBeenCalled();
    drop();
    await vi.advanceTimersByTimeAsync(9_900);
    expect(m.exit).not.toHaveBeenCalled();
    expect(m.stopAccepting).not.toHaveBeenCalled(); // not decided yet
    await vi.advanceTimersByTimeAsync(300);
    expect(m.calls).toEqual(['stop', 'exit']);
  });

  it('does not exit while another connection is still open', async () => {
    const m = make();
    m.t.arm();
    const a = m.t.connect();
    m.t.connect();
    a();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.exit).not.toHaveBeenCalled();
  });

  it('a reconnect inside the 10 s grace cancels the exit', async () => {
    const m = make();
    m.t.arm();
    const drop = m.t.connect();
    drop();
    await vi.advanceTimersByTimeAsync(6_000);
    const drop2 = m.t.connect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.exit).not.toHaveBeenCalled();
    expect(m.stopAccepting).not.toHaveBeenCalled();
    drop2();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(m.exit).toHaveBeenCalledTimes(1);
  });

  it('after the decision: stops accepting jobs, waits for pendingCount() to reach 0, only then exits', async () => {
    let pending = 3;
    const m = make({ pending: () => pending });
    m.t.arm();
    m.t.connect()();
    await vi.advanceTimersByTimeAsync(10_100);
    expect(m.stopAccepting).toHaveBeenCalledTimes(1); // the code path ran
    expect(m.pendingCount).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.exit).not.toHaveBeenCalled(); // still draining: 3 pending
    pending = 1;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.exit).not.toHaveBeenCalled();
    pending = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(m.calls).toEqual(['stop', 'exit']);
    expect(m.stopAccepting).toHaveBeenCalledTimes(1);
  });

  it('the 60 s no-window exit drains the same way', async () => {
    let pending = 2;
    const m = make({ pending: () => pending });
    m.t.arm();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(m.stopAccepting).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(m.exit).not.toHaveBeenCalled();
    pending = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(m.exit).toHaveBeenCalledTimes(1);
  });

  it('once decided, a late connection does not undo the exit', async () => {
    let pending = 1;
    const m = make({ pending: () => pending });
    m.t.arm();
    m.t.connect()();
    await vi.advanceTimersByTimeAsync(10_200);
    expect(m.stopAccepting).toHaveBeenCalledTimes(1);
    m.t.connect();
    pending = 0;
    await vi.advanceTimersByTimeAsync(500);
    expect(m.exit).toHaveBeenCalledTimes(1);
  });
});

describe('aliveStream', () => {
  it('writes a comment line every 15 s while open, and stops after close', async () => {
    expect(ALIVE_COMMENT_MS).toBe(15_000);
    const m = make();
    const write = vi.fn();
    let close: () => void = () => undefined;
    aliveStream({ tracker: m.t, write, onClose: (cb: () => void) => void (close = cb) });
    await vi.advanceTimersByTimeAsync(14_900);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toMatch(/^:/); // SSE-style comment line
    await vi.advanceTimersByTimeAsync(15_000);
    expect(write).toHaveBeenCalledTimes(2);
    close();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('a stream counts as a connection and its close starts the grace period', async () => {
    const m = make();
    m.t.arm();
    let close: () => void = () => undefined;
    aliveStream({ tracker: m.t, write: vi.fn(), onClose: (cb: () => void) => void (close = cb) });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(m.exit).not.toHaveBeenCalled();
    close();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(m.exit).toHaveBeenCalledTimes(1);
  });
});

describe('git queue idle wait', () => {
  it('pendingCount covers a multi-step runExclusive block until it finishes; stopAccepting refuses new jobs', async () => {
    vi.useRealTimers();
    vi.resetModules();
    const q = (await import('./git/queue')) as unknown as {
      runExclusive: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
      pendingCount: () => number;
      stopAccepting: () => void;
    };
    expect(q.pendingCount()).toBe(0);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const running = q.runExclusive('gitslappin-test-repo', async () => {
      await gate; // step 1
      await Promise.resolve(); // step 2
      return 'done';
    });
    const waiting = q.runExclusive('gitslappin-test-repo', async () => 'second');
    expect(q.pendingCount()).toBe(2);
    q.stopAccepting();
    await expect(q.runExclusive('gitslappin-test-repo', async () => 'late')).rejects.toThrow();
    expect(q.pendingCount()).toBe(2); // the refused job was not counted
    release();
    expect(await running).toBe('done');
    expect(await waiting).toBe('second');
    expect(q.pendingCount()).toBe(0);
  });
});
