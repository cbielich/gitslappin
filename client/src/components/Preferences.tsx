import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { TerminalCursor, TerminalShell, Theme } from '@gitslappin/shared';
import { api } from '../api';
import { announceAutoFetchMinutes } from '../lib/autoFetchPref';
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

/** GeneralPreferences-AutoFetchInterval / -Help / -Warning (en-us.json). */
const AUTO_FETCH = {
  label: 'Auto-Fetch Interval',
  help: 'In minutes, between 0 and 60 (0 disables auto-fetch). Fetches all visible remotes.',
  warning: 'If you have many visible remotes, this may impact performance.',
} as const;

/** CLIPreferences-* (en-us.json). The two fixed values (Consolas, line height 1.0) and the cut options (dim, autocomplete) are not offered. */
const TERMINAL = {
  title: 'In-App Terminal',
  shell: 'Default In-App Terminal',
  fontSize: 'Font Size',
  cursor: 'Cursor Style',
  help: 'Changes to this setting will only apply to new tabs or after restarting GitSlappin',
} as const;
const CURSORS: Array<{ id: TerminalCursor; label: string }> = [
  { id: 'block', label: 'Block' },
  { id: 'underline', label: 'Underline' },
  { id: 'bar', label: 'Bar' },
];

/** The Preferences screen (Esc or the close button closes it). */
export function Preferences({ theme, onTheme, onClose }: Props) {
  useEffect(() => pushOverlay(onClose), [onClose]);
  const [saved, setSaved] = useState(1);
  const savedRef = useRef(-1);
  const [draft, setDraft] = useState('1');
  const edited = useRef(false);
  const [page, setPage] = useState<'general' | 'terminal'>('general');
  const [shell, setShell] = useState<TerminalShell>('powershell');
  const [cursor, setCursor] = useState<TerminalCursor>('block');
  const [fontSaved, setFontSaved] = useState(13);
  const [fontDraft, setFontDraft] = useState('13');
  const fontEdited = useRef(false);
  const [bash, setBash] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .getPrefs()
      .then((p) => {
        if (!live) return;
        savedRef.current = p.autoFetchMinutes;
        setSaved(p.autoFetchMinutes);
        if (!edited.current) setDraft(String(p.autoFetchMinutes));
        setShell(p.terminalShell);
        setCursor(p.terminalCursor);
        setFontSaved(p.terminalFontSize);
        if (!fontEdited.current) setFontDraft(String(p.terminalFontSize));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    api
      .ping()
      .then((r) => live && setBash(r.terminalBash === true))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const saveTerminal = (patch: { terminalShell: TerminalShell } | { terminalFontSize: number } | { terminalCursor: TerminalCursor }, undo: () => void) => {
    api.putPrefs(patch).catch(undo);
  };
  /** On blur or Enter: a whole number from 10 to 24 is saved; anything else puts the saved value back. */
  const commitFont = () => {
    const text = fontDraft.trim();
    const n = Number(text);
    if (text === '' || !Number.isInteger(n) || n < 10 || n > 24) {
      setFontDraft(String(fontSaved));
      return;
    }
    setFontDraft(String(n));
    if (n === fontSaved) return;
    const before = fontSaved;
    setFontSaved(n);
    saveTerminal({ terminalFontSize: n }, () => {
      setFontSaved(before);
      setFontDraft(String(before));
    });
  };
  /** On blur or Enter: a whole number from 0 to 60 is saved; anything else puts the saved value back. */
  const commitAutoFetch = () => {
    const text = draft.trim();
    const n = Number(text);
    if (text === '' || !Number.isInteger(n) || n < 0 || n > 60) {
      setDraft(String(saved));
      return;
    }
    setDraft(String(n));
    if (n === savedRef.current) return;
    const before = savedRef.current;
    savedRef.current = n;
    setSaved(n);
    api
      .putPrefs({ autoFetchMinutes: n })
      .then(() => announceAutoFetchMinutes(n))
      .catch(() => {
        savedRef.current = before;
        setSaved(before);
        setDraft(String(before));
      });
  };
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
      <nav className="preferences-nav" aria-label="Preferences">
        <button className={`preferences-nav-item${page === 'general' ? ' active' : ''}`} data-testid="preferences-nav-general" onClick={() => setPage('general')}>
          General
        </button>
        <button className={`preferences-nav-item${page === 'terminal' ? ' active' : ''}`} data-testid="preferences-nav-terminal" onClick={() => setPage('terminal')}>
          {TERMINAL.title}
        </button>
      </nav>
      {page === 'terminal' && (
        <section className="preferences-section" data-testid="preferences-section-terminal">
          <h2 className="preferences-section-title">{TERMINAL.title}</h2>
          <div className="preferences-row">
            <label className="preferences-label" htmlFor="pref-terminal-shell">
              {TERMINAL.shell}
            </label>
            <select
              id="pref-terminal-shell"
              className="preferences-select"
              data-testid="pref-terminal-shell"
              value={shell}
              onChange={(e) => {
                const v = e.target.value === 'bash' ? 'bash' : 'powershell';
                const before = shell;
                setShell(v);
                saveTerminal({ terminalShell: v }, () => setShell(before));
              }}
            >
              <option value="powershell">PowerShell</option>
              {(bash || shell === 'bash') && <option value="bash">Git Bash</option>}
            </select>
          </div>
          <p className="preferences-help">{TERMINAL.help}</p>
          <div className="preferences-row">
            <label className="preferences-label" htmlFor="pref-terminal-font-size">
              {TERMINAL.fontSize}
            </label>
            <input
              id="pref-terminal-font-size"
              className="preferences-number"
              type="number"
              min={10}
              max={24}
              step={1}
              data-testid="pref-terminal-font-size"
              value={fontDraft}
              onChange={(e) => {
                fontEdited.current = true;
                setFontDraft(e.target.value);
              }}
              onBlur={commitFont}
              onKeyDown={(e) => e.key === 'Enter' && commitFont()}
            />
          </div>
          <div className="preferences-row">
            <span className="preferences-label">{TERMINAL.cursor}</span>
            <div className="preferences-options" role="radiogroup" aria-label={TERMINAL.cursor}>
              {CURSORS.map((c) => (
                <label key={c.id} className="preferences-option">
                  <input
                    type="radio"
                    name="gitslappin-terminal-cursor"
                    data-testid={`pref-terminal-cursor-${c.id}`}
                    checked={cursor === c.id}
                    onChange={() => {
                      const before = cursor;
                      setCursor(c.id);
                      saveTerminal({ terminalCursor: c.id }, () => setCursor(before));
                    }}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </div>
          <p className="preferences-help">{TERMINAL.help}</p>
        </section>
      )}
      {page === 'general' && (<>
      <section className="preferences-section">
        <h2 className="preferences-section-title" data-testid="preferences-section-general">
          General
        </h2>
        <div className="preferences-row">
          <label className="preferences-label" data-testid="pref-autofetch-label" htmlFor="pref-autofetch-input">
            {AUTO_FETCH.label}
          </label>
          <input
            id="pref-autofetch-input"
            className="preferences-number"
            type="number"
            min={0}
            max={60}
            step={1}
            data-testid="pref-autofetch-input"
            value={draft}
            onChange={(e) => {
              edited.current = true;
              setDraft(e.target.value);
            }}
            onBlur={commitAutoFetch}
            onKeyDown={(e) => e.key === 'Enter' && commitAutoFetch()}
          />
        </div>
        <p className="preferences-help" data-testid="pref-autofetch-help">
          {AUTO_FETCH.help}
        </p>
        <p className="preferences-help preferences-warning" data-testid="pref-autofetch-warning">
          {AUTO_FETCH.warning}
        </p>
      </section>
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
      </>)}
    </div>
  );
}
