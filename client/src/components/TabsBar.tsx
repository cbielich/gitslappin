import { Bell, Folder, GitBranch, Plus, Settings, X } from 'lucide-react';
import type { RepoInfo } from '@gitslappin/shared';

interface Props {
  tabs: RepoInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onPreferences: () => void;
}

export function TabsBar({ tabs, activeId, onSelect, onClose, onAdd, onPreferences }: Props) {
  return (
    <div className="tabsbar" data-testid="tabsbar">
      <Folder size={14} className="tabsbar-folder" />
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={`tab${t.id === activeId ? ' active' : ''}`}
            data-testid="repo-tab"
            title={t.root}
            onClick={() => onSelect(t.id)}
          >
            <GitBranch size={12} className="tab-icon" />
            <span className="tab-name" data-testid="repo-tab-name">
              {t.name}
            </span>
            <button
              className="icon-btn"
              data-testid="repo-tab-close"
              aria-label={`Close ${t.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="icon-btn tab-add" data-testid="tab-add" aria-label="Open repository" onClick={onAdd}>
          <Plus size={14} />
        </button>
      </div>
      <div className="tabsbar-right">
        <button className="icon-btn" aria-label="Notifications" data-testid="bell">
          <Bell size={14} />
        </button>
        <button className="icon-btn" aria-label="Preferences" data-testid="gear" onClick={onPreferences}>
          <Settings size={14} />
        </button>
      </div>
    </div>
  );
}
