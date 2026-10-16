import { useEffect, useMemo, useState } from 'react';
import type { PullMode } from '@gitslappin/shared';
import {
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Inbox,
  Loader2,
  Redo2,
  Search,
  SquareTerminal,
  Undo2,
  Zap,
  type LucideIcon,
} from 'lucide-react';

function ToolButton({ label, Icon, caret, onClick, disabled, title }: { label: string; Icon: LucideIcon; caret?: boolean; onClick?: () => void; disabled?: boolean; title?: string }) {
  return (
    <button className="tool-btn" disabled={!onClick || disabled === true} onClick={onClick} title={title} data-testid={`tool-${label.toLowerCase()}`}>
      <span className="tool-label">{label}</span>
      <span className="tool-icon">
        <Icon size={16} />
        {caret && <ChevronDown size={10} className="tool-caret" />}
      </span>
    </button>
  );
}

/** What RepoView tells the toolbar about Pull and Push. */
export interface RemoteToolbarState {
  pullMode: PullMode;
  /** A remote request is in flight (the spinner shows). */
  remoteBusy: boolean;
  /** Any change is running. */
  busy: boolean;
  detached: boolean;
  /** A merge, rebase, cherry-pick or revert is stopped. */
  opActive: boolean;
  /** Stash needs changes in the tree and no stopped operation; Pop needs a stash. */
  canStash: boolean;
  canPop: boolean;
  /** What the next Undo / Redo would do (the tooltip text after "Undo "), or null when there is nothing to do. */
  undoLabel: string | null;
  redoLabel: string | null;
}

/** Pull menu items (PullOptions-* texts). */
const PULL_ITEMS: { mode: PullMode | 'fetch'; label: string }[] = [
  { mode: 'fetch', label: 'Fetch All' }, // PullOptions-FetchAll
  { mode: 'merge', label: 'Pull (fast-forward if possible)' }, // PullOptions-Merge
  { mode: 'ff-only', label: 'Pull (fast-forward only)' }, // PullOptions-FastForwardOnly
  { mode: 'rebase', label: 'Pull (rebase)' }, // PullOptions-Rebase
];
/** Toolbar-Pull*NotAvailableInDetachedHead */
const DETACHED_PULL: Record<PullMode, string> = {
  merge: 'Pull (fast-forward if possible) is not available when in a detached HEAD state',
  'ff-only': 'Pull (fast-forward only) is not available when in a detached HEAD state',
  rebase: 'Pull (rebase) is not available when in a detached HEAD state',
};
const DETACHED_PUSH = 'Push is not available when in a detached HEAD state'; // Toolbar-PushNotAvailableInDetachedHead

interface ToolbarProps {
  repoName?: string;
  branchName?: string;
  /** Local branches for the branch picker (undefined = no repository open). */
  localBranches?: { name: string; current: boolean }[];
  onCheckoutLocal?: (name: string) => void;
  /** Set when the Branch button is available (HEAD has a commit). */
  onBranch?: () => void;
  remote?: RemoteToolbarState;
  onPull?: () => void;
  onPickPullMode?: (m: PullMode | 'fetch') => void;
  onPush?: () => void;
  onStash?: () => void;
  onPop?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  /** V6: the Terminal button (show/hide the in-app terminal panel; undefined = disabled), Actions (the palette) and Search (commit search). */
  onTerminal?: () => void;
  onActions?: () => void;
  onSearch?: () => void;
}

function PullSplit({ remote, onPull, onPick }: { remote: RemoteToolbarState; onPull?: () => void; onPick?: (m: PullMode | 'fetch') => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.pull-wrap')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const off = remote.busy || remote.remoteBusy || remote.opActive;
  return (
    <div className="pull-wrap">
      <ToolButton label="Pull" Icon={ArrowDownToLine} disabled={off || remote.detached} {...(onPull ? { onClick: onPull } : {})} {...(remote.detached ? { title: DETACHED_PULL[remote.pullMode] } : {})} />
      <button className="pull-caret" data-testid="pull-options-toggle" disabled={remote.busy || remote.remoteBusy || !onPick} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="pull-menu" data-testid="pull-options" role="menu">
          <div className="pull-menu-header" data-testid="pull-options-header">
            Select a default pull/fetch operation to execute when clicking this button
          </div>
          {PULL_ITEMS.map((it) => (
            <button
              key={it.mode}
              className="pull-menu-item"
              role="menuitem"
              data-testid="pull-option"
              data-mode={it.mode}
              {...(it.mode === remote.pullMode ? { 'data-default': 'true' } : {})}
              disabled={it.mode !== 'fetch' && (remote.detached || remote.opActive)}
              onClick={() => {
                setOpen(false);
                onPick?.(it.mode);
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BranchPicker({ branchName, locals, onPick }: { branchName?: string; locals: { name: string; current: boolean }[]; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.picker-wrap')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return [...locals].sort((a, b) => a.name.localeCompare(b.name)).filter((b) => !f || b.name.toLowerCase().includes(f));
  }, [locals, filter]);
  return (
    <div className="picker-wrap">
      <button
        className="picker-value picker-btn"
        data-testid="toolbar-branch"
        disabled={branchName === undefined}
        onClick={() => {
          setFilter('');
          setOpen((o) => !o);
        }}
      >
        {branchName ?? '—'} <ChevronDown size={10} />
      </button>
      {open && (
        <div className="branch-picker" data-testid="branch-picker">
          <input className="branch-picker-filter" data-testid="branch-picker-filter" autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="branch-picker-list">
            {shown.map((b) => (
              <button
                key={b.name}
                className={`branch-picker-item${b.current ? ' current' : ''}`}
                data-testid="branch-picker-item"
                data-name={b.name}
                onClick={() => {
                  setOpen(false);
                  if (!b.current) onPick(b.name);
                }}
              >
                {b.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Toolbar({ repoName, branchName, localBranches, onCheckoutLocal, onBranch, remote, onPull, onPickPullMode, onPush, onStash, onPop, onUndo, onRedo, onTerminal, onActions, onSearch }: ToolbarProps) {
  return (
    <div className="toolbar" data-testid="toolbar">
      <div className="toolbar-left">
        <div className="picker">
          <span className="picker-label">repository</span>
          <span className="picker-value" data-testid="toolbar-repo">
            {repoName ?? '—'} <ChevronDown size={10} />
          </span>
        </div>
        <ChevronRight size={12} className="picker-sep" />
        <div className="picker">
          <span className="picker-label">branch</span>
          <BranchPicker branchName={branchName} locals={localBranches ?? []} onPick={(n) => onCheckoutLocal?.(n)} />
        </div>
      </div>
      <div className="toolbar-center">
        <ToolButton
          label="Undo"
          Icon={Undo2}
          title={remote?.undoLabel ? `Undo ${remote.undoLabel}` : 'Cannot undo'} // UndoValidButtonTooltip / UndoCannotButtonTooltip
          {...(remote && onUndo ? { onClick: onUndo } : {})}
          disabled={!remote?.undoLabel || remote.busy || remote.remoteBusy || remote.opActive}
        />
        <ToolButton
          label="Redo"
          Icon={Redo2}
          title={remote?.redoLabel ? `Redo ${remote.redoLabel}` : 'Cannot redo'} // RedoValidButtonTooltip / RedoCannotButtonTooltip
          {...(remote && onRedo ? { onClick: onRedo } : {})}
          disabled={!remote?.redoLabel || remote.busy || remote.remoteBusy || remote.opActive}
        />
        {remote ? (
          <PullSplit remote={remote} {...(onPull ? { onPull } : {})} {...(onPickPullMode ? { onPick: onPickPullMode } : {})} />
        ) : (
          <ToolButton label="Pull" Icon={ArrowDownToLine} />
        )}
        <ToolButton
          label="Push"
          Icon={ArrowUpToLine}
          {...(remote && onPush ? { onClick: onPush } : {})}
          disabled={!remote || remote.busy || remote.remoteBusy || remote.opActive || remote.detached}
          {...(remote?.detached ? { title: DETACHED_PUSH } : {})}
        />
        <ToolButton label="Branch" Icon={GitBranch} {...(onBranch ? { onClick: onBranch } : {})} />
        <ToolButton label="Stash" Icon={Inbox} title="Stash" {...(remote && onStash ? { onClick: onStash } : {})} disabled={!remote?.canStash} />
        <ToolButton label="Pop" Icon={ArchiveRestore} title="Pop Stash" {...(remote && onPop ? { onClick: onPop } : {})} disabled={!remote?.canPop} />
        <span className="toolbar-divider" />
        <ToolButton label="Terminal" Icon={SquareTerminal} {...(onTerminal ? { onClick: onTerminal, title: 'Show/Hide Terminal (Ctrl + `)' } : {})} />
      </div>
      <div className="toolbar-right">
        {remote?.remoteBusy && (
          <span className="toolbar-busy" data-testid="toolbar-busy" role="status">
            <Loader2 size={16} />
          </span>
        )}
        <ToolButton label="Actions" Icon={Zap} title="Command Palette (Ctrl + P)" {...(onActions ? { onClick: onActions } : {})} />
        <ToolButton label="Search" Icon={Search} {...(onSearch ? { onClick: onSearch } : {})} />
      </div>
    </div>
  );
}
