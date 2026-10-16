import {
  TOKEN_HEADER,
  type ApiError,
  type AutoFetchResponse,
  type CloneRequest,
  type CloneStreamLine,
  type BlameResult,
  type BranchActionResult,
  type CommitDetail,
  type CompareResult,
  type DiffContents,
  type FileDiff,
  type FileHistoryPage,
  type GraphVisibility,
  type FsListResult,
  type InitRequest,
  type IntegrateResponse,
  type LocateResult,
  type LogPage,
  type MergeToolBackup,
  type MergeToolInfo,
  type Prefs,
  type PullMode,
  type RemoteInfo,
  type RemoteResponse,
  type RebasePlan,
  type RebaseStep,
  type RefsInfo,
  type RepoInfo,
  type SearchResult,
  type StashFiles,
  type StashResponse,
  type StatusSummary,
  type TabsState,
  type TemplateList,
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

/**
 * POST /api/repos/clone: NDJSON progress, then one of done / error / cancelled. Aborting `signal` cancels the clone (the server stops git).
 * A refusal (400/409) arrives as a normal error response and is thrown as an ApiRequestError.
 */
async function cloneStream(body: CloneRequest, onLine: (line: CloneStreamLine) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch('/api/repos/clone', {
    method: 'POST',
    headers: { [TOKEN_HEADER]: getToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data: unknown = await res.json().catch(() => ({}));
    const err = new ApiRequestError((data as Partial<ApiError>).error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const flush = (all: boolean): void => {
    const parts = pending.split('\n');
    pending = all ? '' : (parts.pop() ?? '');
    for (const p of parts) if (p.trim() !== '') onLine(JSON.parse(p) as CloneStreamLine);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    flush(false);
  }
  pending += decoder.decode();
  flush(true);
}

export const api = {
  openRepo: (path: string) => request<RepoInfo>('POST', '/api/repos/open', { path }),
  templates: () => request<TemplateList>('GET', '/api/repos/templates'),
  initRepo: (body: InitRequest) => request<RepoInfo>('POST', '/api/repos/init', body),
  cloneRepo: cloneStream,
  recent: () => request<RepoInfo[]>('GET', '/api/recent'),
  /** V6: `desktop` is true only on a Windows server bound to 127.0.0.1 (the open-terminal / open-folder routes answer 409 otherwise). */
  /** V6b: `terminal` is true when the in-app terminal can run here (Windows, 127.0.0.1, node-pty loaded); `terminalBash` when Git Bash is installed. For the UI only: the server checks again. */
  ping: () => request<{ app: string; pid: number; desktop?: boolean; terminal?: boolean; terminalBash?: boolean }>('GET', '/api/ping'),
  /** V6b: a single-use ticket (10 s) that is the credential of the terminal WebSocket. */
  terminalTicket: () => request<{ ticket: string }>('POST', '/api/terminal/ticket'),
  /** V6: the server starts the terminal / file manager in the repo root; no path is ever sent. */
  openTerminal: (id: string) => request<{ ok: true }>('POST', `/api/repos/${id}/open-terminal`),
  openFolder: (id: string) => request<{ ok: true }>('POST', `/api/repos/${id}/open-folder`),
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
  compare: (id: string, from: string, to: string | null) =>
    request<CompareResult>('GET', `/api/repos/${id}/compare?${new URLSearchParams({ from, ...(to === null ? { workdir: '1' } : { to }) }).toString()}`),
  visibility: (id: string) => request<GraphVisibility>('GET', `/api/repos/${id}/visibility`),
  putVisibility: (id: string, v: GraphVisibility) => request<GraphVisibility>('PUT', `/api/repos/${id}/visibility`, v),
  fileHistory: (id: string, sha: string, path: string, skip: number, limit = 100) =>
    request<FileHistoryPage>('GET', `/api/repos/${id}/file-history?${new URLSearchParams({ sha, path, skip: String(skip), limit: String(limit) }).toString()}`),
  blame: (id: string, sha: string, path: string) => request<BlameResult>('GET', `/api/repos/${id}/blame?${new URLSearchParams({ sha, path }).toString()}`),
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
  /** The quiet background fetch (V2): the body carries only auto:true. */
  fetchAuto: (id: string) => request<AutoFetchResponse>('POST', `/api/repos/${id}/fetch`, { auto: true }),
  addRemote: (id: string, body: { name: string; url: string; pushUrl?: string }) => request<RemoteResponse>('POST', `/api/repos/${id}/remote/add`, body),
  tagPush: (id: string, body: { name: string; sha: string; remote: string }) => request<RemoteResponse>('POST', `/api/repos/${id}/tag/push`, body),
  tagDelete: (id: string, body: { name: string; sha: string }) => request<RemoteResponse>('POST', `/api/repos/${id}/tag/delete`, body),
  tagDeleteRemote: (id: string, body: { name: string; sha: string; remote: string }) => request<RemoteResponse>('POST', `/api/repos/${id}/tag/delete-remote`, body),
  pull: (id: string, body: { mode: PullMode; branch?: string }) => request<RemoteResponse>('POST', `/api/repos/${id}/pull`, body),
  push: (id: string, body: { branch?: string; remote?: string; remoteBranch?: string; upstream?: boolean } = {}) => request<RemoteResponse>('POST', `/api/repos/${id}/push`, body),
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
  ignore: (id: string, body: { paths: string[]; mode: 'file' | 'ext' | 'folder'; untrack: boolean }) => request<{ outcome: 'done' | 'noop' }>('POST', `/api/repos/${id}/ignore`, body),
  /** V4: new message for a commit on HEAD's first-parent line (the commits above it are rebuilt). */
  reword: (id: string, body: { sha: string; expectHead: string; message: string }) => request<{ outcome: 'done'; sha?: string }>('POST', `/api/repos/${id}/reword`, body),
  /** V4: squash 2 or more consecutive commits of HEAD's first-parent line. */
  squash: (id: string, body: { shas: string[]; expectHead: string }) => request<{ outcome: 'done'; sha?: string }>('POST', `/api/repos/${id}/squash`, body),
  /** V4: the commits an interactive rebase would replay (newest first). children: target is a commit on HEAD's line; onto: a branch name or full sha. */
  rebasePlan: (id: string, mode: 'children' | 'onto', target: string) => request<RebasePlan>('GET', `/api/repos/${id}/rebase/interactive/plan?mode=${mode}&target=${encodeURIComponent(target)}`),
  /** V4: run an interactive rebase. steps are OLDEST FIRST. */
  rebaseInteractive: (id: string, body: { upstream: string; onto: string; expectHead: string; steps: RebaseStep[] }) => request<IntegrateResponse>('POST', `/api/repos/${id}/rebase/interactive`, body),
  /** V4: cherry pick several commits (oldest first). */
  cherryPickMulti: (id: string, body: { shas: string[]; expectHead: string }) => request<IntegrateResponse>('POST', `/api/repos/${id}/cherry-pick/multi`, body),
  cherryPickAbort: (id: string) => request<DestructiveResponse>('POST', `/api/repos/${id}/cherry-pick/abort`, {}),
  revertAbort: (id: string) => request<DestructiveResponse>('POST', `/api/repos/${id}/revert/abort`, {}),
};

/** Result of the phase 11 routes. `noop` = a cherry-pick or revert that changed nothing (skipped). `stash` = an auto-stash that was kept. */
export interface DestructiveResponse {
  outcome: 'done' | 'noop' | 'conflict';
  stash?: { message: string; sha?: string };
}
