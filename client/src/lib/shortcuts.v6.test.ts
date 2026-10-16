import { describe, expect, it } from 'vitest';
import { BLOCKING, KEYBINDING_ROWS, MUTATING_SHORTCUTS, resolveShortcut, type KeyEventLike, type TargetLike } from './shortcuts';

/*
 * V6 design "2 Shortcuts and the Ctrl+/ list" + audit security 6. No DOM in this vitest setup (no jsdom), so the table is tested through a pure function added to
 * client/src/lib/shortcuts.ts (contract chosen by the test author; onKeyDown must call it, so the browser path and this test use the same table):
 *   export interface KeyEventLike { key: string; ctrlKey: boolean; metaKey?: boolean; shiftKey: boolean; altKey: boolean; repeat?: boolean }
 *   export interface TargetLike { closest(selector: string): unknown }       // an Element in the browser; a fake here: truthy when `selector` contains the fake's token
 *   export function resolveShortcut(e: KeyEventLike, ctx?: { target?: TargetLike | null; blocked?: boolean }): ShortcutId | null
 *       blocked = a modal, confirm bar, context menu or the palette is open.
 *       null = the key is not a shortcut here (no handler lookup, no preventDefault).
 *   export const MUTATING_SHORTCUTS: readonly ShortcutId[]       createBranch, fetchAll, commitStageAll, stageFile, unstageFile, stageAll, unstageAll
 *   export const KEYBINDING_ROWS: { section: 'RepoActions' | 'Navigation' | 'FuzzyFinder' | 'UI'; id: string; label: string }[]   the Ctrl+/ list, in display order
 * New ShortcutId values (existing ones stay): createBranch fetchAll commitStageAll focusMessage stageFile unstageFile stageAll unstageAll navPrev navNext navRight navLeft
 *   navNextInBranch navPrevInBranch navFirst navLast palette openRepoFinder fileFinder nextTab prevTab tab1..tab9 tabsList toggleLeft toggleDetails fullScreen keybindings openTerminal
 * Selector tokens the fake target answers to: 'input' (any text field: FIELDS in shortcuts.ts), '.monaco-editor', 'commit-summary' (the commit message field).
 */

const ev = (key: string, o: Partial<KeyEventLike> = {}): KeyEventLike => ({ key, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, ...o });
const ctrl = (key: string, o: Partial<KeyEventLike> = {}) => ev(key, { ctrlKey: true, ...o });
const at = (token: string): TargetLike => ({ closest: (sel: string) => (sel.includes(token) ? {} : null) });
const NOWHERE: { target: TargetLike | null } = { target: { closest: () => null } };
const r = (e: KeyEventLike, ctx: { target?: TargetLike | null; blocked?: boolean } = NOWHERE) => resolveShortcut(e, ctx);

describe('shortcut table (GitKraken defaults, screens/32-shortcuts.txt)', () => {
  it('repo actions', () => {
    expect(r(ctrl('b'))).toBe('createBranch');
    expect(r(ctrl('l'))).toBe('fetchAll');
    expect(r(ctrl('M', { shiftKey: true }))).toBe('focusMessage');
    expect(r(ctrl('s', { shiftKey: true }))).toBe('stageAll');
    expect(r(ctrl('U', { shiftKey: true }))).toBe('unstageAll');
    expect(r(ev('s'))).toBe('stageFile');
    expect(r(ev('u'))).toBe('unstageFile');
    expect(r(ev('t', { altKey: true }))).toBe('openTerminal');
  });
  it('Ctrl+Shift+Enter is stage all + commit, only inside the commit message field', () => {
    const e = ctrl('Enter', { shiftKey: true });
    expect(r(e, { target: at('commit-summary') })).toBe('commitStageAll');
    expect(r(e, NOWHERE)).toBeNull();
    expect(r(e, { target: at('input') })).toBeNull(); // some other text field
    expect(r(ctrl('Enter'), { target: at('commit-summary') })).toBe('commit'); // the existing Ctrl+Enter is untouched
  });
  it('graph navigation: arrows and the vim letters', () => {
    expect(r(ev('ArrowUp'))).toBe('navPrev');
    expect(r(ev('k'))).toBe('navPrev');
    expect(r(ev('ArrowDown'))).toBe('navNext');
    expect(r(ev('j'))).toBe('navNext');
    expect(r(ev('ArrowRight'))).toBe('navRight');
    expect(r(ev('l'))).toBe('navRight');
    expect(r(ev('ArrowLeft'))).toBe('navLeft');
    expect(r(ev('h'))).toBe('navLeft');
    expect(r(ev('ArrowDown', { shiftKey: true }))).toBe('navNextInBranch');
    expect(r(ev('J', { shiftKey: true }))).toBe('navNextInBranch');
    expect(r(ev('ArrowUp', { shiftKey: true }))).toBe('navPrevInBranch');
    expect(r(ev('K', { shiftKey: true }))).toBe('navPrevInBranch');
    expect(r(ctrl('Home'))).toBe('navFirst');
    expect(r(ctrl('End'))).toBe('navLast');
  });
  it('palette and finders', () => {
    expect(r(ctrl('p'))).toBe('palette');
    expect(r(ctrl('O', { shiftKey: true }))).toBe('openRepoFinder');
    expect(r(ctrl('H', { shiftKey: true }))).toBe('fileFinder');
    expect(r(ctrl('o'))).toBe('open'); // the existing open-repo key is not stolen by Ctrl+Shift+O
    expect(r(ctrl('f'))).toBe('find');
  });
  it('tabs', () => {
    expect(r(ctrl('Tab'))).toBe('nextTab');
    expect(r(ctrl('Tab', { shiftKey: true }))).toBe('prevTab');
    for (let n = 1; n <= 9; n++) expect(r(ctrl(String(n)))).toBe(`tab${n}`);
    expect(r(ctrl('A', { shiftKey: true }))).toBe('tabsList');
    expect(r(ctrl('0'))).toBe('zoomReset'); // Ctrl+0 stays Reset Zoom, not a tab
  });
  it('UI', () => {
    expect(r(ctrl('j'))).toBe('toggleLeft');
    expect(r(ctrl('k'))).toBe('toggleDetails');
    expect(r(ctrl('F', { shiftKey: true }))).toBe('fullScreen');
    expect(r(ctrl('/'))).toBe('keybindings');
  });
  it('the cut one does nothing: Ctrl+D (external diff tool); Ctrl+` is the terminal panel (V6b)', () => {
    expect(r(ctrl('d'))).toBeNull();
    expect(r(ctrl('`'))).toBe('toggleTerminal');
  });
  it('no shortcut anywhere maps to discard (audit data-safety 1)', () => {
    const keys = [...'abcdefghijklmnopqrstuvwxyz0123456789/`-=', 'Enter', 'Backspace', 'Delete', 'Home', 'End', 'Tab', 'ArrowUp', 'ArrowDown', 'F11'];
    for (const key of keys) {
      for (const ctrlKey of [false, true]) {
        for (const shiftKey of [false, true]) {
          for (const altKey of [false, true]) {
            for (const target of [NOWHERE.target, at('commit-summary')]) {
              const id = r(ev(key, { ctrlKey, shiftKey, altKey }), { target });
              if (id) expect(id, `${ctrlKey ? 'Ctrl+' : ''}${shiftKey ? 'Shift+' : ''}${altKey ? 'Alt+' : ''}${key}`).not.toMatch(/discard|(?<!zoom)reset(?!zoom)|force/i);
            }
          }
        }
      }
    }
    expect([...MUTATING_SHORTCUTS].join(',')).not.toMatch(/discard/i);
  });
});

describe('text fields and the code editor', () => {
  it('single-letter keys do not act in text fields', () => {
    for (const k of ['s', 'u', 'j', 'k', 'h', 'l']) {
      expect(r(ev(k), { target: at('input') }), k).toBeNull();
      expect(r(ev(k), NOWHERE), k).not.toBeNull(); // the same key acts outside a field: the code path runs
    }
    expect(r(ev('J', { shiftKey: true }), { target: at('input') })).toBeNull();
    expect(r(ev('K', { shiftKey: true }), { target: at('input') })).toBeNull();
  });
  it('Ctrl+K and Ctrl+L do not act inside .monaco-editor, but do elsewhere', () => {
    expect(r(ctrl('k'), { target: at('.monaco-editor') })).toBeNull();
    expect(r(ctrl('l'), { target: at('.monaco-editor') })).toBeNull();
    expect(r(ctrl('k'), NOWHERE)).toBe('toggleDetails');
    expect(r(ctrl('l'), NOWHERE)).toBe('fetchAll');
  });
  it('audit security 6: Ctrl+Shift+S / Ctrl+Shift+U do nothing in .monaco-editor and in text inputs', () => {
    for (const key of ['S', 'U']) {
      const e = ctrl(key, { shiftKey: true });
      expect(r(e, { target: at('.monaco-editor') }), key).toBeNull();
      expect(r(e, { target: at('input') }), key).toBeNull();
      expect(r(e, NOWHERE), key).toBe(key === 'S' ? 'stageAll' : 'unstageAll');
    }
  });
});

describe('audit security 6: mutating shortcuts', () => {
  const MUT: [string, KeyEventLike, { target?: TargetLike | null }][] = [
    ['createBranch', ctrl('b'), NOWHERE],
    ['fetchAll', ctrl('l'), NOWHERE],
    ['commitStageAll', ctrl('Enter', { shiftKey: true }), { target: at('commit-summary') }],
    ['stageFile', ev('s'), NOWHERE],
    ['unstageFile', ev('u'), NOWHERE],
    ['stageAll', ctrl('S', { shiftKey: true }), NOWHERE],
    ['unstageAll', ctrl('U', { shiftKey: true }), NOWHERE],
    ['openTerminal', ev('t', { altKey: true }), NOWHERE],
  ];
  it('MUTATING_SHORTCUTS lists exactly these eight (openTerminal repeats are ignored too)', () => {
    expect([...MUTATING_SHORTCUTS].sort()).toEqual(MUT.map((m) => m[0]).sort());
  });
  it.each(MUT)('%s acts once, and is ignored while the key is auto-repeating (e.repeat)', (id, e, ctx) => {
    expect(r({ ...e, repeat: false }, ctx)).toBe(id);
    expect(r({ ...e, repeat: true }, ctx)).toBeNull();
  });
  it.each(MUT)('%s does nothing while a modal, confirm bar, context menu or the palette is open (blocked)', (id, e, ctx) => {
    expect(r(e, { ...ctx, blocked: false })).toBe(id);
    expect(r(e, { ...ctx, blocked: true })).toBeNull();
  });
  it.each([['navNext', ev('j')], ['navPrev', ev('ArrowUp')], ['navLeft', ev('h')], ['navRight', ev('l')], ['navFirst', ctrl('Home')], ['toggleLeft', ctrl('j')], ['toggleDetails', ctrl('k')], ['zoomIn', ctrl('=')], ['newTab', ctrl('t')]])('review fix: %s is also ignored while something is open on top', (id, e) => {
    expect(r(e, { ...NOWHERE, blocked: true })).toBeNull();
    expect(r(e, { ...NOWHERE, blocked: false })).toBe(id);
  });
  it('review fix: the palette key still works while the palette itself is open', () => {
    expect(r(ctrl('p'), { ...NOWHERE, blocked: true })).toBe('palette');
    expect(r(ctrl('/'), { ...NOWHERE, blocked: true })).toBe('keybindings');
  });
  it('review fix: the shared BLOCKING selector covers every bar, menu and picker', () => {
    for (const part of ['.confirm-bar', '[role="alertdialog"]', '[role="menu"]', '.branch-picker', '.pull-menu', '[role="dialog"]', 'context-menu', 'command-palette']) expect(BLOCKING).toContain(part);
  });
  it('a repeating non-mutating key still acts (holding J scrolls through the graph)', () => {
    expect(r(ev('j', { repeat: true }))).toBe('navNext');
    expect(r(ev('ArrowDown', { repeat: true }))).toBe('navNext');
  });
});

describe('Ctrl+/ list (KEYBINDING_ROWS)', () => {
  // [section, KeyBinding-<id>, label]; order and wording from screens/32-shortcuts.txt and en-us.json KeyBinding-*, minus the cut Ctrl+D and Ctrl+` rows.
  const EXPECTED: [string, string, string][] = [
    ['RepoActions', 'CreateBranch', 'Create Branch'],
    ['RepoActions', 'Fetch', 'Fetch All'],
    ['RepoActions', 'Commit', 'Commit (when in message input)'],
    ['RepoActions', 'Stage', 'Stage Current File'],
    ['RepoActions', 'Unstage', 'Unstage Current File'],
    ['RepoActions', 'StageAll', 'Stage All Files'],
    ['RepoActions', 'UnstageAll', 'Unstage All Files'],
    ['RepoActions', 'CommitWithStage', 'Stage All + Commit (when in message input)'],
    ['RepoActions', 'FocusCommitMessage', 'Focus commit message'],
    ['RepoActions', 'OpenInDefaultTerminal', 'Open in default terminal'],
    ['Navigation', 'SelectPrev', 'Select Previous Item'],
    ['Navigation', 'SelectNext', 'Select Next Item'],
    ['Navigation', 'SelectRight', 'Select the Item to the Right'],
    ['Navigation', 'SelectLeft', 'Select the Item to the Left'],
    ['Navigation', 'SelectNextTopological', 'Select Next Item in Branch'],
    ['Navigation', 'SelectPrevTopological', 'Select Previous Item in Branch'],
    ['Navigation', 'SelectFirst', 'Select First Item'],
    ['Navigation', 'SelectLast', 'Select Last Item'],
    ['Navigation', 'Undo', 'Undo'],
    ['Navigation', 'Redo', 'Redo'],
    ['FuzzyFinder', 'ToggleFuzzyFinder', 'Toggle Command Palette'],
    ['FuzzyFinder', 'SearchCommits', 'Search commits'],
    ['FuzzyFinder', 'FuzzyFinderOpenRepo', 'Open Repo via Command Palette'],
    ['FuzzyFinder', 'FuzzyFinderHistory', 'Search for a file to view its history / blame'],
    ['UI', 'OpenNewTab', 'Open a new tab'],
    ['UI', 'CloseFileOrTab', 'Close File/Tab'],
    ['UI', 'CloseView', 'Close View'],
    ['UI', 'JumpToNextTab', 'Jump to the next open tab'],
    ['UI', 'JumpToPreviousTab', 'Jump to the previous open tab'],
    ['UI', 'JumpToSpecificTab', 'Jump to a specific tab'],
    ['UI', 'ToggleLeftPanel', 'Toggle Left Panel'],
    ['UI', 'ToggleCommitDetailsPanel', 'Toggle Commit Details Panel'],
    ['UI', 'ToggleTerminalPanel', 'Toggle Terminal Panel'],
    ['UI', 'IncreaseZoom', 'Increase Zoom'],
    ['UI', 'DecreaseZoom', 'Decrease Zoom'],
    ['UI', 'ResetZoom', 'Reset Zoom'],
    ['UI', 'FullScreen', 'Toggle Full Screen'],
    ['UI', 'OpenTabsList', 'Open tabs list'],
  ];
  it('has every reference row in order, none of the cut ones', () => {
    expect(KEYBINDING_ROWS.map((x) => [x.section, x.id, x.label])).toEqual(EXPECTED);
    const labels = KEYBINDING_ROWS.map((x) => x.label);
    expect(labels).not.toContain('Open Selected File in External Diff/Merge Tool');
  });
});
