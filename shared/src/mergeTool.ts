/** Payloads of the merge tool routes (phase 8). */

export interface MergeSideInfo {
  /** Short sha (7+ hex). */
  sha: string;
  branch?: string;
  /** The side is a stash being applied (its pane reads "Stash" instead of "Commit <sha>"). */
  stash?: true;
}

export interface MergeToolInfo {
  binary: boolean;
  bom: boolean;
  eol: 'lf' | 'crlf';
  /** Stage 1 / 2 / 3 text, or null when that stage does not exist. Empty strings when `binary`. */
  base: string | null;
  a: string | null;
  b: string | null;
  aInfo: MergeSideInfo;
  bInfo: MergeSideInfo;
  /** merge.tool is configured and all three stages exist. */
  external: boolean;
  /** sha256 hex of the working file bytes, or "missing". */
  workingHash: string;
}

export interface MergeToolBackup {
  /** Blob holding the working file bytes from before the write. */
  backup: string;
}
