import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type * as Monaco from 'monaco-editor';
import { languageFor, loadMonaco } from '../../lib/monaco';

export interface MergeOutputHandle {
  /** Replaces the text of conflict `i` (through executeEdits, so Undo works). `unresolved` puts the empty placeholder line back. */
  replaceRegion: (i: number, text: string, unresolved: boolean) => void;
  revealRegion: (i: number) => void;
}

interface Props {
  path: string;
  initial: string;
  offsets: number[];
  wrap: boolean;
  /** Called with the output text after every change. */
  onText: (text: string) => void;
  /** The user typed in, undid or redid something: the conflicts it touched, and every conflict's current text (empty placeholders as ''). */
  onEdited: (hits: number[], texts: string[]) => void;
  ref?: Ref<MergeOutputHandle>;
}

export function MergeOutput({ path, initial, offsets, wrap, onText, onEdited, ref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const regions = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  // A region with nothing taken shows one empty placeholder line (a newline) when text follows it; that newline is not part of the output.
  const placeholder = useRef<boolean[]>([]);
  const physical = (() => {
    let out = '';
    let last = 0;
    offsets.forEach((o) => {
      out += initial.slice(last, o) + (o < initial.length ? '\n' : '');
      last = o;
    });
    return out + initial.slice(last);
  })();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const cb = useRef({ onText, onEdited });
  cb.current = { onText, onEdited };
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;

  const ranges = (): Monaco.Range[] => {
    const c = regions.current;
    return c ? offsets.map((_, i) => c.getRange(i)!) : [];
  };

  /** The editor text without the placeholder newlines. */
  const logical = (): string => {
    const model = editorRef.current?.getModel();
    if (!model) return '';
    let out = model.getValue();
    const all = ranges();
    for (let i = all.length - 1; i >= 0; i--) {
      if (!placeholder.current[i]) continue;
      const s = model.getOffsetAt(all[i]!.getStartPosition());
      const e = model.getOffsetAt(all[i]!.getEndPosition());
      if (out.slice(s, e) === '\n') out = out.slice(0, s) + out.slice(e);
      else placeholder.current[i] = false;
    }
    return out;
  };
  /** Each conflict region's own text (an empty placeholder counts as ''). */
  const regionTexts = (): string[] => {
    const model = editorRef.current?.getModel();
    if (!model) return [];
    const value = model.getValue();
    return ranges().map((r, i) => {
      const t = value.slice(model.getOffsetAt(r.getStartPosition()), model.getOffsetAt(r.getEndPosition()));
      return placeholder.current[i] && t === '\n' ? '' : t;
    });
  };
  const publish = () => {
    const t = logical();
    setValue(t);
    cb.current.onText(t);
  };

  useImperativeHandle(
    ref,
    () => ({
      replaceRegion: (i, text, unresolved) => {
        const ed = editorRef.current;
        const m = monacoRef.current;
        const model = ed?.getModel();
        const c = regions.current;
        if (!ed || !m || !model || !c) return;
        const all = ranges();
        const r = all[i];
        if (!r) return;
        const startOffset = model.getOffsetAt(r.getStartPosition());
        const hasText = model.getOffsetAt(r.getEndPosition()) < model.getValueLength();
        const ph = unresolved && text === '' && hasText;
        if (ph) text = '\n';
        placeholder.current[i] = ph;
        applying.current = true;
        try {
          ed.executeEdits('merge-take', [{ range: r, text, forceMoveMarkers: true }]);
        } finally {
          applying.current = false;
        }
        // The region is exactly the new text; the other regions moved with the edit.
        const next = ranges();
        next[i] = Monaco_range(m, model.getPositionAt(startOffset), model.getPositionAt(startOffset + text.length));
        setRegions(m, next);
        snapshot.current = next;
        publish();
      },
      revealRegion: (i) => {
        const r = ranges()[i];
        if (r) editorRef.current?.revealLineInCenter(r.startLineNumber);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [offsets],
  );

  const applying = useRef(false);
  const snapshot = useRef<Monaco.Range[]>([]);

  function Monaco_range(m: typeof Monaco, s: Monaco.Position, e: Monaco.Position): Monaco.Range {
    return new m.Range(s.lineNumber, s.column, e.lineNumber, e.column);
  }
  function setRegions(m: typeof Monaco, list: Monaco.Range[]): void {
    regions.current?.set(list.map((range) => ({ range, options: { stickiness: m.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges } })));
  }

  useEffect(() => {
    let disposed = false;
    const owned: { dispose: () => void }[] = [];
    loadMonaco()
      .then((m) => {
        const el = host.current;
        if (disposed || !el) return;
        monacoRef.current = m;
        const model = m.editor.createModel(physical, languageFor(m, path));
        model.setEOL(m.editor.EndOfLineSequence.LF);
        const editor = m.editor.create(el, {
          model,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          unusualLineTerminators: 'off',
          wordWrap: wrapRef.current ? 'on' : 'off',
          contextmenu: false,
          hover: { enabled: 'off' },
          quickSuggestions: false,
          links: false,
          renderLineHighlight: 'none',
          lineNumbersMinChars: 3,
        });
        editorRef.current = editor;
        regions.current = editor.createDecorationsCollection();
        setRegions(
          m,
          offsets.map((o, i) => {
            const s = model.getPositionAt(o + i);
            return Monaco_range(m, s, model.getPositionAt(o + i + (o < initial.length ? 1 : 0)));
          }),
        );
        placeholder.current = offsets.map((o) => o < initial.length);
        snapshot.current = ranges();
        owned.push(
          editor,
          model,
          model.onDidChangeContent((e) => {
            if (applying.current) return; // replaceRegion publishes once the regions are set
            // Which conflict regions did this edit touch? Compared against their places before the edit.
            const hits: number[] = [];
            snapshot.current.forEach((r, i) => {
              const hit = placeholder.current[i]
                ? e.changes.some((ch) => ch.range.startLineNumber <= r.startLineNumber && ch.range.endLineNumber >= r.startLineNumber)
                : e.changes.some((ch) => m.Range.areIntersectingOrTouching(r, ch.range));
              if (hit) {
                placeholder.current[i] = false;
                hits.push(i);
              }
            });
            snapshot.current = ranges();
            if (e.isUndoing || e.isRedoing) {
              // Undoing a take puts the region's newline placeholder back as plain text; it is the placeholder again.
              const value = model.getValue();
              ranges().forEach((r, i) => {
                const s = model.getOffsetAt(r.getStartPosition());
                const en = model.getOffsetAt(r.getEndPosition());
                if (hits.includes(i) && value.slice(s, en) === '\n' && en < value.length) placeholder.current[i] = true;
              });
            }
            publish();
            cb.current.onEdited(hits, regionTexts());
          }),
        );
        publish();
      })
      .catch((e: unknown) => !disposed && setError(e instanceof Error ? e.message : 'Could not load the editor.'));
    return () => {
      disposed = true;
      editorRef.current = null;
      regions.current = null;
      for (const d of owned) d.dispose();
    };
    // The model is built once per opened file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, initial]);

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
  }, [wrap]);

  return (
    <div className="merge-output-host" data-testid="merge-output" data-value={value}>
      <div className="merge-monaco" ref={host} />
      {error && <div className="diff-message error">{error}</div>}
    </div>
  );
}
