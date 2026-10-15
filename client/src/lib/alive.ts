import { TOKEN_HEADER } from '@gitslappin/shared';

const STORAGE_KEY = 'gitslappin-token';

/** The token the way api.ts keeps it (sessionStorage); on the very first call it can still be in the URL, which api.ts strips. */
export function currentToken(): string {
  return sessionStorage.getItem(STORAGE_KEY) ?? new URL(window.location.href).searchParams.get('token') ?? '';
}

/**
 * Holds `GET /api/alive` open for as long as this page lives: the server counts it as a window and exits shortly after
 * the last one is gone. The token goes in the header, never the URL. If the stream ends (server restart, network), try again.
 */
export function startAlive(): void {
  void (async () => {
    for (;;) {
      try {
        const res = await fetch('/api/alive', { headers: { [TOKEN_HEADER]: currentToken() } });
        if (res.ok && res.body) {
          const reader = res.body.getReader();
          while (!(await reader.read()).done) {
            // comment lines only; nothing to do with them
          }
        }
      } catch {
        // fall through to the retry
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
}
