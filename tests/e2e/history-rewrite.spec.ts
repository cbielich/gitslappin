import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { TEST_TOKEN } from './helpers/repo';
import { assertRemotesSafe, commitFile, createRemoteFx, git as remoteGit, originRef } from './helpers/remoteFixtures';
import {
  authorOfSubject,
  createPickRepo,
  createRewriteConflictRepo,
  createRewriteRepo,
  createRewriteRepoWithBranch,
  gitOut,
  headSha,
  messageOf,
  rebaseInProgress,
  subjectsOf,
  trackedFiles,
  treeOf,
} from './helpers/rewriteFixtures';

/*
 * V4 History rewriting (build-notes "V4 design" + "V3 + V4 audit fixes"). Test ids this file expects (new ones marked +):
 * Existing: repo-view, commit-row[data-sha][data-selected="true"|"false"], commit-message, ref-pill[data-name], context-menu, menu-item, tool-undo (title),
 *   tool-push, toast, toast-title, confirm-bar[data-kind], confirm-ok, confirm-cancel, op-banner, conflict-panel, conflict-title, mark-all-resolved,
 *   commit-button, details-message (the message box of the commit details), commit-details[data-sha].
 * Selection (+ behaviour, no new id): plain click selects one row; Shift+click selects the range of loaded rows from the anchor; Ctrl+click toggles;
 *   a right click on a row that is already selected keeps the multi selection and opens the menu for it. Selected rows have data-selected="true".
 * Reword (screen 39), shown inside the commit details when the message box is clicked (single commit on HEAD's line, HEAD attached, no operation running):
 *   + reword-editor, reword-summary (input), reword-description (textarea), reword-counter,
 *   + reword-update ("Update Message", AmendOrRewordPreviousCommitMessageButtonLabel; disabled while the summary is empty),
 *   + reword-cancel ("Cancel Amend" for the HEAD commit = CancelAmendPreviousCommitMessageButtonLabel, "Cancel Reword" for another = CancelReword...),
 *   + reword-helper (RewordCommitMessageHelperText, {0} = commits that get rebuilt: "Rewording this commit message will cause 2 commits to be rebased.")
 *   Only the ancestor case shows reword-helper; the HEAD commit has none.
 * Interactive Rebase panel (replaces the graph area; docs-images interactive-rebase--*):
 *   + rebase-panel, rebase-title ("Interactive Rebase"), rebase-onto ("Rebasing main onto <short sha or branch>")
 *   + rebase-row[data-sha][data-action="pick|reword|squash|drop"][data-selected] newest first; inside: rebase-action (a <select>), rebase-message
 *   + rebase-reset ("Reset"), rebase-cancel ("Cancel Rebase"), rebase-start ("Start Rebase")
 *   + rebase-reword-popover with rebase-reword-title ("Reword commit message"), rebase-reword-input, rebase-reword-cancel ("Cancel"), rebase-reword-update ("Update Message")
 *   Keys with a row selected (click it; the focus is not in an input): p / r / s / d set the action (r opens the popover), Control+ArrowUp / Control+ArrowDown move the row.
 *   Any drop shows the existing confirm bar: data-kind="rebase-drop", text "Are you sure you want to drop 1 commit?" / "... drop 2 commits?", confirm-ok "Drop commits".
 * Menus (labels from en-us.json; ids of the items are not asserted here): "Edit commit message" (HEAD), "Reword commit", "Drop commit", "Drop N commits",
 *   "Squash N commits", "Move N commits up|down", "Cherry pick N commits", "Interactive Rebase N children of <sha>" (rows), "Interactive Rebase main onto <branch>" (pills).
 *   Hidden while HEAD is detached or an operation is in progress.
 * Strings: AmendOrRewordPreviousCommitMessageButtonLabel, Cancel{Amend,Reword}PreviousCommitMessageButtonLabel, RewordCommitMessageHelperText, RewordInputTitle,
 *   ContextMenu-*, PendingInteractiveRebasePanel-*, PromptForRebase-ConfirmDropCommit(s), DropCommitsButtonLabel, PromptForPush-ConfirmForcePush ("Force Push").
 * Undo tooltips: "Undo reword '<subject>'", "Undo squash 3 commits", "Undo rebase 'main'", "Undo cherry pick 2 commits".
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

async function openGraph(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
const row = (page: Page, subject: string) => page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: new RegExp(`^\\s*${subject}\\s*$`) }) });
const menuItem = (page: Page, text: string | RegExp) =>
  page.getByTestId('context-menu').getByTestId('menu-item').filter({ hasText: typeof text === 'string' ? new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) : text });
const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-name="${name}"]`);
const rrow = (page: Page, subject: string) => page.getByTestId('rebase-row').filter({ has: page.getByTestId('rebase-message').filter({ hasText: new RegExp(`^\\s*${subject}\\s*$`) }) });
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}
async function rebaseOrder(page: Page): Promise<string[]> {
  return page.getByTestId('rebase-message').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
}
async function openInteractive(page: Page, onSubject: string): Promise<void> {
  await row(page, onSubject).click({ button: 'right' });
  await menuItem(page, /^Interactive Rebase \d+ children of [0-9a-f]{7,}$/).click();
  await expect(page.getByTestId('rebase-panel')).toBeVisible();
}
async function menuLabels(page: Page): Promise<string[]> {
  return page.getByTestId('context-menu').getByTestId('menu-item').evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/[›>]/g, '').trim()));
}

test.describe('Update Message (reword)', () => {
  test('HEAD: click the message, edit, Update Message; Ctrl+Z puts the old commit back', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'four').click();
    await page.getByTestId('details-message').click();
    await expect(page.getByTestId('reword-editor')).toBeVisible();
    await expect(page.getByTestId('reword-summary')).toHaveValue('four');
    await expect(page.getByTestId('reword-counter')).toBeVisible();
    await expect(page.getByTestId('reword-update')).toHaveText('Update Message');
    await expect(page.getByTestId('reword-cancel')).toHaveText('Cancel Amend');
    await expect(page.getByTestId('reword-helper')).toHaveCount(0);
    await page.getByTestId('reword-summary').fill('four edited');
    await page.getByTestId('reword-description').fill('a body line');
    await page.getByTestId('reword-update').click();
    await expect(row(page, 'four edited')).toBeVisible();
    expect(messageOf(fx.repo)).toBe('four edited\n\na body line');
    expect(treeOf(fx.repo)).toBe(treeOf(fx.repo, fx.four));
    expect(authorOfSubject(fx.repo, 'four edited')).toBe('Fourth Author');
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', /^Undo reword '.+'$/);
    await blur(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => headSha(fx.repo)).toBe(fx.four);
    await expect(row(page, 'four')).toBeVisible();
  });

  test('Update Message stays disabled until the text changes (an unchanged message is never rewritten)', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'four').click();
    await page.getByTestId('details-message').click();
    await expect(page.getByTestId('reword-editor')).toBeVisible();
    await expect(page.getByTestId('reword-update')).toBeDisabled();
    await page.getByTestId('reword-summary').fill('four!');
    await expect(page.getByTestId('reword-update')).toBeEnabled();
    await page.getByTestId('reword-summary').fill('four');
    await expect(page.getByTestId('reword-update')).toBeDisabled();
    expect(headSha(fx.repo)).toBe(fx.four);
  });

  test('Ctrl+Z does nothing while the Interactive Rebase panel is open', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'four').click();
    await page.getByTestId('details-message').click();
    await page.getByTestId('reword-summary').fill('four edited');
    await page.getByTestId('reword-update').click();
    await expect(row(page, 'four edited')).toBeVisible();
    const edited = headSha(fx.repo);
    await openInteractive(page, 'one');
    await blur(page);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(700);
    expect(headSha(fx.repo)).toBe(edited);
    await expect(page.getByTestId('rebase-panel')).toBeVisible();
  });

  test('an older commit: Cancel Reword and the helper text with the number of rebuilt commits; descendants keep their trees and authors', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'two').click();
    await page.getByTestId('details-message').click();
    await expect(page.getByTestId('reword-cancel')).toHaveText('Cancel Reword');
    await expect(page.getByTestId('reword-helper')).toHaveText('Rewording this commit message will cause 2 commits to be rebased.');
    await page.getByTestId('reword-summary').fill('two edited');
    await page.getByTestId('reword-update').click();
    await expect(row(page, 'two edited')).toBeVisible();
    expect(subjectsOf(fx.repo)).toEqual(['four', 'three', 'two edited', 'one', 'Base']);
    expect(treeOf(fx.repo)).toBe(treeOf(fx.repo, fx.four));
    expect(authorOfSubject(fx.repo, 'three')).toBe('Third Author');
    expect(authorOfSubject(fx.repo, 'four')).toBe('Fourth Author');
  });

  test('Cancel closes the editor and changes nothing; an empty summary cannot be saved', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'three').click();
    await page.getByTestId('details-message').click();
    await page.getByTestId('reword-summary').fill('');
    await expect(page.getByTestId('reword-update')).toBeDisabled();
    await page.getByTestId('reword-summary').fill('never saved');
    await page.getByTestId('reword-cancel').click();
    await expect(page.getByTestId('reword-editor')).toHaveCount(0);
    expect(headSha(fx.repo)).toBe(fx.four);
    expect(subjectsOf(fx.repo)).toEqual(['four', 'three', 'two', 'one', 'Base']);
  });

  test('a dirty worktree and staged changes are untouched by a reword', async ({ page }) => {
    const fx = createRewriteRepo();
    writeFileSync(join(fx.repo, 'b.txt'), 'b staged\n');
    gitOut(fx.repo, ['add', 'b.txt']);
    writeFileSync(join(fx.repo, 'a.txt'), 'a unstaged\n');
    await openGraph(page, fx.repo);
    await row(page, 'three').click();
    await page.getByTestId('details-message').click();
    await page.getByTestId('reword-summary').fill('three edited');
    await page.getByTestId('reword-update').click();
    await expect(row(page, 'three edited')).toBeVisible();
    expect(gitOut(fx.repo, ['diff', '--cached', '--name-only']).trim()).toBe('b.txt');
    expect(gitOut(fx.repo, ['diff', '--name-only']).trim()).toBe('a.txt');
  });

  test('the editor is not offered when HEAD is detached', async ({ page }) => {
    const fx = createRewriteRepo();
    gitOut(fx.repo, ['switch', '--detach']);
    await openGraph(page, fx.repo);
    await row(page, 'three').click();
    await page.getByTestId('details-message').click();
    await expect(page.getByTestId('reword-editor')).toHaveCount(0);
  });
});

test.describe('multi select and Squash', () => {
  test('Shift+click selects the range, the menu offers Squash 3 commits; Squash joins the messages; Ctrl+Z undoes it', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'three').click();
    await row(page, 'one').click({ modifiers: ['Shift'] });
    for (const s of ['one', 'two', 'three']) await expect(row(page, s)).toHaveAttribute('data-selected', 'true');
    await expect(row(page, 'four')).toHaveAttribute('data-selected', 'false');
    await row(page, 'two').click({ button: 'right' });
    await menuItem(page, 'Squash 3 commits').click();
    await expect.poll(() => subjectsOf(fx.repo)).toEqual(['four', 'one', 'Base']);
    expect(messageOf(fx.repo, 'HEAD~1')).toBe('one\n\ntwo\n\nthree');
    expect(treeOf(fx.repo, 'HEAD~1')).toBe(treeOf(fx.repo, fx.three));
    expect(treeOf(fx.repo)).toBe(treeOf(fx.repo, fx.four));
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', 'Undo squash 3 commits');
    await blur(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => headSha(fx.repo)).toBe(fx.four);
    await expect(row(page, 'two')).toBeVisible();
  });

  test('Ctrl+click toggles: three separate commits (a gap) get no Squash item; adding the gap row back does', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'one').click();
    await row(page, 'three').click({ modifiers: ['Control'] });
    await row(page, 'three').click({ button: 'right' });
    expect(await menuLabels(page)).not.toContain('Squash 2 commits');
    await page.keyboard.press('Escape');
    await row(page, 'two').click({ modifiers: ['Control'] });
    await row(page, 'two').click({ button: 'right' });
    await expect(menuItem(page, 'Squash 3 commits')).toBeVisible();
    expect(headSha(fx.repo)).toBe(fx.four);
  });

  test('a plain click after a multi selection goes back to one row', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'three').click();
    await row(page, 'one').click({ modifiers: ['Shift'] });
    await row(page, 'four').click();
    await expect(row(page, 'four')).toHaveAttribute('data-selected', 'true');
    for (const s of ['one', 'two', 'three']) await expect(row(page, s)).toHaveAttribute('data-selected', 'false');
    expect(headSha(fx.repo)).toBe(fx.four);
  });

  test('no rewrite items while HEAD is detached', async ({ page }) => {
    const fx = createRewriteRepo();
    gitOut(fx.repo, ['switch', '--detach']);
    await openGraph(page, fx.repo);
    await row(page, 'three').click();
    await row(page, 'one').click({ modifiers: ['Shift'] });
    await row(page, 'two').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    const l = await menuLabels(page);
    expect(l.some((t) => /^(Squash|Drop|Move|Reword|Edit commit message|Interactive Rebase)/.test(t))).toBe(false);
  });
});

test.describe('Interactive Rebase panel', () => {
  test('the menu on an older commit opens the panel: header, rows newest first with Pick, three buttons', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'one').click({ button: 'right' });
    await expect(menuItem(page, /^Interactive Rebase 3 children of [0-9a-f]{7,}$/)).toBeVisible();
    await menuItem(page, /^Interactive Rebase 3 children of [0-9a-f]{7,}$/).click();
    await expect(page.getByTestId('rebase-title')).toHaveText('Interactive Rebase');
    await expect(page.getByTestId('rebase-onto')).toContainText('Rebasing main onto');
    expect(await rebaseOrder(page)).toEqual(['four', 'three', 'two']);
    for (const s of ['four', 'three', 'two']) await expect(rrow(page, s)).toHaveAttribute('data-action', 'pick');
    await expect(page.getByTestId('rebase-reset')).toHaveText('Reset');
    await expect(page.getByTestId('rebase-cancel')).toHaveText('Cancel Rebase');
    await expect(page.getByTestId('rebase-start')).toHaveText('Start Rebase');
    expect(headSha(fx.repo)).toBe(fx.four);
  });

  test('keys: d drops, s squashes, p picks, Control+ArrowUp / Down move the row; Reset restores the default', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await openInteractive(page, 'one');
    await rrow(page, 'three').click();
    await blur(page);
    await page.keyboard.press('d');
    await expect(rrow(page, 'three')).toHaveAttribute('data-action', 'drop');
    await page.keyboard.press('s');
    await expect(rrow(page, 'three')).toHaveAttribute('data-action', 'squash');
    await page.keyboard.press('p');
    await expect(rrow(page, 'three')).toHaveAttribute('data-action', 'pick');
    await page.keyboard.press('Control+ArrowUp');
    expect(await rebaseOrder(page)).toEqual(['three', 'four', 'two']);
    await page.keyboard.press('Control+ArrowDown');
    await page.keyboard.press('Control+ArrowDown');
    expect(await rebaseOrder(page)).toEqual(['four', 'two', 'three']);
    await page.keyboard.press('d');
    await page.getByTestId('rebase-reset').click();
    expect(await rebaseOrder(page)).toEqual(['four', 'three', 'two']);
    for (const s of ['four', 'three', 'two']) await expect(rrow(page, s)).toHaveAttribute('data-action', 'pick');
    expect(headSha(fx.repo)).toBe(fx.four); // nothing runs until Start Rebase
  });

  test('the action select does the same as the keys', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await openInteractive(page, 'one');
    await rrow(page, 'three').getByTestId('rebase-action').selectOption('squash');
    await expect(rrow(page, 'three')).toHaveAttribute('data-action', 'squash');
    // the oldest row cannot be a squash: the option is disabled
    await expect(rrow(page, 'two').getByTestId('rebase-action').locator('option[value=squash]')).toBeDisabled();
    await rrow(page, 'two').getByTestId('rebase-action').selectOption('drop');
    await expect(rrow(page, 'two')).toHaveAttribute('data-action', 'drop');
    // nothing kept below 'three' any more, so it falls back to a pick
    await expect(rrow(page, 'three')).toHaveAttribute('data-action', 'pick');
    expect(headSha(fx.repo)).toBe(fx.four);
  });

  test('Cancel Rebase closes the panel and changes nothing', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await openInteractive(page, 'one');
    await rrow(page, 'two').getByTestId('rebase-action').selectOption('drop');
    await page.getByTestId('rebase-cancel').click();
    await expect(page.getByTestId('rebase-panel')).toHaveCount(0);
    await expect(page.getByTestId('commit-row').first()).toBeVisible();
    expect(headSha(fx.repo)).toBe(fx.four);
    expect(subjectsOf(fx.repo)).toEqual(['four', 'three', 'two', 'one', 'Base']);
  });

  test('r opens the reword popover; Update Message sets the new message and Start Rebase applies reword + move + squash', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await openInteractive(page, 'one'); // rows newest first: four, three, two
    await rrow(page, 'four').click();
    await blur(page);
    await page.keyboard.press('r');
    await expect(page.getByTestId('rebase-reword-popover')).toBeVisible();
    await expect(page.getByTestId('rebase-reword-title')).toHaveText('Reword commit message');
    await expect(page.getByTestId('rebase-reword-update')).toHaveText('Update Message');
    await page.getByTestId('rebase-reword-input').fill('four reworded');
    await page.getByTestId('rebase-reword-update').click();
    await expect(page.getByTestId('rebase-reword-popover')).toHaveCount(0);
    await expect(rrow(page, 'four reworded')).toHaveAttribute('data-action', 'reword');
    await rrow(page, 'two').click();
    await blur(page);
    await page.keyboard.press('s'); // squash `two` into the commit below it in the todo (`one`, which is not in the plan): two is the OLDEST row -> refused by the panel
    // the oldest row can never be a squash (the design); the panel keeps it as pick
    await expect(rrow(page, 'two')).not.toHaveAttribute('data-action', 'squash');
    await rrow(page, 'three').click();
    await blur(page);
    await page.keyboard.press('s'); // three squashes into two (the row below it in the panel)
    await expect(rrow(page, 'three')).toHaveAttribute('data-action', 'squash');
    await page.getByTestId('rebase-start').click();
    await expect(page.getByTestId('rebase-panel')).toHaveCount(0);
    await expect.poll(() => subjectsOf(fx.repo)).toEqual(['four reworded', 'two', 'one', 'Base']);
    expect(messageOf(fx.repo, 'HEAD~1')).toBe('two\n\nthree');
    expect(trackedFiles(fx.repo)).toEqual(['a.txt', 'b.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
    expect(authorOfSubject(fx.repo, 'four reworded')).toBe('Fourth Author');
    expect(rebaseInProgress(fx.repo)).toBe(false);
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', "Undo rebase 'main'");
  });

  test('any Drop asks first: the confirm bar says how many, Cancel keeps the panel and changes nothing, "Drop commits" runs it', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await openInteractive(page, 'one');
    await rrow(page, 'three').getByTestId('rebase-action').selectOption('drop');
    await page.getByTestId('rebase-start').click();
    const bar = page.locator('[data-testid="confirm-bar"][data-kind="rebase-drop"]');
    await expect(bar).toContainText('Are you sure you want to drop 1 commit?');
    await expect(page.getByTestId('confirm-ok')).toHaveText('Drop commits');
    await page.getByTestId('confirm-cancel').click();
    await expect(bar).toHaveCount(0);
    await expect(page.getByTestId('rebase-panel')).toBeVisible();
    expect(headSha(fx.repo)).toBe(fx.four);
    await rrow(page, 'two').getByTestId('rebase-action').selectOption('drop');
    await page.getByTestId('rebase-start').click();
    await expect(bar).toContainText('Are you sure you want to drop 2 commits?');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('rebase-panel')).toHaveCount(0);
    await expect.poll(() => subjectsOf(fx.repo)).toEqual(['four', 'one', 'Base']);
    expect(trackedFiles(fx.repo)).toEqual(['a.txt', 'b.txt', 'f1.txt', 'f4.txt']);
  });

  test('the branch pill menu opens the panel with every commit above the branch', async ({ page }) => {
    const fx = createRewriteRepoWithBranch();
    await openGraph(page, fx.repo);
    await pill(page, 'base-branch').click({ button: 'right' });
    await menuItem(page, 'Interactive Rebase main onto base-branch').click();
    await expect(page.getByTestId('rebase-panel')).toBeVisible();
    expect(await rebaseOrder(page)).toEqual(['four', 'three', 'two', 'one']);
    expect(headSha(fx.repo)).toBe(fx.four);
  });

  test('the Interactive Rebase items are hidden while HEAD is detached', async ({ page }) => {
    const fx = createRewriteRepoWithBranch();
    gitOut(fx.repo, ['switch', '--detach']);
    await openGraph(page, fx.repo);
    await row(page, 'one').click({ button: 'right' });
    expect((await menuLabels(page)).some((t) => /^Interactive Rebase/.test(t))).toBe(false);
    await page.keyboard.press('Escape');
    await pill(page, 'base-branch').click({ button: 'right' });
    expect((await menuLabels(page)).some((t) => /^Interactive Rebase/.test(t))).toBe(false);
  });
});

test.describe('Drop and Move presets from the graph menu', () => {
  test('Drop commit on one row asks, then removes only that commit', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'two').click({ button: 'right' });
    await menuItem(page, 'Drop commit').click();
    await expect(page.locator('[data-testid="confirm-bar"][data-kind="rebase-drop"]')).toContainText('Are you sure you want to drop 1 commit?');
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => subjectsOf(fx.repo)).toEqual(['four', 'three', 'one', 'Base']);
    expect(trackedFiles(fx.repo)).not.toContain('f2.txt');
    expect(authorOfSubject(fx.repo, 'three')).toBe('Third Author');
  });

  test('Drop 2 commits on a selected pair', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'three').click();
    await row(page, 'two').click({ modifiers: ['Shift'] });
    await row(page, 'two').click({ button: 'right' });
    await menuItem(page, 'Drop 2 commits').click();
    await expect(page.locator('[data-testid="confirm-bar"][data-kind="rebase-drop"]')).toContainText('Are you sure you want to drop 2 commits?');
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => subjectsOf(fx.repo)).toEqual(['four', 'one', 'Base']);
  });

  test('Move 2 commits down swaps them below the commit under them; Move up on the newest pair is not offered', async ({ page }) => {
    const fx = createRewriteRepo();
    await openGraph(page, fx.repo);
    await row(page, 'four').click();
    await row(page, 'three').click({ modifiers: ['Shift'] });
    await row(page, 'four').click({ button: 'right' });
    const l = await menuLabels(page);
    expect(l).not.toContain('Move 2 commits up'); // the newest commit cannot go up
    await menuItem(page, 'Move 2 commits down').click();
    await expect.poll(() => subjectsOf(fx.repo)).toEqual(['two', 'four', 'three', 'one', 'Base']);
    expect(treeOf(fx.repo)).toBe(treeOf(fx.repo, fx.four));
  });
});

test.describe('a conflict while rewriting', () => {
  test('dropping a commit that the next one depends on: conflict panel, resolve, Continue Rebase, history rewritten, Undo restores', async ({ page }) => {
    const fx = createRewriteConflictRepo();
    await openGraph(page, fx.repo);
    await openInteractive(page, 'one');
    await rrow(page, 'two').getByTestId('rebase-action').selectOption('drop');
    await page.getByTestId('rebase-start').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('op-banner')).toBeVisible();
    expect(rebaseInProgress(fx.repo)).toBe(true);
    await page.getByTestId('op-banner').click();
    await expect(page.getByTestId('conflict-panel')).toBeVisible();
    await expect(page.getByTestId('conflict-title')).toHaveText('Rebase conflicts detected');
    await expect(page.getByTestId('tool-undo')).toBeDisabled(); // nothing is journaled while the rebase is stopped
    writeFileSync(join(fx.repo, 's.txt'), 'resolved\n');
    await page.getByTestId('mark-all-resolved').click();
    await expect(page.getByTestId('commit-button')).toHaveText('Continue Rebase');
    await page.getByTestId('commit-button').click();
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    await expect(page.getByTestId('op-banner')).toHaveCount(0);
    expect(rebaseInProgress(fx.repo)).toBe(false);
    expect(subjectsOf(fx.repo)).toEqual(['four', 'three', 'one', 'Base']);
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', "Undo rebase 'main'");
    await blur(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => headSha(fx.repo)).toBe(fx.four);
  });

  test('Abort Rebase after the conflict: HEAD is back and Undo has nothing to undo', async ({ page }) => {
    const fx = createRewriteConflictRepo();
    await openGraph(page, fx.repo);
    await openInteractive(page, 'one');
    await rrow(page, 'two').getByTestId('rebase-action').selectOption('drop');
    await page.getByTestId('rebase-start').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('op-banner')).toBeVisible();
    await page.getByTestId('op-banner').click();
    await page.getByTestId('op-abort').click();
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    expect(headSha(fx.repo)).toBe(fx.four);
    expect(rebaseInProgress(fx.repo)).toBe(false);
    await expect(page.getByTestId('tool-undo')).toBeDisabled();
  });

  test('while a rebase is stopped the rewrite items are hidden from the graph menu', async ({ page, request }) => {
    const fx = createRewriteConflictRepo();
    const opened = await request.post('/api/repos/open', { headers, data: { path: fx.repo } });
    const id = ((await opened.json()) as { id: string }).id;
    const started = await request.post(`/api/repos/${id}/rebase/interactive`, {
      headers,
      data: {
        upstream: fx.base,
        onto: fx.base,
        expectHead: fx.four,
        steps: [
          { sha: fx.one, action: 'pick' },
          { sha: fx.two, action: 'drop' },
          { sha: fx.three, action: 'pick' },
          { sha: fx.four, action: 'pick' },
        ],
      },
    });
    expect(started.status()).toBe(200);
    expect(rebaseInProgress(fx.repo)).toBe(true);
    await openGraph(page, fx.repo);
    await row(page, 'one').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    expect((await menuLabels(page)).some((t) => /^(Squash|Drop|Move|Reword|Edit commit message|Interactive Rebase|Cherry pick \d)/.test(t))).toBe(false);
  });
});

test.describe('multi cherry pick', () => {
  test('select two commits on another branch, Cherry pick 2 commits: both land on main with their authors; Undo removes them', async ({ page }) => {
    const fx = createPickRepo();
    await openGraph(page, fx.repo);
    await row(page, 'feat two').click();
    await row(page, 'feat one').click({ modifiers: ['Shift'] });
    await row(page, 'feat one').click({ button: 'right' });
    await menuItem(page, 'Cherry pick 2 commits').click();
    await expect.poll(() => subjectsOf(fx.repo)).toEqual(['feat two', 'feat one', 'main one', 'Base']);
    expect(authorOfSubject(fx.repo, 'feat one')).toBe('First Author');
    expect(authorOfSubject(fx.repo, 'feat two')).toBe('Second Author');
    expect(trackedFiles(fx.repo)).toEqual(['a.txt', 'f1.txt', 'f2.txt', 'm.txt']);
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', 'Undo cherry pick 2 commits');
    await blur(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => headSha(fx.repo)).toBe(fx.m1);
    expect(trackedFiles(fx.repo)).toEqual(['a.txt', 'm.txt']);
  });

  test('not offered when HEAD is detached', async ({ page }) => {
    const fx = createPickRepo();
    gitOut(fx.repo, ['switch', '--detach']);
    await openGraph(page, fx.repo);
    await row(page, 'feat two').click();
    await row(page, 'feat one').click({ modifiers: ['Shift'] });
    await row(page, 'feat one').click({ button: 'right' });
    expect((await menuLabels(page)).some((t) => /^Cherry pick \d/.test(t))).toBe(false);
  });
});

test.describe('squash, then push', () => {
  test('after Squash the push is rejected, the behind bar offers Force Push, and it lands on origin (bare repo in mkdtemp)', async ({ page }) => {
    const fx = createRemoteFx();
    commitFile(fx.a, { 'p1.txt': '1\n' }, 'push one');
    commitFile(fx.a, { 'p2.txt': '2\n' }, 'push two');
    commitFile(fx.a, { 'p3.txt': '3\n' }, 'push three');
    remoteGit(fx.a, ['push']);
    const pushedTip = headSha(fx.a);
    expect(originRef(fx, 'refs/heads/main')).toBe(pushedTip);
    assertRemotesSafe(fx.a);
    await openGraph(page, fx.a);
    await row(page, 'push three').click();
    await row(page, 'push one').click({ modifiers: ['Shift'] });
    await row(page, 'push two').click({ button: 'right' });
    await menuItem(page, 'Squash 3 commits').click();
    await expect.poll(() => subjectsOf(fx.a)).toEqual(['push one', 'Remote base 2', 'Remote base 1']);
    const squashedTip = headSha(fx.a);
    expect(squashedTip).not.toBe(pushedTip);
    // a plain push is a non-fast-forward now; there is no warning before it (design decision), only the existing rejected-push flow
    await page.getByTestId('tool-push').click();
    const bar = page.locator('[data-testid="confirm-bar"][data-kind="force-push"]');
    await expect(bar).toBeVisible();
    expect(originRef(fx, 'refs/heads/main')).toBe(pushedTip); // nothing was pushed yet, and no automatic force
    await expect(page.getByTestId('confirm-ok')).toHaveText('Force Push');
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => originRef(fx, 'refs/heads/main')).toBe(squashedTip);
  });
});
