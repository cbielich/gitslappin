import { expect, type Page } from '@playwright/test';
import { TEST_TOKEN } from './repo';

/** Loads the app with the token and shows the Open Repo view. */
export async function gotoOpenView(page: Page): Promise<void> {
  // Start each test with no open tabs so tabs from earlier tests (shared test data dir) can't interfere.
  // This only changes GitSlappin's own tab list in the throwaway test data dir; no repo is touched.
  const res = await page.request.put('/api/tabs', {
    headers: { 'X-GitSlappin-Token': TEST_TOKEN },
    data: { tabs: [], activeId: null },
  });
  expect(res.ok()).toBe(true);
  await page.goto(`/?token=${TEST_TOKEN}`);
  await page.getByTestId('tab-add').click();
  await expect(page.getByTestId('open-repo-view')).toBeVisible();
}

export async function openRepoByPath(page: Page, path: string): Promise<void> {
  await page.getByTestId('open-path-input').fill(path);
  await page.getByTestId('open-button').click();
  // Opening is async: wait until it either succeeds (repo view) or fails (error).
  await expect(page.getByTestId('repo-view').or(page.getByTestId('open-error'))).toBeVisible();
}
