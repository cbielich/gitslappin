export interface RepoInfo {
  id: string;
  root: string;
  name: string;
}

export interface OpenRepoRequest {
  path: string;
}

/** One folder in GET /api/fs/list. `name` is sanitized (display only); `path` is the raw absolute path used for navigation and /open. */
export interface FsEntry {
  name: string;
  path: string;
  isRepo: boolean;
}

/** Body of GET /api/fs/list. `display` is the host path shown to the user (sanitized). */
export interface FsListResult {
  path: string;
  display: string;
  parent: string | null;
  entries: FsEntry[];
  roots: { path: string; display: string }[];
  truncated: boolean;
}

export interface TabsState {
  tabs: RepoInfo[];
  activeId: string | null;
}

export interface ApiError {
  error: string;
}

export const TOKEN_HEADER = 'X-GitSlappin-Token';

export * from './branchName';
export * from './diff';
export * from './git';
export * from './graph';
export * from './identicon';
export { buildPatch } from './patch';
export { wordDiff, wordDiffHunk, type Seg } from './wordDiff';
export * from './merge3';
export * from './mergeTool';
