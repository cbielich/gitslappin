import { useEffect, useMemo, useState, type RefObject } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Cloud, Inbox, Laptop, Search, Tag } from 'lucide-react';
import type { RefsInfo } from '@gitslappin/shared';
import type { MenuCtx } from '../lib/refMenu';
import { readJson, writeJson } from '../lib/storage';

interface Props {
  repoId: string;
  refs: RefsInfo | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  filterRef: RefObject<HTMLInputElement | null>;
  onJump: (sha: string) => void;
  onMenu: (x: number, y: number, ctx: Omit<MenuCtx, 'head'>) => void;
  /** Double-click on a LOCAL or REMOTE item (a remote name is the full `origin/x`). */
  onCheckout: (kind: 'local' | 'remote', name: string) => void;
  /** A click on a stash item opens that stash (its file list), instead of jumping to a commit. */
  onSelectStash: (sha: string) => void;
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

function Section({ id, label, Icon, count, open, onToggle, children }: { id: string; label: string; Icon: typeof Laptop; count: number; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="sb-section" data-testid={`sidebar-section-${id}`}>
      <button className="sb-section-head" onClick={onToggle} data-testid={`sidebar-toggle-${id}`} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Icon size={13} />
        <span className="sb-section-label">{label}</span>
        <span className="sb-count" data-testid={`sidebar-count-${id}`}>
          {count}
        </span>
      </button>
      {open && <div className="sb-items">{children}</div>}
    </div>
  );
}

export function Sidebar({ repoId, refs, collapsed, onToggleCollapse, filterRef, onJump, onMenu, onCheckout, onSelectStash, rail = false, hidden = false }: Props) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>(() => loadOpen(repoId));
  useEffect(() => setOpen(loadOpen(repoId)), [repoId]);
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
  const viewing = data.local.length + remoteCount + data.stashes.length;

  if (collapsed || rail) {
    const railItems: { id: string; label: string; Icon: typeof Laptop; n: number }[] = [
      { id: 'local', label: 'LOCAL', Icon: Laptop, n: refs?.local.length ?? 0 },
      { id: 'remote', label: 'REMOTE', Icon: Cloud, n: (refs?.remotes ?? []).reduce((n, g) => n + g.branches.length, 0) },
      { id: 'stashes', label: 'STASHES', Icon: Inbox, n: refs?.stashes.length ?? 0 },
      { id: 'tags', label: 'TAGS', Icon: Tag, n: refs?.tags.length ?? 0 },
    ];
    return (
      <aside className="left-panel collapsed" data-testid="left-panel" data-collapsed="true" {...(hidden ? { style: { display: 'none' } } : {})}>
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
      data-kind={it.kind}
      data-name={it.name}
      title={it.name}
      onClick={() => (it.kind === 'stash' ? onSelectStash(it.sha) : onJump(it.sha))}
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
        if (it.kind !== 'local' && it.kind !== 'remote') return;
        e.preventDefault();
        onMenu(e.clientX, e.clientY, {
          target: it.kind === 'local' ? 'sidebar-local' : 'sidebar-remote',
          sha: it.sha,
          branch: { name: it.name, local: it.kind === 'local', remote: it.kind === 'remote', current: !!it.current },
        });
      }}
    >
      {it.current && <Check size={11} />}
      <span className="sb-item-name">{it.name}</span>
      {!!it.ahead && (
        <span className="sb-track">
          <ArrowUp size={10} />
          {it.ahead}
        </span>
      )}
      {!!it.behind && (
        <span className="sb-track">
          <ArrowDown size={10} />
          {it.behind}
        </span>
      )}
    </button>
  );

  return (
    <aside className="left-panel" data-testid="left-panel" data-collapsed="false" {...(hidden ? { style: { display: 'none' } } : {})}>
      <div className="left-header">
        <button className="icon-btn" onClick={onToggleCollapse} data-testid="left-collapse" title="Collapse">
          <ChevronLeft size={14} />
        </button>
        <div className="left-header-col">
          <span className="viewing">
            Viewing{' '}
            <span className="blue" data-testid="viewing-count">
              {viewing}
            </span>
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
        <Section id="local" label="LOCAL" Icon={Laptop} count={data.local.length} open={!!open.local} onToggle={() => toggle('local')}>
          {data.local.map(renderItem)}
        </Section>
        <Section id="remote" label="REMOTE" Icon={Cloud} count={remoteCount} open={!!open.remote} onToggle={() => toggle('remote')}>
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
        <Section id="stashes" label="STASHES" Icon={Inbox} count={data.stashes.length} open={!!open.stashes} onToggle={() => toggle('stashes')}>
          {data.stashes.map(renderItem)}
        </Section>
        <Section id="tags" label="TAGS" Icon={Tag} count={data.tags.length} open={!!open.tags} onToggle={() => toggle('tags')}>
          {data.tags.map(renderItem)}
        </Section>
      </div>
    </aside>
  );
}
