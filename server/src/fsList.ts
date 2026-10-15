import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, opendir, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import type { FsEntry, FsListResult } from '@gitslappin/shared';
import { mapOpenPath, toHostPath, type PathPair } from './pathMap';
import { isUncOrDevicePath } from './security';

export const MAX_ENTRIES = 2000;
const MAX_PATH_LENGTH = 4096;
const LIST_TIMEOUT_MS = 3000;
const STAT_TIMEOUT_MS = 1000;
const STAT_CONCURRENCY = 16;

/** A refusal or failure the route turns into `{ error }`. 400 = bad or unreadable folder, 503 = another listing is running. */
export class FsListError extends Error {
  constructor(
    public status: 400 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Strips control characters (C0, DEL, C1) and bidi controls. For names and paths shown on screen only. */
export function sanitizeDisplay(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

/** Fixed drives (DriveType 3) via PowerShell, asked once at startup. Any failure gives `C:` only. Windows only. */
export function queryFixedDrives(): Promise<string[]> {
  const fallback = ['C:'];
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((done) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $_.DeviceID }'],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          if (err) return done(fallback);
          const drives = String(stdout)
            .split(/\r?\n/)
            .map((s) => s.trim().toUpperCase())
            .filter((s) => /^[A-Z]:$/.test(s));
          done(drives.length > 0 ? drives : fallback);
        },
      );
    } catch {
      done(fallback);
    }
  });
}

export interface FsListerOptions {
  mode: 'native' | 'roots';
  roots: string[];
  pathMap?: PathPair[];
  /** Native mode: the fixed drives found at startup, like `C:`. */
  drives?: string[];
}

const win = process.platform === 'win32';
const norm = (p: string) => (win ? p.toLowerCase() : p);
const isNetwork = (p: string) => p.startsWith('\\\\');
const isNetworkTarget = (t: string) => /^(\\\\|\/\/)/.test(t) || /^\\\?\?\\UNC\\/i.test(t);

/** A drive letter outside `drives` (mapped network drives) is not local. Only checked when a drive list is given (native mode, Windows). */
function driveRefused(p: string, drives?: string[]): boolean {
  if (!win || !drives || !/^[a-zA-Z]:/.test(p)) return false;
  return !drives.some((d) => d.toUpperCase() === p.slice(0, 2).toUpperCase());
}

/** One shared budget of link hops for a whole check. */
interface HopBudget {
  left: number;
}

/** False when `p` is a link whose target (every hop, every path prefix, without touching it) is a network path or a drive outside `drives`. No SMB connection is made. */
async function linkIsLocal(p: string, drives?: string[], budget: HopBudget = { left: 16 }): Promise<boolean> {
  let st;
  try {
    st = await lstat(p);
  } catch {
    return true; // missing: realpath/stat report that later
  }
  if (!st.isSymbolicLink()) return true;
  let t: string;
  try {
    t = await readlink(p);
  } catch {
    return false; // a known link that cannot be read is not trusted
  }
  if (--budget.left < 0) return false; // too many hops
  if (isNetworkTarget(t)) return false;
  const next = resolve(dirname(p), t.replace(/^\\\?\?\\/, ''));
  if (isNetwork(next) || driveRefused(next, drives)) return false;
  return pathIsLocal(next, drives, budget);
}

/** Checks every prefix of an absolute path (each may be a link). */
async function pathIsLocal(abs: string, drives?: string[], budget: HopBudget = { left: 16 }): Promise<boolean> {
  const root = parse(abs).root;
  let cur = root;
  for (const seg of abs.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    cur = join(cur, seg);
    if (!(await linkIsLocal(cur, drives, budget))) return false;
  }
  return true;
}

function within<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((done, fail) => {
    const t = setTimeout(() => done(onTimeout()), ms);
    t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        done(v);
      },
      (e) => {
        clearTimeout(t);
        fail(e);
      },
    );
  });
}

function hiddenName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('$') || name.toLowerCase() === 'system volume information';
}

export function createFsLister(opts: FsListerOptions): { list(path?: string): Promise<FsListResult> } {
  const pathMap = opts.pathMap ?? [];
  const rootsMode = opts.mode === 'roots';
  if (rootsMode && opts.roots.length === 0) throw new Error('Folder browsing in roots mode needs at least one root folder.');
  let busy = false;

  const show = (p: string) => sanitizeDisplay(pathMap.length > 0 ? toHostPath(p, pathMap) : p);
  const underRoots = (p: string, realRoots: string[]) =>
    realRoots.some((r) => {
      const a = norm(p);
      const b = norm(r);
      return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
    });

  function startFolder(): string {
    if (rootsMode) return opts.roots[0] ?? homedir();
    return existsSync('C:\\repos') ? 'C:\\repos' : homedir();
  }

  async function realRootsOf(): Promise<string[]> {
    return Promise.all(opts.roots.map((r) => realpath(resolve(r)).catch(() => resolve(r))));
  }

  async function doList(requested: string | undefined, deadline: number): Promise<FsListResult> {
    let typed = requested === undefined || requested.trim() === '' ? startFolder() : requested;
    if (typed.includes('\0')) throw new FsListError(400, 'That path is not valid.');
    if (typed.length > MAX_PATH_LENGTH) throw new FsListError(400, 'That path is too long.');
    // A path already under a container prefix (the start folder, entry paths) is not mapped again.
    const fwd = typed.replace(/\\/g, '/').toLowerCase();
    const isContainer = pathMap.some((p) => fwd === p.container.toLowerCase() || fwd.startsWith(p.container.toLowerCase() + '/'));
    const mapped = isContainer ? { path: typed } : mapOpenPath(typed, pathMap);
    if ('error' in mapped) throw new FsListError(400, mapped.error);
    typed = mapped.path.trim();
    if (/^[a-zA-Z]:$/.test(typed)) typed += '\\';
    if (isUncOrDevicePath(typed)) throw new FsListError(400, 'UNC and device paths are not supported. Use a local folder.');
    if (!(win ? /^[a-zA-Z]:[\\/]/.test(typed) : isAbsolute(typed))) throw new FsListError(400, 'Use a full folder path.');
    const resolved = resolve(typed);
    if (isUncOrDevicePath(resolved)) throw new FsListError(400, 'UNC and device paths are not supported. Use a local folder.');

    const knownDrive = (p: string) => (opts.drives ?? []).some((d) => d.toUpperCase() === p.slice(0, 2).toUpperCase());
    if (win && !rootsMode && !knownDrive(resolved)) throw new FsListError(400, 'That drive is not a local fixed drive.');
    const driveList = win && !rootsMode ? (opts.drives ?? []) : undefined;
    if (!(await pathIsLocal(resolved, driveList))) throw new FsListError(400, 'Network folders are not supported. Use a local folder.');

    // Resolve once, check that real path, then read that same real path.
    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      throw new FsListError(400, 'That folder does not exist or cannot be read.');
    }
    if (isUncOrDevicePath(real) || isNetwork(real)) throw new FsListError(400, 'Network folders are not supported. Use a local folder.');
    if (win && !rootsMode && !knownDrive(real)) throw new FsListError(400, 'That drive is not a local fixed drive.');
    const realRoots = rootsMode ? await realRootsOf() : [];
    if (rootsMode && !underRoots(real, realRoots)) throw new FsListError(400, 'That folder is outside the folders GitSlappin may browse.');
    try {
      if (!(await stat(real)).isDirectory()) throw new FsListError(400, 'That path is not a folder.');
    } catch (e) {
      if (e instanceof FsListError) throw e;
      throw new FsListError(400, 'That folder does not exist or cannot be read.');
    }

    // Read entry names (stops at the cap).
    const candidates: { raw: string; link: boolean }[] = [];
    let truncated = false;
    try {
      const dir = await opendir(real);
      try {
        for await (const d of dir) {
          if (Date.now() > deadline) throw new FsListError(400, 'Reading that folder took too long.');
          // Links and junctions may not report as symlinks on Windows, so anything that is not a plain file or folder is vetted with stat.
          const link = !d.isDirectory();
          if ((link && d.isFile()) || hiddenName(d.name)) continue;
          if (candidates.length >= MAX_ENTRIES) {
            truncated = true;
            break;
          }
          candidates.push({ raw: d.name, link });
        }
      } finally {
        await dir.close().catch(() => undefined);
      }
    } catch (e) {
      if (e instanceof FsListError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      throw new FsListError(400, code === 'EACCES' || code === 'EPERM' ? 'You do not have permission to open that folder.' : 'That folder cannot be read.');
    }

    // Vet each entry (links, roots, repo marker), 16 at a time.
    const found: (FsEntry | null)[] = new Array(candidates.length).fill(null);
    let next = 0;
    async function vet(i: number): Promise<void> {
      const cand = candidates[i];
      if (!cand) return;
      const { raw, link } = cand;
      const child = join(real, raw);
      let target = child;
      if (link && !(await linkIsLocal(child, driveList))) return;
      if (link || rootsMode) {
        try {
          target = await realpath(child);
        } catch {
          return;
        }
        if (isNetwork(target) || isUncOrDevicePath(target)) return;
        if (rootsMode && !underRoots(target, realRoots)) return;
      }
      if (link) {
        try {
          if (!(await stat(target)).isDirectory()) return;
        } catch {
          return;
        }
      }
      const isRepo = await within(
        lstat(join(target, '.git')).then(
          (st) => !st.isSymbolicLink(),
          () => false,
        ),
        STAT_TIMEOUT_MS,
        () => false,
      );
      found[i] = { name: sanitizeDisplay(raw), path: child, isRepo };
    }
    async function worker(): Promise<void> {
      while (next < candidates.length) {
        if (Date.now() > deadline) throw new FsListError(400, 'Reading that folder took too long.');
        await vet(next++);
      }
    }
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, worker));

    const entries = found
      .filter((e): e is FsEntry => e !== null)
      .sort((a, b) => {
        const x = a.name.toLowerCase();
        const y = b.name.toLowerCase();
        return x < y ? -1 : x > y ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });

    const atRoot = rootsMode ? realRoots.some((r) => norm(r) === norm(real)) : norm(parse(real).root) === norm(real);
    const roots = rootsMode
      ? realRoots.map((r) => ({ path: r, display: show(r) }))
      : (opts.drives ?? []).map((d) => ({ path: d, display: d }));
    return { path: real, display: show(real), parent: atRoot ? null : dirname(real), entries, roots, truncated };
  }

  return {
    list(path?: string): Promise<FsListResult> {
      if (busy) return Promise.reject(new FsListError(503, 'Another folder is still being read. Try again in a moment.'));
      busy = true; // taken synchronously, before any await
      const work = doList(path, Date.now() + LIST_TIMEOUT_MS);
      const release = () => {
        busy = false;
      };
      work.then(release, release);
      return new Promise<FsListResult>((done, fail) => {
        const t = setTimeout(() => fail(new FsListError(400, 'Reading that folder took too long.')), LIST_TIMEOUT_MS + 200);
        t.unref();
        work.then(
          (v) => {
            clearTimeout(t);
            done(v);
          },
          (e) => {
            clearTimeout(t);
            fail(e);
          },
        );
      });
    },
  };
}
