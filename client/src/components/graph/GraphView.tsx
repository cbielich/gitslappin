import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, Cloud, Laptop, Pencil, Plus, Minus, Tag, TriangleAlert } from 'lucide-react';
import type { GraphRow, LogCommit, StatusSummary } from '@gitslappin/shared';
import { formatAuthored, shortSha } from '../../lib/identicon';
import { readJson, writeJson } from '../../lib/storage';
import { LaneSvg, MID_Y, NODE_R, ROW_H, WipSvg, laneVar, laneX } from './LaneSvg';
import type { MenuCtx } from '../../lib/refMenu';
import { BranchInput } from './BranchInput';
import { groupRefs, type Pill } from './refPills';

export type MenuRequest = Omit<MenuCtx, 'head'>;

export type Selection = { kind: 'wip' } | { kind: 'commit'; sha: string } | { kind: 'stash'; sha: string };
export interface ScrollTarget {
  /** A commit sha, or 'wip' for the WIP row. */
  sha: string;
  nonce: number;
}

const OVERSCAN = 12;
const LOAD_AHEAD = 100;
const MIN_AUTO_GRAPH = 90;
const MAX_AUTO_GRAPH = 320;

/** Optional columns after COMMIT MESSAGE. Hidden by default (GitKraken 12.6 hides them too). */
export type OptionalColumn = 'author' | 'date' | 'sha';
type Columns = Record<OptionalColumn, boolean>;
const COLUMN_LABELS: { id: OptionalColumn; header: string; menu: string }[] = [
  { id: 'author', header: 'AUTHOR', menu: 'Show commit author in graph' },
  { id: 'date', header: 'COMMIT DATE / TIME', menu: 'Show commit date/time in graph' },
  { id: 'sha', header: 'SHA', menu: 'Show commit sha in graph' },
];
const COLUMNS_KEY = 'gitslappin-graph-columns';

function loadColumns(): Columns {
  const v = readJson<Partial<Record<OptionalColumn, unknown>> | null>(COLUMNS_KEY, null);
  return { author: v?.author === true, date: v?.date === true, sha: v?.sha === true };
}

interface RowProps {
  row: GraphRow;
  commit: LogCommit;
  index: number;
  top: number;
  selected: boolean;
  match: boolean;
  cols: Columns;
  onSelect: (sha: string, stash: boolean) => void;
  onMenu: (x: number, y: number, ctx: MenuRequest) => void;
  onPillOpen: (p: Pill) => void;
  /** This row shows the inline new-branch input. */
  creating: boolean;
  /** The typed name (kept by the parent) while `creating`. */
  creatingName: string;
  onCreateName: (v: string) => void;
  onCreateSubmit: (name: string) => void;
  onCreateCancel: () => void;
}

const CommitRow = memo(function CommitRow({ row, commit, index, top, selected, match, cols, onSelect, onMenu, onPillOpen, creating, creatingName, onCreateName, onCreateSubmit, onCreateCancel }: RowProps) {
  const pills = groupRefs(commit.refs);
  const first = pills[0];
  const extra = pills.slice(1);
  const current = commit.refs.some((r) => r.current);
  const style = { top, '--lane': laneVar(row.color) } as CSSProperties;
  return (
    <div
      className={`commit-row${selected ? ' selected' : ''}${match ? ' match' : ''}${row.stash ? ' stash' : ''}`}
      style={style}
      data-testid="commit-row"
      data-sha={commit.sha}
      data-selected={selected}
      data-match={match}
      data-stash={row.stash ? 'true' : undefined}
      onClick={() => onSelect(commit.sha, row.stash)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY, { target: row.stash ? 'stash' : 'row', sha: commit.sha });
      }}
    >
      <div className={`cell cell-ref${creating ? ' creating' : ''}`}>
        {creating && <BranchInput value={creatingName} onChange={onCreateName} onSubmit={onCreateSubmit} onCancel={onCreateCancel} />}
        {!creating && first && (
          <span
            className={`ref-pill${first.current ? ' current' : ''}`}
            data-testid="ref-pill"
            data-name={first.label}
            title={first.title}
            onDoubleClick={() => onPillOpen(first)}
            onContextMenu={(e) => {
              const name = first.localName ?? first.remoteNames[0];
              if (!name) return; // tags and the detached HEAD use the row menu
              e.preventDefault();
              e.stopPropagation();
              onMenu(e.clientX, e.clientY, { target: 'pill', sha: commit.sha, branch: { name, local: !!first.localName, remote: first.remoteNames.length > 0, current: first.current } });
            }}
          >
            {first.current && <Check size={11} />}
            <span className="ref-pill-name">{first.label}</span>
            {first.local && <Laptop size={11} />}
            {first.remote && <Cloud size={11} />}
            {first.tag && <Tag size={11} />}
          </span>
        )}
        {!creating && extra.length > 0 && (
          <span
            className="ref-more"
            data-testid="ref-more"
            title={extra.map((p) => p.title).join('\n')}
            onContextMenu={(e) => {
              const more = extra.flatMap((p) => {
                const name = p.localName ?? p.remoteNames[0];
                return name ? [{ name, local: !!p.localName, remote: p.remoteNames.length > 0, current: p.current }] : [];
              });
              if (more.length === 0) return; // tags only: the row menu
              e.preventDefault();
              e.stopPropagation();
              onMenu(e.clientX, e.clientY, { target: 'more', sha: commit.sha, more });
            }}
          >
            +{extra.length}
          </span>
        )}
        {!creating && first && <span className="ref-line" data-testid="ref-line" />}
      </div>
      <div className="cell cell-graph">
        <div className="lane-band" style={{ left: laneX(row.lane) }} />
        <LaneSvg row={row} email={commit.authorEmail} idKey={String(index)} showConnector={pills.length > 0} current={current} />
      </div>
      <div className="cell cell-msg">
        <span className="commit-subject" data-testid="commit-message">
          {commit.subject}
        </span>
      </div>
      {cols.author && (
        <div className="cell cell-col cell-author" data-testid="cell-author" title={commit.authorEmail}>
          {commit.authorName}
        </div>
      )}
      {cols.date && (
        <div className="cell cell-col cell-date" data-testid="cell-date">
          {formatAuthored(commit.authorDate)}
        </div>
      )}
      {cols.sha && (
        <div className="cell cell-col cell-sha mono" data-testid="cell-sha" title={commit.sha}>
          {shortSha(commit.sha)}
        </div>
      )}
    </div>
  );
});

/** MergeConflictMessageSingular / Plural (en-us.json). A rebase names HEAD, a merge the current branch. */
export function conflictBannerText(count: number, into: string): string {
  return count === 1 ? `A file conflict was found when attempting to merge into ${into}` : `${count} file conflicts were found when attempting to merge into ${into}`;
}

function WipRow({ wip, lane, linked, selected, top, cols, message, onMessage, onSelect }: { wip: StatusSummary; lane: number; linked: boolean; selected: boolean; top: number; cols: Columns; message: string; onMessage: (v: string) => void; onSelect: () => void }) {
  const added = wip.added + wip.untracked;
  if (wip.op && wip.conflicted > 0) {
    // The amber bar of the conflict screen replaces the WIP message box (reference 08b / 14b).
    return (
      <div
        className={`commit-row wip-row op-banner-row${selected ? ' selected' : ''}`}
        style={{ top, '--lane': laneVar(0) } as CSSProperties}
        data-testid="op-banner"
        data-selected={selected}
        role="button"
        onClick={onSelect}
      >
        <div className="cell cell-ref" />
        <div className="cell cell-graph">
          <WipSvg lane={lane} linked={linked} />
        </div>
        <div className="cell cell-msg op-banner-msg">
          <TriangleAlert size={14} />
          <span>{conflictBannerText(wip.conflicted, wip.op.kind === 'rebase' ? 'HEAD' : wip.op.head)}</span>
        </div>
        {cols.author && <div className="cell cell-col cell-author op-banner-msg" />}
        {cols.date && <div className="cell cell-col cell-date op-banner-msg" />}
        {cols.sha && <div className="cell cell-col cell-sha op-banner-msg" />}
      </div>
    );
  }
  return (
    <div
      className={`commit-row wip-row${selected ? ' selected' : ''}`}
      style={{ top, '--lane': laneVar(0) } as CSSProperties}
      data-testid="wip-row"
      data-selected={selected}
      onClick={onSelect}
    >
      <div className="cell cell-ref" />
      <div className="cell cell-graph">
        <WipSvg lane={lane} linked={linked} />
      </div>
      <div className="cell cell-msg">
        <input className="wip-box" data-testid="wip-message-input" placeholder="// WIP" value={message} onChange={(e) => onMessage(e.target.value)} />
        {wip.modified > 0 && (
          <span className="wip-count mod" data-testid="wip-count-modified">
            <Pencil size={11} /> {wip.modified}
          </span>
        )}
        {added > 0 && (
          <span className="wip-count add" data-testid="wip-count-added">
            <Plus size={12} /> {added}
          </span>
        )}
        {wip.deleted > 0 && (
          <span className="wip-count del" data-testid="wip-count-deleted">
            <Minus size={12} /> {wip.deleted}
          </span>
        )}
      </div>
      {cols.author && <div className="cell cell-col cell-author" />}
      {cols.date && <div className="cell cell-col cell-date" />}
      {cols.sha && <div className="cell cell-col cell-sha" />}
    </div>
  );
}

interface Props {
  rows: GraphRow[];
  commits: LogCommit[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  onRetry: () => void;
  indexOf: (sha: string) => number;
  wip: StatusSummary | null;
  headSha: string | null;
  selected: Selection | null;
  onSelect: (sel: Selection) => void;
  matches: Set<string>;
  scrollTarget: ScrollTarget | null;
  /** The commit summary typed in the WIP row (shared with the commit box). */
  wipMessage: string;
  onWipMessage: (v: string) => void;
  onMenu: (x: number, y: number, ctx: MenuRequest) => void;
  onPillOpen: (p: Pill) => void;
  /** Sha of the row that shows the inline new-branch input. */
  creatingSha: string | null;
  creatingName: string;
  onCreateName: (v: string) => void;
  onCreateSubmit: (name: string) => void;
  onCreateCancel: () => void;
}

export function GraphView({ rows, commits, hasMore, loading, error, loadMore, onRetry, indexOf, wip, headSha, selected, onSelect, matches, scrollTarget, wipMessage, onWipMessage, onMenu, onPillOpen, creatingSha, creatingName, onCreateName, onCreateSubmit, onCreateCancel }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  /** `graph: null` = fit the lanes in view; a number = the user resized the column. */
  const [widths, setWidths] = useState<{ ref: number; graph: number | null }>({ ref: 170, graph: null });
  const [cols, setCols] = useState<Columns>(loadColumns);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const wipVisible = !!wip && (wip.total > 0 || !!wip.op);
  const offset = wipVisible ? 1 : 0;
  const total = rows.length + offset;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  // Default graph column width: fits the widest lane layout in view, capped.
  let maxLanes = 1;
  for (let i = start; i < end; i++) {
    const r = rows[i - offset];
    if (r && r.laneCount > maxLanes) maxLanes = r.laneCount;
  }
  const autoGraph = Math.min(MAX_AUTO_GRAPH, Math.max(MIN_AUTO_GRAPH, laneX(maxLanes - 1) + NODE_R + 8));
  const graphW = widths.graph ?? autoGraph;

  useEffect(() => {
    if (hasMore && !loading && !error && end >= total - LOAD_AHEAD) void loadMore();
  }, [end, total, hasMore, loading, error, loadMore]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !scrollTarget) return;
    const row = scrollTarget.sha === 'wip' ? 0 : indexOf(scrollTarget.sha) + offset;
    if (row < 0 || (scrollTarget.sha !== 'wip' && indexOf(scrollTarget.sha) < 0)) return;
    const y = row * ROW_H;
    if (y < el.scrollTop || y + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, y - el.clientHeight / 2 + ROW_H / 2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const toggleColumn = (id: OptionalColumn) => {
    const next = { ...cols, [id]: !cols[id] };
    setCols(next);
    writeJson(COLUMNS_KEY, next);
  };

  const onSelectSha = useCallback((sha: string, stash: boolean) => onSelect({ kind: stash ? 'stash' : 'commit', sha }), [onSelect]);

  const headIdx = headSha ? indexOf(headSha) : -1;
  const headLane = useMemo(() => (headIdx >= 0 ? (rows[headIdx]?.lane ?? 0) : 0), [headIdx, rows]);
  // Dotted line from the WIP node down to the HEAD commit's node.
  const wipLinkTo = wipVisible && headIdx >= 0 ? headIdx + offset : -1;

  const startDrag = (col: 'ref' | 'graph') => (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = col === 'ref' ? widths.ref : graphW;
    const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [col]: Math.max(60, w0 + ev.clientX - x0) }));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const items = [];
  for (let i = start; i < end; i++) {
    const top = i * ROW_H;
    if (wipVisible && i === 0 && wip) {
      items.push(<WipRow key="wip" wip={wip} lane={headLane} linked={wipLinkTo > 0} selected={selected?.kind === 'wip'} top={top} cols={cols} message={wipMessage} onMessage={onWipMessage} onSelect={() => onSelect({ kind: 'wip' })} />);
      continue;
    }
    const ci = i - offset;
    const row = rows[ci];
    const commit = commits[ci];
    if (!row || !commit) continue;
    items.push(
      <CommitRow
        key={commit.sha}
        row={row}
        commit={commit}
        index={ci}
        top={top}
        selected={(selected?.kind === 'commit' || selected?.kind === 'stash') && selected.sha === commit.sha}
        match={matches.has(commit.sha)}
        cols={cols}
        onSelect={onSelectSha}
        onMenu={onMenu}
        onPillOpen={onPillOpen}
        creating={creatingSha === commit.sha}
        creatingName={creatingSha === commit.sha ? creatingName : ''}
        onCreateName={onCreateName}
        onCreateSubmit={onCreateSubmit}
        onCreateCancel={onCreateCancel}
      />,
    );
  }

  const vars = { '--col-ref': `${widths.ref}px`, '--col-graph': `${graphW}px` } as CSSProperties;
  const wipX = laneX(headLane);
  return (
    <div className="graph-view" style={vars} data-testid="graph-view">
      <div
        className="graph-header"
        data-testid="graph-header"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div className="cell cell-ref">
          BRANCH / TAG
          <span className="col-resizer" onPointerDown={startDrag('ref')} data-testid="resize-ref" />
        </div>
        <div className="cell cell-graph">
          GRAPH
          <span className="col-resizer" onPointerDown={startDrag('graph')} data-testid="resize-graph" />
        </div>
        <div className="cell cell-msg">COMMIT MESSAGE</div>
        {COLUMN_LABELS.filter((c) => cols[c.id]).map((c) => (
          <div key={c.id} className={`cell cell-col cell-${c.id}`} data-testid={`header-${c.id}`}>
            {c.header}
          </div>
        ))}
      </div>
      {menu && (
        <div className="column-menu" role="menu" data-testid="column-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {COLUMN_LABELS.map((c) => (
            <button key={c.id} role="menuitemcheckbox" aria-checked={cols[c.id]} className="column-menu-item" data-testid={`column-toggle-${c.id}`} onClick={() => toggleColumn(c.id)}>
              <span className="column-menu-check">{cols[c.id] && <Check size={12} />}</span>
              {c.menu}
            </button>
          ))}
        </div>
      )}
      <div
        className="graph-scroll"
        ref={scroller}
        data-testid="graph-scroll"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div className="graph-rows" style={{ height: total * ROW_H }}>
          {items}
          {wipLinkTo > 0 && (
            <svg className="wip-link" data-testid="wip-link" aria-hidden="true" width={graphW} height={(wipLinkTo + 1) * ROW_H} style={{ left: widths.ref }}>
              <path d={`M${wipX} ${MID_Y + NODE_R}V${wipLinkTo * ROW_H + MID_Y - NODE_R}`} style={{ stroke: laneVar(0), strokeWidth: 2, strokeDasharray: '2 3', fill: 'none' }} />
            </svg>
          )}
        </div>
        {error && (
          <div className="graph-error" data-testid="graph-error">
            <span data-testid="graph-error-text">{error}</span>
            <button className="btn-outline" onClick={onRetry} data-testid="graph-retry">
              Try Again
            </button>
          </div>
        )}
        {!loading && !error && total === 0 && (
          <div className="graph-empty" data-testid="graph-empty">
            No commits
          </div>
        )}
      </div>
    </div>
  );
}
