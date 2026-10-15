import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { createMergeInProgress, gitOut, gitStatus } from './helpers/mergeFixtures';
import { createRepo } from './helpers/repo';
import { createNoUpstreamBranch, createPullMergeInProgress, createRemoteFx, git } from './helpers/remoteFixtures';

/*
 * Phase 7 code-review fixes 4, 5, 6 (UpstreamBar key, origin default, Pull caret during an op) and
 * phase 8 visual fixes 1, 2, 3 (rail hidden, header checkbox, output placeholder line).
 * Fixes 1 and 2 of phase 7 and fix 4 of phase 8 (/take) are server fixes with unit and integration tests.
 */

async function openGraph(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}

async function openTool(page: Page, repo: string, path: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('op-banner')).toBeVisible();
  await page.getByTestId('op-banner').click();
  await expect(page.getByTestId('conflict-panel')).toBeVisible();
  await page.getByTestId('conflict-conflicted').locator(`[data-testid="conflict-file-row"][data-path="${path}"]`).click();
  await expect(page.getByTestId('merge-tool')).toBeVisible({ timeout: 20_000 });
}

/** f.txt has stable lines around the conflict: "one", the conflict, "three". */
function interiorMerge(): string {
  const repo = createRepo('mt-interior-merge', [{ message: 'Base', files: { 'f.txt': 'one\ntitle=base\nthree\n' } }]);
  gitOut(repo, ['config', 'core.autocrlf', 'false']);
  gitOut(repo, ['switch', '-c', 'side']);
    writeFileSync(`${repo}/f.txt`, 'one\ntitle=side\nthree\n');
  gitOut(repo, ['commit', '-am', 'Side']);
  gitOut(repo, ['switch', 'main']);
  writeFileSync(`${repo}/f.txt`, 'one\ntitle=main\nthree\n');
  gitOut(repo, ['commit', '-am', 'Main']);
  if (gitStatus(repo, ['merge', '--no-ff', '--no-edit', 'side']) === 0) throw new Error('fixture: expected a conflict');
  return repo;
}

test.describe('phase 7 review fixes (client)', () => {
  test('the upstream bar defaults to origin even when another remote sorts first', async ({ page }) => {
    const fx = createRemoteFx();
    createNoUpstreamBranch(fx);
    git(fx.a, ['remote', 'add', 'aaa', fx.originUrl]);
    await openGraph(page, fx.a);
    await page.getByTestId('tool-push').click();
    await expect(page.getByTestId('upstream-bar')).toBeVisible();
    await expect(page.getByTestId('upstream-remote').locator('option')).toHaveText(['aaa', 'origin']);
    await expect(page.getByTestId('upstream-remote')).toHaveValue('origin');
  });

  test('the upstream bar starts afresh when it is asked again for another purpose', async ({ page }) => {
    const fx = createRemoteFx();
    createNoUpstreamBranch(fx);
    await openGraph(page, fx.a);
    await page.getByTestId('tool-push').click();
    await expect(page.getByTestId('upstream-bar')).toBeVisible();
    await page.getByTestId('upstream-branch').fill('typed-name');
    await page.getByTestId('tool-pull').click();
    await expect(page.getByTestId('upstream-branch')).toHaveValue('feature/x');
  });

  test('during a merge the Pull caret and Fetch All stay usable; the pull items and Pull and Push are off', async ({ page }) => {
    const fx = createPullMergeInProgress();
    await openGraph(page, fx.a);
    await expect(page.getByTestId('tool-pull')).toBeDisabled();
    await expect(page.getByTestId('tool-push')).toBeDisabled();
    await expect(page.getByTestId('pull-options-toggle')).toBeEnabled();
    await page.getByTestId('pull-options-toggle').click();
    await expect(page.locator('[data-testid="pull-option"][data-mode="fetch"]')).toBeEnabled();
    for (const mode of ['merge', 'ff-only', 'rebase']) await expect(page.locator(`[data-testid="pull-option"][data-mode="${mode}"]`)).toBeDisabled();
    await page.locator('[data-testid="pull-option"][data-mode="fetch"]').click();
    await expect(page.getByTestId('pull-options')).toHaveCount(0);
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
});

test.describe('phase 8 visual fixes', () => {
  test('the left icon rail is hidden while the merge tool is open and comes back after Close', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openTool(page, fx.repo, 'src/config.js');
    await expect(page.getByTestId('left-panel')).toBeHidden();
    const box = await page.getByTestId('merge-tool').boundingBox();
    const view = await page.getByTestId('repo-view').boundingBox();
    expect(box && view && box.x - view.x < 2).toBe(true); // the tool starts at the left edge
    await page.getByTestId('merge-close').click();
    await expect(page.getByTestId('left-panel')).toBeVisible();
  });

  test('the select-all checkbox sits left of the A/B badge and has no text, only a tooltip and label', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openTool(page, fx.repo, 'src/config.js');
    for (const side of ['a', 'b']) {
      const all = page.getByTestId(`merge-take-all-${side}`);
      await expect(all).toHaveText('');
      await expect(all).toHaveAttribute('aria-label', 'Take all');
      await expect(all).toHaveAttribute('title', 'Take all');
      const a = await all.boundingBox();
      const badge = await page.getByTestId(`merge-badge-${side}`).boundingBox();
      expect(a && badge && a.x + a.width <= badge.x).toBe(true);
    }
  });

  test('an unresolved conflict is one empty placeholder line at its place; the next stable line does not take it', async ({ page }) => {
    const repo = interiorMerge();
    await openTool(page, repo, 'f.txt');
    const out = page.getByTestId('merge-output');
    const lines = out.locator('.view-line');
    await expect(lines).toHaveCount(4); // "one", the empty placeholder, "three", and the final empty line
    await expect(out).toHaveAttribute('data-value', 'one\nthree\n'); // the placeholder is not part of the output
    await page.getByTestId('merge-take-a').first().click();
    await expect(out).toHaveAttribute('data-value', 'one\ntitle=main\nthree\n');
    await expect(lines).toHaveCount(4);
    await page.getByTestId('merge-take-a').first().click();
    await expect(out).toHaveAttribute('data-value', 'one\nthree\n');
    await expect(lines).toHaveCount(4); // the placeholder line is back
  });

  test('a conflict-only file shows a single empty output line (as GitKraken does)', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openTool(page, fx.repo, 'src/config.js');
    await expect(page.getByTestId('merge-output').locator('.view-line')).toHaveCount(1);
    await expect(page.getByTestId('merge-output')).toHaveAttribute('data-value', '');
  });
});
