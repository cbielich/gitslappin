import { runGit } from './runner';

/** Raw bytes of a blob by object id. Read as latin1 (one char per byte), so every byte survives. */
export async function readBlobBytes(root: string, repoId: string, oid: string, maxBytes: number): Promise<Buffer | 'too-large' | null> {
  if (!/^[0-9a-f]{40,64}$/.test(oid)) return null;
  const size = await runGit(['cat-file', '-s', oid], { cwd: root, repoId });
  if (size.code !== 0) return null;
  if (Number(size.stdout.trim()) > maxBytes) return 'too-large';
  const res = await runGit(['cat-file', 'blob', oid], { cwd: root, repoId, encoding: 'latin1', maxBuffer: maxBytes * 2 });
  return res.code === 0 ? Buffer.from(res.stdout, 'latin1') : null;
}

/** One unmerged index entry. */
export interface UnmergedEntry {
  mode: string;
  oid: string;
  stage: 1 | 2 | 3;
}

/** The stages of `path` from `ls-files -u -z`, matched by exact string. Empty when the path is not unmerged. */
export async function unmergedStages(root: string, repoId: string, path: string): Promise<UnmergedEntry[]> {
  const res = await runGit(['--literal-pathspecs', 'ls-files', '-u', '-z'], { cwd: root, repoId });
  if (res.code !== 0) return [];
  const out: UnmergedEntry[] = [];
  for (const rec of res.stdout.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) ([123])\t([\s\S]*)$/.exec(rec);
    if (m && m[4] === path) out.push({ mode: m[1]!, oid: m[2]!, stage: Number(m[3]) as 1 | 2 | 3 });
  }
  return out;
}
