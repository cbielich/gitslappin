import { timingSafeEqual } from 'node:crypto';

export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  const o = origin.toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

export function isValidToken(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Deny by default: true when the raw URL, any percent-decoded form of it (decoded up to 5 times), or the matched route is under /api.
 * A path that fails to decode counts as API. find-my-way decodes %XX before matching, so the raw URL alone is not enough.
 */
export function isApiRequest(url: string, routeUrl?: string): boolean {
  if (routeUrl !== undefined && (routeUrl === '/api' || routeUrl.startsWith('/api/'))) return true;
  let p = url.split('?')[0] ?? '';
  for (let i = 0; i < 5; i++) {
    if (isApiPath(p)) return true;
    let d: string;
    try {
      d = decodeURIComponent(p);
    } catch {
      return true;
    }
    if (d === p) return false;
    p = d;
  }
  return true;
}

/** UNC (`\server\share`, `//server/share`) and device (`\?\`, `\.\`) paths are refused. */
export function isUncOrDevicePath(p: string): boolean {
  return /^[\\/]{2}/.test(p.trim());
}
