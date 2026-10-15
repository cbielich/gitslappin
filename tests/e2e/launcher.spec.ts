import { expect, test, type APIRequestContext } from '@playwright/test';
import { gotoOpenView } from './helpers/app';
import { TEST_TOKEN, createRepo } from './helpers/repo';

/*
 * Phase 12 (Launcher), browser-reachable parts. Routes the builder must add (all under the existing token hook, header X-GitSlappin-Token):
 *  GET /api/ping  -> 200 {app:'gitslappin', pid:<integer>}
 *  GET /api/alive -> 200, a streamed response that stays open (comment line every 15 s); the client opens it with fetch + the token HEADER
 *  GET /api/repos/:id/command-log?after=<seq> -> 200 {entries:[{seq,at,args,code,durationMs}]} (seq integers, increasing; args scrubbed and capped)
 *       after: non-negative integer, otherwise 400; unknown / not-open repo id -> 404
 * Missing or wrong token: the existing hook answers 403 (security.spec.ts); the design allows 401 or 403, so both are accepted here.
 * The client opens /api/alive on boot even when GITSLAPPIN_NO_OPEN=1 (the server just never auto-exits then).
 * Not covered here: the 1,000-entry cap (needs 1,000+ git calls; unit-level), single-instance lock, shortcut script (vitest).
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };
const AUTH_FAIL = [401, 403];

async function openRepoApi(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.post('/api/repos/open', { headers, data: { path } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}
interface Entry {
  seq: number;
  at: number;
  args: string[];
  code: number;
  durationMs: number;
}
async function readLog(request: APIRequestContext, id: string, after = 0): Promise<Entry[]> {
  const res = await request.get(`/api/repos/${id}/command-log?after=${after}`, { headers });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { entries: Entry[] }).entries;
}

test.describe('/api/ping', () => {
  test('with the token: 200 {app:"gitslappin", pid}', async ({ request }) => {
    const res = await request.get('/api/ping', { headers });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { app: string; pid: number };
    expect(body.app).toBe('gitslappin');
    expect(Number.isInteger(body.pid)).toBe(true);
    expect(body.pid).toBeGreaterThan(0);
  });
  test('without a token or with a wrong one: refused', async ({ request }) => {
    expect(AUTH_FAIL).toContain((await request.get('/api/ping')).status());
    expect(AUTH_FAIL).toContain((await request.get('/api/ping', { headers: { 'X-GitSlappin-Token': 'nope' } })).status());
  });
  test('the token in the query string is not accepted', async ({ request }) => {
    expect(AUTH_FAIL).toContain((await request.get(`/api/ping?token=${TEST_TOKEN}`)).status());
  });
});

test.describe('/api/alive', () => {
  test('without a token (header absent, or token only in the query string): refused', async ({ request }) => {
    expect(AUTH_FAIL).toContain((await request.get('/api/alive')).status());
    expect(AUTH_FAIL).toContain((await request.get(`/api/alive?token=${TEST_TOKEN}`)).status());
    expect(AUTH_FAIL).toContain((await request.get('/api/alive', { headers: { 'X-GitSlappin-Token': 'nope' } })).status());
  });

  test('with the header: 200 and the stream stays open', async ({ page }) => {
    await page.goto('/'); // same origin for fetch; static files need no token
    const out = await page.evaluate(async (token) => {
      const ctl = new AbortController();
      const res = await fetch('/api/alive', { headers: { 'X-GitSlappin-Token': token }, signal: ctl.signal });
      const status = res.status;
      const stillOpen = await Promise.race([res.text().then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 1500))]);
      ctl.abort();
      return { status, stillOpen };
    }, TEST_TOKEN);
    expect(out.status).toBe(200);
    expect(out.stillOpen).toBe(true);
  });

  test('the client holds /api/alive open using the token header, never the query string', async ({ page }) => {
    const seen: { url: string; token: string | undefined }[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/alive') seen.push({ url: r.url(), token: r.headers()['x-gitslappin-token'] });
    });
    await gotoOpenView(page);
    await expect.poll(() => seen.length, { timeout: 10_000 }).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.url).not.toContain('token');
      expect(s.token).toBe(TEST_TOKEN);
    }
  });
});

test.describe('/api/repos/:id/command-log', () => {
  test('without a token: refused (the repo is open, so this is the token check and not a 404)', async ({ request }) => {
    const id = await openRepoApi(request, createRepo('gitslappin-test-clog-auth'));
    expect(AUTH_FAIL).toContain((await request.get(`/api/repos/${id}/command-log?after=0`)).status());
    expect(AUTH_FAIL).toContain((await request.get(`/api/repos/${id}/command-log?after=0`, { headers: { 'X-GitSlappin-Token': 'nope' } })).status());
  });

  test('only open repos resolve: an unknown id is 404', async ({ request }) => {
    const res = await request.get('/api/repos/0000000000000000/command-log?after=0', { headers });
    expect(res.status()).toBe(404);
  });

  test('after must be a non-negative integer', async ({ request }) => {
    const id = await openRepoApi(request, createRepo('gitslappin-test-clog-after'));
    for (const bad of ['-1', '1.5', 'abc', '', '1e3', '0x10', '9'.repeat(40), '1;2']) {
      const res = await request.get(`/api/repos/${id}/command-log?after=${encodeURIComponent(bad)}`, { headers });
      expect(res.status(), `after=${bad}`).toBe(400);
    }
    expect((await request.get(`/api/repos/${id}/command-log?after=0`, { headers })).status()).toBe(200);
  });

  test('entries carry increasing integer seq; after=<seq> returns only newer ones', async ({ request }) => {
    const id = await openRepoApi(request, createRepo('gitslappin-test-clog-seq'));
    for (let i = 0; i < 3; i++) await request.get(`/api/repos/${id}/log`, { headers }); // each runs git and so logs commands
    const all = await readLog(request, id);
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const e of all) {
      expect(Number.isInteger(e.seq)).toBe(true);
      expect(Array.isArray(e.args)).toBe(true);
      expect(typeof e.code).toBe('number');
      expect(typeof e.durationMs).toBe('number');
    }
    const seqs = all.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    const first = seqs[0]!;
    const last = seqs[seqs.length - 1]!;
    expect((await readLog(request, id, first)).every((e) => e.seq > first)).toBe(true);
    expect((await readLog(request, id, first)).length).toBe(all.length - 1);
    expect(await readLog(request, id, last)).toEqual([]);
  });

  test('a repo only sees its own log', async ({ request }) => {
    const a = await openRepoApi(request, createRepo('gitslappin-test-clog-a'));
    const b = await openRepoApi(request, createRepo('gitslappin-test-clog-b'));
    const q = 'gitslappin-test-marker-for-a';
    await request.get(`/api/repos/${a}/search?q=${q}`, { headers });
    expect((await readLog(request, a)).some((e) => e.args.some((x) => x.includes(q)))).toBe(true);
    expect((await readLog(request, b)).some((e) => e.args.some((x) => x.includes(q)))).toBe(false);
  });

  test('served args are scrubbed (URL credentials, Authorization, the GitSlappin token) and capped at 500 characters', async ({ request }) => {
    const id = await openRepoApi(request, createRepo('gitslappin-test-clog-scrub'));
    // GET /search puts the query on the git command line as --grep=<q>, so it reaches the log.
    const probes = ['https://someuser:hunter2pw@example.invalid/x.git', 'Authorization: Bearer sekrit123tok', `tokenvalue-${TEST_TOKEN}-end`, 'z'.repeat(1200)];
    for (const q of probes) await request.get(`/api/repos/${id}/search?q=${encodeURIComponent(q)}`, { headers });
    const entries = await readLog(request, id);
    const grepRows = entries.filter((e) => e.args.some((a) => a.startsWith('--grep=')));
    expect(grepRows.length).toBeGreaterThanOrEqual(probes.length - 1); // the code path ran for every probe the search route accepts (it refuses q over 200 characters, so the 1200-character probe never reaches git)
    const text = JSON.stringify(entries);
    expect(text).not.toContain('hunter2pw');
    expect(text).not.toContain('sekrit123tok');
    expect(text).not.toContain(TEST_TOKEN);
    for (const e of entries) for (const a of e.args) expect(a.length, a.slice(0, 40)).toBeLessThanOrEqual(500);
  });
});

test.describe('token handling in the browser', () => {
  test('the token is moved to sessionStorage and stripped from the URL after boot', async ({ page }) => {
    await page.request.put('/api/tabs', { headers, data: { tabs: [], activeId: null } });
    await page.goto(`/?token=${TEST_TOKEN}`);
    await expect(page.getByTestId('tabsbar')).toBeVisible();
    await expect.poll(() => new URL(page.url()).search).toBe('');
    expect(page.url()).not.toContain(TEST_TOKEN);
    expect(await page.evaluate(() => sessionStorage.getItem('gitslappin-token'))).toBe(TEST_TOKEN);
    const local = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(local).not.toContain(TEST_TOKEN);
  });

  test('a reload keeps working from sessionStorage with a clean URL', async ({ page }) => {
    await page.goto(`/?token=${TEST_TOKEN}`);
    await expect(page.getByTestId('tabsbar')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('tabsbar')).toBeVisible();
    expect(page.url()).not.toContain('token');
  });

  test('theme-boot.js is an external script and the CSP has no unsafe-inline for scripts', async ({ request, page }) => {
    const boot = await request.get('/theme-boot.js');
    expect(boot.status()).toBe(200);
    expect(boot.headers()['content-type'] ?? '').toMatch(/javascript/);
    const html = await request.get('/');
    const csp = html.headers()['content-security-policy'] ?? '';
    const scriptSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src')) ?? '';
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(await html.text()).toMatch(/<script[^>]+src="\/?theme-boot\.js"/);
    const violations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    await page.goto(`/?token=${TEST_TOKEN}`);
    await expect(page.getByTestId('tabsbar')).toBeVisible();
    expect(violations).toEqual([]);
  });
});
