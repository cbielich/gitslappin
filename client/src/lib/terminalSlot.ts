import { useSyncExternalStore } from 'react';

/**
 * Where the terminal panel is drawn: a slot at the bottom of the graph column (GitKraken screen 33), so the panel sits between the left sidebar and
 * the right details panel. RepoView registers its slot element; TerminalHost (which lives at App level to keep every repo's sessions) portals into it.
 */
let slot: HTMLElement | null = null;
const subs = new Set<() => void>();

export function setTerminalSlot(el: HTMLElement | null): void {
  if (slot === el) return;
  slot = el;
  for (const f of subs) f();
}

export function useTerminalSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => slot,
  );
}
