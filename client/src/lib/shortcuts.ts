/**
 * Every keyboard shortcut lives in this one table, behind ONE keydown listener. Screens register a handler by id while they are mounted
 * (`registerShortcut`); a handler that returns `false` did not act, so the key keeps its default. Keys are GitKraken's documented defaults.
 */
export type ShortcutId = 'find' | 'filter' | 'undo' | 'redo' | 'commit' | 'open' | 'newTab' | 'closeTab' | 'zoomIn' | 'zoomOut' | 'zoomReset';

type Handler = (e: KeyboardEvent) => boolean | void;

const FIELDS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .monaco-editor';

interface Def {
  id: ShortcutId;
  match: (e: KeyboardEvent) => boolean;
  /** Where the key must not act (typing fields and the code editor keep their own meaning of it). */
  skipIn?: string;
  /** Where the key may act at all. */
  onlyIn?: string;
}

const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
const plain = (e: KeyboardEvent, key: string) => mod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === key;

const DEFS: Def[] = [
  { id: 'filter', match: (e) => mod(e) && e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' },
  { id: 'find', match: (e) => plain(e, 'f'), skipIn: '.monaco-editor' },
  { id: 'undo', match: (e) => plain(e, 'z'), skipIn: FIELDS },
  { id: 'redo', match: (e) => plain(e, 'y'), skipIn: FIELDS },
  { id: 'commit', match: (e) => mod(e) && !e.altKey && !e.shiftKey && e.key === 'Enter', onlyIn: '[data-testid="commit-summary"], [data-testid="commit-description"]' },
  { id: 'open', match: (e) => plain(e, 'o') },
  { id: 'newTab', match: (e) => plain(e, 't') },
  { id: 'closeTab', match: (e) => plain(e, 'w') },
  { id: 'zoomIn', match: (e) => mod(e) && !e.altKey && (e.key === '=' || e.key === '+') },
  { id: 'zoomOut', match: (e) => mod(e) && !e.altKey && (e.key === '-' || e.key === '_') },
  { id: 'zoomReset', match: (e) => mod(e) && !e.altKey && !e.shiftKey && e.key === '0' },
];

const handlers = new Map<ShortcutId, Handler>();
const overlays: Array<() => void> = [];

/** Registers the handler for a shortcut; the returned function removes it (only if it is still the registered one). */
export function registerShortcut(id: ShortcutId, fn: Handler): () => void {
  handlers.set(id, fn);
  return () => {
    if (handlers.get(id) === fn) handlers.delete(id);
  };
}

/** An open overlay (Preferences, ...) registers how to close itself; Esc closes the topmost one. */
export function pushOverlay(close: () => void): () => void {
  overlays.push(close);
  return () => {
    const i = overlays.lastIndexOf(close);
    if (i >= 0) overlays.splice(i, 1);
  };
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  const target = e.target instanceof Element ? e.target : null;
  if (e.key === 'Escape') {
    const top = overlays[overlays.length - 1];
    if (top) {
      e.preventDefault();
      top();
    }
    return;
  }
  for (const d of DEFS) {
    if (!d.match(e)) continue;
    if (d.skipIn && target?.closest(d.skipIn)) return;
    if (d.onlyIn && !target?.closest(d.onlyIn)) return;
    const fn = handlers.get(d.id);
    if (!fn) return;
    if (fn(e) !== false) e.preventDefault();
    return;
  }
}

/** Installs the single listener; the returned function removes it. */
export function installShortcuts(): () => void {
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
