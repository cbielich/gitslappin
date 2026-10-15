import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { RepoInfo } from '@gitslappin/shared';
import { api } from '../api';

export function useTabs() {
  const [tabs, setTabs] = useState<RepoInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showOpen, setShowOpen] = useState(false);

  useEffect(() => {
    api
      .getTabs()
      .then((s) => {
        setTabs(s.tabs);
        setActiveId(s.activeId);
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  // A layout effect, so the save is sent before the new tab's RepoView effects queue their requests and event stream:
  // the browser allows 6 connections per host, and behind those slow reads the save could still be waiting at a reload.
  useLayoutEffect(() => {
    if (loaded) api.putTabs({ tabs, activeId }).catch(() => undefined);
  }, [loaded, tabs, activeId]);

  const addTab = useCallback((repo: RepoInfo) => {
    setTabs((t) => (t.some((x) => x.id === repo.id) ? t : [...t, repo]));
    setActiveId(repo.id);
    setShowOpen(false);
  }, []);

  const selectTab = useCallback((id: string) => {
    setActiveId(id);
    setShowOpen(false);
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      const idx = tabs.findIndex((t) => t.id === id);
      const next = tabs.filter((t) => t.id !== id);
      setTabs(next);
      if (activeId === id) setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? null);
    },
    [tabs, activeId],
  );

  return { tabs, activeId, loaded, showOpen, setShowOpen, addTab, selectTab, closeTab };
}
