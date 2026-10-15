import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { createBranchRepo, localBranches } from './helpers/branchFixtures';
import { FEATURE, createMergeRepo, gitStatus, merging } from './helpers/mergeFixtures';
import { TEST_TOKEN } from './helpers/repo';

/* Phase 10 code-review fixes 2 and 3 (client): Ctrl+Z / Ctrl+Y ignore a held key (e.repeat) and do nothing while a merge / rebase is in progress. */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

async function openGraph(page: Page, repo: string): Promise<string> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
  const opened = await page.request.post('/api/repos/open', { headers, data: { path: repo } });
  expect(opened.status()).toBe(200);
  return ((await opened.json()) as { id: string }).id;
}
async function makeBranch(page: Page, id: string, name: string): Promise<void> {
  const res = await page.request.post(`/api/repos/${id}/branch`, { headers, data: { name, checkout: false } });
  expect(res.status()).toBe(200);
}

test('a held Ctrl+Z undoes one step, not a series (e.repeat is ignored)', async ({ page }) => {
  const fx = createBranchRepo();
  const id = await openGraph(page, fx.repo);
  await makeBranch(page, id, 'held-a'); // two recorded steps
  await makeBranch(page, id, 'held-b');
  await page.evaluate(() => {
    (window as unknown as { __repeats: boolean[] }).__repeats = [];
    window.addEventListener('keydown', (e) => e.key.toLowerCase() === 'z' && (window as unknown as { __repeats: boolean[] }).__repeats.push(e.repeat), true);
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.down('Control');
  await page.keyboard.down('z'); // the first press: undoes 'held-b'
  await expect.poll(() => localBranches(fx.repo).includes('held-b')).toBe(false);
  await expect(page.getByTestId('toast-title').first()).toHaveText('Undo Successful');
  await page.keyboard.down('z'); // auto-repeat of the held key
  await page.keyboard.down('z');
  await page.waitForTimeout(800);
  await page.keyboard.up('z');
  await page.keyboard.up('Control');
  const repeats = await page.evaluate(() => (window as unknown as { __repeats: boolean[] }).__repeats);
  expect(repeats).toEqual([false, true, true]); // the browser did flag them as repeats
  expect(localBranches(fx.repo)).toContain('held-a'); // the repeats did nothing
  expect((await (await page.request.get(`/api/repos/${id}/undo-state`, { headers })).json()).undo).toEqual({ label: "create branch 'held-a'" });
});

test('Ctrl+Z / Ctrl+Y do nothing while a merge is in progress (no request is even sent)', async ({ page }) => {
  const fx = createMergeRepo();
  const id = await openGraph(page, fx.repo);
  await makeBranch(page, id, 'before-merge'); // a recorded step to undo
  expect(gitStatus(fx.repo, ['merge', '--no-ff', '--no-edit', FEATURE])).not.toBe(0);
  expect(merging(fx.repo)).toBe(true);
  await page.reload(); // the app reads the merge state again
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('op-banner')).toBeVisible(); // opActive is true
  const posts: string[] = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === 'POST' && /\/(undo|redo)$/.test(p)) posts.push(p);
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(800);
  expect(posts).toEqual([]);
  await expect(page.getByTestId('toast')).toHaveCount(0);
  expect(localBranches(fx.repo)).toContain('before-merge');
});
