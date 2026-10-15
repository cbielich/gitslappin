import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWatchHub, type Fingerprint, type WatchEvent } from './watch';
import { onSettled, repoBusy, runExclusive, setSettleFingerprint } from './queue';

const FP: Fingerprint = { head: 'h', refs: 'r', op: 'o', status: 's' };

afterEach(() => {
  setSettleFingerprint(undefined);
  vi.useRealTimers();
});

describe('queue: busy stays true while the post-action fingerprint is taken', () => {
  it('repoBusy is true until the settle callbacks ran', async () => {
    let finish!: () => void;
    setSettleFingerprint(() => new Promise((ok) => (finish = () => ok({ ...FP }))));
    const cb = vi.fn();
    const run = runExclusive('rev-q1', async () => undefined);
    onSettled('rev-q1', cb);
    await new Promise((r) => setTimeout(r, 20));
    expect(repoBusy('rev-q1')).toBe(true); // fingerprint pending: a watcher timer must still defer
    expect(cb).not.toHaveBeenCalled();
    finish();
    await run;
    expect(repoBusy('rev-q1')).toBe(false);
    expect(cb).toHaveBeenCalledWith(FP);
  });

  it('a stuck fingerprint is cut off after 2 s and the callback gets undefined', async () => {
    setSettleFingerprint(() => new Promise(() => undefined));
    const cb = vi.fn();
    const run = runExclusive('rev-q2', async () => undefined);
    onSettled('rev-q2', cb);
    await run;
    expect(cb).toHaveBeenCalledWith(undefined);
  }, 6000);
});

describe('watch: a failed settle fingerprint does not swallow an outside change', () => {
  beforeEach(() => vi.useFakeTimers());
  it('expected undefined is compared with the baseline', async () => {
    const fp = { ...FP };
    const settled: ((e?: Fingerprint) => void)[] = [];
    let busy = false;
    const hub = createWatchHub({
      mode: 'events',
      fingerprint: async () => ({ ...fp }),
      watchFs: (_r, h) => {
        fire = h.onEvent;
        return { close: () => undefined };
      },
      repoBusy: () => busy,
      onSettled: (_id, cb) => void settled.push(cb),
    });
    let fire!: (f: string | null) => void;
    const events: WatchEvent[] = [];
    hub.subscribe('x', '/fake/x', (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(1100);
    busy = true;
    fire('a.txt');
    await vi.advanceTimersByTimeAsync(500);
    busy = false;
    fp.status = 's2';
    settled[0]!(undefined);
    await vi.advanceTimersByTimeAsync(1500);
    expect(events.map((e) => e.type)).toEqual(['status']);
  });
});
