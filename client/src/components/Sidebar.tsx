import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Cloud, Inbox, Laptop, Plus, Eye, EyeOff, Search, Tag } from 'lucide-react';
import type { GraphVisibility, RefsInfo } from '@gitslappin/shared';
import { ContextMenu } from './menu/ContextMenu';
import type { MenuEntry } from '../lib/refMenu';
import type { MenuCtx } from '../lib/refMenu';
import { readJson, writeJson } from '../lib/storage';
import { branchDndProps } from '../lib/branchDnd';
import type { BranchDrop } from './graph/GraphView';

interface Props {
  repoId: string;
  refs: RefsInfo | null;
  /** V5c: hide / solo state and its change callback (the view saves it and reloads the graph). */
  vis: GraphVisibility;
  onVis: (next: GraphVisibility) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  filterRef: RefObject<HTMLInputElement | null>;
  onJump: (sha: string) => void;
  onMenu: (x: number, y: number, ctx: Omit<MenuCtx, 'head'>) => void;
  onBranchDrop: BranchDrop;
  /** Double-click on a LOCAL or REMOTE item (a remote name is the full `origin/x`). */
  onCheckout: (kind: 'local' | 'remote', name: string) => void;
  /** A click on a stash item opens that stash (its file list), instead of jumping to a commit. */
  onSelectStash: (sha: string) => void;
  /** The green "+" on the REMOTE section head (RemoteForm-AddRemote). */
  onAddRemote?: () => void;
  /** A diff is open: show the icon rail with counts, whatever the collapsed setting. */
  rail?: boolean;
  /** The merge tool is open: the whole sidebar (and its icon rail) is not shown. */
  hidden?: boolean;
}

interface Item {
  key: string;
  kind: 'local' | 'remote' | 'stash' | 'tag';
  name: string;
  sha: string;
  current?: boolean;
  ahead?: number;
  behind?: number;
}

const openKey = (repoId: string): string => `gitslappin-sidebar-open:${repoId}`;

/** Sections start collapsed; the expanded ones are remembered per repo. */
function loadOpen(repoId: string): Record<string, boolean> {
  const v = readJson<unknown>(openKey(repoId), {});
  const out: Record<string, boolean> = {};
  if (v && typeof v === 'object') for (const [k, on] of Object.entries(v as Record<string, unknown>)) if (on === true) out[k] = true;
  return out;
}

function Section({ id, label, Icon, count, countText, onHeadMenu, open, onToggle, action, children }: { id: string; label: string; Icon: typeof Laptop; count: number; countText?: string; onHeadMenu?: (e: React.MouseEvent) => void; open: boolean; onToggle: () => void; action?: { testId: string; title: string; onClick: () => void }; children: React.ReactNode }) {
  return (
    <div className="sb-section" data-testid={`sidebar-section-${id}`}>
      <div className="sb-section-headrow">
      <button className="sb-section-head" onClick={onToggle} onContextMenu={onHeadMenu} data-testid={`sidebar-toggle-${id}`} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Icon size={13} />
        <span className="sb-section-label">{label}</span>
        <span className="sb-count" data-testid={`sidebar-count-${id}`}>
          {countText ?? count}
        </span>
      </button>
      {action && (
        <button className="sb-add" data-testid={action.testId} title={action.title} aria-label={action.title} onClick={action.onClick}>
          <Plus size={13} />
        </button>
      )}
      </div>
      {open && <div className="sb-items">{children}</div>}
    </div>
  );
}

export function Sidebar({ repoId, refs, vis, onVis, collapsed, onToggleCollapse, filterRef, onJump, onMenu, onBranchDrop, onCheckout, onSelectStash, onAddRemote, rail = false, hidden = false }: Props) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>(() => loadOpen(repoId));
  useEffect(() => setOpen(loadOpen(repoId)), [repoId]);
  const [secMenu, setSecMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [closedRemotes, setClosedRemotes] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => {
    const next = { ...open, [k]: !open[k] };
    setOpen(next);
    writeJson(openKey(repoId), next);
  };

  const f = filter.trim().toLowerCase();
  const match = (s: string) => !f || s.toLowerCase().includes(f);

  const data = useMemo(() => {
    const local: Item[] = (refs?.local ?? [])
      .filter((b) => match(b.name))
      .map((b) => ({ key: `l:${b.name}`, kind: 'local', name: b.name, sha: b.sha, current: b.current, ahead: b.ahead, behind: b.behind }));
    const remotes = (refs?.remotes ?? []).map((g) => ({
      name: g.name,
      items: g.branches.filter((b) => match(b.name)).map((b): Item => ({ key: `r:${b.name}`, kind: 'remote', name: b.name, sha: b.sha })),
    }));
    const stashes: Item[] = (refs?.stashes ?? [])
      .filter((s) => match(`${s.ref} ${s.message}`))
      .map((s) => ({ key: `s:${s.index}`, kind: 'stash', name: `${s.ref}: ${s.message}`, sha: s.sha }));
    const tags: Item[] = (refs?.tags ?? []).filter((t) => match(t.name)).map((t) => ({ key: `t:${t.name}`, kind: 'tag', name: t.name, sha: t.sha }));
    return { local, remotes, stashes, tags };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, f]);

  const remoteCount = data.remotes.reduce((n, g) => n + g.items.length, 0);

  // V5c hide / solo. Full ref names match the server's graph-visibility.json entries.
  const hiddenSet = useMemo(() => new Set(vis.hidden), [vis.hidden]);
  const soloSet = useMemo(() => new Set(vis.solo), [vis.solo]);
  const soloing = vis.solo.length > 0;
  const fullRef = (it: Item): string => (it.kind === 'local' ? `refs/heads/${it.name}` : it.kind === 'remote' ? `refs/remotes/${it.name}` : it.kind === 'tag' ? `refs/tags/${it.name}` : '');
  const isHid = (it: Item): boolean => it.kind !== 'stash' && !it.current && hiddenSet.has(fullRef(it));
  const isOut = (it: Item): boolean => it.kind !== 'stash' && !it.current && (hiddenSet.has(fullRef(it)) || (soloing && !soloSet.has(fullRef(it))));
  const outOf = (items: Item[]): number => items.filter(isOut).length;
  const countText = (items: Item[]): string | undefined => {
    const out = outOf(items);
    return out > 0 ? `${items.length - out}/${items.length}` : undefined;
  };
  const remoteItems = data.remotes.flatMap((g) => g.items);
  const viewItems = [...data.local, ...remoteItems, ...data.tags];
  const viewOut = outOf(viewItems);
  const viewText = viewOut > 0 ? `${viewItems.length - viewOut}/${viewItems.length}` : String(viewItems.length);
  // Everything the repository has (not narrowed by the text filter): what a section menu acts on.
  const allRefs = useMemo(
    () => ({
      local: (refs?.local ?? []).filter((b) => !b.current).map((b) => `refs/heads/${b.name}`),
      remote: (refs?.remotes ?? []).flatMap((g) => g.branches.map((b) => `refs/remotes/${b.name}`)),
      tags: (refs?.tags ?? []).map((t) => `refs/tags/${t.name}`),
    }),
    [refs],
  );
  const anyHidden = vis.hideStashes || [...allRefs.local, ...allRefs.remote, ...allRefs.tags].some((r) => hiddenSet.has(r));
  const sectionMenu = (e: React.MouseEvent, id: 'local' | 'remote' | 'tags' | 'stashes'): void => {
    e.preventDefault();
    const entries: MenuEntry[] = [];
    if (id === 'stashes') {
      if ((refs?.stashes.length ?? 0) > 0) {
        const hide = !vis.hideStashes;
        entries.push({ type: 'item', id: 'stashes', label: hide ? 'Hide all stashes' : 'Show all stashes', run: () => onVis({ ...vis, hideStashes: hide }) });
      }
    } else {
      const names = allRefs[id];
      const text = { local: ['Hide all local branches', 'Show all local branches'], remote: ['Hide all remotes', 'Show all remotes'], tags: ['Hide all tags', 'Show all tags'] }[id];
      if (names.some((r) => !hiddenSet.has(r))) entries.push({ type: 'item', id: 'hide-all', label: text[0] ?? '', run: () => onVis({ ...vis, hidden: [...new Set([...vis.hidden, ...names])] }) });
      if (names.some((r) => hiddenSet.has(r))) {
        const drop = new Set(names);
        entries.push({ type: 'item', id: 'show-all', label: text[1] ?? '', run: () => onVis({ ...vis, hidden: vis.hidden.filter((r) => !drop.has(r)) }) });
      }
    }
    if (entries.length > 0) setSecMenu({ x: e.clientX, y: e.clientY, entries });
  };

  if (collapsed || rail) {
    const railItems: { id: string; label: string; Icon: typeof Laptop; n: number }[] = [
      { id: 'local', label: 'LOCAL', Icon: Laptop, n: refs?.local.length ?? 0 },
      { id: 'remote', label: 'REMOTE', Icon: Cloud, n: (refs?.remotes ?? []).reduce((n, g) => n + g.branches.length, 0) },
      { id: 'stashes', label: 'STASHES', Icon: Inbox, n: refs?.stashes.length ?? 0 },
      { id: 'tags', label: 'TAGS', Icon: Tag, n: refs?.tags.length ?? 0 },
    ];
    return (
      <aside className="left-panel collapsed" data-testid="left-panel" tabIndex={-1} data-collapsed="true" {...(hidden ? { style: { display: 'none' } } : {})}>
        <button className="icon-btn sb-collapse" onClick={onToggleCollapse} data-testid="left-collapse" title="Expand">
          <ChevronRight size={14} />
        </button>
        {railItems.map(({ id, label, Icon, n }) => (
          <div key={id} className="rail-item" title={label} data-testid={`rail-item-${id}`}>
            <Icon size={15} />
            <span className="rail-count" data-testid="rail-count">
              {n}
            </span>
          </div>
        ))}
      </aside>
    );
  }

  const renderItem = (it: Item) => (
    <button
      key={it.key}
      className={`sb-item${it.current ? ' current' : ''}`}
      data-testid="sidebar-item"
      {...(isHid(it) ? { 'data-hidden': 'true' } : {})}
      data-kind={it.kind}
      data-name={it.name}
      title={it.name}
      onClick={() => (it.kind === 'stash' ? onSelectStash(it.sha) : onJump(it.sha))}
      {...(it.kind === 'local' || it.kind === 'remote' ? branchDndProps({ name: it.name, kind: it.kind }, onBranchDrop) : {})}
      onDoubleClick={() => {
        if (it.kind === 'local' && !it.current) onCheckout('local', it.name);
        else if (it.kind === 'remote') onCheckout('remote', it.name);
      }}
      onContextMenu={(e) => {
        if (it.kind === 'stash') {
          e.preventDefault();
          onMenu(e.clientX, e.clientY, { target: 'stash', sha: it.sha });
          return;
        }
        if (it.kind === 'tag') {
          // V2: the tag group first, then the commit-row items (the row menu of the tagged commit).
          e.preventDefault();
          onMenu(e.clientX, e.clientY, { target: 'row', sha: it.sha, tag: { name: it.name }, solo: { ref: fullRef(it), soloed: soloSet.has(fullRef(it)) } });
          return;
        }
        if (it.kind !== 'local' && it.kind !== 'remote') return;
        e.preventDefault();
        onMenu(e.clientX, e.clientY, {
          target: it.kind === 'local' ? 'sidebar-local' : 'sidebar-remote',
          sha: it.sha,
          branch: { name: it.name, local: it.kind === 'local', remote: it.kind === 'remote', current: !!it.current },
          solo: { ref: fullRef(it), soloed: soloSet.has(fullRef(it)) },
        });
      }}
    >
      {it.current && <Check size={11} />}
      <span className="sb-item-name">{it.name}</span>
      {(!!it.ahead || !!it.behind) && (
        // Screen 43b: one group, number then arrow, "1↑ 1↓".
        <span className="sb-track" data-testid="sb-track">
          {[it.ahead ? `${it.ahead}↑` : '', it.behind ? `${it.behind}↓` : ''].filter(Boolean).join(' ')}
        </span>
      )}
      {it.kind !== 'stash' && !it.current && (
        <span
          className="sb-eye"
          role="button"
          data-testid="sidebar-eye"
          title={isHid(it) ? 'Show in the graph' : 'Hide in the graph'}
          aria-label={isHid(it) ? 'Show in the graph' : 'Hide in the graph'}
          onClick={(e) => {
            e.stopPropagation();
            onVis({ ...vis, hidden: isHid(it) ? vis.hidden.filter((r) => r !== fullRef(it)) : [...vis.hidden, fullRef(it)] });
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {isHid(it) ? <EyeOff size={12} /> : <Eye size={12} />}
        </span>
      )}
    </button>
  );

  return (
    <aside className="left-panel" data-testid="left-panel" tabIndex={-1} data-collapsed="false" {...(hidden ? { style: { display: 'none' } } : {})}>
      <div className="left-header">
        <button className="icon-btn" onClick={onToggleCollapse} data-testid="left-collapse" title="Collapse">
          <ChevronLeft size={14} />
        </button>
        <div className="left-header-col">
          <span className="viewing">
            <span data-testid="viewing-label">{soloing ? 'Soloing' : 'Viewing'}</span>{' '}
            <span className="blue" data-testid="viewing-count">
              {viewText}
            </span>
            {anyHidden && (
              <button className="viewing-btn" data-testid="viewing-show-all" onClick={() => onVis({ hidden: [], solo: [], hideStashes: false })}>
                Show All
              </button>
            )}
            {soloing && (
              <button className="viewing-btn" data-testid="viewing-unsolo" onClick={() => onVis({ ...vis, solo: [] })}>
                Stop Soloing
              </button>
            )}
          </span>
          <div className="sb-filter">
            <input
              ref={filterRef}
              data-testid="sidebar-filter"
              placeholder="Filter (Ctrl + Alt + f)"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Search size={12} />
          </div>
        </div>
      </div>
      <div className="sb-scroll">
        <Section id="local" label="LOCAL" Icon={Laptop} count={data.local.length} countText={countText(data.local)} onHeadMenu={(e) => sectionMenu(e, 'local')} open={!!open.local} onToggle={() => toggle('local')}>
          {data.local.map(renderItem)}
        </Section>
        <Section id="remote" label="REMOTE" Icon={Cloud} count={remoteCount} countText={countText(remoteItems)} onHeadMenu={(e) => sectionMenu(e, 'remote')} open={!!open.remote} onToggle={() => toggle('remote')} {...(onAddRemote ? { action: { testId: 'sidebar-add-remote', title: 'Add Remote', onClick: onAddRemote } } : {})}>
          {data.remotes.map((g) => (
            <div key={g.name} className="sb-remote" data-testid={`sidebar-remote-${g.name}`}>
              <button className="sb-remote-head" onClick={() => setClosedRemotes((c) => ({ ...c, [g.name]: !c[g.name] }))}>
                {closedRemotes[g.name] ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                <span>{g.name}</span>
                <span className="sb-count">{g.items.length}</span>
              </button>
              {!closedRemotes[g.name] && g.items.map(renderItem)}
            </div>
          ))}
        </Section>
        <Section id="stashes" label="STASHES" Icon={Inbox} count={data.stashes.length} countText={vis.hideStashes && data.stashes.length > 0 ? `0/${data.stashes.length}` : undefined} onHeadMenu={(e) => sectionMenu(e, 'stashes')} open={!!open.stashes} onToggle={() => toggle('stashes')}>
          {data.stashes.map(renderItem)}
        </Section>
        <Section id="tags" label="TAGS" Icon={Tag} count={data.tags.length} countText={countText(data.tags)} onHeadMenu={(e) => sectionMenu(e, 'tags')} open={!!open.tags} onToggle={() => toggle('tags')}>
          {data.tags.map(renderItem)}
        </Section>
      </div>
      {secMenu && <ContextMenu x={secMenu.x} y={secMenu.y} entries={secMenu.entries} onClose={() => setSecMenu(null)} />}
    </aside>
  );
}
