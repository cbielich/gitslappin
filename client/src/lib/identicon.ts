import { identicon } from '@gitslappin/shared';

const MAX_CACHE = 2000;
/** LRU: a Map keeps insertion order, so the first key is the least recently used. */
const cache = new Map<string, string>();

/** Local 8-bit identicon as an SVG data URI. Never contacts Gravatar. */
export function identiconUri(email: string): string {
  const key = email.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const { cells, hue } = identicon(key);
  let rects = '';
  cells.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }),
  );
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges">` +
    `<rect width="5" height="5" fill="hsl(${hue},45%,22%)"/>` +
    `<g fill="hsl(${hue},75%,62%)">${rects}</g></svg>`;
  const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  cache.set(key, uri);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return uri;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** MM/DD/YYYY @ h:mm AM (viewer's local time) */
export function formatAuthored(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} @ ${h12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

/** For tests. */
export function identiconCacheSize(): number {
  return cache.size;
}
