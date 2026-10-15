import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MenuEntry } from '../../lib/refMenu';

type Item = Extract<MenuEntry, { type: 'item' }>;

interface Props {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

/**
 * Keeps a popup of the measured size inside the window. With `flipX` (the x to use instead), a popup that would run
 * past the right edge opens to the left of its anchor.
 */
function useClamp(x: number, y: number, flipX?: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = flipX !== undefined && x + r.width > window.innerWidth - 4 ? flipX - r.width : x;
    setPos({ left: Math.max(4, Math.min(left, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y, flipX]);
  return { ref, pos };
}

function Rows({ entries, openId, onOpen, onRun }: { entries: MenuEntry[]; openId: string | null; onOpen: (it: Item, el: HTMLElement) => void; onRun: (it: Item) => void }) {
  return (
    <>
      {entries.map((e, i) =>
        e.type === 'divider' ? (
          <div key={`d${i}`} className="ctx-divider" data-testid="menu-divider" role="separator" />
        ) : (
          <button
            key={e.id}
            className={`ctx-item${openId === e.id ? ' open' : ''}`}
            role="menuitem"
            data-testid="menu-item"
            data-id={e.id}
            {...(e.submenu ? { 'aria-haspopup': 'menu' as const } : {})}
            onMouseEnter={(ev) => onOpen(e, ev.currentTarget)}
            onClick={(ev) => (e.submenu ? onOpen(e, ev.currentTarget) : onRun(e))}
          >
            <span className="ctx-label">{e.label}</span>
            {e.submenu && <span className="ctx-arrow" aria-hidden="true" />}
          </button>
        ),
      )}
    </>
  );
}

const itemsOf = (root: HTMLElement | null): HTMLElement[] => Array.from(root?.querySelectorAll<HTMLElement>('[data-testid="menu-item"]') ?? []);

/**
 * Dark rounded menu with an optional one-level submenu. Esc, Tab or a press outside closes it.
 * Keyboard: the first item is focused on open; Up/Down/Home/End move, Right opens a submenu, Left closes it, Enter runs.
 */
export function ContextMenu({ x, y, entries, onClose }: Props) {
  const [sub, setSub] = useState<{ item: Item; x: number; y: number; flipX: number } | null>(null);
  const [focusSub, setFocusSub] = useState(false);
  const main = useClamp(x, y);
  const subPos = useClamp(sub?.x ?? 0, sub?.y ?? 0, sub?.flipX);

  const open = (it: Item, el: HTMLElement) => {
    if (!it.submenu) {
      setSub(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setSub({ item: it, x: r.right - 2, y: r.top - 5, flipX: r.left + 2 });
  };

  useEffect(() => {
    itemsOf(main.ref.current)[0]?.focus();
  }, [main.ref]);

  useEffect(() => {
    if (!sub || !focusSub) return;
    itemsOf(subPos.ref.current)[0]?.focus();
    setFocusSub(false);
  }, [sub, focusSub, subPos.ref]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (main.ref.current?.contains(t) || subPos.ref.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key === 'Tab') {
        e.preventDefault();
        return onClose();
      }
      const active = document.activeElement as HTMLElement | null;
      const inSub = !!active && !!subPos.ref.current?.contains(active);
      const list = itemsOf(inSub ? subPos.ref.current : main.ref.current);
      const idx = active ? list.indexOf(active) : -1;
      const focusAt = (i: number) => {
        e.preventDefault();
        list[(i + list.length) % list.length]?.focus();
      };
      if (list.length === 0) return;
      if (e.key === 'ArrowDown') focusAt(idx + 1);
      else if (e.key === 'ArrowUp') focusAt(idx < 0 ? -1 : idx - 1);
      else if (e.key === 'Home') focusAt(0);
      else if (e.key === 'End') focusAt(-1);
      else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        const it = !inSub && active ? entries.find((en): en is Item => en.type === 'item' && en.id === active.dataset.id) : undefined;
        if (it?.submenu && active) {
          e.preventDefault();
          open(it, active);
          setFocusSub(true);
        }
        // Enter on any other item is the button's own click.
      } else if (e.key === 'ArrowLeft' && inSub) {
        e.preventDefault();
        const parent = sub?.item.id;
        setSub(null);
        itemsOf(main.ref.current)
          .find((el) => el.dataset.id === parent)
          ?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, main.ref, subPos.ref, entries, sub]);

  const run = (it: Item) => {
    onClose();
    it.run();
  };

  return (
    <>
      <div ref={main.ref} className="ctx-menu" data-testid="context-menu" role="menu" style={main.pos} onContextMenu={(e) => e.preventDefault()}>
        <Rows entries={entries} openId={sub?.item.id ?? null} onOpen={open} onRun={run} />
      </div>
      {sub?.item.submenu && (
        <div ref={subPos.ref} className="ctx-menu ctx-submenu" data-testid="context-submenu" role="menu" style={subPos.pos} onContextMenu={(e) => e.preventDefault()}>
          <Rows entries={sub.item.submenu} openId={null} onOpen={() => undefined} onRun={run} />
        </div>
      )}
    </>
  );
}
