import { useSyncExternalStore } from 'react';

/** The file lists show paths ("list") or folders ("tree"). One choice for the whole window; the status bar and the panels share it. */
export type ListMode = 'path' | 'tree';

let current: ListMode = 'path';
const listeners = new Set<() => void>();

export function setListMode(m: ListMode): void {
  if (m === current) return;
  current = m;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useListMode(): [ListMode, (m: ListMode) => void] {
  return [useSyncExternalStore(subscribe, () => current), setListMode];
}
