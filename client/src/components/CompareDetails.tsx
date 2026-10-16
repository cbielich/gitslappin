import { useEffect, useMemo, useState } from 'react';
import { ArrowDownAZ, List, ListTree } from 'lucide-react';
import { compareMode, type ChangedFile, type LogCommit } from '@gitslappin/shared';
import { api } from '../api';
import type { DiffTarget } from '../lib/diffTarget';
import { formatAuthored, identiconUri, shortSha } from '../lib/identicon';
import { useListMode } from '../lib/listMode';
import { FileRow, StatusIcon, SUMMARY, TreeView, buildTree, type ListFile, type OpenFileHook } from './DetailsPanel';

/** More cards than this are cut off with an "and N more" line (the wording is ours: GitKraken has no string for it). */
const MAX_CARDS = 200;

interface Props {
  repoId: string;
  shas: string[];
  wip: boolean;
  /** The loaded graph rows, newest first. */
  commits: LogCommit[];
  headSha: string | null;
  onOpenFile: OpenFileHook;
}

type FilesState = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; files: ChangedFile[]; truncated: boolean } | { state: 'error'; message: string };

/** Right panel for a multi selection: the commits and, when the selection allows it, the combined file changes. */
export function CompareDetails({ repoId, shas, wip, commits, headSha, onOpenFile }: Props) {
  const [mode, setMode] = useListMode();
  const [files, setFiles] = useState<FilesState>({ state: 'idle' });
  const bySha = useMemo(() => new Map(commits.map((c) => [c.sha, c])), [commits]);
  const cmp = useMemo(() => compareMode({ kind: 'multi', shas, wip }, commits, headSha), [shas, wip, commits, headSha]);

  const total = shas.length + (wip ? 1 : 0);
  const title =
    cmp.mode === 'pair'
      ? 'Viewing diff between 2 commits'
      : cmp.mode === 'range'
        ? `Viewing diff of ${shas.length} commits`
        : cmp.mode === 'wip'
          ? 'Viewing diff between a commit and the WIP'
          : cmp.mode === 'wipRange'
            ? `Viewing diff of ${shas.length} commits and uncommitted changes`
            : 'A combined diff is not shown for this selection. Select a contiguous range of commits, or one or two items, to see their changes.';

  // One compare call per selection.
  const toKey = cmp.mode === 'pair' || cmp.mode === 'range' ? cmp.head : null;
  useEffect(() => {
    if (cmp.mode === 'none' || !cmp.base) {
      setFiles({ state: 'idle' });
      return;
    }
    let stale = false;
    setFiles({ state: 'loading' });
    api
      .compare(repoId, cmp.base, toKey ?? null)
      .then((r) => !stale && setFiles({ state: 'ready', files: r.files, truncated: r.truncated }))
      .catch((e: unknown) => !stale && setFiles({ state: 'error', message: e instanceof Error ? e.message : 'Failed to load files.' }));
    return () => {
      stale = true;
    };
  }, [repoId, cmp.mode, cmp.base, toKey]);

  const sorted = useMemo(() => (files.state === 'ready' ? files.files.slice().sort((a, b) => a.path.localeCompare(b.path)) : []), [files]);
  const tree = useMemo(() => buildTree(sorted), [sorted]);
  const cards = shas.slice(0, MAX_CARDS).flatMap((s) => {
    const c = bySha.get(s);
    return c ? [c] : [];
  });

  const open = (f: ListFile) => {
    if (f.status === null || !cmp.base) return;
    const common = { path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status };
    if (cmp.mode === 'pair' || cmp.mode === 'range') {
      if (cmp.head) onOpenFile({ source: 'commit', sha: cmp.head, base: cmp.base, ...common } satisfies DiffTarget);
    } else {
      onOpenFile({ source: 'workdir', sha: cmp.base, ...common } satisfies DiffTarget);
    }
  };

  return (
    <div className="details compare-details" data-testid="compare-details">
      <div className="compare-header" data-testid="compare-header">
        {total} commits selected
      </div>
      <div className="compare-title" data-testid="compare-title">
        {title}
      </div>
      <div className="compare-cards">
        {cards.map((c) => (
          <div className="compare-card" data-testid="compare-card" data-sha={c.sha} key={c.sha}>
            <img className="author-avatar" src={identiconUri(c.authorEmail)} alt="" width={28} height={28} />
            <div className="compare-card-text">
              <div className="compare-card-summary">{c.subject}</div>
              <div className="compare-card-meta">
                {formatAuthored(c.authorDate)} by {c.authorName}
              </div>
            </div>
            <span className="mono compare-card-sha">{shortSha(c.sha)}</span>
          </div>
        ))}
        {shas.length > MAX_CARDS && (
          <div className="compare-more" data-testid="compare-more">
            and {shas.length - MAX_CARDS} more
          </div>
        )}
      </div>
      {files.state === 'loading' && <div className="details-loading">Loading...</div>}
      {files.state === 'error' && <div className="details-error" data-testid="compare-error">{files.message}</div>}
      {files.state === 'ready' && (
        <>
          <div className="file-summary" data-testid="file-summary">
            {SUMMARY.map((s) => {
              const n = files.files.filter((f) => s.status.includes(f.status)).length;
              if (n === 0) return null;
              return (
                <span key={s.id} className="summary-item">
                  <StatusIcon status={s.status[0] ?? 'M'} /> {n} {s.label}
                </span>
              );
            })}
            {files.files.length === 0 && <span className="summary-item dim">No file changes</span>}
          </div>
          <div className="file-tools">
            <ArrowDownAZ size={14} className="dim" />
            <div className="seg">
              <button className={mode === 'path' ? 'on' : ''} onClick={() => setMode('path')}>
                <List size={12} /> Path
              </button>
              <button className={mode === 'tree' ? 'on' : ''} onClick={() => setMode('tree')}>
                <ListTree size={12} /> Tree
              </button>
            </div>
          </div>
          <div className="file-list" data-testid="compare-file-list" data-mode={mode}>
            {mode === 'path' ? sorted.map((f) => <FileRow key={f.path} file={f} onOpen={open} />) : <TreeView node={tree} depth={0} onOpen={open} />}
            {files.truncated && <div className="details-loading">Showing the first {sorted.length} files.</div>}
          </div>
        </>
      )}
    </div>
  );
}
