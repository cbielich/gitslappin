import { scrubSecrets } from './scrub';

export interface CommandLogEntry {
  /** Increasing per repo (never reused, even after old entries are dropped). */
  seq: number;
  at: number;
  args: string[];
  code: number;
  durationMs: number;
}

const MAX_ENTRIES = 1000;
const MAX_ARG = 500;
const logs = new Map<string, CommandLogEntry[]>();
const counters = new Map<string, number>();
let token = '';

/** The GitSlappin token is never kept in the log, whatever argument it turns up in. */
export function setLogToken(t: string): void {
  token = t;
}

/** Credentials out (URL userinfo, Authorization, http.*extraheader values, token query values, the GitSlappin token), then cut to 500 characters. Scrubbing comes first so a cut can never leave half a secret. */
export function scrubArg(arg: string): string {
  let s = scrubSecrets(arg).replace(/(http\.[^\s=]*extraheader=)[\s\S]*/gi, '$1***');
  if (token) s = s.split(token).join('***');
  return s.length > MAX_ARG ? s.slice(0, MAX_ARG) : s;
}

export function recordCommand(repoId: string, entry: Omit<CommandLogEntry, 'seq'>): void {
  const seq = (counters.get(repoId) ?? 0) + 1;
  counters.set(repoId, seq);
  const list = logs.get(repoId) ?? [];
  list.push({ ...entry, seq, args: entry.args.map(scrubArg) });
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  logs.set(repoId, list);
}

export function getCommandLog(repoId: string, after = 0): CommandLogEntry[] {
  return (logs.get(repoId) ?? []).filter((e) => e.seq > after);
}
