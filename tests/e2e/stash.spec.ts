import { writeFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { createMergeInProgress } from './helpers/mergeFixtures';
import { TEST_TOKEN } from './helpers/repo';
import {
  EDITED_APP,
  EDITED_UTIL,
  FIRST_STASH,
  LOCAL_APP,
  ORIGINAL,
  PARTIAL_FINAL,
  SECOND_STASH,
  UNTRACKED_NAME,
  UNTRACKED_TEXT,
  createDirtyStashRepo,
  createOverlapRepo,
  createPartialStagingRepo,
  createPopConflictRepo,
  createStagedWithStashRepo,
  createStashRepo,
  createStashedDirtyRepo,
  createStashedRepo,
  createTwoStagedRepo,
  fileExists,
  fileText,
  gitOut,
  keepRefSha,
  porcelain,
  stagedNames,
  stashShas,
  stashSubjects,
} from './helpers/stashFixtures';

/*
 * Test ids this file expects (new ones marked +):
 *  existing: repo-view, commit-row[data-sha][data-stash], commit-message, sidebar-toggle-stashes, sidebar-count-stashes,
 *            sidebar-item[data-kind="stash"][data-sha], wip-row, wip-details, wip-file-row, commit-summary, commit-button, toast,
 *            toast-title, toast-detail, context-menu, menu-item, op-banner, conflict-panel, conflict-title, op-abort,
 *            tab-stash (named by the phase 6 spec), diff-view, diff-line[data-kind], line-text
 *  + tool-stash, tool-pop                   toolbar buttons; `disabled` when unavailable; the tooltip is the `title` attribute
 *  + tab-commit                             the Commit tab of the commit box (tab-stash is its sibling)
 *  + stash-summary, stash-description       inputs of the Stash tab (placeholders "Stash title" / "Description")
 *  + stash-button                           the action button of the Stash tab, its text is the state label
 *  + confirm-bar, confirm-message, confirm-ok, confirm-cancel     one generic confirm bar (delete stash, dirty apply, partial staging)
 *  + stash-details                          right panel after clicking a stash node (graph row or sidebar item)
 *  + stash-file-row[data-path][data-status] inside stash-details; clicking a row opens diff-view
 * Right-clicking a stash graph row or a sidebar stash item opens context-menu with: Apply Stash, Pop Stash, Delete Stash.
 * Routes: POST /api/repos/:id/stash {message?, fromTab}, POST .../stash/apply {sha, pop}, POST .../stash/drop {sha}, GET .../stash/:sha
 *   (400 bad input, 404 sha not in the stash list, 409 op in progress / unmerged / anything staged on apply).
 * Strings (en-us.json): StashButtonTooltip, PopStashButtonTooltip, ContextMenu-StashApply/-StashPop/-StashDelete,
 *   ConfirmationMessage-DeleteStash, DeleteButtonLabel, CancelButtonLabel, Stash-ApplyWithUncommittedChangesPrompt,
 *   CommitDetailPanel-Tab-Stash-Label / -ActionLabelDisabledStageChanges / -ActionLabelDisabledNoMessage / -ActionLabelSingular / -ActionLabelPlural,
 *   StashMessage-SummaryPlaceholder / -DescriptionPlaceholder, Error-ApplyingStashError, ErrorMessage-CannotApplyStashWhenFilesAreStaged,
 *   RightPanel-MergeConflictsDetected.
 *   UNVERIFIED: the {0} of ConfirmationMessage-DeleteStash is matched as "anything ending in the stash text"; the partial-staging warning
 *   has no GitKraken key (design's own wording), so only the bar's presence and its buttons are asserted.
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };
const DIRTY_PROMPT = 'You have uncommitted changes. Are you sure you want to apply the stash on top of your changes?';
const STAGED_REFUSAL = 'Cannot apply stash while anything is staged. Stash, commit, or unstage first.';

async function openGraph(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
async function expandStashes(page: Page): Promise<void> {
  const head = page.getByTestId('sidebar-toggle-stashes');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
}
const sbStash = (page: Page, text: string) => page.locator('[data-testid="sidebar-item"][data-kind="stash"]').filter({ hasText: text });
const stashRow = (page: Page, sha: string) => page.locator(`[data-testid="commit-row"][data-sha="${sha}"]`);
const menuItem = (page: Page, text: string) => page.getByTestId('context-menu').getByTestId('menu-item').filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) });
const fileRow = (page: Page, path: string) => page.locator(`[data-testid="stash-file-row"][data-path="${path}"]`);

async function openMenu(page: Page, text: string): Promise<void> {
  await expandStashes(page);
  await sbStash(page, text).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}
async function openWipTab(page: Page, tab: 'tab-stash' | 'tab-commit'): Promise<void> {
  await page.getByTestId('wip-row').click();
  await expect(page.getByTestId('wip-details')).toBeVisible();
  await page.getByTestId(tab).click();
}
async function openRepoApi(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.post('/api/repos/open', { headers, data: { path } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

test.describe('toolbar Stash and Pop', () => {
  test('Stash saves tracked and untracked changes with git\'s default message and cleans the tree', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openGraph(page, repo);
    const btn = page.getByTestId('tool-stash');
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveAttribute('title', 'Stash'); // StashButtonTooltip
    await btn.click();
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    expect(stashShas(repo)).toHaveLength(1);
    expect(stashSubjects(repo)[0]).toMatch(/^WIP on main: [0-9a-f]{7,} Stash fixture 2$/);
    expect(porcelain(repo)).toBe('');
    expect(fileExists(repo, UNTRACKED_NAME)).toBe(false);
    expect(fileText(repo, 'src/app.js')).toBe(ORIGINAL.app);
    await expect(page.locator('[data-testid="commit-row"][data-stash]')).toHaveCount(1); // the stash node is on the graph
    await expect(btn).toBeDisabled(); // clean tree now
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('Stash is disabled on a clean tree and while a merge has conflicts', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await expect(page.getByTestId('tool-stash')).toBeDisabled();
    const merge = createMergeInProgress();
    await openGraph(page, merge.repo);
    await expect(page.getByTestId('tool-stash')).toBeDisabled();
    await expect(page.getByTestId('tool-pop')).toBeDisabled();
  });

  test('Pop applies the newest stash, drops it, and keeps a keep ref', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    const btn = page.getByTestId('tool-pop');
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveAttribute('title', 'Pop Stash'); // PopStashButtonTooltip
    await btn.click();
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    expect(fileText(fx.repo, 'src/util.js')).toBe(EDITED_UTIL); // SECOND_STASH was the newest
    expect(fileText(fx.repo, 'src/app.js')).toBe(ORIGINAL.app);
    expect(stashShas(fx.repo)).toEqual([fx.shas[0]]);
    expect(keepRefSha(fx.repo, fx.shas[1])).toBe(fx.shas[1]);
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('Pop is disabled when there is no stash', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await expect(page.getByTestId('tool-pop')).toBeDisabled();
  });
});

test.describe('Stash tab', () => {
  test('labels follow the state: stage changes, type a message, one file, many files', async ({ page }) => {
    const repo = createDirtyStashRepo(); // nothing staged
    await openGraph(page, repo);
    await openWipTab(page, 'tab-stash');
    await expect(page.getByTestId('tab-stash')).toHaveText('Stash'); // CommitDetailPanel-Tab-Stash-Label
    await expect(page.getByTestId('stash-summary')).toHaveAttribute('placeholder', 'Stash title');
    await expect(page.getByTestId('stash-description')).toHaveAttribute('placeholder', 'Description');
    const btn = page.getByTestId('stash-button');
    await expect(btn).toHaveText('Stage Changes to Stash');
    await expect(btn).toBeDisabled();
    await page.getByTestId('tab-commit').click(); // keep the page alive; the staged cases use fresh repos below
  });

  test('one staged file: needs a message, then reads "Stash Changes to 1 File"', async ({ page }) => {
    const repo = createStashRepo();
    writeFileSync(`${repo}/src/app.js`, EDITED_APP);
    gitOut(repo, ['add', '--', 'src/app.js']);
    await openGraph(page, repo);
    await openWipTab(page, 'tab-stash');
    const btn = page.getByTestId('stash-button');
    await expect(btn).toHaveText('Type a Message to Stash');
    await expect(btn).toBeDisabled();
    await page.getByTestId('stash-summary').fill('One file');
    await expect(btn).toHaveText('Stash Changes to 1 File');
    await expect(btn).toBeEnabled();
  });

  test('two staged files with a title and description stash only those, message = title + blank line + description', async ({ page }) => {
    const repo = createTwoStagedRepo();
    writeFileSync(`${repo}/README.md`, `${ORIGINAL.readme}second\nleft in the tree\n`);
    await openGraph(page, repo);
    await openWipTab(page, 'tab-stash');
    await page.getByTestId('stash-summary').fill('Two files');
    await page.getByTestId('stash-description').fill('Because of reasons');
    await expect(page.getByTestId('stash-button')).toHaveText('Stash Changes to 2 Files');
    await page.getByTestId('stash-button').click();
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    expect(gitOut(repo, ['log', '-1', '--format=%B', 'stash@{0}']).trimEnd()).toBe('On main: Two files\n\nBecause of reasons');
    expect(gitOut(repo, ['diff-tree', '-r', '--name-only', '--no-commit-id', 'stash@{0}^1', 'stash@{0}']).split('\n').filter(Boolean).sort()).toEqual(['src/app.js', 'src/util.js']);
    expect(stagedNames(repo)).toEqual([]);
    expect(fileText(repo, 'src/app.js')).toBe(ORIGINAL.app);
    expect(fileText(repo, 'README.md')).toBe(`${ORIGINAL.readme}second\nleft in the tree\n`); // unstaged edit stays
  });

  test('partial staging: a confirm bar warns first; Cancel stashes nothing, OK stashes the whole file', async ({ page }) => {
    const repo = createPartialStagingRepo();
    await openGraph(page, repo);
    await openWipTab(page, 'tab-stash');
    await page.getByTestId('stash-summary').fill('Partial');
    await page.getByTestId('stash-button').click();
    await expect(page.getByTestId('confirm-bar')).toBeVisible();
    expect(stashShas(repo)).toHaveLength(0);
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
    expect(stashShas(repo)).toHaveLength(0);
    expect(fileText(repo, 'src/app.js')).toBe(PARTIAL_FINAL);
    await page.getByTestId('stash-button').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    expect(gitOut(repo, ['show', 'stash@{0}:src/app.js'])).toBe(PARTIAL_FINAL); // staged AND unstaged part
    expect(fileText(repo, 'src/app.js')).toBe(ORIGINAL.app);
    expect(fileText(repo, 'src/util.js')).toBe(EDITED_UTIL); // not staged -> stays
  });
});

test.describe('stash context menu', () => {
  test('menu shows Apply Stash, Pop Stash, Delete Stash', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    await openMenu(page, FIRST_STASH);
    const labels = await page.getByTestId('context-menu').getByTestId('menu-item').allInnerTexts();
    expect(labels.map((l) => l.trim())).toEqual(['Apply Stash', 'Pop Stash', 'Delete Stash']);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
  });

  test('menu also opens from the stash node in the graph', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    await stashRow(page, fx.shas[1]).getByTestId('commit-message').click({ button: 'right' });
    await expect(menuItem(page, 'Apply Stash')).toBeVisible();
  });

  test('Apply keeps the stash and restores tracked and untracked files', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    await openMenu(page, FIRST_STASH);
    await menuItem(page, 'Apply Stash').click();
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0); // clean tree: no prompt
    await expect.poll(() => fileText(fx.repo, 'src/app.js')).toBe(EDITED_APP);
    await expect.poll(() => fileExists(fx.repo, UNTRACKED_NAME)).toBe(true); // git writes the untracked files after the tracked ones
    expect(fileText(fx.repo, UNTRACKED_NAME)).toBe(UNTRACKED_TEXT);
    expect(stashShas(fx.repo)).toEqual([fx.shas[1], fx.shas[0]]);
  });

  test('Pop on the older stash picks the right entry by sha and removes only it', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    await openMenu(page, FIRST_STASH);
    await menuItem(page, 'Pop Stash').click();
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    expect(fileText(fx.repo, 'src/app.js')).toBe(EDITED_APP);
    expect(fileText(fx.repo, UNTRACKED_NAME)).toBe(UNTRACKED_TEXT);
    expect(fileText(fx.repo, 'src/util.js')).toBe(ORIGINAL.util);
    expect(stashShas(fx.repo)).toEqual([fx.shas[1]]);
    expect(keepRefSha(fx.repo, fx.shas[0])).toBe(fx.shas[0]);
  });

  test('Delete asks first (exact sentence, Delete / Cancel); Cancel keeps it, Delete drops it but the commit survives', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    await openMenu(page, FIRST_STASH);
    await menuItem(page, 'Delete Stash').click();
    const bar = page.getByTestId('confirm-bar');
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText(new RegExp(`^This is a destructive operation, are you sure you want to delete stash with message ".*${FIRST_STASH}"\\?$`));
    await expect(page.getByTestId('confirm-ok')).toHaveText('Delete');
    await expect(page.getByTestId('confirm-cancel')).toHaveText('Cancel');
    await page.getByTestId('confirm-cancel').click();
    await expect(bar).toHaveCount(0);
    expect(stashShas(fx.repo)).toHaveLength(2);
    await openMenu(page, FIRST_STASH);
    await menuItem(page, 'Delete Stash').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    expect(stashShas(fx.repo)).toEqual([fx.shas[1]]);
    expect(keepRefSha(fx.repo, fx.shas[0])).toBe(fx.shas[0]);
    expect(gitOut(fx.repo, ['cat-file', '-t', fx.shas[0]]).trim()).toBe('commit');
  });

  test('a hostile stash message is shown as text, never run', async ({ page }) => {
    const repo = createStashRepo();
    const hostile = '<img src=x onerror=window.__pwned=1>';
    writeFileSync(`${repo}/src/app.js`, EDITED_APP);
    gitOut(repo, ['stash', 'push', '-m', hostile]);
    await openGraph(page, repo);
    await expandStashes(page);
    await expect(sbStash(page, hostile)).toBeVisible();
    await sbStash(page, hostile).click({ button: 'right' });
    await menuItem(page, 'Delete Stash').click();
    await expect(page.getByTestId('confirm-message')).toContainText(hostile);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });
});

test.describe('stash node and file list', () => {
  test('clicking a stash lists tracked changes and the untracked file; each opens a diff', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    await stashRow(page, fx.shas[0]).getByTestId('commit-message').click();
    await expect(page.getByTestId('stash-details')).toBeVisible();
    await expect(fileRow(page, 'src/app.js')).toHaveAttribute('data-status', 'M');
    await expect(fileRow(page, UNTRACKED_NAME)).toHaveAttribute('data-status', 'A');
    await expect(page.locator('[data-testid="stash-file-row"]')).toHaveCount(2);

    await fileRow(page, UNTRACKED_NAME).click();
    await expect(page.getByTestId('diff-view')).toBeVisible();
    const adds = page.locator('[data-testid="diff-line"][data-kind="add"] [data-testid="line-text"]');
    await expect(adds).toHaveText(['untracked line one', 'untracked line two']);

    await fileRow(page, 'src/app.js').click();
    await expect(page.locator('[data-testid="diff-line"][data-kind="add"]').filter({ hasText: 'app EDITED for the stash' })).toBeVisible();
    await expect(page.locator('[data-testid="diff-line"][data-kind="del"]')).toHaveCount(0);
    // reading changed nothing
    expect(stashShas(fx.repo)).toEqual([fx.shas[1], fx.shas[0]]);
    expect(porcelain(fx.repo)).toBe('');
  });

  test('the sidebar stash item opens the same file list', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    await expandStashes(page);
    await sbStash(page, SECOND_STASH).click();
    await expect(page.getByTestId('stash-details')).toBeVisible();
    await expect(fileRow(page, 'src/util.js')).toHaveAttribute('data-status', 'M');
  });
});

test.describe('apply onto a changed tree', () => {
  test('dirty tree: a confirm bar with the exact prompt; Cancel applies nothing, OK applies and keeps the local edit', async ({ page }) => {
    const fx = createStashedDirtyRepo();
    await openGraph(page, fx.repo);
    await openMenu(page, FIRST_STASH);
    await menuItem(page, 'Apply Stash').click();
    await expect(page.getByTestId('confirm-message')).toHaveText(DIRTY_PROMPT);
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
    expect(fileText(fx.repo, 'src/app.js')).toBe(ORIGINAL.app);
    await openMenu(page, FIRST_STASH);
    await menuItem(page, 'Apply Stash').click();
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => fileText(fx.repo, 'src/app.js')).toBe(EDITED_APP);
    expect(fileText(fx.repo, 'README.md')).toContain('local edit');
    expect(stashShas(fx.repo)).toHaveLength(2);
  });

  test('git refuses to overwrite local changes: error toast, bytes and stash untouched', async ({ page }) => {
    const fx = createOverlapRepo();
    await openGraph(page, fx.repo);
    await openMenu(page, FIRST_STASH);
    await menuItem(page, 'Pop Stash').click();
    if (await page.getByTestId('confirm-bar').isVisible()) await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('toast-title')).toHaveText('Error Applying Stash');
    expect(fileText(fx.repo, 'src/app.js')).toBe(LOCAL_APP);
    expect(stashShas(fx.repo)).toHaveLength(2);
  });

  test('anything staged: refused with the exact message, nothing changes', async ({ page }) => {
    const fx = createStagedWithStashRepo();
    await openGraph(page, fx.repo);
    const before = gitOut(fx.repo, ['ls-files', '-s']);
    await openMenu(page, FIRST_STASH);
    await menuItem(page, 'Apply Stash').click();
    if (await page.getByTestId('confirm-bar').isVisible()) await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('toast-title')).toHaveText('Error Applying Stash');
    await expect(page.getByTestId('toast-detail')).toContainText(STAGED_REFUSAL);
    expect(gitOut(fx.repo, ['ls-files', '-s'])).toBe(before);
    expect(fileText(fx.repo, 'src/app.js')).toBe(ORIGINAL.app);
    expect(stashShas(fx.repo)).toHaveLength(2);
  });

  test('a pop that conflicts keeps the stash and shows the conflict panel without Abort or Commit', async ({ page }) => {
    const fx = createPopConflictRepo();
    await openGraph(page, fx.repo);
    await openMenu(page, 'Conflicting stash');
    await menuItem(page, 'Pop Stash').click();
    if (!(await page.getByTestId('conflict-panel').isVisible())) await page.getByTestId('op-banner').click();
    await expect(page.getByTestId('conflict-title')).toHaveText('Merge conflicts detected'); // RightPanel-MergeConflictsDetected
    await expect(page.getByTestId('op-abort')).toHaveCount(0);
    await expect(page.getByTestId('commit-button')).toHaveCount(0);
    expect(stashShas(fx.repo)).toEqual([fx.sha]);
    expect(gitOut(fx.repo, ['diff', '--name-only', '--diff-filter=U']).trim()).toBe('src/app.js');
  });
});

test.describe('stash API guards', () => {
  test('bad sha is 400, unknown or non-stash sha is 404, nothing changes', async ({ request }) => {
    const fx = createStashedRepo();
    const id = await openRepoApi(request, fx.repo);
    const head = gitOut(fx.repo, ['rev-parse', 'HEAD']).trim();
    const before = gitOut(fx.repo, ['for-each-ref', '--format=%(refname) %(objectname)']);
    for (const sha of ['stash@{0}', '--all', fx.shas[0].slice(0, 7), fx.shas[0].toUpperCase()]) {
      expect((await request.post(`/api/repos/${id}/stash/apply`, { headers, data: { sha, pop: true } })).status()).toBe(400);
      expect((await request.post(`/api/repos/${id}/stash/drop`, { headers, data: { sha } })).status()).toBe(400);
      expect((await request.get(`/api/repos/${id}/stash/${encodeURIComponent(sha)}`, { headers })).status()).toBeGreaterThanOrEqual(400);
    }
    expect((await request.post(`/api/repos/${id}/stash/apply`, { headers, data: { sha: head, pop: true } })).status()).toBe(404);
    expect((await request.post(`/api/repos/${id}/stash/drop`, { headers, data: { sha: '0'.repeat(40) } })).status()).toBe(404);
    expect((await request.get(`/api/repos/${id}/stash/${head}`, { headers })).status()).toBe(404);
    expect(gitOut(fx.repo, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(before);
    expect(stashShas(fx.repo)).toHaveLength(2);
  });

  test('GET /stash/:sha lists tracked files and the untracked file', async ({ request }) => {
    const fx = createStashedRepo();
    const id = await openRepoApi(request, fx.repo);
    const res = await request.get(`/api/repos/${id}/stash/${fx.shas[0]}`, { headers });
    expect(res.status()).toBe(200);
    expect(JSON.stringify(await res.json())).toContain(UNTRACKED_NAME);
  });

  test('message over 8 KB is 400 and creates nothing; exactly 8 KB works', async ({ request }) => {
    const repo = createDirtyStashRepo();
    const id = await openRepoApi(request, repo);
    const tooLong = await request.post(`/api/repos/${id}/stash`, { headers, data: { message: 'a'.repeat(8193), fromTab: false } });
    expect(tooLong.status()).toBe(400);
    expect(stashShas(repo)).toHaveLength(0);
    expect(porcelain(repo)).not.toBe('');
    const ok = await request.post(`/api/repos/${id}/stash`, { headers, data: { message: 'a'.repeat(8192), fromTab: false } });
    expect(ok.status()).toBe(200);
    expect(stashShas(repo)).toHaveLength(1);
  });

  test('every stash route answers 409 while a merge is unresolved', async ({ request }) => {
    const merge = createMergeInProgress();
    gitOut(merge.repo, ['stash', 'list']); // sanity: the repo is usable
    const id = await openRepoApi(request, merge.repo);
    const before = gitOut(merge.repo, ['status', '--porcelain=v1']);
    expect((await request.post(`/api/repos/${id}/stash`, { headers, data: { fromTab: false } })).status()).toBe(409);
    expect((await request.post(`/api/repos/${id}/stash/apply`, { headers, data: { sha: '0'.repeat(40), pop: false } })).status()).toBe(409);
    expect((await request.post(`/api/repos/${id}/stash/drop`, { headers, data: { sha: '0'.repeat(40) } })).status()).toBe(409);
    expect(gitOut(merge.repo, ['status', '--porcelain=v1'])).toBe(before);
  });
});
