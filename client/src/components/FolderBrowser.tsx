import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { FsEntry, FsListResult } from '@gitslappin/shared';
import { api } from '../api';
import { pushOverlay } from '../lib/shortcuts';

const MAX_SHOWN = 2000;

function FolderIcon() {
  return (
    <svg className="fb-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

function RepoIcon() {
  return (
    <svg className="fb-icon fb-repo-icon" data-testid="folder-browser-repo-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" fill="currentColor" opacity="0.7" />
      <circle cx="6" cy="8" r="1" fill="var(--panel__bg1)" />
      <circle cx="6" cy="11" r="1" fill="var(--panel__bg1)" />
      <circle cx="10" cy="9" r="1" fill="var(--panel__bg1)" />
      <path d="M6 8v3M6 10c0-1 4-.5 4-1" stroke="var(--panel__bg1)" strokeWidth="0.8" fill="none" />
    </svg>
  );
}

/** Modal folder picker. `start` is the folder typed in the Open box (falls back to the default start folder when it does not exist). */
export function FolderBrowser({ start, onClose, onOpen, mode = 'open' }: { start: string; onClose: () => void; onOpen: (path: string) => Promise<void>; mode?: 'open' | 'pick' }) {
  const [result, setResult] = useState<FsListResult | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [first] = useState(start); // the folder typed when Browse was clicked
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => pushOverlay(onClose), [onClose]);

  const load = useCallback(async (path?: string, fallbackToDefault = false) => {
    const mine = ++seq.current;
    // 503 = the server is still reading a folder; retry shortly (bounded) and keep only the newest request.
    for (let tries = 0; ; tries++) {
      try {
        const r = await api.fsList(path);
        if (mine !== seq.current) return;
        setResult(r);
        setSelected(null);
        setError('');
        return;
      } catch (e) {
        if (mine !== seq.current) return;
        if ((e as { status?: number }).status === 503 && tries < 10) {
          await new Promise((done) => setTimeout(done, 200));
          if (mine !== seq.current) return;
          continue;
        }
        if (fallbackToDefault && (e as { status?: number }).status !== 503) return void load(undefined);
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
  }, []);

  // After every load the list gets focus back (keyboard use keeps working).
  useEffect(() => {
    if (result) listRef.current?.focus();
  }, [result]);

  function trapTab(ev: KeyboardEvent) {
    if (ev.key !== 'Tab') return;
    const items = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'));
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (!firstEl || !lastEl) return;
    if (ev.shiftKey && document.activeElement === firstEl) {
      ev.preventDefault();
      lastEl.focus();
    } else if (!ev.shiftKey && document.activeElement === lastEl) {
      ev.preventDefault();
      firstEl.focus();
    }
  }

  useEffect(() => {
    void load(first.trim() || undefined, true);
    listRef.current?.focus();
  }, [load, first]);

  async function open(path: string) {
    setBusy(true);
    setError('');
    try {
      await onOpen(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const entries = result?.entries ?? [];
  const pick = mode === 'pick'; // pick: every folder is entered, and the footer button picks the folder being shown
  const activate = (e: FsEntry) => (e.isRepo && !pick ? void open(e.path) : void load(e.path));
  const up = () => result?.parent && void load(result.parent);

  function onKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Backspace') {
      ev.preventDefault();
      up();
    } else if (ev.key === 'Enter') {
      const e = entries.find((x) => x.path === selected);
      if (e) {
        ev.preventDefault();
        activate(e);
      }
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (entries.length === 0) return;
      const i = entries.findIndex((x) => x.path === selected);
      const n = ev.key === 'ArrowDown' ? Math.min(entries.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      setSelected(entries[n]?.path ?? null);
      listRef.current?.querySelectorAll('.fb-row')[n]?.scrollIntoView({ block: 'nearest' });
    }
  }

  return (
    <div className="fb-scrim">
      <div className="fb-modal" data-testid="folder-browser" role="dialog" aria-label={pick ? 'Select a folder' : 'Select a repository to open'} onKeyDown={trapTab}>
        <h3 className="fb-title" data-testid="folder-browser-title">
          {pick ? 'Select a folder' : 'Select a repository to open'}
        </h3>
        <div className="fb-bar">
          <button type="button" className="btn" data-testid="folder-browser-up" disabled={!result?.parent} onClick={up}>
            Up
          </button>
          <div className="fb-path" data-testid="folder-browser-path" title={result?.display ?? ''}>
            {result?.display ?? ''}
          </div>
        </div>
        {result && result.roots.length > 0 && (
          <div className="fb-roots">
            {result.roots.map((r) => (
              <button type="button" key={r.path} className="fb-root" data-testid="folder-browser-root" data-path={r.path} onClick={() => void load(r.path)}>
                {r.display}
              </button>
            ))}
          </div>
        )}
        <div className="fb-list" data-testid="folder-browser-list" ref={listRef} tabIndex={0} role="listbox" onKeyDown={onKeyDown}>
          {entries.map((e) => (
            <div
              key={e.path}
              className={`fb-row${e.path === selected ? ' selected' : ''}`}
              data-testid="folder-browser-entry"
              data-path={e.path}
              role="option"
              aria-selected={e.path === selected}
              onClick={() => setSelected(e.path)}
              onDoubleClick={() => activate(e)}
            >
              {e.isRepo ? <RepoIcon /> : <FolderIcon />}
              <span className="fb-name">{e.name}</span>
            </div>
          ))}
          {result && entries.length === 0 && (
            <div className="fb-empty" data-testid="folder-browser-empty">
              This folder has no subfolders.
            </div>
          )}
        </div>
        {result?.truncated && (
          <div className="fb-note" data-testid="folder-browser-truncated">
            Only the first {MAX_SHOWN} folders are shown.
          </div>
        )}
        {error && (
          <div className="open-error" data-testid="folder-browser-error" role="alert">
            {error}
          </div>
        )}
        <div className="fb-actions">
          <button type="button" className="btn" data-testid="folder-browser-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-success"
            data-testid="folder-browser-open"
            disabled={busy || !(pick ? result?.path : (selected ?? result?.path))}
            onClick={() => void open(pick ? (result?.display ?? '') : (selected ?? result?.path ?? ''))}
          >
            {pick ? 'Select Folder' /* invented: GitKraken has no string for it */ : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
