import { useMemo, useState } from 'react';
import { ArrowDownAZ, ChevronDown, ChevronRight, CircleCheck, Folder, GitCommitHorizontal, List, ListTree, TriangleAlert } from 'lucide-react';
import type { OpState, StatusSummary, WipFile } from '@gitslappin/shared';
import { PathLabel, type OpenFileHook } from './DetailsPanel';
import { buildTree, displayStatus, flattenTree, type Entry, type ListMode } from './FileList';

const SUMMARY_LIMIT = 72;

/** Wording from en-us.json (see build-notes, Phase 6). */
const TEXT = {
  merge: 'Merge conflicts detected', // RightPanel-MergeConflictsDetected
  rebase: 'Rebase conflicts detected', // RightPanel-RebaseConflictsDetected
  conflicted: 'Conflicted Files', // UncommittedFileList-ConflictedFilesTitleSummary
  resolved: 'Resolved Files', // UncommittedFileList-UnconflictedFilesTitleSummary
  markAll: 'Mark All Resolved',
  markOne: 'Mark resolved', // MarkAsResolved
  noChanges: 'No Changes to Merge', // DisabledMergeButtonLabel
  commitMerge: 'Commit and Merge', // CommitAndMergeButtonLabel
  abortMerge: 'Abort Merge',
  abortRebase: 'Abort Rebase',
  // Spec 5.5's inferred wording (no GitKraken key): the merge and rebase texts with the operation's name.
  cherryPick: 'Cherry-pick conflicts detected',
  abortCherryPick: 'Abort Cherry-pick',
  revert: 'Revert conflicts detected',
  abortRevert: 'Abort Revert',
  skip: 'Skip Commit', // SkipCommitButtonLabel
  continueRebase: 'Continue Rebase', // ContinueRebaseButtonLabel
};

/** "Rebasing commit {0} out of {1}" (Rebasing-CommitLabel). */
export const rebasingLabel = (step: number, total: number): string => `Rebasing commit ${step} out of ${total}`;

interface Props {
  wip: StatusSummary;
  op: OpState;
  summary: string;
  description: string;
  busy: boolean;
  onSummary: (v: string) => void;
  onDescription: (v: string) => void;
  onOpenFile: OpenFileHook;
  /** A conflicted file opens the merge tool. */
  onOpenMerge: (path: string) => void;
  onMarkResolved: (paths: string[]) => void;
  /** Commit and Merge (the normal commit route; the server strips the "#" lines). */
  onCommit: () => void;
  onContinue: () => void;
  /** Skip Commit: the caller shows the confirm bar. */
  onSkip: () => void;
  onAbort: () => void;
}

export function ConflictPanel(p: Props) {
  const { wip, op } = p;
  const rebase = op.kind === 'rebase';
  // A conflicted stash apply or pop: only the files to resolve. There is nothing to commit and nothing to abort.
  const stash = op.kind === 'stash';
  const pickKind = op.kind === 'cherry-pick' || op.kind === 'revert';
  const title = { merge: TEXT.merge, rebase: TEXT.rebase, 'cherry-pick': TEXT.cherryPick, revert: TEXT.revert, stash: TEXT.merge }[op.kind];
  const abortLabel = { merge: TEXT.abortMerge, rebase: TEXT.abortRebase, 'cherry-pick': TEXT.abortCherryPick, revert: TEXT.abortRevert, stash: '' }[op.kind];
  const [mode, setMode] = useState<ListMode>('path');
  const conflicted = useMemo(() => wip.files.filter((f) => f.status === 'U'), [wip.files]);
  const resolved = useMemo(() => wip.files.filter((f) => f.status !== 'U'), [wip.files]);
  // A merge whose conflicts were all resolved to HEAD's content has nothing staged but can still be committed (MERGE_HEAD exists).
  const ready = conflicted.length === 0 && (wip.stagedCount > 0 || op.kind === 'merge');

  const open = (f: WipFile) => {
    if (f.status === 'U') p.onOpenMerge(f.path);
    else if (f.staged) p.onOpenFile({ source: 'staged', path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: displayStatus(f, 'staged') });
    else p.onOpenFile({ source: 'unstaged', path: f.path, ...(f.worktreeStatus === '?' ? { untracked: true } : {}), status: displayStatus(f, 'unstaged') });
  };

  const row = (f: WipFile, isConflict: boolean, indent: number, nameOnly: boolean) => (
    <div
      key={f.path}
      className="file-row conflict-file"
      role="button"
      tabIndex={0}
      data-testid="conflict-file-row"
      data-path={f.path}
      style={{ paddingLeft: indent }}
      title={f.path}
      onClick={() => open(f)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open(f);
      }}
    >
      {isConflict ? <TriangleAlert size={12} className="st st-conflict" /> : <CircleCheck size={12} className="st st-resolved" />}
      {nameOnly ? <span className="file-name">{f.path.slice(f.path.lastIndexOf('/') + 1)}</span> : <PathLabel path={f.path} />}
      <span className="file-spacer" />
      {isConflict && (
        <button
          className="stage-btn mark-btn"
          data-testid="mark-resolved"
          title={TEXT.markOne}
          disabled={p.busy}
          onClick={(e) => {
            e.stopPropagation();
            p.onMarkResolved([f.path]);
          }}
        >
          {TEXT.markOne}
        </button>
      )}
    </div>
  );

  const list = (files: WipFile[], isConflict: boolean) => {
    const entries: Entry[] = mode === 'tree' ? flattenTree(buildTree(files), 0, '', []) : files.map((f) => ({ kind: 'file' as const, key: f.path, file: f, depth: 0 }));
    return entries.map((e) =>
      e.kind === 'dir' ? (
        <div key={e.key} className="tree-dir" data-testid="wip-tree-dir" style={{ paddingLeft: 8 + e.depth * 14 }}>
          <Folder size={12} /> {e.name}
        </div>
      ) : (
        row(e.file, isConflict, mode === 'tree' ? 8 + e.depth * 14 : 8, mode === 'tree')
      ),
    );
  };

  // "Merging {0} into {1}" / "Rebasing {0} onto {1}" (ConflictsHeader-*)
  const first = rebase ? op.head : (op.other ?? '');
  const second = rebase ? (op.onto ?? '') : op.head;
  const left = SUMMARY_LIMIT - p.summary.length;

  const mainLabel = rebase ? (ready ? TEXT.continueRebase : TEXT.skip) : ready ? TEXT.commitMerge : TEXT.noChanges;
  const mainEnabled = !p.busy && (rebase || (ready && p.summary.trim() !== ''));
  const onMain = rebase ? (ready ? p.onContinue : p.onSkip) : p.onCommit;

  return (
    <div className="details staging conflict-panel" data-testid="conflict-panel">
      <div className="conflict-header">
        <TriangleAlert size={16} className="st-conflict" />
        <span data-testid="conflict-title">{title}</span>
      </div>
      {!stash && !pickKind && (
      <div className="conflict-subtitle" data-testid="conflict-subtitle">
        {rebase ? 'Rebasing ' : 'Merging '}
        <span className="conflict-pill head-a" data-testid={rebase ? 'conflict-pill-head' : 'conflict-pill-other'}>
          {first}
        </span>
        {rebase ? ' onto ' : ' into '}
        <span className="conflict-pill head-b" data-testid={rebase ? 'conflict-pill-other' : 'conflict-pill-head'}>
          {second}
        </span>
      </div>
      )}
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
      <div className="wip-lists">
        <div className="wip-section" data-testid="conflict-conflicted" style={{ flex: '1 1 0' }}>
          <div className="wip-section-head">
            <span className="conflict-section-title">
              <ChevronDown size={12} /> {TEXT.conflicted} ({conflicted.length})
            </span>
            {conflicted.length > 0 && (
              <button className="stage-btn mark-btn always" data-testid="mark-all-resolved" disabled={p.busy} onClick={() => p.onMarkResolved(conflicted.map((f) => f.path))}>
                {TEXT.markAll}
              </button>
            )}
          </div>
          <div className="wip-section-body">{list(conflicted, true)}</div>
        </div>
        <div className="wip-section" data-testid="conflict-resolved" style={{ flex: '1 1 0' }}>
          <div className="wip-section-head">
            <span className="conflict-section-title">
              <ChevronDown size={12} /> {TEXT.resolved} ({resolved.length})
            </span>
          </div>
          <div className="wip-section-body">{list(resolved, false)}</div>
        </div>
      </div>
      {!stash && (
      <div className="commit-panel">
        <div className="commit-tabs">
          <span className="commit-tab on">
            <GitCommitHorizontal size={14} /> Commit
          </span>
        </div>
        {!rebase && (
          <label className="amend-row">
            <input type="checkbox" checked={false} disabled readOnly data-testid="commit-amend" />
            Amend previous commit
          </label>
        )}
        <div className="commit-box">
          {rebase && op.step !== undefined && op.total !== undefined && (
            <div className="rebase-commit-label" data-testid="rebase-commit-label">
              {rebasingLabel(op.step, op.total)}
            </div>
          )}
          <div className="commit-summary-row">
            <input className="commit-summary" data-testid="commit-summary" placeholder="Commit summary" value={p.summary} onChange={(e) => p.onSummary(e.target.value)} />
            <span className={`commit-countdown${left < 0 ? ' negative' : ''}`} data-testid="commit-countdown" data-negative={left < 0}>
              {left}
            </span>
          </div>
          <textarea className="commit-description" data-testid="commit-description" placeholder="Description" value={p.description} onChange={(e) => p.onDescription(e.target.value)} />
        </div>
        <div className="commit-options">
          <ChevronRight size={14} /> Commit options
        </div>
        <div className="op-buttons">
          <button className={`commit-btn${mainEnabled ? ' ready' : ''}`} data-testid="commit-button" disabled={!mainEnabled} onClick={onMain}>
            {mainLabel}
          </button>
          {!stash && (
            <button className="commit-btn abort" data-testid="op-abort" disabled={p.busy} onClick={p.onAbort}>
              {abortLabel}
            </button>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
