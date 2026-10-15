import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Folder } from 'lucide-react';
import type { FileStatus, StatusCode, WipFile } from '@gitslappin/shared';
import { PathLabel, StatusIcon } from './DetailsPanel';

export type Side = 'unstaged' | 'staged';
export type ListMode = 'path' | 'tree';

/** The status letter shown for a file in one of the two lists. */
export function displayStatus(f: WipFile, side: Side): FileStatus | '?' {
  const c: StatusCode = side === 'staged' ? f.indexStatus : f.worktreeStatus;
  if (c === '?' || c === 'A' || c === 'D' || c === 'R' || c === 'C' || c === 'U') return c;
  return 'M';
}

/** Rows are drawn one by one above this count; longer lists are windowed. */
export const WINDOW_THRESHOLD = 200;
const ROW_HEIGHT = 24;
const OVERSCAN = 20;

export interface TreeNode {
  name: string;
  dirs: Map<string, TreeNode>;
  files: WipFile[];
}

export function buildTree(files: WipFile[]): TreeNode {
  const root: TreeNode = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    let node = root;
    for (const part of f.path.split('/').slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) node.dirs.set(part, (next = { name: part, dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push(f);
  }
  return root;
}

export type Entry = { kind: 'dir'; key: string; name: string; depth: number } | { kind: 'file'; key: string; file: WipFile; depth: number };

/** The tree as one flat list of rows (folders first, both sorted by name). */
export function flattenTree(node: TreeNode, depth: number, prefix: string, out: Entry[]): Entry[] {
  for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push({ kind: 'dir', key: `d:${prefix}${d.name}`, name: d.name, depth });
    flattenTree(d, depth + 1, `${prefix}${d.name}/`, out);
  }
  for (const f of node.files.slice().sort((a, b) => a.path.localeCompare(b.path))) out.push({ kind: 'file', key: `f:${f.path}`, file: f, depth });
  return out;
}

interface RowProps {
  file: WipFile;
  side: Side;
  indent: number;
  nameOnly: boolean;
  selected: boolean;
  onOpen: (f: WipFile) => void;
  onAction: (f: WipFile) => void;
  /** Ctrl/Cmd+click: add or remove the file from the selection (no diff opens). */
  onToggle: (f: WipFile) => void;
  /** Right-click (phase 11: Discard changes). */
  onContext: (f: WipFile, x: number, y: number) => void;
  disabled: boolean;
}

const Row = memo(function Row({ file, side, indent, nameOnly, selected, onOpen, onAction, onToggle, onContext, disabled }: RowProps) {
  const status = displayStatus(file, side);
  const title = side === 'staged' ? 'Unstage File' : 'Stage File';
  return (
    <div
      className={`file-row wip-file${selected ? ' selected' : ''}`}
      role="button"
      tabIndex={0}
      data-testid="wip-file-row"
      data-path={file.path}
      data-status={status}
      {...(selected ? { 'data-selected': 'true' } : {})}
      style={{ paddingLeft: indent }}
      title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(file, e.clientX, e.clientY);
      }}
      onClick={(e) => (e.ctrlKey || e.metaKey ? onToggle(file) : onOpen(file))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(file);
      }}
    >
      <StatusIcon status={status} />
      {nameOnly ? <span className="file-name">{file.path.slice(file.path.lastIndexOf('/') + 1)}</span> : <PathLabel path={file.path} />}
      <span className="file-spacer" />
      {status !== 'U' && (
        <button
          className={`stage-btn ${side === 'staged' ? 'unstage' : 'stage'}`}
          data-testid="wip-file-action"
          title={title}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onAction(file);
          }}
        >
          {title}
        </button>
      )}
    </div>
  );
});

interface Props {
  files: WipFile[];
  side: Side;
  mode: ListMode;
  onOpen: (f: WipFile) => void;
  onAction: (f: WipFile) => void;
  disabled: boolean;
  /** Paths that are selected (phase 11, for the Discard changes menu). Optional: other lists have no selection. */
  selection?: ReadonlySet<string>;
  onToggle?: (f: WipFile) => void;
  onContext?: (f: WipFile, x: number, y: number) => void;
}

const NONE: ReadonlySet<string> = new Set();

export function FileList({ files, side, mode, onOpen, onAction, disabled, selection = NONE, onToggle, onContext }: Props) {
  // The callers pass new functions on every render; Row is memoised, so it gets stable wrappers.
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;
  const contextRef = useRef(onContext);
  contextRef.current = onContext;
  const stableOpen = useCallback((f: WipFile) => openRef.current(f), []);
  const stableAction = useCallback((f: WipFile) => actionRef.current(f), []);
  const stableToggle = useCallback((f: WipFile) => toggleRef.current?.(f), []);
  const stableContext = useCallback((f: WipFile, x: number, y: number) => contextRef.current?.(f, x, y), []);

  const entries = useMemo<Entry[]>(
    () => (mode === 'tree' ? flattenTree(buildTree(files), 0, '', []) : files.map((f) => ({ kind: 'file' as const, key: `f:${f.path}`, file: f, depth: 0 }))),
    [files, mode],
  );

  const box = useRef<HTMLDivElement>(null);
  const windowed = entries.length > WINDOW_THRESHOLD;
  const [range, setRange] = useState({ first: 0, last: WINDOW_THRESHOLD });
  useEffect(() => {
    const el = box.current;
    const scroller = el?.parentElement;
    if (!windowed || !el || !scroller) return;
    const update = () => {
      const top = Math.max(0, scroller.scrollTop - el.offsetTop);
      const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
      const last = Math.ceil((top + scroller.clientHeight) / ROW_HEIGHT) + OVERSCAN;
      setRange((r) => (r.first === first && r.last === last ? r : { first, last }));
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [windowed, entries.length]);

  const shown = windowed ? entries.slice(range.first, Math.min(entries.length, range.last + 1)) : entries;
  const nodes = shown.map((e) =>
    e.kind === 'dir' ? (
      <div key={e.key} className="tree-dir" data-testid="wip-tree-dir" style={{ paddingLeft: 8 + e.depth * 14 }}>
        <Folder size={12} /> {e.name}
      </div>
    ) : (
      <Row
        key={e.key}
        file={e.file}
        side={side}
        indent={mode === 'tree' ? 8 + e.depth * 14 : 8}
        nameOnly={mode === 'tree'}
        selected={selection.has(e.file.path)}
        onOpen={stableOpen}
        onAction={stableAction}
        onToggle={stableToggle}
        onContext={stableContext}
        disabled={disabled}
      />
    ),
  );
  if (!windowed) return <>{nodes}</>;
  return (
    <div ref={box} data-testid="wip-windowed" style={{ position: 'relative', height: entries.length * ROW_HEIGHT }}>
      <div style={{ position: 'absolute', top: range.first * ROW_HEIGHT, left: 0, right: 0 }}>{nodes}</div>
    </div>
  );
}
