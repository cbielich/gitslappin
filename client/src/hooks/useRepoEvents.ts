import { useEffect, useRef } from 'react';
import { TOKEN_HEADER } from '@gitslappin/shared';
import { currentToken } from '../lib/alive';

export type RepoEventType = 'status' | 'refs' | 'head' | 'op' | 'off';

const RETRY_MS = 2000;

/**
 * Live auto-refresh: holds the repo's event stream open while the page is visible. Lines are `data: {"type":...}`.
 * When the page becomes visible again, and after a dropped stream comes back, `cb('refs')` runs once (changes may have
 * been missed); a dropped stream is retried every 2 s. The token goes in the header, never the URL.
 */
export function useRepoEvents(repoId: string, cb: (type: RepoEventType) => void): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    let gen = 0;
    let ctrl: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let missed = false;
    let retryMs = RETRY_MS;

    const stop = (): void => {
      gen++;
      clearTimeout(timer);
      ctrl?.abort();
    };

    const open = async (): Promise<void> => {
      if (document.visibilityState !== 'visible') return;
      const mine = ++gen;
      const c = new AbortController();
      ctrl = c;
      try {
        const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/events`, { headers: { [TOKEN_HEADER]: currentToken() }, signal: c.signal });
        if (mine === gen && (res.status === 404 || res.status === 401 || res.status === 403)) return; // will not get better: no retry
        retryMs = res.status === 429 ? 30_000 : RETRY_MS;
        if (res.ok && res.body && mine === gen) {
          if (missed) cbRef.current('refs');
          missed = false;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done || mine !== gen) break;
            buf += decoder.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              for (const line of block.split('\n')) {
                if (!line.startsWith('data:')) continue;
                try {
                  const type = (JSON.parse(line.slice(5).trim()) as { type?: unknown }).type;
                  if (type === 'status' || type === 'refs' || type === 'head' || type === 'op' || type === 'off') cbRef.current(type);
                } catch {
                  // not one of ours
                }
              }
            }
          }
        }
      } catch {
        // fall through to the retry
      }
      if (mine !== gen) return; // closed on purpose
      missed = true;
      timer = setTimeout(() => void open(), retryMs);
    };

    const onVisibility = (): void => {
      stop();
      if (document.visibilityState === 'visible') {
        cbRef.current('refs'); // reload once, then the stream again
        void open();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    void open();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [repoId]);
}
