import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { TEST_TOKEN } from './helpers/repo';
import { STAGING_FILES, commitCount, createHookRepo, createStagingRepo, headMessage } from './helpers/stagingFixtures';

/*
 * Phase 13 (Polish). Test ids the builder must add (existing ones reused: gear, tabsbar, repo-tab, repo-view, open-repo-view, statusbar, graph-search,
 * graph-search-input, sidebar-filter, commit-summary, commit-description, commit-button, commit-row, context-menu, toast, toast-title, tool-undo,
 * wip-row, wip-details, wip-unstaged, wip-file-row[data-path], wip-file-list[data-mode=path|tree], view-inline, diff-view, diff-monaco):
 *  + activity-log-button          status-bar button, title "Activity Logs"; aria-expanded true/false; click toggles the panel
 *  + activity-log-panel           bottom panel, rendered only while open; has the title text "Activity Logs" in activity-log-title
 *  + activity-log-title
 *  + activity-log-row             one per entry; attributes data-seq, data-code (exit code)
 *  + activity-log-time, activity-log-args (text "git <args joined by spaces>"), activity-log-code (text = exit code; red when non-zero), activity-log-duration (text like "12 ms")
 *  + activity-log-error           shown when loading fails: "An error occurred while trying to load this log."
 *  + statusbar-zoom               text "🔍 110%" (zoom x 100, rounded)
 *  + statusbar-version            text contains the version from the root package.json
 *  + statusbar-view-list, statusbar-view-tree     buttons titled "List" and "Tree"; aria-pressed; they drive wip-file-list data-mode (list = path, tree = tree)
 *  + preferences-view             the Preferences screen opened by the gear (testid gear); closed by Escape or preferences-close
 *  + preferences-close
 *  + preferences-title            text "Preferences"
 *  + preferences-section-ui       heading text "UI Customization"
 *  + preferences-theme-label      text "Theme"
 *  + pref-theme-dark, pref-theme-light    radio inputs labelled "Dark" and "Light" (`checked`)
 * Exports / contracts:
 *  - localStorage key 'gitslappin-theme' holds exactly 'dark' or 'light'; client/public/theme-boot.js reads it and ignores anything else. <html data-theme> carries the theme.
 *  - GET/PUT /api/prefs now return/accept {pullMode, theme, zoom} (PUT merges). NOTE: the phase 7 spec tests/e2e/remotes.spec.ts expects GET to equal exactly {pullMode} and Object.keys == ['pullMode']; those lines need updating (not done here).
 *  - Zoom: CSS zoom on <html> (getComputedStyle(documentElement).zoom === String(zoom)); keys Control+= / Control+- / Control+0; 0.8..1.5 step 0.1; saved through PUT /api/prefs {zoom}.
 *  - Activity log polls GET /api/repos/:id/command-log?after=<seq> every 2 s only while the panel is open.
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

async function resetPrefs(request: APIRequestContext): Promise<void> {
  const res = await request.put('/api/prefs', { headers, data: { theme: 'dark', zoom: 1 } });
  expect(res.status()).toBe(200);
}
async function getPrefs(request: APIRequestContext): Promise<Record<string, unknown>> {
  const res = await request.get('/api/prefs', { headers });
  expect(res.status()).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}
async function openGraph(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}
const theme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const zoomOf = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).zoom);
async function bgLuminance(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)!.map(Number);
    return (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255;
  });
}

test.beforeEach(async ({ request }) => {
  await resetPrefs(request); // GitSlappin's own prefs in the throwaway test data dir
});

test.describe('command log panel', () => {
  test('rows appear after a commit: time, git args, exit code 0, duration; the button toggles the panel', async ({ page }) => {
    const repo = createStagingRepo();
    await openGraph(page, repo);
    await expect(page.getByTestId('activity-log-panel')).toHaveCount(0);
    await expect(page.getByTestId('activity-log-button')).toHaveAttribute('title', 'Activity Logs'); // ActivityLogButtonTooltip
    await page.getByTestId('wip-row').click();
    await page.getByTestId('commit-summary').fill('Log me');
    await page.getByTestId('commit-button').click();
    await expect.poll(() => commitCount(repo)).toBe(3);

    await page.getByTestId('activity-log-button').click();
    await expect(page.getByTestId('activity-log-panel')).toBeVisible();
    await expect(page.getByTestId('activity-log-title')).toHaveText('Activity Logs'); // View-ActivityLog
    const commitRow = page.getByTestId('activity-log-row').filter({ has: page.getByTestId('activity-log-args').filter({ hasText: /^git .*\bcommit\b/ }) });
    await expect(commitRow.first()).toBeVisible({ timeout: 8_000 });
    await expect(commitRow.first()).toHaveAttribute('data-code', '0');
    await expect(commitRow.first().getByTestId('activity-log-code')).toHaveText('0');
    await expect(commitRow.first().getByTestId('activity-log-duration')).toHaveText(/^\d+\s?ms$/);
    await expect(commitRow.first().getByTestId('activity-log-time')).not.toHaveText('');

    await page.getByTestId('activity-log-button').click();
    await expect(page.getByTestId('activity-log-panel')).toHaveCount(0);
  });

  test('a failed command shows its non-zero exit code, in red', async ({ page }) => {
    const repo = createHookRepo('fail'); // pre-commit hook exits 1
    await openGraph(page, repo);
    await page.getByTestId('wip-row').click();
    await page.getByTestId('commit-summary').fill('Will be refused');
    await page.getByTestId('commit-button').click();
    await expect(page.getByTestId('toast')).toBeVisible();
    expect(commitCount(repo)).toBe(1);

    await page.getByTestId('activity-log-button').click();
    const failed = page.locator('[data-testid="activity-log-row"]:not([data-code="0"])').filter({ hasText: /\bcommit\b/ });
    await expect(failed.first()).toBeVisible({ timeout: 8_000 });
    const code = await failed.first().getAttribute('data-code');
    expect(Number(code)).toBeGreaterThan(0);
    await expect(failed.first().getByTestId('activity-log-code')).toHaveText(String(code));
    const colour = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).color);
    const ok = page.locator('[data-testid="activity-log-row"][data-code="0"]').first();
    await expect(ok).toBeVisible();
    expect(await colour(failed.first().getByTestId('activity-log-code'))).not.toBe(await colour(ok.getByTestId('activity-log-code')));
  });

  test('rows render as text, never as HTML', async ({ page, request }) => {
    const repo = createStagingRepo();
    await openGraph(page, repo);
    const open = await request.post('/api/repos/open', { headers, data: { path: repo } });
    const id = ((await open.json()) as { id: string }).id;
    const evil = '<img src=x onerror=window.__pwned=1>';
    await request.get(`/api/repos/${id}/search?q=${encodeURIComponent(evil)}`, { headers });
    await page.getByTestId('activity-log-button').click();
    const row = page.getByTestId('activity-log-row').filter({ hasText: 'onerror=window.__pwned=1' });
    await expect(row.first()).toBeVisible({ timeout: 8_000 }); // the text is shown
    await expect(page.getByTestId('activity-log-panel').locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });

  test('new commands show up while the panel is open (polling), and no polling happens while it is closed', async ({ page }) => {
    const repo = createStagingRepo();
    await openGraph(page, repo);
    let polls = 0;
    page.on('request', (r) => {
      if (/\/command-log/.test(new URL(r.url()).pathname)) polls++;
    });
    await page.waitForTimeout(5_000);
    expect(polls).toBe(0); // closed: nothing polled
    await page.getByTestId('activity-log-button').click();
    await expect(page.getByTestId('activity-log-panel')).toBeVisible();
    await expect.poll(() => polls, { timeout: 5_000 }).toBeGreaterThan(0);
    const before = await page.getByTestId('activity-log-row').count();
    await page.getByTestId('wip-row').click(); // loads status and details: more git commands
    await page.getByTestId('commit-summary').fill('Poll me');
    await page.getByTestId('commit-button').click();
    await expect.poll(() => page.getByTestId('activity-log-row').count(), { timeout: 8_000 }).toBeGreaterThan(before);
    await page.getByTestId('activity-log-button').click();
    const after = polls;
    await page.waitForTimeout(4_500);
    expect(polls).toBe(after); // closed again: polling stopped
  });

  test('a failed load shows Error-LoadingActivityLogFailed', async ({ page }) => {
    await openGraph(page, createStagingRepo());
    await page.route('**/command-log**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
    await page.getByTestId('activity-log-button').click();
    await expect(page.getByTestId('activity-log-error')).toHaveText('An error occurred while trying to load this log.');
  });
});

test.describe('shortcuts', () => {
  test('Ctrl+F opens the graph search and focuses it', async ({ page }) => {
    await openGraph(page, createStagingRepo());
    await expect(page.getByTestId('graph-search')).toHaveCount(0);
    await blur(page);
    await page.keyboard.press('Control+f');
    await expect(page.getByTestId('graph-search-input')).toBeFocused();
  });

  test('Ctrl+F does nothing inside the Monaco editor', async ({ page }) => {
    const repo = createStagingRepo();
    await openGraph(page, repo);
    await page.getByTestId('wip-row').click();
    await page.locator(`[data-testid="wip-file-row"][data-path="${STAGING_FILES.header}"]`).first().click();
    await page.getByTestId('view-inline').click();
    const editor = page.locator('[data-testid="diff-monaco"] .monaco-editor:visible').first();
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.locator('.view-lines').click({ force: true });
    await page.keyboard.press('Control+f');
    await expect(page.getByTestId('graph-search')).toHaveCount(0);
  });

  test('Ctrl+Alt+F focuses the sidebar filter', async ({ page }) => {
    await openGraph(page, createStagingRepo());
    await blur(page);
    await page.keyboard.press('Control+Alt+f');
    await expect(page.getByTestId('sidebar-filter')).toBeFocused();
  });

  test('Ctrl+Enter commits from the summary field', async ({ page }) => {
    const repo = createStagingRepo();
    await openGraph(page, repo);
    await page.getByTestId('wip-row').click();
    await page.getByTestId('commit-summary').fill('Via summary');
    await page.getByTestId('commit-summary').press('Control+Enter');
    await expect.poll(() => commitCount(repo)).toBe(3);
    expect(headMessage(repo)).toBe('Via summary');
  });

  test('Ctrl+Enter commits from the description field', async ({ page }) => {
    const repo = createStagingRepo();
    await openGraph(page, repo);
    await page.getByTestId('wip-row').click();
    await page.getByTestId('commit-summary').fill('Via description');
    await page.getByTestId('commit-description').fill('some body');
    await page.getByTestId('commit-description').press('Control+Enter');
    await expect.poll(() => commitCount(repo)).toBe(3);
    expect(headMessage(repo)).toContain('Via description');
  });

  test('Ctrl+Enter does nothing outside those two fields (summary filled, focus elsewhere)', async ({ page }) => {
    const repo = createStagingRepo();
    await openGraph(page, repo);
    await page.getByTestId('wip-row').click();
    await page.getByTestId('commit-summary').fill('Should not commit');
    await expect(page.getByTestId('commit-button')).toBeEnabled(); // so the commit path is available
    await blur(page);
    await page.keyboard.press('Control+Enter');
    await page.getByTestId('sidebar-filter').click();
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(1_500);
    expect(commitCount(repo)).toBe(2);
  });

  test('Ctrl+O shows the Open Repo view', async ({ page }) => {
    await openGraph(page, createStagingRepo());
    await blur(page);
    await page.keyboard.press('Control+o');
    await expect(page.getByTestId('open-repo-view')).toBeVisible();
  });

  test('Ctrl+T opens a new tab and Ctrl+W closes the active one; records whether the page could intercept them', async ({ page }, testInfo) => {
    await openGraph(page, createStagingRepo());
    await page.evaluate(() => {
      const w = window as unknown as { __prevented: Record<string, boolean> };
      w.__prevented = {};
      // Registered after the app's own listener, so defaultPrevented shows what the app did with the key.
      window.addEventListener('keydown', (e) => {
        if (e.ctrlKey && (e.key === 't' || e.key === 'w')) w.__prevented[e.key] = e.defaultPrevented;
      });
    });
    await blur(page);
    await page.keyboard.press('Control+t');
    await expect(page.getByTestId('open-repo-view')).toBeVisible();
    await page.getByTestId('repo-tab').first().click();
    await expect(page.getByTestId('repo-view')).toBeVisible();
    await expect(page.getByTestId('repo-tab')).toHaveCount(1);
    await blur(page);
    await page.keyboard.press('Control+w');
    await expect(page.getByTestId('repo-tab')).toHaveCount(0);
    const prevented = await page.evaluate(() => (window as unknown as { __prevented: Record<string, boolean> }).__prevented);
    testInfo.annotations.push({ type: 'ctrl-t-w', description: `page-level preventDefault seen: ${JSON.stringify(prevented)} (Playwright sends keys over CDP; a real Edge --app window may still keep Ctrl+T/W for itself)` });
    expect(prevented).toEqual({ t: true, w: true });
  });

  test('Escape closes the topmost overlay: Preferences, then a context menu', async ({ page }) => {
    await openGraph(page, createStagingRepo());
    await page.getByTestId('gear').click();
    await expect(page.getByTestId('preferences-view')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preferences-view')).toHaveCount(0);
    await page.getByTestId('commit-row').first().click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
  });

  test('Ctrl+= / Ctrl+- / Ctrl+0 change, bound and reset the zoom', async ({ page, request }) => {
    await openGraph(page, createStagingRepo());
    await expect(page.getByTestId('statusbar-zoom')).toContainText('100%');
    await blur(page);
    await page.keyboard.press('Control+=');
    await expect(page.getByTestId('statusbar-zoom')).toContainText('110%');
    await page.keyboard.press('Control+-');
    await page.keyboard.press('Control+-');
    await expect(page.getByTestId('statusbar-zoom')).toContainText('90%');
    await page.keyboard.press('Control+0');
    await expect(page.getByTestId('statusbar-zoom')).toContainText('100%');
    for (let i = 0; i < 10; i++) await page.keyboard.press('Control+=');
    await expect(page.getByTestId('statusbar-zoom')).toContainText('150%');
    await expect.poll(async () => (await getPrefs(request)).zoom).toBe(1.5);
    for (let i = 0; i < 12; i++) await page.keyboard.press('Control+-');
    await expect(page.getByTestId('statusbar-zoom')).toContainText('80%');
    await expect.poll(async () => (await getPrefs(request)).zoom).toBe(0.8);
  });
});

test.describe('zoom', () => {
  test('shown in the status bar, applied to the page, saved, and restored after a reload', async ({ page, request }) => {
    await openGraph(page, createStagingRepo());
    await expect(page.getByTestId('statusbar-zoom')).toContainText('🔍');
    expect(await zoomOf(page)).toBe('1');
    await blur(page);
    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+=');
    await expect(page.getByTestId('statusbar-zoom')).toContainText('120%');
    expect(await zoomOf(page)).toBe('1.2');
    await expect.poll(async () => (await getPrefs(request)).zoom).toBe(1.2);
    await page.reload();
    await expect(page.getByTestId('statusbar-zoom')).toContainText('120%');
    expect(await zoomOf(page)).toBe('1.2');
  });

  test('the server rejects zoom values outside 0.8..1.5 or off the 0.1 steps', async ({ request }) => {
    await request.put('/api/prefs', { headers, data: { zoom: 1.3 } });
    for (const bad of [0.7, 1.6, 1.05, '1.2', null, 0]) {
      const res = await request.put('/api/prefs', { headers, data: { zoom: bad } });
      expect(res.status(), String(bad)).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    }
    expect((await getPrefs(request)).zoom).toBe(1.3);
  });

  test('clicking in Monaco still lands the caret on the clicked line while zoomed', async ({ page }) => {
    await openGraph(page, createStagingRepo());
    await blur(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+=');
    await expect(page.getByTestId('statusbar-zoom')).toContainText('130%');
    await page.getByTestId('wip-row').click();
    await page.locator(`[data-testid="wip-file-row"][data-path="${STAGING_FILES.header}"]`).first().click();
    await page.getByTestId('view-inline').click();
    const editor = page.locator('[data-testid="diff-monaco"] .monaco-editor:visible').first();
    await expect(editor).toBeVisible({ timeout: 20_000 });
    // Click the unchanged line "h3" (the caret starts on line 1, so landing on this line proves the click position was read right).
    const line = page.locator('[data-testid="diff-monaco"] .view-line').filter({ hasText: /^h3$/ }).last();
    const box = (await line.boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    // The caret moves a moment after the click: poll instead of reading it once.
    await expect
      .poll(async () => {
        for (const c of await page.locator('[data-testid="diff-monaco"] .cursors-layer .cursor').all()) {
          const r = await c.boundingBox();
          if (r && Math.abs(r.y + r.height / 2 - (box.y + box.height / 2)) < box.height / 2) return true;
        }
        return false;
      })
      .toBe(true);
  });
});

test.describe('theme', () => {
  test('Preferences opens from the gear with the exact wording and Dark selected by default', async ({ page }) => {
    await openGraph(page, createStagingRepo());
    await page.getByTestId('gear').click();
    await expect(page.getByTestId('preferences-view')).toBeVisible();
    await expect(page.getByTestId('preferences-title')).toHaveText('Preferences'); // Preferences-Preferences
    await expect(page.getByTestId('preferences-section-ui')).toHaveText('UI Customization'); // UIPreferences
    await expect(page.getByTestId('preferences-theme-label')).toHaveText('Theme'); // UIPreferences-Theme
    await expect(page.getByLabel('Dark')).toBeChecked();
    await expect(page.getByLabel('Light')).not.toBeChecked();
    await page.getByTestId('preferences-close').click();
    await expect(page.getByTestId('preferences-view')).toHaveCount(0);
  });

  test('choosing Light switches data-theme, saves it, and survives a reload (also with localStorage cleared)', async ({ page, request }) => {
    await request.put('/api/prefs', { headers, data: { pullMode: 'rebase' } });
    await openGraph(page, createStagingRepo());
    expect(await theme(page)).toBe('dark');
    await page.getByTestId('gear').click();
    await page.getByTestId('pref-theme-light').check();
    await expect.poll(() => theme(page)).toBe('light');
    await expect.poll(async () => (await getPrefs(request)).theme).toBe('light');
    expect((await getPrefs(request)).pullMode).toBe('rebase'); // merge rule: a theme change keeps pullMode
    expect(await page.evaluate(() => localStorage.getItem('gitslappin-theme'))).toBe('light');

    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(await theme(page)).toBe('light'); // set by theme-boot.js before the app renders
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByTestId('tabsbar')).toBeVisible();
    await expect.poll(() => theme(page)).toBe('light'); // /api/prefs is the source of truth
    await request.put('/api/prefs', { headers, data: { pullMode: 'merge' } });
  });

  test('a bad localStorage value is never applied', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('gitslappin-theme', 'evil"><x'));
    await page.goto(`/?token=${TEST_TOKEN}`, { waitUntil: 'domcontentloaded' });
    expect(['dark', 'light']).toContain(await theme(page));
    await expect(page.getByTestId('tabsbar')).toBeVisible();
    expect(['dark', 'light']).toContain(await theme(page));
  });

  test('the server rejects themes other than dark and light', async ({ request }) => {
    for (const bad of ['Dark', 'blue', '', 1, null]) {
      const res = await request.put('/api/prefs', { headers, data: { theme: bad } });
      expect(res.status(), String(bad)).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    }
    expect((await getPrefs(request)).theme).toBe('dark');
  });

  test('Light uses the GitKraken light token values (computed colours)', async ({ page, request }) => {
    await request.put('/api/prefs', { headers, data: { theme: 'light' } });
    await openGraph(page, createStagingRepo());
    await expect.poll(() => theme(page)).toBe('light');
    // Values copied from light.jsonc-default (also visible in screens 10a/10b): token name -> rgb().
    const expected: Record<string, string> = {
      '--app__bg0': 'rgb(252, 252, 252)',
      '--toolbar__bg0': 'rgb(250, 250, 250)',
      '--panel__bg0': 'rgb(243, 243, 243)',
      '--panel__bg1': 'rgb(250, 250, 250)',
      '--panel-border': 'rgb(198, 198, 198)',
      '--section-border': 'rgb(204, 204, 204)',
      '--text-accent': 'rgb(57, 91, 191)',
      '--green': 'rgb(0, 168, 87)',
      '--red': 'rgb(159, 26, 22)',
      '--blue': 'rgb(77, 136, 255)',
    };
    const actual = await page.evaluate((names) => {
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      const out: Record<string, string> = {};
      for (const n of names) {
        probe.style.backgroundColor = `var(${n})`;
        out[n] = getComputedStyle(probe).backgroundColor;
      }
      probe.remove();
      return out;
    }, Object.keys(expected));
    expect(actual).toEqual(expected);
  });

  test('no dark colours are left in the diff, menu and staging screens in Light', async ({ page, request }) => {
    await request.put('/api/prefs', { headers, data: { theme: 'light' } });
    await openGraph(page, createStagingRepo());
    await expect.poll(() => theme(page)).toBe('light');
    await page.getByTestId('wip-row').click();
    await expect(page.getByTestId('wip-details')).toBeVisible();
    expect(await bgLuminance(page, '[data-testid="commit-summary"]')).toBeGreaterThan(0.7); // staging.css
    await page.locator(`[data-testid="wip-file-row"][data-path="${STAGING_FILES.header}"]`).first().click();
    await expect(page.getByTestId('diff-view')).toBeVisible();
    expect(await bgLuminance(page, '[data-testid="diff-view"]')).toBeGreaterThan(0.7); // diff.css
    await page.getByTestId('diff-close').click(); // the diff covers the graph
    await page.getByTestId('commit-row').first().click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    expect(await bgLuminance(page, '[data-testid="context-menu"]')).toBeGreaterThan(0.7); // menu.css
  });

  test('switching back to Dark restores the dark theme', async ({ page, request }) => {
    await request.put('/api/prefs', { headers, data: { theme: 'light' } });
    await openGraph(page, createStagingRepo());
    await expect.poll(() => theme(page)).toBe('light');
    await page.getByTestId('gear').click();
    await page.getByTestId('pref-theme-dark').check();
    await expect.poll(() => theme(page)).toBe('dark');
    await expect.poll(async () => (await getPrefs(request)).theme).toBe('dark');
  });
});

test.describe('status bar', () => {
  test('shows the version from the root package.json', async ({ page }) => {
    const version = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    await openGraph(page, createStagingRepo());
    await expect(page.getByTestId('statusbar-version')).toContainText(version);
  });

  test('List and Tree buttons carry the GitKraken titles and drive the file list', async ({ page }) => {
    await openGraph(page, createStagingRepo());
    await expect(page.getByTestId('statusbar-view-list')).toHaveAttribute('title', 'List'); // LeftPanel-ListView
    await expect(page.getByTestId('statusbar-view-tree')).toHaveAttribute('title', 'Tree'); // FileNodeListControls-TreeView
    await page.getByTestId('wip-row').click();
    await expect(page.getByTestId('wip-file-list').first()).toHaveAttribute('data-mode', 'path');
    await page.getByTestId('statusbar-view-tree').click();
    await expect(page.getByTestId('statusbar-view-tree')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('wip-file-list').first()).toHaveAttribute('data-mode', 'tree');
    await page.getByTestId('statusbar-view-list').click();
    await expect(page.getByTestId('wip-file-list').first()).toHaveAttribute('data-mode', 'path');
  });
});
