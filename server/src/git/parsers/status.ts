import type { StatusCode, StatusSummary, WipFile } from '@gitslappin/shared';

function kindOf(xy: string): WipFile['status'] {
  if (xy.includes('D')) return 'D';
  if (xy.includes('A')) return 'A';
  if (xy.includes('R') || xy.includes('C')) return 'R';
  return 'M';
}

const code = (c: string | undefined): StatusCode => (c && 'MTADRCU'.includes(c) ? (c as StatusCode) : '.');

export const MAX_STATUS_FILES = 5000;

/** Parses `git status --porcelain=v2 -z --untracked-files=all`. */
export function parseStatusV2(stdout: string): StatusSummary {
  const files: WipFile[] = [];
  const tok = stdout.split('\0');
  let i = 0;
  while (i < tok.length) {
    const t = tok[i++];
    if (!t) continue;
    const type = t[0];
    if (type === '1') {
      const f = t.split(' ');
      const xy = f[1] ?? '..';
      files.push({ path: f.slice(8).join(' '), status: kindOf(xy), staged: xy[0] !== '.', unstaged: xy[1] !== '.', indexStatus: code(xy[0]), worktreeStatus: code(xy[1]) });
    } else if (type === '2') {
      const f = t.split(' ');
      const xy = f[1] ?? '..';
      const orig = tok[i++]; // original path follows as its own token
      files.push({ path: f.slice(9).join(' '), ...(orig ? { oldPath: orig } : {}), status: kindOf(xy), staged: xy[0] !== '.', unstaged: xy[1] !== '.', indexStatus: code(xy[0]), worktreeStatus: code(xy[1]) });
    } else if (type === 'u') {
      const f = t.split(' ');
      files.push({ path: f.slice(10).join(' '), status: 'U', staged: false, unstaged: true, indexStatus: 'U', worktreeStatus: 'U' });
    } else if (type === '?') {
      files.push({ path: t.slice(2), status: '?', staged: false, unstaged: true, indexStatus: '.', worktreeStatus: '?' });
    }
    // '!' (ignored) and '#' headers are skipped
  }
  const count = (s: WipFile['status']) => files.filter((f) => f.status === s).length;
  return {
    modified: count('M') + count('R'),
    added: count('A'),
    deleted: count('D'),
    untracked: count('?'),
    conflicted: count('U'),
    total: files.length,
    stagedCount: files.filter((f) => f.staged).length,
    unstagedCount: files.filter((f) => f.unstaged).length,
    files: files.length > MAX_STATUS_FILES ? files.slice(0, MAX_STATUS_FILES) : files,
    ...(files.length > MAX_STATUS_FILES ? { truncated: true } : {}),
  };
}
