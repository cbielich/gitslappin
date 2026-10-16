import { useEffect, useMemo, useState } from 'react';
import { ArrowDownAZ, Folder, List, ListTree, Minus, Pencil, Plus, ArrowRight } from 'lucide-react';
import type { CommitDetail, FileStatus } from '@gitslappin/shared';
import { api } from '../api';
import type { DiffTarget } from '../lib/diffTarget';
import { formatAuthored, identiconUri, shortSha } from '../lib/identicon';
import { useListMode } from '../lib/listMode';
import { RewordEditor } from './RewordEditor';

export type OpenFileHook = (target: DiffTarget) => void;

/** A file in the right-panel list. `status` is null for files the commit did not change ("View all files"). */
export interface ListFile {
  status: FileStatus | null;
  path: string;
  oldPath?: string;
}

export function StatusIcon({ status }: { status: string | null }) {
  if (status === null) return <span className="st st-none" />;
  if (status === 'A' || status === '?') return <Plus size={12} className="st st-add" />;
  if (status === 'D') return <Minus size={12} className="st st-del" />;
  if (status === 'R' || status === 'C') return <ArrowRight size={12} className="st st-ren" />;
  return <Pencil size={11} className="st st-mod" />;
}

export function PathLabel({ path }: { path: string }) {
  const i = path.lastIndexOf('/');
  return (
    <span className="file-path">
      {i >= 0 && <span className="file-dir">{path.slice(0, i + 1)}</span>}
      <span className="file-name">{path.slice(i + 1)}</span>
    </span>
  );
}

interface TreeNode {
  name: string;
  dirs: Map<string, TreeNode>;
  files: ListFile[];
}

export function buildTree(files: ListFile[]): TreeNode {
  const root: TreeNode = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) node.dirs.set(part, (next = { name: part, dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push(f);
  }
  return root;
}

export function TreeView({ node, depth, onOpen }: { node: TreeNode; depth: number; onOpen: (f: ListFile) => void }) {
  return (
    <>
      {[...node.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => (
          <div key={d.name}>
            <div className="tree-dir" data-testid="tree-dir" style={{ paddingLeft: 8 + depth * 14 }}>
              <Folder size={12} /> {d.name}
            </div>
            <TreeView node={d} depth={depth + 1} onOpen={onOpen} />
          </div>
        ))}
      {node.files
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => (
          <FileRow key={f.path} file={f} onOpen={onOpen} indent={8 + depth * 14} nameOnly />
        ))}
    </>
  );
}

export function FileRow({ file, onOpen, indent = 8, nameOnly = false }: { file: ListFile; onOpen: (f: ListFile) => void; indent?: number; nameOnly?: boolean }) {
  return (
    <button
      className={`file-row${file.status === null ? ' unchanged' : ''}`}
      data-testid="file-row"
      data-path={file.path}
      data-status={file.status ?? 'unchanged'}
      style={{ paddingLeft: indent }}
      title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
      onClick={() => onOpen(file)}
    >
      <StatusIcon status={file.status} />
      {nameOnly ? <span className="file-name">{file.path.slice(file.path.lastIndexOf('/') + 1)}</span> : <PathLabel path={file.path} />}
    </button>
  );
}

export const SUMMARY: { status: string[]; label: string; id: string }[] = [
  { status: ['M', 'T', 'U'], label: 'modified', id: 'modified' },
  { status: ['A', 'C'], label: 'added', id: 'added' },
  { status: ['D'], label: 'deleted', id: 'deleted' },
  { status: ['R'], label: 'renamed', id: 'renamed' },
];

interface CommitProps {
  repoId: string;
  sha: string;
  wipTotal: number;
  onViewChanges: () => void;
  onOpenFile: OpenFileHook;
  onJump: (sha: string) => void;
  /** V4: set when this commit's message may be reworded (HEAD is a branch, nothing is stopped, the commit is on its first-parent line). */
  reword?: { editing: boolean; isHead: boolean; rebuilt: number; busy: boolean; onStart: () => void; onCancel: () => void; onSave: (message: string) => void };
}

export function CommitDetails({ repoId, sha, wipTotal, onViewChanges, onOpenFile, onJump, reword }: CommitProps) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useListMode();
  const [viewAll, setViewAll] = useState(false);
  const [allPaths, setAllPaths] = useState<{ files: string[]; truncated: boolean } | null>(null);
  const [allError, setAllError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setDetail(null);
    setError(null);
    api
      .commit(repoId, sha)
      .then((d) => !stale && setDetail(d))
      .catch((e: unknown) => !stale && setError(e instanceof Error ? e.message : 'Failed to load commit.'));
    return () => {
      stale = true;
    };
  }, [repoId, sha]);

  // "View all files": the commit's whole tree is fetched once the box is ticked.
  useEffect(() => {
    setAllPaths(null);
    setAllError(null);
    if (!viewAll) return;
    let stale = false;
    api
      .commitTree(repoId, sha)
      .then((r) => !stale && setAllPaths(r))
      .catch((e: unknown) => !stale && setAllError(e instanceof Error ? e.message : 'Failed to load files.'));
    return () => {
      stale = true;
    };
  }, [repoId, sha, viewAll]);

  const sorted = useMemo(() => (detail ? detail.files.slice().sort((a, b) => a.path.localeCompare(b.path)) : []), [detail]);
  const shown = useMemo((): ListFile[] => {
    if (!viewAll || !allPaths) return sorted;
    const changed = new Map(sorted.map((f) => [f.path, f]));
    const inTree = new Set(allPaths.files);
    const merged: ListFile[] = allPaths.files.map((path) => changed.get(path) ?? { status: null, path });
    // Deleted files are not in the commit's tree but are still part of its changes.
    for (const f of sorted) if (!inTree.has(f.path)) merged.push(f);
    return merged.sort((a, b) => a.path.localeCompare(b.path));
  }, [viewAll, allPaths, sorted]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  const open = (f: ListFile) => {
    if (f.status === null) return; // unchanged file from "View all files": nothing to diff
    onOpenFile({ source: 'commit', sha, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status });
  };

  return (
    <div className="details" data-testid="commit-details" data-sha={sha} tabIndex={-1}>
      {wipTotal > 0 && (
        <div className="changes-banner" data-testid="changes-banner">
          <span>
            {wipTotal} file change{wipTotal === 1 ? '' : 's'} in working directory
          </span>
          <button className="btn-outline" onClick={onViewChanges} data-testid="view-changes">
            View Changes
          </button>
        </div>
      )}
      <div className="details-sha">
        commit: <span className="mono" data-testid="details-sha">{shortSha(sha)}</span>
      </div>
      {error && <div className="details-error" data-testid="details-error">{error}</div>}
      {!detail && !error && <div className="details-loading">Loading...</div>}
      {detail && (
        <>
          {reword && !detail.truncated && reword.editing ? (
            <RewordEditor message={detail.message} isHead={reword.isHead} rebuilt={reword.rebuilt} busy={reword.busy} onUpdate={reword.onSave} onCancel={reword.onCancel} />
          ) : (
            <div
              className={`message-box${reword && !detail.truncated ? ' rewordable' : ''}`}
              data-testid="details-message"
              {...(reword && !detail.truncated ? { onClick: reword.onStart, title: 'Click to reword your commit message' } : {})}
            >
              {detail.message}
            </div>
          )}
          <div className="message-handle" />
          <div className="author-row">
            <img className="author-avatar" src={identiconUri(detail.authorEmail)} alt="" width={36} height={36} />
            <div className="author-info">
              <div className="author-name" data-testid="details-author">{detail.authorName}</div>
              <div className="author-date" data-testid="details-date">
                authored <span>{formatAuthored(detail.authorDate)}</span>
              </div>
            </div>
            <div className="author-parents" data-testid="details-parents">
              {detail.parents.map((p) => (
                <div key={p}>
                  parent:{' '}
                  <button className="link-sha mono" data-testid="details-parent" data-sha={p} onClick={() => onJump(p)}>
                    {shortSha(p)}
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="file-summary" data-testid="file-summary">
            {SUMMARY.map((s) => {
              const n = detail.files.filter((f) => s.status.includes(f.status)).length;
              if (n === 0) return null;
              return (
                <span key={s.id} className="summary-item" data-testid={`file-summary-${s.id}`}>
                  <StatusIcon status={s.status[0] ?? 'M'} /> {n} {s.label}
                </span>
              );
            })}
            {detail.files.length === 0 && <span className="summary-item dim">No file changes</span>}
          </div>
          <div className="file-tools">
            <ArrowDownAZ size={14} className="dim" />
            <div className="seg">
              <button className={mode === 'path' ? 'on' : ''} onClick={() => setMode('path')} data-testid="toggle-path">
                <List size={12} /> Path
              </button>
              <button className={mode === 'tree' ? 'on' : ''} onClick={() => setMode('tree')} data-testid="toggle-tree">
                <ListTree size={12} /> Tree
              </button>
            </div>
            <label className="view-all">
              <input type="checkbox" checked={viewAll} onChange={(e) => setViewAll(e.target.checked)} data-testid="view-all-files" />
              View all files
            </label>
          </div>
          {viewAll && allError && <div className="details-error" data-testid="view-all-error">{allError}</div>}
          <div className="file-list" data-testid="file-list" data-mode={mode}>
            {mode === 'path' ? shown.map((f) => <FileRow key={f.path} file={f} onOpen={open} />) : <TreeView node={tree} depth={0} onOpen={open} />}
          </div>
        </>
      )}
    </div>
  );
}
