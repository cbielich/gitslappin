import { List, ListTree, ScrollText } from 'lucide-react';
import { useListMode } from '../lib/listMode';

interface Props {
  zoom: number;
  /** Set when a repository is open: the Activity Logs button shows then. */
  logOpen?: boolean;
  onToggleLog?: () => void;
}

export function StatusBar({ zoom, logOpen = false, onToggleLog }: Props) {
  const [mode, setMode] = useListMode();
  return (
    <footer className="statusbar" data-testid="statusbar">
      <div className="statusbar-left">
        {onToggleLog && (
          <button className={`statusbar-btn${logOpen ? ' on' : ''}`} data-testid="activity-log-button" title="Activity Logs" aria-label="Activity Logs" aria-expanded={logOpen} onClick={onToggleLog}>
            <ScrollText size={12} />
          </button>
        )}
      </div>
      <div className="statusbar-right">
        <button className={`statusbar-btn${mode === 'path' ? ' on' : ''}`} data-testid="statusbar-view-list" title="List" aria-label="List" aria-pressed={mode === 'path'} onClick={() => setMode('path')}>
          <List size={12} />
        </button>
        <button className={`statusbar-btn${mode === 'tree' ? ' on' : ''}`} data-testid="statusbar-view-tree" title="Tree" aria-label="Tree" aria-pressed={mode === 'tree'} onClick={() => setMode('tree')}>
          <ListTree size={12} />
        </button>
        <span data-testid="statusbar-zoom">{`🔍 ${Math.round(zoom * 100)}%`}</span>
        <span data-testid="statusbar-version">{`v${__APP_VERSION__}`}</span>
      </div>
    </footer>
  );
}
