import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { EVIL_SUBJECT, createBigRepo, createGraphRepo } from './helpers/graphFixtures';
import { TEST_TOKEN, createRepo } from './helpers/repo';

async function openGraph(page: Page, path: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, path);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}

async function expandSections(page: Page, ids: string[] = ['local', 'remote', 'stashes', 'tags']): Promise<void> {
  for (const id of ids) {
    const head = page.getByTestId(`sidebar-toggle-${id}`);
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  }
}

/** Opens a repo that may have no commits: waits for the repo view only. */
async function openGraph0(page: Page, path: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, path);
  await expect(page.getByTestId('repo-view')).toBeVisible();
}

const rowWithSubject = (page: Page, subject: string | RegExp) =>
  page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: subject }) });

test.describe('commit graph', () => {
  let graphRepo: string;
  test.beforeAll(() => {
    graphRepo = createGraphRepo();
  });

  test('rows render with refs, current branch and literal hostile subject', async ({ page }) => {
    let dialogs = 0;
    page.on('dialog', async (d) => {
      dialogs++;
      await d.dismiss();
    });
    await openGraph(page, graphRepo);

    // 7 commits + 1 stash node
    await expect(page.getByTestId('commit-row')).toHaveCount(8);
    await expect(page.locator('.ref-pill.current')).toContainText('main');
    await expect(page.locator('[data-testid="ref-pill"][data-name="feature/login"]')).toBeVisible();
    await expect(page.locator('[data-testid="ref-pill"][data-name="v1.0"]')).toBeVisible();
    await expect(page.locator('[data-testid="ref-pill"][data-name="bugfix/header"]')).toBeVisible();
    await expect(page.getByTestId('toolbar-branch')).toContainText('main');

    // The merge commit is a small solid dot, the others are avatar nodes.
    const merge = rowWithSubject(page, "Merge branch 'feature/login'");
    await expect(merge.locator('[data-node="merge"]')).toHaveCount(1);
    await expect(rowWithSubject(page, 'Add login form').locator('[data-node="commit"]')).toHaveCount(1);
    // Stash shows as a dashed square node.
    await expect(page.locator('[data-testid="commit-row"][data-stash="true"]')).toHaveCount(1);

    // Hostile subject renders as text only.
    const evil = rowWithSubject(page, EVIL_SUBJECT);
    await expect(evil).toHaveCount(1);
    await expect(evil.getByTestId('commit-message')).toHaveText(EVIL_SUBJECT);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(dialogs).toBe(0);
  });

  test('selecting a commit shows its details and files', async ({ page }) => {
    await openGraph(page, graphRepo);
    await rowWithSubject(page, 'Add login form').click();
    await expect(rowWithSubject(page, 'Add login form')).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('commit-details')).toBeVisible();
    await expect(page.getByTestId('details-message')).toHaveText('Add login form');
    await expect(page.getByTestId('details-author')).toHaveText('Test Author');
    await expect(page.getByTestId('details-date')).toContainText(/authored \d{2}\/\d{2}\/\d{4} @ \d{1,2}:\d{2} (AM|PM)/);
    await expect(page.getByTestId('details-sha')).toHaveText(/^[0-9a-f]{7}$/);
    await expect(page.getByTestId('details-parent')).toHaveCount(1);
    await expect(page.getByTestId('file-row')).toHaveCount(1);
    await expect(page.locator('[data-testid="file-row"][data-path="src/login.js"][data-status="A"]')).toBeVisible();
    await expect(page.getByTestId('file-summary-added')).toContainText('1 added');
    await expect(page.getByTestId('changes-banner')).toContainText('2 file changes in working directory');

    // Tree mode groups by directory.
    await page.getByTestId('toggle-tree').click();
    await expect(page.getByTestId('tree-dir')).toContainText('src');
    await page.getByTestId('toggle-path').click();
    await expect(page.getByTestId('tree-dir')).toHaveCount(0);

    // Merge commit shows two parents and the first-parent diff.
    await rowWithSubject(page, "Merge branch 'feature/login'").click();
    await expect(page.getByTestId('details-parent')).toHaveCount(2);
    await expect(page.locator('[data-testid="file-row"][data-path="src/login.js"]')).toBeVisible();
  });

  test('sidebar sections show counts and the filter narrows them', async ({ page }) => {
    await openGraph(page, graphRepo);
    // Sections start collapsed; the counts are still shown.
    await expect(page.getByTestId('sidebar-toggle-local')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('sidebar-item')).toHaveCount(0);
    await expandSections(page);
    await expect(page.getByTestId('sidebar-count-local')).toHaveText('3');
    await expect(page.getByTestId('sidebar-count-remote')).toHaveText('1');
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    await expect(page.getByTestId('sidebar-count-tags')).toHaveText('1');
    await expect(page.getByTestId('viewing-count')).toHaveText('5');

    await page.getByTestId('sidebar-filter').fill('login');
    await expect(page.getByTestId('sidebar-count-local')).toHaveText('1');
    await expect(page.getByTestId('sidebar-count-remote')).toHaveText('0');
    await expect(page.getByTestId('sidebar-count-tags')).toHaveText('0');
    await expect(page.getByTestId('sidebar-item')).toHaveCount(1);
    await expect(page.getByTestId('viewing-count')).toHaveText('1');

    await page.getByTestId('sidebar-filter').fill('');
    await expect(page.getByTestId('sidebar-toggle-local')).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('sidebar-toggle-local').click();
    await expect(page.locator('[data-testid="sidebar-item"][data-kind="local"]')).toHaveCount(0);
    await page.getByTestId('left-collapse').click();
    await expect(page.getByTestId('left-panel')).toHaveAttribute('data-collapsed', 'true');
  });

  test('clicking a branch selects its commit', async ({ page }) => {
    await openGraph(page, graphRepo);
    await expandSections(page, ['local']);
    await page.locator('[data-testid="sidebar-item"][data-name="bugfix/header"]').click();
    await expect(rowWithSubject(page, 'Add header component')).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('details-message')).toHaveText('Add header component');
  });

  test('Ctrl+F finds matches, counts them and steps through', async ({ page }) => {
    await openGraph(page, graphRepo);
    await page.getByTestId('graph-view').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+f');
    await expect(page.getByTestId('graph-search')).toBeVisible();
    await page.getByTestId('graph-search-input').fill('login');
    // merge commit + "Validate login input" + "Add login form"
    await expect(page.getByTestId('graph-search-count')).toHaveText('1 of 3');
    await expect(page.locator('[data-testid="commit-row"][data-match="true"]')).toHaveCount(3);
    await expect(rowWithSubject(page, "Merge branch 'feature/login'")).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('graph-search-count')).toHaveText('2 of 3');
    await expect(rowWithSubject(page, 'Validate login input')).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('Shift+Enter');
    await expect(page.getByTestId('graph-search-count')).toHaveText('1 of 3');
    await page.getByTestId('graph-search-next').click();
    await expect(page.getByTestId('graph-search-count')).toHaveText('2 of 3');

    await page.getByTestId('graph-search-input').fill('no-such-text-anywhere');
    await expect(page.getByTestId('graph-search-count')).toHaveText('0 of 0');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('graph-search')).toHaveCount(0);
  });

  test('WIP row shows when the tree is dirty and lists the changes read-only', async ({ page }) => {
    await openGraph(page, graphRepo);
    await expect(page.getByTestId('wip-row')).toBeVisible();
    await expect(page.getByTestId('wip-count-modified')).toContainText('1');
    await expect(page.getByTestId('wip-count-added')).toContainText('1');
    await page.getByTestId('wip-row').click();
    await expect(page.getByTestId('wip-details')).toBeVisible();
    await expect(page.getByTestId('wip-header')).toContainText('2 file changes');
    await expect(page.getByTestId('wip-file-row')).toHaveCount(2);
    await expect(page.locator('[data-testid="wip-file-row"][data-path="new-file.txt"]')).toBeVisible();
    await expect(page.getByTestId('wip-summary-modified')).toContainText('1 modified');
  });

  test('no WIP row on a clean repo', async ({ page }) => {
    const clean = createRepo('clean-graph');
    await openGraph(page, clean);
    await expect(page.getByTestId('wip-row')).toHaveCount(0);
  });
});

test.describe('graph visuals and options', () => {
  let graphRepo: string;
  test.beforeAll(() => {
    graphRepo = createGraphRepo();
  });

  test('ref pills have a line to the node, WIP and stash are linked with dotted lines', async ({ page }) => {
    await openGraph(page, graphRepo);
    const mainRow = page.locator('[data-testid="commit-row"]').filter({ has: page.locator('.ref-pill.current') });
    await expect(mainRow.getByTestId('ref-line')).toHaveCount(1);
    await expect(rowWithSubject(page, 'Add login form').getByTestId('ref-line')).toHaveCount(0);
    // WIP node -> HEAD node
    await expect(page.getByTestId('wip-link')).toHaveCount(1);
    // The stash lane is dotted down to its base commit.
    const stashRow = page.locator('[data-testid="commit-row"][data-stash="true"]');
    await expect(stashRow.locator('svg path[style*="stroke-dasharray"]').first()).toBeAttached();
  });

  test('graph column fits the lanes by default and can be resized', async ({ page }) => {
    await openGraph(page, graphRepo);
    const cell = page.locator('.graph-header .cell-graph');
    const w0 = (await cell.boundingBox())!.width;
    expect(w0).toBeGreaterThanOrEqual(90);
    expect(w0).toBeLessThanOrEqual(320);
    const handle = (await page.getByTestId('resize-graph').boundingBox())!;
    await page.mouse.move(handle.x + 3, handle.y + 10);
    await page.mouse.down();
    await page.mouse.move(handle.x + 63, handle.y + 10);
    await page.mouse.up();
    const w1 = (await cell.boundingBox())!.width;
    expect(w1).toBeGreaterThan(w0 + 40);
  });

  test('AUTHOR / DATE / SHA columns are hidden by default, toggled from the header menu and remembered', async ({ page }) => {
    await openGraph(page, graphRepo);
    await expect(page.getByTestId('header-author')).toHaveCount(0);
    await expect(page.getByTestId('cell-author')).toHaveCount(0);
    await page.getByTestId('graph-header').click({ button: 'right', position: { x: 300, y: 10 } });
    await expect(page.getByTestId('column-menu')).toBeVisible();
    await page.getByTestId('column-toggle-author').click();
    await page.getByTestId('column-toggle-sha').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('column-menu')).toHaveCount(0);
    await expect(page.getByTestId('header-author')).toHaveText('AUTHOR');
    await expect(page.getByTestId('header-sha')).toHaveText('SHA');
    await expect(page.getByTestId('header-date')).toHaveCount(0);
    await expect(page.getByTestId('cell-author').first()).toHaveText('Test Author');
    await expect(page.getByTestId('cell-sha').first()).toHaveText(/^[0-9a-f]{7}$/);

    await page.reload();
    await expect(page.getByTestId('commit-row').first()).toBeVisible();
    await expect(page.getByTestId('header-author')).toBeVisible();
    await expect(page.getByTestId('header-sha')).toBeVisible();
    await expect(page.getByTestId('header-date')).toHaveCount(0);

    // Date column, then switch everything off again.
    await page.getByTestId('graph-header').click({ button: 'right', position: { x: 300, y: 10 } });
    await page.getByTestId('column-toggle-date').click();
    await page.getByTestId('column-toggle-author').click();
    await page.getByTestId('column-toggle-sha').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('cell-date').first()).toHaveText(/^\d{2}\/\d{2}\/\d{4} @ \d{1,2}:\d{2} (AM|PM)$/);
    await expect(page.getByTestId('header-author')).toHaveCount(0);
    await page.getByTestId('graph-header').click({ button: 'right', position: { x: 300, y: 10 } });
    await page.getByTestId('column-toggle-date').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('header-date')).toHaveCount(0);
  });

  test('sidebar expanded state is remembered per repo', async ({ page }) => {
    await openGraph(page, graphRepo);
    await expandSections(page, ['tags']);
    await expect(page.getByTestId('sidebar-toggle-tags')).toHaveAttribute('aria-expanded', 'true');
    await page.reload();
    await expect(page.getByTestId('commit-row').first()).toBeVisible();
    await expect(page.getByTestId('sidebar-toggle-tags')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('sidebar-toggle-local')).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('sidebar-toggle-tags').click();
  });

  test('"View all files" lists the whole tree and marks the changed files', async ({ page }) => {
    await openGraph(page, graphRepo);
    await rowWithSubject(page, 'Add login form').click();
    await expect(page.getByTestId('file-row')).toHaveCount(1);
    await expect(page.getByTestId('view-all-files')).not.toBeChecked();
    await page.getByTestId('view-all-files').check();
    await expect(page.locator('[data-testid="file-row"][data-path="README.md"][data-status="unchanged"]')).toBeVisible();
    await expect(page.locator('[data-testid="file-row"][data-path="src/app.js"][data-status="unchanged"]')).toBeVisible();
    await expect(page.locator('[data-testid="file-row"][data-path="src/login.js"][data-status="A"]')).toBeVisible();
    await page.getByTestId('toggle-tree').click();
    await expect(page.getByTestId('tree-dir')).toContainText('src');
    await page.getByTestId('view-all-files').uncheck();
    await page.getByTestId('toggle-path').click();
    await expect(page.getByTestId('file-row')).toHaveCount(1);
  });

  test('a failed page load shows an error row with a working retry', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/repos/*/log*', async (route) => {
      calls++;
      if (calls === 1) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
      else await route.continue();
    });
    await gotoOpenView(page);
    await openRepoByPath(page, graphRepo);
    await expect(page.getByTestId('graph-error')).toContainText('boom');
    await expect(page.getByTestId('commit-row')).toHaveCount(0);
    await page.getByTestId('graph-retry').click();
    await expect(page.getByTestId('graph-error')).toHaveCount(0);
    await expect(page.getByTestId('commit-row').first()).toBeVisible();
    expect(calls).toBe(2);
  });

  test('an empty repository shows the empty state, not an error', async ({ page, request }) => {
    const empty = createRepo('empty-repo', []);
    const headers = { 'X-GitSlappin-Token': TEST_TOKEN };
    const opened = await request.post('/api/repos/open', { headers, data: { path: empty } });
    expect(opened.status()).toBe(200);
    const { id } = (await opened.json()) as { id: string };
    const log = await request.get(`/api/repos/${id}/log`, { headers });
    expect(log.status()).toBe(200);
    expect((await log.json()).commits).toEqual([]);

    await openGraph0(page, empty);
    await expect(page.getByTestId('graph-empty')).toHaveText('No commits');
    await expect(page.getByTestId('graph-error')).toHaveCount(0);
    await expect(page.getByTestId('commit-row')).toHaveCount(0);
  });

  test('the WIP selection is dropped when the tree becomes clean', async ({ page }) => {
    const repo = createRepo('wip-clean');
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    await openGraph(page, repo);
    await page.getByTestId('wip-row').click();
    await expect(page.getByTestId('wip-details')).toBeVisible();
    // Restore the file (no deletion involved), then refocus the window to trigger the refetch.
    writeFileSync(join(repo, 'README.md'), '# test\n');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('wip-row')).toHaveCount(0);
    await expect(page.getByTestId('wip-details')).toHaveCount(0);
  });
});

test.describe('large history', () => {
  let big: string;
  test.beforeAll(() => {
    big = createBigRepo(1200).dir;
  });

  test('pages and virtualizes: DOM rows stay small while scrolling to the oldest commit', async ({ page }) => {
    await openGraph(page, big);
    const rows = page.getByTestId('commit-row');
    expect(await rows.count()).toBeLessThan(150);

    const scroller = page.getByTestId('graph-scroll');
    const root = rowWithSubject(page, 'Root marker zzroot');
    await expect
      .poll(
        async () => {
          await scroller.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          expect(await rows.count()).toBeLessThan(150);
          return root.count();
        },
        { timeout: 30_000 },
      )
      .toBe(1);
    await expect(rowWithSubject(page, 'Root marker zzroot')).toBeVisible();
  });

  test('clicking a far-away branch loads pages until its commit is found', async ({ page }) => {
    await openGraph(page, big);
    await expect(rowWithSubject(page, 'Root marker zzroot')).toHaveCount(0);
    await expandSections(page, ['local']);
    await page.locator('[data-testid="sidebar-item"][data-name="ancient"]').click();
    const root = rowWithSubject(page, 'Root marker zzroot');
    await expect(root).toHaveAttribute('data-selected', 'true', { timeout: 30_000 });
    await expect(root).toBeVisible();
    expect(await page.getByTestId('commit-row').count()).toBeLessThan(150);
  });

  test('Ctrl+F loads pages until a far-away match is shown', async ({ page }) => {
    await openGraph(page, big);
    await page.getByTestId('graph-view').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+f');
    await page.getByTestId('graph-search-input').fill('zzroot');
    await expect(page.getByTestId('graph-search-count')).toHaveText('1 of 1', { timeout: 30_000 });
    await expect(rowWithSubject(page, 'Root marker zzroot')).toHaveAttribute('data-selected', 'true', { timeout: 30_000 });
    expect(await page.getByTestId('commit-row').count()).toBeLessThan(150);
  });
});
