import { writeFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { SUBJECTS, createBranchRepo, currentBranch, headSha, localBranches } from './helpers/branchFixtures';
import { createMergeInProgress } from './helpers/mergeFixtures';
import { TEST_TOKEN } from './helpers/repo';
import { cachedNames, commitCount, createStagingRepo, headMessage } from './helpers/stagingFixtures';
import {
  EDITED_APP,
  EDITED_UTIL,
  FIRST_STASH,
  ORIGINAL,
  UNTRACKED_NAME,
  createDirtyStashRepo,
  createStashedRepo,
  fileExists,
  fileText,
  gitOut,
  porcelain,
  stashShas,
} from './helpers/stashFixtures';

/*
 * Test ids this file expects (new ones marked +). Existing: repo-view, commit-row, commit-message, ref-pill[data-name], wip-row, wip-details,
 * commit-summary, commit-description, commit-button, toast, toast-title, toast-detail, context-menu, menu-item, tool-undo, tool-redo,
 * tool-stash, tool-pop, sidebar-toggle-stashes, sidebar-count-stashes, sidebar-item[data-kind="stash"], branch-input, confirm-bar, confirm-cancel.
 *  + tool-undo / tool-redo carry the tooltip in their `title` attribute and are `disabled` when there is nothing to undo / redo.
 *    Tooltip texts: "Undo commit 'Fix login'", "Undo checkout 'feature/one'", "Undo create branch 'from-c2'", "Undo stash", "Undo pop stash",
 *    "Undo delete stash", and the same with Redo; "Cannot undo" / "Cannot redo" when empty.
 * Keys: Control+Z undoes, Control+Y redoes; both are ignored in input / textarea / .monaco-editor, while a context menu or confirm bar is open.
 * Toasts (title): "Undo Successful", "Redo Successful", "Undo Failed" (detail = the reason from the 409).
 * Routes: GET /api/repos/:id/undo-state -> {undo:{label}|null, redo:{label}|null}; POST .../undo and POST .../redo (no body; 409 + {error} on refusal).
 * Strings (en-us.json): UndoValidButtonTooltip, RedoValidButtonTooltip, UndoCannotButtonTooltip, RedoCannotButtonTooltip, UndoRedo-UndoSuccessful,
 *   UndoRedo-RedoSuccessful, UndoRedo-UndoFailed. The {0} labels are the spec's own wording (GitKraken builds them in code).
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

async function openGraph(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
/** Takes focus off any input so the key goes to the page. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}
async function ctrlZ(page: Page): Promise<void> {
  await blur(page);
  await page.keyboard.press('Control+z');
}
async function ctrlY(page: Page): Promise<void> {
  await blur(page);
  await page.keyboard.press('Control+y');
}
const undoTip = (page: Page, text: string) => expect(page.getByTestId('tool-undo')).toHaveAttribute('title', text);
const redoTip = (page: Page, text: string) => expect(page.getByTestId('tool-redo')).toHaveAttribute('title', text);
const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-name="${name}"]`);
const rowWithSubject = (page: Page, subject: string) =>
  page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: subject }) });
const menuItem = (page: Page, text: string) => page.getByTestId('context-menu').getByTestId('menu-item').filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) });
const sbStash = (page: Page, text: string) => page.locator('[data-testid="sidebar-item"][data-kind="stash"]').filter({ hasText: text });
async function expandStashes(page: Page): Promise<void> {
  const head = page.getByTestId('sidebar-toggle-stashes');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
}
async function openRepoApi(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.post('/api/repos/open', { headers, data: { path } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}
async function checkoutFeatureOne(page: Page): Promise<void> {
  await pill(page, 'feature/one').dblclick();
  await expect(page.getByTestId('toolbar-branch')).toContainText('feature/one');
  await undoTip(page, "Undo checkout 'feature/one'");
}

test.describe('commit', () => {
  test('Ctrl+Z undoes the commit (changes stay staged), Ctrl+Y redoes it; tooltips follow', async ({ page }) => {
    const repo = createStagingRepo(); // src/app.js staged
    await openGraph(page, repo);
    await expect(page.getByTestId('tool-undo')).toBeDisabled();
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', 'Cannot undo'); // UndoCannotButtonTooltip
    await expect(page.getByTestId('tool-redo')).toHaveAttribute('title', 'Cannot redo'); // RedoCannotButtonTooltip
    await page.getByTestId('wip-row').click();
    await page.getByTestId('commit-summary').fill('Fix login');
    await page.getByTestId('commit-button').click();
    await expect.poll(() => commitCount(repo)).toBe(3);
    await undoTip(page, "Undo commit 'Fix login'");
    await expect(page.getByTestId('tool-undo')).toBeEnabled();
    await expect(page.getByTestId('tool-redo')).toBeDisabled();

    await ctrlZ(page);
    await expect.poll(() => commitCount(repo)).toBe(2);
    expect(gitOut(repo, ['diff', '--cached', '--name-only']).trim()).toBe('src/app.js'); // soft reset: still staged (cachedNames lists every tracked file, so it cannot show this)
    expect(fileText(repo, 'src/app.js')).toBe('a1\na2 edited\na3\n');
    await expect(page.getByTestId('toast-title')).toHaveText('Undo Successful'); // UndoRedo-UndoSuccessful
    await redoTip(page, "Redo commit 'Fix login'");
    await undoTip(page, 'Cannot undo');

    await ctrlY(page);
    await expect.poll(() => commitCount(repo)).toBe(3);
    expect(headMessage(repo)).toBe('Fix login');
    await expect(page.getByTestId('toast-title')).toHaveText('Redo Successful'); // UndoRedo-RedoSuccessful
    await undoTip(page, "Undo commit 'Fix login'");
    await redoTip(page, 'Cannot redo');
  });

  test('the toolbar buttons do the same as the keys', async ({ page }) => {
    const repo = createStagingRepo();
    await openGraph(page, repo);
    await page.getByTestId('wip-row').click();
    await page.getByTestId('commit-summary').fill('Via buttons');
    await page.getByTestId('commit-button').click();
    await expect.poll(() => commitCount(repo)).toBe(3);
    await page.getByTestId('tool-undo').click();
    await expect.poll(() => commitCount(repo)).toBe(2);
    await page.getByTestId('tool-redo').click();
    await expect.poll(() => commitCount(repo)).toBe(3);
    expect(headMessage(repo)).toBe('Via buttons');
  });

  test('undo is refused when the branch moved on outside the app: "Undo Failed" with the reason, nothing changes', async ({ page }) => {
    const repo = createStagingRepo();
    await openGraph(page, repo);
    await page.getByTestId('wip-row').click();
    await page.getByTestId('commit-summary').fill('Will be outdated');
    await page.getByTestId('commit-button').click();
    await expect.poll(() => commitCount(repo)).toBe(3);
    await undoTip(page, "Undo commit 'Will be outdated'"); // the app is idle again (keys are ignored while it is busy)
    gitOut(repo, ['commit', '--allow-empty', '-m', 'Made outside the app']);
    const head = headSha(repo);
    await ctrlZ(page);
    await expect(page.getByTestId('toast-title')).toHaveText('Undo Failed'); // UndoRedo-UndoFailed
    await expect(page.getByTestId('toast-detail')).not.toBeEmpty();
    expect(headSha(repo)).toBe(head);
    expect(commitCount(repo)).toBe(4);
  });
});

test.describe('checkout and create branch', () => {
  test('checkout: Ctrl+Z goes back, Ctrl+Y checks out again', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await checkoutFeatureOne(page);
    await ctrlZ(page);
    await expect(page.getByTestId('toolbar-branch')).toContainText('main');
    expect(currentBranch(fx.repo)).toBe('main');
    expect(headSha(fx.repo)).toBe(fx.shas[4]);
    await redoTip(page, "Redo checkout 'feature/one'");
    await ctrlY(page);
    await expect(page.getByTestId('toolbar-branch')).toContainText('feature/one');
    expect(currentBranch(fx.repo)).toBe('feature/one');
  });

  test('checkout undo is refused on a dirty tree and the edit survives', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await checkoutFeatureOne(page);
    writeFileSync(`${fx.repo}/file.txt`, 'uncommitted edit\n');
    await ctrlZ(page);
    await expect(page.getByTestId('toast-title')).toHaveText('Undo Failed');
    expect(currentBranch(fx.repo)).toBe('feature/one');
    expect(fileText(fx.repo, 'file.txt')).toBe('uncommitted edit\n');
  });

  test('create branch here: Ctrl+Z switches back and removes the branch, Ctrl+Y recreates it', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    const row = rowWithSubject(page, SUBJECTS[1]);
    await row.getByTestId('commit-message').click({ button: 'right' });
    await menuItem(page, 'Create branch here').click();
    await row.getByTestId('branch-input').fill('from-c2');
    await row.getByTestId('branch-input').press('Enter');
    await expect(page.getByTestId('toolbar-branch')).toContainText('from-c2');
    await undoTip(page, "Undo create branch 'from-c2'");

    await ctrlZ(page);
    await expect(page.getByTestId('toolbar-branch')).toContainText('main');
    expect(localBranches(fx.repo)).not.toContain('from-c2');
    expect(currentBranch(fx.repo)).toBe('main');
    await redoTip(page, "Redo create branch 'from-c2'");

    await ctrlY(page);
    await expect.poll(() => localBranches(fx.repo)).toContain('from-c2');
    expect(gitOut(fx.repo, ['rev-parse', 'from-c2']).trim()).toBe(fx.shas[1]);
  });

  test('create branch undo is refused when the branch has new commits (they are never deleted)', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    const row = rowWithSubject(page, SUBJECTS[1]);
    await row.getByTestId('commit-message').click({ button: 'right' });
    await menuItem(page, 'Create branch here').click();
    await row.getByTestId('branch-input').fill('moves-on');
    await row.getByTestId('branch-input').press('Enter');
    await expect(page.getByTestId('toolbar-branch')).toContainText('moves-on');
    gitOut(fx.repo, ['commit', '--allow-empty', '-m', 'Work on moves-on']);
    const tip = headSha(fx.repo);
    await ctrlZ(page);
    await expect(page.getByTestId('toast-title')).toHaveText('Undo Failed');
    expect(localBranches(fx.repo)).toContain('moves-on');
    expect(gitOut(fx.repo, ['rev-parse', 'moves-on']).trim()).toBe(tip);
  });
});

test.describe('the "Cannot undo" state and key guards', () => {
  test('nothing recorded: both buttons disabled, Ctrl+Z / Ctrl+Y do nothing', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await expect(page.getByTestId('tool-undo')).toBeDisabled();
    await expect(page.getByTestId('tool-redo')).toBeDisabled();
    await ctrlZ(page);
    await ctrlY(page);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    expect(currentBranch(fx.repo)).toBe('main');
    expect(headSha(fx.repo)).toBe(fx.shas[4]);
  });

  test('Ctrl+Z inside the commit summary and description does nothing to the repo', async ({ page }) => {
    const fx = createBranchRepo();
    writeFileSync(`${fx.repo}/scratch.txt`, 'untracked so the WIP row shows\n');
    await openGraph(page, fx.repo);
    await checkoutFeatureOne(page);
    await page.getByTestId('wip-row').click();
    for (const id of ['commit-summary', 'commit-description']) {
      const box = page.getByTestId(id);
      await box.fill('typing here');
      await box.focus();
      await page.keyboard.press('Control+z');
      expect(currentBranch(fx.repo)).toBe('feature/one');
      await expect(page.getByTestId('toast')).toHaveCount(0);
      await page.keyboard.press('Control+y');
      expect(currentBranch(fx.repo)).toBe('feature/one');
    }
    await undoTip(page, "Undo checkout 'feature/one'"); // still recorded
    await ctrlZ(page); // proves the same gesture works once focus is on the page
    await expect.poll(() => currentBranch(fx.repo)).toBe('main');
  });

  test('Ctrl+Z while a context menu is open does nothing; works after it closes', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await checkoutFeatureOne(page);
    await pill(page, 'dup').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.keyboard.press('Control+z');
    expect(currentBranch(fx.repo)).toBe('feature/one');
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
    await ctrlZ(page);
    await expect.poll(() => currentBranch(fx.repo)).toBe('main');
  });

  test('Ctrl+Z while a confirm bar is open does nothing', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    await page.getByTestId('tool-pop').click(); // pops the newest stash: recorded
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    await undoTip(page, 'Undo pop stash');
    await expandStashes(page);
    await sbStash(page, FIRST_STASH).click({ button: 'right' });
    await menuItem(page, 'Delete Stash').click();
    await expect(page.getByTestId('confirm-bar')).toBeVisible();
    await blur(page);
    await page.keyboard.press('Control+z');
    expect(fileText(fx.repo, 'src/util.js')).toBe(EDITED_UTIL);
    expect(stashShas(fx.repo)).toEqual([fx.shas[0]]);
    await page.getByTestId('confirm-cancel').click();
    await ctrlZ(page);
    await expect.poll(() => fileText(fx.repo, 'src/util.js')).toBe(ORIGINAL.util);
  });

  test('a new action clears the redo list: Ctrl+Y afterwards does nothing', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await checkoutFeatureOne(page);
    await ctrlZ(page);
    await expect.poll(() => currentBranch(fx.repo)).toBe('main');
    await redoTip(page, "Redo checkout 'feature/one'");
    await pill(page, 'dup').dblclick();
    await expect(page.getByTestId('toolbar-branch')).toContainText('dup');
    await expect(page.getByTestId('tool-redo')).toBeDisabled();
    await redoTip(page, 'Cannot redo');
    await ctrlY(page);
    expect(currentBranch(fx.repo)).toBe('dup');
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
});

test.describe('stash actions', () => {
  test('stash: Ctrl+Z brings the changes back (untracked too), Ctrl+Y stashes again', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openGraph(page, repo);
    await page.getByTestId('tool-stash').click();
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    await undoTip(page, 'Undo stash');
    await ctrlZ(page);
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('0');
    expect(fileText(repo, 'src/app.js')).toBe(EDITED_APP);
    expect(fileExists(repo, UNTRACKED_NAME)).toBe(true);
    await redoTip(page, 'Redo stash');
    await ctrlY(page);
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    expect(porcelain(repo)).toBe('');
  });

  test('pop: Ctrl+Z stashes the result again, Ctrl+Y pops it again', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    await page.getByTestId('tool-pop').click();
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    await undoTip(page, 'Undo pop stash');
    await ctrlZ(page);
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('2');
    expect(porcelain(fx.repo)).toBe('');
    await redoTip(page, 'Redo pop stash');
    await ctrlY(page);
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    expect(fileText(fx.repo, 'src/util.js')).toBe(EDITED_UTIL);
  });

  test('delete stash: Ctrl+Z stores the same commit back as the newest stash', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    await expandStashes(page);
    await sbStash(page, FIRST_STASH).click({ button: 'right' });
    await menuItem(page, 'Delete Stash').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    await undoTip(page, 'Undo delete stash');
    await ctrlZ(page);
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('2');
    expect(stashShas(fx.repo)).toEqual([fx.shas[0], fx.shas[1]]);
    await redoTip(page, 'Redo delete stash');
    await ctrlY(page);
    await expect(page.getByTestId('sidebar-count-stashes')).toHaveText('1');
    expect(stashShas(fx.repo)).toEqual([fx.shas[1]]);
  });
});

test.describe('undo API', () => {
  test('state is per repo root; empty undo and redo are 409 with the Cannot texts', async ({ request }) => {
    const fx = createBranchRepo();
    const id = await openRepoApi(request, fx.repo);
    const state = await request.get(`/api/repos/${id}/undo-state`, { headers });
    expect(state.status()).toBe(200);
    expect(await state.json()).toEqual({ undo: null, redo: null });
    const u = await request.post(`/api/repos/${id}/undo`, { headers });
    expect(u.status()).toBe(409);
    expect(((await u.json()) as { error: string }).error).toBe('Cannot undo');
    const r = await request.post(`/api/repos/${id}/redo`, { headers });
    expect(r.status()).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('Cannot redo');

    // a recorded action shows up, and opening the same folder again sees the same journal (keyed by root)
    const made = await request.post(`/api/repos/${id}/branch`, { headers, data: { name: 'api-made', checkout: false } });
    expect(made.status()).toBe(200);
    const again = await openRepoApi(request, fx.repo);
    const s2 = await request.get(`/api/repos/${again}/undo-state`, { headers });
    expect(await s2.json()).toEqual({ undo: { label: "create branch 'api-made'" }, redo: null });

    // another repo has its own empty journal
    const other = createBranchRepo();
    const otherId = await openRepoApi(request, other.repo);
    expect(await (await request.get(`/api/repos/${otherId}/undo-state`, { headers })).json()).toEqual({ undo: null, redo: null });
    expect((await request.post(`/api/repos/${otherId}/undo`, { headers })).status()).toBe(409);
    expect(localBranches(other.repo)).not.toContain('api-made');

    // undo takes nothing from the client: a body naming another repo's data is ignored
    const ok = await request.post(`/api/repos/${id}/undo`, { headers, data: { branch: 'main', sha: other.shas[0], name: 'main' } });
    expect(ok.status()).toBe(200);
    expect(localBranches(fx.repo)).not.toContain('api-made');
    expect(localBranches(fx.repo)).toContain('main');
  });

  test('undo and redo answer 409 while a merge is unresolved, and nothing changes', async ({ request }) => {
    const merge = createMergeInProgress();
    const id = await openRepoApi(request, merge.repo);
    const before = gitOut(merge.repo, ['status', '--porcelain=v1']);
    expect((await request.post(`/api/repos/${id}/undo`, { headers })).status()).toBe(409);
    expect((await request.post(`/api/repos/${id}/redo`, { headers })).status()).toBe(409);
    expect(gitOut(merge.repo, ['status', '--porcelain=v1'])).toBe(before);
  });

  test('unknown repo id is 404', async ({ request }) => {
    expect((await request.get('/api/repos/nope/undo-state', { headers })).status()).toBe(404);
    expect((await request.post('/api/repos/nope/undo', { headers })).status()).toBe(404);
    expect((await request.post('/api/repos/nope/redo', { headers })).status()).toBe(404);
  });
});
