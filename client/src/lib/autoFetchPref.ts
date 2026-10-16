/** Tells the open repository view when the Auto-Fetch Interval is changed in Preferences (minutes, 0 = off). */
type Listener = (minutes: number) => void;
const listeners = new Set<Listener>();

export function onAutoFetchMinutes(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function announceAutoFetchMinutes(minutes: number): void {
  for (const fn of [...listeners]) fn(minutes);
}
