import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { Theme } from '@gitslappin/shared';
import { pushOverlay } from '../lib/shortcuts';

interface Props {
  theme: Theme;
  onTheme: (t: Theme) => void;
  onClose: () => void;
}

// "Dark" and "Light" have no GitKraken string (its themes carry brand names); the wording was decided in the phase 13 design.
const THEMES: Array<{ id: Theme; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];

/** The Preferences screen (Esc or the close button closes it). */
export function Preferences({ theme, onTheme, onClose }: Props) {
  useEffect(() => pushOverlay(onClose), [onClose]);
  return (
    <div className="preferences" data-testid="preferences-view" role="dialog" aria-label="Preferences">
      <header className="preferences-header">
        <h1 className="preferences-title" data-testid="preferences-title">
          Preferences
        </h1>
        <button className="icon-btn" aria-label="Close preferences" data-testid="preferences-close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <section className="preferences-section">
        <h2 className="preferences-section-title" data-testid="preferences-section-ui">
          UI Customization
        </h2>
        <div className="preferences-row">
          <span className="preferences-label" data-testid="preferences-theme-label">
            Theme
          </span>
          <div className="preferences-options" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <label key={t.id} className="preferences-option">
                <input type="radio" name="gitslappin-theme" data-testid={`pref-theme-${t.id}`} checked={theme === t.id} onChange={() => onTheme(t.id)} />
                {t.label}
              </label>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
