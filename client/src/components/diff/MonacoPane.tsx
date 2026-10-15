import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { languageFor, loadMonaco } from '../../lib/monaco';

export interface MonacoHandle {
  goTo: (dir: 'next' | 'previous') => void;
}

interface Props {
  /** inline / split: read-only DiffEditor. file: read-only editor of the new content. */
  kind: 'inline' | 'split' | 'file';
  oldText: string;
  newText: string;
  path: string;
  wrap: boolean;
  ignoreWhitespace: boolean;
  onCount: (n: number) => void;
  ref?: Ref<MonacoHandle>;
}

type Disposable = { dispose: () => void };

export function MonacoPane({ kind, oldText, newText, path, wrap, ignoreWhitespace, onCount, ref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const diffEditor = useRef<{ goToDiff: (t: 'next' | 'previous') => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const countCb = useRef(onCount);
  countCb.current = onCount;

  useImperativeHandle(ref, () => ({ goTo: (dir) => diffEditor.current?.goToDiff(dir) }), []);

  useEffect(() => {
    let disposed = false;
    const owned: Disposable[] = [];
    setError(null);
    countCb.current(0);
    loadMonaco()
      .then((m) => {
        const el = host.current;
        if (disposed || !el) return;
        const language = languageFor(m, path);
        const common = {
          readOnly: true,
          domReadOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: wrap ? ('on' as const) : ('off' as const),
          contextmenu: false,
          renderLineHighlight: 'none' as const,
          hover: { enabled: 'off' as const },
          quickSuggestions: false,
          links: false,
        };
        if (kind === 'file') {
          const model = m.editor.createModel(newText, language);
          const editor = m.editor.create(el, { ...common, model });
          owned.push(editor, model);
          countCb.current(0);
          return;
        }
        const original = m.editor.createModel(oldText, language);
        const modified = m.editor.createModel(newText, language);
        const editor = m.editor.createDiffEditor(el, {
          ...common,
          renderSideBySide: kind === 'split',
          originalEditable: false,
          ignoreTrimWhitespace: ignoreWhitespace,
          maxComputationTime: 5000,
          renderOverviewRuler: true,
          experimental: { showMoves: false },
        });
        editor.setModel({ original, modified });
        diffEditor.current = editor;
        // The count is read again right away and after every diff update, so a view switch never keeps an old number.
        countCb.current(editor.getLineChanges()?.length ?? 0);
        owned.push(
          editor.onDidUpdateDiff(() => countCb.current(editor.getLineChanges()?.length ?? 0)),
          editor,
          original,
          modified,
        );
      })
      .catch((e: unknown) => !disposed && setError(e instanceof Error ? e.message : 'Could not load the editor.'));
    return () => {
      disposed = true;
      diffEditor.current = null;
      for (const d of owned) d.dispose();
    };
  }, [kind, oldText, newText, path, wrap, ignoreWhitespace]);

  return (
    <div className="diff-monaco" data-testid="diff-monaco" ref={host}>
      {error && <div className="diff-message error">{error}</div>}
    </div>
  );
}
