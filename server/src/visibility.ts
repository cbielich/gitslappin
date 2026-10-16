import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphVisibility } from '@gitslappin/shared';

export const VISIBILITY_FILE = 'graph-visibility.json';
export const MAX_VISIBILITY_ENTRIES = 5000;
const MAX_ENTRY_LENGTH = 1024;
const PREFIXES = ['refs/heads/', 'refs/remotes/', 'refs/tags/'];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function parseList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_VISIBILITY_ENTRIES) return null;
  const out: string[] = [];
  for (const e of v) {
    if (typeof e !== 'string' || e.length > MAX_ENTRY_LENGTH || CONTROL.test(e) || !PREFIXES.some((p) => e.startsWith(p) && e.length > p.length)) return null;
    out.push(e);
  }
  return out;
}

/** The validated value (a fresh object with only the three known keys), or null when anything is wrong. */
export function parseVisibility(input: unknown): GraphVisibility | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  if (!own(input, 'hidden') || !own(input, 'solo') || !own(input, 'hideStashes')) return null;
  const src = input as Record<string, unknown>;
  const hidden = parseList(src.hidden);
  const solo = parseList(src.solo);
  if (!hidden || !solo || typeof src.hideStashes !== 'boolean') return null;
  return { hidden, solo, hideStashes: src.hideStashes };
}

export const NO_VISIBILITY: GraphVisibility = { hidden: [], solo: [], hideStashes: false };
export const isNoVisibility = (v: GraphVisibility): boolean => v.hidden.length === 0 && v.solo.length === 0 && !v.hideStashes;

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

/** Per-repo hide/solo state in `<dataDir>/graph-visibility.json` (repoId -> value). Loaded once; a missing or corrupt file or entry reads as nothing hidden. */
export class VisibilityStore {
  private map: Map<string, GraphVisibility> | null = null;

  constructor(private dataDir: string) {}

  private load(): Map<string, GraphVisibility> {
    if (this.map) return this.map;
    const map = new Map<string, GraphVisibility>();
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.dataDir, VISIBILITY_FILE), 'utf8'));
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        for (const [id, v] of Object.entries(raw)) {
          const ok = parseVisibility(v);
          if (ok) map.set(id, ok);
        }
      }
    } catch {
      // corrupt or missing: nothing hidden
    }
    this.map = map;
    return map;
  }

  get(repoId: string): GraphVisibility {
    return this.load().get(repoId) ?? NO_VISIBILITY;
  }

  set(repoId: string, v: GraphVisibility): void {
    const map = this.load();
    const next = new Map(map);
    if (isNoVisibility(v)) next.delete(repoId);
    else next.set(repoId, v);
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = join(this.dataDir, `${VISIBILITY_FILE}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(next)), 'utf8');
    renameWithRetry(tmp, join(this.dataDir, VISIBILITY_FILE));
    this.map = next;
  }
}
