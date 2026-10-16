import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Plus, Trash2, X } from 'lucide-react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Theme } from '@gitslappin/shared';
import { api } from '../api';
import { terminalSocket } from '../lib/terminalSocket';
import { useTerminalSlot } from '../lib/terminalSlot';
import { ConfirmBar } from './ConfirmBar';
import { ContextMenu } from './menu/ContextMenu';
import type { MenuEntry } from '../lib/refMenu';

/** Wording from en-us.json: Terminal-*, TerminalToolbar-*, TerminalContextMenu-*. */
const T = {
  tab: (n: number) => `Terminal ${n}`,
  closeTab: (n: number) => `Close Terminal ${n}`,
  newTab: 'New terminal tab',
  kill: 'Kill Terminal',
  killAll: 'Kill All Terminals',
  killAllConfirm: (n: number) => `Kill ${n} terminals? Any running processes will be stopped.`,
  minimize: 'Minimize Terminal',
  expand: 'Expand Terminal',
  hide: 'Hide Terminal',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
  clear: 'Clear',
  closeTerminal: 'Close Terminal',
} as const;

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;

/** The terminal__* theme tokens (client/src/theme/*.css), read from the page so the light and dark themes both apply. */
function readTerminalTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(`--terminal__${n}`).trim();
  const t: Record<string, string> = { background: v('background'), foreground: v('foreground'), cursor: v('cursor'), cursorAccent: v('cursorAccent'), selectionBackground: v('selection') };
  for (const n of NAMES) t[n] = v(n);
  return t as ITheme;
}

interface Sess {
  key: string;
  repoId: string;
  n: number;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  fontSize: number;
  shell: string;
  serverId: string | null;
  /** Keys typed before the server answered `opened` (the shell is still starting): sent as soon as it did. */
  early: string;
  started: boolean;
  closed: boolean;
}

export interface TerminalHostHandle {
  /** Show or hide the active repository's panel; showing it with no terminal opens the first one. */
  toggle: () => void;
}

interface Props {
  /** The active repository tab (null on the Open view: no panel). */
  repoId: string | null;
  /** Every open repository tab; the terminals of a closed tab are killed. null until the tabs are loaded. */
  openRepoIds: string[] | null;
  theme: Theme;
  onError: () => void;
  /** The connection dropped and the running terminals were closed. */
  onLost: () => void;
}

let seq = 0;
const MIN_H = 120;

const fitSafe = (s: Sess): void => {
  try {
    s.fit.fit();
  } catch {
    // not measurable yet (hidden)
  }
};

/**
 * V6b: the in-app terminal panel. It lives at App level so every repository keeps its own terminals while another tab is shown; only the active
 * repository's panel is visible. Hide keeps the sessions; closing a tab or Kill ends the shell on the server.
 */
export const TerminalHost = forwardRef<TerminalHostHandle, Props>(function TerminalHost({ repoId, openRepoIds, theme, onError, onLost }, ref) {
  const slot = useTerminalSlot();
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [activeBy, setActiveBy] = useState<Record<string, string>>({});
  const [minimized, setMinimized] = useState(false);
  const [height, setHeight] = useState(280);
  const [killAllAsk, setKillAllAsk] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const counters = useRef<Record<string, number>>({});
  const creating = useRef(new Set<string>());
  const sessRef = useRef(sessions);
  sessRef.current = sessions;
  const bodyRef = useRef<HTMLDivElement>(null);
  const errRef = useRef(onError);
  errRef.current = onError;
  const lostRef = useRef(onLost);
  lostRef.current = onLost;
  const openRef = useRef(openRepoIds);
  openRef.current = openRepoIds;

  useEffect(() => {
    terminalSocket.onLost = () => lostRef.current();
    return () => {
      terminalSocket.onLost = null;
    };
  }, []);

  const mine = sessions.filter((s) => s.repoId === repoId);
  const activeKey = repoId ? (activeBy[repoId] && mine.some((s) => s.key === activeBy[repoId]) ? activeBy[repoId] : mine[0]?.key) : undefined;
  const open = !!repoId && !!shown[repoId] && mine.length > 0 && !!slot;
  const visibleKey = open && !minimized ? activeKey : undefined;

  const closeSession = useCallback((key: string, killRemote = true) => {
    const s = sessRef.current.find((x) => x.key === key);
    if (!s || s.closed) return;
    s.closed = true;
    if (killRemote && s.serverId) terminalSocket.kill(s.serverId);
    try {
      s.term.dispose();
    } catch {
      // already disposed
    }
    const rest = sessRef.current.filter((x) => x.key !== key);
    sessRef.current = rest;
    setSessions(rest);
    const sameRepo = rest.filter((x) => x.repoId === s.repoId);
    if (sameRepo.length === 0) setShown((v) => ({ ...v, [s.repoId]: false }));
    else setActiveBy((a) => (a[s.repoId] === key ? { ...a, [s.repoId]: sameRepo[sameRepo.length - 1]!.key } : a));
  }, []);

  const startSession = useCallback(
    (s: Sess) => {
      s.started = true;
      s.term.open(s.el);
      fitSafe(s);
      // Ctrl+` is the panel toggle: xterm must not consume it, so it reaches the app's shortcut listener.
      s.term.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '`'));
      s.term.onData((d) => {
        if (s.serverId) terminalSocket.input(s.serverId, d);
        else if (!s.closed && s.early.length < 65_536) s.early += d;
      });
      s.term.onResize(({ cols, rows }) => {
        if (s.serverId) terminalSocket.resize(s.serverId, cols, rows);
      });
      terminalSocket
        .open(s.repoId, s.term.cols, s.term.rows, s.shell, { out: (d) => s.term.write(d), exit: () => closeSession(s.key, false) })
        .then((id) => {
          if (s.closed) {
            terminalSocket.kill(id);
            return;
          }
          s.serverId = id;
          terminalSocket.resize(id, s.term.cols, s.term.rows);
          if (s.early) terminalSocket.input(id, s.early);
          s.early = '';
        })
        .catch(() => {
          if (s.closed) return;
          errRef.current();
          closeSession(s.key, false);
        });
    },
    [closeSession],
  );

  const create = useCallback(async (repo: string) => {
    if (creating.current.has(repo)) return;
    creating.current.add(repo);
    try {
      const prefs = await api.getPrefs().catch(() => null);
      if (openRef.current && !openRef.current.includes(repo)) return; // the repository tab was closed while the prefs were loading
      const fontSize = prefs?.terminalFontSize ?? 13;
      const term = new Terminal({
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize,
        lineHeight: 1.0,
        cursorStyle: prefs?.terminalCursor ?? 'block',
        cursorBlink: true,
        scrollback: 5000,
        theme: readTerminalTheme(),
        // OSC 8 links open only as http(s), without opener. No clipboard addon is loaded, so OSC 52 stays unsupported.
        linkHandler: {
          allowNonHttpProtocols: false,
          activate: (_e, text) => {
            if (/^https?:\/\//i.test(text)) window.open(text, '_blank', 'noopener,noreferrer');
          },
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      const el = document.createElement('div');
      el.className = 'terminal-xterm';
      const n = (counters.current[repo] = (counters.current[repo] ?? 0) + 1);
      const s: Sess = { key: `term-${++seq}`, repoId: repo, n, term, fit, el, fontSize, shell: prefs?.terminalShell ?? 'powershell', serverId: null, early: '', started: false, closed: false };
      sessRef.current = [...sessRef.current, s];
      setSessions(sessRef.current);
      setActiveBy((a) => ({ ...a, [repo]: s.key }));
      setShown((v) => ({ ...v, [repo]: true }));
      setMinimized(false);
    } finally {
      creating.current.delete(repo);
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      toggle: () => {
        if (!repoId) return;
        if (shown[repoId] && sessRef.current.some((s) => s.repoId === repoId)) {
          setShown((v) => ({ ...v, [repoId]: false }));
          return;
        }
        if (sessRef.current.some((s) => s.repoId === repoId)) {
          setShown((v) => ({ ...v, [repoId]: true }));
          setMinimized(false);
        } else void create(repoId);
      },
    }),
    [repoId, shown, create],
  );

  // A terminal opens its shell once it is on screen (xterm needs the size of its box).
  useLayoutEffect(() => {
    for (const s of sessions) if (!s.started && s.key === visibleKey) startSession(s);
  }, [sessions, visibleKey, startSession]);

  // Showing a panel, switching tabs or expanding: fit the active terminal and give it the keyboard.
  useEffect(() => {
    if (!visibleKey) return;
    const raf = requestAnimationFrame(() => {
      const s = sessRef.current.find((x) => x.key === visibleKey);
      if (!s) return;
      fitSafe(s);
      s.term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visibleKey, slot]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const s = sessRef.current.find((x) => x.key === visibleKey);
      if (s && s.started) fitSafe(s);
    });
    ro.observe(body);
    return () => ro.disconnect();
  }, [visibleKey, slot]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const t = readTerminalTheme();
      for (const s of sessRef.current) s.term.options.theme = t;
    });
    return () => cancelAnimationFrame(raf);
  }, [theme]);

  // A closed repository tab takes its terminals with it.
  useEffect(() => {
    if (!openRepoIds) return;
    for (const s of sessRef.current) if (!openRepoIds.includes(s.repoId)) closeSession(s.key);
  }, [openRepoIds, closeSession]);

  const drag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: MouseEvent) => setHeight(Math.max(MIN_H, Math.min(Math.round(window.innerHeight * 0.8), startH + (startY - ev.clientY))));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const menuSess = menu ? sessions.find((s) => s.key === menu.key) : undefined;
  const menuEntries: MenuEntry[] = menuSess
    ? [
        {
          type: 'item',
          id: 'copy',
          label: T.copy,
          run: () => {
            const sel = menuSess.term.getSelection();
            if (sel) void navigator.clipboard?.writeText(sel).catch(() => undefined);
            menuSess.term.focus();
          },
        },
        {
          type: 'item',
          id: 'paste',
          label: T.paste,
          run: () => {
            // term.paste() applies bracketed paste when the shell asked for it.
            void navigator.clipboard
              ?.readText()
              .then((t) => menuSess.term.paste(t))
              .catch(() => undefined);
            menuSess.term.focus();
          },
        },
        { type: 'item', id: 'select-all', label: T.selectAll, run: () => menuSess.term.selectAll() },
        { type: 'divider' },
        { type: 'item', id: 'clear', label: T.clear, run: () => menuSess.term.clear() },
        { type: 'item', id: 'close', label: T.closeTerminal, run: () => closeSession(menuSess.key) },
      ]
    : [];

  if (!slot) return null;
  return createPortal(
    <div className="terminal-panel" data-testid="terminal-panel" data-minimized={String(minimized)} style={{ display: open ? 'flex' : 'none', ...(minimized ? {} : { height }) }}>
      <div className="terminal-resize-handle" data-testid="terminal-resize-handle" onMouseDown={drag} />
      <div className="terminal-strip">
        <div className="terminal-tabs">
          {mine.map((s) => (
            <div key={s.key} className={`terminal-tab${s.key === activeKey ? ' active' : ''}`} data-testid="terminal-tab" data-active={String(s.key === activeKey)} onClick={() => repoId && setActiveBy((a) => ({ ...a, [repoId]: s.key }))}>
              <span className="terminal-tab-label">{`${s.shell}.exe`}</span>
              <button
                className="terminal-icon-btn"
                data-testid="terminal-tab-close"
                title={T.closeTab(s.n)}
                aria-label={T.closeTab(s.n)}
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(s.key);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button className="terminal-icon-btn" data-testid="terminal-new" title={T.newTab} aria-label={T.newTab} onClick={() => repoId && void create(repoId)}>
            <Plus size={14} />
          </button>
        </div>
        <div className="terminal-actions">
          <button className="terminal-icon-btn" data-testid="terminal-minimize" title={minimized ? T.expand : T.minimize} aria-label={minimized ? T.expand : T.minimize} onClick={() => setMinimized((m) => !m)}>
            {minimized ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {/* One trash icon (screen 33): Kill Terminal with a single tab, Kill All Terminals (confirmed) with several. */}
          <button
            className="terminal-icon-btn"
            data-testid={mine.length > 1 ? 'terminal-kill-all' : 'terminal-kill'}
            title={mine.length > 1 ? T.killAll : T.kill}
            aria-label={mine.length > 1 ? T.killAll : T.kill}
            onClick={() => (mine.length > 1 ? setKillAllAsk(true) : activeKey && closeSession(activeKey))}
          >
            <Trash2 size={14} />
          </button>
          <button className="terminal-icon-btn" data-testid="terminal-hide" title={T.hide} aria-label={T.hide} onClick={() => repoId && setShown((v) => ({ ...v, [repoId]: false }))}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="terminal-body" ref={bodyRef} style={{ display: minimized ? 'none' : 'block' }}>
        {sessions.map((s) => (
          <div
            key={s.key}
            className="terminal-screen"
            data-testid="terminal-screen"
            data-font-size={s.fontSize}
            style={{ display: s.key === visibleKey ? 'block' : 'none' }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, key: s.key });
            }}
            ref={(node) => {
              if (node && s.el.parentElement !== node) node.appendChild(s.el);
            }}
          />
        ))}
      </div>
      {killAllAsk && (
        <ConfirmBar
          kind="kill-all-terminals"
          message={T.killAllConfirm(sessions.length)}
          okLabel={T.killAll}
          onOk={() => {
            setKillAllAsk(false);
            for (const s of [...sessRef.current]) closeSession(s.key);
          }}
          onCancel={() => setKillAllAsk(false)}
        />
      )}
      {menu && menuSess && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries} onClose={() => setMenu(null)} />}
    </div>,
    slot,
  );
});
