import { useEffect, useMemo, useRef, useState } from 'react';
import { wordDiffHunk, type DiffHunk, type FileDiff } from '@gitslappin/shared';
import { ensureTokenizer, languageFor, loadMonaco } from '../../lib/monaco';
import type { DiffAction } from './DiffView';
import { tokenizeLines, toPieces, type TokSpan } from './highlight';

/** Hunks longer than this are shown without syntax colouring. */
const MAX_COLOR_LINES = 1000;

/** Stage / Unstage controls (left out where staging does not apply). */
export interface Staging {
  side: 'unstaged' | 'staged';
  busy: boolean;
  onAction: (a: DiffAction) => void;
  /** Discard Hunk (unstaged side only): no confirm bar, the server checks the header. */
  onDiscard?: (hunk: number, header: string) => void;
}

interface HunkProps {
  hunk: DiffHunk;
  hunkIdx: number;
  path: string;
  /** Change number of the first line of each change block in this hunk, by line index. */
  changeAt: Map<number, number>;
  staging: Staging | undefined;
  /** Selected line indexes of this hunk (shift-click). */
  selectedLines: ReadonlySet<number> | undefined;
  onLine: (hunkIdx: number, line: number, shift: boolean) => void;
}

function Hunk({ hunk, hunkIdx, path, changeAt, staging, selectedLines, onLine }: HunkProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [toks, setToks] = useState<TokSpan[][] | null>(null);

  // Colouring and word diff only run for hunks that have been on screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const words = useMemo(() => (visible ? wordDiffHunk(hunk.lines) : null), [visible, hunk]);

  useEffect(() => {
    if (!visible || hunk.lines.length > MAX_COLOR_LINES) return;
    let stale = false;
    loadMonaco()
      .then(async (m) => {
        const lang = languageFor(m, path);
        await ensureTokenizer(m, lang);
        if (!stale) setToks(tokenizeLines(m, hunk.lines.map((l) => l.text), lang));
      })
      .catch(() => undefined); // no colouring is fine
    return () => {
      stale = true;
    };
  }, [visible, hunk, path]);

  return (
    <div className="hunk" ref={ref}>
      <div className="hunk-head">
        <span className="hunk-header" data-testid="hunk-header">
          {hunk.header}
        </span>
        <span className="hunk-actions" data-slot="hunk-actions">
          {staging?.onDiscard && (
            <button className="stage-btn unstage" data-testid="hunk-discard" title="Discard Hunk" disabled={staging.busy} onClick={() => staging.onDiscard?.(hunkIdx, hunk.header)}>
              Discard Hunk
            </button>
          )}
          {staging && (
            <button
              className={`stage-btn ${staging.side === 'staged' ? 'unstage' : 'stage'}`}
              data-testid="hunk-action"
              title={staging.side === 'staged' ? 'Unstage Hunk' : 'Stage Hunk'}
              disabled={staging.busy}
              onClick={() => staging.onAction({ kind: 'hunk', hunk: hunkIdx, header: hunk.header })}
            >
              {staging.side === 'staged' ? 'Unstage Hunk' : 'Stage Hunk'}
            </button>
          )}
        </span>
      </div>
      {hunk.lines.map((l, i) => {
        const text = l.text.replace(/\r$/, '');
        const change = changeAt.get(i);
        return (
          <div key={i}>
            <div className={`diff-line ${l.kind}${selectedLines?.has(i) ? ' sel' : ''}`} data-testid="diff-line" data-kind={l.kind} {...(change !== undefined ? { 'data-change-index': change } : {})}>
              <span className="line-plus-slot" data-slot="line-plus">
                {staging && l.kind !== 'context' && (
                  <button
                    className={`line-action ${staging.side === 'staged' ? 'unstage' : 'stage'}`}
                    data-testid="line-action"
                    title={staging.side === 'staged' ? 'Unstage this line' : 'Stage this line'}
                    disabled={staging.busy}
                    onClick={(e) => onLine(hunkIdx, i, e.shiftKey)}
                  >
                    {staging.side === 'staged' ? '−' : '+'}
                  </button>
                )}
              </span>
              <span className="gutter gutter-old" data-testid="gutter-old">
                {l.oldNo ?? ''}
              </span>
              <span className="gutter gutter-new" data-testid="gutter-new">
                {l.newNo ?? ''}
              </span>
              <span className="line-text" data-testid="line-text">
                {toPieces(text, toks?.[i], words?.[i]).map((p, k) => (
                  <span key={k} className={`${p.cls}${p.changed ? ' wd' : ''}`}>
                    {p.text}
                  </span>
                ))}
              </span>
            </div>
            {l.noEol && <div className="line-noeol">\ No newline at end of file</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Change blocks: runs of added/deleted lines. Returns, per hunk, the change number at each block's first line. */
export function changeBlocks(diff: FileDiff): { perHunk: Map<number, number>[]; count: number } {
  let count = 0;
  const perHunk = diff.hunks.map((h) => {
    const m = new Map<number, number>();
    let inBlock = false;
    h.lines.forEach((l, i) => {
      const changed = l.kind !== 'context';
      if (changed && !inBlock) m.set(i, count++);
      inBlock = changed;
    });
    return m;
  });
  return { perHunk, count };
}

interface Props {
  diff: FileDiff;
  staging?: Staging | undefined;
  wrap: boolean;
  /** Current change number (-1 for none): scrolled into view. */
  current: number;
  onCount: (n: number) => void;
}

export function HunkView({ diff, wrap, current, onCount, staging }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => changeBlocks(diff), [diff]);
  const { count } = blocks;
  const [sel, setSel] = useState<{ hunk: number; lines: Set<number>; anchor: number } | null>(null);
  // A new diff (after a stage or unstage) has new line numbers: the selection no longer means anything.
  useEffect(() => setSel(null), [diff]);

  const onLine = (h: number, i: number, shift: boolean) => {
    const hunk = diff.hunks[h];
    if (!hunk || !staging) return;
    if (shift) {
      // Shift-click picks a range of changed lines (nothing is staged yet).
      const anchor = sel && sel.hunk === h ? sel.anchor : i;
      const lines = new Set<number>();
      for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) if (hunk.lines[k] && hunk.lines[k]!.kind !== 'context') lines.add(k);
      setSel({ hunk: h, lines, anchor });
      return;
    }
    // A click on a selected line acts on the whole selection; otherwise on that one line.
    const chosen = sel && sel.hunk === h && sel.lines.has(i) ? [...sel.lines].sort((a, b) => a - b) : [i];
    setSel(null);
    staging.onAction({ kind: 'lines', hunk: h, header: hunk.header, lines: chosen });
  };
  useEffect(() => onCount(count), [count, onCount]);

  useEffect(() => {
    if (current < 0) return;
    root.current?.querySelector(`[data-change-index="${current}"]`)?.scrollIntoView({ block: 'center' });
  }, [current]);

  return (
    <div className={`hunk-view${wrap ? ' wrap' : ''}`} ref={root} data-testid="hunk-view">
      {diff.hunks.map((h, i) => (
        <Hunk key={i} hunk={h} hunkIdx={i} path={diff.path} changeAt={blocks.perHunk[i] ?? new Map()} staging={staging} selectedLines={sel && sel.hunk === i ? sel.lines : undefined} onLine={onLine} />
      ))}
    </div>
  );
}
