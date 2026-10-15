import {
  TOKEN_HEADER,
  type ApiError,
  type BranchActionResult,
  type CommitDetail,
  type DiffContents,
  type FileDiff,
  type FsListResult,
  type IntegrateResponse,
  type LocateResult,
  type LogPage,
  type MergeToolBackup,
  type MergeToolInfo,
  type Prefs,
  type PullMode,
  type RemoteInfo,
  type RemoteResponse,
  type RefsInfo,
  type RepoInfo,
  type SearchResult,
  type StashFiles,
  type StashResponse,
  type StatusSummary,
  type TabsState,
  type TreeListing,
  type UndoStateInfo,
} from '@gitslappin/shared';

import { diffQuery, type DiffTarget } from './lib/diffTarget';

const STORAGE_KEY = 'gitslappin-token';

function getToken(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    sessionStorage.setItem(STORAGE_KEY, fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  return sessionStorage.getItem(STORAGE_KEY) ?? '';
}

export class ApiRequestError extends Error {
  /** git's own output for a failed action (stderr), when the server sent it. */
  detail?: string;
  /** HTTP status of the failed request. */
  status?: number;
  /** Set by POST checkout (409): the local branch that already exists. */
  exists?: string;
  /** Set by merge / rebase failures: the auto-stash that was created and kept. */
  stash?: string;
  /** The whole error body (already scrubbed by the server): needsUpstream, remotes, rejected, noRemote, detached, opInProgress, ... */
  body?: Record<string, unknown>;
}

/** One row of GET command-log. */
export interface CommandLogEntry {
  seq: number;
  at: number;
  args: string[];
  code: number;
  durationMs: number;
}

/** Body of POST stage-lines. `lines` are indexes into the hunk's lines; left out = the whole hunk. */
export interface StageLinesBody {
  source: 'unstaged' | 'staged';
  path: string;
  oldPath?: string;
  untracked?: boolean;
  hunk: number;
  header: string;
  lines?: number[];
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { [TOKEN_HEADER]: getToken() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiRequestError((data as Partial<ApiError>).error ?? `Request failed (${res.status})`);
    const stderr = (data as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string') err.detail = stderr;
    err.status = res.status;
    if (typeof data === 'object' && data !== null) err.body = data as Record<string, unknown>;
    const exists = (data as { exists?: unknown }).exists;
    if (typeof exists === 'string') err.exists = exists;
    const stash = (data as { stash?: { message?: unknown } }).stash?.message;
    if (typeof stash === 'string') err.stash = stash;
    throw err;
  }
  return data as T;
}

export const api = {
  openRepo: (path: string) => request<RepoInfo>('POST', '/api/repos/open', { path }),
  recent: () => request<RepoInfo[]>('GET', '/api/recent'),
  fsList: (path?: string) => request<FsListResult>('GET', `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  getTabs: () => request<TabsState>('GET', '/api/tabs'),
  putTabs: (state: TabsState) => request<{ ok: true }>('PUT', '/api/tabs', state),
  log: (id: string, skip: number, limit = 500) => request<LogPage>('GET', `/api/repos/${id}/log?skip=${skip}&limit=${limit}`),
  locate: (id: string, sha: string) => request<LocateResult>('GET', `/api/repos/${id}/locate/${encodeURIComponent(sha)}`),
  commitTree: (id: string, sha: string) => request<TreeListing>('GET', `/api/repos/${id}/commit/${encodeURIComponent(sha)}/tree`),
  refs: (id: string) => request<RefsInfo>('GET', `/api/repos/${id}/refs`),
  commit: (id: string, sha: string) => request<CommitDetail>('GET', `/api/repos/${id}/commit/${encodeURIComponent(sha)}`),
  search: (id: string, q: string) => request<SearchResult>('GET', `/api/repos/${id}/search?q=${encodeURIComponent(q)}`),
  diff: (id: string, t: DiffTarget, extra: { full?: boolean; ws?: boolean } = {}) =>
    request<FileDiff>('GET', `/api/repos/${id}/diff?${diffQuery(t, extra)}`),
  diffContents: (id: string, t: DiffTarget) => request<DiffContents>('GET', `/api/repos/${id}/diff/contents?${diffQuery(t)}`),
  statusSummary: (id: string) => request<StatusSummary>('GET', `/api/repos/${id}/status-summary`),
  stage: (id: string, paths: string[]) => request<{ ok: true }>('POST', `/api/repos/${id}/stage`, { paths }),
  stageAll: (id: string) => request<{ ok: true }>('POST', `/api/repos/${id}/stage`, { all: true }),
  unstage: (id: string, paths: string[]) => request<{ ok: true }>('POST', `/api/repos/${id}/unstage`, { paths }),
  stageLines: (id: string, body: StageLinesBody) => request<{ ok: true }>('POST', `/api/repos/${id}/stage-lines`, body),
  headMessage: (id: string) => request<{ message: string }>('GET', `/api/repos/${id}/head-message`),
  checkout: (id: string, body: { kind: 'local' | 'remote'; name: string } | { kind: 'commit'; sha: string }) =>
    request<BranchActionResult>('POST', `/api/repos/${id}/checkout`, body),
  createBranch: (id: string, body: { name: string; start?: string; checkout: boolean }) => request<BranchActionResult>('POST', `/api/repos/${id}/branch`, body),
  merge: (id: string, body: { name: string; ffOnly?: boolean }) => request<IntegrateResponse>('POST', `/api/repos/${id}/merge`, body),
  rebase: (id: string, body: { name: string } | { sha: string }) => request<IntegrateResponse>('POST', `/api/repos/${id}/rebase`, body),
  /** `step` is the rebase step the user was looking at; the server refuses (409) when the rebase has moved on. */
  rebaseContinue: (id: string, message?: string, step?: number) =>
    request<IntegrateResponse>('POST', `/api/repos/${id}/rebase/continue`, { ...(message === undefined ? {} : { message }), ...(step === undefined ? {} : { step }) }),
  rebaseSkip: (id: string) => request<IntegrateResponse>('POST', `/api/repos/${id}/rebase/skip`, {}),
  rebaseAbort: (id: string) => request<IntegrateResponse>('POST', `/api/repos/${id}/rebase/abort`, {}),
  mergeAbort: (id: string) => request<IntegrateResponse>('POST', `/api/repos/${id}/merge/abort`, {}),
  canFastForward: (id: string, name: string) => request<{ canFastForward: boolean }>('GET', `/api/repos/${id}/can-fast-forward?name=${encodeURIComponent(name)}`),
  remotes: (id: string) => request<RemoteInfo[]>('GET', `/api/repos/${id}/remotes`),
  fetchAll: (id: string) => request<RemoteResponse>('POST', `/api/repos/${id}/fetch`, {}),
  pull: (id: string, body: { mode: PullMode; branch?: string }) => request<RemoteResponse>('POST', `/api/repos/${id}/pull`, body),
  push: (id: string, body: { branch?: string; remote?: string; remoteBranch?: string } = {}) => request<RemoteResponse>('POST', `/api/repos/${id}/push`, body),
  setUpstream: (id: string, body: { branch: string; remote: string; remoteBranch: string }) => request<RemoteResponse>('POST', `/api/repos/${id}/upstream`, body),
  stash: (id: string, body: { message?: string; fromTab: boolean }) => request<StashResponse>('POST', `/api/repos/${id}/stash`, body),
  stashApply: (id: string, sha: string, pop: boolean) => request<StashResponse>('POST', `/api/repos/${id}/stash/apply`, { sha, pop }),
  stashDrop: (id: string, sha: string) => request<StashResponse>('POST', `/api/repos/${id}/stash/drop`, { sha }),
  stashFiles: (id: string, sha: string) => request<StashFiles>('GET', `/api/repos/${id}/stash/${encodeURIComponent(sha)}`),
  undoState: (id: string) => request<UndoStateInfo>('GET', `/api/repos/${id}/undo-state`),
  undo: (id: string) => request<{ label?: string }>('POST', `/api/repos/${id}/undo`),
  redo: (id: string) => request<{ label?: string }>('POST', `/api/repos/${id}/redo`),
  getPrefs: () => request<Prefs>('GET', '/api/prefs'),
  putPrefs: (body: Partial<Prefs>) => request<Prefs>('PUT', '/api/prefs', body),
  /** Git commands run for this repo after `after` (already scrubbed by the server). */
  commandLog: (id: string, after: number) => request<{ entries: CommandLogEntry[] }>('GET', `/api/repos/${id}/command-log?after=${after}`),
  mergeToolInfo: (id: string, path: string) => request<MergeToolInfo>('GET', `/api/repos/${id}/merge-tool?path=${encodeURIComponent(path)}`),
  mergeToolSave: (id: string, body: { path: string; text: string; expectHash: string }) => request<MergeToolBackup>('POST', `/api/repos/${id}/merge-tool/save`, body),
  mergeToolTake: (id: string, body: { path: string; side: 'a' | 'b'; expectHash: string }) => request<MergeToolBackup>('POST', `/api/repos/${id}/merge-tool/take`, body),
  mergeToolExternal: (id: string, path: string) => request<MergeToolBackup>('POST', `/api/repos/${id}/merge-tool/external`, { path }),
  commitChanges: (id: string, message: string, amend: boolean) => request<{ sha: string }>('POST', `/api/repos/${id}/commit`, { message, amend }),
  // Phase 11
  discard: (id: string, paths: string[]) => request<DestructiveResponse>('POST', `/api/repos/${id}/discard`, { paths }),
  discardHunk: (id: string, body: { path: string; hunk: number; header: string }) => request<DestructiveResponse>('POST', `/api/repos/${id}/discard-hunk`, body),
  resetCheck: (id: string, sha: string) => request<{ dirty: boolean }>('GET', `/api/repos/${id}/reset-check?sha=${encodeURIComponent(sha)}`),
  reset: (id: string, body: { sha: string; mode: 'soft' | 'mixed' | 'hard' }) => request<DestructiveResponse>('POST', `/api/repos/${id}/reset`, body),
  renameBranch: (id: string, body: { name: string; newName: string }) => request<DestructiveResponse>('POST', `/api/repos/${id}/branch/rename`, body),
  deleteBranch: (id: string, body: { name: string; expectSha: string; force?: boolean; remote?: boolean }) => request<DestructiveResponse>('POST', `/api/repos/${id}/branch/delete`, body),
  forcePush: (id: string, body: { branch: string; expect: string }) => request<DestructiveResponse>('POST', `/api/repos/${id}/push/force`, body),
  createTag: (id: string, body: { name: string; sha: string; message?: string }) => request<DestructiveResponse>('POST', `/api/repos/${id}/tag`, body),
  cherryPick: (id: string, sha: string) => request<DestructiveResponse>('POST', `/api/repos/${id}/cherry-pick`, { sha }),
  revert: (id: string, sha: string) => request<DestructiveResponse>('POST', `/api/repos/${id}/revert`, { sha }),
  cherryPickAbort: (id: string) => request<DestructiveResponse>('POST', `/api/repos/${id}/cherry-pick/abort`, {}),
  revertAbort: (id: string) => request<DestructiveResponse>('POST', `/api/repos/${id}/revert/abort`, {}),
};

/** Result of the phase 11 routes. `noop` = a cherry-pick or revert that changed nothing (skipped). `stash` = an auto-stash that was kept. */
export interface DestructiveResponse {
  outcome: 'done' | 'noop' | 'conflict';
  stash?: { message: string; sha?: string };
}
