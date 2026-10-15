import type { DiffStatus, FileDiff } from '@gitslappin/shared';

/** Sums `--numstat -z` output for one path only (a rename counts under its new path). */
export function sumNumstat(stdout: string, path: string): { additions: number; deletions: number } {
  const toks = stdout.split('\0');
  let additions = 0;
  let deletions = 0;
  for (let i = 0; i < toks.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(toks[i] ?? '');
    if (!m) continue;
    let file = m[3] ?? '';
    if (file === '') {
      // Rename or copy: the old and new paths follow as their own tokens.
      file = toks[i + 2] ?? '';
      i += 2;
    }
    if (file !== path) continue;
    additions += m[1] === '-' ? 0 : Number(m[1]);
    deletions += m[2] === '-' ? 0 : Number(m[2]);
  }
  return { additions, deletions };
}

/** The status letter git reports (`--name-status -z`) for one path, or null when the path is not listed. */
export function statusFromNameStatus(stdout: string, path: string): DiffStatus | null {
  const toks = stdout.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const code = toks[i] ?? '';
    if (!/^[A-Z]\d*$/.test(code)) continue;
    const letter = code[0] as string;
    const twoPaths = letter === 'R' || letter === 'C';
    const file = twoPaths ? (toks[i + 2] ?? '') : (toks[i + 1] ?? '');
    i += twoPaths ? 2 : 1;
    if (file !== path) continue;
    return letter === 'A' || letter === 'D' || letter === 'R' || letter === 'C' ? letter : 'M';
  }
  return null;
}

/** The parsed file whose path is the requested one, else the first. */
export function pickFile(files: FileDiff[], path: string): FileDiff | undefined {
  return files.find((f) => f.path === path) ?? files[0];
}
