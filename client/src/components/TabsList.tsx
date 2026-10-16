import { useEffect } from 'react';
import type { RepoInfo } from '@gitslappin/shared';
import { pushOverlay } from '../lib/shortcuts';

/** Ctrl+Shift+A: the open tabs as a list; Enter or a click selects, Esc closes. */
export function TabsList({ tabs, activeId, onSelect, onClose }: { tabs: RepoInfo[]; activeId: string | null; onSelect: (id: string) => void; onClose: () => void }) {
  useEffect(() => pushOverlay(onClose), [onClose]);
  const move = (e: React.KeyboardEvent, d: number) => {
    e.preventDefault();
    const items = [...e.currentTarget.parentElement!.querySelectorAll<HTMLElement>('[data-testid="tabs-list-item"]')];
    const i = items.indexOf(e.currentTarget as HTMLElement);
    items[Math.min(items.length - 1, Math.max(0, i + d))]?.focus();
  };
  return (
    <div className="palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" data-testid="tabs-list" role="listbox" aria-label="Open tabs list">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            type="button"
            className={`palette-item${t.id === activeId ? ' selected' : ''}`}
            role="option"
            aria-selected={t.id === activeId}
            data-testid="tabs-list-item"
            data-id={t.id}
            title={t.root}
            autoFocus={t.id === activeId || (activeId === null && i === 0)}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') move(e, 1);
              else if (e.key === 'ArrowUp') move(e, -1);
            }}
          >
            <span className="palette-item-label">{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
