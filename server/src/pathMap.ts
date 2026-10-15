/** Docker mode: maps a Windows host folder typed into "Open" to the folder it is mounted at inside the container. Pure, no I/O. */

export interface PathPair {
  /** Host prefix, forward slashes, no trailing slash (e.g. `C:/repos`). */
  host: string;
  /** Container prefix, forward slashes, no trailing slash (e.g. `/repos`). */
  container: string;
}

/** Separator between pairs in GITSLAPPIN_PATH_MAP (same as GITSLAPPIN_REPO_ROOTS). */
export const PATH_MAP_SEPARATOR = ';';

const slashes = (s: string) => s.replace(/\\/g, '/');
const noTrailing = (s: string) => s.replace(/\/+$/, '');

/** Parses `host=container;host2=container2`. Unset or empty gives no pairs; a malformed pair throws. */
export function parsePathMap(value: string | undefined): PathPair[] {
  return (value ?? '')
    .split(PATH_MAP_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.lastIndexOf('=');
      const host = i > 0 ? noTrailing(slashes(entry.slice(0, i).trim())) : '';
      const container = i > 0 ? noTrailing(slashes(entry.slice(i + 1).trim())) : '';
      if (!host || !container) throw new Error(`GITSLAPPIN_PATH_MAP entry "${entry}" must look like host=container.`);
      return { host, container };
    });
}

/** Reverse of mapOpenPath: swaps a container prefix for its host prefix (whole segments, case-insensitive). Forward slashes out. */
export function toHostPath(path: string, pairs: PathPair[]): string {
  const norm = slashes(path);
  const lower = norm.toLowerCase();
  for (const p of pairs) {
    const c = p.container.toLowerCase();
    if (lower === c || lower.startsWith(`${c}/`)) return p.host + norm.slice(p.container.length);
  }
  return norm;
}

export type MapResult = { path: string } | { error: string };

/**
 * Applies the map to the text typed into Open. With no pairs nothing changes. A path under a host prefix
 * (whole segments, case-insensitive, `\` or `/`) gets the container prefix. A drive-letter path that matches
 * no pair is refused. Anything else is returned unchanged for the normal checks (UNC refusal, roots, git).
 */
export function mapOpenPath(input: string, pairs: PathPair[]): MapResult {
  if (pairs.length === 0) return { path: input };
  const text = input.trim().replace(/^"(.*)"$/, '$1').trim();
  const norm = slashes(text);
  const lower = norm.toLowerCase();
  for (const p of pairs) {
    const h = p.host.toLowerCase();
    if (lower === h || lower.startsWith(`${h}/`)) return { path: p.container + norm.slice(p.host.length) };
  }
  if (/^[a-zA-Z]:/.test(norm)) {
    const list = pairs.map((p) => `${p.container} = ${p.host}`).join(', ');
    return { error: `In Docker, GitSlappin can only open folders under the mounted folders (${list}).` };
  }
  return { path: text };
}
