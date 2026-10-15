import type { RefLabel } from '@gitslappin/shared';

export interface Pill {
  key: string;
  label: string;
  local: boolean;
  remote: boolean;
  tag: boolean;
  current: boolean;
  title: string;
  /** Name of the local branch in this pill. */
  localName?: string;
  /** Full names (`origin/x`) of the remote branches in this pill. */
  remoteNames: string[];
}

/** Groups ref labels into pills: a local branch and its same-named remote branch share one pill. */
export function groupRefs(refs: RefLabel[]): Pill[] {
  const map = new Map<string, Pill>();
  const get = (key: string, label: string): Pill => {
    let p = map.get(key);
    if (!p) map.set(key, (p = { key, label, local: false, remote: false, tag: false, current: false, title: '', remoteNames: [] }));
    return p;
  };
  for (const r of refs) {
    if (r.kind === 'tag') {
      const p = get(`t:${r.name}`, r.name);
      p.tag = true;
      p.title = `tag: ${r.name}`;
    } else if (r.kind === 'head') {
      const p = get('h', 'HEAD');
      p.local = true;
      p.current = true;
      p.title = 'HEAD (detached)';
    } else if (r.kind === 'local') {
      const p = get(`b:${r.name}`, r.name);
      p.local = true;
      p.localName = r.name;
      p.current = p.current || !!r.current;
      p.title = p.title ? `${r.name}, ${p.title}` : r.name;
    } else {
      const short = r.name.includes('/') ? r.name.slice(r.name.indexOf('/') + 1) : r.name;
      const p = get(`b:${short}`, short);
      p.remote = true;
      p.remoteNames.push(r.name);
      p.title = p.title ? `${p.title}, ${r.name}` : r.name;
    }
  }
  return [...map.values()].sort((a, b) => Number(b.current) - Number(a.current));
}
