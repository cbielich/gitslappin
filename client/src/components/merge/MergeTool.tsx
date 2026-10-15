import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Save, TriangleAlert, WrapText, X } from 'lucide-react';
import type { MergeToolInfo } from '@gitslappin/shared';
import { ApiRequestError, api } from '../../api';
import { MergeOutput, type MergeOutputHandle } from './MergeOutput';
import { MergeSidePane } from './MergeSidePane';
import { useMergeModel, withEols } from './useMergeModel';

/** Wording from en-us.json: Merge-*, Save, Close, FileViewPanel-*, PromptForMerge-SaveMergeWithUnresolvedConflicts. */
const TEXT = {
  output: 'Output', // Merge-Output
  oneConflict: '(1 conflict)', // Merge-OneConflict
  conflicts: (n: number) => `(${n} conflicts)`, // Merge-XConflicts
  position: (x: number, y: number) => `conflict ${x} of ${y}`, // Merge-ConflictXofY
  binary: 'Binary File', // Merge-BinaryFile
  noAncestor: 'No ancestor file', // Merge-NoAncestorFile
  external: 'Open in external merge tool', // OpenIn + ExternalMergeTool
  save: 'Save',
  close: 'Close',
  wrap: 'Word Wrap', // FileViewPanel-WordWrap
  prev: 'Previous Change', // FileViewPanel-PreviousDiff
  next: 'Next Change', // FileViewPanel-NextDiff
  unresolved: 'You have unresolved conflicts. How would you like to proceed?', // PromptForMerge-SaveMergeWithUnresolvedConflicts
  saveOutput: 'Save Output', // Merge-SaveOutput
  cancel: 'Cancel',
  takeAll: 'Take all', // Merge-TakeAll
  backup: 'Backup of the previous file', // no GitKraken key (invented)
};

interface Props {
  repoId: string;
  path: string;
  onClose: () => void;
  /** After a write: the caller refreshes, then closes the tool. `backup` is the sha of the saved copy of the old file. */
  onSaved: (backup: string) => Promise<void>;
}

export function MergeTool({ repoId, path, onClose, onSaved }: Props) {
  const [info, setInfo] = useState<MergeToolInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const outputRef = useRef<MergeOutputHandle>(null);
  const text = useRef('');
  const m = useMergeModel(info, outputRef);

  useEffect(() => {
    let live = true;
    setInfo(null);
    setError(null);
    api
      .mergeToolInfo(repoId, path)
      .then((i) => live && setInfo(i))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'Request failed.'));
    return () => {
      live = false;
    };
  }, [repoId, path]);

  const run = async (fn: () => Promise<{ backup: string }>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { backup } = await fn();
      await onSaved(backup);
    } catch (e) {
      setError(e instanceof ApiRequestError ? (e.detail ?? e.message) : e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  const doSave = () => {
    if (!info) return;
    setConfirm(false);
    void run(() => api.mergeToolSave(repoId, { path, text: withEols(text.current, info), expectHash: info.workingHash }));
  };
  const onSave = () => {
    if (m.unresolved > 0) setConfirm(true);
    else doSave();
  };
  const take = (side: 'a' | 'b') => info && void run(() => api.mergeToolTake(repoId, { path, side, expectHash: info.workingHash }));

  const count = m.count;
  const header = (
    <div className="merge-header">
      <TriangleAlert size={14} className="st-conflict" />
      <span className="merge-title" data-testid="merge-title">
        {path}
      </span>
      {info && !info.binary && (
        <span className="merge-count" data-testid="merge-count">
          {count === 1 ? TEXT.oneConflict : TEXT.conflicts(count)}
        </span>
      )}
      <span className="merge-spacer" />
      {info && <span className="merge-encoding">UTF-8</span>}
      <button className={`merge-icon-btn${wrap ? ' on' : ''}`} data-testid="merge-wrap" title={TEXT.wrap} aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
        <WrapText size={14} />
      </button>
      {info?.external && (
        <button className="merge-btn external" data-testid="merge-external" disabled={busy} onClick={() => void run(() => api.mergeToolExternal(repoId, path))}>
          {TEXT.external} <ExternalLink size={12} />
        </button>
      )}
      {info && !info.binary && (
        <button className="merge-btn save" data-testid="merge-save" disabled={busy || !info} onClick={onSave}>
          {TEXT.save}
        </button>
      )}
      <button className="merge-close" data-testid="merge-close" title={TEXT.close} onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );

  let body: ReactNode = null;
  if (info?.binary) {
    body = (
      <div className="merge-binary">
        {(['a', 'b'] as const).map((side) => {
          const si = side === 'a' ? info.aInfo : info.bInfo;
          const missing = (side === 'a' ? info.a : info.b) === null;
          return (
            <div key={side} className={`merge-pane merge-pane-${side}`}>
              <div className="merge-pane-head">
                <span className={`merge-badge merge-badge-${side}`} data-testid={`merge-badge-${side}`}>
                  {side.toUpperCase()}
                </span>
                <span className="merge-pane-title" data-testid={`merge-pane-title-${side}`}>
                  {si.stash ? 'Stash' : `Commit ${si.sha}`}
                  {si.branch ? ' on ' : ''}
                  {si.branch && <em className={`merge-branch merge-branch-${side}`}>{si.branch}</em>}
                </span>
              </div>
              <div className="merge-binary-body" data-testid={`merge-pane-${side}`}>
                <div>{TEXT.binary}</div>
                <button className="merge-btn" data-testid={`merge-take-${side}`} disabled={busy || missing} onClick={() => take(side)}>
                  {TEXT.takeAll}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  } else if (info && m.model) {
    const model = m.model;
    const pane = (side: 'a' | 'b') => (
      <MergeSidePane
        key={side}
        side={side}
        path={path}
        text={side === 'a' ? model.aText : model.bText}
        regions={model.conflicts.map((c) => (side === 'a' ? { start: c.aStart, len: c.aLen } : { start: c.bStart, len: c.bLen }))}
        takes={m.takes.map((t) => t[side])}
        missing={(side === 'a' ? info.a : info.b) === null}
        info={side === 'a' ? info.aInfo : info.bInfo}
        wrap={wrap}
        allTaken={m.allTaken(side)}
        onToggle={(i) => m.toggle(i, side)}
        onTakeAll={() => m.takeAll(side)}
        reveal={m.reveal}
      />
    );
    body = (
      <>
        <div className="merge-panes">
          {pane('a')}
          {pane('b')}
        </div>
        <div className="merge-output-area">
          <div className="merge-output-head">
            <span className="merge-output-title" data-testid="merge-output-title">
              {TEXT.output}
            </span>
            {info.base === null && <span className="merge-note">{TEXT.noAncestor}</span>}
            <span className="merge-pos" data-testid="merge-conflict-pos">
              {TEXT.position(count === 0 ? 0 : m.current + 1, count)}
            </span>
            <button className="merge-nav" data-testid="merge-prev" title={TEXT.prev} disabled={count === 0} onClick={() => m.goTo(-1)}>
              <ChevronUp size={12} />
            </button>
            <button className="merge-nav" data-testid="merge-next" title={TEXT.next} disabled={count === 0} onClick={() => m.goTo(1)}>
              <ChevronDown size={12} />
            </button>
          </div>
          <MergeOutput
            ref={outputRef}
            path={path}
            initial={model.initial}
            offsets={model.offsets}
            wrap={wrap}
            onText={(t) => (text.current = t)}
            onEdited={m.markEdited}
          />
        </div>
      </>
    );
  }

  return (
    <section className="merge-tool" data-testid="merge-tool">
      {header}
      {error && (
        <div className="merge-error" data-testid="merge-error" role="alert">
          {error}
        </div>
      )}
      {body}
      {confirm && (
        <div className="confirm-bar" data-testid="merge-save-confirm" role="alertdialog">
          <span>{TEXT.unresolved}</span>
          <button className="confirm-ok" data-testid="merge-save-confirm-ok" onClick={doSave}>
            {TEXT.saveOutput}
          </button>
          <button className="confirm-cancel" data-testid="merge-save-confirm-cancel" onClick={() => setConfirm(false)}>
            {TEXT.cancel}
          </button>
        </div>
      )}
    </section>
  );
}
