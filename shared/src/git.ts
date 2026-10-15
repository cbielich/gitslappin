export type RefKind = 'local' | 'remote' | 'tag' | 'head';

/** A ref label shown on a commit in the graph. */
export interface RefLabel {
  /** Short name: `main`, `origin/main`, `v1.0`. For kind 'head' (detached) it is `HEAD`. */
  name: string;
  kind: RefKind;
  /** True for the checked-out branch (or detached HEAD). */
  current?: boolean;
}

export interface LogCommit {
  sha: string;
  /** For stash nodes only the base commit is kept. */
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** ISO 8601 with offset. */
  authorDate: string;
  subject: string;
  refs: RefLabel[];
  /** Set for stash nodes: the stash index (stash@{N}). */
  stash?: number;
}

export interface LogPage {
  commits: LogCommit[];
  /** Pass as `skip` for the next page. */
  nextSkip: number;
  hasMore: boolean;
  /** Total number of graph commits (after hiding stash helper commits). */
  total: number;
}

export interface LocalBranch {
  name: string;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  current: boolean;
}

export interface RemoteBranch {
  /** Full short name, e.g. `origin/main`. */
  name: string;
  sha: string;
}

export interface RemoteGroup {
  name: string;
  branches: RemoteBranch[];
}

export interface TagInfo {
  name: string;
  /** Commit the tag points to (peeled for annotated tags). */
  sha: string;
}

export interface StashInfo {
  index: number;
  /** `stash@{N}` */
  ref: string;
  sha: string;
  /** Parents of the stash commit: [base, index, (untracked)]. */
  parents: string[];
  message: string;
}

/** One file of a stash: tracked changes by status, untracked files (from the third parent) as 'A'. */
export interface StashFileEntry {
  path: string;
  status: 'M' | 'A' | 'D' | 'R';
  oldPath?: string;
}

export interface StashFiles {
  files: StashFileEntry[];
  truncated?: boolean;
}

/** Result of POST /stash, /stash/apply, /stash/drop. `conflict` = an apply or pop left unmerged files (a pop keeps the stash). */
export interface StashResponse {
  sha?: string;
  base?: string;
  conflict?: boolean;
}

/** GET undo-state (phase 10): what the next Undo and Redo would do, as text for the tooltip ("commit 'Fix login'"). */
export interface UndoStateInfo {
  undo: { label: string } | null;
  redo: { label: string } | null;
}

export interface RefsInfo {
  /** Current branch name, or null when detached. */
  branch: string | null;
  detached: boolean;
  headSha: string | null;
  local: LocalBranch[];
  remotes: RemoteGroup[];
  tags: TagInfo[];
  stashes: StashInfo[];
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface ChangedFile {
  status: FileStatus;
  path: string;
  /** Only for renames/copies. */
  oldPath?: string;
}

export interface CommitDetail {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
  files: ChangedFile[];
  /** True when the file list or message was cut at the server limit. */
  truncated?: boolean;
}

export interface TreeListing {
  files: string[];
  truncated: boolean;
}

export interface LocateResult {
  /** Index in the graph order, or -1 when the commit is not in the history. */
  index: number;
}

export interface SearchResult {
  /** Matching shas in graph order. */
  shas: string[];
  /** Graph index of each sha in `shas` (same order). */
  indexes: number[];
}

/** One side of a porcelain XY status: a letter, or '.' for no change, or '?' for untracked. */
export type StatusCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

export interface WipFile {
  path: string;
  /** Only for staged renames/copies. */
  oldPath?: string;
  /** M modified, A added, D deleted, R renamed, U conflicted, ? untracked */
  status: 'M' | 'A' | 'D' | 'R' | 'U' | '?';
  /** Has a staged change. */
  staged: boolean;
  /** Has an unstaged (or untracked/conflicted) change. */
  unstaged: boolean;
  /** Index side of the status (what the Staged list shows). */
  indexStatus: StatusCode;
  /** Working-tree side of the status (what the Unstaged list shows). */
  worktreeStatus: StatusCode;
}

/** A merge, rebase, cherry-pick or revert that is stopped in the repo (phase 6). */
export interface OpState {
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash';
  /** merge: current branch; rebase: the branch being rebased (no refs/heads/). 'HEAD' when detached. */
  head: string;
  /** merge: the branch being merged (name, not sha). */
  other?: string;
  /** rebase: the target name. */
  onto?: string;
  step?: number;
  total?: number;
  /** The message git prepared for the commit (control characters removed, capped at 64 KB). */
  message: string;
  truncated?: boolean;
}

/** Result of the merge / rebase routes. */
export interface IntegrateResponse {
  outcome: 'done' | 'conflict';
  /** Set when an auto-stash was created (never popped). */
  stash?: { message: string };
}

export interface StatusSummary {
  /** Set while a merge, rebase, cherry-pick or revert is in progress. */
  op?: OpState;
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  conflicted: number;
  total: number;
  /** Files with a staged change / with an unstaged (or untracked, or conflicted) change. Exact even when `files` is cut. */
  stagedCount: number;
  unstagedCount: number;
  files: WipFile[];
  /** True when `files` was cut at the server limit (counts stay exact). */
  truncated?: boolean;
}

/** Where HEAD pointed: a branch name (null = detached) and the commit (null = no commit yet). */
export interface HeadState {
  branch: string | null;
  sha: string | null;
}

/** Result of POST checkout and POST branch. `prev` is what phase 10 Undo needs. */
export interface BranchActionResult {
  prev: HeadState;
  head: HeadState;
  created?: { name: string; sha: string };
  /** A remote checkout made a new local tracking branch (`created`), so undo can delete it. */
  createdTracking?: boolean;
}

/** A configured remote. The url never carries user:pass@ (scrubbed on the server). */
export interface RemoteInfo {
  name: string;
  url: string;
}

export type PullMode = 'merge' | 'ff-only' | 'rebase';

/** GET/PUT /api/prefs. */
export type Theme = 'dark' | 'light';
export interface Prefs {
  pullMode: PullMode;
  theme: Theme;
  /** 0.8 to 1.5 in 0.1 steps. */
  zoom: number;
}

/** Result of POST fetch / pull / push (200). A conflict means the merge or rebase is stopped (phase 6 screens). */
export interface RemoteResponse {
  outcome: 'done' | 'conflict';
}
