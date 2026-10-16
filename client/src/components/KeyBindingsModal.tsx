import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { KEYBINDING_ROWS, type KeyBindingSection } from '../lib/shortcuts';
import { pushOverlay } from '../lib/shortcuts';

/** KeyBindingHeader-* (en-us.json). */
const HEADERS: Record<KeyBindingSection, string> = { RepoActions: 'Repo Actions', Navigation: 'Navigation', FuzzyFinder: 'Command Palette', UI: 'UI' };
const SECTIONS: KeyBindingSection[] = ['RepoActions', 'Navigation', 'FuzzyFinder', 'UI'];

/** The Ctrl+/ list (View-KeyBindings): a filter, four sections, one row per shortcut with its key caps. */
export function KeyBindingsModal({ onClose }: { onClose: () => void }) {
  const [filter, setFilter] = useState('');
  useEffect(() => pushOverlay(onClose), [onClose]);
  const f = filter.trim().toLowerCase();
  const rows = KEYBINDING_ROWS.filter((r) => !f || r.label.toLowerCase().includes(f));
  return (
    <div
      className="fb-scrim"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      // Ctrl+F in this window focuses the filter instead of opening the graph search behind it.
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          (e.currentTarget.querySelector('[data-testid="KeyBindingFilter-Placeholder"]') as HTMLInputElement | null)?.focus();
        }
      }}
    >
      <div className="kb-modal" data-testid="View-KeyBindings" role="dialog" aria-label="Keyboard Shortcuts">
        <div className="rm-header">
          <h3 className="rm-title">Keyboard Shortcuts</h3>
          <button type="button" className="rm-close" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <input className="kb-filter" data-testid="KeyBindingFilter-Placeholder" autoFocus placeholder="Filter shortcuts (Ctrl + F)" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="kb-list">
          {SECTIONS.map((s) => {
            const inSection = rows.filter((r) => r.section === s);
            if (inSection.length === 0) return null;
            return (
              <div key={s}>
                <div className="kb-header" data-testid={`KeyBindingHeader-${s}`}>
                  {HEADERS[s]}
                </div>
                {inSection.map((r) => (
                  <div key={r.id} className="kb-row" data-testid={`KeyBinding-${r.id}`}>
                    <span className="kb-label">{r.label}</span>
                    <span className="kb-keys">
                      {r.keys.map((alt, i) => (
                        <span key={i} className="kb-alt">
                          {i > 0 && <span className="kb-or">or</span>}
                          {alt.map((k) => (
                            <kbd key={k} className="kb-cap">
                              {k}
                            </kbd>
                          ))}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
