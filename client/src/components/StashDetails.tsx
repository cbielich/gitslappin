import { useEffect, useMemo, useState } from 'react';
import type { StashFileEntry, StashInfo } from '@gitslappin/shared';
import { api } from '../api';
import { PathLabel, StatusIcon, type OpenFileHook } from './DetailsPanel';
import { shortSha } from '../lib/identicon';

interface Props {
  repoId: string;
  stash: StashInfo;
  onOpenFile: OpenFileHook;
}

/** Right panel for a stash node: its message and the files it holds (tracked changes, then untracked files as added). */
export function StashDetails({ repoId, stash, onOpenFile }: Props) {
  const [files, setFiles] = useState<StashFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let stale = false;
    setFiles(null);
    setError(null);
    api
      .stashFiles(repoId, stash.sha)
      .then((r) => {
        if (stale) return;
        setFiles(r.files);
        setTruncated(r.truncated === true);
      })
      .catch((e: unknown) => !stale && setError(e instanceof Error ? e.message : 'Failed to load files.'));
    return () => {
      stale = true;
    };
  }, [repoId, stash.sha]);

  const sorted = useMemo(() => (files ?? []).slice().sort((a, b) => a.path.localeCompare(b.path)), [files]);
  const open = (f: StashFileEntry) => onOpenFile({ source: 'stash', sha: stash.sha, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status });

  return (
    <div className="details" data-testid="stash-details" data-sha={stash.sha}>
      <div className="details-sha">
        {stash.ref}: <span className="mono">{shortSha(stash.sha)}</span>
      </div>
      <div className="message-box" data-testid="stash-message">
        {stash.message}
      </div>
      {error && (
        <div className="details-error" data-testid="stash-error">
          {error}
        </div>
      )}
      {!files && !error && <div className="details-loading">Loading...</div>}
      {files && (
        <>
          <div className="file-list" data-testid="stash-file-list">
            {sorted.map((f) => (
              <button
                key={f.path}
                className="file-row"
                data-testid="stash-file-row"
                data-path={f.path}
                data-status={f.status}
                title={f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path}
                style={{ paddingLeft: 8 }}
                onClick={() => open(f)}
              >
                <StatusIcon status={f.status} />
                <PathLabel path={f.path} />
              </button>
            ))}
            {truncated && <div className="details-loading">Showing the first {sorted.length} files.</div>}
          </div>
        </>
      )}
    </div>
  );
}
