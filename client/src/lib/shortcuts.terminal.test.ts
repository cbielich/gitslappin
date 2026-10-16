import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installShortcuts, registerShortcut } from './shortcuts';

/*
 * V6b: Ctrl+` (GitKraken View-ToggleTerminalPanel) is a new shortcut id `toggleTerminal` in shortcuts.ts. Every app shortcut is ignored when the
 * key press comes from inside `.xterm` (the terminal owns its keys), EXCEPT Ctrl+`. No DOM in this vitest setup, so window and Element are stubbed
 * and the single registered keydown listener is called directly with plain event objects.
 * Existing ids used: find (Ctrl+F), open (Ctrl+O), newTab (Ctrl+T), closeTab (Ctrl+W), undo (Ctrl+Z), redo (Ctrl+Y), zoomIn (Ctrl+=).
 */

class FakeEl {
  constructor(private readonly classes: string[] = [], private readonly tag = 'div') {}
  closest(sel: string): FakeEl | null {
    for (const part of sel.split(',').map((s) => s.trim())) {
      if (part.startsWith('.') && this.classes.includes(part.slice(1))) return this;
      if (/^[a-z]+$/.test(part) && part === this.tag) return this;
    }
    return null;
  }
}

let listener: ((e: unknown) => void) | undefined;
let uninstall: (() => void) | undefined;
const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, Element: g.Element };

beforeAll(() => {
  g.Element = FakeEl;
  g.window = {
    addEventListener: (_t: string, fn: (e: unknown) => void) => {
      listener = fn;
    },
    removeEventListener: () => undefined,
  };
  uninstall = installShortcuts();
});
afterAll(() => {
  uninstall?.();
  g.window = saved.window;
  g.Element = saved.Element;
});

function press(key: string, target: FakeEl, extra: Record<string, unknown> = {}): { prevented: boolean } {
  const state = { prevented: false };
  listener?.({ key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, target, preventDefault: () => (state.prevented = true), ...extra });
  return state;
}

const inTerminal = () => new FakeEl(['xterm', 'xterm-helper-textarea'], 'textarea');
const elsewhere = () => new FakeEl([], 'div');

describe('shortcuts and the terminal', () => {
  it('Ctrl+` fires toggleTerminal from anywhere, including inside .xterm', () => {
    const fn = vi.fn();
    const off = registerShortcut('toggleTerminal' as never, fn);
    const a = press('`', elsewhere());
    const b = press('`', inTerminal());
    expect(fn).toHaveBeenCalledTimes(2);
    expect(a.prevented).toBe(true);
    expect(b.prevented).toBe(true);
    off();
  });

  it('Ctrl+` does nothing special without Ctrl (a plain backtick is typed text)', () => {
    const fn = vi.fn();
    const off = registerShortcut('toggleTerminal' as never, fn);
    press('`', inTerminal(), { ctrlKey: false });
    expect(fn).not.toHaveBeenCalled();
    off();
  });

  const keys: Array<[string, string]> = [
    ['find', 'f'],
    ['open', 'o'],
    ['newTab', 't'],
    ['closeTab', 'w'],
    ['undo', 'z'],
    ['redo', 'y'],
    ['zoomIn', '='],
  ];
  for (const [id, key] of keys) {
    it(`Ctrl+${key} (${id}) is ignored inside .xterm and the key keeps its default, but acts elsewhere`, () => {
      const fn = vi.fn();
      const off = registerShortcut(id as never, fn);
      const outside = press(key, elsewhere());
      expect(fn, 'acts outside the terminal').toHaveBeenCalledTimes(1);
      expect(outside.prevented).toBe(true);
      const inside = press(key, inTerminal());
      expect(fn, 'ignored inside the terminal').toHaveBeenCalledTimes(1);
      expect(inside.prevented).toBe(false);
      off();
    });
  }
});
