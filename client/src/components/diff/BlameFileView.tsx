import { useEffect, useMemo, useRef, useState } from 'react';
import type { BlameResult } from '@gitslappin/shared';
import { identiconUri } from '../../lib/identicon';
import { languageFor, loadMonaco } from '../../lib/monaco';

interface Props {
  text: string;
  path: string;
  /** One sha per file line, with the details of each commit. Null while it is loading or when it failed. */
  blame: BlameResult | null;
  /** Show the summary and date on the first line of each run. */
  blameOn: boolean;
}

interface Run {
  sha: string;
  /** 1-based first line. */
  start: number;
  len: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (epochSeconds: number): string => {
  const d = new Date(epochSeconds * 1000);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
};
/** One of the 12 theme colours --blame-0 .. --blame-11 (theme/*.css). */
const hueOf = (sha: string): number => {
  let h = 0;
  for (let i = 0; i < 8; i++) h = (h * 31 + sha.charCodeAt(i)) % 360;
  return Math.floor(h / 30);
};

/** First run that still reaches `line` (runs are in line order). */
function firstRunAt(runs: Run[], line: number): number {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid]!;
    if (r.start + r.len - 1 < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Read-only Monaco of one file version with a blame gutter on its left. The gutter is plain DOM (text and small images only):
 * only the runs of lines that are on screen are drawn, and it follows the editor's scroll position.
 */
export function BlameFileView({ text, path, blame, blameOn }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0, lineHeight: 19 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const owned: { dispose: () => void }[] = [];
    setError(null);
    setView((v) => ({ ...v, top: 0 }));
    loadMonaco()
      .then((m) => {
        const el = host.current;
        if (disposed || !el) return;
        const model = m.editor.createModel(text, languageFor(m, path));
        const editor = m.editor.create(el, {
          model,
          readOnly: true,
          domReadOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          contextmenu: false,
          renderLineHighlight: 'none',
          hover: { enabled: 'off' },
          quickSuggestions: false,
          links: false,
        });
        owned.push(editor, model);
        const sync = () => setView({ top: editor.getScrollTop(), height: editor.getLayoutInfo().height, lineHeight: editor.getOption(m.editor.EditorOption.lineHeight) });
        sync();
        owned.push(editor.onDidScrollChange(sync), editor.onDidLayoutChange(sync));
      })
      .catch((e: unknown) => !disposed && setError(e instanceof Error ? e.message : 'Could not load the editor.'));
    return () => {
      disposed = true;
      for (const d of owned) d.dispose();
    };
  }, [text, path]);

  const runs = useMemo((): Run[] => {
    const out: Run[] = [];
    (blame?.lines ?? []).forEach((sha, i) => {
      const last = out[out.length - 1];
      if (last && last.sha === sha) last.len++;
      else out.push({ sha, start: i + 1, len: 1 });
    });
    return out;
  }, [blame]);

  const topLine = Math.floor(view.top / view.lineHeight) + 1;
  const bottomLine = Math.ceil((view.top + view.height) / view.lineHeight) + 1;
  const visible: Run[] = [];
  for (let i = firstRunAt(runs, topLine); i < runs.length && runs[i]!.start <= bottomLine; i++) visible.push(runs[i]!);

  return (
    <div className="blame-file" data-testid="blame-file">
      <div className={`blame-gutter${blameOn ? ' wide' : ''}`} data-testid="blame-gutter">
        <div className="blame-gutter-inner" style={{ transform: `translateY(${-view.top}px)` }}>
          {visible.map((r) => {
            const c = blame?.commits[r.sha];
            return (
              <div
                key={r.start}
                className="blame-run"
                data-testid="blame-run"
                data-sha={r.sha}
                title={c ? c.summary : undefined}
                style={{ top: (r.start - 1) * view.lineHeight, height: r.len * view.lineHeight, borderLeftColor: `var(--blame-${hueOf(r.sha)})` }}
              >
                <img className="blame-avatar" data-testid="blame-avatar" src={identiconUri(c?.authorEmail ?? r.sha)} alt="" width={16} height={16} />
                {blameOn && c && (
                  <>
                    <span className="blame-summary" data-testid="blame-summary">
                      {c.summary}
                    </span>
                    <span className="blame-date">{dateOf(c.authorTime)}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="blame-editor" ref={host}>
        {error && <div className="diff-message error">{error}</div>}
      </div>
    </div>
  );
}
