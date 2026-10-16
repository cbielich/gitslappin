import { useEffect, useState } from 'react';
import { pushOverlay } from '../lib/shortcuts';

type Entry = { id: string; label: string } | 'divider';

/** Wording from en-us.json menuStrings. Cut: Cut / Copy / Paste / Select All, Sign In, Quit, Developer tools, Relaunch, Favorites, Window. */
const MENUS: { name: string; entries: Entry[] }[] = [
  {
    name: 'File',
    entries: [
      { id: 'NewTab', label: 'New Tab' },
      'divider',
      { id: 'CloneRepo', label: 'Clone Repo...' },
      { id: 'InitRepo', label: 'Init Repo...' },
      { id: 'OpenRepo', label: 'Open Repo...' },
      { id: 'OpenRepoManagement', label: 'Open Repo Management' },
      'divider',
      { id: 'OpenTerminal', label: 'Open External Terminal' },
      { id: 'OpenInFileManager', label: 'Open in File Manager' },
      'divider',
      { id: 'Preferences', label: 'Preferences...' },
    ],
  },
  {
    name: 'Edit',
    entries: [
      { id: 'Undo', label: 'Undo' },
      { id: 'Redo', label: 'Redo' },
    ],
  },
  {
    name: 'View',
    entries: [
      { id: 'ToggleFullScreen', label: 'Toggle Full Screen' },
      'divider',
      { id: 'ZoomIn', label: 'Increase Zoom' },
      { id: 'ZoomOut', label: 'Decrease Zoom' },
      { id: 'ZoomReset', label: 'Reset Zoom' },
      'divider',
      { id: 'ShowLeftPanel', label: 'Show Left Panel' },
      { id: 'ShowDetailPanel', label: 'Show Commit Details Panel' },
      { id: 'ShowTerminalPanel', label: 'Show Terminal Panel' },
      'divider',
      { id: 'ReloadWindow', label: 'Reload Window' },
    ],
  },
  {
    name: 'Help',
    entries: [
      { id: 'KeyboardShortcuts', label: 'Keyboard Shortcuts' },
      { id: 'OpenFuzzyFinder', label: 'Open Command Palette' },
      { id: 'ViewActivityLogs', label: 'View Activity Logs' },
    ],
  },
];

/** File / Edit / View / Help. `disabled` holds the ids of the rows that cannot act now (they stay visible and do nothing). */
export function MenuBar({ disabled, onRun }: { disabled: ReadonlySet<string>; onRun: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const off = pushOverlay(() => setOpen(null));
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-testid="menubar"]')) setOpen(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => {
      off();
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const menu = MENUS.find((m) => m.name === open);
  return (
    <div className="menubar" data-testid="menubar">
      {MENUS.map((m) => (
        <div key={m.name} className="menubar-slot">
          <button
            type="button"
            className={`menubar-item${open === m.name ? ' open' : ''}`}
            data-testid="menubar-item"
            data-id={m.name}
            aria-haspopup="menu"
            aria-expanded={open === m.name}
            onClick={() => setOpen(open === m.name ? null : m.name)}
            onMouseEnter={() => open && setOpen(m.name)}
          >
            {m.name}
          </button>
          {menu?.name === m.name && (
            <div className="menubar-menu" data-testid="menubar-menu" role="menu">
              {m.entries.map((e, i) =>
                e === 'divider' ? (
                  <div key={`d${i}`} className="menubar-divider" data-testid="menubar-divider" />
                ) : (
                  <button
                    key={e.id}
                    type="button"
                    role="menuitem"
                    className="menubar-entry"
                    data-testid="menubar-entry"
                    data-id={e.id}
                    aria-disabled={disabled.has(e.id)}
                    onClick={() => {
                      if (disabled.has(e.id)) return;
                      setOpen(null);
                      onRun(e.id);
                    }}
                  >
                    <span data-testid="menubar-entry-label">{e.label}</span>
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
