import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView } from './helpers/app';
import { createRepo } from './helpers/repo';

// In-app folder browser. Every test types a mkdtemp folder into the Open box first, then clicks Browse, so C:\repos is never listed.
// ASSUMED (builder must match): Browse starts at the typed folder when it exists. Test ids:
//   browse-button, folder-browser (the modal), folder-browser-title, folder-browser-path (current folder, text = display path),
//   folder-browser-up, folder-browser-list, folder-browser-entry (one row per folder, text = name),
//   folder-browser-repo-icon (inside a row that is a repo), folder-browser-empty, folder-browser-open, folder-browser-cancel.
// GitKraken strings (en-us.json): BrowseButtonLabel "Browse", OpenRepo-BrowseForReposDialogTitle "Select a repository to open", CancelButtonLabel "Cancel", Open "Open".
// Invented wording: "Up"; empty folder "This folder has no subfolders."

const EMPTY_TEXT = 'This folder has no subfolders.';

/** parent/ { alpha/, Beta/inner/, empty/, <repo>/ (a git repo) } */
function layout(name: string) {
  const repo = createRepo(name);
  const parent = dirname(repo);
  mkdirSync(join(parent, 'alpha'));
  mkdirSync(join(parent, 'Beta', 'inner'), { recursive: true });
  mkdirSync(join(parent, 'empty'));
  return { parent, repo, repoName: basename(repo) };
}

async function browse(page: Page, typed: string) {
  await gotoOpenView(page);
  await page.getByTestId('open-path-input').fill(typed);
  await page.getByRole('button', { name: 'Browse', exact: true }).click();
  await expect(page.getByTestId('folder-browser')).toBeVisible();
}
const row = (page: Page, name: string) => page.getByTestId('folder-browser-entry').filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) });

test('Browse opens the modal with GitKraken wording and lists the typed folder, folders only, sorted ignoring case', async ({ page }) => {
  const { parent, repoName } = layout('fb-basic');
  await browse(page, parent);
  const modal = page.getByTestId('folder-browser');
  await expect(modal.getByTestId('folder-browser-title')).toHaveText('Select a repository to open');
  await expect(modal.getByTestId('folder-browser-path')).toContainText(basename(parent));
  await expect(modal.getByTestId('folder-browser-up')).toHaveText('Up');
  await expect(modal.getByTestId('folder-browser-open')).toHaveText('Open');
  await expect(modal.getByTestId('folder-browser-cancel')).toHaveText('Cancel');
  await expect(modal.getByTestId('folder-browser-entry')).toHaveText(['alpha', 'Beta', 'empty', repoName]);
  // Each row carries the raw absolute path in data-path (navigation and /open use it, not the displayed name).
  await expect(row(page, 'alpha')).toHaveAttribute('data-path', join(parent, 'alpha'));
});

test('a repo row shows the repo icon and a plain folder does not', async ({ page }) => {
  const { parent, repoName } = layout('fb-icon');
  await browse(page, parent);
  await expect(row(page, repoName).getByTestId('folder-browser-repo-icon')).toBeVisible();
  await expect(row(page, 'alpha')).toBeVisible();
  await expect(row(page, 'alpha').getByTestId('folder-browser-repo-icon')).toHaveCount(0);
});

test('double-click enters a folder, the Up button and Backspace go back, an empty folder says so', async ({ page }) => {
  const { parent } = layout('fb-nav');
  await browse(page, parent);
  await row(page, 'Beta').dblclick();
  await expect(page.getByTestId('folder-browser-path')).toContainText('Beta');
  await expect(page.getByTestId('folder-browser-entry')).toHaveText(['inner']);

  await page.getByTestId('folder-browser-up').click();
  await expect(page.getByTestId('folder-browser-path')).not.toContainText('Beta');
  await expect(row(page, 'Beta')).toBeVisible();

  await row(page, 'Beta').dblclick();
  await expect(row(page, 'inner')).toBeVisible();
  await page.getByTestId('folder-browser-list').focus();
  await page.keyboard.press('Backspace');
  await expect(row(page, 'Beta')).toBeVisible();

  await row(page, 'empty').click();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('folder-browser-empty')).toHaveText(EMPTY_TEXT);
  await expect(page.getByTestId('folder-browser-entry')).toHaveCount(0);
});

test('Enter on a selected folder enters it', async ({ page }) => {
  const { parent } = layout('fb-enter');
  await browse(page, parent);
  await row(page, 'Beta').click();
  await page.keyboard.press('Enter');
  await expect(row(page, 'inner')).toBeVisible();
});

test('double-click on a repo opens it through /open and closes the modal', async ({ page }) => {
  const { parent, repoName } = layout('fb-open-dbl');
  await browse(page, parent);
  await row(page, repoName).dblclick();
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('repo-tab-name').filter({ hasText: repoName })).toBeVisible();
  await expect(page.getByTestId('folder-browser')).toHaveCount(0);
});

test('Enter on a selected repo opens it', async ({ page }) => {
  const { parent, repoName } = layout('fb-open-enter');
  await browse(page, parent);
  await row(page, repoName).click();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('repo-tab-name').filter({ hasText: repoName })).toBeVisible();
});

test('the Open button opens the selected repo', async ({ page }) => {
  const { parent, repoName } = layout('fb-open-btn');
  await browse(page, parent);
  await row(page, repoName).click();
  await page.getByTestId('folder-browser-open').click();
  await expect(page.getByTestId('repo-tab-name').filter({ hasText: repoName })).toBeVisible();
});

test('Esc closes the modal and leaves the Open view', async ({ page }) => {
  const { parent } = layout('fb-esc');
  await browse(page, parent);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('folder-browser')).toHaveCount(0);
  await expect(page.getByTestId('open-repo-view')).toBeVisible();
});

test('Cancel closes the modal and opens nothing', async ({ page }) => {
  const { parent } = layout('fb-cancel');
  await browse(page, parent);
  await page.getByTestId('folder-browser-cancel').click();
  await expect(page.getByTestId('folder-browser')).toHaveCount(0);
  await expect(page.getByTestId('open-repo-view')).toBeVisible();
  await expect(page.getByTestId('repo-view')).toHaveCount(0);
});
