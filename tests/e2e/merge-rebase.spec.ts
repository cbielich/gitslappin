import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import {
  AUTHORS,
  CONFLICT_SUBJECT_B,
  FEATURE,
  HOSTILE_BRANCH,
  authorOf,
  cachedNames,
  createDetachedMenuRepo,
  createHostileBranchRepo,
  createMenuRepo,
  createMergeInProgress,
  createMergeRepo,
  createRebaseInProgress,
  createRebaseRepo,
  currentBranch,
  fileText,
  headMessageRaw,
  headSha,
  merging,
  parentCount,
  rebaseStep,
  rebasing,
  refSha,
  stashList,
  subjects,
  unmergedPaths,
  CLEAN_README,
} from './helpers/mergeFixtures';

/*
 * Test ids this file expects (new ones marked +). Existing: repo-view, commit-row, commit-message, ref-pill[data-name],
 * sidebar-item[data-kind][data-name], context-menu, menu-item, wip-row, commit-summary, commit-description, commit-button,
 * toast, tool-undo, tool-redo, tool-branch.
 *  + op-banner                          (amber graph row: "A file conflict was found ..." / "N file conflicts were found ...")
 *  + conflict-panel                     (right panel while a merge/rebase is in progress; shown after clicking op-banner)
 *  + conflict-title                     ("Merge conflicts detected" / "Rebase conflicts detected")
 *  + conflict-subtitle                  ("Merging X into Y" / "Rebasing X onto Y"), conflict-pill-head, conflict-pill-other
 *  + conflict-conflicted, conflict-resolved       (the two sections; text "Conflicted Files (n)" / "Resolved Files (n)")
 *  + conflict-file-row[data-path]       (inside either section), mark-resolved (hover button in a conflicted row, title "Mark resolved")
 *  + mark-all-resolved                  (button in the Conflicted section head; absent when there are no conflicts)
 *  + op-abort                           ("Abort Merge" / "Abort Rebase")
 *  + rebase-commit-label                ("Rebasing commit 2 out of 3")
 *  + skip-confirm, skip-confirm-ok ("Skip Commit"), skip-confirm-cancel ("Cancel")
 *  + tab-stash                          (the Stash tab of the commit box; must be absent during a rebase)
 *  commit-button is the main action: "No Changes to Merge" (disabled) -> "Commit and Merge", "Skip Commit" -> "Continue Rebase".
 *  commit-summary / commit-description hold the prefilled message (first line / rest) for both merge and rebase.
 * Strings (en-us.json): MergeConflictMessageSingular/Plural, RightPanel-Merge/RebaseConflictsDetected, ConflictsHeader-Merging/Rebasing,
 *   UncommittedFileList-Conflicted/UnconflictedFilesTitleSummary, MarkAllResolved, MarkAsResolved, DisabledMergeButtonLabel,
 *   CommitAndMergeButtonLabel, AbortMergeButtonLabel, SkipCommitButtonLabel, ContinueRebaseButtonLabel, AbortRebaseButtonLabel,
 *   Rebasing-CommitLabel, StashMessage-Merge/RebaseOnto, ContextMenu-MergeBranchIntoBranch/RebaseBranchOntoBranch/FastForward/
 *   RebaseBranchOntoThisCommit. The skip confirm sentence is the design's own wording (no GitKraken key).
 *   Placeholder order UNVERIFIED: Merge {0}=other {1}=current; Rebase {0}=current {1}=target; Fast-forward {0}=current {1}=target
 *   (inferred from ConflictsHeader-* and screens 12-14).
 */

const SKIP_CONFIRM_TEXT = 'This is a destructive operation, are you sure you want to skip this commit?';

async function openGraph(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}

async function openConflictPanel(page: Page, repo: string): Promise<void> {
  await openGraph(page, repo);
  await expect(page.getByTestId('op-banner')).toBeVisible();
  await page.getByTestId('op-banner').click();
  await expect(page.getByTestId('conflict-panel')).toBeVisible();
}

const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-name="${name}"]`);
const menuItem = (page: Page, text: string) => page.getByTestId('context-menu').getByTestId('menu-item').filter({ hasText: new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) });
const rowWithSubject = (page: Page, subject: string | RegExp) =>
  page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: subject }) });
const fileRow = (page: Page, section: 'conflicted' | 'resolved', path: string) =>
  page.getByTestId(`conflict-${section}`).locator(`[data-testid="conflict-file-row"][data-path="${path}"]`);
const btn = (page: Page) => page.getByTestId('commit-button');

async function menuLabels(page: Page): Promise<string[]> {
  return page.getByTestId('context-menu').getByTestId('menu-item').evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/[›>]/g, '').trim()));
}

test.describe('merge conflict screen', () => {
  test('graph banner, panel header, pills, sections and buttons (one conflict)', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openConflictPanel(page, fx.repo);
    await expect(page.getByTestId('op-banner')).toHaveText('A file conflict was found when attempting to merge into main');
    await expect(page.getByTestId('conflict-title')).toHaveText('Merge conflicts detected');
    await expect(page.getByTestId('conflict-subtitle')).toHaveText(/^Merging feature\/conflict into main\s*$/);
    await expect(page.getByTestId('conflict-pill-other')).toHaveText(FEATURE);
    await expect(page.getByTestId('conflict-pill-head')).toHaveText('main');
    await expect(page.getByTestId('conflict-conflicted')).toContainText('Conflicted Files (1)');
    await expect(page.getByTestId('conflict-resolved')).toContainText('Resolved Files (0)');
    await expect(fileRow(page, 'conflicted', 'src/config.js')).toBeVisible();
    await expect(page.getByTestId('mark-all-resolved')).toHaveText('Mark All Resolved');
    await expect(btn(page)).toHaveText('No Changes to Merge');
    await expect(btn(page)).toBeDisabled();
    await expect(page.getByTestId('op-abort')).toHaveText('Abort Merge');
    await expect(page.getByTestId('commit-summary')).toHaveValue("Merge branch 'feature/conflict'");
  });

  test('plural banner and counts with two conflicts and one auto-resolved file', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 2, added: true });
    await openConflictPanel(page, fx.repo);
    await expect(page.getByTestId('op-banner')).toHaveText('2 file conflicts were found when attempting to merge into main');
    await expect(page.getByTestId('conflict-conflicted')).toContainText('Conflicted Files (2)');
    await expect(page.getByTestId('conflict-resolved')).toContainText('Resolved Files (1)');
    await expect(fileRow(page, 'resolved', 'src/added.js')).toBeVisible();
    await expect(fileRow(page, 'conflicted', 'src/config.js')).toBeVisible();
    await expect(fileRow(page, 'conflicted', 'src/other.js')).toBeVisible();
  });

  test('Mark resolved moves one file and stages only that path; the button stays "No Changes to Merge"', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 2, added: true });
    await openConflictPanel(page, fx.repo);
    const row = fileRow(page, 'conflicted', 'src/config.js');
    await row.hover();
    await expect(row.getByTestId('mark-resolved')).toHaveAttribute('title', 'Mark resolved');
    await row.getByTestId('mark-resolved').click();
    await expect(page.getByTestId('conflict-conflicted')).toContainText('Conflicted Files (1)');
    await expect(page.getByTestId('conflict-resolved')).toContainText('Resolved Files (2)');
    await expect(fileRow(page, 'resolved', 'src/config.js')).toBeVisible();
    expect(unmergedPaths(fx.repo)).toEqual(['src/other.js']);
    await expect(btn(page)).toHaveText('No Changes to Merge');
    await expect(btn(page)).toBeDisabled();
  });

  test('Mark All Resolved stages only the conflicted paths, then the button becomes Commit and Merge', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 2, added: true, untracked: true });
    await openConflictPanel(page, fx.repo);
    await expect(btn(page)).toHaveText('No Changes to Merge');
    await page.getByTestId('mark-all-resolved').click();
    await expect(page.getByTestId('conflict-conflicted')).toContainText('Conflicted Files (0)');
    await expect(page.getByTestId('mark-all-resolved')).toHaveCount(0);
    await expect(btn(page)).toHaveText('Commit and Merge');
    await expect(btn(page)).toBeEnabled();
    expect(unmergedPaths(fx.repo)).toEqual([]);
    expect(cachedNames(fx.repo)).not.toContain('scratch.txt'); // never add -A
  });

  test('Commit and Merge makes the merge commit (two parents, no "#" lines) and leaves the conflict screen', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: true });
    await openConflictPanel(page, fx.repo);
    await page.getByTestId('mark-all-resolved').click();
    await expect(btn(page)).toHaveText('Commit and Merge');
    await btn(page).click();
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    await expect(page.getByTestId('op-banner')).toHaveCount(0);
    await expect(rowWithSubject(page, "Merge branch 'feature/conflict'")).toBeVisible();
    expect(merging(fx.repo)).toBe(false);
    expect(parentCount(fx.repo)).toBe(2);
    const msg = headMessageRaw(fx.repo);
    expect(msg.split('\n')[0]).toBe("Merge branch 'feature/conflict'");
    expect(msg.split('\n').some((l) => l.startsWith('#'))).toBe(false);
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('Abort Merge runs at once (no confirm) and restores the files and HEAD', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 2, added: true });
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await openConflictPanel(page, fx.repo);
    await page.getByTestId('op-abort').click();
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    await expect(page.getByTestId('op-banner')).toHaveCount(0);
    expect(dialogs).toEqual([]);
    expect(merging(fx.repo)).toBe(false);
    expect(headSha(fx.repo)).toBe(fx.mainSha);
    expect(fileText(fx.repo, 'src/config.js')).toBe(fx.configMain);
    expect(unmergedPaths(fx.repo)).toEqual([]);
    expect(currentBranch(fx.repo)).toBe('main');
  });

  test('during the operation only Undo and Redo are disabled in the toolbar', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openConflictPanel(page, fx.repo);
    await expect(page.getByTestId('tool-undo')).toBeDisabled();
    await expect(page.getByTestId('tool-redo')).toBeDisabled();
    await expect(page.getByTestId('tool-branch')).toBeEnabled(); // proves the toolbar is live, not all-disabled
  });
});

test.describe('starting a merge from the menu', () => {
  test('dirty tree: auto-stash node in the graph, conflict screen shown, edit parked in the stash', async ({ page }) => {
    const fx = createMergeRepo({ conflicts: 1, added: false, dirty: true });
    await openGraph(page, fx.repo);
    await pill(page, FEATURE).click({ button: 'right' });
    await menuItem(page, 'Merge feature/conflict into main').click();
    await expect(page.getByTestId('op-banner')).toBeVisible();
    await expect(rowWithSubject(page, 'Auto stash before merge of "main" and "feature/conflict"')).toBeVisible();
    expect(stashList(fx.repo).some((s) => s.endsWith('Auto stash before merge of "main" and "feature/conflict"'))).toBe(true);
    expect(fileText(fx.repo, 'README.md')).toBe(CLEAN_README);
    expect(merging(fx.repo)).toBe(true);
    await page.getByTestId('op-banner').click();
    await expect(page.getByTestId('conflict-title')).toHaveText('Merge conflicts detected');
    // Phase 6 review fix 2: a response that carries a stash gets a toast naming it (changed from "no toast").
    await expect(page.getByTestId('toast-detail')).toHaveText('Auto stash before merge of "main" and "feature/conflict"');
  });

  test('clean merge from the menu makes a merge commit and no stash', async ({ page }) => {
    const fx = createMenuRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'side').click({ button: 'right' });
    await menuItem(page, 'Merge side into main').click();
    await expect(rowWithSubject(page, "Merge branch 'side'")).toBeVisible();
    expect(parentCount(fx.repo)).toBe(2);
    expect(stashList(fx.repo)).toEqual([]);
    await expect(page.getByTestId('op-banner')).toHaveCount(0);
  });

  test('Fast-forward moves main to the branch tip', async ({ page }) => {
    const fx = createMenuRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'ahead').click({ button: 'right' });
    await menuItem(page, 'Fast-forward main to ahead').click();
    await expect.poll(() => headSha(fx.repo)).toBe(fx.aheadSha);
    expect(currentBranch(fx.repo)).toBe('main');
  });
});

test.describe('integrate menu items', () => {
  test('Merge and Rebase appear on a pill; Fast-forward only when HEAD is an ancestor of the branch', async ({ page }) => {
    const fx = createMenuRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'ahead').click({ button: 'right' });
    await expect(menuItem(page, 'Merge ahead into main')).toBeVisible();
    await expect(menuItem(page, 'Rebase main onto ahead')).toBeVisible();
    await expect(menuItem(page, 'Fast-forward main to ahead')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
    await pill(page, 'side').click({ button: 'right' });
    await expect(menuItem(page, 'Merge side into main')).toBeVisible();
    await expect(menuItem(page, 'Rebase main onto side')).toBeVisible();
    await expect(menuItem(page, 'Fast-forward main to side')).toHaveCount(0);
  });

  test('sidebar branch items and commit rows offer the same actions', async ({ page }) => {
    const fx = createMenuRepo();
    await openGraph(page, fx.repo);
    const head = page.getByTestId('sidebar-toggle-local');
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
    await page.locator('[data-testid="sidebar-item"][data-kind="local"][data-name="side"]').click({ button: 'right' });
    await expect(menuItem(page, 'Merge side into main')).toBeVisible();
    await page.keyboard.press('Escape');
    await rowWithSubject(page, 'Menu base').click({ button: 'right' });
    await expect(menuItem(page, 'Rebase main onto this commit')).toBeVisible();
  });

  test('hidden while a merge is in progress (the menu itself still opens)', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openGraph(page, fx.repo);
    await pill(page, FEATURE).click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    const labels = await menuLabels(page);
    expect(labels).toContain('Copy branch name'); // the menu rendered its other items
    expect(labels.filter((l) => /^(Merge|Rebase|Fast-forward) /.test(l))).toEqual([]);
  });

  test('hidden while HEAD is detached', async ({ page }) => {
    const fx = createDetachedMenuRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'ahead').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    const labels = await menuLabels(page);
    expect(labels).toContain('Copy branch name');
    expect(labels.filter((l) => /^(Merge|Rebase|Fast-forward) /.test(l))).toEqual([]);
  });

  test('a hostile branch name is shown as text everywhere and never runs', async ({ page }) => {
    const fx = createHostileBranchRepo();
    await openGraph(page, fx.repo);
    const hostile = page.getByTestId('ref-pill').filter({ hasText: HOSTILE_BRANCH });
    await expect(hostile).toHaveCount(1);
    await expect(hostile.locator('img')).toHaveCount(0);
    await hostile.click({ button: 'right' });
    await expect(menuItem(page, `Merge ${HOSTILE_BRANCH} into main`)).toBeVisible();
    await expect(page.getByTestId('context-menu').locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
    expect(refSha(fx.repo, 'main')).toBe(fx.mainSha);
  });
});

test.describe('rebase screens', () => {
  test('banner, header, pills, step label, prefilled message, Skip Commit and Abort Rebase', async ({ page }) => {
    const fx = createRebaseInProgress();
    await openConflictPanel(page, fx.repo);
    await expect(page.getByTestId('op-banner')).toHaveText('A file conflict was found when attempting to merge into HEAD');
    await expect(page.getByTestId('conflict-title')).toHaveText('Rebase conflicts detected');
    await expect(page.getByTestId('conflict-subtitle')).toHaveText(/^Rebasing main onto feature\/conflict\s*$/);
    await expect(page.getByTestId('conflict-pill-head')).toHaveText('main');
    await expect(page.getByTestId('conflict-pill-other')).toHaveText(FEATURE);
    await expect(page.getByTestId('conflict-conflicted')).toContainText('Conflicted Files (1)');
    await expect(page.getByTestId('conflict-resolved')).toContainText('Resolved Files (0)');
    await expect(page.getByTestId('rebase-commit-label')).toHaveText('Rebasing commit 2 out of 3');
    await expect(page.getByTestId('commit-summary')).toHaveValue(CONFLICT_SUBJECT_B);
    await expect(page.getByTestId('commit-description')).toHaveValue(/# Conflicts:/);
    await expect(btn(page)).toHaveText('Skip Commit');
    await expect(page.getByTestId('op-abort')).toHaveText('Abort Rebase');
    await expect(page.getByTestId('tab-stash')).toHaveCount(0);
    await expect(page.getByLabel('Amend previous commit')).toHaveCount(0);
    await expect(page.getByTestId('tool-undo')).toBeDisabled();
    await expect(page.getByTestId('tool-redo')).toBeDisabled();
    await expect(page.getByTestId('tool-branch')).toBeEnabled();
  });

  test('Skip shows a confirm bar first; Cancel keeps the rebase exactly where it was', async ({ page }) => {
    const fx = createRebaseInProgress();
    await openConflictPanel(page, fx.repo);
    await btn(page).click();
    await expect(page.getByTestId('skip-confirm')).toContainText(SKIP_CONFIRM_TEXT);
    await expect(page.getByTestId('skip-confirm-ok')).toHaveText('Skip Commit');
    await expect(page.getByTestId('skip-confirm-cancel')).toHaveText('Cancel');
    expect(rebasing(fx.repo)).toBe(true);
    expect(rebaseStep(fx.repo)).toBe(2); // nothing skipped before the confirm
    await page.getByTestId('skip-confirm-cancel').click();
    await expect(page.getByTestId('skip-confirm')).toHaveCount(0);
    expect(rebasing(fx.repo)).toBe(true);
    expect(rebaseStep(fx.repo)).toBe(2);
    await expect(btn(page)).toHaveText('Skip Commit');
    await expect(page.getByTestId('conflict-panel')).toBeVisible();
  });

  test('confirming Skip drops that commit and finishes the rest, keeping the other authors', async ({ page }) => {
    const fx = createRebaseInProgress();
    await openConflictPanel(page, fx.repo);
    await btn(page).click();
    await page.getByTestId('skip-confirm-ok').click();
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    await expect(page.getByTestId('op-banner')).toHaveCount(0);
    expect(rebasing(fx.repo)).toBe(false);
    expect(subjects(fx.repo)).not.toContain(CONFLICT_SUBJECT_B);
    expect(subjects(fx.repo).slice(0, 2)).toEqual(['Third change', 'First change']);
    expect(authorOf(fx.repo, 'Third change')).toBe(AUTHORS.third);
    expect(currentBranch(fx.repo)).toBe('main');
  });

  test('Mark resolved turns Skip Commit into Continue Rebase; Continue finishes and keeps the author', async ({ page }) => {
    const fx = createRebaseInProgress();
    await openConflictPanel(page, fx.repo);
    await page.getByTestId('mark-all-resolved').click();
    await expect(btn(page)).toHaveText('Continue Rebase');
    await expect(btn(page)).toBeEnabled();
    await btn(page).click();
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    expect(rebasing(fx.repo)).toBe(false);
    expect(subjects(fx.repo).slice(0, 3)).toEqual(['Third change', CONFLICT_SUBJECT_B, 'First change']);
    expect(authorOf(fx.repo, CONFLICT_SUBJECT_B)).toBe(AUTHORS.second);
    expect(currentBranch(fx.repo)).toBe('main');
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('Continue with an edited subject keeps the original author', async ({ page }) => {
    const fx = createRebaseInProgress();
    await openConflictPanel(page, fx.repo);
    await page.getByTestId('mark-all-resolved').click();
    await expect(btn(page)).toHaveText('Continue Rebase');
    await page.getByTestId('commit-summary').fill('Edited rebase subject');
    await btn(page).click();
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    expect(subjects(fx.repo)).toContain('Edited rebase subject');
    expect(subjects(fx.repo)).not.toContain(CONFLICT_SUBJECT_B);
    expect(authorOf(fx.repo, 'Edited rebase subject')).toBe(AUTHORS.second);
  });

  test('Abort Rebase runs at once (no confirm) and restores the branch', async ({ page }) => {
    const fx = createRebaseInProgress();
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await openConflictPanel(page, fx.repo);
    await page.getByTestId('op-abort').click();
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    await expect(page.getByTestId('skip-confirm')).toHaveCount(0);
    expect(dialogs).toEqual([]);
    expect(rebasing(fx.repo)).toBe(false);
    expect(headSha(fx.repo)).toBe(fx.original);
    expect(currentBranch(fx.repo)).toBe('main');
    expect(existsSync(join(fx.repo, '.git', 'rebase-merge'))).toBe(false);
  });

  test('rebase from the menu with a dirty tree: auto-stash node, rebase screen, edit parked in the stash', async ({ page }) => {
    const fx = createRebaseRepo({ dirty: true });
    await openGraph(page, fx.repo);
    await pill(page, FEATURE).click({ button: 'right' });
    await menuItem(page, 'Rebase main onto feature/conflict').click();
    await expect(page.getByTestId('op-banner')).toBeVisible();
    await expect(rowWithSubject(page, 'Auto stash before rebase of "main" onto "feature/conflict"')).toBeVisible();
    expect(stashList(fx.repo).some((s) => s.endsWith('Auto stash before rebase of "main" onto "feature/conflict"'))).toBe(true);
    expect(fileText(fx.repo, 'README.md')).toBe(CLEAN_README);
    expect(rebasing(fx.repo)).toBe(true);
    await page.getByTestId('op-banner').click();
    await expect(page.getByTestId('rebase-commit-label')).toHaveText('Rebasing commit 2 out of 3');
  });
});
