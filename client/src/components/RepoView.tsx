import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { branchNameProblem, type IntegrateResponse, type PullMode,type RefsInfo, type RepoInfo, type StashResponse, type StatusSummary, type UndoStateInfo, type WipFile } from '@gitslappin/shared';
import { ApiRequestError, api, type DestructiveResponse } from '../api';
import { useGraph } from '../hooks/useGraph';
import { useRepoEvents, type RepoEventType } from '../hooks/useRepoEvents';
import { UNSTAGE_CHUNK, chunk } from '../lib/chunk';
import { diffTargetKey, type DiffTarget } from '../lib/diffTarget';
import { buildMenu, type MenuCtx, type MenuEntry } from '../lib/refMenu';
import { CommitDetails, type OpenFileHook } from './DetailsPanel';
import { displayStatus } from './FileList';
import { DiffView, type DiffAction } from './diff/DiffView';
import { GraphSearch } from './graph/GraphSearch';
import { GraphView, type MenuRequest, type ScrollTarget, type Selection } from './graph/GraphView';
import type { Pill } from './graph/refPills';
import { BranchPrompt } from './BranchPrompt';
import { ConfirmBar } from './ConfirmBar';
import { ConflictPanel } from './ConflictPanel';
import { MergeTool } from './merge/MergeTool';
import { ContextMenu } from './menu/ContextMenu';
import { RenamePrompt, TagPrompt } from './RefPrompts';
import { Sidebar } from './Sidebar';
import { StagingPanel } from './StagingPanel';
import { StashDetails } from './StashDetails';
import { Toasts, type Toast } from './Toasts';
import { UpstreamBar } from './UpstreamBar';
import type { RemoteToolbarState } from './Toolbar';
import { registerShortcut } from '../lib/shortcuts';

interface Props {
  repo: RepoInfo;
  onBranchChange?: (branch: string | undefined) => void;
  /** The latest refs (null when this view goes away), for the toolbar branch picker. */
  onRefs?: (refs: RefsInfo | null) => void;
  /** Gives later phases `refresh()` to call after each action (refs, working-tree status and graph). */
  ref?: Ref<RepoViewHandle>;
  /** What the toolbar needs for Pull and Push (null when this view goes away). */
  onRemote?: (s: RemoteToolbarState | null) => void;
}

export interface RepoViewHandle {
  refresh: () => void;
  /** Shows the inline new-branch input in the HEAD commit row. */
  startCreateBranch: () => void;
  checkoutLocal: (name: string) => void;
  /** The Pull button: runs the saved pull mode. */
  pull: () => void;
  /** A Pull menu item: runs it, and saves a pull mode as the default. */
  pickPullMode: (m: PullMode | 'fetch') => void;
  push: () => void;
  /** The toolbar Stash button: stashes every change (tracked and untracked) with git's own message. */
  stash: () => void;
  /** The toolbar Pop button: pops the newest stash. */
  pop: () => void;
  /** The toolbar Undo and Redo buttons. */
  undo: () => void;
  redo: () => void;
}

/** After a stage or unstage: where should an open diff of this file go? null = close it. */
function settleTarget(s: StatusSummary, t: DiffTarget, jump: boolean): DiffTarget | null {
  const f = s.files.find((x) => x.path === t.path);
  if (!f || t.source === 'commit' || t.source === 'stash') return null;
  const unstagedTarget = (): DiffTarget => ({ source: 'unstaged', path: f.path, ...(f.worktreeStatus === '?' ? { untracked: true } : {}), status: displayStatus(f, 'unstaged') });
  const stagedTarget = (): DiffTarget => ({ source: 'staged', path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: displayStatus(f, 'staged') });
  // Staging the last hunk or line of a side jumps to the other side's diff; a whole-file action just closes it.
  if (t.source === 'unstaged') return f.unstaged ? unstagedTarget() : jump && f.staged ? stagedTarget() : null;
  return f.staged ? stagedTarget() : jump && f.unstaged ? unstagedTarget() : null;
}

/** Toast title for the backup the merge tool stores before it writes (invented wording, no GitKraken key). */
const MERGE_BACKUP_TITLE = 'Backup of the previous file';

export function RepoView({ repo, onBranchChange, onRefs, ref, onRemote }: Props) {
  const graph = useGraph(repo.id);
  const [refs, setRefs] = useState<RefsInfo | null>(null);
  const [wip, setWip] = useState<StatusSummary | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const [matches, setMatches] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [diffNonce, setDiffNonce] = useState(0);
  /** The conflicted file open in the 3-pane merge tool (it takes over the centre and right area). */
  const [mergePath, setMergePath] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const working = useRef(false);
  const toastId = useRef(0);
  const amendPrefill = useRef<{ summary: string; description: string } | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const nonce = useRef(0);

  const branchCb = useRef(onBranchChange);
  branchCb.current = onBranchChange;
  const refsCb = useRef(onRefs);
  refsCb.current = onRefs;
  const refsReq = useRef(0);
  const statusReq = useRef(0);

  const loadRefs = useCallback(() => {
    const id = ++refsReq.current;
    api
      .refs(repo.id)
      .then((r) => {
        if (id !== refsReq.current) return;
        setRefs(r);
        refsCb.current?.(r);
        branchCb.current?.(r.branch ?? (r.detached ? 'HEAD (detached)' : undefined));
      })
      .catch(() => undefined);
  }, [repo.id]);

  const loadStatus = useCallback((): Promise<StatusSummary | null> => {
    const id = ++statusReq.current;
    return api
      .statusSummary(repo.id)
      .then((s) => {
        if (id === statusReq.current) setWip(s);
        return s;
      })
      .catch(() => null);
  }, [repo.id]);

  const { reload: reloadGraph } = graph;
  const closeMenuRef = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => {
    closeMenuRef.current(); // a menu built from old data must not stay open
    loadRefs();
    loadStatus();
    reloadGraph();
  }, [loadRefs, loadStatus, reloadGraph]);

  useEffect(() => {
    loadRefs();
    loadStatus();
    return () => {
      refsReq.current++;
      statusReq.current++;
      branchCb.current?.(undefined);
      refsCb.current?.(null);
    };
  }, [loadRefs, loadStatus]);

  // Refresh automatically when the window regains focus.
  useEffect(() => {
    const onFocus = () => {
      loadRefs();
      loadStatus();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadRefs, loadStatus]);

  // Live auto-refresh: events that arrive together are merged; they are dropped while an action of ours runs (it refreshes itself).
  // Only status, refs and the graph rows are re-read: never the commit box, an open diff or a menu.
  const { softReload } = graph;
  const liveFlags = useRef({ status: false, refs: false });
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(liveTimer.current), []);
  useRepoEvents(repo.id, (type: RepoEventType) => {
    if (type === 'off') return; // no watcher for this repo: refresh-on-focus stays the way
    if (working.current) return;
    if (type === 'refs' || type === 'head') liveFlags.current.refs = true;
    else liveFlags.current.status = true; // status and op
    if (type === 'op') liveFlags.current.refs = true;
    if (liveTimer.current) return;
    liveTimer.current = setTimeout(() => {
      liveTimer.current = undefined;
      const f = liveFlags.current;
      liveFlags.current = { status: false, refs: false };
      if (working.current) return;
      if (f.refs) {
        loadRefs();
        loadStatus();
        void softReload();
      } else if (f.status) {
        void loadStatus();
      }
    }, 50);
  });

  const { ensureLoaded } = graph;
  const jump = useCallback(
    async (sha: string) => {
      const idx = await ensureLoaded(sha);
      if (idx < 0) return;
      setSelected({ kind: 'commit', sha });
      setScrollTarget({ sha, nonce: ++nonce.current });
    },
    [ensureLoaded],
  );

  const viewChanges = useCallback(() => {
    setSelected({ kind: 'wip' });
    setScrollTarget({ sha: 'wip', nonce: ++nonce.current });
  }, []);

  const onOpenFile: OpenFileHook = useCallback((t) => setDiffTarget(t), []);
  const closeDiff = useCallback(() => setDiffTarget(null), []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  /** Failure toasts stay until dismissed; a success toast goes by itself. */
  const addToast = useCallback(
    (title: string, detail = '', autoDismiss = false) => {
      const id = ++toastId.current;
      setToasts((t) => [...t, { id, title, detail }]);
      if (autoDismiss) setTimeout(() => dismissToast(id), 6000);
    },
    [dismissToast],
  );

  const diffTargetRef = useRef(diffTarget);
  diffTargetRef.current = diffTarget;
  /** The open diff is being read again after a change: its stage buttons wait (a stale hunk must not be sent). */
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    if (!diffTarget) setReloading(false);
  }, [diffTarget]);
  const onDiffSettled = useCallback(() => setReloading(false), []);

  /** Re-reads the status, moves or closes the open diff, and makes it read its diff again. */
  const afterChange = useCallback(
    async (jump: boolean): Promise<void> => {
      const s = await loadStatus();
      const cur = diffTargetRef.current;
      const next = cur && s ? settleTarget(s, cur, jump) : cur;
      setReloading(next !== null);
      setDiffTarget(next);
      setDiffNonce((n) => n + 1);
    },
    [loadStatus],
  );

  /** One change at a time. A failure shows a toast (git's own output stays until dismissed) and re-reads the status. */
  const mutate = useCallback(
    async (failTitle: string, fn: () => Promise<unknown>): Promise<boolean> => {
      if (working.current) return false;
      working.current = true;
      setBusy(true);
      try {
        await fn();
        return true;
      } catch (e) {
        let detail = e instanceof ApiRequestError ? (e.detail ?? e.message) : e instanceof Error ? e.message : '';
        // A merge or rebase that failed after an auto-stash: the stash is kept; its name (GitKraken's StashMessage text) is shown.
        if (e instanceof ApiRequestError && e.stash) detail = `${detail}\n\n${e.stash}`;
        setToasts((t) => [...t, { id: ++toastId.current, title: failTitle, detail }]);
        // The files may have changed under the open diff (a stale hunk, a failed hook): read it again.
        await afterChange(false);
        return false;
      } finally {
        working.current = false;
        setBusy(false);
      }
    },
    [afterChange],
  );

  const pathsOf = (f: WipFile): string[] => (f.oldPath && f.oldPath !== f.path ? [f.oldPath, f.path] : [f.path]);

  const stageFile = (f: WipFile) =>
    void mutate('Staging paths failed', async () => {
      await api.stage(repo.id, [f.path]);
      await afterChange(false);
    });
  const unstageFile = (f: WipFile) =>
    void mutate('Unstaging paths failed', async () => {
      await api.unstage(repo.id, pathsOf(f));
      await afterChange(false);
    });
  const stageAll = () =>
    void mutate('Staging paths failed', async () => {
      await api.stageAll(repo.id);
      await afterChange(false);
    });
  const unstageAll = () => {
    const paths = [...new Set((wip?.files ?? []).filter((f) => f.staged).flatMap(pathsOf))];
    if (paths.length === 0) return;
    void mutate('Unstaging paths failed', async () => {
      // The server takes at most 10k paths per request; send them in pieces of 5k.
      for (const part of chunk(paths, UNSTAGE_CHUNK)) await api.unstage(repo.id, part);
      await afterChange(false);
    });
  };

  /** Stage File / Stage Hunk / lines from the open diff. */
  const onDiffAction = (a: DiffAction) => {
    const t = diffTarget;
    if (!t || t.source === 'commit' || t.source === 'stash') return;
    const side = t.source;
    const unstaging = side === 'staged';
    if (a.kind === 'file') {
      const paths = unstaging && t.oldPath && t.oldPath !== t.path ? [t.oldPath, t.path] : [t.path];
      void mutate(unstaging ? 'Unstaging paths failed' : 'Staging paths failed', async () => {
        await (unstaging ? api.unstage(repo.id, paths) : api.stage(repo.id, paths));
        await afterChange(false);
      });
      return;
    }
    void mutate(unstaging ? 'Unstaging selection failed' : 'Staging selection failed', async () => {
      await api.stageLines(repo.id, {
        source: side,
        path: t.path,
        ...(t.oldPath ? { oldPath: t.oldPath } : {}),
        ...(t.untracked ? { untracked: true } : {}),
        hunk: a.hunk,
        header: a.header,
        ...(a.kind === 'lines' ? { lines: a.lines } : {}),
      });
      await afterChange(true);
    });
  };

  const onAmend = (on: boolean) => {
    if (!on) {
      setAmend(false);
      // Take back the prefilled message, unless the user has edited it.
      const pre = amendPrefill.current;
      if (pre && pre.summary === summary && pre.description === description) {
        setSummary('');
        setDescription('');
      }
      amendPrefill.current = null;
      return;
    }
    setAmend(true); // the box flips at once; a failure below flips it back
    // Text the user already typed is never replaced: the HEAD message is only prefilled into an empty box.
    if (summary.trim() !== '' || description.trim() !== '') return;
    void mutate('Amend failed', async () => {
      const { message } = await api.headMessage(repo.id);
      const nl = message.indexOf('\n');
      const first = nl < 0 ? message : message.slice(0, nl);
      const rest = nl < 0 ? '' : message.slice(nl + 1).replace(/^\s*\n/, '');
      amendPrefill.current = { summary: first, description: rest };
      setSummary(first);
      setDescription(rest);
    }).then((ok) => {
      if (!ok) setAmend(false);
    });
  };

  const composedMessage = (): string => (description.trim() === '' ? summary : `${summary}\n\n${description}`);

  const doCommit = () => {
    const message = composedMessage();
    const wasAmend = amend;
    void mutate(wasAmend ? 'Amend failed' : 'Commit failed', async () => {
      await api.commitChanges(repo.id, message, wasAmend);
      setSummary('');
      setDescription('');
      setAmend(false);
      amendPrefill.current = null;
      refresh();
      // A staged diff that was open is stale now (its file was just committed): close or refresh it.
      await afterChange(false);
    });
  };

  // --- Branches (phase 5): checkout, inline create, context menus ---
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const [menu, setMenu] = useState<{ x: number; y: number; ctx: MenuCtx } | null>(null);
  const [creating, setCreating] = useState<{ rowSha: string; start?: string } | null>(null);
  const creatingRef = useRef(creating);
  creatingRef.current = creating;
  /** The typed name lives here, so a refresh (which redraws the graph rows) never loses it. */
  const [creatingName, setCreatingName] = useState('');
  const [prompt, setPrompt] = useState<{ exists: string; remote: string } | null>(null);

  const wipRef = useRef(wip);
  wipRef.current = wip;
  const commitsRef = useRef(graph.commits);
  commitsRef.current = graph.commits;
  const menuReq = useRef(0);
  const closeMenu = useCallback(() => {
    menuReq.current++;
    setMenu(null);
  }, []);
  closeMenuRef.current = closeMenu;
  const openMenu = useCallback(
    (x: number, y: number, req: MenuRequest) => {
      const id = ++menuReq.current;
      const merge = (commitsRef.current.find((c) => c.sha === req.sha)?.parents.length ?? 0) > 1;
      const ctx: MenuCtx = { ...req, head: { branch: refsRef.current?.branch ?? null }, inProgress: !!wipRef.current?.op, merge };
      const b = req.branch;
      // Fast-forward needs one question to the server (is HEAD an ancestor of the branch?). If the status has not
      // arrived yet, wait for it, so a stopped merge or rebase is never missed. Otherwise the menu shows at once.
      const needFf = !!b && !b.current && ctx.head.branch !== null && !ctx.inProgress;
      if (!needFf && wipRef.current) {
        setMenu({ x, y, ctx });
        return;
      }
      const status = wipRef.current ? Promise.resolve(wipRef.current) : loadStatus();
      const ff = needFf && b ? api.canFastForward(repo.id, b.name).then((r) => r.canFastForward, () => false) : Promise.resolve(false);
      void Promise.all([status, ff]).then(([s, canFastForward]) => {
        if (id !== menuReq.current) return;
        const inProgress = !!s?.op;
        setMenu({ x, y, ctx: { ...ctx, inProgress, canFastForward: canFastForward && !inProgress } });
      });
    },
    [repo.id, loadStatus],
  );

  const doCheckout = useCallback(
    (body: { kind: 'local' | 'remote'; name: string } | { kind: 'commit'; sha: string }) => {
      void mutate('Checkout Failed', async () => {
        try {
          await api.checkout(repo.id, body);
        } catch (e) {
          // A local branch of that name sits on another commit: ask for another name (never reset it).
          if (body.kind === 'remote' && e instanceof ApiRequestError && e.status === 409 && e.exists) {
            setPrompt({ exists: e.exists, remote: body.name });
            return;
          }
          throw e;
        }
        refresh();
      });
    },
    [mutate, repo.id, refresh],
  );

  const onPillOpen = useCallback(
    (p: Pill) => {
      if (p.current) return;
      if (p.localName) doCheckout({ kind: 'local', name: p.localName });
      else if (p.remoteNames[0]) doCheckout({ kind: 'remote', name: p.remoteNames[0] });
    },
    [doCheckout],
  );

  const startCreate = useCallback(
    async (rowSha: string, start?: string) => {
      setDiffTarget(null);
      const idx = await ensureLoaded(rowSha);
      if (idx >= 0) setScrollTarget({ sha: rowSha, nonce: ++nonce.current });
      setCreatingName('');
      setCreating({ rowSha, ...(start ? { start } : {}) });
    },
    [ensureLoaded],
  );

  const createBranch = useCallback(
    (name: string, start?: string) => {
      void mutate('Failed creating ref', async () => {
        await api.createBranch(repo.id, { name, ...(start ? { start } : {}), checkout: true });
        refresh();
      });
    },
    [mutate, repo.id, refresh],
  );

  const onCreateSubmit = useCallback(
    (name: string) => {
      const c = creatingRef.current;
      if (!c) return;
      // Another change is running: say so and keep the input open with the typed name.
      if (working.current) {
        addToast('Another operation is already in progress.'); // Error-AnotherOperationInProgress
        return;
      }
      setCreating(null);
      createBranch(name, c.start);
    },
    [createBranch, addToast],
  );
  const onCreateCancel = useCallback(() => setCreating(null), []);
  /** The prompt stays up until the branch exists (or the attempt failed and a toast says why). */
  const onPromptCreate = (name: string) => {
    const p = prompt;
    if (!p) return;
    void mutate('Failed creating ref', async () => {
      await api.createBranch(repo.id, { name, start: p.remote, checkout: true });
      refresh();
    }).then((ok) => {
      if (ok) setPrompt(null);
    });
  };

  const copy = (text: string | undefined) => {
    if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
  };
  /** Handlers for the menu items phase 5 owns. Later phases add theirs here (or register their own). */
  /** Merge / rebase: the server stashes first when needed and a conflict is a normal outcome, not an error. */
  /** The auto-stash of the merge or rebase that is running, so an abort can name it again. */
  const autoStash = useRef<string | null>(null);
  /** Whenever a response carries `stash`, a toast names it (done, conflict, up to date). Stays until dismissed. */
  const noteStash = (res: IntegrateResponse | undefined) => {
    if (!res?.stash) return;
    autoStash.current = res.outcome === 'conflict' ? res.stash.message : null; // remembered only while an op is stopped
    addToast('Stashing uncommitted changes', res.stash.message); // Rebasing-AutoStashLabel + the StashMessage text
  };
  const integrate = (failTitle: string, fn: () => Promise<IntegrateResponse>) =>
    void mutate(failTitle, async () => {
      const res = await fn();
      noteStash(res);
      refresh();
    });

  // --- Remotes (phase 7): fetch, pull, push, upstream ---
  const [pullMode, setPullMode] = useState<PullMode>('merge');
  const pullModeRef = useRef(pullMode);
  pullModeRef.current = pullMode;
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [upstream, setUpstream] = useState<{ branch: string; remotes: string[]; intent: 'push' | 'pull' | 'set'; mode?: PullMode } | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getPrefs()
      .then((p) => live && setPullMode(p.pullMode))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const NO_REMOTE = {
    fetch: 'There are no remotes to fetch from, would you like to add one?', // Error-FetchFailedNoRemote
    pull: 'There are no remotes to pull from, would you like to add one?', // Error-PullFailedNoRemote
    push: 'There are no remotes to push to, would you like to add one?', // Error-PushFailedNoRemote
  } as const;
  const bodyOf = (e: unknown): Record<string, unknown> => (e instanceof ApiRequestError && e.body ? e.body : {});
  const remotesOf = (e: unknown): string[] => {
    const r = bodyOf(e).remotes;
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
  };
  /** Runs one remote request: the toolbar shows its spinner, and nothing else changes until it is done. */
  const remoteOp = (failTitle: string, fn: () => Promise<void>) =>
    void mutate(failTitle, async () => {
      setRemoteBusy(true);
      try {
        await fn();
      } finally {
        setRemoteBusy(false);
      }
    });

  const doFetch = () =>
    remoteOp(`Fetch failed for '${repo.name}'`, async () => {
      try {
        await api.fetchAll(repo.id);
      } catch (e) {
        if (bodyOf(e).noRemote) return addToast(NO_REMOTE.fetch);
        throw e;
      }
      refresh();
    });

  const doPull = (mode: PullMode, branch?: string, setUp?: { remote: string; remoteBranch: string }) =>
    remoteOp('Pull Failed', async () => {
      try {
        if (setUp && branch) await api.setUpstream(repo.id, { branch, ...setUp });
        const res = await api.pull(repo.id, { mode, ...(branch ? { branch } : {}) });
        refresh();
        await afterChange(false);
        if (res.outcome === 'done') addToast('Pulled Successfully', '', true); // Notification-PulledSuccessfully
      } catch (e) {
        if (bodyOf(e).needsUpstream) return setUpstream({ branch: branch ?? refsRef.current?.branch ?? '', remotes: remotesOf(e), intent: 'pull', mode });
        if (bodyOf(e).noRemote) return addToast(NO_REMOTE.pull);
        throw e;
      }
    });

  const forcePushRef = useRef<(branch: string, expect: string) => void>(() => undefined);
  const doPush = (branch?: string, to?: { remote: string; remoteBranch: string }) =>
    remoteOp('Push Failed', async () => {
      const local = branch ?? refsRef.current?.branch ?? '';
      try {
        await api.push(repo.id, { ...(branch ? { branch } : {}), ...(to ?? {}) });
      } catch (e) {
        const b = bodyOf(e);
        if (b.needsUpstream) return setUpstream({ branch: local, remotes: remotesOf(e), intent: 'push' });
        if (b.noRemote) return addToast(NO_REMOTE.push);
        if (b.rejected === 'non-ff') {
          // A push git refused after the remote commit was already fetched can be forced (with a lease): ask first (phase 11).
          // Only when the rejected push went to the configured upstream (a custom remote/branch never gets the bar).
          if (!to && typeof b.expect === 'string' && b.fetchFirst !== true) return forcePushRef.current(local, b.expect);
          const target = typeof b.target === 'string' ? b.target : 'the remote branch';
          return addToast('Push Failed', `'${local}' is behind '${target}'. Update your branch by doing a Pull.`); // PromptForPush-LocalIsBehindRemote
        }
        throw e;
      }
      addToast('Pushed Successfully', '', true); // Notification-PushedSuccessfully
      refresh();
    });

  /** The Set Upstream menu item: needs the remote names first. */
  const startSetUpstream = (branch: string) =>
    remoteOp('Set Upstream', async () => {
      const remotes = (await api.remotes(repo.id)).map((r) => r.name);
      if (remotes.length === 0) return addToast(NO_REMOTE.push);
      setUpstream({ branch, remotes, intent: 'set' });
    });

  const submitUpstream = (remote: string, remoteBranch: string) => {
    const u = upstream;
    if (!u) return;
    setUpstream(null);
    if (u.intent === 'push') doPush(u.branch, { remote, remoteBranch });
    else if (u.intent === 'pull') doPull(u.mode ?? pullMode, u.branch, { remote, remoteBranch });
    else
      remoteOp('Set Upstream', async () => {
        await api.setUpstream(repo.id, { branch: u.branch, remote, remoteBranch });
        refresh();
      });
  };

  const pickPullMode = (m: PullMode | 'fetch') => {
    if (m === 'fetch') return doFetch();
    setPullMode(m);
    void api.putPrefs({ pullMode: m }).catch(() => undefined);
    doPull(m);
  };

  const detached = !!refs?.detached;
  const opActive = !!wip?.op;
  const canStash = !!wip && wip.total > 0 && !wip.op && !busy;
  const canPop = (refs?.stashes.length ?? 0) > 0 && !wip?.op && !busy;

  // --- Undo / redo (phase 10): the server keeps the journal; this only asks what the next step is and triggers it ---
  const [undoInfo, setUndoInfo] = useState<UndoStateInfo>({ undo: null, redo: null });
  useEffect(() => {
    if (busy) return; // read again once the running change is over, so the tooltip never shows before the buttons work
    let live = true;
    // Every change reloads refs or the status, so this follows them (a new action also empties the redo side).
    // (`undoInfo` keeps its old value while a change runs, so the buttons never look usable too early.)
    api
      .undoState(repo.id)
      .then((s) => live && setUndoInfo(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repo.id, refs, wip, busy]);
  const undoLabel = undoInfo.undo?.label ?? null;
  const redoLabel = undoInfo.redo?.label ?? null;
  useEffect(() => {
    onRemote?.({ pullMode, remoteBusy, busy, detached, opActive, canStash, canPop, undoLabel, redoLabel });
  }, [onRemote, pullMode, remoteBusy, busy, detached, opActive, canStash, canPop, undoLabel, redoLabel]);
  useEffect(() => () => onRemote?.(null), [onRemote]);

  // --- Stash (phase 9) ---
  const STASH_CREATE_ERROR = 'Error Creating Stash'; // Error-CreatingStashError
  const STASH_APPLY_ERROR = 'Error Applying Stash'; // Error-ApplyingStashError
  // `keepOpen` (phase 11): `run` returns a promise and the bar stays up, buttons waiting, until the action is over.
  const [confirm, setConfirm] = useState<{ message: string; okLabel: string; run: () => void | Promise<unknown>; cancel?: () => void; kind?: string; detail?: string; keepOpen?: boolean } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const stashEntry = (sha: string) => refsRef.current?.stashes.find((s) => s.sha === sha);

  /** After a stash change: refs, graph and status again; a conflicted apply or pop opens the conflict screen. */
  const afterStash = async (res?: StashResponse) => {
    refresh();
    await afterChange(false);
    if (res?.conflict) viewChanges();
  };

  const doStash = () =>
    void mutate(STASH_CREATE_ERROR, async () => {
      await api.stash(repo.id, { fromTab: false });
      await afterStash();
    });

  const runApply = (sha: string, pop: boolean) =>
    void mutate(STASH_APPLY_ERROR, async () => {
      await afterStash(await api.stashApply(repo.id, sha, pop));
    });

  /** Apply or pop. A tree with changes asks first (Stash-ApplyWithUncommittedChangesPrompt). */
  const applyStash = (sha: string, pop: boolean) => {
    const w = wipRef.current;
    if (w && w.total > 0 && !w.op) setConfirm({ message: 'You have uncommitted changes. Are you sure you want to apply the stash on top of your changes?', okLabel: 'Yes', run: () => runApply(sha, pop) }); // YesButtonLabel
    else runApply(sha, pop);
  };

  const deleteStash = (sha: string) => {
    const s = stashEntry(sha);
    if (!s) return;
    setConfirm({
      message: `This is a destructive operation, are you sure you want to delete stash with message "${s.message}"?`, // ConfirmationMessage-DeleteStash
      okLabel: 'Delete', // DeleteButtonLabel
      run: () =>
        void mutate('Delete Stash', async () => {
          await api.stashDrop(repo.id, sha);
          await afterStash();
        }),
    });
  };

  /** The Stash tab: only the staged files. A file that is staged and also changed further asks first (Stash-PartialStashSelectedPath/Paths). */
  const stashFromTab = (message: string): Promise<boolean> => {
    const run = () =>
      mutate(STASH_CREATE_ERROR, async () => {
        await api.stash(repo.id, { message, fromTab: true });
        await afterStash();
      });
    const partial = (wipRef.current?.files ?? []).filter((f) => f.staged && f.unstaged);
    if (partial.length === 0) return run();
    const first = partial[0];
    return new Promise<boolean>((resolve) =>
      setConfirm({
        message:
          partial.length === 1 && first
            ? `This will stash all staged and unstaged changes in "${first.path}". Are you sure you want to stash all changes in the file?`
            : 'This will stash all staged and unstaged changes in the selected files. Are you sure you want to stash all selected files?',
        okLabel: 'Yes, Stash Changes', // StashChangesButtonLabel
        run: () => void run().then(resolve),
        cancel: () => resolve(false),
      }),
    );
  };

  // --- Destructive actions (phase 11): discard, reset, rename, delete, force push, tags, cherry-pick, revert ---
  /** Texts from en-us.json (ConfirmationMessage-*, PromptForPush-*, Notification-*, Error-*). */
  /** Long names are cut so a bar or toast stays readable (rendered as text only, never as markup). */
  const cut = (s: string): string => (s.length > 120 ? `${s.slice(0, 117)}...` : s);
  const D = {
    resetFile: (p: string) => `This will discard all staged and unstaged changes to "${cut(p)}". Are you sure you want to discard all changes to the file?`,
    resetFiles: 'This will discard all staged and unstaged changes to the selected files. Are you sure you want to discard all selected changes?',
    resetAll: 'This will discard all staged and unstaged changes, including new untracked files. Are you sure you want to discard all changes?',
    deleteRef: (n: string) => `This is a destructive operation, are you sure you want to delete "${cut(n)}"?`,
    deleteAllRefs: (n: string) => `This is a destructive operation, are you sure you want to delete "${cut(n)}" at this node, including remotes?`,
    forcePush: 'Force push is a destructive action and cannot be undone. Are you sure?', // PromptForPush-ConfirmForcePush
    remoteChanged: (b: string) => `Branch '${cut(b)}' has changed on the remote since the last fetch.`, // PromptForPush-RemoteChanged
    // GitKraken has no reset confirmation string: this follows its ConfirmationMessage-* pattern (build-notes, "Reset confirm (decision)").
    resetHard: (b: string) => `This is a destructive operation, are you sure you want to reset "${cut(b)}" to this commit? Uncommitted changes will be lost.`,
  };
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tagging, setTagging] = useState<{ sha: string; annotated: boolean } | null>(null);

  /**
   * After a destructive change: a kept auto-stash is named, then refs, graph and status are read again. The re-reading is not
   * awaited: the change itself is over, so the busy flag (and the Ctrl+Z key) must not wait for it.
   */
  const afterDestructive = (res?: DestructiveResponse): void => {
    if (res?.stash) addToast('Stashing uncommitted changes', res.stash.message); // Rebasing-AutoStashLabel + the StashMessage text
    refresh();
    void afterChange(false);
  };

  const runDiscard = (paths: string[]) =>
    mutate('Discarding selection failed', async () => {
      // Error-DiscardSelectionFailed
      await api.discard(repo.id, paths);
      await afterDestructive();
    });
  const askDiscard = (paths: string[]) => {
    if (paths.length === 0) return;
    const one = paths.length === 1;
    setConfirm({
      kind: one ? 'discard-file' : 'discard-files',
      message: one ? D.resetFile(paths[0] as string) : D.resetFiles,
      okLabel: one ? 'Reset File' : 'Reset Files', // ResetFileButtonLabel / ResetFilesButtonLabel
      run: () => runDiscard(paths),
      keepOpen: true,
    });
  };
  const askDiscardAll = () => {
    // Nested-repo entries (paths ending in "/") are not discardable: the server refuses them, so they stay out of the list.
    const paths = [...new Set((wipRef.current?.files ?? []).filter((f) => f.status !== 'U' && !f.path.endsWith('/')).map((f) => f.path))];
    if (paths.length === 0) return;
    setConfirm({ kind: 'discard-all', message: D.resetAll, okLabel: 'Reset All', run: () => runDiscard(paths), keepOpen: true }); // ResetAllButtonLabel
  };
  /** Discard Hunk: no confirm bar (accepted in the design); the server re-diffs and refuses a stale header. */
  const onDiscardHunk = (hunk: number, header: string) => {
    const t = diffTargetRef.current;
    if (!t || t.source !== 'unstaged') return;
    void mutate('Discarding selection failed', async () => {
      await api.discardHunk(repo.id, { path: t.path, hunk, header });
      afterDestructive();
    });
  };

  const runReset = (sha: string, mode: 'soft' | 'mixed' | 'hard') =>
    mutate('Reset Failed', async () => {
      // Error-ResetFailed
      await api.reset(repo.id, { sha, mode });
      await afterDestructive();
    });
  /** Soft and Mixed run at once. Hard asks first when anything uncommitted (or an untracked or ignored file in the way) would be lost. */
  const startReset = async (sha: string, mode: 'soft' | 'mixed' | 'hard') => {
    if (mode !== 'hard') return runReset(sha, mode);
    if (working.current) return;
    const branch = refsRef.current?.branch ?? '';
    let dirty = true; // when the question cannot be asked, ask the user
    try {
      dirty = (await api.resetCheck(repo.id, sha)).dirty;
    } catch {
      dirty = true;
    }
    if (!dirty) return runReset(sha, 'hard');
    setConfirm({ kind: 'reset-hard', message: D.resetHard(branch), okLabel: 'Reset', run: () => runReset(sha, 'hard'), keepOpen: true });
  };

  /** The prompt stays up until the branch is renamed (a failure shows a toast and keeps it, so the name can be changed). */
  const submitRename = (name: string, newName: string) => {
    void mutate('Rename Failed', async () => {
      // Error-RenameFailed
      await api.renameBranch(repo.id, { name, newName });
      refresh();
    }).then((ok) => {
      if (ok) setRenaming(null);
    });
  };

  const runDelete = (p: { name: string; expectSha: string; force: boolean; remote: boolean }): Promise<boolean> =>
    mutate(`Delete Failed: ${p.name}`, async () => {
      // Error-DeleteFailedWithName
      try {
        await api.deleteBranch(repo.id, { name: p.name, expectSha: p.expectSha, ...(p.force ? { force: true } : {}), ...(p.remote ? { remote: true } : {}) });
        await afterDestructive();
      } catch (e) {
        // git refused -d: show its own words and ask again; the second OK runs -D after the same sha check.
        if (e instanceof ApiRequestError && e.body?.unmerged === true && !p.force) {
          setConfirm({
            kind: 'delete-branch-force',
            message: p.remote ? D.deleteAllRefs(p.name) : D.deleteRef(p.name),
            detail: e.detail ?? e.message,
            okLabel: 'Delete', // DeleteButtonLabel
            run: () => runDelete({ ...p, force: true }),
            keepOpen: true,
          });
          return;
        }
        refresh(); // the local branch may be gone even though the remote part failed
        throw e;
      }
    });
  const askDelete = (name: string, remote: boolean) => {
    const b = refsRef.current?.local.find((l) => l.name === name);
    if (!b) return;
    const expectSha = b.sha;
    setConfirm({
      kind: remote ? 'delete-branch-remote' : 'delete-branch',
      message: remote ? D.deleteAllRefs(name) : D.deleteRef(name),
      okLabel: 'Delete',
      run: () => runDelete({ name, expectSha, force: false, remote }),
      keepOpen: true,
    });
  };

  /** A push git refused as non-fast-forward: the force bar, with the lease read at the time of the rejection (never refetched). */
  const askForcePush = (branch: string, expect: string) =>
    setConfirm({
      kind: 'force-push',
      message: `${D.remoteChanged(branch)} ${D.forcePush}`,
      okLabel: 'Force Push', // ForcePushWithLeaseButtonLabel
      keepOpen: true,
      run: () =>
        mutate('Push Failed', async () => {
          setRemoteBusy(true);
          try {
            await api.forcePush(repo.id, { branch, expect });
          } catch (e) {
            // The lease failed: the remote moved after the last fetch, and nothing was pushed.
            if (e instanceof ApiRequestError && bodyOf(e).leaseFailed === true) throw Object.assign(e, { detail: `${D.remoteChanged(branch)}\n\n${e.detail ?? ''}`.trim() });
            throw e;
          } finally {
            setRemoteBusy(false);
          }
          addToast('Pushed Successfully', '', true); // Notification-PushedSuccessfully
          refresh();
        }),
    });
  forcePushRef.current = askForcePush;

  /** The prompt stays up until the tag exists (a failure shows a toast and keeps it). */
  const submitTag = (sha: string, name: string, message?: string) => {
    void mutate('Failed creating ref', async () => {
      // Error-CreateRefFailed
      await api.createTag(repo.id, { name, sha, ...(message !== undefined ? { message } : {}) });
      refresh();
    }).then((ok) => {
      if (ok) setTagging(null);
    });
  };

  /** Cherry pick / revert: a conflict opens the conflict screen; an empty result says so; a kept auto-stash is named. */
  const pickOrRevert = (kind: 'cherry-pick' | 'revert', sha: string) =>
    void mutate(kind === 'cherry-pick' ? 'Cherry pick Failed' : 'Revert Failed', async () => {
      // Error-CherrypickFailed / Error-RevertFailed
      const res = await (kind === 'cherry-pick' ? api.cherryPick(repo.id, sha) : api.revert(repo.id, sha));
      if (res.stash) {
        autoStash.current = res.outcome === 'conflict' ? res.stash.message : null;
        // Goes by itself after 6 s (it would sit over the Abort button of the conflict screen); the stash stays in the STASHES list.
        addToast('Stashing uncommitted changes', res.stash.message, true);
      }
      refresh();
      await afterChange(false);
      if (res.outcome === 'conflict') return viewChanges();
      const title = kind === 'cherry-pick' ? 'Cherry pick Successful' : 'Revert Successful'; // Notification-CherrypickSuccessful / -RevertSuccessful
      const noop = kind === 'cherry-pick' ? 'However, the current branch already has all changes from the cherry picked commit.' : 'However, the current branch already has all changes from the reverted commit.'; // NotificationMessage-*WasNoop
      addToast(title, res.outcome === 'noop' ? noop : '', true);
    });

  const selectStash = useCallback(
    async (sha: string) => {
      const idx = await ensureLoaded(sha);
      setSelected({ kind: 'stash', sha });
      if (idx >= 0) setScrollTarget({ sha, nonce: ++nonce.current });
    },
    [ensureLoaded],
  );
  // The selected stash is gone (popped or deleted): drop the selection.
  const stashGone = selected?.kind === 'stash' && !!refs && !refs.stashes.some((s) => s.sha === selected.sha);
  useEffect(() => {
    if (stashGone) setSelected(null);
  }, [stashGone]);

  const menuHandlers = (ctx: MenuCtx): Record<string, () => void> => {
    const b = ctx.branch;
    return {
      'stash-apply': () => applyStash(ctx.sha, false),
      'stash-pop': () => applyStash(ctx.sha, true),
      'stash-delete': () => deleteStash(ctx.sha),
      pull: () => b && doPull('merge', b.name), // the menu item reads "Pull (fast-forward if possible)"
      push: () => b && doPush(b.name),
      'set-upstream': () => b && void startSetUpstream(b.name),
      merge: () => b && integrate('Merge Failed', () => api.merge(repo.id, { name: b.name })), // Error-MergeFailed
      'fast-forward': () => b && integrate('Merge Failed', () => api.merge(repo.id, { name: b.name, ffOnly: true })),
      rebase: () => b && integrate('Rebase Failed', () => api.rebase(repo.id, { name: b.name })), // Error-RebaseFailed
      'rebase-this-commit': () => integrate('Rebase Failed', () => api.rebase(repo.id, { sha: ctx.sha })),
      'checkout-branch': () => b && doCheckout({ kind: b.local ? 'local' : 'remote', name: b.name }),
      'checkout-commit-submenu': () => doCheckout({ kind: 'commit', sha: ctx.sha }),
      'checkout-commit': () => doCheckout({ kind: 'commit', sha: ctx.sha }),
      'create-branch-here': () => void startCreate(ctx.sha, ctx.sha),
      'copy-branch-name': () => copy(b?.name),
      'copy-commit-sha': () => copy(ctx.sha),
      // Phase 11
      'rename-branch': () => b && setRenaming(b.name),
      'delete-branch': () => b && askDelete(b.name, false),
      'delete-branch-remote': () => b && askDelete(b.name, true),
      'reset-soft': () => void startReset(ctx.sha, 'soft'),
      'reset-mixed': () => void startReset(ctx.sha, 'mixed'),
      'reset-hard': () => void startReset(ctx.sha, 'hard'),
      'cherry-pick': () => pickOrRevert('cherry-pick', ctx.sha),
      revert: () => pickOrRevert('revert', ctx.sha),
      'create-tag-here': () => setTagging({ sha: ctx.sha, annotated: false }),
      'create-annotated-tag': () => setTagging({ sha: ctx.sha, annotated: true }),
    };
  };

  /** The +N pill menu: one item per extra branch, each opening that branch's own menu (one level deep). */
  const menuEntries = (ctx: MenuCtx): MenuEntry[] => {
    // "Delete {0} and {1}" needs the upstream of the local branch.
    const withUpstream = (c: MenuCtx): MenuCtx => ({ ...c, upstream: c.branch?.local ? (refsRef.current?.local.find((l) => l.name === c.branch?.name)?.upstream ?? null) : null });
    if (!ctx.more) return buildMenu(withUpstream(ctx), menuHandlers(ctx));
    const noop = (): void => undefined;
    return ctx.more.flatMap((b): MenuEntry[] => {
      const { more: _more, ...rest } = ctx;
      const own: MenuCtx = { ...rest, target: 'pill', branch: b };
      const sub = buildMenu(withUpstream(own), menuHandlers(own)).flatMap((e): MenuEntry[] => {
        if (e.type === 'item' && e.submenu) return e.id === 'checkout' ? e.submenu.filter((x) => x.type === 'item' && x.id === 'checkout-branch') : [];
        return [e];
      });
      return sub.length > 0 ? [{ type: 'item', id: `more-${b.name}`, label: b.name, run: noop, submenu: sub }] : [];
    });
  };

  // --- Conflict screens (phase 6) ---
  const op = wip?.op;
  const opKey = op ? [op.kind, op.step ?? '', op.total ?? '', op.head, op.other ?? '', op.onto ?? ''].join('|') : '';
  const prefilled = useRef('');
  const opMessage = op?.message ?? '';
  useEffect(() => {
    if (!op) {
      if (prefilled.current !== '') {
        prefilled.current = '';
        setSummary('');
        setDescription('');
      }
      return;
    }
    if (prefilled.current === opKey) return;
    // Once per operation step: git's prepared message goes into the commit box.
    prefilled.current = opKey;
    const nl = opMessage.indexOf('\n');
    setSummary(nl < 0 ? opMessage : opMessage.slice(0, nl));
    setDescription(nl < 0 ? '' : opMessage.slice(nl + 1).replace(/^\s*\n/, ''));
    setAmend(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opKey, opMessage]);

  const doUndoRedo = (dir: 'undo' | 'redo') => {
    if (working.current) return;
    // One Undo/Redo toast at a time: the newest replaces the one still showing.
    setToasts((t) => t.filter((x) => !/^(Undo|Redo) /.test(x.title)));
    void mutate(dir === 'undo' ? 'Undo Failed' : 'Redo Failed', async () => {
      await (dir === 'undo' ? api.undo(repo.id) : api.redo(repo.id));
      addToast(dir === 'undo' ? 'Undo Successful' : 'Redo Successful', '', true); // UndoRedo-UndoSuccessful / -RedoSuccessful
      refresh();
      await afterChange(false);
    });
  };
  const undoKey = useRef<(dir: 'undo' | 'redo') => void>(() => undefined);
  undoKey.current = (dir) => {
    // Ignored while a change runs or a question is open (an open diff that is only reading itself again does not count).
    if (working.current || busy || remoteBusy || confirm || skipConfirm || opActive) return;
    // The server's journal is the truth (the toolbar copy may not have arrived yet); with nothing to do the key does nothing.
    void api
      .undoState(repo.id)
      .then((s) => {
        if (!(dir === 'undo' ? s.undo : s.redo) || working.current) return;
        doUndoRedo(dir);
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    // The shortcut registry keeps typing fields and the code editor out; anything open on top (menu, picker, confirm bar) is checked here.
    const make = (dir: 'undo' | 'redo') => (e: KeyboardEvent) => {
      if (document.querySelector('[data-testid="context-menu"], .confirm-bar, .branch-picker, .pull-menu, [role="menu"], [role="dialog"], [role="alertdialog"]')) return false;
      if (!e.repeat) undoKey.current(dir); // a held key runs one step, not a series
      return true;
    };
    const offs = [registerShortcut('undo', make('undo')), registerShortcut('redo', make('redo'))];
    return () => offs.forEach((off) => off());
  }, []);

  const [skipConfirm, setSkipConfirm] = useState(false);
  useEffect(() => {
    if (!skipConfirm) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSkipConfirm(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [skipConfirm]);
  useEffect(() => {
    if (!op) {
      setSkipConfirm(false);
      autoStash.current = null; // the op ended: its auto-stash is no longer "the one to name again"
    }
  }, [op]);

  const markResolved = (paths: string[]) =>
    void mutate('Staging paths failed', async () => {
      await api.stage(repo.id, paths); // only the conflicted paths, never add -A
      await afterChange(false);
    });
  const abortOp = () => {
    const kind = op?.kind;
    // Abort goes by the kind of the stopped operation. A stash conflict has nothing to abort.
    if (kind !== 'merge' && kind !== 'rebase' && kind !== 'cherry-pick' && kind !== 'revert') return;
    const failTitle = { merge: 'Abort Merge Failed', rebase: 'Abort Rebase Failed', 'cherry-pick': 'Abort Cherry-pick Failed', revert: 'Abort Revert Failed' }[kind];
    void mutate(failTitle, async () => {
      if (kind === 'cherry-pick' || kind === 'revert') {
        // The server pops the auto-stash back when the tree is clean after the abort; a stash it kept comes back in the response.
        const res = await (kind === 'cherry-pick' ? api.cherryPickAbort(repo.id) : api.revertAbort(repo.id));
        if (res.stash) addToast('Stashing uncommitted changes', res.stash.message, true);
      } else {
        await (kind === 'rebase' ? api.rebaseAbort(repo.id) : api.mergeAbort(repo.id));
        // The auto-stash made when this merge or rebase started is still in the stash list: name it again.
        if (autoStash.current) addToast('Stashing uncommitted changes', autoStash.current, true);
      }
      autoStash.current = null;
      setSummary('');
      setDescription('');
      refresh();
      await afterChange(false);
    });
  };
  const continueRebase = () => {
    const message = composedMessage();
    void mutate('Rebase Skip/Continue Failed', async () => {
      await api.rebaseContinue(repo.id, message.trim() === '' ? undefined : message, op?.step);
      setSummary('');
      setDescription('');
      refresh();
      await afterChange(false);
    });
  };
  const skipCommit = () => {
    setSkipConfirm(false);
    void mutate('Rebase Skip/Continue Failed', async () => {
      await api.rebaseSkip(repo.id);
      setSummary('');
      setDescription('');
      refresh();
      await afterChange(false);
    });
  };

  const onMatches = useCallback((shas: string[]) => setMatches(new Set(shas)), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  useEffect(() => {
    // Ctrl+F does nothing inside the code editor (the registry skips it there).
    const offs = [
      registerShortcut('find', () => {
        setSearchOpen(true);
        setFocusNonce((n) => n + 1);
      }),
      registerShortcut('filter', () => {
        setCollapsed(false);
        setTimeout(() => filterRef.current?.focus(), 0);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      refresh,
      startCreateBranch: () => {
        const head = refsRef.current?.headSha;
        if (head) void startCreate(head);
      },
      checkoutLocal: (name: string) => doCheckout({ kind: 'local', name }),
      pull: () => doPull(pullModeRef.current),
      pickPullMode,
      push: () => doPush(),
      stash: doStash,
      undo: () => undoKey.current('undo'),
      redo: () => undoKey.current('redo'),
      pop: () => {
        const top = refsRef.current?.stashes[0];
        if (top) applyStash(top.sha, true);
      },
    }),
  );

  // The merge or rebase is over (aborted, committed): the merge tool has nothing left to resolve.
  useEffect(() => {
    if (wip && !wip.op) setMergePath(null);
  }, [wip]);

  const wipTotal = wip?.total ?? 0;
  // The tree became clean while the WIP row was selected: its row is gone, so drop the selection.
  useEffect(() => {
    if (wip && wipTotal === 0 && !wip.op && selected?.kind === 'wip') setSelected(null);
  }, [wip, wipTotal, selected]);
  return (
    <div className="columns" data-testid="repo-view" data-repo-id={repo.id}>
      <Sidebar repoId={repo.id} refs={refs} collapsed={collapsed} rail={diffTarget !== null} hidden={mergePath !== null} onToggleCollapse={() => setCollapsed((c) => !c)} filterRef={filterRef} onJump={(sha) => void jump(sha)} onSelectStash={(sha) => void selectStash(sha)} onMenu={openMenu} onCheckout={(kind, name) => doCheckout({ kind, name })} />
      <section className="center-panel" data-testid="center-panel" style={mergePath ? { display: 'none' } : undefined}>
        {searchOpen && !diffTarget && <GraphSearch repoId={repo.id} focusNonce={focusNonce} onJump={(sha) => void jump(sha)} onMatches={onMatches} onClose={closeSearch} />}
        {/* Stays mounted while a diff is open so scroll position and loaded pages survive. */}
        <div className={`graph-wrap${diffTarget ? ' hidden' : ''}`}>
        <GraphView
          rows={graph.rows}
          commits={graph.commits}
          hasMore={graph.hasMore}
          loading={graph.loading}
          error={graph.error}
          loadMore={graph.loadMore}
          onRetry={graph.retry}
          indexOf={graph.indexOf}
          wip={wip}
          headSha={refs?.headSha ?? null}
          selected={selected}
          onSelect={setSelected}
          matches={matches}
          scrollTarget={scrollTarget}
          wipMessage={summary}
          onWipMessage={setSummary}
          onMenu={openMenu}
          onPillOpen={onPillOpen}
          creatingSha={creating?.rowSha ?? null}
          creatingName={creatingName}
          onCreateName={setCreatingName}
          onCreateSubmit={onCreateSubmit}
          onCreateCancel={onCreateCancel}
        />
        </div>
        {diffTarget && (
          <DiffView
            key={diffTargetKey(diffTarget)}
            repoId={repo.id}
            target={diffTarget}
            onClose={closeDiff}
            refreshKey={diffNonce}
            busy={busy || reloading}
            onSettled={onDiffSettled}
            {...(diffTarget.source === 'staged' || diffTarget.source === 'unstaged' ? { onAction: onDiffAction } : {})}
            {...(diffTarget.source === 'unstaged' && !diffTarget.untracked ? { onDiscardHunk } : {})}
          />
        )}
        {prompt && <BranchPrompt exists={prompt.exists} onCreate={onPromptCreate} onCancel={() => setPrompt(null)} />}
        {renaming && <RenamePrompt key={renaming} name={renaming} onSubmit={(n) => submitRename(renaming, n)} onCancel={() => setRenaming(null)} />}
        {tagging && <TagPrompt key={`${tagging.sha}${tagging.annotated}`} annotated={tagging.annotated} onSubmit={(n, m) => submitTag(tagging.sha, n, m)} onCancel={() => setTagging(null)} />}
      </section>
      {mergePath && (
        <MergeTool
          key={mergePath}
          repoId={repo.id}
          path={mergePath}
          onClose={() => setMergePath(null)}
          onSaved={async (backup) => {
            if (backup) addToast(MERGE_BACKUP_TITLE, backup, true);
            refresh();
            await loadStatus();
            setMergePath(null);
          }}
        />
      )}
      <aside className="right-panel" data-testid="right-panel" style={mergePath ? { display: 'none' } : undefined}>
        {selected?.kind === 'commit' && (
          <CommitDetails repoId={repo.id} sha={selected.sha} wipTotal={wipTotal} onViewChanges={viewChanges} onOpenFile={onOpenFile} onJump={(sha) => void jump(sha)} />
        )}
        {selected?.kind === 'stash' && refs?.stashes.find((s) => s.sha === selected.sha) && (
          <StashDetails key={selected.sha} repoId={repo.id} stash={refs.stashes.find((s) => s.sha === selected.sha)!} onOpenFile={onOpenFile} />
        )}
        {selected?.kind === 'wip' && wip && wip.op && (
          <ConflictPanel
            wip={wip}
            op={wip.op}
            summary={summary}
            description={description}
            busy={busy}
            onSummary={setSummary}
            onDescription={setDescription}
            onOpenFile={onOpenFile}
            onOpenMerge={setMergePath}
            onMarkResolved={markResolved}
            onCommit={doCommit}
            onContinue={continueRebase}
            onSkip={() => setSkipConfirm(true)}
            onAbort={abortOp}
          />
        )}
        {selected?.kind === 'wip' && wip && !wip.op && (
          <StagingPanel
            wip={wip}
            branch={refs?.branch ?? 'HEAD'}
            summary={summary}
            description={description}
            amend={amend}
            busy={busy}
            onSummary={setSummary}
            onDescription={setDescription}
            onAmend={onAmend}
            onOpenFile={onOpenFile}
            onStageFile={stageFile}
            onUnstageFile={unstageFile}
            onStageAll={stageAll}
            onUnstageAll={unstageAll}
            onCommit={doCommit}
            onStash={stashFromTab}
            onDiscard={askDiscard}
            onDiscardAll={askDiscardAll}
          />
        )}
      </aside>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.ctx)} onClose={closeMenu} />}
      {upstream && <UpstreamBar key={upstream.branch + upstream.intent} branch={upstream.branch} remotes={upstream.remotes} onSubmit={submitUpstream} onCancel={() => setUpstream(null)} />}
      {confirm && (
        <ConfirmBar
          message={confirm.message}
          okLabel={confirm.okLabel}
          {...(confirm.kind ? { kind: confirm.kind } : {})}
          {...(confirm.detail ? { detail: confirm.detail } : {})}
          busy={confirmBusy}
          onOk={() => {
            const cur = confirm;
            if (!cur.keepOpen) {
              setConfirm(null);
              void cur.run();
              return;
            }
            // The bar stays until the action is over; a second question that the action raised itself (git refused -d) is kept.
            setConfirmBusy(true);
            void Promise.resolve(cur.run()).finally(() => {
              setConfirmBusy(false);
              setConfirm((c) => (c === cur ? null : c));
            });
          }}
          onCancel={() => {
            setConfirm(null);
            confirm.cancel?.();
          }}
        />
      )}
      {skipConfirm && (
        <div className="confirm-bar" data-testid="skip-confirm" role="alertdialog">
          <span>This is a destructive operation, are you sure you want to skip this commit?</span>
          <button className="confirm-ok" data-testid="skip-confirm-ok" onClick={skipCommit}>
            Skip Commit
          </button>
          <button className="confirm-cancel" data-testid="skip-confirm-cancel" onClick={() => setSkipConfirm(false)}>
            Cancel
          </button>
        </div>
      )}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
