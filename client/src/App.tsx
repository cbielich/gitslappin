import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefsInfo } from '@gitslappin/shared';
import { api } from './api';
import { ActivityLog } from './components/ActivityLog';
import { CommandPalette, type PaletteMode } from './components/CommandPalette';
import { KeyBindingsModal } from './components/KeyBindingsModal';
import { MenuBar } from './components/MenuBar';
import { OpenRepoView } from './components/OpenRepoView';
import { Preferences } from './components/Preferences';
import { RepoView, type RepoViewHandle } from './components/RepoView';
import { TerminalHost, type TerminalHostHandle } from './components/TerminalHost';
import { StatusBar } from './components/StatusBar';
import { TabsBar } from './components/TabsBar';
import { TabsList } from './components/TabsList';
import { Toasts, type Toast } from './components/Toasts';
import { Toolbar, type RemoteToolbarState } from './components/Toolbar';
import { useAppearance } from './hooks/useAppearance';
import { useTabs } from './hooks/useTabs';
import { installShortcuts, registerShortcut } from './lib/shortcuts';

export function App() {
  const { tabs, activeId, loaded, showOpen, setShowOpen, addTab, selectTab, closeTab } = useTabs();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const onSaveError = useCallback((detail: string) => setToasts((t) => [...t, { id: ++toastId.current, title: 'Saving preferences failed', detail }]), []);
  const { theme, setTheme, zoom, zoomIn, zoomOut, zoomReset } = useAppearance(onSaveError);
  const [branch, setBranch] = useState<string | undefined>();
  const [refs, setRefs] = useState<RefsInfo | null>(null);
  const [remote, setRemote] = useState<RemoteToolbarState | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const repoRef = useRef<RepoViewHandle>(null);
  const active = tabs.find((t) => t.id === activeId);
  const openView = loaded && (showOpen || !active);
  const hasRepo = !openView && !!active;

  // V6: command palette, shortcuts list, tabs list, and what the server says about opening a terminal / folder.
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [tabsListOpen, setTabsListOpen] = useState(false);
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [terminalOk, setTerminalOk] = useState(false); // V6b: the server says the in-app terminal can run here (the server checks again on every call)
  const termRef = useRef<TerminalHostHandle>(null);
  const [openRequest, setOpenRequest] = useState<{ modal: 'clone' | 'init' } | null>(null);
  useEffect(() => {
    api
      .ping()
      .then((r) => {
        setDesktop(r.desktop === true);
        setTerminalOk(r.terminal === true);
      })
      .catch(() => setDesktop(false));
  }, []);
  useEffect(() => {
    if (!openView) setOpenRequest(null);
  }, [openView]);
  const closePalette = useCallback(() => setPalette(null), []);
  const closeKeys = useCallback(() => setKeysOpen(false), []);
  const closeTabsList = useCallback(() => setTabsListOpen(false), []);
  const addToast = useCallback((title: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, title, detail: '' }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  /** Error-OpenRepoInTerminalFailed. The server starts the program in the repo root; the client sends no path. */
  const openExternal = (kind: 'terminal' | 'folder') => {
    if (!hasRepo || !activeId) return false;
    void (kind === 'terminal' ? api.openTerminal(activeId) : api.openFolder(activeId)).catch(() => addToast(kind === 'terminal' ? 'Failed to open repo in terminal' : 'Failed to open the folder'));
    return true;
  };
  const toggleTerminal = () => {
    if (!hasRepo || !terminalOk) return false;
    termRef.current?.toggle();
    return true;
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };
  const askOpenView = (modal?: 'clone' | 'init') => {
    setShowOpen(true);
    if (modal) setOpenRequest({ modal });
  };
  const openRecent = (root: string) => {
    closePalette();
    api
      .openRepo(root)
      .then(addTab)
      .catch((e: unknown) => setToasts((t) => [...t, { id: ++toastId.current, title: 'Open failed', detail: e instanceof Error ? e.message : '' }]));
  };
  const runPalette = (id: string) => {
    closePalette();
    const r = repoRef.current;
    const map: Record<string, () => void> = {
      'activity-logs': () => setLogOpen(true),
      clone: () => askOpenView('clone'),
      'close-tab': () => void closeActive.current(),
      'create-annotated-tag': () => r?.createTag(true),
      'create-branch': () => r?.startCreateBranch(),
      'create-tag': () => r?.createTag(false),
      'zoom-out': zoomOut,
      'discard-all': () => r?.discardAll(),
      'fetch-all': () => r?.fetchAll(),
      'init-repo': () => askOpenView('init'),
      'zoom-in': zoomIn,
      'keyboard-shortcuts': () => setKeysOpen(true),
      'open-repo-management': () => askOpenView(),
      'open-terminal': () => void openExternal('terminal'),
      'open-folder': () => void openExternal('folder'),
      'rename-branch': () => r?.renameBranch(),
      'zoom-reset': zoomReset,
      'search-commits': () => r?.searchCommits(),
      settings: () => setPrefsOpen(true),
      'stage-all': () => r?.stageAll(),
      'stash-apply': () => r?.stashApply(false),
      'stash-create': () => r?.stash(),
      'stash-pop': () => r?.stashApply(true),
      'switch-theme': () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      'toggle-details-panel': () => r?.toggleDetails(),
      'toggle-left-panel': () => r?.toggleLeft(),
      'toggle-terminal-panel': () => void toggleTerminal(),
      'unstage-all': () => r?.unstageAll(),
      'view-wip': () => r?.viewWip(),
    };
    map[id]?.();
  };
  const runMenu = (id: string) => {
    const r = repoRef.current;
    const map: Record<string, () => void> = {
      NewTab: () => askOpenView(),
      CloneRepo: () => askOpenView('clone'),
      InitRepo: () => askOpenView('init'),
      OpenRepo: () => askOpenView(),
      OpenRepoManagement: () => askOpenView(),
      OpenTerminal: () => void openExternal('terminal'),
      OpenInFileManager: () => void openExternal('folder'),
      Preferences: () => setPrefsOpen(true),
      Undo: () => r?.undo(),
      Redo: () => r?.redo(),
      ToggleFullScreen: toggleFullscreen,
      ZoomIn: zoomIn,
      ZoomOut: zoomOut,
      ZoomReset: zoomReset,
      ShowLeftPanel: () => r?.toggleLeft(),
      ShowDetailPanel: () => r?.toggleDetails(),
      ShowTerminalPanel: () => void toggleTerminal(),
      ReloadWindow: () => window.location.reload(),
      KeyboardShortcuts: () => setKeysOpen(true),
      OpenFuzzyFinder: () => setPalette('commands'),
      ViewActivityLogs: () => setLogOpen(true),
    };
    map[id]?.();
  };
  const menuDisabled = new Set<string>();
  if (!hasRepo) ['OpenTerminal', 'OpenInFileManager', 'Undo', 'Redo', 'ShowLeftPanel', 'ShowDetailPanel', 'ViewActivityLogs'].forEach((x) => menuDisabled.add(x));
  if (!hasRepo || !terminalOk) menuDisabled.add('ShowTerminalPanel');
  if (desktop === false) ['OpenTerminal', 'OpenInFileManager'].forEach((x) => menuDisabled.add(x));
  const toolbarBusy = !remote || remote.busy || remote.remoteBusy || remote.opActive;
  if (!remote?.undoLabel || toolbarBusy) menuDisabled.add('Undo');
  if (!remote?.redoLabel || toolbarBusy) menuDisabled.add('Redo');

  // One keydown listener for the whole window (lib/shortcuts.ts); this screen owns the tab and zoom keys.
  const closeActive = useRef<() => boolean>(() => false);
  closeActive.current = () => {
    if (!activeId || openView) return false; // the Open view is showing: no repo tab is on screen to close
    closeTab(activeId);
    return true;
  };
  // V6 shortcuts: the handlers are read through a ref, so they always see the latest tabs and state.
  const keys = useRef({ tabs, activeId, hasRepo, selectTab, openExternal, toggleFullscreen, toggleTerminal });
  keys.current = { tabs, activeId, hasRepo, selectTab, openExternal, toggleFullscreen, toggleTerminal };
  useEffect(() => {
    const step = (d: number) => () => {
      const { tabs: ts, activeId: cur, selectTab: pick } = keys.current;
      if (ts.length === 0) return false;
      const i = ts.findIndex((t) => t.id === cur);
      const next = ts[(i + d + ts.length) % ts.length];
      if (next) pick(next.id);
    };
    const nth = (n: number) => () => {
      const t = keys.current.tabs[n - 1];
      if (!t) return false;
      keys.current.selectTab(t.id);
    };
    const offs = [
      registerShortcut('palette', () => setPalette((p) => (p ? null : 'commands'))),
      registerShortcut('openRepoFinder', () => setPalette('open-repo')),
      registerShortcut('fileFinder', () => (keys.current.hasRepo ? setPalette('history') : false)),
      registerShortcut('nextTab', step(1)),
      registerShortcut('prevTab', step(-1)),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => registerShortcut(`tab${n}` as 'tab1', nth(n))),
      registerShortcut('tabsList', () => (keys.current.tabs.length > 0 ? setTabsListOpen(true) : false)),
      registerShortcut('fullScreen', () => keys.current.toggleFullscreen()),
      registerShortcut('keybindings', () => setKeysOpen((o) => !o)),
      registerShortcut('openTerminal', () => keys.current.openExternal('terminal')),
      registerShortcut('toggleTerminal', () => keys.current.toggleTerminal()),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  useEffect(() => {
    const offs = [
      registerShortcut('open', () => setShowOpen(true)),
      registerShortcut('newTab', () => setShowOpen(true)),
      registerShortcut('closeTab', () => closeActive.current()),
      registerShortcut('zoomIn', zoomIn),
      registerShortcut('zoomOut', zoomOut),
      registerShortcut('zoomReset', zoomReset),
    ];
    const uninstall = installShortcuts();
    return () => {
      offs.forEach((off) => off());
      uninstall();
    };
  }, [setShowOpen, zoomIn, zoomOut, zoomReset]);

  const closePrefs = useCallback(() => setPrefsOpen(false), []);

  return (
    <div className="app" data-testid="app">
      <MenuBar disabled={menuDisabled} onRun={runMenu} />
      <TabsBar
        tabs={tabs}
        activeId={openView ? null : activeId}
        onSelect={selectTab}
        onClose={closeTab}
        onAdd={() => setShowOpen(true)}
        onPreferences={() => setPrefsOpen(true)}
      />
      <Toolbar
        repoName={openView ? undefined : active?.name}
        branchName={openView ? undefined : branch}
        localBranches={openView ? undefined : refs?.local}
        onCheckoutLocal={(n) => repoRef.current?.checkoutLocal(n)}
        {...(!openView && remote ? { remote } : {})}
        onPull={() => repoRef.current?.pull()}
        onPickPullMode={(m) => repoRef.current?.pickPullMode(m)}
        onPush={() => repoRef.current?.push()}
        onStash={() => repoRef.current?.stash()}
        onPop={() => repoRef.current?.pop()}
        onUndo={() => repoRef.current?.undo()}
        onRedo={() => repoRef.current?.redo()}
        {...(!openView && refs?.headSha ? { onBranch: () => repoRef.current?.startCreateBranch() } : {})}
        onActions={() => setPalette('commands')}
        {...(hasRepo ? { onSearch: () => repoRef.current?.searchCommits() } : {})}
        {...(hasRepo && terminalOk ? { onTerminal: () => void toggleTerminal() } : {})}
      />
      <main className="main">
        {!loaded ? null : openView ? <OpenRepoView onOpened={addTab} request={openRequest} /> : active && <RepoView key={active.id} ref={repoRef} repo={active} onBranchChange={setBranch} onRefs={setRefs} onRemote={setRemote} />}
      </main>
      <TerminalHost ref={termRef} repoId={hasRepo ? activeId : null} openRepoIds={loaded ? tabs.map((t) => t.id) : null} theme={theme} onError={() => addToast('Failed to open repo in terminal')} onLost={() => addToast('Terminal connection lost')} />
      {logOpen && active && !openView && <ActivityLog repoId={active.id} onClose={() => setLogOpen(false)} />}
      <StatusBar zoom={zoom} logOpen={logOpen} {...(active && !openView ? { onToggleLog: () => setLogOpen((o) => !o) } : {})} />
      {prefsOpen && <Preferences theme={theme} onTheme={setTheme} onClose={closePrefs} />}
      {palette && (
        <CommandPalette
          mode={palette}
          hasRepo={hasRepo}
          repoId={hasRepo ? activeId : null}
          headSha={refs?.headSha ?? null}
          branches={(refs?.local ?? []).filter((b) => !b.current).map((b) => b.name)}
          onClose={closePalette}
          onMode={setPalette}
          onRun={runPalette}
          onCheckout={(n) => {
            closePalette();
            repoRef.current?.checkoutLocal(n);
          }}
          onOpenRepo={openRecent}
          onOpenFile={(path, blame) => {
            closePalette();
            repoRef.current?.openFileHistory(path, blame);
          }}
        />
      )}
      {keysOpen && <KeyBindingsModal onClose={closeKeys} />}
      {tabsListOpen && (
        <TabsList
          tabs={tabs}
          activeId={activeId}
          onSelect={(id) => {
            closeTabsList();
            selectTab(id);
          }}
          onClose={closeTabsList}
        />
      )}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
