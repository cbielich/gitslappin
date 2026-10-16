import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: { terminalTicket: async () => ({ ticket: 't' }) } }));

import { TerminalSocket, splitInput } from './terminalSocket';

/* V6b review fixes 4, 5 and 7. No DOM in this vitest setup: window and WebSocket are stubbed. */

class FakeWs {
  static OPEN = 1;
  static last: FakeWs | null = null;
  readyState = 1;
  sent: string[] = [];
  failSend = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) {
    FakeWs.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(d: string): void {
    if (this.failSend) throw new Error('send failed');
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
  }
  say(f: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, WebSocket: g.WebSocket };
beforeEach(() => {
  g.window = { location: { protocol: 'http:', host: 'x' } };
  g.WebSocket = FakeWs;
  FakeWs.last = null;
});
afterEach(() => {
  g.window = saved.window;
  g.WebSocket = saved.WebSocket;
});

const bytes = (s: string): number => new TextEncoder().encode(s).length;
const sink = () => ({ out: vi.fn(), exit: vi.fn() });

describe('splitInput: a frame never exceeds 64 KiB once JSON-encoded', () => {
  it('control-character-heavy text (each char becomes a 6-byte \\u00XX escape) is cut by encoded size', () => {
    const text = '\u0001'.repeat(40_000); // 40 KB raw, 240 KB encoded
    const parts = splitInput('t1-abc', text);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(bytes(JSON.stringify({ t: 'in', id: 't1-abc', d: p }))).toBeLessThanOrEqual(65_536);
    expect(parts.join('')).toBe(text);
  });

  it('never splits a surrogate pair, and non-ASCII text is counted in UTF-8 bytes', () => {
    const text = '\u{1F600}a'.repeat(30_000);
    const parts = splitInput('t1-abc', text, 1_000);
    for (const p of parts) {
      expect(bytes(JSON.stringify({ t: 'in', id: 't1-abc', d: p }))).toBeLessThanOrEqual(1_000);
      const first = p.charCodeAt(0);
      const last = p.charCodeAt(p.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false); // does not start with a low surrogate
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // does not end with a high surrogate
    }
    expect(parts.join('')).toBe(text);
  });

  it('plain short input stays one frame, and empty input sends nothing', () => {
    expect(splitInput('t1', 'ls\r')).toEqual(['ls\r']);
    expect(splitInput('t1', '')).toEqual([]);
  });

  it('input() sends every part as its own in frame', async () => {
    const s = new TerminalSocket();
    const p = s.open('r', 80, 24, 'powershell', sink());
    await vi.waitFor(() => expect(FakeWs.last?.sent.length).toBe(1));
    FakeWs.last!.say({ t: 'opened', req: 1, id: 's1' });
    await p;
    s.input('s1', '\u0001'.repeat(40_000));
    const frames = FakeWs.last!.sent.slice(1);
    expect(frames.length).toBeGreaterThan(3);
    for (const f of frames) expect(bytes(f)).toBeLessThanOrEqual(65_536);
  });
});

describe('open(): a failing send', () => {
  it('rejects with code 0 and removes the pending entry', async () => {
    const s = new TerminalSocket();
    const first = s.open('r', 80, 24, 'powershell', sink());
    await vi.waitFor(() => expect(FakeWs.last?.sent.length).toBe(1));
    FakeWs.last!.say({ t: 'opened', req: 1, id: 's1' });
    await first;
    FakeWs.last!.failSend = true;
    await expect(s.open('r', 80, 24, 'powershell', sink())).rejects.toThrow('0');
    expect((s as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
  });
});

describe('a dropped connection', () => {
  it('ends every running terminal with exit(-1) and reports the loss once', async () => {
    const s = new TerminalSocket();
    const onLost = vi.fn();
    s.onLost = onLost;
    const a = sink();
    const b = sink();
    const pa = s.open('r', 80, 24, 'powershell', a);
    await vi.waitFor(() => expect(FakeWs.last?.sent.length).toBe(1));
    FakeWs.last!.say({ t: 'opened', req: 1, id: 'sa' });
    await pa;
    const pb = s.open('r', 80, 24, 'powershell', b);
    await vi.waitFor(() => expect(FakeWs.last?.sent.length).toBe(2));
    FakeWs.last!.say({ t: 'opened', req: 2, id: 'sb' });
    await pb;
    FakeWs.last!.onclose?.();
    expect(a.exit).toHaveBeenCalledWith(-1);
    expect(b.exit).toHaveBeenCalledWith(-1);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('a normal shell exit or closing the last terminal is not a loss', async () => {
    const s = new TerminalSocket();
    const onLost = vi.fn();
    s.onLost = onLost;
    const a = sink();
    const pa = s.open('r', 80, 24, 'powershell', a);
    await vi.waitFor(() => expect(FakeWs.last?.sent.length).toBe(1));
    FakeWs.last!.say({ t: 'opened', req: 1, id: 'sa' });
    await pa;
    const ws = FakeWs.last!;
    ws.say({ t: 'exit', id: 'sa', code: 0 });
    ws.onclose?.();
    expect(a.exit).toHaveBeenCalledWith(0);
    expect(onLost).not.toHaveBeenCalled();
  });
});
