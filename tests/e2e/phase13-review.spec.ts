import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { FEATURE, createMergeRepo } from './helpers/mergeFixtures';
import { TEST_TOKEN } from './helpers/repo';
import { createStagingRepo } from './helpers/stagingFixtures';

/* Phase 13 code-review fixes (build-notes) 2 to 8. Fix 1 (tokenised colours) is client/src/theme/tokens.test.ts. */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };
const resetPrefs = (page: Page) => page.request.put('/api/prefs', { headers, data: { theme: 'dark', zoom: 1 } });
const zoomOf = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).zoom);
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

async function openGraph(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await resetPrefs(page);
});
test.afterEach(async ({ page }) => {
  await resetPrefs(page);
});

test('fix 2: Ctrl+W does nothing while the Open view is showing', async ({ page }) => {
  await openGraph(page, createStagingRepo());
  await page.getByTestId('tab-add').click();
  await expect(page.getByTestId('open-repo-view')).toBeVisible();
  await blur(page);
  await page.keyboard.press('Control+w');
  await expect(page.getByTestId('repo-tab')).toHaveCount(1);
  await expect(page.getByTestId('open-repo-view')).toBeVisible();
});

test('fix 3: a zoom changed before the first prefs load returns is kept', async ({ page }) => {
  await page.route('**/api/prefs', async (route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto(`/?token=${TEST_TOKEN}`);
  await expect(page.getByTestId('statusbar-zoom')).toContainText('100%');
  await blur(page);
  await page.keyboard.press('Control+=');
  await expect(page.getByTestId('statusbar-zoom')).toContainText('110%');
  await page.waitForTimeout(2500); // the delayed GET (zoom 1) has returned by now
  await expect(page.getByTestId('statusbar-zoom')).toContainText('110%');
  expect(await zoomOf(page)).toBe('1.1');
});

test('fix 4: theme-boot.js applies the saved zoom before the app loads, and ignores values outside 0.8..1.5', async ({ page }) => {
  await page.goto(`/?token=${TEST_TOKEN}`);
  await expect(page.getByTestId('statusbar-zoom')).toContainText('100%'); // the first prefs load has finished writing its own value
  await page.evaluate(() => localStorage.setItem('gitslappin-zoom', '1.3'));
  await page.route('**/api/prefs', (route) => route.abort()); // the prefs never arrive: only theme-boot.js can have set it
  await page.reload();
  expect(await zoomOf(page)).toBe('1.3');
  await page.evaluate(() => localStorage.setItem('gitslappin-zoom', '9'));
  await page.reload();
  expect(await zoomOf(page)).toBe('1');
  await page.evaluate(() => localStorage.setItem('gitslappin-zoom', 'abc'));
  await page.reload();
  expect(await zoomOf(page)).toBe('1');
});

test('fix 4: a zoom change is remembered for the next load', async ({ page }) => {
  await page.goto(`/?token=${TEST_TOKEN}`);
  await expect(page.getByTestId('statusbar-zoom')).toContainText('100%');
  await blur(page);
  await page.keyboard.press('Control+=');
  await expect(page.getByTestId('statusbar-zoom')).toContainText('110%');
  expect(await page.evaluate(() => localStorage.getItem('gitslappin-zoom'))).toBe('1.1');
});

test('fix 5: a failed prefs save shows an error toast', async ({ page }) => {
  await page.route('**/api/prefs', async (route) => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk full' }) });
    else await route.continue();
  });
  await page.goto(`/?token=${TEST_TOKEN}`);
  await expect(page.getByTestId('statusbar-zoom')).toContainText('100%');
  await blur(page);
  await page.keyboard.press('Control+=');
  await expect(page.getByTestId('toast-title')).toHaveText('Saving preferences failed');
});

test('fix 6: the Activity Log does not poll while the page is hidden', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => (window as unknown as { __hidden?: boolean }).__hidden === true });
  });
  await openGraph(page, createStagingRepo());
  let polls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/command-log')) polls++;
  });
  await page.getByTestId('activity-log-button').click();
  await expect(page.getByTestId('activity-log-panel')).toBeVisible();
  await expect.poll(() => polls).toBeGreaterThan(0);
  await page.evaluate(() => ((window as unknown as { __hidden?: boolean }).__hidden = true));
  await page.waitForTimeout(500);
  const frozen = polls;
  await page.waitForTimeout(5000); // more than two poll periods
  expect(polls).toBe(frozen);
  await page.evaluate(() => ((window as unknown as { __hidden?: boolean }).__hidden = false));
  await expect.poll(() => polls, { timeout: 8000 }).toBeGreaterThan(frozen);
});

test('fix 7: shortcuts act only on the active tab (one RepoView, one search bar)', async ({ page }) => {
  await openGraph(page, createStagingRepo());
  await page.getByTestId('tab-add').click();
  await openRepoByPath(page, createMergeRepo({ conflicts: 1, added: false }).repo);
  await expect(page.getByTestId('repo-view')).toHaveCount(1);
  await expect(page.getByTestId('repo-tab')).toHaveCount(2);
  await blur(page);
  await page.keyboard.press('Control+f');
  await expect(page.getByTestId('graph-search')).toHaveCount(1);
  await expect(page.getByTestId('graph-search-input')).toBeFocused();
});

test('fix 8: the merge-abort stash toast dismisses itself', async ({ page }) => {
  const fx = createMergeRepo({ conflicts: 1, added: false, dirty: true });
  await openGraph(page, fx.repo);
  await page.locator(`[data-testid="ref-pill"][data-name="${FEATURE}"]`).first().click({ button: 'right' });
  await page
    .getByTestId('context-menu')
    .getByTestId('menu-item')
    .filter({ hasText: `Merge ${FEATURE} into main` })
    .click();
  await expect(page.getByTestId('op-banner')).toBeVisible();
  await page.getByTestId('toast-dismiss').click();
  await page.getByTestId('op-banner').click();
  await page.getByTestId('op-abort').click();
  await expect(page.getByTestId('toast-title')).toHaveText('Stashing uncommitted changes');
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 10_000 });
});
