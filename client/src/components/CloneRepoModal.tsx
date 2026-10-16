import { useCallback, useRef, useState } from 'react';
import { repoNameFromUrl, type CloneRequest, type CloneStreamLine, type RepoInfo } from '@gitslappin/shared';
import { api, ApiRequestError } from '../api';
import { FolderBrowser } from './FolderBrowser';
import { RepoModalFrame, RmRow } from './RepoModalFrame';

/** The date checks of the Shallow Clone form: ShallowCloneForm-SinceDateInvalid / -SinceDateInFuture. */
function sinceProblem(s: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const ok = !!m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === s;
  if (!ok) return "Enter a valid date in 'YYYY-MM-DD' format";
  return s > new Date().toISOString().slice(0, 10) ? 'Date cannot be in the future' : null;
}

/** Folder + name the way the "Full path" row shows them. */
export const joinForDisplay = (parent: string, name: string): string => `${parent}${parent.endsWith('\\') || parent.endsWith('/') ? '' : parent.includes('\\') ? '\\' : '/'}${name}`;

export function CloneRepoModal({ onClose, onOpened }: { onClose: () => void; onOpened: (repo: RepoInfo) => void }) {
  const [parent, setParent] = useState('');
  const [url, setUrl] = useState('');
  const [shallow, setShallow] = useState(false);
  const [branch, setBranch] = useState('');
  const [limit, setLimit] = useState<'depth' | 'since'>('depth');
  const [depth, setDepth] = useState('50'); // GitKraken pre-fills 50 (screen 21a)
  const [since, setSince] = useState('');
  const [flags, setFlags] = useState('');
  const [sparse, setSparse] = useState(false);
  const [blobless, setBlobless] = useState(false);
  const [paths, setPaths] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<{ text: string; detail: string } | null>(null);
  const [note, setNote] = useState('');
  const abort = useRef<AbortController | null>(null);

  const name = repoNameFromUrl(url);
  const fullPath = joinForDisplay(parent, name);
  const sinceError = shallow && limit === 'since' && since !== '' ? sinceProblem(since) : null;

  // Closing while a clone runs is a cancel: the fetch is aborted and the server stops git.
  const close = useCallback(() => {
    abort.current?.abort();
    onClose();
  }, [onClose]);
  const closeBrowser = useCallback(() => setBrowsing(false), []);
  const picked = async (p: string) => {
    setParent(p);
    setBrowsing(false);
  };

  async function submit() {
    const body: CloneRequest = { parent, url };
    if (shallow) {
      body.shallow = {
        by: limit,
        ...(limit === 'depth' ? (depth.trim() === '' ? {} : { depth: Number(depth) }) : { since }),
        ...(branch.trim() !== '' ? { branch: branch.trim() } : {}),
        ...(flags.trim() !== '' ? { flags } : {}),
      };
    }
    if (sparse) body.sparse = { paths: paths.split('\n').map((l) => l.trim()).filter((l) => l !== ''), blobless };
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true);
    setError(null);
    setNote('');
    setPercent(null);
    let last: CloneStreamLine | null = null;
    try {
      await api.cloneRepo(
        body,
        (line) => {
          if (line.type === 'progress') setPercent(line.percent);
          else last = line;
        },
        ac.signal,
      );
      const result = last as CloneStreamLine | null;
      if (result?.type === 'done') return onOpened(result.repo);
      if (result?.type === 'error') setError({ text: result.error, detail: result.stderr });
      else if (result?.type === 'cancelled') setNote(`Clone cancelled. Files already downloaded were left in ${result.path}.`);
      else setError({ text: 'The clone ended without a result.', detail: '' });
    } catch (e) {
      if (ac.signal.aborted) setNote(`Clone cancelled. Files already downloaded were left in ${fullPath}.`);
      else setError({ text: e instanceof Error ? e.message : String(e), detail: e instanceof ApiRequestError ? (e.detail ?? '') : '' });
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <RepoModalFrame prefix="clone" title="Clone a Repository" navLabel="Clone with URL" heading="Clone a Repo" onClose={close}>
        <RmRow label="Where to clone to">
          <div className="rm-inline">
            <input className="rm-input" data-testid="clone-parent-input" value={parent} disabled={running} onChange={(e) => setParent(e.target.value)} autoFocus />
            <button type="button" className="rm-btn rm-btn-blue" data-testid="clone-browse" disabled={running} onClick={() => setBrowsing(true)}>
              Browse
            </button>
          </div>
        </RmRow>
        <RmRow label="URL">
          <input className="rm-input" data-testid="clone-url-input" value={url} disabled={running} onChange={(e) => setUrl(e.target.value)} />
        </RmRow>
        {url.trim() !== '' && (
          <RmRow label="Full path" testId="clone-fullpath">
            <span className="rm-fullpath">{fullPath}</span>
          </RmRow>
        )}
        <RmRow label="Shallow Clone">
          <input type="checkbox" data-testid="clone-shallow-toggle" checked={shallow} disabled={running} onChange={(e) => setShallow(e.target.checked)} />
        </RmRow>
        {shallow && (
          <div className="rm-section">
            <RmRow label="Branch to clone">
              <input className="rm-input" data-testid="clone-branch-input" placeholder="default branch" value={branch} disabled={running} onChange={(e) => setBranch(e.target.value)} />
              <div className="rm-help">The default branch is usually main or master, but you can specify a different one.</div>
            </RmRow>
            <RmRow label="Limit history by">
              <label className="rm-radio">
                <input type="radio" name="clone-limit" data-testid="clone-limit-depth" checked={limit === 'depth'} disabled={running} onChange={() => setLimit('depth')} />
                Commit depth
              </label>
              <label className="rm-radio">
                <input type="radio" name="clone-limit" data-testid="clone-limit-since" checked={limit === 'since'} disabled={running} onChange={() => setLimit('since')} />
                Since date
              </label>
            </RmRow>
            {limit === 'depth' ? (
              <RmRow label="Depth">
                <input className="rm-input" data-testid="clone-depth-input" inputMode="numeric" value={depth} disabled={running} onChange={(e) => setDepth(e.target.value)} />
                <div className="rm-help">How many commits to clone from the target branch.</div>
              </RmRow>
            ) : (
              <RmRow label="Since date">
                <input className="rm-input" data-testid="clone-since-input" placeholder="YYYY-MM-DD" value={since} disabled={running} onChange={(e) => setSince(e.target.value)} />
                {sinceError && <div className="rm-field-error">{sinceError}</div>}
                <div className="rm-help">Commits older than this date will not be cloned.</div>
              </RmRow>
            )}
            <RmRow label="Custom flags">
              <input className="rm-input" data-testid="clone-flags-input" value={flags} disabled={running} onChange={(e) => setFlags(e.target.value)} />
              <div className="rm-help">Here you can pass any additional flags you may need to git clone. Enter them exactly as you would on the command line.</div>
            </RmRow>
          </div>
        )}
        <RmRow label="Sparse Checkout">
          <input type="checkbox" data-testid="clone-sparse-toggle" checked={sparse} disabled={running} onChange={(e) => setSparse(e.target.checked)} />
        </RmRow>
        {sparse && (
          <div className="rm-section">
            <RmRow label="Blobless clone">
              <input type="checkbox" data-testid="clone-blobless-toggle" checked={blobless} disabled={running} onChange={(e) => setBlobless(e.target.checked)} />
              <div className="rm-help">Fetches trees and commits without blobs initially, reducing clone size. Blobs are fetched on-demand when needed.</div>
            </RmRow>
            <RmRow label="Paths to include">
              <textarea className="rm-input rm-textarea" data-testid="clone-sparse-paths" placeholder={'e.g.\nsrc/\ndocs/\nREADME.md'} value={paths} disabled={running} onChange={(e) => setPaths(e.target.value)} />
              <div className="rm-help">Enter one path per line. Only these paths will be checked out in your working directory. If no paths are provided, only root files will be checked out.</div>
            </RmRow>
          </div>
        )}
        {error && (
          <div className="rm-error" data-testid="clone-error" role="alert">
            <strong>Clone Failed</strong>
            <div className="rm-error-detail" data-testid="clone-error-detail">
              {error.text}
              {error.detail && error.detail !== error.text ? `\n${error.detail}` : ''}
            </div>
          </div>
        )}
        {note && (
          <div className="rm-note" data-testid="clone-note">
            {note}
          </div>
        )}
        <div className="rm-actions">
          {running ? (
            <div className="rm-progress" data-testid="clone-progress">
              <span>{`Cloning into ${fullPath}`}</span>
              <span>{`Cloning... ${percent ?? 0}%`}</span>
              <button type="button" className="rm-btn" data-testid="clone-cancel" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="rm-btn rm-btn-green" data-testid="clone-submit" onClick={() => void submit()}>
              Clone the repo!
            </button>
          )}
        </div>
      </RepoModalFrame>
      {browsing && <FolderBrowser mode="pick" start={parent} onClose={closeBrowser} onOpen={picked} />}
    </>
  );
}
