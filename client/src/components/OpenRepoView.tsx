import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { RepoInfo } from '@gitslappin/shared';
import { api } from '../api';
import { CloneRepoModal } from './CloneRepoModal';
import { FolderBrowser } from './FolderBrowser';
import { InitRepoModal } from './InitRepoModal';

/** `request`: the menu bar or the palette asks for the Clone or Init window (a new object each time). */
export function OpenRepoView({ onOpened, request }: { onOpened: (repo: RepoInfo) => void; request?: { modal: 'clone' | 'init' } | null }) {
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [modal, setModal] = useState<'clone' | 'init' | null>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<RepoInfo[]>([]);

  useEffect(() => {
    api.recent().then(setRecent).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (request) setModal(request.modal);
  }, [request]);

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
  const closeModal = useCallback(() => setModal(null), []);

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
      <div className="open-actions">
        <button type="button" className="btn" data-testid="open-view-open" onClick={() => pathRef.current?.focus()}>
          Open
        </button>
        <button type="button" className="btn" data-testid="open-view-clone" onClick={() => setModal('clone')}>
          Clone
        </button>
        <button type="button" className="btn" data-testid="open-view-create" onClick={() => setModal('init')}>
          Create
        </button>
      </div>
      <form className="open-form" onSubmit={submit}>
        <input
          ref={pathRef}
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
      {modal === 'clone' && <CloneRepoModal onClose={closeModal} onOpened={onOpened} />}
      {modal === 'init' && <InitRepoModal onClose={closeModal} onOpened={onOpened} />}
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
