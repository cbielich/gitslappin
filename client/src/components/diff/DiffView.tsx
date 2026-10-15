import { useEffect, useRef, useState } from 'react';
import { AlignLeft, ArrowDown, ArrowUp, Columns2, FileText, List, Pilcrow, X } from 'lucide-react';
import type { DiffContents, FileDiff } from '@gitslappin/shared';
import { api } from '../../api';
import { diffTargetKey, type DiffTarget } from '../../lib/diffTarget';
import { StatusIcon } from '../DetailsPanel';
import { HunkView } from './HunkView';
import { MonacoPane, type MonacoHandle } from './MonacoPane';

type View = 'hunk' | 'inline' | 'split';

/** Contents above this many characters (both sides) fall back to Hunk View. */
const MAX_MONACO_CHARS = 2 * 1024 * 1024;

/** What the user asked for through a Stage / Unstage control in the diff. */
export type DiffAction =
  | { kind: 'file' }
  | { kind: 'hunk'; hunk: number; header: string }
  | { kind: 'lines'; hunk: number; header: string; lines: number[] };

interface Props {
  repoId: string;
  target: DiffTarget;
  onClose: () => void;
  /** Bumped after a stage or unstage so the diff is read again. */
  refreshKey?: number;
  /** Stage / Unstage controls. Left out for commit diffs. */
  onAction?: (a: DiffAction) => void;
  /** Discard Hunk (phase 11): only given for the unstaged side of a tracked file. */
  onDiscardHunk?: (hunk: number, header: string) => void;
  busy?: boolean;
  /** Called when a diff request ends (loaded or failed), so the caller knows the refresh is done. */
  onSettled?: () => void;
}

type ContentsState = { state: 'loading' } | { state: 'ready'; contents: DiffContents } | { state: 'error'; message: string; status: 'binary' | 'other' };

const errMessage = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

export function DiffView({ repoId, target, onClose, refreshKey = 0, onAction, onDiscardHunk, busy = false, onSettled }: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [ws, setWs] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [view, setView] = useState<View>('hunk');
  const [fileMode, setFileMode] = useState(false);
  const [current, setCurrent] = useState(-1);
  const [count, setCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [contents, setContents] = useState<ContentsState>({ state: 'loading' });
  const cache = useRef<DiffContents | null>(null);
  const loadedSig = useRef('');
  const monaco = useRef<MonacoHandle>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const key = diffTargetKey(target);
  useEffect(() => {
    setCurrent(-1);
  }, [key, view, fileMode]);

  useEffect(() => {
    let stale = false;
    // A refresh after stage/unstage keeps the old diff on screen (and its scroll position) until the new one arrives.
    const sig = `${repoId}|${key}|${full}|${ws}`;
    if (loadedSig.current !== sig) setDiff(null);
    setError(null);
    api
      .diff(repoId, target, { full, ws })
      .then((d) => {
        if (stale) return;
        loadedSig.current = sig;
        setDiff(d);
        onSettledRef.current?.();
      })
      .catch((e: unknown) => {
        if (stale) return;
        setError(errMessage(e, 'Failed to load the diff.'));
        onSettledRef.current?.();
      });
    return () => {
      stale = true;
    };
    // `target` is identified by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, key, full, ws, refreshKey]);

  // The files changed under us (a stage or unstage): the cached contents are stale.
  useEffect(() => {
    cache.current = null;
  }, [refreshKey]);

  const needsContents = fileMode || view !== 'hunk';
  const canShowContents = !!diff && !diff.binary && !diff.tooLarge && !diff.conflicted;
  useEffect(() => {
    if (!needsContents || !canShowContents) return;
    // Both sides are fetched once per opened file; switching views reuses them.
    if (cache.current) {
      setContents({ state: 'ready', contents: cache.current });
      return;
    }
    let stale = false;
    setContents({ state: 'loading' });
    api
      .diffContents(repoId, target)
      .then((c) => {
        if (stale) return;
        if (c.old.length + c.new.length > MAX_MONACO_CHARS) {
          setNotice('This file is too large for this view.');
          setFileMode(false);
          setView('hunk');
          return;
        }
        cache.current = c;
        setContents({ state: 'ready', contents: c });
      })
      .catch((e: unknown) => {
        if (stale) return;
        const message = errMessage(e, 'Failed to load the file.');
        setContents({ state: 'error', message, status: message === 'Binary file' ? 'binary' : 'other' });
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, key, needsContents, canShowContents, refreshKey]);

  const pick = (v: View) => {
    setNotice(null);
    setView(v);
    setFileMode(false);
  };

  const step = (dir: 1 | -1) => {
    if (count === 0 || fileMode) return;
    setCurrent(dir > 0 ? Math.min(count - 1, current + 1) : Math.max(0, current - 1));
    if (view !== 'hunk') monaco.current?.goTo(dir > 0 ? 'next' : 'previous');
  };

  const slash = target.path.lastIndexOf('/');
  const dir = slash >= 0 ? target.path.slice(0, slash + 1) : '';
  const name = target.path.slice(slash + 1);
  const dataView = fileMode ? 'file' : view;
  const noChanges = (diff?.hunks.length ?? 0) === 0;

  const renderBody = () => {
    if (error) return <div className="diff-message error" data-testid="diff-error">{error}</div>;
    if (!diff) return <div className="diff-message">Loading...</div>;
    if (diff.conflicted) {
      return (
        <div className="diff-message" data-testid="diff-conflicted">
          Merge conflicts detected
        </div>
      );
    }
    if (diff.binary) {
      return (
        <div className="diff-message" data-testid="diff-binary">
          Binary file
        </div>
      );
    }
    if (diff.tooLarge) {
      return (
        <div className="diff-message" data-testid="diff-too-large">
          <div>
            This diff is too large to show: {diff.additions + diff.deletions} changed lines (+{diff.additions} -{diff.deletions}).
          </div>
          <button className="btn-outline" data-testid="diff-show-anyway" onClick={() => setFull(true)}>
            Show anyway
          </button>
        </div>
      );
    }
    if (needsContents) {
      if (contents.state === 'loading') return <div className="diff-message">Loading...</div>;
      if (contents.state === 'error') {
        return contents.status === 'binary' ? (
          <div className="diff-message" data-testid="diff-binary">
            Binary file
          </div>
        ) : (
          <div className="diff-message error" data-testid="diff-error">
            {contents.message}
          </div>
        );
      }
      return (
        <MonacoPane
          ref={monaco}
          kind={fileMode ? 'file' : view === 'split' ? 'split' : 'inline'}
          oldText={contents.contents.old}
          newText={contents.contents.new}
          path={target.path}
          wrap={wrap}
          ignoreWhitespace={ws}
          onCount={setCount}
        />
      );
    }
    if (noChanges) {
      return (
        <div className="diff-message" data-testid="diff-empty">
          {diff.oldMode && diff.newMode ? `File Mode Changes from ${diff.oldMode} to ${diff.newMode}` : 'File contents are unchanged.'}
        </div>
      );
    }
    // Whitespace-ignoring diffs have different hunks than the ones git would apply, so no stage controls then.
    const staging =
      (target.source === 'staged' || target.source === 'unstaged') && onAction && !ws
        ? { side: target.source, busy, onAction, ...(target.source === 'unstaged' && onDiscardHunk ? { onDiscard: onDiscardHunk } : {}) }
        : undefined;
    return <HunkView diff={diff} wrap={wrap} current={current} onCount={setCount} staging={staging} />;
  };

  const iconBtn = (id: string, title: string, on: boolean, onClick: () => void, icon: React.ReactNode, disabled = false) => (
    <button className={`diff-tool${on ? ' on' : ''}`} data-testid={id} title={title} aria-label={title} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {icon}
    </button>
  );

  return (
    <div className="diff-view" data-testid="diff-view" data-view={dataView} data-current-change={current}>
      <div className="diff-header">
        <StatusIcon status={target.status} />
        <span className="diff-path" data-testid="diff-path" title={target.oldPath ? `${target.oldPath} -> ${target.path}` : target.path}>
          <span className="file-dir">{dir}</span>
          <span className="file-name">{name}</span>
        </span>
        <span className="diff-spacer" />
        <span className="diff-encoding">UTF-8</span>
        {(target.source === 'staged' || target.source === 'unstaged') && onAction && !diff?.conflicted && (
          <button
            className={`stage-btn ${target.source === 'staged' ? 'unstage' : 'stage'}`}
            data-testid="diff-file-action"
            title={target.source === 'staged' ? 'Unstage File' : 'Stage File'}
            disabled={busy}
            onClick={() => onAction({ kind: 'file' })}
          >
            {target.source === 'staged' ? 'Unstage File' : 'Stage File'}
          </button>
        )}
        <button className="icon-btn" data-testid="diff-close" title="Close" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="diff-toolbar">
        <div className="diff-toolbar-left" />
        <div className="diff-toolbar-center">
          {(target.source === 'staged' || target.source === 'unstaged') && (
            <span className="diff-badge" data-testid="diff-badge">
              {target.source === 'staged' ? 'Staged' : 'Unstaged'}
            </span>
          )}
          <div className="seg">
            <button className={fileMode ? 'on' : ''} data-testid="mode-file" onClick={() => setFileMode(true)}>
              File View
            </button>
            <button className={fileMode ? '' : 'on'} data-testid="mode-diff" onClick={() => setFileMode(false)}>
              Diff View
            </button>
          </div>
        </div>
        <div className="diff-toolbar-right">
          <span className="diff-group">
            {iconBtn('change-prev', 'Previous Change', false, () => step(-1), <ArrowUp size={14} />, fileMode)}
            {iconBtn('change-next', 'Next Change', false, () => step(1), <ArrowDown size={14} />, fileMode)}
          </span>
          <span className="diff-group">
            {iconBtn('view-hunk', 'Hunk View', !fileMode && view === 'hunk', () => pick('hunk'), <FileText size={14} />)}
            {iconBtn('view-inline', 'Inline View', !fileMode && view === 'inline', () => pick('inline'), <List size={14} />)}
            {iconBtn('view-split', 'Split View', !fileMode && view === 'split', () => pick('split'), <Columns2 size={14} />)}
          </span>
          <span className="diff-group">
            {iconBtn('ignore-ws', 'Ignore Leading/Trailing Whitespace', ws, () => setWs((v) => !v), <Pilcrow size={14} />)}
            {iconBtn('word-wrap', 'Word Wrap', wrap, () => setWrap((v) => !v), <AlignLeft size={14} />)}
          </span>
        </div>
      </div>
      {notice && <div className="diff-notice">{notice}</div>}
      <div className="diff-body">{renderBody()}</div>
    </div>
  );
}
