import { useEffect, useMemo, useRef, useState } from 'react';
import type { RepoInfo } from '@gitslappin/shared';
import { api } from '../api';
import { fuzzyRank, type Range } from '../lib/fuzzy';
import { visiblePaletteItems } from '../lib/paletteItems';
import { pushOverlay } from '../lib/shortcuts';

export type PaletteMode = 'commands' | 'checkout' | 'open-repo' | 'history' | 'blame';

/** FuzzyFinder-*Placeholder (en-us.json). */
const PLACEHOLDERS: Record<PaletteMode, string> = {
  commands: 'Search for commands and actions (e.g., Open Repo)',
  checkout: 'Search for a branch to checkout',
  'open-repo': 'Search for a repository to open',
  history: 'Search for a file to view its history / blame',
  blame: 'Search for a file to view who did what (i.e. its blame)',
};

/** Rows drawn at once in a long list (a repo can have 5000 files); typing narrows it. */
const MAX_ROWS = 300;

interface Row {
  id: string;
  label: string;
  keywords?: string;
  detail?: string;
}

interface Props {
  mode: PaletteMode;
  hasRepo: boolean;
  repoId: string | null;
  headSha: string | null;
  /** Local branches that are not checked out (Checkout mode). */
  branches: string[];
  onClose: () => void;
  onMode: (m: PaletteMode) => void;
  onRun: (id: string) => void;
  onCheckout: (name: string) => void;
  onOpenRepo: (root: string) => void;
  onOpenFile: (path: string, blame: boolean) => void;
}

function Marked({ text, ranges }: { text: string; ranges: Range[] }) {
  if (ranges.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** The command palette (Actions button, Ctrl+P): commands, or one of the sub-modes (Checkout, Open Repo, History / Blame file finder). */
export function CommandPalette({ mode, hasRepo, repoId, headSha, branches, onClose, onMode, onRun, onCheckout, onOpenRepo, onOpenFile }: Props) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [recent, setRecent] = useState<RepoInfo[] | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => pushOverlay(onClose), [onClose]);

  useEffect(() => {
    setQuery('');
    setSel(0);
    input.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (mode !== 'open-repo') return;
    let live = true;
    setRecent(null);
    api
      .recent()
      .then((r) => live && setRecent(r))
      .catch(() => live && setRecent([]));
    return () => {
      live = false;
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'history' && mode !== 'blame') return;
    if (!repoId || !headSha) {
      setFiles([]);
      return;
    }
    let live = true;
    setFiles(null);
    api
      .commitTree(repoId, headSha)
      .then((t) => live && setFiles(t.files))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [mode, repoId, headSha]);

  const rows = useMemo((): Row[] => {
    switch (mode) {
      case 'commands':
        return visiblePaletteItems(hasRepo).map((i) => ({ id: i.id, label: i.label, ...(i.keywords ? { keywords: i.keywords } : {}) }));
      case 'checkout':
        return branches.map((b) => ({ id: b, label: b }));
      case 'open-repo':
        return (recent ?? []).map((r) => ({ id: r.root, label: r.name, keywords: r.root, detail: r.root }));
      default:
        return (files ?? []).map((f) => ({ id: f, label: f }));
    }
  }, [mode, hasRepo, branches, recent, files]);

  const ranked = useMemo(() => fuzzyRank(rows, query).slice(0, MAX_ROWS), [rows, query]);
  const cur = Math.min(sel, Math.max(0, ranked.length - 1));
  const loading = (mode === 'open-repo' && recent === null) || ((mode === 'history' || mode === 'blame') && files === null);
  /** Enter pressed while the list is still loading runs the first row as soon as it arrives. */
  const enterWhenLoaded = useRef(false);

  useEffect(() => {
    document.querySelector('[data-testid="palette-item"][aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [cur, ranked]);

  const run = (row: Row | undefined) => {
    enterWhenLoaded.current = false;
    if (!row) return;
    if (mode === 'commands') {
      if (row.id === 'checkout') return onMode('checkout');
      if (row.id === 'history') return onMode('history');
      if (row.id === 'blame') return onMode('blame');
      if (row.id === 'open-repo') return onMode('open-repo');
      return onRun(row.id);
    }
    if (mode === 'checkout') return onCheckout(row.id);
    if (mode === 'open-repo') return onOpenRepo(row.id);
    return onOpenFile(row.id, mode === 'blame');
  };

  useEffect(() => {
    if (!loading && enterWhenLoaded.current) run(ranked[0]?.item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(ranked.length - 1, cur + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(0, cur - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (loading) enterWhenLoaded.current = true;
      else run(ranked[cur]?.item);
    }
  };

  return (
    <div className="palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" data-testid="command-palette" data-mode={mode} onKeyDown={onKeyDown}>
        <input
          ref={input}
          className="palette-input"
          data-testid="palette-input"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder={PLACEHOLDERS[mode]}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
        />
        <div className="palette-list" role="listbox">
          {ranked.map(({ item, ranges }, i) => (
            <div
              key={item.id}
              className={`palette-item${i === cur ? ' selected' : ''}`}
              role="option"
              data-testid="palette-item"
              data-id={item.id}
              aria-selected={i === cur}
              onMouseMove={() => setSel(i)}
              onClick={() => run(item)}
            >
              <span className="palette-item-label" data-testid="palette-item-label">
                <Marked text={item.label} ranges={ranges} />
              </span>
              {item.detail && <span className="palette-item-detail">{item.detail}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
