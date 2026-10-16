/**
 * Every keyboard shortcut lives in this one table, behind ONE keydown listener. Screens register a handler by id while they are mounted
 * (`registerShortcut`); a handler that returns `false` did not act, so the key keeps its default. Keys are GitKraken's documented defaults.
 * `resolveShortcut` is the pure part (table + guards); `onKeyDown` only adds the DOM facts (target, open overlays) and calls the handler.
 */
export type ShortcutId =
  | 'find'
  | 'filter'
  | 'undo'
  | 'redo'
  | 'commit'
  | 'open'
  | 'newTab'
  | 'closeTab'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'createBranch'
  | 'fetchAll'
  | 'commitStageAll'
  | 'focusMessage'
  | 'stageFile'
  | 'unstageFile'
  | 'stageAll'
  | 'unstageAll'
  | 'navPrev'
  | 'navNext'
  | 'navRight'
  | 'navLeft'
  | 'navNextInBranch'
  | 'navPrevInBranch'
  | 'navFirst'
  | 'navLast'
  | 'palette'
  | 'openRepoFinder'
  | 'fileFinder'
  | 'nextTab'
  | 'prevTab'
  | 'tab1'
  | 'tab2'
  | 'tab3'
  | 'tab4'
  | 'tab5'
  | 'tab6'
  | 'tab7'
  | 'tab8'
  | 'tab9'
  | 'tabsList'
  | 'toggleLeft'
  | 'toggleDetails'
  | 'fullScreen'
  | 'keybindings'
  | 'openTerminal'
  | 'toggleTerminal';

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey?: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}
export interface TargetLike {
  closest(selector: string): unknown;
}

type Handler = (e: KeyboardEvent) => boolean | void;

const FIELDS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .monaco-editor';
const MONACO = '.monaco-editor';
const XTERM = '.xterm';
const COMMIT_FIELDS = '[data-testid="commit-summary"], [data-testid="commit-description"]';

/** Shortcuts that change the repo or open an edit box: ignored while the key auto-repeats and while anything is open on top (V6 audit security 6). */
export const MUTATING_SHORTCUTS: readonly ShortcutId[] = ['createBranch', 'fetchAll', 'commitStageAll', 'stageFile', 'unstageFile', 'stageAll', 'unstageAll', 'openTerminal'];

interface Def {
  id: ShortcutId;
  match: (e: KeyEventLike) => boolean;
  /** Where the key must not act (typing fields and the code editor keep their own meaning of it). */
  skipIn?: string;
  /** Where the key may act at all. */
  onlyIn?: string;
}

const mod = (e: KeyEventLike) => e.ctrlKey || e.metaKey === true;
const lower = (e: KeyEventLike) => e.key.toLowerCase();
const plain = (e: KeyEventLike, key: string) => mod(e) && !e.altKey && !e.shiftKey && lower(e) === key;
const shifted = (e: KeyEventLike, key: string) => mod(e) && !e.altKey && e.shiftKey && lower(e) === key;
/** A bare key (no Ctrl / Alt / Meta); Shift only when asked for. */
const bare = (e: KeyEventLike, keys: string[], shift = false) => !mod(e) && !e.altKey && e.shiftKey === shift && keys.includes(shift ? lower(e) : e.key);

const DEFS: Def[] = [
  { id: 'filter', match: (e) => mod(e) && e.altKey && !e.shiftKey && lower(e) === 'f' },
  { id: 'openTerminal', match: (e) => e.altKey && !mod(e) && !e.shiftKey && lower(e) === 't' },
  { id: 'fullScreen', match: (e) => shifted(e, 'f') },
  { id: 'find', match: (e) => plain(e, 'f'), skipIn: MONACO },
  { id: 'undo', match: (e) => plain(e, 'z'), skipIn: FIELDS },
  { id: 'redo', match: (e) => plain(e, 'y') || shifted(e, 'z'), skipIn: FIELDS },
  { id: 'commit', match: (e) => mod(e) && !e.altKey && !e.shiftKey && e.key === 'Enter', onlyIn: COMMIT_FIELDS },
  { id: 'commitStageAll', match: (e) => mod(e) && !e.altKey && e.shiftKey && e.key === 'Enter', onlyIn: COMMIT_FIELDS },
  { id: 'open', match: (e) => plain(e, 'o') },
  { id: 'openRepoFinder', match: (e) => shifted(e, 'o') },
  { id: 'fileFinder', match: (e) => shifted(e, 'h') },
  { id: 'palette', match: (e) => plain(e, 'p') },
  { id: 'keybindings', match: (e) => mod(e) && !e.altKey && e.key === '/' },
  { id: 'newTab', match: (e) => plain(e, 't') },
  { id: 'closeTab', match: (e) => plain(e, 'w') },
  { id: 'nextTab', match: (e) => mod(e) && !e.altKey && !e.shiftKey && e.key === 'Tab' },
  { id: 'prevTab', match: (e) => mod(e) && !e.altKey && e.shiftKey && e.key === 'Tab' },
  { id: 'tabsList', match: (e) => shifted(e, 'a') },
  { id: 'createBranch', match: (e) => plain(e, 'b') },
  { id: 'fetchAll', match: (e) => plain(e, 'l'), skipIn: MONACO },
  { id: 'focusMessage', match: (e) => shifted(e, 'm') },
  { id: 'stageAll', match: (e) => shifted(e, 's'), skipIn: FIELDS },
  { id: 'unstageAll', match: (e) => shifted(e, 'u'), skipIn: FIELDS },
  { id: 'toggleLeft', match: (e) => plain(e, 'j') },
  { id: 'toggleDetails', match: (e) => plain(e, 'k'), skipIn: MONACO },
  { id: 'toggleTerminal', match: (e) => mod(e) && !e.altKey && !e.shiftKey && e.repeat !== true && e.key === '`' },
  { id: 'zoomIn', match: (e) => mod(e) && !e.altKey && (e.key === '=' || e.key === '+') },
  { id: 'zoomOut', match: (e) => mod(e) && !e.altKey && (e.key === '-' || e.key === '_') },
  { id: 'zoomReset', match: (e) => mod(e) && !e.altKey && !e.shiftKey && e.key === '0' },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n): Def => ({ id: `tab${n}` as ShortcutId, match: (e) => plain(e, String(n)) })),
  { id: 'navFirst', match: (e) => plain(e, 'home'), skipIn: FIELDS },
  { id: 'navLast', match: (e) => plain(e, 'end'), skipIn: FIELDS },
  { id: 'stageFile', match: (e) => bare(e, ['s']), skipIn: FIELDS },
  { id: 'unstageFile', match: (e) => bare(e, ['u']), skipIn: FIELDS },
  { id: 'navNextInBranch', match: (e) => (!mod(e) && !e.altKey && e.shiftKey && (e.key === 'ArrowDown' || lower(e) === 'j')), skipIn: FIELDS },
  { id: 'navPrevInBranch', match: (e) => (!mod(e) && !e.altKey && e.shiftKey && (e.key === 'ArrowUp' || lower(e) === 'k')), skipIn: FIELDS },
  { id: 'navPrev', match: (e) => bare(e, ['ArrowUp', 'k']), skipIn: FIELDS },
  { id: 'navNext', match: (e) => bare(e, ['ArrowDown', 'j']), skipIn: FIELDS },
  { id: 'navRight', match: (e) => bare(e, ['ArrowRight', 'l']), skipIn: FIELDS },
  { id: 'navLeft', match: (e) => bare(e, ['ArrowLeft', 'h']), skipIn: FIELDS },
];

/** The pure table lookup: which shortcut (if any) this key press is, given where it came from and whether something is open on top. */
export function resolveShortcut(e: KeyEventLike, ctx: { target?: TargetLike | null; blocked?: boolean } = {}): ShortcutId | null {
  const target = ctx.target ?? null;
  for (const d of DEFS) {
    if (!d.match(e)) continue;
    if (d.id !== 'toggleTerminal' && target?.closest(XTERM)) return null; // the terminal owns its keys, except Ctrl+`
    if (d.skipIn && target?.closest(d.skipIn)) return null;
    if (d.onlyIn && !target?.closest(d.onlyIn)) return null;
    if (ctx.blocked === true && d.id !== 'palette' && d.id !== 'keybindings') return null; // anything open on top owns the keyboard (only Ctrl+P / Ctrl+/ stay, to toggle their own overlay)
    if (MUTATING_SHORTCUTS.includes(d.id) && e.repeat === true) return null;
    return d.id;
  }
  return null;
}

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

/** Anything open on top of the screen: a registered overlay, a confirm bar, a context menu, the palette or a list. */
export const BLOCKING = '[data-testid="context-menu"], [data-testid="command-palette"], [data-testid="tabs-list"], [data-testid="View-KeyBindings"], .confirm-bar, .branch-picker, .pull-menu, [role="menu"], [role="dialog"], [role="alertdialog"]';
function blocked(): boolean {
  return overlays.length > 0 || (typeof document !== 'undefined' && document.querySelector(BLOCKING) !== null);
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  const target = e.target instanceof Element ? e.target : null;
  if (e.key === 'Escape') {
    if (target?.closest(XTERM)) return; // Esc belongs to the shell
    const top = overlays[overlays.length - 1];
    if (top) {
      e.preventDefault();
      top();
    }
    return;
  }
  const id = resolveShortcut(e, { target, blocked: blocked() });
  if (!id) return;
  const fn = handlers.get(id);
  if (!fn) return;
  if (fn(e) !== false) e.preventDefault();
}

/** Installs the single listener; the returned function removes it. */
export function installShortcuts(): () => void {
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/** The Ctrl+/ list: GitKraken's rows (screens/32-shortcuts.txt) minus the cut ones. `keys` = alternatives; each alternative is a list of key caps. */
export type KeyBindingSection = 'RepoActions' | 'Navigation' | 'FuzzyFinder' | 'UI';
export interface KeyBindingRow {
  section: KeyBindingSection;
  id: string;
  label: string;
  keys: string[][];
}
const C = 'Ctrl';
const S = 'Shift';
export const KEYBINDING_ROWS: KeyBindingRow[] = [
  { section: 'RepoActions', id: 'CreateBranch', label: 'Create Branch', keys: [[C, 'B']] },
  { section: 'RepoActions', id: 'Fetch', label: 'Fetch All', keys: [[C, 'L']] },
  { section: 'RepoActions', id: 'Commit', label: 'Commit (when in message input)', keys: [[C, 'Enter']] },
  { section: 'RepoActions', id: 'Stage', label: 'Stage Current File', keys: [['S']] },
  { section: 'RepoActions', id: 'Unstage', label: 'Unstage Current File', keys: [['U']] },
  { section: 'RepoActions', id: 'StageAll', label: 'Stage All Files', keys: [[C, S, 'S']] },
  { section: 'RepoActions', id: 'UnstageAll', label: 'Unstage All Files', keys: [[C, S, 'U']] },
  { section: 'RepoActions', id: 'CommitWithStage', label: 'Stage All + Commit (when in message input)', keys: [[C, S, 'Enter']] },
  { section: 'RepoActions', id: 'FocusCommitMessage', label: 'Focus commit message', keys: [[C, S, 'M']] },
  { section: 'RepoActions', id: 'OpenInDefaultTerminal', label: 'Open in default terminal', keys: [['Alt', 'T']] },
  { section: 'Navigation', id: 'SelectPrev', label: 'Select Previous Item', keys: [['↑'], ['K']] },
  { section: 'Navigation', id: 'SelectNext', label: 'Select Next Item', keys: [['↓'], ['J']] },
  { section: 'Navigation', id: 'SelectRight', label: 'Select the Item to the Right', keys: [['→'], ['L']] },
  { section: 'Navigation', id: 'SelectLeft', label: 'Select the Item to the Left', keys: [['←'], ['H']] },
  { section: 'Navigation', id: 'SelectNextTopological', label: 'Select Next Item in Branch', keys: [[S, '↓'], [S, 'J']] },
  { section: 'Navigation', id: 'SelectPrevTopological', label: 'Select Previous Item in Branch', keys: [[S, '↑'], [S, 'K']] },
  { section: 'Navigation', id: 'SelectFirst', label: 'Select First Item', keys: [[C, 'Home']] },
  { section: 'Navigation', id: 'SelectLast', label: 'Select Last Item', keys: [[C, 'End']] },
  { section: 'Navigation', id: 'Undo', label: 'Undo', keys: [[C, 'Z']] },
  { section: 'Navigation', id: 'Redo', label: 'Redo', keys: [[C, 'Y'], [C, S, 'Z']] },
  { section: 'FuzzyFinder', id: 'ToggleFuzzyFinder', label: 'Toggle Command Palette', keys: [[C, 'P']] },
  { section: 'FuzzyFinder', id: 'SearchCommits', label: 'Search commits', keys: [[C, 'F']] },
  { section: 'FuzzyFinder', id: 'FuzzyFinderOpenRepo', label: 'Open Repo via Command Palette', keys: [[C, S, 'O']] },
  { section: 'FuzzyFinder', id: 'FuzzyFinderHistory', label: 'Search for a file to view its history / blame', keys: [[C, S, 'H']] },
  { section: 'UI', id: 'OpenNewTab', label: 'Open a new tab', keys: [[C, 'T']] },
  { section: 'UI', id: 'CloseFileOrTab', label: 'Close File/Tab', keys: [[C, 'W']] },
  { section: 'UI', id: 'CloseView', label: 'Close View', keys: [['Esc']] },
  { section: 'UI', id: 'JumpToNextTab', label: 'Jump to the next open tab', keys: [[C, 'Tab']] },
  { section: 'UI', id: 'JumpToPreviousTab', label: 'Jump to the previous open tab', keys: [[C, S, 'Tab']] },
  { section: 'UI', id: 'JumpToSpecificTab', label: 'Jump to a specific tab', keys: [[C, '1–9']] },
  { section: 'UI', id: 'ToggleLeftPanel', label: 'Toggle Left Panel', keys: [[C, 'J']] },
  { section: 'UI', id: 'ToggleCommitDetailsPanel', label: 'Toggle Commit Details Panel', keys: [[C, 'K']] },
  { section: 'UI', id: 'ToggleTerminalPanel', label: 'Toggle Terminal Panel', keys: [[C, '`']] },
  { section: 'UI', id: 'IncreaseZoom', label: 'Increase Zoom', keys: [[C, '+']] },
  { section: 'UI', id: 'DecreaseZoom', label: 'Decrease Zoom', keys: [[C, '-']] },
  { section: 'UI', id: 'ResetZoom', label: 'Reset Zoom', keys: [[C, '0']] },
  { section: 'UI', id: 'FullScreen', label: 'Toggle Full Screen', keys: [[C, S, 'F']] },
  { section: 'UI', id: 'OpenTabsList', label: 'Open tabs list', keys: [[C, S, 'A']] },
];
