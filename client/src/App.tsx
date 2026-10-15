import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefsInfo } from '@gitslappin/shared';
import { ActivityLog } from './components/ActivityLog';
import { MenuBar } from './components/MenuBar';
import { OpenRepoView } from './components/OpenRepoView';
import { Preferences } from './components/Preferences';
import { RepoView, type RepoViewHandle } from './components/RepoView';
import { StatusBar } from './components/StatusBar';
import { TabsBar } from './components/TabsBar';
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

  // One keydown listener for the whole window (lib/shortcuts.ts); this screen owns the tab and zoom keys.
  const closeActive = useRef<() => boolean>(() => false);
  closeActive.current = () => {
    if (!activeId || openView) return false; // the Open view is showing: no repo tab is on screen to close
    closeTab(activeId);
    return true;
  };
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
      <MenuBar />
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
      />
      <main className="main">
        {!loaded ? null : openView ? <OpenRepoView onOpened={addTab} /> : active && <RepoView key={active.id} ref={repoRef} repo={active} onBranchChange={setBranch} onRefs={setRefs} onRemote={setRemote} />}
      </main>
      {logOpen && active && !openView && <ActivityLog repoId={active.id} onClose={() => setLogOpen(false)} />}
      <StatusBar zoom={zoom} logOpen={logOpen} {...(active && !openView ? { onToggleLog: () => setLogOpen((o) => !o) } : {})} />
      {prefsOpen && <Preferences theme={theme} onTheme={setTheme} onClose={closePrefs} />}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
