import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, GitCommitHorizontal, Inbox, List, ListTree, Minus, Pencil, Plus, ArrowDownAZ, Trash2 } from 'lucide-react';
import { ignorePattern, type IgnoreMode, type StatusSummary, type WipFile } from '@gitslappin/shared';
import type { MenuEntry } from '../lib/refMenu';
import { IgnoreBar } from './IgnoreBar';
import { readJson, writeJson } from '../lib/storage';
import type { OpenFileHook } from './DetailsPanel';
import { FileList, displayStatus, type Side } from './FileList';
import { useListMode } from '../lib/listMode';
import { registerShortcut } from '../lib/shortcuts';
import { ContextMenu } from './menu/ContextMenu';

const SPLIT_KEY = 'gitslappin-wip-split';
const SUMMARY_LIMIT = 72;
const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;

interface Props {
  wip: StatusSummary;
  branch: string;
  summary: string;
  description: string;
  amend: boolean;
  /** An action is running: the buttons wait. */
  busy: boolean;
  onSummary: (v: string) => void;
  onDescription: (v: string) => void;
  onAmend: (v: boolean) => void;
  onOpenFile: OpenFileHook;
  onStageFile: (f: WipFile) => void;
  onUnstageFile: (f: WipFile) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onCommit: () => void;
  /** V6 Ctrl+Shift+Enter in the message field: stage everything, then commit. */
  onCommitAll: () => void;
  /** Runs a key action now, or when the running change is over. */
  whenIdle: (fn: () => void) => void;
  /** Stash tab: stashes the staged files with this message. Resolves true when a stash was made (the boxes clear). */
  onStash: (message: string) => Promise<boolean>;
  /** Phase 11: the caller shows the confirm bar for these paths (one file or the selection). */
  onDiscard: (paths: string[]) => void;
  /** Phase 11: the trash button of the Unstaged section. */
  onDiscardAll: () => void;
  /** V3: write the ignore pattern for these paths (the server builds the pattern text). */
  onIgnore: (paths: string[], mode: IgnoreMode, untrack: boolean) => Promise<unknown> | void;
}

/** The Stash tab button text (CommitDetailPanel-Tab-Stash-ActionLabel*). */
export function stashButtonLabel(summary: string, stagedCount: number): string {
  if (stagedCount === 0) return 'Stage Changes to Stash';
  if (summary.trim() === '') return 'Type a Message to Stash';
  return stagedCount === 1 ? 'Stash Changes to 1 File' : `Stash Changes to ${stagedCount} Files`;
}

/** The commit button text, in the order GitKraken uses. */
export function commitButtonLabel(summary: string, stagedCount: number, amend: boolean): string {
  if (summary.trim() === '') return 'Type a Message to Commit';
  if (stagedCount === 0 && !amend) return 'Stage Changes to Commit';
  return stagedCount === 1 ? 'Commit Changes to 1 File' : `Commit Changes to ${stagedCount} Files`;
}

export function StagingPanel(p: Props) {
  const { wip } = p;
  const [mode, setMode] = useListMode();
  const [split, setSplit] = useState<number>(() => {
    const v = readJson<number>(SPLIT_KEY, 0.5);
    return typeof v === 'number' && v >= MIN_SPLIT && v <= MAX_SPLIT ? v : 0.5;
  });
  const lists = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<'commit' | 'stash'>('commit');
  const [stashSummary, setStashSummary] = useState('');
  const [stashDescription, setStashDescription] = useState('');

  const unstaged = useMemo(() => wip.files.filter((f) => f.unstaged), [wip.files]);
  const staged = useMemo(() => wip.files.filter((f) => f.staged), [wip.files]);
  const conflicts = wip.conflicted > 0;

  // Selection for the Discard changes menu (ctrl+click adds or removes; a plain click selects just that file).
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; paths: string[]; side: Side } | null>(null);
  // V3 Ignore: a tree folder menu, and the confirm bar for a tracked target.
  const [dirMenu, setDirMenu] = useState<{ x: number; y: number; dir: string } | null>(null);
  const [ask, setAsk] = useState<{ paths: string[]; mode: IgnoreMode; name: string } | null>(null);
  const known = useMemo(() => new Set(wip.files.map((f) => f.path)), [wip.files]);
  const liveSelection = useMemo(() => new Set([...selection].filter((x) => known.has(x))), [selection, known]);
  const toggle = useCallback((f: WipFile) => {
    setSelection((s) => {
      const n = new Set(s);
      if (n.has(f.path)) n.delete(f.path);
      else n.add(f.path);
      return n;
    });
  }, []);
  const onContext = useCallback(
    (f: WipFile, x: number, y: number, side: Side) => {
      const paths = liveSelection.has(f.path) ? [...liveSelection] : [f.path];
      if (!liveSelection.has(f.path)) setSelection(new Set([f.path]));
      setFileMenu({ x, y, paths, side });
    },
    [liveSelection],
  );

  const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
  /** Untracked-only targets are written at once; a tracked one asks first (PromptIgnore-*). */
  const askIgnore = (paths: string[], mode: IgnoreMode, name: string, changed: string[] = paths) => {
    if (paths.length === 0) return;
    const byPath = new Map(unstaged.map((f) => [f.path, f]));
    if (changed.some((x) => byPath.get(x)?.worktreeStatus !== '?')) setAsk({ paths, mode, name });
    else p.onIgnore(paths, mode, false);
  };
  /** Ignore menu entries for the unstaged rows (IgnoreFile, AllFilesWithSameExtension, AllFilesInFolder, IgnoreNFiles). */
  const ignoreEntries = (paths: string[]): MenuEntry[] => {
    const ok = new Set(unstaged.filter((f) => f.worktreeStatus !== 'U' && !f.path.endsWith('/')).map((f) => f.path));
    const targets = paths.filter((x) => ok.has(x));
    if (targets.length === 0) return [];
    const first = targets[0] as string;
    if (targets.length > 1) return [{ type: 'item', id: 'ignore-n', label: `Ignore ${targets.length} files`, run: () => askIgnore(targets, 'file', `${targets.length} files`) }];
    const sub: MenuEntry[] = [{ type: 'item', id: 'ignore-file', label: `Ignore '${base(first)}'`, run: () => askIgnore([first], 'file', base(first)) }];
    const ext = ignorePattern(first, 'ext');
    if (ext) sub.push({ type: 'item', id: 'ignore-ext', label: `All files with the extension '${ext.slice(1)}'`, run: () => askIgnore([first], 'ext', ext) });
    if (ignorePattern(first, 'folder')) {
      const dir = first.slice(0, first.lastIndexOf('/'));
      sub.push({ type: 'item', id: 'ignore-folder', label: `All files in '${base(dir)}/'`, run: () => askIgnore([dir], 'folder', `${base(dir)}/`, [first]) });
    }
    return [{ type: 'item', id: 'ignore', label: 'Ignore', run: () => undefined, submenu: sub }];
  };
  const dirEntries = (dir: string): MenuEntry[] => {
    const under = unstaged.filter((f) => f.worktreeStatus !== 'U' && !f.path.endsWith('/') && f.path.startsWith(`${dir}/`)).map((f) => f.path);
    if (under.length === 0) return [];
    return [{ type: 'item', id: 'ignore-dir', label: `Ignore all files in '${base(dir)}/'`, run: () => askIgnore([dir], 'folder', `${base(dir)}/`, under) }];
  };

  const open = useCallback(
    (side: Side) => (f: WipFile) => {
      setSelection(new Set([f.path]));
      const status = displayStatus(f, side);
      p.onOpenFile({
        source: side,
        path: f.path,
        ...(side === 'staged' && f.oldPath ? { oldPath: f.oldPath } : {}),
        ...(side === 'unstaged' && f.worktreeStatus === '?' ? { untracked: true } : {}),
        status,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.onOpenFile],
  );

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const box = lists.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    let latest = split;
    const move = (ev: PointerEvent) => {
      latest = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, (ev.clientY - rect.top) / rect.height));
      setSplit(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      writeJson(SPLIT_KEY, latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const len = p.summary.length;
  const left = SUMMARY_LIMIT - len;
  const label = commitButtonLabel(p.summary, wip.stagedCount, p.amend);
  const canCommit = p.summary.trim() !== '' && (wip.stagedCount > 0 || p.amend) && !p.busy;
  // Ctrl+Enter (from the summary or description field only; the registry checks the field) commits like the button.
  const commitNow = useRef<() => boolean>(() => false);
  commitNow.current = () => {
    if (tab !== 'commit' || !canCommit) return false;
    p.onCommit();
    return true;
  };
  useEffect(() => registerShortcut('commit', () => commitNow.current()), []);
  // V6: Ctrl+Shift+Enter (message field only) stages all and commits; S / U stage / unstage the selected file(s). The registry blocks repeats and open bars.
  const keysNow = useRef({ unstaged, staged, sel: liveSelection, onStageFile: p.onStageFile, onUnstageFile: p.onUnstageFile });
  keysNow.current = { unstaged, staged, sel: liveSelection, onStageFile: p.onStageFile, onUnstageFile: p.onUnstageFile };
  const keys = useRef<{ commitAll: () => boolean; stage: () => boolean; unstage: () => boolean }>({ commitAll: () => false, stage: () => false, unstage: () => false });
  keys.current = {
    commitAll: () => {
      if (tab !== 'commit' || p.summary.trim() === '' || p.busy || conflicts || (wip.total === 0 && !p.amend)) return false;
      p.onCommitAll();
      return true;
    },
    stage: () => {
      if (conflicts) return false;
      const paths = new Set(keysNow.current.sel); // the selection the user saw at key press; the file itself is looked up when the queue runs
      if (paths.size > 0) p.whenIdle(() => { const f = keysNow.current.unstaged.find((x) => paths.has(x.path)); if (f) keysNow.current.onStageFile(f); });
      return true;
    },
    unstage: () => {
      const paths = new Set(keysNow.current.sel);
      if (paths.size > 0) p.whenIdle(() => { const f = keysNow.current.staged.find((x) => paths.has(x.path)); if (f) keysNow.current.onUnstageFile(f); });
      return true;
    },
  };
  useEffect(() => {
    const offs = [registerShortcut('commitStageAll', () => keys.current.commitAll()), registerShortcut('stageFile', () => keys.current.stage()), registerShortcut('unstageFile', () => keys.current.unstage())];
    return () => offs.forEach((off) => off());
  }, []);

  const stashLabel = stashButtonLabel(stashSummary, wip.stagedCount);
  const canStash = stashSummary.trim() !== '' && wip.stagedCount > 0 && !p.busy;
  const doStash = () => {
    const message = stashDescription.trim() === '' ? stashSummary : `${stashSummary}\n\n${stashDescription}`;
    void p.onStash(message).then((ok) => {
      if (!ok) return;
      setStashSummary('');
      setStashDescription('');
    });
  };

  const section = (side: Side, title: string, files: WipFile[], count: number) => (
    <div className="wip-section" data-testid={`wip-${side}`} style={{ flex: side === 'unstaged' ? `${split} 1 0` : `${1 - split} 1 0` }}>
      <div className="wip-section-head">
        <span>
          {title} (<span data-testid={`wip-${side}-count`}>{count}</span>)
        </span>
        {side === 'unstaged' ? (
          <span className="wip-head-actions">
            <button className="discard-all" data-testid="discard-all" title="Discard all changes" aria-label="Discard all changes" disabled={p.busy || conflicts || wip.files.length === 0 || !!wip.truncated} onClick={p.onDiscardAll}>
              <Trash2 size={13} />
            </button>
            <button className="stage-btn stage" data-testid="stage-all" disabled={p.busy || conflicts || count === 0} onClick={p.onStageAll}>
              Stage All Changes
            </button>
          </span>
        ) : (
          <button className="stage-btn unstage" data-testid="unstage-all" disabled={p.busy || count === 0} onClick={p.onUnstageAll}>
            Unstage All Changes
          </button>
        )}
      </div>
      <div className="wip-section-body">
        <FileList files={files} side={side} mode={mode} onOpen={open(side)} onAction={side === 'unstaged' ? p.onStageFile : p.onUnstageFile} disabled={p.busy} selection={liveSelection} onToggle={toggle} onContext={(f, x, y) => onContext(f, x, y, side)} {...(side === 'unstaged' && mode === 'tree' ? { onDirContext: (dir: string, x: number, y: number) => setDirMenu({ x, y, dir }) } : {})} />
      </div>
    </div>
  );

  return (
    <div className="details staging" data-testid="wip-details">
      <div className="wip-header" data-testid="wip-header">
        {wip.total} file change{wip.total === 1 ? '' : 's'} on <span className="branch-chip">{p.branch}</span>
      </div>
      <div className="file-summary" data-testid="wip-summary">
        {wip.modified > 0 && (
          <span className="summary-item" data-testid="wip-summary-modified">
            <Pencil size={11} className="st st-mod" /> {wip.modified} modified
          </span>
        )}
        {wip.added + wip.untracked > 0 && (
          <span className="summary-item" data-testid="wip-summary-added">
            <Plus size={12} className="st st-add" /> {wip.added + wip.untracked} added
          </span>
        )}
        {wip.deleted > 0 && (
          <span className="summary-item" data-testid="wip-summary-deleted">
            <Minus size={12} className="st st-del" /> {wip.deleted} deleted
          </span>
        )}
        {wip.conflicted > 0 && (
          <span className="summary-item" data-testid="wip-summary-conflicted">
            {wip.conflicted} conflicted
          </span>
        )}
      </div>
      <div className="file-tools">
        <ArrowDownAZ size={14} className="dim" />
        <div className="seg">
          <button className={mode === 'path' ? 'on' : ''} onClick={() => setMode('path')} data-testid="wip-toggle-path">
            <List size={12} /> Path
          </button>
          <button className={mode === 'tree' ? 'on' : ''} onClick={() => setMode('tree')} data-testid="wip-toggle-tree">
            <ListTree size={12} /> Tree
          </button>
        </div>
        <span className="file-tools-gap" />
      </div>
      <div className="wip-lists" ref={lists} data-testid="wip-file-list" data-mode={mode}>
        {section('unstaged', 'Unstaged Files', unstaged, wip.unstagedCount)}
        <div className="split-handle" data-testid="wip-split-handle" role="separator" aria-orientation="horizontal" onPointerDown={startDrag} />
        {section('staged', 'Staged Files', staged, wip.stagedCount)}
      </div>
      {fileMenu && (
        <ContextMenu
          x={fileMenu.x}
          y={fileMenu.y}
          entries={[
            { type: 'item', id: 'discard-changes', label: 'Discard changes', run: () => p.onDiscard(fileMenu.paths) }, // File-Reset
            ...(fileMenu.side === 'unstaged' ? ignoreEntries(fileMenu.paths) : []),
          ]}
          onClose={() => setFileMenu(null)}
        />
      )}
      {dirMenu && <ContextMenu x={dirMenu.x} y={dirMenu.y} entries={dirEntries(dirMenu.dir)} onClose={() => setDirMenu(null)} />}
      {ask && (
        <IgnoreBar
          message={ask.paths.length === 1 || ask.mode === 'folder' ? `Ignore '${ask.name}'?` : `Ignore ${ask.paths.length} files?`}
          onIgnore={() => void Promise.resolve(p.onIgnore(ask.paths, ask.mode, false)).finally(() => setAsk(null))}
          onIgnoreUntrack={() => void Promise.resolve(p.onIgnore(ask.paths, ask.mode, true)).finally(() => setAsk(null))}
          onCancel={() => setAsk(null)}
        />
      )}
      <div className="commit-panel">
        <div className="commit-tabs">
          <button className={`commit-tab${tab === 'commit' ? ' on' : ''}`} data-testid="tab-commit" aria-pressed={tab === 'commit'} onClick={() => setTab('commit')}>
            <GitCommitHorizontal size={14} /> Commit
          </button>
          <button className={`commit-tab${tab === 'stash' ? ' on' : ''}`} data-testid="tab-stash" aria-pressed={tab === 'stash'} onClick={() => setTab('stash')}>
            <Inbox size={14} /> Stash
          </button>
        </div>
        {tab === 'stash' ? (
          <>
            <div className="commit-box">
              <div className="commit-summary-row">
                <input className="commit-summary" data-testid="stash-summary" placeholder="Stash title" value={stashSummary} onChange={(e) => setStashSummary(e.target.value)} />
              </div>
              <textarea className="commit-description" data-testid="stash-description" placeholder="Description" value={stashDescription} onChange={(e) => setStashDescription(e.target.value)} />
            </div>
            <button className={`commit-btn${canStash ? ' ready' : ''}`} data-testid="stash-button" disabled={!canStash} onClick={doStash}>
              {stashLabel}
            </button>
          </>
        ) : (
          <>
        <label className="amend-row">
          <input type="checkbox" checked={p.amend} disabled={p.busy} onChange={(e) => p.onAmend(e.target.checked)} data-testid="commit-amend" />
          Amend previous commit
        </label>
        <div className="commit-box">
          <div className="commit-summary-row">
            <input
              className="commit-summary"
              data-testid="commit-summary"
              placeholder="Commit summary"
              value={p.summary}
              onChange={(e) => p.onSummary(e.target.value)}
            />
            <span className={`commit-countdown${left < 0 ? ' negative' : ''}`} data-testid="commit-countdown" data-negative={left < 0}>
              {left}
            </span>
          </div>
          <textarea className="commit-description" data-testid="commit-description" placeholder="Description" value={p.description} onChange={(e) => p.onDescription(e.target.value)} />
        </div>
        <div className="commit-options">
          <ChevronRight size={14} /> Commit options
        </div>
        <button className={`commit-btn${canCommit ? ' ready' : ''}`} data-testid="commit-button" disabled={!canCommit} onClick={p.onCommit}>
          <GitCommitHorizontal size={14} /> {label}
        </button>
          </>
        )}
      </div>
    </div>
  );
}
