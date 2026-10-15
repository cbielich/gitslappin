import type { LocalBranch, RefsInfo, RemoteGroup, StashInfo, TagInfo } from '@gitslappin/shared';

/** for-each-ref format. Fields 0x1f separated, one record per line (ref names cannot contain control chars). */
export const REFS_FORMAT = '%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1f%(objecttype)%1f%(*objecttype)';

export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: track.includes('gone') };
}

/** Remote a short remote-branch name (`origin/main`) belongs to: the longest configured remote name that prefixes it. */
export function remoteOf(name: string, remoteNames: string[]): string {
  let best = '';
  for (const r of remoteNames) if (name.startsWith(`${r}/`) && r.length > best.length) best = r;
  return best || (name.split('/')[0] ?? name);
}

export function parseForEachRef(stdout: string, remoteNames: string[] = []): Pick<RefsInfo, 'local' | 'remotes' | 'tags'> {
  const local: LocalBranch[] = [];
  const tags: TagInfo[] = [];
  const remoteMap = new Map<string, RemoteGroup>();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [ref = '', sha = '', peeled = '', upstream = '', track = '', head = '', objType = '', peeledType = ''] = line.split('\x1f');
    if (ref.startsWith('refs/heads/')) {
      local.push({
        name: ref.slice('refs/heads/'.length),
        sha,
        upstream: upstream || null,
        ...parseTrack(track),
        current: head.trim() === '*',
      });
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length);
      if (name.endsWith('/HEAD')) continue;
      const remote = remoteOf(name, remoteNames);
      let group = remoteMap.get(remote);
      if (!group) remoteMap.set(remote, (group = { name: remote, branches: [] }));
      group.branches.push({ name, sha });
    } else if (ref.startsWith('refs/tags/')) {
      // Only tags that resolve to a commit (lightweight, or annotated pointing at a commit).
      if (!(objType === 'commit' || (objType === 'tag' && peeledType === 'commit'))) continue;
      tags.push({ name: ref.slice('refs/tags/'.length), sha: peeled || sha });
    }
  }
  return { local, remotes: [...remoteMap.values()], tags };
}

/** `git stash list --format=STASH_FORMAT` */
export const STASH_FORMAT = '%H%x00%P%x00%gd%x00%gs%x1e';

export function parseStashList(stdout: string): StashInfo[] {
  const out: StashInfo[] = [];
  for (const rec of stdout.split('\x1e')) {
    const text = rec.replace(/^\n+/, '');
    if (!text) continue;
    const [sha = '', parents = '', ref = '', message = ''] = text.split('\0');
    const m = /^stash@\{(\d+)\}$/.exec(ref);
    if (!sha || !m) continue;
    out.push({ index: Number(m[1]), ref, sha, parents: parents ? parents.split(' ') : [], message });
  }
  return out;
}
