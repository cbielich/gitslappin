import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { FEATURE, createMenuRepo, createMergeInProgress, createMergeRepo, createRebaseInProgress, gitOut, gitStatus, merging, parentCount, stashList } from './helpers/mergeFixtures';

/*
 * Phase 6 code-review fixes (build-notes): 2 stash toast, 6 no Abort for cherry-pick/revert, 7 Commit and Merge with nothing staged,
 * 8 the continue request carries the step. Fixes 1, 3, 4, 5 are server tests (server/src/git/phase6Review.int.test.ts).
 * Toast title is Rebasing-AutoStashLabel; its detail is the StashMessage text.
 */

async function openGraph(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-name="${name}"]`).first();
const menuItem = (page: Page, text: string) => page.getByTestId('context-menu').getByTestId('menu-item').filter({ hasText: new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) });
const btn = (page: Page) => page.getByTestId('commit-button');

test.describe('review fix 2: a stash toast whenever the response carries one', () => {
  test('clean merge on a dirty tree (done): the toast names the stash', async ({ page }) => {
    const fx = createMenuRepo();
    writeFileSync(join(fx.repo, 'base.txt'), 'uncommitted edit\n');
    await openGraph(page, fx.repo);
    await pill(page, 'side').click({ button: 'right' });
    await menuItem(page, 'Merge side into main').click();
    await expect(page.getByTestId('toast-title')).toHaveText('Stashing uncommitted changes');
    await expect(page.getByTestId('toast-detail')).toHaveText('Auto stash before merge of "main" and "side"');
    expect(stashList(fx.repo)).toHaveLength(1);
    expect(parentCount(fx.repo)).toBe(2);
  });

  test('merge that is already up to date on a dirty tree: the toast names the stash', async ({ page }) => {
    const fx = createMenuRepo();
    gitOut(fx.repo, ['switch', 'ahead']);
    writeFileSync(join(fx.repo, 'base.txt'), 'uncommitted edit\n');
    await openGraph(page, fx.repo);
    await pill(page, 'main').click({ button: 'right' });
    await menuItem(page, 'Merge main into ahead').click();
    await expect(page.getByTestId('toast-detail')).toHaveText('Auto stash before merge of "ahead" and "main"');
    expect(stashList(fx.repo)).toHaveLength(1);
  });

  test('conflict and then Abort Merge: the toast shows again after the abort', async ({ page }) => {
    const fx = createMergeRepo({ conflicts: 1, added: false, dirty: true });
    await openGraph(page, fx.repo);
    await pill(page, FEATURE).click({ button: 'right' });
    await menuItem(page, 'Merge feature/conflict into main').click();
    await expect(page.getByTestId('op-banner')).toBeVisible();
    await expect(page.getByTestId('toast-detail')).toHaveText('Auto stash before merge of "main" and "feature/conflict"');
    await page.getByTestId('toast-dismiss').click();
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await page.getByTestId('op-banner').click();
    await page.getByTestId('op-abort').click();
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    await expect(page.getByTestId('toast-detail')).toHaveText('Auto stash before merge of "main" and "feature/conflict"');
    expect(merging(fx.repo)).toBe(false);
    expect(stashList(fx.repo)).toHaveLength(1);
  });
});

// Phase 11 built the cherry-pick and revert aborts, so review fix 6 (no Abort button) is lifted: the panel routes Abort by kind.
test.describe('review fix 6 (lifted in phase 11): a cherry-pick started outside GitSlappin shows Abort Cherry-pick', () => {
  test('the panel shows the conflicts and the Abort Cherry-pick button', async ({ page }) => {
    const fx = createMergeRepo({ conflicts: 1, added: false });
    expect(gitStatus(fx.repo, ['cherry-pick', fx.featureSha])).not.toBe(0);
    await openGraph(page, fx.repo);
    await expect(page.getByTestId('op-banner')).toBeVisible();
    await page.getByTestId('op-banner').click();
    await expect(page.getByTestId('conflict-panel')).toBeVisible();
    await expect(page.getByTestId('conflict-conflicted')).toContainText('Conflicted Files (1)'); // the panel is live
    await expect(page.getByTestId('op-abort')).toHaveText('Abort Cherry-pick');
  });

  test('control: a merge still has Abort Merge', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openGraph(page, fx.repo);
    await page.getByTestId('op-banner').click();
    await expect(page.getByTestId('op-abort')).toHaveText('Abort Merge');
  });
});

test.describe('review fix 7: Commit and Merge with nothing staged', () => {
  test('conflicts resolved to HEAD content: the button is enabled and makes the merge commit', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    gitOut(fx.repo, ['checkout', '--ours', '--', 'src/config.js']);
    gitOut(fx.repo, ['add', 'src/config.js']);
    expect(gitStatus(fx.repo, ['diff', '--cached', '--quiet'])).toBe(0); // nothing is staged
    await openGraph(page, fx.repo);
    await page.getByTestId('wip-row').click();
    await expect(page.getByTestId('conflict-panel')).toBeVisible();
    await expect(btn(page)).toHaveText('Commit and Merge');
    await expect(btn(page)).toBeEnabled();
    await btn(page).click();
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    expect(merging(fx.repo)).toBe(false);
    expect(parentCount(fx.repo)).toBe(2);
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
});

test.describe('review fix 8: continue sends the step', () => {
  test('the request body carries the step the user was looking at', async ({ page }) => {
    const fx = createRebaseInProgress();
    let body: Record<string, unknown> | null = null;
    await page.route('**/rebase/continue', async (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      await route.continue();
    });
    await openGraph(page, fx.repo);
    await page.getByTestId('op-banner').click();
    await page.getByTestId('mark-all-resolved').click();
    await expect(btn(page)).toHaveText('Continue Rebase');
    await btn(page).click();
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    expect(body).not.toBeNull();
    expect((body as unknown as Record<string, unknown>).step).toBe(2);
  });
});
