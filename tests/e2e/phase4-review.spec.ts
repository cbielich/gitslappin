import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { LAST_BODY, createHunkRepo, createStagingRepo, createUnbornRepo, headMessage } from './helpers/stagingFixtures';

/* Phase 4 code-review fixes 3, 4, 5 and 7 (1, 2 and 8 are int tests in server/src/git/phase4Review.int.test.ts). */

async function openWip(page: Page, repo: string, graph = true): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  if (graph) await expect(page.getByTestId('commit-row').first()).toBeVisible();
  await page.getByTestId('wip-row').click();
  await expect(page.getByTestId('wip-details')).toBeVisible();
}

const wipRow = (page: Page, section: 'unstaged' | 'staged', path: string) =>
  page.getByTestId(`wip-${section}`).locator(`[data-testid="wip-file-row"][data-path="${path}"]`);

async function openDiff(page: Page, section: 'unstaged' | 'staged', path: string): Promise<void> {
  await wipRow(page, section, path).click();
  await expect(page.getByTestId('diff-view')).toBeVisible();
}

const addLine = (page: Page, text: string) =>
  page.locator('[data-testid="diff-line"][data-kind="add"]').filter({ has: page.getByTestId('line-text').filter({ hasText: new RegExp(`^${text}$`) }) });

test.describe('phase 4 review fixes', () => {
  test('3: a failed stage action re-reads the open diff (stale hunk after the file changed on disk)', async ({ page }) => {
    const repo = createHunkRepo();
    await openWip(page, repo);
    await openDiff(page, 'unstaged', 'lines.txt');
    await expect(addLine(page, 'X2')).toBeVisible();
    await expect(addLine(page, 'X3')).toHaveCount(0);
    // The file changes behind the app's back: the hunk header the page holds is out of date, so the server says 409.
    writeFileSync(join(repo, 'lines.txt'), 'a\nX1\nX2\nX3\nb\n');
    await page.getByTestId('hunk-action').first().click();
    await expect(page.getByTestId('toast-title')).toHaveText('Staging selection failed');
    await expect(addLine(page, 'X3')).toBeVisible(); // the diff was read again
  });

  test('4: after a commit the staged diff that was open is closed', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    await openDiff(page, 'staged', 'src/app.js');
    await page.getByTestId('commit-summary').fill('Commit the staged file');
    await expect(page.getByTestId('commit-button')).toBeEnabled();
    await page.getByTestId('commit-button').click();
    await expect(page.getByTestId('diff-view')).toHaveCount(0);
    expect(headMessage(repo)).toBe('Commit the staged file');
  });

  test('5: Amend does not replace text the user already typed', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    await page.getByTestId('commit-summary').fill('My own summary');
    await page.getByTestId('commit-description').fill('My own description');
    await page.getByLabel('Amend previous commit').check();
    await page.waitForTimeout(600); // a prefill (the old behaviour) would land within this time
    await expect(page.getByTestId('commit-summary')).toHaveValue('My own summary');
    await expect(page.getByTestId('commit-description')).toHaveValue('My own description');
    await expect(page.getByTestId('commit-description')).not.toHaveValue(new RegExp(LAST_BODY));
  });

  test('5: Amend still prefills an empty box with the HEAD message', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    await page.getByLabel('Amend previous commit').check();
    await expect(page.getByTestId('commit-summary')).toHaveValue('Second commit');
    await expect(page.getByTestId('commit-description')).toHaveValue(LAST_BODY);
  });

  test('7: a long file list is windowed (few rows in the page) and still reaches the last file', async ({ page }) => {
    const repo = createUnbornRepo();
    const names = Array.from({ length: 400 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
    for (const n of names) writeFileSync(join(repo, n), `${n}\n`);
    await openWip(page, repo, false);
    await expect(page.getByTestId('wip-unstaged-count')).toHaveText('401'); // 400 + first.txt
    const rows = page.getByTestId('wip-unstaged').getByTestId('wip-file-row');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeLessThan(150);
    await page.getByTestId('wip-unstaged').locator('.wip-section-body').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(wipRow(page, 'unstaged', 'first.txt')).toBeVisible(); // sorts after f399.txt
    await expect(wipRow(page, 'unstaged', 'f000.txt')).toHaveCount(0);
    expect(await rows.count()).toBeLessThan(150);
  });
});
