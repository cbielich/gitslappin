import { EventEmitter } from 'node:events';

/*
 * Test helpers for V6b (not collected by vitest: the name does not end in .test.ts). Fakes for node-pty's IPty and for a `ws` socket.
 * The hub is built with createTerminalHub(deps) from ./hub; see hub.test.ts for the contract these fakes assume.
 */

export class FakePty {
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = 0;
  paused = 0;
  resumed = 0;
  private dataCbs: Array<(d: string) => void> = [];
  private exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  constructor(public pid: number) {}
  onData(cb: (d: string) => void): { dispose: () => void } {
    this.dataCbs.push(cb);
    return { dispose: () => undefined };
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this.exitCbs.push(cb);
    return { dispose: () => undefined };
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed++;
  }
  pause(): void {
    this.paused++;
  }
  resume(): void {
    this.resumed++;
  }
  emitData(s: string): void {
    for (const cb of this.dataCbs) cb(s);
  }
  emitExit(code = 0): void {
    for (const cb of this.exitCbs) cb({ exitCode: code });
  }
}

export interface SpawnCall {
  file: string;
  args: string[];
  opts: { cwd: string; env: Record<string, string | undefined>; cols: number; rows: number; name?: string };
}

export class FakeSpawner {
  calls: SpawnCall[] = [];
  ptys: FakePty[] = [];
  private nextPid = 1000;
  spawn = (file: string, args: string[], opts: SpawnCall['opts']): FakePty => {
    this.calls.push({ file, args, opts });
    const p = new FakePty(this.nextPid++);
    this.ptys.push(p);
    return p;
  };
}

export class FakeWs extends EventEmitter {
  sent: string[] = [];
  bufferedAmount = 0;
  closed = false;
  closeCalls = 0;
  pings = 0;
  readyState = 1;
  send(d: string): void {
    this.sent.push(String(d));
  }
  ping(): void {
    this.pings++;
  }
  close(): void {
    this.closeCalls++;
    this.finish();
  }
  terminate(): void {
    this.closeCalls++;
    this.finish();
  }
  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }
  /** What the browser sends: one JSON text frame. */
  client(obj: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(obj)), false);
  }
  clientRaw(data: Buffer | string, isBinary = false): void {
    this.emit('message', typeof data === 'string' ? Buffer.from(data) : data, isBinary);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  framesOf(t: string): Array<Record<string, unknown>> {
    return this.frames().filter((f) => f.t === t);
  }
}
