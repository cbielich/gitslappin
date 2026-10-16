import type { BlameCommit, BlameResult } from '@gitslappin/shared';

const HEADER_RE = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ \d+(?: \d+)?$/;

/** Parses `git blame --porcelain`: a header per run (full details only the first time a commit shows up), then the tab-led file line. */
export function parseBlamePorcelain(stdout: string): BlameResult {
  const commits: Record<string, BlameCommit> = Object.create(null) as Record<string, BlameCommit>;
  const lines: string[] = [];
  let current: string | null = null;
  let building: BlameCommit | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('\t')) {
      if (current) lines.push(current);
      building = null;
      continue;
    }
    const h = HEADER_RE.exec(line);
    if (h) {
      current = h[1]!;
      if (!(current in commits)) {
        building = { summary: '', authorName: '', authorEmail: '', authorTime: 0 };
        commits[current] = building;
      } else building = null;
      continue;
    }
    if (!building) continue;
    if (line.startsWith('author ')) building.authorName = line.slice(7);
    else if (line.startsWith('author-mail ')) building.authorEmail = line.slice(12).replace(/^<|>$/g, '');
    else if (line.startsWith('author-time ')) building.authorTime = Number(line.slice(12)) || 0;
    else if (line.startsWith('summary ')) building.summary = line.slice(8);
  }
  return { commits: { ...commits }, lines };
}
