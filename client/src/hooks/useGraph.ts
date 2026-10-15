import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyGraphState, layoutGraph, type GraphRow, type GraphState, type LogCommit } from '@gitslappin/shared';
import { api } from '../api';

const PAGE = 500;

interface Store {
  commits: LogCommit[];
  rows: GraphRow[];
  index: Map<string, number>;
  state: GraphState;
  nextSkip: number;
  hasMore: boolean;
  error: string | null;
  inflight: Promise<void> | null;
}

function freshStore(): Store {
  return { commits: [], rows: [], index: new Map(), state: emptyGraphState(), nextSkip: 0, hasMore: true, error: null, inflight: null };
}

export interface GraphData {
  commits: LogCommit[];
  rows: GraphRow[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

const INITIAL: GraphData = { commits: [], rows: [], hasMore: true, loading: true, error: null };

/** Paged commit log with incremental lane layout. */
export function useGraph(repoId: string) {
  const [data, setData] = useState<GraphData>(INITIAL);
  const store = useRef<Store>(freshStore());

  /** Loads the next `limit` commits. A failed load keeps `hasMore` so the caller can retry. */
  const loadMore = useCallback(
    (limit: number = PAGE): Promise<void> => {
      const s = store.current;
      if (s.inflight) return s.inflight;
      if (!s.hasMore) return Promise.resolve();
      s.error = null;
      setData((d) => ({ ...d, loading: true, error: null }));
      const p = api
        .log(repoId, s.nextSkip, limit)
        .then((page) => {
          if (store.current !== s) return;
          const { rows, state } = layoutGraph(
            page.commits.map((c) => ({ sha: c.sha, parents: c.parents, stash: c.stash !== undefined })),
            s.state,
          );
          const base = s.commits.length;
          page.commits.forEach((c, i) => s.index.set(c.sha, base + i));
          s.commits = s.commits.concat(page.commits);
          s.rows = s.rows.concat(rows);
          s.state = state;
          s.nextSkip = page.nextSkip;
          s.hasMore = page.hasMore;
          setData({ commits: s.commits, rows: s.rows, hasMore: s.hasMore, loading: false, error: null });
        })
        .catch((e: unknown) => {
          if (store.current !== s) return;
          s.error = e instanceof Error ? e.message : 'Failed to load commits.';
          setData((d) => ({ ...d, loading: false, error: s.error }));
        })
        .finally(() => {
          if (store.current === s) s.inflight = null;
        });
      s.inflight = p;
      return p;
    },
    [repoId],
  );

  /** Drops everything loaded so far and loads the first page again (also used by refresh). */
  const reload = useCallback((): void => {
    store.current = freshStore();
    setData(INITIAL);
    void loadMore();
  }, [loadMore]);

  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * Live refresh: fetches the first page and swaps it in over the top of the loaded rows, joining at the first sha both
   * lists share (older rows stay). No shared sha: the list restarts from that page. Never shows the loading state.
   */
  const softReload = useCallback(async (): Promise<void> => {
    const s = store.current;
    if (s.inflight) await s.inflight;
    if (store.current !== s || s.inflight) return;
    let page: Awaited<ReturnType<typeof api.log>>;
    try {
      page = await api.log(repoId, 0, PAGE);
    } catch {
      return;
    }
    if (store.current !== s || s.inflight) return;
    const fresh = page.commits;
    let at = -1; // index in fresh of the first sha the loaded list also has
    let old = -1; // that sha's index in the loaded list
    for (let k = 0; k < fresh.length && at < 0; k++) {
      const j = s.index.get(fresh[k]!.sha);
      if (j !== undefined) {
        at = k;
        old = j;
      }
    }
    let commits = fresh;
    let nextSkip = page.nextSkip;
    let hasMore = page.hasMore;
    if (s.commits.length > 0 && at >= 0) {
      // The splice is only trusted when the fresh page matches the loaded rows exactly from the join point on.
      const overlap = Math.min(fresh.length - at, s.commits.length - old);
      let same = true;
      for (let k = 0; k < overlap && same; k++) same = fresh[at + k]!.sha === s.commits[old + k]!.sha;
      if (same && s.commits.length <= PAGE) {
        const tail = s.commits.slice(old + fresh.length - at);
        if (tail.length > 0) {
          commits = fresh.concat(tail);
          nextSkip = s.nextSkip + (commits.length - s.commits.length);
          hasMore = s.hasMore;
        }
      } else if (s.commits.length > fresh.length) {
        // (more than one page loaded always takes this path)
        // The order changed under the loaded rows (older-dated commit inserted): read as many rows as were loaded and swap them all.
        try {
          const big = await api.log(repoId, 0, s.commits.length);
          if (store.current !== s || s.inflight) return;
          commits = big.commits;
          nextSkip = big.nextSkip;
          hasMore = big.hasMore;
        } catch {
          return;
        }
      }
    }
    const { rows, state } = layoutGraph(
      commits.map((c) => ({ sha: c.sha, parents: c.parents, stash: c.stash !== undefined })),
      emptyGraphState(),
    );
    s.commits = commits;
    s.rows = rows;
    s.state = state;
    s.index = new Map(commits.map((c, i) => [c.sha, i]));
    s.nextSkip = nextSkip;
    s.hasMore = hasMore;
    s.error = null;
    setData({ commits, rows, hasMore, loading: false, error: null });
  }, [repoId]);

  /** Retries after a failed load. */
  const retry = useCallback((): void => {
    void loadMore();
  }, [loadMore]);

  /**
   * Loads commits until `sha` is present. Asks the server for the sha's index first and then loads
   * up to it in one request. Resolves to its index, or -1 when it is not in the history (or loading failed).
   */
  const ensureLoaded = useCallback(
    async (sha: string): Promise<number> => {
      const s = store.current;
      const known = s.index.get(sha);
      if (known !== undefined) return known;
      let target: number;
      try {
        target = (await api.locate(repoId, sha)).index;
      } catch {
        return -1;
      }
      if (target < 0 || store.current !== s) return -1;
      for (;;) {
        const i = s.index.get(sha);
        if (i !== undefined) return i;
        if (!s.hasMore || s.error || store.current !== s) return -1;
        await loadMore(Math.max(PAGE, target + 1 - s.commits.length));
      }
    },
    [repoId, loadMore],
  );

  const indexOf = useCallback((sha: string): number => store.current.index.get(sha) ?? -1, []);

  return { ...data, loadMore, reload, softReload, retry, ensureLoaded, indexOf };
}
