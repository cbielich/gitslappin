import { expect, test, type APIRequestContext } from '@playwright/test';
import { createGraphRepo } from './helpers/graphFixtures';
import { TEST_TOKEN } from './helpers/repo';

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

interface Page {
  commits: { sha: string; subject: string }[];
  nextSkip: number;
  hasMore: boolean;
  total: number;
}

async function openRepo(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.post('/api/repos/open', { headers, data: { path } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

test.describe('graph API', () => {
  let id: string;
  test.beforeAll(async ({ request }) => {
    id = await openRepo(request, createGraphRepo());
  });

  test('API responses are not cacheable and carry the security headers', async ({ request }) => {
    const res = await request.get(`/api/repos/${id}/refs`, { headers });
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    const page = await request.get('/');
    expect(page.headers()['referrer-policy']).toBe('no-referrer');
    expect(page.headers()['x-content-type-options']).toBe('nosniff');
    expect(page.headers()['cache-control'] ?? '').not.toBe('no-store');
  });

  test('/log slices the cached history and reports the total', async ({ request }) => {
    const all = (await (await request.get(`/api/repos/${id}/log?limit=1000`, { headers })).json()) as Page;
    expect(all.total).toBe(8);
    expect(all.commits).toHaveLength(8);
    expect(all.hasMore).toBe(false);
    const first = (await (await request.get(`/api/repos/${id}/log?skip=0&limit=3`, { headers })).json()) as Page;
    expect(first.commits.map((c) => c.sha)).toEqual(all.commits.slice(0, 3).map((c) => c.sha));
    expect(first.hasMore).toBe(true);
    expect(first.nextSkip).toBe(3);
    const rest = (await (await request.get(`/api/repos/${id}/log?skip=${first.nextSkip}&limit=1000`, { headers })).json()) as Page;
    expect(rest.commits.map((c) => c.sha)).toEqual(all.commits.slice(3).map((c) => c.sha));
    expect(rest.hasMore).toBe(false);
  });

  test('/locate returns the index of a commit, -1 for unknown ones, 400 for bad input', async ({ request }) => {
    const all = (await (await request.get(`/api/repos/${id}/log?limit=1000`, { headers })).json()) as Page;
    for (const i of [0, 4, 7]) {
      const res = await request.get(`/api/repos/${id}/locate/${all.commits[i]!.sha}`, { headers });
      expect(await res.json()).toEqual({ index: i });
    }
    const unknown = await request.get(`/api/repos/${id}/locate/${'a'.repeat(40)}`, { headers });
    expect(await unknown.json()).toEqual({ index: -1 });
    expect((await request.get(`/api/repos/${id}/locate/--help`, { headers })).status()).toBe(400);
  });

  test('/search returns matches with their graph index', async ({ request }) => {
    const all = (await (await request.get(`/api/repos/${id}/log?limit=1000`, { headers })).json()) as Page;
    const res = await request.get(`/api/repos/${id}/search?q=login`, { headers });
    const body = (await res.json()) as { shas: string[]; indexes: number[] };
    expect(body.shas).toHaveLength(3);
    expect(body.indexes).toHaveLength(3);
    body.shas.forEach((sha, k) => expect(all.commits[body.indexes[k]!]!.sha).toBe(sha));
    expect([...body.indexes].sort((a, b) => a - b)).toEqual(body.indexes);
  });

  test('/commit needs 7+ hex characters and a real commit', async ({ request }) => {
    const all = (await (await request.get(`/api/repos/${id}/log?limit=1000`, { headers })).json()) as Page;
    const sha = all.commits.find((c) => c.subject === 'Add login form')!.sha;
    expect((await request.get(`/api/repos/${id}/commit/${sha.slice(0, 6)}`, { headers })).status()).toBe(400);
    expect((await request.get(`/api/repos/${id}/commit/HEAD`, { headers })).status()).toBe(400);
    expect((await request.get(`/api/repos/${id}/commit/${'b'.repeat(40)}`, { headers })).status()).toBe(404);
    const ok = await request.get(`/api/repos/${id}/commit/${sha.slice(0, 7)}`, { headers });
    expect(ok.status()).toBe(200);
    const detail = (await ok.json()) as { sha: string; files: { path: string }[]; truncated?: boolean };
    expect(detail.sha).toBe(sha);
    expect(detail.files.map((f) => f.path)).toEqual(['src/login.js']);
    expect(detail.truncated).toBeUndefined();
  });

  test('/commit/:sha/tree lists every file in the commit', async ({ request }) => {
    const all = (await (await request.get(`/api/repos/${id}/log?limit=1000`, { headers })).json()) as Page;
    const sha = all.commits.find((c) => c.subject === 'Add login form')!.sha;
    const res = await request.get(`/api/repos/${id}/commit/${sha}/tree`, { headers });
    const body = (await res.json()) as { files: string[]; truncated: boolean };
    expect(body.files).toEqual(expect.arrayContaining(['README.md', 'src/app.js', 'src/header.js', 'src/login.js']));
    expect(body.truncated).toBe(false);
    expect((await request.get(`/api/repos/${id}/commit/abc/tree`, { headers })).status()).toBe(400);
  });

  test('/refs groups remotes by their configured name and lists only commit tags', async ({ request }) => {
    const res = await request.get(`/api/repos/${id}/refs`, { headers });
    const refs = (await res.json()) as { remotes: { name: string; branches: { name: string }[] }[]; tags: { name: string }[] };
    expect(refs.remotes.map((r) => [r.name, r.branches.map((b) => b.name)])).toEqual([['origin', ['origin/main']]]);
    expect(refs.tags.map((t) => t.name)).toEqual(['v1.0']);
  });

  test('UNC and device paths are refused when opening', async ({ request }) => {
    for (const path of ['\\\\server\\share\\repo', '\\\\?\\C:\\repo', '\\\\.\\C:\\repo']) {
      const res = await request.post('/api/repos/open', { headers, data: { path } });
      expect(res.status()).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('UNC and device paths');
    }
  });
});
