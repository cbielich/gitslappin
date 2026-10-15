/** Splits a list into pieces of at most `size` items (the server accepts at most 10k paths per request). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const UNSTAGE_CHUNK = 5000;
