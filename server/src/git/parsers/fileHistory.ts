import type { FileHistoryEntry } from '@gitslappin/shared';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LETTERS = new Set(['A', 'M', 'D', 'R', 'C', 'T']);

/** Parses `log --follow -M --name-status -z --format=%x1e%H%x00%an%x00%ae%x00%aI%x00%s`. A record that does not start with a full hex sha is skipped. */
export function parseFileHistory(stdout: string): FileHistoryEntry[] {
  const out: FileHistoryEntry[] = [];
  for (const rec of stdout.split('\x1e')) {
    if (!rec) continue;
    const f = rec.split('\0');
    const sha = f[0] ?? '';
    if (!SHA.test(sha) || f.length < 7) continue;
    const letter = (f[5] ?? '').replace(/^\n+/, '')[0] ?? '';
    if (!LETTERS.has(letter)) continue;
    const status = letter as FileHistoryEntry['status'];
    const base = { sha, authorName: f[1] ?? '', authorEmail: f[2] ?? '', authorDate: f[3] ?? '', summary: f[4] ?? '', status };
    if (letter === 'R' || letter === 'C') out.push({ ...base, path: f[7] ?? '', oldPath: f[6] ?? '' });
    else out.push({ ...base, path: f[6] ?? '' });
  }
  return out;
}
