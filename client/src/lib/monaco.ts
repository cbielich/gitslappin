import type * as Monaco from 'monaco-editor';

export type MonacoApi = typeof Monaco;

let loading: Promise<MonacoApi> | null = null;

/**
 * Loads Monaco once, as a lazy local chunk (no CDN). Every worker label gets the plain editor worker:
 * the language services (ts, json, css, html) are switched off below, so they never ask for their own.
 */
export function loadMonaco(): Promise<MonacoApi> {
  loading ??= (async () => {
    const [monaco, worker] = await Promise.all([import('monaco-editor'), import('monaco-editor/editor/editor.worker?worker')]);
    const EditorWorker = worker.default;
    Object.assign(self, { MonacoEnvironment: { getWorker: () => new EditorWorker() } });

    const m = monaco as unknown as Record<string, any>;
    const lang = (name: string) => m[name] ?? m.languages?.[name];
    for (const defaults of [lang('typescript')?.typescriptDefaults, lang('typescript')?.javascriptDefaults]) {
      defaults?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
    }
    lang('json')?.jsonDefaults?.setDiagnosticsOptions?.({ validate: false });
    for (const name of ['cssDefaults', 'scssDefaults', 'lessDefaults']) lang('css')?.[name]?.setOptions?.({ validate: false });
    lang('html')?.htmlDefaults?.setOptions?.({ suggest: { html5: false } });

    const light = document.documentElement.dataset.theme === 'light';
    monaco.editor.defineTheme('gitslappin', {
      base: light ? 'vs' : 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': light ? '#ffffff' : '#1c1e23' },
    });
    monaco.editor.setTheme('gitslappin');
    return monaco;
  })();
  // A failed load can be retried by the next caller.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

export function languageFor(monaco: MonacoApi, path: string): string {
  const i = path.lastIndexOf('.');
  const ext = i >= 0 ? path.slice(i).toLowerCase() : '';
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const found = monaco.languages
    .getLanguages()
    .find((l) => (ext && l.extensions?.includes(ext)) || l.filenames?.some((f) => f.toLowerCase() === name));
  return found?.id ?? 'plaintext';
}

const ready = new Map<string, Promise<void>>();

/**
 * Waits until Monaco has loaded the tokenizer for a language. Monaco loads each language lazily, and
 * `editor.tokenize` is synchronous: called too early it silently returns uncoloured tokens.
 * `editor.colorize` awaits the tokenization support first, so a tiny call is used as the wait (its HTML is discarded).
 */
export function ensureTokenizer(monaco: MonacoApi, languageId: string): Promise<void> {
  let p = ready.get(languageId);
  if (!p) {
    p = (async () => {
      if (languageId === 'plaintext') return;
      await monaco.editor.colorize('', languageId, {});
    })().catch(() => undefined);
    ready.set(languageId, p);
  }
  return p;
}
