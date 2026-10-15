import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import type { MergeSideInfo } from '@gitslappin/shared';
import { languageFor, loadMonaco } from '../../lib/monaco';

interface Props {
  side: 'a' | 'b';
  path: string;
  text: string;
  /** 0-based first line and line count of each conflict in this pane's text. */
  regions: { start: number; len: number }[];
  takes: boolean[];
  /** This side has no file (deleted there): its checkboxes are disabled. */
  missing: boolean;
  info: MergeSideInfo;
  wrap: boolean;
  allTaken: boolean;
  onToggle: (i: number) => void;
  onTakeAll: () => void;
  reveal: { index: number; nonce: number };
}

export function MergeSidePane({ side, path, text, regions, takes, missing, info, wrap, allTaken, onToggle, onTakeAll, reveal }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const regionsRef = useRef(regions);
  regionsRef.current = regions;
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;

  useEffect(() => {
    let disposed = false;
    const owned: { dispose: () => void }[] = [];
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
          unusualLineTerminators: 'off',
          wordWrap: wrapRef.current ? 'on' : 'off',
          contextmenu: false,
          renderLineHighlight: 'none',
          hover: { enabled: 'off' },
          quickSuggestions: false,
          links: false,
          glyphMargin: true,
          lineNumbersMinChars: 3,
        });
        editorRef.current = editor;
        const lines = model.getLineCount();
        editor.createDecorationsCollection(
          regionsRef.current.flatMap((r) =>
            r.len === 0
              ? []
              : [
                  {
                    range: new m.Range(r.start + 1, 1, Math.min(lines, r.start + r.len), 1),
                    options: { isWholeLine: true, className: `merge-region merge-region-${side}`, linesDecorationsClassName: `merge-border merge-border-${side}` },
                  },
                ],
          ),
        );
        const bump = () => setTick((n) => n + 1);
        owned.push(editor, model, editor.onDidScrollChange(bump), editor.onDidLayoutChange(bump), editor.onDidContentSizeChange(bump));
        bump();
      })
      .catch((e: unknown) => !disposed && setError(e instanceof Error ? e.message : 'Could not load the editor.'));
    return () => {
      disposed = true;
      editorRef.current = null;
      for (const d of owned) d.dispose();
    };
    // Rebuilt only when another file (or other text) is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, text, side]);

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
  }, [wrap]);

  useEffect(() => {
    const r = regionsRef.current[reveal.index];
    if (r && reveal.nonce > 0) editorRef.current?.revealLineInCenter(r.start + 1);
  }, [reveal]);

  const ed = editorRef.current;
  const lineCount = ed?.getModel()?.getLineCount() ?? 1;
  const letter = side.toUpperCase();
  return (
    <div className={`merge-pane merge-pane-${side}`}>
      <div className="merge-pane-head">
        <button
          className={`merge-all-box${allTaken ? ' on' : ''}`}
          data-testid={`merge-take-all-${side}`}
          disabled={missing}
          title={allTaken ? 'Untake all' : 'Take all'}
          aria-label={allTaken ? 'Untake all' : 'Take all'}
          onClick={onTakeAll}
        >
          <span className="merge-checkbox" aria-hidden="true" />
        </button>
        <span className={`merge-badge merge-badge-${side}`} data-testid={`merge-badge-${side}`}>
          {letter}
        </span>
        <span className="merge-pane-title" data-testid={`merge-pane-title-${side}`}>
          {info.stash ? 'Stash' : `Commit ${info.sha}`}
          {info.branch ? ' on ' : ''}
          {info.branch && <em className={`merge-branch merge-branch-${side}`}>{info.branch}</em>}
        </span>
      </div>
      <div className="merge-pane-body" data-testid={`merge-pane-${side}`} data-value={text}>
        <div className="merge-monaco" ref={host} />
        {ed &&
          regions.map((r, i) => {
            const line = Math.min(lineCount, r.start + 1);
            const top = ed.getTopForLineNumber(line) - ed.getScrollTop();
            if (top < -20 || top > ed.getLayoutInfo().height) return null;
            const on = takes[i] ?? false;
            return (
              <button
                key={i}
                className={`merge-take merge-take-${side}${on ? ' on' : ''}`}
                style={{ top: top + 2 }}
                role="checkbox"
                aria-checked={on}
                aria-label={`Take ${letter}`}
                disabled={missing}
                data-testid={`merge-take-${side}`}
                data-conflict={i}
                onClick={() => onToggle(i)}
              />
            );
          })}
        {error && <div className="diff-message error">{error}</div>}
      </div>
    </div>
  );
}
