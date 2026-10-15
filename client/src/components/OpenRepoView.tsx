import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { RepoInfo } from '@gitslappin/shared';
import { api } from '../api';
import { FolderBrowser } from './FolderBrowser';

export function OpenRepoView({ onOpened }: { onOpened: (repo: RepoInfo) => void }) {
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [recent, setRecent] = useState<RepoInfo[]>([]);

  useEffect(() => {
    api.recent().then(setRecent).catch(() => undefined);
  }, []);

  async function open(p: string) {
    setBusy(true);
    setError('');
    try {
      onOpened(await api.openRepo(p));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const closeBrowser = useCallback(() => setBrowsing(false), []);

  async function openFromBrowser(p: string) {
    const repo = await api.openRepo(p); // a failure is shown inside the browser
    setBrowsing(false);
    onOpened(repo);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void open(path);
  }

  return (
    <div className="open-repo" data-testid="open-repo-view">
      <h2>Open a repository</h2>
      <form className="open-form" onSubmit={submit}>
        <input
          data-testid="open-path-input"
          value={path}
          placeholder="Paste a repository folder path"
          onChange={(e) => setPath(e.target.value)}
          autoFocus
        />
        <button type="button" className="btn" data-testid="browse-button" onClick={() => setBrowsing(true)}>
          Browse
        </button>
        <button type="submit" className="btn btn-success" data-testid="open-button" disabled={busy}>
          Open
        </button>
      </form>
      {browsing && <FolderBrowser start={path} onClose={closeBrowser} onOpen={openFromBrowser} />}
      {error && (
        <div className="open-error" data-testid="open-error" role="alert">
          {error}
        </div>
      )}
      <h3>Recent repositories</h3>
      <ul className="recent-list" data-testid="recent-list">
        {recent.map((r) => (
          <li key={r.id}>
            <button className="recent-item" data-testid="recent-item" onClick={() => void open(r.root)}>
              <span className="recent-name">{r.name}</span>
              <span className="recent-path">{r.root}</span>
            </button>
          </li>
        ))}
        {recent.length === 0 && <li className="recent-empty">No recent repositories.</li>}
      </ul>
    </div>
  );
}
