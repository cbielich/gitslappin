import { randomBytes } from 'node:crypto';
import { isAllowedHost, isAllowedOrigin } from '../security';

/** V6b in-app terminal (build-notes "V6b terminal design" + "V6b audit fixes"). Nothing here is ever logged: not input, output, tickets, env, cwd or argv. */

export const TERMINAL_MAX_PAYLOAD = 65_536;
const TICKET_TTL_MS = 10_000;
const MAX_TICKETS = 16;
const MAX_SOCKETS = 4;
const PENDING_UPGRADE_MS = 10_000;
const MAX_PER_REPO = 4;
const MAX_TOTAL = 8;
const FLUSH_MS = 16;
const HEARTBEAT_MS = 30_000;
const DEAD_AFTER_MS = 60_000;
const PAUSE_ABOVE = 1024 * 1024;
const RESUME_BELOW = 256 * 1024;
const RESUME_POLL_MS = 100;

export interface PtyLike {
  pid: number;
  onData(cb: (d: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause(): void;
  resume(): void;
}
export type SpawnPty = (file: string, args: string[], opts: { name?: string; cols: number; rows: number; cwd: string; env: Record<string, string | undefined>; useConptyDll?: boolean }) => PtyLike;

export interface WsLike {
  on(event: string, cb: (...a: never[]) => void): unknown;
  send(d: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  bufferedAmount: number;
  readyState: number;
}

export interface TerminalHubDeps {
  spawnPty: SpawnPty | null;
  platform: string;
  bind: string;
  port: number;
  shellExists: (absPath: string) => boolean;
  now: () => number;
  rootOf: (repoId: string) => string | undefined;
  env: NodeJS.ProcessEnv;
  systemRoot: string;
  programFiles: string;
  runTaskkill: (file: string, args: string[]) => void;
}

export type TicketResult = { ok: true; ticket: string } | { ok: false; status: 409 | 429 };
export type UpgradeResult = { ok: true } | { ok: false; status: 403 | 409 | 429 };

export interface TerminalHub {
  available(): boolean;
  /** Git Bash is installed (for the Default In-App Terminal choice; the UI only). */
  bashAvailable(): boolean;
  issueTicket(): TicketResult;
  acceptUpgrade(a: { ticket: unknown; origin: string | undefined; host: string | undefined }): UpgradeResult;
  ticketCount(): number;
  attach(ws: WsLike): void;
  killAll(): void;
}

interface Session {
  id: string;
  repoId: string;
  pty: PtyLike;
  sock: Sock;
  chunks: string;
  timer: ReturnType<typeof setTimeout> | null;
}
interface Sock {
  ws: WsLike;
  sessions: Map<string, Session>;
  lastPong: number;
  beat: ReturnType<typeof setInterval> | null;
  poll: ReturnType<typeof setInterval> | null;
  closed: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.trunc(v)));
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const REMOVED_ENV = /^(GITSLAPPIN_|GIT_CONFIG_)/i;
const REMOVED_GIT = /^(GIT_DIR|GIT_WORK_TREE|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT)$/i;

export function createTerminalHub(deps: TerminalHubDeps): TerminalHub {
  const tickets = new Map<string, number>();
  const socks = new Set<Sock>();
  const pendingUp: number[] = []; // expiry times of accepted upgrades that have not attached yet
  let nextId = 1;

  const psExe = (): string => `${deps.systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const bashExe = (): string => `${deps.programFiles}\\Git\\bin\\bash.exe`;
  const taskkillExe = (): string => `${deps.systemRoot}\\System32\\taskkill.exe`;

  const available = (): boolean => deps.platform === 'win32' && deps.bind === '127.0.0.1' && deps.spawnPty !== null && deps.shellExists(psExe());

  function prune(): void {
    const t = deps.now();
    for (const [k, exp] of tickets) if (t > exp) tickets.delete(k);
  }

  function send(s: Sock, obj: Record<string, unknown>): void {
    if (s.closed || s.ws.readyState !== 1) return;
    try {
      s.ws.send(JSON.stringify(obj));
    } catch {
      // the socket is going away; its close handler cleans up
    }
  }

  function flush(sess: Session): void {
    if (sess.timer) {
      clearTimeout(sess.timer);
      sess.timer = null;
    }
    while (sess.chunks.length > 0) {
      let cut = Math.min(sess.chunks.length, TERMINAL_MAX_PAYLOAD);
      if (cut < sess.chunks.length) {
        const c = sess.chunks.charCodeAt(cut - 1);
        if (c >= 0xd800 && c <= 0xdbff) cut--; // never split a surrogate pair
      }
      send(sess.sock, { t: 'out', id: sess.id, d: sess.chunks.slice(0, cut) });
      sess.chunks = sess.chunks.slice(cut);
    }
    if (!sess.sock.poll && sess.sock.ws.bufferedAmount > PAUSE_ABOVE) pauseSock(sess.sock);
  }

  function pauseSock(s: Sock): void {
    for (const x of s.sessions.values()) safe(() => x.pty.pause());
    s.poll = setInterval(() => {
      if (s.closed || s.ws.bufferedAmount >= RESUME_BELOW) return;
      if (s.poll) clearInterval(s.poll);
      s.poll = null;
      for (const x of s.sessions.values()) safe(() => x.pty.resume());
    }, RESUME_POLL_MS);
    s.poll.unref?.();
  }

  function safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // a PTY that is already gone
    }
  }

  /** Removes the session and stops everything that belongs to it. Returns false when it was already gone. */
  function forget(sess: Session): boolean {
    if (!sess.sock.sessions.delete(sess.id)) return false;
    if (sess.timer) clearTimeout(sess.timer);
    sess.timer = null;
    return true;
  }

  /**
   * pty.kill plus taskkill of the tree (taskkill first: after pty.kill the PID could already be reused). The shell is spawned with node-pty's bundled
   * conpty.dll (useConptyDll), whose kill does not fork the console-list agent that printed "AttachConsole failed" for an already-dead shell.
   * only for a session whose exit event has not fired (audit 2: a freed PID may belong to someone else). */
  function killSession(sess: Session): void {
    if (!forget(sess)) return;
    safe(() => deps.runTaskkill(taskkillExe(), ['/T', '/F', '/PID', String(sess.pty.pid)]));
    safe(() => sess.pty.kill());
  }

  function closeSock(s: Sock): void {
    if (s.closed) return;
    for (const sess of [...s.sessions.values()]) killSession(sess);
    s.closed = true;
    if (s.beat) clearInterval(s.beat);
    if (s.poll) clearInterval(s.poll);
    s.beat = s.poll = null;
    socks.delete(s);
  }

  function childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(deps.env)) {
      if (v === undefined || REMOVED_ENV.test(k) || REMOVED_GIT.test(k)) continue;
      env[k] = v;
    }
    return env;
  }

  function open(s: Sock, f: Record<string, unknown>): void {
    const req = f.req;
    const fail = (code: number): void => send(s, { t: 'error', req, code });
    if (!available()) return fail(409);
    let shell: unknown = 'powershell';
    if (Object.prototype.hasOwnProperty.call(f, 'shell')) shell = f.shell;
    if (shell !== 'powershell' && shell !== 'bash') return fail(400);
    const root = deps.rootOf(f.repoId as string);
    if (typeof root !== 'string' || root === '') return fail(404);
    const file = shell === 'bash' ? bashExe() : psExe();
    if (shell === 'bash' && !deps.shellExists(file)) return fail(409);
    let total = 0;
    let perRepo = 0;
    for (const x of socks) {
      for (const sess of x.sessions.values()) {
        total++;
        if (sess.repoId === f.repoId) perRepo++;
      }
    }
    if (total >= MAX_TOTAL || perRepo >= MAX_PER_REPO) return fail(429);
    const cols = isNum(f.cols) ? clamp(f.cols, 2, 500) : 80;
    const rows = isNum(f.rows) ? clamp(f.rows, 1, 200) : 24;
    let pty: PtyLike;
    try {
      pty = (deps.spawnPty as SpawnPty)(file, shell === 'bash' ? ['--login', '-i'] : ['-NoLogo'], { name: 'xterm-256color', cols, rows, cwd: root, env: childEnv(), useConptyDll: true });
    } catch {
      return fail(500);
    }
    const sess: Session = { id: `t${nextId++}-${randomBytes(6).toString('hex')}`, repoId: f.repoId as string, pty, sock: s, chunks: '', timer: null };
    s.sessions.set(sess.id, sess);
    pty.onData((d) => {
      if (!s.sessions.has(sess.id)) return;
      sess.chunks += d;
      if (sess.chunks.length >= TERMINAL_MAX_PAYLOAD) flush(sess);
      else if (!sess.timer) {
        sess.timer = setTimeout(() => flush(sess), FLUSH_MS);
        sess.timer.unref?.();
      }
    });
    pty.onExit((e) => {
      if (!s.sessions.has(sess.id)) return;
      flush(sess);
      forget(sess);
      send(s, { t: 'exit', id: sess.id, code: isNum(e.exitCode) ? e.exitCode : 0 });
    });
    if (s.poll) safe(() => pty.pause());
    send(s, { t: 'opened', req, id: sess.id });
  }

  function onFrame(s: Sock, data: unknown, isBinary: boolean): void {
    const bad = (): void => {
      try {
        s.ws.close(1008, 'bad frame');
      } catch {
        s.ws.terminate();
      }
    };
    if (isBinary || !Buffer.isBuffer(data) || data.length > TERMINAL_MAX_PAYLOAD) return bad();
    let f: unknown;
    try {
      f = JSON.parse(data.toString('utf8'));
    } catch {
      return bad();
    }
    if (typeof f !== 'object' || f === null || Array.isArray(f)) return bad();
    const o = f as Record<string, unknown>;
    switch (o.t) {
      case 'open':
        if (!isStr(o.repoId)) return bad();
        return open(s, o);
      case 'in':
      case 'resize':
      case 'kill': {
        if (!isStr(o.id)) return bad();
        if (o.t === 'in' && !isStr(o.d)) return bad();
        if (o.t === 'resize' && (!isNum(o.cols) || !isNum(o.rows))) return bad();
        const sess = s.sessions.get(o.id); // only this socket's own sessions
        if (!sess) return send(s, { t: 'error', id: o.id, code: 404 });
        if (o.t === 'in') safe(() => sess.pty.write(o.d as string));
        else if (o.t === 'resize') safe(() => sess.pty.resize(clamp(o.cols as number, 2, 500), clamp(o.rows as number, 1, 200)));
        else killSession(sess);
        return;
      }
      default:
        return bad();
    }
  }

  return {
    available,
    bashAvailable: () => available() && deps.shellExists(bashExe()),

    issueTicket() {
      if (!available()) return { ok: false, status: 409 };
      prune();
      if (tickets.size >= MAX_TICKETS) return { ok: false, status: 429 };
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, deps.now() + TICKET_TTL_MS);
      return { ok: true, ticket };
    },

    acceptUpgrade({ ticket, origin, host }) {
      // The ticket is used up the first time it is presented, whatever else fails (audit 1).
      let exp: number | undefined;
      if (isStr(ticket) && ticket !== '') {
        exp = tickets.get(ticket);
        tickets.delete(ticket);
      }
      if (!available()) return { ok: false, status: 409 };
      if (exp === undefined || deps.now() > exp) return { ok: false, status: 403 };
      if (origin === undefined || !isAllowedOrigin(origin, deps.port)) return { ok: false, status: 403 };
      if (!isAllowedHost(host, deps.port)) return { ok: false, status: 403 };
      // An accepted upgrade counts toward the cap until it attaches (or its short window passes), so concurrent upgrades cannot overshoot it.
      while (pendingUp.length > 0 && pendingUp[0]! <= deps.now()) pendingUp.shift();
      if (socks.size + pendingUp.length >= MAX_SOCKETS) return { ok: false, status: 429 };
      pendingUp.push(deps.now() + PENDING_UPGRADE_MS);
      return { ok: true };
    },

    ticketCount() {
      prune();
      return tickets.size;
    },

    attach(ws) {
      const s: Sock = { ws, sessions: new Map(), lastPong: Date.now(), beat: null, poll: null, closed: false };
      socks.add(s);
      pendingUp.shift();
      s.beat = setInterval(() => {
        if (Date.now() - s.lastPong > DEAD_AFTER_MS) {
          ws.terminate();
          return;
        }
        safe(() => ws.ping());
      }, HEARTBEAT_MS);
      s.beat.unref?.();
      ws.on('pong', () => {
        s.lastPong = Date.now();
      });
      ws.on('message', ((data: unknown, isBinary: boolean) => onFrame(s, data, isBinary)) as never);
      ws.on('close', () => closeSock(s));
      ws.on('error', () => safe(() => ws.terminate()));
    },

    killAll() {
      for (const s of [...socks]) for (const sess of [...s.sessions.values()]) killSession(sess);
    },
  };
}
