import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import type { FileActionResult, FileEditInfo } from '@gitslappin/shared';
import { ApiRequestError, api } from '../../api';
import { displayPath } from '../../lib/displayPath';
import { languageFor, loadMonaco } from '../../lib/monaco';
import { restoreEols } from '../../lib/restoreEols';

/** Wording from GitKraken's en-us.json: File-Editor, Save, Cancel, Merge-BinaryFile. */
const TEXT = { title: 'File Editor', save: 'Save', cancel: 'Cancel', binary: 'Binary File' };

interface Props {
  repoId: string;
  path: string;
  /** Cancel (the X too): closes without saving, also when there is unsaved typing. */
  onClose: () => void;
  /** After the file was written: the caller refreshes and closes the editor. */
  onSaved: (res: FileActionResult) => void | Promise<void>;
  /** Whether there is unsaved typing (a live refresh must not close a dirty editor). */
  onDirty?: (dirty: boolean) => void;
}

const lf = (s: string): string => s.replace(/\r\n/g, '\n');

/** The working copy of a tracked file in Monaco (LF model). Line endings and the BOM are put back by the save. Never stages. */
export function FileEditor({ repoId, path, onClose, onSaved, onDirty }: Props) {
  const [info, setInfo] = useState<FileEditInfo | null>(null);
  const [binary, setBinary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');
  const host = useRef<HTMLDivElement>(null);
  const text = useRef('');
  const initial = info ? lf(info.text) : '';
  const dirty = !!info && value !== initial;

  useEffect(() => {
    let live = true;
    setInfo(null);
    setBinary(false);
    setError(null);
    setValue('');
    api
      .fileEditGet(repoId, path)
      .then((i) => {
        if (!live) return;
        text.current = lf(i.text);
        setValue(text.current);
        setInfo(i);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiRequestError && e.status === 415) setBinary(true);
        else setError(e instanceof Error ? e.message : 'Request failed.');
      });
    return () => {
      live = false;
    };
  }, [repoId, path]);

  const dirtyCb = useRef(onDirty);
  dirtyCb.current = onDirty;
  useEffect(() => {
    dirtyCb.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCb.current?.(false), []);

  useEffect(() => {
    if (!info) return;
    let disposed = false;
    const owned: { dispose: () => void }[] = [];
    loadMonaco()
      .then((m) => {
        const el = host.current;
        if (disposed || !el) return;
        const model = m.editor.createModel(lf(info.text), languageFor(m, path));
        model.setEOL(m.editor.EndOfLineSequence.LF);
        const editor: Monaco.editor.IStandaloneCodeEditor = m.editor.create(el, {
          model,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          unusualLineTerminators: 'off',
          contextmenu: false,
          hover: { enabled: 'off' },
          quickSuggestions: false,
          suggestOnTriggerCharacters: false,
          acceptSuggestionOnEnter: 'off',
          wordBasedSuggestions: 'off',
          links: false,
          lineNumbersMinChars: 3,
        });
        owned.push(
          editor,
          model,
          model.onDidChangeContent(() => {
            text.current = model.getValue();
            setValue(text.current);
          }),
        );
      })
      .catch((e: unknown) => !disposed && setError(e instanceof Error ? e.message : 'Could not load the editor.'));
    return () => {
      disposed = true;
      for (const d of owned) d.dispose();
    };
    // One model per opened file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, path]);

  const save = async (): Promise<void> => {
    if (!info || busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.fileEditSave(repoId, { path, text: restoreEols(text.current, [info.text], info.eol), expectHash: info.hash });
      await onSaved(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="file-editor" data-testid="file-editor" data-value={value}>
      <div className="merge-header">
        <span className="merge-title" data-testid="file-editor-title">
          {TEXT.title}
        </span>
        <span className="merge-count" data-testid="file-editor-path">
          {displayPath(path)}
        </span>
        <span className="merge-spacer" />
        {info && <span className="merge-encoding">UTF-8</span>}
        <button className="merge-btn save" data-testid="editor-save" disabled={busy || !dirty} onClick={() => void save()}>
          {TEXT.save}
        </button>
        <button className="merge-btn" data-testid="editor-cancel" onClick={onClose}>
          {TEXT.cancel}
        </button>
        <button className="merge-close" data-testid="editor-close" title={TEXT.cancel} aria-label={TEXT.cancel} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {error && (
        <div className="merge-error" data-testid="editor-error" role="alert">
          {error}
        </div>
      )}
      {binary && (
        <div className="file-editor-binary" data-testid="editor-binary">
          {TEXT.binary}
        </div>
      )}
      {info && (
        <div className="merge-output-host">
          <div className="merge-monaco" ref={host} />
        </div>
      )}
    </div>
  );
}
