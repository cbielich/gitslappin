import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { BlameResult, FileHistoryEntry } from '@gitslappin/shared';
import { api } from '../../api';
import { formatAuthored, identiconUri, shortSha } from '../../lib/identicon';
import { PathLabel } from '../DetailsPanel';
import { BlameFileView } from './BlameFileView';
import { DiffView } from './DiffView';

interface Props {
  repoId: string;
  /** The commit the list starts from (the diff's commit, or HEAD for working-copy diffs). */
  sha: string;
  path: string;
  /** Open with blame already on (the Blame button). */
  blame: boolean;
  onClose: () => void;
}

const pad = (n: number) => String(n).padStart(2, '0');
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
}

type TextState = { state: 'loading' } | { state: 'ready'; text: string } | { state: 'error'; message: string };
type BlameState = { key: string; data: BlameResult | null; failed: boolean };

/** File History (screens 29, 30, 30a): the commits that touched one file, with its text (and blame) or its diff for the chosen commit. */
export function FileHistoryView({ repoId, sha, path, blame: blameOpen, onClose }: Props) {
  const [entries, setEntries] = useState<FileHistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [fileMode, setFileMode] = useState(true);
  const [blameOn, setBlameOn] = useState(blameOpen);
  const [text, setText] = useState<TextState>({ state: 'loading' });
  const [blame, setBlame] = useState<BlameState | null>(null);
  const nextSkip = useRef(0);
  const busy = useRef(false);
  const blameCache = useRef(new Map<string, BlameResult>());

  const loadMore = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    api
      .fileHistory(repoId, sha, path, nextSkip.current)
      .then((r) => {
        nextSkip.current = r.nextSkip;
        setEntries((e) => [...e, ...r.entries]);
        setHasMore(r.hasMore);
        setSelected((s) => s ?? r.entries[0]?.sha ?? null);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        setListError((e as { status?: number } | null)?.status === 404 ? 'No history for this file (it was deleted or exists only in the working copy).' : 'Failed to generate file history');
        setHasMore(false);
        setLoaded(true);
      })
      .finally(() => {
        busy.current = false;
      });
  }, [repoId, sha, path]);

  useEffect(() => {
    nextSkip.current = 0;
    setEntries([]);
    setHasMore(true);
    setLoaded(false);
    setListError(null);
    setSelected(null);
    blameCache.current.clear();
    loadMore();
  }, [loadMore]);

  const entry = entries.find((e) => e.sha === selected) ?? null;
  const entryKey = entry ? `${entry.sha}|${entry.path}` : '';
  const deleted = entry?.status === 'D'; // no blob at a deleted entry

  // The file's text at the chosen commit (File View).
  useEffect(() => {
    if (!entry || !fileMode || deleted) return;
    let stale = false;
    setText({ state: 'loading' });
    api
      .diffContents(repoId, { source: 'commit', sha: entry.sha, path: entry.path, status: entry.status })
      .then((c) => !stale && setText({ state: 'ready', text: c.new }))
      .catch((e: unknown) => !stale && setText({ state: 'error', message: e instanceof Error ? e.message : 'Failed to load the file.' }));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, entryKey, fileMode]);

  // Blame for the same version: fetched once per version and reused when blame is switched on and off.
  useEffect(() => {
    if (!entry || !fileMode || deleted) return;
    const hit = blameCache.current.get(entryKey);
    if (hit) {
      setBlame({ key: entryKey, data: hit, failed: false });
      return;
    }
    let stale = false;
    setBlame({ key: entryKey, data: null, failed: false });
    api
      .blame(repoId, entry.sha, entry.path)
      .then((b) => {
        blameCache.current.set(entryKey, b);
        if (!stale) setBlame({ key: entryKey, data: b, failed: false });
      })
      .catch(() => !stale && setBlame({ key: entryKey, data: null, failed: true }));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, entryKey, fileMode]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (hasMore && !busy.current && el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadMore();
  };

  const last = entries[entries.length - 1];
  const blameData = blame && blame.key === entryKey ? blame : null;

  return (
    <div className="file-history" data-testid="file-history-view">
      <div className="file-history-head">
        <span className="file-history-title" data-testid="file-history-title">
          File History: {path}
        </span>
        <span className="diff-spacer" />
        <span className="diff-encoding" data-testid="file-history-encoding">
          UTF-8
        </span>
        <button className="icon-btn" data-testid="file-history-close" title="Close" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="file-history-body">
        <div className="file-history-list" onScroll={onScroll}>
          {entries.map((e) => (
            <button
              key={e.sha}
              className={`file-history-entry${e.sha === selected ? ' selected' : ''}`}
              data-testid="file-history-entry"
              data-sha={e.sha}
              data-status={e.status}
              aria-selected={e.sha === selected}
              onClick={() => setSelected(e.sha)}
            >
              <img className="author-avatar" src={identiconUri(e.authorEmail)} alt="" width={28} height={28} />
              <span className="file-history-entry-text">
                <span className="file-history-summary">{e.summary}</span>
                <span className="file-history-meta">
                  {shortDate(e.authorDate)} by {e.authorName}
                </span>
              </span>
              <span className="mono file-history-sha">{shortSha(e.sha)}</span>
            </button>
          ))}
          {!hasMore && last?.status === 'A' && (
            <div className="file-history-added" data-testid="file-history-added">
              <span className="file-history-added-label">ADDED</span>
              <PathLabel path={last.path} />
            </div>
          )}
          {listError && <div className="details-error">{listError}</div>}
          {loaded && !hasMore && !listError && (
            <div className="file-history-end" data-testid="file-history-end">
              End of History
            </div>
          )}
          {!loaded && <div className="details-loading">Loading...</div>}
        </div>
        <div className="file-history-main">
          <div className="diff-toolbar file-history-toolbar">
            <div className="diff-toolbar-left" />
            <div className="diff-toolbar-center">
              <div className="seg">
                <button className={fileMode ? 'on' : ''} data-testid="file-history-mode-file" aria-pressed={fileMode} onClick={() => setFileMode(true)}>
                  File View
                </button>
                <button className={fileMode ? '' : 'on'} data-testid="file-history-mode-diff" aria-pressed={!fileMode} onClick={() => setFileMode(false)}>
                  Diff View
                </button>
              </div>
            </div>
            <div className="diff-toolbar-right">
              {fileMode && !deleted && (
                <button
                  className={`diff-tool diff-tool-text file-history-blame${blameOn ? ' on' : ''}`}
                  data-testid="file-history-blame-toggle"
                  title="Show blame details"
                  aria-pressed={blameOn}
                  onClick={() => setBlameOn((v) => !v)}
                >
                  Blame
                </button>
              )}
            </div>
          </div>
          {entry && !fileMode && (
            <DiffView
              key={entryKey}
              embedded
              repoId={repoId}
              target={{ source: 'commit', sha: entry.sha, path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), status: entry.status }}
              onClose={onClose}
            />
          )}
          {entry && fileMode && (
            <div className="file-history-file-view" data-testid="file-history-file-view">
              {deleted && (
                <div className="diff-message" data-testid="file-history-deleted">
                  File deleted in this commit.
                </div>
              )}
              {!deleted && blameData?.failed && <div className="diff-message error">Failed to resolve blame</div>}
              {!deleted && text.state === 'loading' && <div className="diff-message">Loading...</div>}
              {!deleted && text.state === 'error' && <div className="diff-message error">{text.message}</div>}
              {!deleted && text.state === 'ready' && <BlameFileView text={text.text} path={entry.path} blame={blameData?.data ?? null} blameOn={blameOn} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
