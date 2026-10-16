import { api } from '../api';

/** The one multiplexed terminal WebSocket per window (V6b design item 2): opened on the first terminal, closed with the last. */
export interface TerminalSink {
  out(d: string): void;
  /** The shell ended (code) or the connection was lost (-1). */
  exit(code: number): void;
}

interface Pending {
  ok: (id: string) => void;
  fail: (code: number) => void;
  sink: TerminalSink;
}

const MAX_FRAME = 65_536; // a frame over 64 KiB (bytes) closes the socket on the server
const enc = new TextEncoder();

/**
 * Splits typed or pasted text so that every `in` frame, as encoded JSON (control characters become \u00XX), stays within MAX_FRAME bytes.
 * Never cuts between the two halves of a surrogate pair.
 */
export function splitInput(id: string, d: string, maxFrame = MAX_FRAME): string[] {
  const budget = maxFrame - enc.encode(JSON.stringify({ t: 'in', id, d: '' })).length;
  const out: string[] = [];
  let cur = '';
  let size = 0;
  for (const ch of d) {
    const cost = enc.encode(JSON.stringify(ch)).length - 2;
    if (cur !== '' && size + cost > budget) {
      out.push(cur);
      cur = '';
      size = 0;
    }
    cur += ch;
    size += cost;
  }
  if (cur !== '') out.push(cur);
  return out;
}

export class TerminalSocket {
  private ws: WebSocket | null = null;
  private ready: Promise<WebSocket> | null = null;
  private req = 0;
  private pending = new Map<number, Pending>();
  private sinks = new Map<string, TerminalSink>();
  /** Called once when an open connection drops while terminals were running (they have just received exit(-1)). */
  onLost: (() => void) | null = null;

  private connect(): Promise<WebSocket> {
    if (this.ready) return this.ready;
    const p = (async () => {
      const { ticket } = await api.terminalTicket();
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/api/terminal?ticket=${encodeURIComponent(ticket)}`);
      await new Promise<void>((ok, fail) => {
        ws.onopen = () => ok();
        ws.onerror = () => fail(new Error('The terminal connection failed.'));
        ws.onclose = () => fail(new Error('The terminal connection failed.'));
      });
      ws.onerror = null;
      ws.onclose = () => this.lost(ws);
      ws.onmessage = (ev) => this.onMessage(ev.data);
      this.ws = ws;
      return ws;
    })();
    this.ready = p;
    p.catch(() => {
      if (this.ready === p) this.ready = null;
    });
    return p;
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let f: { t?: string; req?: number; id?: string; d?: string; code?: number };
    try {
      f = JSON.parse(data);
    } catch {
      return;
    }
    if (f.t === 'opened' && typeof f.req === 'number' && typeof f.id === 'string') {
      const p = this.pending.get(f.req);
      if (!p) return;
      this.pending.delete(f.req);
      this.sinks.set(f.id, p.sink); // registered at once, so the first output cannot be missed
      p.ok(f.id);
    } else if (f.t === 'error' && typeof f.req === 'number') {
      const p = this.pending.get(f.req);
      if (!p) return;
      this.pending.delete(f.req);
      p.fail(typeof f.code === 'number' ? f.code : 0);
      this.closeIfIdle();
    } else if (f.t === 'out' && typeof f.id === 'string' && typeof f.d === 'string') {
      this.sinks.get(f.id)?.out(f.d);
    } else if (f.t === 'exit' && typeof f.id === 'string') {
      const s = this.sinks.get(f.id);
      this.sinks.delete(f.id);
      s?.exit(typeof f.code === 'number' ? f.code : 0);
      this.closeIfIdle();
    }
  }

  private lost(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.ready = null;
    const sinks = [...this.sinks.values()];
    const pend = [...this.pending.values()];
    this.sinks.clear();
    this.pending.clear();
    for (const p of pend) p.fail(0);
    for (const s of sinks) s.exit(-1);
    if (sinks.length > 0) this.onLost?.(); // once per dropped connection, however many terminals it carried
  }

  private closeIfIdle(): void {
    if (this.sinks.size > 0 || this.pending.size > 0 || !this.ws) return;
    const ws = this.ws;
    this.ws = null;
    this.ready = null;
    ws.close();
  }

  private send(frame: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  /** Resolves with the server's session id; rejects with an Error whose message is the numeric code ("0" = connection problem). */
  async open(repoId: string, cols: number, rows: number, shell: string, sink: TerminalSink): Promise<string> {
    const ws = await this.connect();
    return new Promise<string>((ok, fail) => {
      const req = ++this.req;
      this.pending.set(req, { ok, fail: (c) => fail(new Error(String(c))), sink });
      try {
        ws.send(JSON.stringify({ t: 'open', req, repoId, cols, rows, shell }));
      } catch {
        this.pending.delete(req);
        fail(new Error('0'));
      }
    });
  }

  input(id: string, d: string): void {
    for (const part of splitInput(id, d)) this.send({ t: 'in', id, d: part });
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ t: 'resize', id, cols, rows });
  }

  kill(id: string): void {
    this.send({ t: 'kill', id });
    this.sinks.delete(id);
    this.closeIfIdle();
  }
}

export const terminalSocket = new TerminalSocket();
