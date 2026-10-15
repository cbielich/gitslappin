import type { ChangedFile, CommitDetail, FileStatus } from '@gitslappin/shared';

export const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

/** git log -1 --format=COMMIT_FORMAT: 8 NUL-separated fields, then the full message. */
export const COMMIT_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B';

export function parseCommitMeta(stdout: string): Omit<CommitDetail, 'files'> | null {
  const parts = stdout.split('\0');
  if (parts.length < 9 || !parts[0]) return null;
  const message = parts.slice(8).join('\0').replace(/\n+$/, '');
  return {
    sha: parts[0].replace(/^\n+/, ''),
    parents: parts[1] ? parts[1].split(' ') : [],
    authorName: parts[2] ?? '',
    authorEmail: parts[3] ?? '',
    authorDate: parts[4] ?? '',
    committerName: parts[5] ?? '',
    committerEmail: parts[6] ?? '',
    committerDate: parts[7] ?? '',
    message,
  };
}

const STATUSES = new Set<string>(['A', 'M', 'D', 'R', 'C', 'T', 'U']);

/** Parses `git diff-tree --name-status -z` output. */
export function parseNameStatusZ(stdout: string): ChangedFile[] {
  const tok = stdout.split('\0');
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < tok.length) {
    const code = tok[i++];
    if (!code) continue;
    const letter = code[0] ?? '';
    const status = (STATUSES.has(letter) ? letter : 'M') as FileStatus;
    if (letter === 'R' || letter === 'C') {
      const oldPath = tok[i++] ?? '';
      const path = tok[i++] ?? '';
      files.push({ status, path, oldPath });
    } else {
      const path = tok[i++] ?? '';
      files.push({ status, path });
    }
  }
  return files;
}
