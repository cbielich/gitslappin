import type { LogCommit, RefLabel } from '@gitslappin/shared';

/** git log --format used by the log route. Fields are NUL separated, records end with 0x1e. */
export const LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%D%x1e';
export const REC = '\x1e';

/** Parses `%D` produced with `--decorate=full`. Skips remote HEADs and refs/stash. */
export function parseDecorations(raw: string): RefLabel[] {
  const out: RefLabel[] = [];
  if (!raw) return out;
  for (const part of raw.split(', ')) {
    const item = part.trim();
    if (!item) continue;
    if (item.startsWith('HEAD -> ')) {
      const ref = item.slice('HEAD -> '.length);
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), kind: 'local', current: true });
    } else if (item === 'HEAD') {
      out.push({ name: 'HEAD', kind: 'head', current: true });
    } else if (item.startsWith('tag: refs/tags/')) {
      out.push({ name: item.slice('tag: refs/tags/'.length), kind: 'tag' });
    } else if (item.startsWith('refs/heads/')) {
      out.push({ name: item.slice('refs/heads/'.length), kind: 'local' });
    } else if (item.startsWith('refs/remotes/')) {
      const name = item.slice('refs/remotes/'.length);
      if (!name.endsWith('/HEAD')) out.push({ name, kind: 'remote' });
    }
  }
  return out;
}

export function parseLog(stdout: string): LogCommit[] {
  const commits: LogCommit[] = [];
  for (const rec of stdout.split(REC)) {
    const text = rec.replace(/^\n+/, '');
    if (!text) continue;
    const f = text.split('\0');
    if (f.length < 7 || !f[0]) continue;
    commits.push({
      sha: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      authorName: f[2] ?? '',
      authorEmail: f[3] ?? '',
      authorDate: f[4] ?? '',
      subject: f[5] ?? '',
      refs: parseDecorations(f[6] ?? ''),
    });
  }
  return commits;
}
