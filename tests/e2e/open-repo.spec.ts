import { basename } from 'node:path';
import { expect, test } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { createPlainDir, createRepo } from './helpers/repo';

test('opening a repo by path adds a tab with the repo name', async ({ page }) => {
  const repo = createRepo('open-by-path');
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-tab-name').filter({ hasText: basename(repo) })).toBeVisible();
  await expect(page.getByTestId('repo-view')).toBeVisible();
});

test('invalid paths show clear errors', async ({ page }) => {
  await gotoOpenView(page);
  await openRepoByPath(page, 'C:\\gitslappin-does-not-exist-xyz');
  await expect(page.getByTestId('open-error')).toContainText('does not exist');
  await openRepoByPath(page, createPlainDir('not-a-repo'));
  await expect(page.getByTestId('open-error')).toContainText('Not a git repository');
});

test('recent list shows an opened repo and reopens it on click', async ({ page }) => {
  const repo = createRepo('recent-one');
  const name = basename(repo);
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await page.getByTestId('repo-tab-close').first().waitFor();
  await page.getByTestId('tab-add').click();
  const item = page.getByTestId('recent-item').filter({ hasText: name });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId('repo-view')).toBeVisible();
});

test('tabs are restored after reload and can be closed', async ({ page }) => {
  const a = createRepo('restore-a');
  const b = createRepo('restore-b');
  await gotoOpenView(page);
  await openRepoByPath(page, a);
  await page.getByTestId('tab-add').click();
  await openRepoByPath(page, b);
  await expect(page.getByTestId('repo-tab-name').filter({ hasText: basename(b) })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('repo-tab-name').filter({ hasText: basename(a) })).toBeVisible();
  await expect(page.getByTestId('repo-tab-name').filter({ hasText: basename(b) })).toBeVisible();

  await page.getByTestId('repo-tab').filter({ hasText: basename(b) }).getByTestId('repo-tab-close').click();
  await expect(page.getByTestId('repo-tab-name').filter({ hasText: basename(b) })).toHaveCount(0);
});
