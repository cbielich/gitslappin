import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandLog } from '../git/commandLog';
import { pendingCount } from '../git/queue';
import { createTerminalHub, TERMINAL_MAX_PAYLOAD } from './hub';
import { FakeSpawner, FakeWs } from './testFakes';

/*
 * V6b terminal hub (build-notes "V6b terminal design" + "V6b audit fixes"). Pure unit tests: fake PTY, fake ws, fake clock, fake taskkill. No process is spawned.
 *
 * CONTRACT the builder implements (server/src/terminal/hub.ts), chosen where the design leaves it open:
 *   createTerminalHub(deps) -> TerminalHub, deps = {
 *     spawnPty: SpawnPty | null,            // node-pty's spawn(file, args, {name?, cols, rows, cwd, env}); null = the pty module failed to load
 *     platform: string, bind: string, port: number,
 *     shellExists: (absPath) => boolean, now: () => number,
 *     rootOf: (repoId) => string | undefined,  // registry.rootOf
 *     env: NodeJS.ProcessEnv,                  // read at spawn time (process.env in production)
 *     systemRoot: string, programFiles: string,
 *     runTaskkill: (file: string, args: string[]) => void }   // synchronous; the real one runs execFileSync/spawnSync
 *   hub.available(): boolean                      // win32 && bind==='127.0.0.1' && spawnPty && PowerShell exe exists (for /api/ping `terminal`)
 *   hub.issueTicket(): {ok:true, ticket:string} | {ok:false, status:409|429}
 *   hub.acceptUpgrade({ticket, origin, host}): {ok:true} | {ok:false, status:403|409|429}   // consumes the ticket FIRST, then checks Origin, Host, gates, 4-socket cap
 *   hub.ticketCount(): number                     // outstanding (unexpired, unused) tickets
 *   hub.attach(ws): void                          // ws: EventEmitter 'message'(data, isBinary) / 'close' / 'pong'; methods send, ping, close, terminate; bufferedAmount
 *   hub.killAll(): void                           // synchronous (process.on('exit') and app onClose call it)
 *   TERMINAL_MAX_PAYLOAD = 65536
 * Frames are JSON text with discriminator `t`:
 *   client->server {t:'open',req,repoId,cols,rows,shell?:'powershell'|'bash'} {t:'in',id,d} {t:'resize',id,cols,rows} {t:'kill',id}
 *   server->client {t:'opened',req,id} {t:'error',req?,id?,code:number} {t:'out',id,d} {t:'exit',id,code}
 * Error codes: 409 gated / shell missing, 404 unknown repoId or unknown (or foreign) session id, 429 caps, 400 bad shell value.
 * A bad frame (invalid JSON, not an object, unknown `t`, binary, longer than TERMINAL_MAX_PAYLOAD) closes the socket.
 * Backpressure: pause when bufferedAmount > 1 MiB after a flush; resume within 200 ms of bufferedAmount < 256 KiB (poll at most every 100 ms).
 */

const PORT = 4518;
const SYSROOT = 'C:\\Windows';
const PF = 'C:\\Program Files';
const PS = `${SYSROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const BASH = `${PF}\\Git\\bin\\bash.exe`;
const TASKKILL = `${SYSROOT}\\System32\\taskkill.exe`;
const ROOTS: Record<string, string> = { 'repo-a': 'C:\\fixture\\repo-a', 'repo-b': 'C:\\fixture\\repo-b', 'repo-c': 'C:\\fixture\\repo-c' };
const GOOD = { origin: `http://127.0.0.1:${PORT}`, host: `127.0.0.1:${PORT}` };

function make(over: Record<string, unknown> = {}) {
  const spawner = new FakeSpawner();
  const taskkills: Array<[string, string[]]> = [];
  const clock = { t: 5_000_000 };
  const state = { ps: true, bash: true };
  const deps = {
    spawnPty: spawner.spawn,
    platform: 'win32',
    bind: '127.0.0.1',
    port: PORT,
    shellExists: (p: string) => (p === PS ? state.ps : p === BASH ? state.bash : false),
    now: () => clock.t,
    rootOf: (id: string) => ROOTS[id],
    env: {
      PATH: 'C:\\bin;C:\\tools',
      USERPROFILE: 'C:\\Users\\t',
      GIT_AUTHOR_NAME: 'kept',
      GITSLAPPIN_TOKEN: 'secret-token',
      gitslappin_data_dir: 'C:\\x',
      GitSlappin_Port: '4518',
      GIT_DIR: 'C:\\other\\.git',
      GIT_WORK_TREE: 'C:\\other',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: 'c',
      GIT_CONFIG_PARAMETERS: "'a.b=c'",
    } as Record<string, string>,
    systemRoot: SYSROOT,
    programFiles: PF,
    runTaskkill: (f: string, a: string[]) => void taskkills.push([f, a]),
    ...over,
  };
  const hub = createTerminalHub(deps as never);
  return { hub, spawner, taskkills, clock, state, deps };
}
type Made = ReturnType<typeof make>;

function attach(m: Made): FakeWs {
  const ws = new FakeWs();
  m.hub.attach(ws as never);
  return ws;
}
function open(ws: FakeWs, repoId = 'repo-a', extra: Record<string, unknown> = {}, req = 1): void {
  ws.client({ t: 'open', req, repoId, cols: 100, rows: 30, ...extra });
}
function openedId(ws: FakeWs, index = 0): string {
  const f = ws.framesOf('opened')[index];
  if (!f) throw new Error(`no opened frame; got ${JSON.stringify(ws.frames())}`);
  return String(f.id);
}
function errCodes(ws: FakeWs): number[] {
  return ws.framesOf('error').map((f) => Number(f.code));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('gating: 409 on the server for every ticket and every open', () => {
  const gates: Array<[string, Record<string, unknown>]> = [
    ['not win32', { platform: 'linux' }],
    ['darwin', { platform: 'darwin' }],
    ['bound to 0.0.0.0 (Docker)', { bind: '0.0.0.0' }],
    ['pty module not loaded', { spawnPty: null }],
    ['shell exe missing', { shellExists: () => false }],
  ];
  for (const [name, over] of gates) {
    it(`${name}: ticket is 409, upgrade is 409, open is error 409 and nothing is spawned`, () => {
      const m = make(over);
      expect(m.hub.available()).toBe(false);
      expect(m.hub.issueTicket()).toEqual({ ok: false, status: 409 });
      const up = m.hub.acceptUpgrade({ ticket: 'anything', ...GOOD });
      expect(up).toEqual({ ok: false, status: 409 });
      const ws = attach(m);
      open(ws);
      expect(errCodes(ws)).toEqual([409]);
      expect(ws.framesOf('opened')).toHaveLength(0);
      expect(m.spawner.calls).toHaveLength(0);
    });
  }

  it('control: all gates satisfied is available, a ticket is issued and open works', () => {
    const m = make();
    expect(m.hub.available()).toBe(true);
    expect(m.hub.issueTicket().ok).toBe(true);
    const ws = attach(m);
    open(ws);
    expect(ws.framesOf('opened')).toHaveLength(1);
  });

  it('is checked again on every call: the shell vanishing after a ticket was issued refuses the upgrade and the next open', () => {
    const m = make();
    const t = m.hub.issueTicket();
    if (!t.ok) throw new Error('no ticket');
    const ws = attach(m);
    open(ws);
    expect(ws.framesOf('opened')).toHaveLength(1);
    m.state.ps = false;
    expect(m.hub.acceptUpgrade({ ticket: t.ticket, ...GOOD })).toEqual({ ok: false, status: 409 });
    open(ws, 'repo-a', {}, 2);
    expect(errCodes(ws)).toEqual([409]);
    expect(m.spawner.calls).toHaveLength(1);
  });
});

describe('spawn', () => {
  it('spawns PowerShell by its absolute path with only -NoLogo, cwd = the repo root, and no path in argv', () => {
    const m = make();
    open(attach(m));
    expect(m.spawner.calls).toHaveLength(1);
    const c = m.spawner.calls[0]!;
    expect(c.file).toBe(PS);
    expect(c.args).toEqual(['-NoLogo']);
    expect(c.opts.cwd).toBe(ROOTS['repo-a']);
    for (const a of c.args) {
      expect(a).not.toContain(ROOTS['repo-a']);
      expect(a).not.toMatch(/[\\/]/);
    }
    expect(c.opts.cols).toBe(100);
    expect(c.opts.rows).toBe(30);
  });

  it('answers opened{req,id} with the request number the client sent', () => {
    const m = make();
    const ws = attach(m);
    open(ws, 'repo-a', {}, 77);
    expect(ws.framesOf('opened')[0]).toMatchObject({ t: 'opened', req: 77 });
    expect(typeof openedId(ws)).toBe('string');
  });

  it('the shell env has no GITSLAPPIN_* in any case, no GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_*, and keeps PATH and the rest', () => {
    const m = make();
    open(attach(m));
    const env = m.spawner.calls[0]!.opts.env;
    const keys = Object.keys(env);
    expect(keys.filter((k) => /^GITSLAPPIN_/i.test(k))).toEqual([]);
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS']) expect(keys, k).not.toContain(k);
    expect(env.PATH).toBe('C:\\bin;C:\\tools');
    expect(env.USERPROFILE).toBe('C:\\Users\\t');
    expect(env.GIT_AUTHOR_NAME).toBe('kept');
  });

  it('does not add the runner env (GIT_TERMINAL_PROMPT, GIT_OPTIONAL_LOCKS)', () => {
    const m = make();
    open(attach(m));
    const keys = Object.keys(m.spawner.calls[0]!.opts.env);
    expect(keys).not.toContain('GIT_TERMINAL_PROMPT');
    expect(keys).not.toContain('GIT_OPTIONAL_LOCKS');
  });

  it('does not change the env object it was given (a copy is filtered)', () => {
    const m = make();
    open(attach(m));
    expect(m.deps.env.GITSLAPPIN_TOKEN).toBe('secret-token');
  });

  it('an unknown repoId is error 404 and nothing is spawned; the socket stays open', () => {
    const m = make();
    const ws = attach(m);
    open(ws, 'no-such-repo');
    expect(errCodes(ws)).toEqual([404]);
    expect(ws.framesOf('error')[0]).toMatchObject({ req: 1 });
    expect(m.spawner.calls).toHaveLength(0);
    expect(ws.closed).toBe(false);
  });

  it('a repoId that is a path is just an unknown id (404), never used as a cwd', () => {
    const m = make();
    const ws = attach(m);
    open(ws, 'C:\\Windows');
    open(ws, '..\\..', {}, 2);
    expect(errCodes(ws)).toEqual([404, 404]);
    expect(m.spawner.calls).toHaveLength(0);
  });

  it('shell "bash" spawns Git Bash by absolute path with --login -i when it exists', () => {
    const m = make();
    open(attach(m), 'repo-b', { shell: 'bash' });
    const c = m.spawner.calls[0]!;
    expect(c.file).toBe(BASH);
    expect(c.args).toEqual(['--login', '-i']);
    expect(c.opts.cwd).toBe(ROOTS['repo-b']);
  });

  it('shell "bash" when Git Bash is not installed is error 409 and nothing is spawned', () => {
    const m = make();
    m.state.bash = false;
    const ws = attach(m);
    open(ws, 'repo-a', { shell: 'bash' });
    expect(errCodes(ws)).toEqual([409]);
    expect(m.spawner.calls).toHaveLength(0);
  });

  it('any other shell value (a path, cmd, a number) is error 400 and nothing is spawned', () => {
    const m = make();
    const ws = attach(m);
    for (const shell of ['cmd', 'C:\\evil\\x.exe', '', 5, null, ['bash']]) open(ws, 'repo-a', { shell });
    expect(errCodes(ws)).toEqual([400, 400, 400, 400, 400, 400]);
    expect(m.spawner.calls).toHaveLength(0);
  });

  it('no shell given means PowerShell', () => {
    const m = make();
    open(attach(m));
    expect(m.spawner.calls[0]!.file).toBe(PS);
  });
});

describe('tickets', () => {
  it('issues 32 random bytes as text, a different one each time', () => {
    const m = make();
    const a = m.hub.issueTicket();
    const b = m.hub.issueTicket();
    if (!a.ok || !b.ok) throw new Error('no ticket');
    expect(a.ticket).toMatch(/^([A-Za-z0-9_-]{43}|[0-9a-f]{64})$/);
    expect(a.ticket).not.toBe(b.ticket);
  });

  it('a valid ticket with an allowed Origin and Host upgrades (127.0.0.1 and localhost)', () => {
    const m = make();
    for (const [origin, host] of [
      [`http://127.0.0.1:${PORT}`, `127.0.0.1:${PORT}`],
      [`http://localhost:${PORT}`, `localhost:${PORT}`],
    ] as const) {
      const t = m.hub.issueTicket();
      if (!t.ok) throw new Error('no ticket');
      expect(m.hub.acceptUpgrade({ ticket: t.ticket, origin, host })).toEqual({ ok: true });
    }
  });

  it('refuses a missing, empty, unknown or non-string ticket with 403', () => {
    const m = make();
    m.hub.issueTicket();
    for (const ticket of [undefined, '', 'nope', 123, ['a', 'b'], null]) {
      expect(m.hub.acceptUpgrade({ ticket: ticket as never, ...GOOD }), JSON.stringify(ticket)).toEqual({ ok: false, status: 403 });
    }
  });

  it('refuses a reused ticket (single use)', () => {
    const m = make();
    const t = m.hub.issueTicket();
    if (!t.ok) throw new Error('no ticket');
    expect(m.hub.acceptUpgrade({ ticket: t.ticket, ...GOOD })).toEqual({ ok: true });
    expect(m.hub.acceptUpgrade({ ticket: t.ticket, ...GOOD })).toEqual({ ok: false, status: 403 });
  });

  it('refuses an expired ticket (valid 10 s) and accepts one just inside the window', () => {
    const m = make();
    const fresh = m.hub.issueTicket();
    const old = m.hub.issueTicket();
    if (!fresh.ok || !old.ok) throw new Error('no ticket');
    m.clock.t += 9_000;
    expect(m.hub.acceptUpgrade({ ticket: fresh.ticket, ...GOOD })).toEqual({ ok: true });
    m.clock.t += 2_000;
    expect(m.hub.acceptUpgrade({ ticket: old.ticket, ...GOOD })).toEqual({ ok: false, status: 403 });
  });

  it('refuses a missing Origin (required on this route, unlike the other /api routes)', () => {
    const m = make();
    const t = m.hub.issueTicket();
    if (!t.ok) throw new Error('no ticket');
    expect(m.hub.acceptUpgrade({ ticket: t.ticket, origin: undefined, host: GOOD.host })).toEqual({ ok: false, status: 403 });
  });

  it('refuses a foreign Origin: another site, another port, https, a lookalike', () => {
    const m = make();
    for (const origin of ['http://evil.example', `http://127.0.0.1:${PORT + 1}`, `https://127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}.evil.example`, 'null', '']) {
      const t = m.hub.issueTicket();
      if (!t.ok) throw new Error('no ticket');
      expect(m.hub.acceptUpgrade({ ticket: t.ticket, origin, host: GOOD.host }), origin).toEqual({ ok: false, status: 403 });
    }
  });

  it('refuses a foreign or missing Host (DNS rebinding)', () => {
    const m = make();
    for (const host of ['evil.example', `evil.example:${PORT}`, `127.0.0.1:${PORT + 1}`, '', undefined]) {
      const t = m.hub.issueTicket();
      if (!t.ok) throw new Error('no ticket');
      expect(m.hub.acceptUpgrade({ ticket: t.ticket, origin: GOOD.origin, host: host as never }), String(host)).toEqual({ ok: false, status: 403 });
    }
  });

  it('audit 1: the ticket is used up the FIRST time it is presented, even when the Origin check fails', () => {
    const m = make();
    const t = m.hub.issueTicket();
    if (!t.ok) throw new Error('no ticket');
    expect(m.hub.ticketCount()).toBe(1);
    expect(m.hub.acceptUpgrade({ ticket: t.ticket, origin: 'http://evil.example', host: GOOD.host })).toEqual({ ok: false, status: 403 });
    expect(m.hub.ticketCount()).toBe(0);
    expect(m.hub.acceptUpgrade({ ticket: t.ticket, ...GOOD })).toEqual({ ok: false, status: 403 });
  });

  it('audit 1: also used up when the Host check or a missing Origin fails', () => {
    const m = make();
    const a = m.hub.issueTicket();
    const b = m.hub.issueTicket();
    if (!a.ok || !b.ok) throw new Error('no ticket');
    m.hub.acceptUpgrade({ ticket: a.ticket, origin: GOOD.origin, host: 'evil.example' });
    m.hub.acceptUpgrade({ ticket: b.ticket, origin: undefined, host: GOOD.host });
    expect(m.hub.ticketCount()).toBe(0);
    expect(m.hub.acceptUpgrade({ ticket: a.ticket, ...GOOD }).ok).toBe(false);
    expect(m.hub.acceptUpgrade({ ticket: b.ticket, ...GOOD }).ok).toBe(false);
  });

  it('audit 1: at most 16 tickets are outstanding; the 17th is refused with 429, and expired ones free their slot', () => {
    const m = make();
    for (let i = 0; i < 16; i++) expect(m.hub.issueTicket().ok, String(i)).toBe(true);
    expect(m.hub.ticketCount()).toBe(16);
    for (let i = 0; i < 5; i++) expect(m.hub.issueTicket()).toEqual({ ok: false, status: 429 });
    expect(m.hub.ticketCount()).toBeLessThanOrEqual(16);
    m.clock.t += 11_000;
    expect(m.hub.issueTicket().ok).toBe(true);
    expect(m.hub.ticketCount()).toBe(1);
  });

  it('a used ticket frees its slot', () => {
    const m = make();
    const first = m.hub.issueTicket();
    for (let i = 0; i < 15; i++) m.hub.issueTicket();
    expect(m.hub.issueTicket().ok).toBe(false);
    if (!first.ok) throw new Error('no ticket');
    m.hub.acceptUpgrade({ ticket: first.ticket, ...GOOD });
    expect(m.hub.issueTicket().ok).toBe(true);
  });

  it('at most 4 sockets: the 5th upgrade is refused with 429, and a closed socket frees its place', () => {
    const m = make();
    const sockets: FakeWs[] = [];
    for (let i = 0; i < 4; i++) {
      const t = m.hub.issueTicket();
      if (!t.ok) throw new Error('no ticket');
      expect(m.hub.acceptUpgrade({ ticket: t.ticket, ...GOOD })).toEqual({ ok: true });
      sockets.push(attach(m));
    }
    const t5 = m.hub.issueTicket();
    if (!t5.ok) throw new Error('no ticket');
    expect(m.hub.acceptUpgrade({ ticket: t5.ticket, ...GOOD })).toEqual({ ok: false, status: 429 });
    sockets[0]!.close();
    const t6 = m.hub.issueTicket();
    if (!t6.ok) throw new Error('no ticket');
    expect(m.hub.acceptUpgrade({ ticket: t6.ticket, ...GOOD })).toEqual({ ok: true });
  });

  it('V6b fix 8: accepted upgrades that have not attached yet count toward the 4-socket cap, and the hold expires', () => {
    const m = make();
    const accept = (): unknown => {
      const t = m.hub.issueTicket();
      if (!t.ok) throw new Error('no ticket');
      return m.hub.acceptUpgrade({ ticket: t.ticket, ...GOOD });
    };
    for (let i = 0; i < 4; i++) expect(accept()).toEqual({ ok: true }); // four upgrades in flight, none attached
    expect(accept()).toEqual({ ok: false, status: 429 });
    attach(m); // one of them attaches: still 4 in total (1 socket + 3 pending), so the 5th is still refused
    expect(accept()).toEqual({ ok: false, status: 429 });
    m.clock.t += 11_000; // an upgrade that never attaches frees its place
    expect(accept()).toEqual({ ok: true });
  });

  it('V6b fix 2: the shell is spawned with node-pty conpty.dll (its kill does not fork the AttachConsole agent)', () => {
    const m = make();
    open(attach(m));
    expect(m.spawner.calls[0]!.opts).toMatchObject({ useConptyDll: true });
  });
});

describe('caps', () => {
  it('4 terminals per repo: the 5th open is error 429 and spawns nothing; killing one frees a slot', () => {
    const m = make();
    const ws = attach(m);
    for (let i = 0; i < 4; i++) open(ws, 'repo-a', {}, i + 1);
    expect(ws.framesOf('opened')).toHaveLength(4);
    open(ws, 'repo-a', {}, 5);
    expect(errCodes(ws)).toEqual([429]);
    expect(ws.framesOf('error')[0]).toMatchObject({ req: 5 });
    expect(m.spawner.calls).toHaveLength(4);
    ws.client({ t: 'kill', id: openedId(ws, 0) });
    open(ws, 'repo-a', {}, 6);
    expect(ws.framesOf('opened')).toHaveLength(5);
  });

  it('the per-repo cap counts all sockets', () => {
    const m = make();
    const a = attach(m);
    const b = attach(m);
    for (let i = 0; i < 3; i++) open(a, 'repo-a', {}, i + 1);
    open(b, 'repo-a', {}, 1);
    open(b, 'repo-a', {}, 2);
    expect(b.framesOf('opened')).toHaveLength(1);
    expect(errCodes(b)).toEqual([429]);
  });

  it('8 terminals in total: the 9th, in another repo, is error 429', () => {
    const m = make();
    const ws = attach(m);
    for (let i = 0; i < 4; i++) open(ws, 'repo-a', {}, i + 1);
    for (let i = 0; i < 4; i++) open(ws, 'repo-b', {}, i + 10);
    expect(ws.framesOf('opened')).toHaveLength(8);
    open(ws, 'repo-c', {}, 99);
    expect(errCodes(ws)).toEqual([429]);
    expect(m.spawner.calls).toHaveLength(8);
  });

  it('a shell that exited frees its slot', () => {
    const m = make();
    const ws = attach(m);
    for (let i = 0; i < 4; i++) open(ws, 'repo-a', {}, i + 1);
    m.spawner.ptys[0]!.emitExit(0);
    open(ws, 'repo-a', {}, 9);
    expect(ws.framesOf('opened')).toHaveLength(5);
  });
});

describe('protocol: input, resize, output', () => {
  it('in{id,d} writes exactly that text to the PTY', () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    ws.client({ t: 'in', id: openedId(ws), d: 'git status\r' });
    expect(m.spawner.ptys[0]!.written.join('')).toBe('git status\r');
  });

  it('resize clamps cols to 2..500 and rows to 1..200', () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    const id = openedId(ws);
    const pty = m.spawner.ptys[0]!;
    const cases: Array<[number, number, [number, number]]> = [
      [1, 0, [2, 1]],
      [-50, -5, [2, 1]],
      [9999, 9999, [500, 200]],
      [80, 24, [80, 24]],
      [2, 1, [2, 1]],
      [500, 200, [500, 200]],
    ];
    for (const [cols, rows, want] of cases) {
      ws.client({ t: 'resize', id, cols, rows });
      expect(pty.resizes[pty.resizes.length - 1], `${cols}x${rows}`).toEqual(want);
    }
  });

  it('out frames are batched: nothing before 16 ms, then one frame with everything', async () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    const id = openedId(ws);
    const pty = m.spawner.ptys[0]!;
    pty.emitData('he');
    pty.emitData('llo');
    expect(ws.framesOf('out')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(16);
    expect(ws.framesOf('out')).toEqual([{ t: 'out', id, d: 'hello' }]);
  });

  it('a full 64 KiB batch is sent at once without waiting for the timer; no frame carries more than 64 KiB; nothing is lost', async () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    const pty = m.spawner.ptys[0]!;
    pty.emitData('a'.repeat(65_536));
    const early = ws.framesOf('out').map((f) => String(f.d)).join('');
    expect(early.length).toBeGreaterThan(0);
    pty.emitData('b'.repeat(70_000));
    await vi.advanceTimersByTimeAsync(50);
    const frames = ws.framesOf('out');
    for (const f of frames) expect(String(f.d).length).toBeLessThanOrEqual(65_536);
    expect(frames.map((f) => String(f.d)).join('')).toBe('a'.repeat(65_536) + 'b'.repeat(70_000));
  });

  it('exit{id,code} is sent when the shell exits', () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    const id = openedId(ws);
    m.spawner.ptys[0]!.emitExit(3);
    expect(ws.framesOf('exit')).toEqual([{ t: 'exit', id, code: 3 }]);
  });

  it('output still buffered when the shell exits is delivered before the exit frame', async () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    const pty = m.spawner.ptys[0]!;
    pty.emitData('last words');
    pty.emitExit(0);
    await vi.advanceTimersByTimeAsync(50);
    const order = ws.frames().map((f) => f.t);
    expect(order.indexOf('out')).toBeGreaterThan(-1);
    expect(order.indexOf('out')).toBeLessThan(order.indexOf('exit'));
  });
});

describe('backpressure', () => {
  it('pauses the PTY when bufferedAmount is over 1 MiB, resumes once it is under 256 KiB, and not before', async () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    const pty = m.spawner.ptys[0]!;
    ws.bufferedAmount = 2 * 1024 * 1024;
    pty.emitData('x');
    await vi.advanceTimersByTimeAsync(16);
    expect(ws.framesOf('out').length).toBeGreaterThan(0); // the flush ran
    expect(pty.paused).toBeGreaterThanOrEqual(1);
    expect(pty.resumed).toBe(0);
    ws.bufferedAmount = 500 * 1024; // between the two marks: stays paused
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.resumed).toBe(0);
    ws.bufferedAmount = 100 * 1024;
    await vi.advanceTimersByTimeAsync(200);
    expect(pty.resumed).toBeGreaterThanOrEqual(1);
  });

  it('control: a small bufferedAmount never pauses', async () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    const pty = m.spawner.ptys[0]!;
    ws.bufferedAmount = 1024;
    pty.emitData('x');
    await vi.advanceTimersByTimeAsync(100);
    expect(ws.framesOf('out').length).toBeGreaterThan(0);
    expect(pty.paused).toBe(0);
  });
});

describe('bad frames close the socket', () => {
  const bad: Array<[string, (ws: FakeWs) => void]> = [
    ['invalid JSON', (ws) => ws.clientRaw('{not json')],
    ['a JSON array', (ws) => ws.clientRaw('[1,2]')],
    ['a JSON string', (ws) => ws.clientRaw('"open"')],
    ['null', (ws) => ws.clientRaw('null')],
    ['an unknown type', (ws) => ws.client({ t: 'rm-rf', id: 'x' })],
    ['no type', (ws) => ws.client({ id: 'x' })],
    ['a binary frame', (ws) => ws.clientRaw(Buffer.from([1, 2, 3]), true)],
    ['a frame over 64 KiB', (ws) => ws.clientRaw(JSON.stringify({ t: 'in', id: 'x', d: 'a'.repeat(TERMINAL_MAX_PAYLOAD + 1) }))],
  ];
  for (const [name, send] of bad) {
    it(name, () => {
      const m = make();
      const ws = attach(m);
      send(ws);
      expect(ws.closed).toBe(true);
    });
  }

  it('the payload limit is exactly 64 KiB', () => {
    expect(TERMINAL_MAX_PAYLOAD).toBe(65_536);
  });

  it('control: a good frame next to a rejected unknown-id frame leaves the socket open', () => {
    const m = make();
    const ws = attach(m);
    ws.client({ t: 'in', id: 'nope', d: 'x' });
    open(ws);
    expect(ws.closed).toBe(false);
    expect(ws.framesOf('opened')).toHaveLength(1);
  });
});

describe('audit 4: sessions belong to the socket that opened them', () => {
  it('in, resize and kill with an unknown id get error 404 and the socket stays open', () => {
    const m = make();
    const ws = attach(m);
    ws.client({ t: 'in', id: 'ghost', d: 'x' });
    ws.client({ t: 'resize', id: 'ghost', cols: 80, rows: 24 });
    ws.client({ t: 'kill', id: 'ghost' });
    expect(errCodes(ws)).toEqual([404, 404, 404]);
    expect(ws.framesOf('error').map((f) => f.id)).toEqual(['ghost', 'ghost', 'ghost']);
    expect(ws.closed).toBe(false);
    expect(m.taskkills).toEqual([]);
  });

  it('another socket cannot write to, resize or kill a session it did not open; the owner is unaffected', () => {
    const m = make();
    const a = attach(m);
    const b = attach(m);
    open(a);
    const id = openedId(a);
    const pty = m.spawner.ptys[0]!;
    b.client({ t: 'in', id, d: 'stolen' });
    b.client({ t: 'resize', id, cols: 10, rows: 10 });
    b.client({ t: 'kill', id });
    expect(errCodes(b)).toEqual([404, 404, 404]);
    expect(b.closed).toBe(false);
    expect(pty.written).toEqual([]);
    expect(pty.resizes).toEqual([]);
    expect(pty.killed).toBe(0);
    expect(m.taskkills).toEqual([]);
    a.client({ t: 'in', id, d: 'mine' });
    expect(pty.written).toEqual(['mine']);
  });

  it('output of a session goes only to its own socket', async () => {
    const m = make();
    const a = attach(m);
    const b = attach(m);
    open(a);
    open(b, 'repo-b');
    m.spawner.ptys[0]!.emitData('only-for-a');
    await vi.advanceTimersByTimeAsync(20);
    expect(a.framesOf('out').map((f) => f.d).join('')).toBe('only-for-a');
    expect(b.framesOf('out')).toHaveLength(0);
  });

  it('closing one socket kills only its own sessions', () => {
    const m = make();
    const a = attach(m);
    const b = attach(m);
    open(a);
    open(b, 'repo-b');
    a.close();
    expect(m.spawner.ptys[0]!.killed).toBe(1);
    expect(m.spawner.ptys[1]!.killed).toBe(0);
    expect(m.taskkills).toHaveLength(1);
  });
});

describe('kill paths: pty.kill plus taskkill by absolute path with fixed argv', () => {
  const expectKilled = (m: Made, index: number, pid: number) => {
    expect(m.spawner.ptys[index]!.killed).toBe(1);
    expect(m.taskkills.filter(([, a]) => a.includes(String(pid)))).toEqual([[TASKKILL, ['/T', '/F', '/PID', String(pid)]]]);
  };

  it('kill frame (also what closing a tab sends)', () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    ws.client({ t: 'kill', id: openedId(ws) });
    expectKilled(m, 0, 1000);
    expect(m.taskkills).toHaveLength(1);
  });

  it('the socket closing', () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    open(ws, 'repo-b', {}, 2);
    ws.close();
    expectKilled(m, 0, 1000);
    expectKilled(m, 1, 1001);
    expect(m.taskkills).toHaveLength(2);
  });

  it('hub.killAll() (app onClose and the synchronous process exit handler), across sockets', () => {
    const m = make();
    const a = attach(m);
    const b = attach(m);
    open(a);
    open(b, 'repo-b');
    m.hub.killAll();
    expectKilled(m, 0, 1000);
    expectKilled(m, 1, 1001);
    expect(m.taskkills).toHaveLength(2);
  });

  it('a heartbeat timeout', async () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(ws.closed).toBe(true);
    expectKilled(m, 0, 1000);
  });

  it('is done once: a kill frame followed by the socket closing does not kill twice', () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    ws.client({ t: 'kill', id: openedId(ws) });
    ws.close();
    m.hub.killAll();
    expect(m.spawner.ptys[0]!.killed).toBe(1);
    expect(m.taskkills).toHaveLength(1);
  });

  it('killing one terminal leaves the others of the same socket running', () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    open(ws, 'repo-a', {}, 2);
    ws.client({ t: 'kill', id: openedId(ws, 0) });
    expect(m.spawner.ptys[0]!.killed).toBe(1);
    expect(m.spawner.ptys[1]!.killed).toBe(0);
  });

  it('audit 2: after the shell exited there is NO taskkill (the PID may belong to another process now), on every path', () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    const id = openedId(ws);
    m.spawner.ptys[0]!.emitExit(0);
    expect(ws.framesOf('exit')).toHaveLength(1);
    ws.client({ t: 'kill', id });
    expect(errCodes(ws)).toEqual([404]);
    m.hub.killAll();
    ws.close();
    expect(m.taskkills).toEqual([]);
  });

  it('audit 2: a live session next to an exited one is still taskkilled, the exited one is not', () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    open(ws, 'repo-b', {}, 2);
    m.spawner.ptys[0]!.emitExit(0);
    ws.close();
    expect(m.taskkills).toEqual([[TASKKILL, ['/T', '/F', '/PID', '1001']]]);
  });
});

describe('heartbeat', () => {
  it('pings every 30 s and keeps a socket that answers with pong', async () => {
    const m = make();
    const ws = attach(m);
    expect(ws.pings).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.pings).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 6; i++) {
      ws.emit('pong');
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(ws.closed).toBe(false);
  });

  it('closes a socket that sends no pong for 60 s, but not before', async () => {
    const m = make();
    const ws = attach(m);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(ws.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.closed).toBe(true);
  });

  it('there is no idle timeout: an idle terminal on a live socket is never closed', async () => {
    const m = make();
    const ws = attach(m);
    open(ws);
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      ws.emit('pong');
    }
    expect(ws.closed).toBe(false);
    expect(m.spawner.ptys[0]!.killed).toBe(0);
  });
});

describe('what the terminal never touches or logs', () => {
  it('commandLog stays empty and the git queue count is unchanged, with the code path proven to have run', async () => {
    const m = make();
    const ws = attach(m);
    const before = pendingCount();
    open(ws, 'repo-a');
    const id = openedId(ws);
    ws.client({ t: 'in', id, d: 'git commit --allow-empty -m x\r' });
    m.spawner.ptys[0]!.emitData('output');
    await vi.advanceTimersByTimeAsync(20);
    expect(m.spawner.ptys[0]!.written).toHaveLength(1); // it ran
    expect(ws.framesOf('out')).toHaveLength(1); // it ran
    for (const repoId of Object.keys(ROOTS)) expect(getCommandLog(repoId)).toEqual([]);
    expect(pendingCount()).toBe(before);
  });

  it('input, output, the ticket, env values and the cwd are never written to the console or stdout', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const m = make();
    const t = m.hub.issueTicket();
    if (!t.ok) throw new Error('no ticket');
    m.hub.acceptUpgrade({ ticket: t.ticket, origin: 'http://evil.example', host: GOOD.host });
    const ws = attach(m);
    open(ws);
    ws.client({ t: 'in', id: openedId(ws), d: 'SECRET_INPUT_9f3' });
    m.spawner.ptys[0]!.emitData('SECRET_OUTPUT_9f3');
    await vi.advanceTimersByTimeAsync(20);
    ws.client({ t: 'in', id: 'ghost', d: 'x' });
    ws.clientRaw('{bad');
    expect(ws.framesOf('out')).toHaveLength(1); // it ran
    const all = [...spies, out, err].flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
    for (const secret of ['SECRET_INPUT_9f3', 'SECRET_OUTPUT_9f3', t.ticket, 'secret-token', ROOTS['repo-a']!, 'C:\\other']) expect(all).not.toContain(secret);
  });

  it('error frames carry a numeric code and no path, no cwd and no argv', () => {
    const m = make();
    const ws = attach(m);
    open(ws, 'nope');
    open(ws, 'repo-a', { shell: 'x' }, 2);
    const raw = ws.sent.join('\n');
    expect(raw).not.toMatch(/[A-Za-z]:\\/);
    expect(raw).not.toContain('powershell');
    for (const f of ws.framesOf('error')) expect(typeof f.code).toBe('number');
  });
});
