import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import {
  DISCARD,
  DISCARD_EDITED,
  DISCARD_ORIGINAL,
  PICK,
  PICK_DIRTY,
  RESET_SUBJECTS,
  assertRemotesSafe,
  configGet,
  createBranchDeleteRepo,
  createDiscardRepo,
  createHunkRepo,
  createPickRepo,
  createRejectedPushFx,
  createRemoteBranchFx,
  createResetRepo,
  currentBranch,
  exists,
  fileText,
  git,
  hasRef,
  headSha,
  lastAuthor,
  lastSubject,
  marker,
  objectType,
  originAdvance,
  originRef,
  originSnapshot,
  pinCount,
  readText,
  refSha,
  repoState,
  stashList,
  subjects,
  tagMessage,
  tagNames,
} from './helpers/destructiveFixtures';
import { createMergeInProgress } from './helpers/mergeFixtures';
import { TEST_TOKEN } from './helpers/repo';

/*
 * Test ids this file expects (new ones marked +). Existing: repo-view, commit-row, commit-message, ref-pill[data-name], context-menu,
 * menu-item, context-submenu, toast, toast-title, toast-detail, wip-row, wip-details, wip-unstaged, wip-staged, wip-file-row[data-path],
 * diff-view, hunk-header, hunk-action, tool-undo, tool-push, op-banner, conflict-panel, conflict-title, op-abort, mark-all-resolved,
 * commit-button, commit-summary.
 *  + confirm-bar[data-kind]   the 09a bar. data-kind = discard-file | discard-files | discard-all | delete-branch | delete-branch-force
 *                             (the second bar after git refused -d) | delete-branch-remote | force-push | reset-hard
 *                             (reset-hard added by the phase 11 builder: shown when the tree is dirty or a file is in the way; soft/mixed have no bar)
 *    confirm-message          text only; confirm-detail (only on delete-branch-force: git's stderr, text only, truncated);
 *    confirm-ok               the red action button (text = the *ButtonLabel key); confirm-cancel ("Cancel")
 *  + discard-all              the trash button of the Unstaged section head (title "Discard all changes")
 *  + hunk-discard             one per UNSTAGED hunk header, absent in a staged diff (title "Discard Hunk"); no confirm bar
 *  + rename-prompt (container), rename-message ("Rename 'x' to:"), rename-input (placeholder "new branch name"), rename-error
 *  + tag-prompt (container), tag-input (placeholder "enter tag name"), tag-input-error, tag-annotation (textarea, annotated only,
 *    placeholder "Annotation message"), tag-annotation-label ("Message:"), tag-submit (annotated: click; plain tag: Enter in tag-input)
 *  Right-click menus: wip-file-row -> item "Discard changes" (File-Reset); ctrl+click on wip-file-row selects several, and the same
 *  menu then discards the selection. Branch pill menu: "Rename <b>", "Delete <b>", "Delete <b> and <remote branch>". Commit-row menu:
 *  "Cherry pick commit", "Revert commit" (both absent on a merge commit), "Create tag here", "Create annotated tag here",
 *  "Reset <b> to this commit" with a submenu "Soft - keep all changes" / "Mixed - keep working copy but reset index" /
 *  "Hard - discard all changes". Ctrl+Z / Ctrl+Y are the undo/redo keys (tool-undo title = "Undo <label>").
 * Server routes under /api/repos/:id: POST discard {paths}, discard-hunk {path,hunk,header}, reset {sha,mode}, branch/rename {name,newName},
 *   branch/delete {name,expectSha,force?,remote?}, push/force {branch,expect}, tag {name,sha,message?}.
 *   Cherry-pick / revert route names are not fixed by the design: they are only exercised through the UI here.
 *   Refused input is asserted as 4xx (not 5xx) plus "nothing changed"; a stale hunk header and blocked states are asserted as 409.
 * Strings (en-us.json): ConfirmationMessage-ResetFile/-ResetFiles/-ResetAll/-DeleteRef/-DeleteAllRefs, ResetFileButtonLabel,
 *   ResetFilesButtonLabel, ResetAllButtonLabel, DeleteButtonLabel, CancelButtonLabel, PromptForPush-ConfirmForcePush / -RemoteChanged,
 *   ForcePushWithLeaseButtonLabel, Error-PushFailed, Notification-PushedSuccessfully, DiscardAllChanges, File-Reset, DiscardThisHunk,
 *   PromptForNewBranchName-Message/-Placeholder/-InvalidBranchName, Error-RenameFailed, RefZone-EnterTagName,
 *   PromptForCreateTagName-InvalidTagName, PromptForTagAnnotation-Message/-Placeholder, Error-CreateRefFailed,
 *   ContextMenu-CherrypickCommit/-RevertCommit/-CreateTagHere/-CreateAnnotatedTag/-ResetBranchToThisCommit/-ResetSoft|Mixed|HardWithHint/
 *   -RenameBranch/-DeleteBranch/-DeleteLocalAndRemoteBranches, Notification-CherrypickSuccessful/-RevertSuccessful,
 *   NotificationMessage-CherrypickWasNoop/-RevertWasNoop.
 * UNVERIFIED (inferred, flagged): "Cherry-pick conflicts detected", "Abort Cherry-pick" and the Revert equivalents (spec 5.5, as the design says);
 *   ConfirmationMessage-DeleteAllRefs {0} = the local branch name; the noop toast uses the Successful title plus the WasNoop text as detail;
 *   (superseded by the "Reset confirm" decision: only mixed takes no bar); tags show as ref-pill[data-name]; the commit button
 *   during a cherry-pick conflict is `commit-button` (its label is not asserted); {0} of PromptForPush-RemoteChanged is not asserted.
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

const T = {
  resetFile: (p: string) => `This will discard all staged and unstaged changes to "${p}". Are you sure you want to discard all changes to the file?`,
  resetFiles: 'This will discard all staged and unstaged changes to the selected files. Are you sure you want to discard all selected changes?',
  resetAll: 'This will discard all staged and unstaged changes, including new untracked files. Are you sure you want to discard all changes?',
  deleteRef: (n: string) => `This is a destructive operation, are you sure you want to delete "${n}"?`,
  deleteAllRefs: (n: string) => `This is a destructive operation, are you sure you want to delete "${n}" at this node, including remotes?`,
  forcePush: 'Force push is a destructive action and cannot be undone. Are you sure?',
  remoteChanged: /has changed on the remote since the last fetch\./,
  invalidBranch: 'The given branch name is not valid',
  invalidTag: 'The given tag name is not valid',
  renameMessage: (n: string) => `Rename '${n}' to:`,
  cherryOk: 'Cherry pick Successful',
  revertOk: 'Revert Successful',
  cherryNoop: 'However, the current branch already has all changes from the cherry picked commit.',
  revertNoop: 'However, the current branch already has all changes from the reverted commit.',
  pushed: 'Pushed Successfully',
  pushFailed: 'Push Failed',
  renameFailed: 'Rename Failed',
  createRefFailed: 'Failed creating ref',
} as const;

async function openGraph(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
async function openWip(page: Page, repo: string): Promise<void> {
  await openGraph(page, repo);
  await page.getByTestId('wip-row').click();
  await expect(page.getByTestId('wip-details')).toBeVisible();
}
async function openRepoApi(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.post('/api/repos/open', { headers, data: { path } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}
const post = (request: APIRequestContext, id: string, route: string, data: unknown) =>
  request.post(`/api/repos/${id}/${route}`, { headers, data: data as object });

const bar = (page: Page, kind?: string) => (kind ? page.locator(`[data-testid="confirm-bar"][data-kind="${kind}"]`) : page.getByTestId('confirm-bar'));
const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-name="${name}"]`);
const wipRow = (page: Page, section: 'unstaged' | 'staged', path: string) =>
  page.getByTestId(`wip-${section}`).locator(`[data-testid="wip-file-row"][data-path="${path}"]`);
const rowWithSubject = (page: Page, subject: string | RegExp) =>
  page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: subject }) });
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const menuItem = (page: Page, text: string | RegExp) =>
  page.getByTestId('context-menu').getByTestId('menu-item').filter({ hasText: typeof text === 'string' ? new RegExp(`^\\s*${esc(text)}\\s*$`) : text });
const subItem = (page: Page, text: string | RegExp) =>
  page.getByTestId('context-submenu').getByTestId('menu-item').filter({ hasText: typeof text === 'string' ? new RegExp(`^\\s*${esc(text)}\\s*$`) : text });
async function menuLabels(page: Page): Promise<string[]> {
  return page.getByTestId('context-menu').getByTestId('menu-item').evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/[›>]/g, '').trim()));
}
// Ctrl+Z is ignored while the app is busy (by design), so wait until Undo is offered and nothing is running.
const undoKey = async (page: Page): Promise<void> => {
  await expect(page.getByTestId('tool-undo')).toBeEnabled();
  await expect(page.getByTestId('toolbar-busy')).toHaveCount(0);
  await page.keyboard.press('Control+z');
};
const toastTitle = (page: Page) => page.getByTestId('toast-title');

/** Right-click a commit row and pick a menu item. */
async function commitMenu(page: Page, subject: string | RegExp, item: string | RegExp): Promise<void> {
  await rowWithSubject(page, subject).first().click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await menuItem(page, item).click();
}
async function pillMenu(page: Page, branch: string, item: string | RegExp): Promise<void> {
  await pill(page, branch).first().click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await menuItem(page, item).click();
}
async function fileMenuDiscard(page: Page, section: 'unstaged' | 'staged', path: string): Promise<void> {
  await wipRow(page, section, path).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await menuItem(page, 'Discard changes').click();
}

// ---------------------------------------------------------------------------------------------------------------------
test.describe('discard: confirm bars', () => {
  test('one file (right-click "Discard changes"): bar text and buttons, Cancel changes nothing, OK discards only that file and is undoable with Ctrl+Z', async ({ page }) => {
    const repo = createDiscardRepo();
    await openWip(page, repo);
    const before = repoState(repo);

    await fileMenuDiscard(page, 'unstaged', DISCARD.a);
    await expect(bar(page, 'discard-file')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText(T.resetFile(DISCARD.a));
    await expect(page.getByTestId('confirm-ok')).toHaveText('Reset File');
    await expect(page.getByTestId('confirm-cancel')).toHaveText('Cancel');
    await page.getByTestId('confirm-cancel').click();
    await expect(bar(page)).toHaveCount(0);
    expect(repoState(repo)).toEqual(before);
    expect(pinCount(repo)).toBe(0);

    await fileMenuDiscard(page, 'unstaged', DISCARD.a);
    await page.getByTestId('confirm-ok').click();
    await expect(bar(page)).toHaveCount(0);
    await expect(wipRow(page, 'unstaged', DISCARD.a)).toHaveCount(0);
    expect(readText(repo, DISCARD.a)).toBe(DISCARD_ORIGINAL.a);
    expect(readText(repo, DISCARD.c)).toBe(DISCARD_EDITED.c); // the other edits are untouched
    expect(readText(repo, DISCARD.untracked)).toBe(DISCARD_EDITED.untracked);
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe(DISCARD.b);
    await expect(page.getByTestId('tool-undo')).toBeEnabled();
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', 'Undo discard changes');

    await undoKey(page);
    await expect(wipRow(page, 'unstaged', DISCARD.a)).toBeVisible();
    expect(repoState(repo)).toEqual(before);
  });

  test('a staged file: "Reset File" discards the staged AND the unstaged state', async ({ page }) => {
    const repo = createDiscardRepo();
    await openWip(page, repo);
    await fileMenuDiscard(page, 'staged', DISCARD.b);
    await expect(page.getByTestId('confirm-message')).toHaveText(T.resetFile(DISCARD.b));
    await page.getByTestId('confirm-ok').click();
    await expect(wipRow(page, 'staged', DISCARD.b)).toHaveCount(0);
    expect(readText(repo, DISCARD.b)).toBe(DISCARD_ORIGINAL.b);
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  test('an untracked file: OK removes only that file (ignored file stays), Ctrl+Z brings the exact bytes back', async ({ page }) => {
    const repo = createDiscardRepo();
    await openWip(page, repo);
    const before = repoState(repo);
    await fileMenuDiscard(page, 'unstaged', DISCARD.untracked);
    await expect(bar(page, 'discard-file')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(wipRow(page, 'unstaged', DISCARD.untracked)).toHaveCount(0);
    expect(exists(repo, DISCARD.untracked)).toBe(false);
    expect(readText(repo, DISCARD.ignored)).toBe('ignored bytes\n');
    expect(readText(repo, DISCARD.a)).toBe(DISCARD_EDITED.a);
    await undoKey(page);
    await expect(wipRow(page, 'unstaged', DISCARD.untracked)).toBeVisible();
    expect(repoState(repo)).toEqual(before);
  });

  test('several files (ctrl+click, then the menu): "Reset Files" bar, Cancel changes nothing, OK discards exactly the selection', async ({ page }) => {
    const repo = createDiscardRepo();
    await openWip(page, repo);
    const before = repoState(repo);
    await wipRow(page, 'unstaged', DISCARD.a).click();
    await wipRow(page, 'unstaged', DISCARD.c).click({ modifiers: ['Control'] });
    await wipRow(page, 'unstaged', DISCARD.c).click({ button: 'right' });
    await menuItem(page, 'Discard changes').click();
    await expect(bar(page, 'discard-files')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText(T.resetFiles);
    await expect(page.getByTestId('confirm-ok')).toHaveText('Reset Files');
    await page.getByTestId('confirm-cancel').click();
    await expect(bar(page)).toHaveCount(0);
    expect(repoState(repo)).toEqual(before);

    await wipRow(page, 'unstaged', DISCARD.a).click();
    await wipRow(page, 'unstaged', DISCARD.c).click({ modifiers: ['Control'] });
    await wipRow(page, 'unstaged', DISCARD.c).click({ button: 'right' });
    await menuItem(page, 'Discard changes').click();
    await page.getByTestId('confirm-ok').click();
    await expect(bar(page)).toHaveCount(0);
    expect(readText(repo, DISCARD.a)).toBe(DISCARD_ORIGINAL.a);
    expect(readText(repo, DISCARD.c)).toBe(DISCARD_ORIGINAL.c);
    expect(readText(repo, DISCARD.b)).toBe(DISCARD_EDITED.b); // not selected
    expect(readText(repo, DISCARD.untracked)).toBe(DISCARD_EDITED.untracked);
  });

  test('discard all (trash button): "Reset All" bar, Cancel changes nothing, OK clears the tree but never touches ignored files, Ctrl+Z restores everything', async ({ page }) => {
    const repo = createDiscardRepo();
    await openWip(page, repo);
    const before = repoState(repo);
    await expect(page.getByTestId('discard-all')).toHaveAttribute('title', 'Discard all changes');
    await page.getByTestId('discard-all').click();
    await expect(bar(page, 'discard-all')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText(T.resetAll);
    await expect(page.getByTestId('confirm-ok')).toHaveText('Reset All');
    await page.getByTestId('confirm-cancel').click();
    await expect(bar(page)).toHaveCount(0);
    expect(repoState(repo)).toEqual(before);

    await page.getByTestId('discard-all').click();
    await page.getByTestId('confirm-ok').click();
    await expect(bar(page)).toHaveCount(0);
    // A clean tree has no WIP row and the open WIP panel closes with it (phase 4), so the row is what goes, not a "0" count.
    await expect(page.getByTestId('wip-row')).toHaveCount(0);
    expect(git(repo, ['status', '--porcelain=v1', '-uall']).trim()).toBe('');
    expect(readText(repo, DISCARD.ignored)).toBe('ignored bytes\n');
    await undoKey(page);
    await expect(page.getByTestId('wip-row')).toBeVisible();
    await page.getByTestId('wip-row').click();
    await expect(page.getByTestId('wip-unstaged-count')).toHaveText('3');
    expect(repoState(repo)).toEqual(before);
  });

  test('Ctrl+Z is ignored while a confirm bar is open', async ({ page }) => {
    const repo = createDiscardRepo();
    await openWip(page, repo);
    await fileMenuDiscard(page, 'unstaged', DISCARD.a);
    await page.getByTestId('confirm-ok').click();
    await expect(wipRow(page, 'unstaged', DISCARD.a)).toHaveCount(0);
    await page.getByTestId('discard-all').click();
    await expect(bar(page, 'discard-all')).toBeVisible();
    await undoKey(page);
    await expect(bar(page, 'discard-all')).toBeVisible();
    expect(readText(repo, DISCARD.a)).toBe(DISCARD_ORIGINAL.a); // the earlier discard was NOT undone
    await page.getByTestId('confirm-cancel').click();
    await undoKey(page); // with the bar closed it works
    await expect(wipRow(page, 'unstaged', DISCARD.a)).toBeVisible();
    expect(readText(repo, DISCARD.a)).toBe(DISCARD_EDITED.a);
  });
});

test.describe('discard hunk', () => {
  test('the hunk Discard has no confirm bar: it reverts one hunk, keeps the other, and Ctrl+Z restores it', async ({ page }) => {
    const repo = createHunkRepo();
    await openWip(page, repo);
    await wipRow(page, 'unstaged', 'hunks.txt').click();
    await expect(page.getByTestId('diff-view')).toBeVisible();
    await expect(page.getByTestId('hunk-header')).toHaveCount(2);
    await expect(page.getByTestId('hunk-discard')).toHaveCount(2);
    await expect(page.getByTestId('hunk-discard').first()).toHaveAttribute('title', 'Discard Hunk');
    const before = repoState(repo);

    await page.getByTestId('hunk-discard').first().click();
    await expect.poll(() => fileText(repo, 'hunks.txt')).not.toContain('line 2 CHANGED');
    expect(fileText(repo, 'hunks.txt')).toContain('line 28 CHANGED');
    await expect(bar(page)).toHaveCount(0);
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', 'Undo discard changes');

    await undoKey(page);
    await expect.poll(() => fileText(repo, 'hunks.txt')).toContain('line 2 CHANGED');
    expect(repoState(repo)).toEqual(before);
  });

  test('a staged diff has no Discard Hunk (unstaged side only)', async ({ page }) => {
    const repo = createHunkRepo();
    git(repo, ['add', 'hunks.txt']);
    await openWip(page, repo);
    await wipRow(page, 'staged', 'hunks.txt').click();
    await expect(page.getByTestId('diff-view')).toBeVisible();
    await expect(page.getByTestId('hunk-header').first()).toBeVisible();
    await expect(page.getByTestId('hunk-discard')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('reset from the commit menu', () => {
  async function pickReset(page: Page, hint: RegExp): Promise<void> {
    await rowWithSubject(page, RESET_SUBJECTS[1]).first().click({ button: 'right' });
    await menuItem(page, 'Reset main to this commit').click();
    await expect(page.getByTestId('context-submenu')).toBeVisible();
    await subItem(page, hint).click();
  }

  test('submenu wording; soft reset: no confirm bar, HEAD moves, changes stay staged, Ctrl+Z moves HEAD back', async ({ page }) => {
    const { repo, shas } = createResetRepo();
    await openGraph(page, repo);
    await rowWithSubject(page, RESET_SUBJECTS[1]).first().click({ button: 'right' });
    await menuItem(page, 'Reset main to this commit').click();
    await expect.poll(async () => (await page.getByTestId('context-submenu').getByTestId('menu-item').allTextContents()).map((t) => t.trim())).toEqual([
      'Soft - keep all changes',
      'Mixed - keep working copy but reset index',
      'Hard - discard all changes',
    ]);
    await subItem(page, /^Soft/).click();
    await expect.poll(() => headSha(repo)).toBe(shas[1]);
    await expect(bar(page)).toHaveCount(0);
    expect(fileText(repo, 'a.txt')).toBe('a3\n');
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('a.txt');
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', "Undo reset 'main'");
    await undoKey(page);
    await expect.poll(() => headSha(repo)).toBe(shas[2]);
  });

  test('mixed reset on a dirty index pins a snapshot; Ctrl+Z restores index and worktree', async ({ page }) => {
    const { repo, shas } = createResetRepo({ dirty: true });
    await openGraph(page, repo);
    const before = repoState(repo);
    await pickReset(page, /^Mixed/);
    await expect.poll(() => headSha(repo)).toBe(shas[1]);
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(fileText(repo, 'a.txt')).toBe('a staged edit\nplus an unstaged line\n');
    expect(pinCount(repo)).toBeGreaterThan(0);
    await undoKey(page);
    await expect.poll(() => headSha(repo)).toBe(shas[2]);
    // HEAD moves first; the snapshot (index + bytes) is put back right after, so wait for the whole state.
    await expect.poll(() => repoState(repo)).toEqual(before);
  });

  // Phase 11 decision ("Reset confirm"): a hard reset asks first whenever the tree is dirty or an untracked/ignored file is in the way.
  const T_RESET_HARD = 'This is a destructive operation, are you sure you want to reset "main" to this commit? Uncommitted changes will be lost.';

  test('hard reset on a dirty tree: the bar (reset-hard) asks first, Cancel changes nothing, OK resets, snapshot pinned, Ctrl+Z restores index and bytes', async ({ page }) => {
    const { repo, shas } = createResetRepo({ dirty: true });
    await openGraph(page, repo);
    const before = repoState(repo);
    await pickReset(page, /^Hard/);
    await expect(bar(page, 'reset-hard')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText(T_RESET_HARD);
    await expect(page.getByTestId('confirm-ok')).toHaveText('Reset');
    await expect(page.getByTestId('confirm-cancel')).toHaveText('Cancel');
    await page.getByTestId('confirm-cancel').click();
    await expect(bar(page)).toHaveCount(0);
    expect(repoState(repo)).toEqual(before);
    expect(pinCount(repo)).toBe(0);

    await pickReset(page, /^Hard/);
    await expect(bar(page, 'reset-hard')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(bar(page)).toHaveCount(0);
    await expect.poll(() => headSha(repo)).toBe(shas[1]);
    expect(fileText(repo, 'a.txt')).toBe('a2\n');
    expect(pinCount(repo)).toBeGreaterThan(0);
    await undoKey(page);
    await expect.poll(() => headSha(repo)).toBe(shas[2]);
    // HEAD moves first; the snapshot (index + bytes) is put back right after, so wait for the whole state.
    await expect.poll(() => repoState(repo)).toEqual(before);
  });

  test('hard reset on a clean tree: no confirm bar, HEAD moves at once, nothing is pinned, Ctrl+Z moves it back', async ({ page }) => {
    const { repo, shas } = createResetRepo();
    await openGraph(page, repo);
    await pickReset(page, /^Hard/);
    await expect.poll(() => headSha(repo)).toBe(shas[1]);
    await expect(bar(page)).toHaveCount(0);
    expect(pinCount(repo)).toBe(0);
    await undoKey(page);
    await expect.poll(() => headSha(repo)).toBe(shas[2]);
  });

  test('mixed reset never shows a bar (even on a dirty index)', async ({ page }) => {
    const { repo, shas } = createResetRepo({ dirty: true });
    await openGraph(page, repo);
    await pickReset(page, /^Mixed/);
    await expect.poll(() => headSha(repo)).toBe(shas[1]);
    await expect(bar(page)).toHaveCount(0);
  });

  test('hard reset on an otherwise clean tree still asks when an untracked file is in the way of the target (collision counts as dirty); OK pins its bytes and Ctrl+Z brings them back', async ({ page }) => {
    const { repo, shas } = createResetRepo();
    git(repo, ['rm', '-q', '--', 'b.txt']);
    git(repo, ['commit', '-m', 'Remove b']); // b.txt is tracked by Reset two (the target) and no longer by HEAD
    const head4 = headSha(repo);
    writeFileSync(join(repo, 'b.txt'), 'my precious untracked bytes\n');
    await openGraph(page, repo);
    const before = repoState(repo);
    await pickReset(page, /^Hard/);
    await expect(bar(page, 'reset-hard')).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
    expect(repoState(repo)).toEqual(before);
    expect(pinCount(repo)).toBe(0);
    await pickReset(page, /^Hard/);
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => headSha(repo)).toBe(shas[1]);
    expect(fileText(repo, 'b.txt')).toBe('b1\n');
    expect(pinCount(repo)).toBeGreaterThan(0);
    await undoKey(page);
    await expect.poll(() => headSha(repo)).toBe(head4);
    // HEAD moves first; the pinned bytes are written back right after, so wait for the whole state.
    await expect.poll(() => repoState(repo)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('rename branch (inline, no confirm, not undoable)', () => {
  test('prompt text, invalid name keeps the prompt open, valid name renames, Escape cancels', async ({ page }) => {
    const fx = createBranchDeleteRepo();
    await openGraph(page, fx.repo);
    await pillMenu(page, 'wip', 'Rename wip');
    await expect(page.getByTestId('rename-message')).toHaveText(T.renameMessage('wip'));
    await expect(page.getByTestId('rename-input')).toHaveAttribute('placeholder', 'new branch name');
    await page.getByTestId('rename-input').fill('bad name');
    await page.getByTestId('rename-input').press('Enter');
    await expect(page.getByTestId('rename-error')).toHaveText(T.invalidBranch);
    expect(hasRef(fx.repo, 'refs/heads/wip')).toBe(true);
    await page.getByTestId('rename-input').press('Escape');
    await expect(page.getByTestId('rename-prompt')).toHaveCount(0);
    expect(hasRef(fx.repo, 'refs/heads/wip')).toBe(true);

    await pillMenu(page, 'wip', 'Rename wip');
    await page.getByTestId('rename-input').fill('renamed/wip');
    await page.getByTestId('rename-input').press('Enter');
    await expect(page.getByTestId('rename-prompt')).toHaveCount(0);
    await expect(pill(page, 'renamed/wip')).toBeVisible();
    expect(hasRef(fx.repo, 'refs/heads/wip')).toBe(false);
    expect(refSha(fx.repo, 'refs/heads/renamed/wip')).toBe(fx.wipSha);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await expect(page.getByTestId('tool-undo')).toBeDisabled(); // not journaled
  });

  test('renaming onto an existing branch fails with "Rename Failed" and never overwrites it', async ({ page }) => {
    const fx = createBranchDeleteRepo();
    await openGraph(page, fx.repo);
    await pillMenu(page, 'wip', 'Rename wip');
    await page.getByTestId('rename-input').fill('done');
    await page.getByTestId('rename-input').press('Enter');
    await expect(toastTitle(page)).toHaveText(T.renameFailed);
    expect(refSha(fx.repo, 'refs/heads/wip')).toBe(fx.wipSha);
    expect(refSha(fx.repo, 'refs/heads/done')).toBe(fx.doneSha);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('delete branch', () => {
  test('unmerged: first bar (DeleteRef), Cancel changes nothing; OK -> git refuses -d -> second bar shows git\'s words; Cancel keeps it; OK deletes (-D); Ctrl+Z recreates it', async ({ page }) => {
    const fx = createBranchDeleteRepo();
    await openGraph(page, fx.repo);
    const before = repoState(fx.repo);

    await pillMenu(page, 'wip', 'Delete wip');
    await expect(bar(page, 'delete-branch')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText(T.deleteRef('wip'));
    await expect(page.getByTestId('confirm-ok')).toHaveText('Delete');
    await expect(page.getByTestId('confirm-cancel')).toHaveText('Cancel');
    await page.getByTestId('confirm-cancel').click();
    await expect(bar(page)).toHaveCount(0);
    expect(repoState(fx.repo)).toEqual(before);

    await pillMenu(page, 'wip', 'Delete wip');
    await page.getByTestId('confirm-ok').click();
    await expect(bar(page, 'delete-branch-force')).toBeVisible();
    await expect(page.getByTestId('confirm-detail')).toContainText(/not fully merged/);
    await expect(page.getByTestId('confirm-ok')).toHaveText('Delete');
    expect(hasRef(fx.repo, 'refs/heads/wip')).toBe(true); // the first OK did not delete anything
    await page.getByTestId('confirm-cancel').click();
    await expect(bar(page)).toHaveCount(0);
    expect(repoState(fx.repo)).toEqual(before);

    await pillMenu(page, 'wip', 'Delete wip');
    await page.getByTestId('confirm-ok').click();
    await expect(bar(page, 'delete-branch-force')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(bar(page)).toHaveCount(0);
    await expect(pill(page, 'wip')).toHaveCount(0);
    expect(hasRef(fx.repo, 'refs/heads/wip')).toBe(false);
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', "Undo delete branch 'wip'");

    await undoKey(page);
    await expect(pill(page, 'wip')).toBeVisible();
    expect(refSha(fx.repo, 'refs/heads/wip')).toBe(fx.wipSha);
  });

  test('merged: one bar only, then the branch is gone', async ({ page }) => {
    const fx = createBranchDeleteRepo();
    await openGraph(page, fx.repo);
    // `done` sits on the same commit as the checked-out `main`, so it is not the row's first pill: it is in the "+1" menu (phase 5 design).
    await rowWithSubject(page, 'Branch base two').first().getByTestId('ref-more').click({ button: 'right' });
    await menuItem(page, 'done').hover();
    await subItem(page, 'Delete done').click();
    await expect(page.getByTestId('confirm-message')).toHaveText(T.deleteRef('done'));
    await page.getByTestId('confirm-ok').click();
    await expect(bar(page)).toHaveCount(0);
    expect(hasRef(fx.repo, 'refs/heads/done')).toBe(false);
    expect(refSha(fx.repo, 'refs/heads/wip')).toBe(fx.wipSha);
  });

  test('"Delete <b> and <remote branch>": its own bar naming the branch; Cancel changes nothing, OK deletes local and remote, Ctrl+Z restores both', async ({ page }) => {
    const fx = createRemoteBranchFx();
    assertRemotesSafe(fx.a);
    await openGraph(page, fx.a);
    const before = repoState(fx.a);
    const originBefore = originSnapshot(fx);

    await pillMenu(page, 'feature', /^Delete feature and /);
    await expect(bar(page, 'delete-branch-remote')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText(T.deleteAllRefs('feature'));
    await page.getByTestId('confirm-cancel').click();
    await expect(bar(page)).toHaveCount(0);
    expect(repoState(fx.a)).toEqual(before);
    expect(originSnapshot(fx)).toBe(originBefore);

    await pillMenu(page, 'feature', /^Delete feature and /);
    await page.getByTestId('confirm-ok').click();
    await expect(bar(page)).toHaveCount(0);
    await expect.poll(() => originRef(fx, 'refs/heads/feature')).toBeUndefined();
    expect(hasRef(fx.a, 'refs/heads/feature')).toBe(false);
    expect(originRef(fx, 'refs/heads/main')).toBeDefined();

    await undoKey(page);
    await expect.poll(() => originRef(fx, 'refs/heads/feature')).toBe(fx.featureSha);
    // The undo restores the remote, the local branch and its config in steps, so poll each.
    await expect.poll(() => refSha(fx.a, 'refs/heads/feature')).toBe(fx.featureSha);
    await expect.poll(() => configGet(fx.a, 'branch.feature.remote')).toBe('origin');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('force push after a rejected push', () => {
  test('the force bar shows the remote-changed text, Cancel changes nothing, Force Push replaces origin/main', async ({ page }) => {
    const fx = createRejectedPushFx();
    assertRemotesSafe(fx.a);
    await openGraph(page, fx.a);
    const before = repoState(fx.a);
    const originBefore = originSnapshot(fx);

    await page.getByTestId('tool-push').click();
    await expect(bar(page, 'force-push')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toContainText(T.remoteChanged);
    await expect(page.getByTestId('confirm-message')).toContainText(T.forcePush);
    await expect(page.getByTestId('confirm-ok')).toHaveText('Force Push');
    await expect(page.getByTestId('confirm-cancel')).toHaveText('Cancel');
    await page.getByTestId('confirm-cancel').click();
    await expect(bar(page)).toHaveCount(0);
    expect(originSnapshot(fx)).toBe(originBefore);
    expect(repoState(fx.a)).toEqual(before);

    await page.getByTestId('tool-push').click();
    await expect(bar(page, 'force-push')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(toastTitle(page)).toHaveText(T.pushed);
    await expect(bar(page)).toHaveCount(0);
    expect(originRef(fx, 'refs/heads/main')).toBe(fx.localSha);
    expect(headSha(fx.a)).toBe(fx.localSha);
  });

  test('the lease fails when origin moved after the last fetch: Push Failed + the remote-changed text, origin keeps the newer commit', async ({ page }) => {
    const fx = createRejectedPushFx();
    assertRemotesSafe(fx.a);
    await openGraph(page, fx.a);
    await page.getByTestId('tool-push').click();
    await expect(bar(page, 'force-push')).toBeVisible();
    const moved = originAdvance(fx, { 'again.txt': 'again\n' }, 'Remote moved after my fetch');
    const before = repoState(fx.a);
    await page.getByTestId('confirm-ok').click();
    await expect(toastTitle(page)).toHaveText(T.pushFailed);
    await expect(page.getByTestId('toast-detail')).toContainText(T.remoteChanged);
    await expect(bar(page)).toHaveCount(0);
    expect(originRef(fx, 'refs/heads/main')).toBe(moved);
    expect(repoState(fx.a)).toEqual(before);
  });

  test('a push rejected on a CUSTOM remote branch shows the "is behind" toast, never the force bar; origin is untouched', async ({ page }) => {
    const fx = createRejectedPushFx();
    assertRemotesSafe(fx.a);
    git(fx.a, ['switch', '-c', 'topic']);
    writeFileSync(join(fx.a, 'topic.txt'), 'topic\n');
    git(fx.a, ['add', '-A']);
    git(fx.a, ['commit', '-m', 'Topic commit']);
    await openGraph(page, fx.a);
    const originBefore = originSnapshot(fx);
    await page.getByTestId('tool-push').click();
    await expect(page.getByTestId('upstream-bar')).toBeVisible();
    await page.getByTestId('upstream-branch').fill('main'); // origin/main exists and has diverged from topic
    await page.getByTestId('upstream-submit').click();
    await expect(toastTitle(page)).toHaveText(T.pushFailed);
    await expect(page.getByTestId('toast-detail')).toContainText('is behind');
    await expect(bar(page)).toHaveCount(0);
    expect(originSnapshot(fx)).toBe(originBefore);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('tags (inline)', () => {
  test('Create tag here: invalid name keeps the prompt, a valid name makes a lightweight tag on that commit, Escape cancels', async ({ page }) => {
    const { repo, shas } = createResetRepo();
    await openGraph(page, repo);
    await commitMenu(page, RESET_SUBJECTS[1], 'Create tag here');
    await expect(page.getByTestId('tag-input')).toHaveAttribute('placeholder', 'enter tag name');
    await page.getByTestId('tag-input').fill('bad name');
    await page.getByTestId('tag-input').press('Enter');
    await expect(page.getByTestId('tag-input-error')).toHaveText(T.invalidTag);
    expect(tagNames(repo)).toEqual([]);
    await page.getByTestId('tag-input').press('Escape');
    await expect(page.getByTestId('tag-prompt')).toHaveCount(0);
    expect(tagNames(repo)).toEqual([]);

    await commitMenu(page, RESET_SUBJECTS[1], 'Create tag here');
    await page.getByTestId('tag-input').fill('v1.0');
    await page.getByTestId('tag-input').press('Enter');
    await expect(page.getByTestId('tag-prompt')).toHaveCount(0);
    expect(tagNames(repo)).toEqual(['v1.0']);
    expect(refSha(repo, 'refs/tags/v1.0')).toBe(shas[1]);
    expect(objectType(repo, 'refs/tags/v1.0')).toBe('commit');
    await expect(pill(page, 'v1.0')).toBeVisible();
  });

  test('Create annotated tag here: name + "Annotation message" make a tag object with the message', async ({ page }) => {
    const { repo, shas } = createResetRepo();
    await openGraph(page, repo);
    await commitMenu(page, RESET_SUBJECTS[0], 'Create annotated tag here');
    await expect(page.getByTestId('tag-annotation-label')).toHaveText('Message:');
    await expect(page.getByTestId('tag-annotation')).toHaveAttribute('placeholder', 'Annotation message');
    await page.getByTestId('tag-input').fill('v2.0');
    await page.getByTestId('tag-annotation').fill('Second release');
    await page.getByTestId('tag-submit').click();
    await expect(page.getByTestId('tag-prompt')).toHaveCount(0);
    expect(objectType(repo, 'refs/tags/v2.0')).toBe('tag');
    expect(git(repo, ['rev-parse', 'refs/tags/v2.0^{commit}']).trim()).toBe(shas[0]);
    expect(tagMessage(repo, 'v2.0')).toContain('Second release');
  });

  test('an existing tag name fails with "Failed creating ref" and the tag stays where it was (never forced)', async ({ page }) => {
    const { repo, shas } = createResetRepo();
    git(repo, ['tag', 'v1.0', shas[0]!]);
    await openGraph(page, repo);
    await commitMenu(page, RESET_SUBJECTS[1], 'Create tag here');
    await page.getByTestId('tag-input').fill('v1.0');
    await page.getByTestId('tag-input').press('Enter');
    await expect(toastTitle(page)).toHaveText(T.createRefFailed);
    expect(refSha(repo, 'refs/tags/v1.0')).toBe(shas[0]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('cherry-pick and revert from the commit menu', () => {
  test('cherry-pick: a clean pick adds one commit with the same message and author, and shows the success toast', async ({ page }) => {
    const fx = createPickRepo();
    const before = headSha(fx.repo);
    await openGraph(page, fx.repo);
    await commitMenu(page, PICK.t1, 'Cherry pick commit');
    await expect(toastTitle(page)).toHaveText(T.cherryOk);
    expect(git(fx.repo, ['rev-parse', 'HEAD^']).trim()).toBe(before);
    expect(lastSubject(fx.repo)).toBe(PICK.t1);
    expect(lastAuthor(fx.repo)).toBe(PICK.author);
    expect(fileText(fx.repo, 'topic.txt')).toBe('topic\n');
    expect(marker(fx.repo, 'CHERRY_PICK_HEAD')).toBe(false);
  });

  test('cherry-pick of a change that is already there is skipped: toast with the noop text, HEAD unchanged, no pick left in progress', async ({ page }) => {
    const fx = createPickRepo();
    await openGraph(page, fx.repo);
    await commitMenu(page, PICK.t1, 'Cherry pick commit');
    await expect(toastTitle(page)).toHaveText(T.cherryOk);
    const afterFirst = headSha(fx.repo);
    await page.getByTestId('toast-dismiss').first().click();
    await commitMenu(page, PICK.t1, 'Cherry pick commit');
    await expect(page.getByTestId('toast-detail')).toHaveText(T.cherryNoop);
    expect(headSha(fx.repo)).toBe(afterFirst);
    expect(marker(fx.repo, 'CHERRY_PICK_HEAD')).toBe(false);
    expect(git(fx.repo, ['status', '--porcelain=v1']).trim()).toBe('');
  });

  test('cherry-pick conflict opens the conflict screen; Abort restores HEAD and bytes exactly', async ({ page }) => {
    const fx = createPickRepo();
    const before = repoState(fx.repo);
    await openGraph(page, fx.repo);
    await commitMenu(page, PICK.t3, 'Cherry pick commit');
    await expect(page.getByTestId('op-banner')).toBeVisible();
    expect(marker(fx.repo, 'CHERRY_PICK_HEAD')).toBe(true);
    await page.getByTestId('op-banner').click();
    await expect(page.getByTestId('conflict-title')).toHaveText('Cherry-pick conflicts detected');
    await expect(page.getByTestId('op-abort')).toHaveText('Abort Cherry-pick');
    await page.getByTestId('op-abort').click();
    await expect(page.getByTestId('op-banner')).toHaveCount(0);
    expect(marker(fx.repo, 'CHERRY_PICK_HEAD')).toBe(false);
    expect(repoState(fx.repo)).toEqual(before);
  });

  test('cherry-pick conflict on a dirty tree: the edit is auto-stashed, and Abort pops it back', async ({ page }) => {
    const fx = createPickRepo({ dirty: true });
    const head = headSha(fx.repo);
    await openGraph(page, fx.repo);
    await commitMenu(page, PICK.t3, 'Cherry pick commit');
    await expect(page.getByTestId('op-banner')).toBeVisible();
    // `stash list --format=%gs` prefixes git's own "On main: " to the message, so the text is matched without a leading anchor.
    expect(stashList(fx.repo).some((s) => /Auto stash before cherry pick of ".+"$/.test(s))).toBe(true);
    expect(fileText(fx.repo, 'README.md')).toBe('# readme\n');
    await page.getByTestId('op-banner').click();
    await page.getByTestId('op-abort').click();
    await expect(page.getByTestId('op-banner')).toHaveCount(0);
    expect(headSha(fx.repo)).toBe(head);
    expect(fileText(fx.repo, 'README.md')).toBe(PICK_DIRTY);
    expect(stashList(fx.repo)).toEqual([]);
  });

  test('cherry-pick conflict resolved and committed: the picked message is used, no "#" lines, the screen closes', async ({ page }) => {
    const fx = createPickRepo();
    await openGraph(page, fx.repo);
    await commitMenu(page, PICK.t3, 'Cherry pick commit');
    await expect(page.getByTestId('op-banner')).toBeVisible();
    writeFileSync(join(fx.repo, 'a.txt'), 'a resolved\n');
    await page.getByTestId('op-banner').click();
    await page.getByTestId('mark-all-resolved').click();
    await expect(page.getByTestId('commit-button')).toBeEnabled();
    await page.getByTestId('commit-button').click();
    // (the amber banner is already gone once the files are resolved, so the screen itself is what must close)
    await expect(page.getByTestId('conflict-panel')).toHaveCount(0);
    expect(marker(fx.repo, 'CHERRY_PICK_HEAD')).toBe(false);
    expect(lastSubject(fx.repo)).toBe(PICK.t3);
    expect(fileText(fx.repo, 'a.txt')).toBe('a resolved\n');
    expect(git(fx.repo, ['log', '-1', '--format=%B']).split('\n').some((l) => l.startsWith('#'))).toBe(false);
  });

  test('revert: a clean revert adds a "Revert ..." commit and shows the success toast', async ({ page }) => {
    const fx = createPickRepo();
    await openGraph(page, fx.repo);
    await commitMenu(page, PICK.m2, 'Revert commit');
    await expect(toastTitle(page)).toHaveText(T.revertOk);
    expect(lastSubject(fx.repo)).toBe(`Revert "${PICK.m2}"`);
    expect(fileText(fx.repo, 'b.txt')).toBe('b1\n');
    expect(git(fx.repo, ['log', '-1', '--format=%B']).split('\n').some((l) => l.startsWith('#'))).toBe(false);
    expect(marker(fx.repo, 'REVERT_HEAD')).toBe(false);
  });

  test('revert of a change the history already undid is skipped with the noop text', async ({ page }) => {
    const fx = createPickRepo();
    const before = repoState(fx.repo);
    await openGraph(page, fx.repo);
    await commitMenu(page, PICK.m4, 'Revert commit');
    await expect(page.getByTestId('toast-detail')).toHaveText(T.revertNoop);
    expect(repoState(fx.repo)).toEqual(before);
    expect(marker(fx.repo, 'REVERT_HEAD')).toBe(false);
  });

  test('revert conflict: conflict screen with the Revert wording, Abort restores HEAD and bytes', async ({ page }) => {
    const fx = createPickRepo();
    const before = repoState(fx.repo);
    await openGraph(page, fx.repo);
    await commitMenu(page, PICK.m1, 'Revert commit');
    await expect(page.getByTestId('op-banner')).toBeVisible();
    expect(marker(fx.repo, 'REVERT_HEAD')).toBe(true);
    await page.getByTestId('op-banner').click();
    await expect(page.getByTestId('conflict-title')).toHaveText('Revert conflicts detected');
    await expect(page.getByTestId('op-abort')).toHaveText('Abort Revert');
    await page.getByTestId('op-abort').click();
    await expect(page.getByTestId('op-banner')).toHaveCount(0);
    expect(marker(fx.repo, 'REVERT_HEAD')).toBe(false);
    expect(repoState(fx.repo)).toEqual(before);
  });

  test('a merge commit offers neither Cherry pick nor Revert (but the menu still opens)', async ({ page }) => {
    const fx = createPickRepo();
    await openGraph(page, fx.repo);
    await rowWithSubject(page, PICK.merge).first().click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    const labels = await menuLabels(page);
    expect(labels).toContain('Create tag here');
    expect(labels).not.toContain('Cherry pick commit');
    expect(labels).not.toContain('Revert commit');
    expect(subjects(fx.repo)[0]).toBe(PICK.merge);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('routes refuse bad input and leave the repository untouched', () => {
  const clientErr = (status: number): boolean => status >= 400 && status < 500;

  test('POST /discard: empty, escaping, absolute, .git, glob and not-in-status paths are 4xx; a listed path works and only it', async ({ request }) => {
    const repo = createDiscardRepo();
    const id = await openRepoApi(request, repo);
    const before = repoState(repo);
    const abs = join(repo, '..', 'outside.txt');
    for (const paths of [[], [''], ['../outside.txt'], [abs], ['.git/config'], ['*'], ['.'], [':(glob)**'], [DISCARD.clean], [DISCARD.ignored]]) {
      const res = await post(request, id, 'discard', { paths });
      expect(clientErr(res.status()), JSON.stringify(paths)).toBe(true);
    }
    expect(repoState(repo)).toEqual(before);
    const ok = await post(request, id, 'discard', { paths: [DISCARD.untracked] });
    expect(ok.status()).toBe(200);
    expect(exists(repo, DISCARD.untracked)).toBe(false);
    expect(readText(repo, DISCARD.a)).toBe(DISCARD_EDITED.a);
    expect(readText(repo, DISCARD.ignored)).toBe('ignored bytes\n');
  });

  test('POST /discard-hunk: a stale header is 409 and changes nothing', async ({ request }) => {
    const repo = createHunkRepo();
    const id = await openRepoApi(request, repo);
    const before = repoState(repo);
    const res = await post(request, id, 'discard-hunk', { path: 'hunks.txt', hunk: 0, header: '@@ -1,1 +1,1 @@' });
    expect(res.status()).toBe(409);
    expect(repoState(repo)).toEqual(before);
  });

  test('POST /reset: refs by name, options as sha, unknown sha, bad mode are 4xx; HEAD, index and bytes stay', async ({ request }) => {
    const { repo, shas } = createResetRepo({ dirty: true });
    const id = await openRepoApi(request, repo);
    const before = repoState(repo);
    for (const body of [
      { sha: 'HEAD', mode: 'hard' },
      { sha: 'main', mode: 'hard' },
      { sha: '--hard', mode: 'hard' },
      { sha: 'f'.repeat(40), mode: 'hard' },
      { sha: shas[0], mode: 'keep' },
      { sha: shas[0], mode: '--hard' },
    ]) {
      const res = await post(request, id, 'reset', body);
      expect(clientErr(res.status()), JSON.stringify(body)).toBe(true);
    }
    expect(repoState(repo)).toEqual(before);
    expect(pinCount(repo)).toBe(0);
  });

  test('POST /tag, /branch/rename, /branch/delete, /push/force: invalid names, stale shas and malformed leases are 4xx and nothing changes', async ({ request }) => {
    const fx = createBranchDeleteRepo();
    const id = await openRepoApi(request, fx.repo);
    const before = repoState(fx.repo);
    const cases: Array<[string, unknown]> = [
      ['tag', { name: '-x', sha: fx.baseSha }],
      ['tag', { name: 'a b', sha: fx.baseSha }],
      ['tag', { name: 'v1', sha: 'HEAD' }],
      ['tag', { name: 'v1', sha: fx.baseSha, message: 'bad \u0000 nul' }],
      ['branch/rename', { name: 'wip', newName: 'bad name' }],
      ['branch/rename', { name: 'nope', newName: 'fine' }],
      ['branch/rename', { name: 'wip', newName: '-M' }],
      ['branch/delete', { name: 'wip', expectSha: fx.baseSha, force: true }],
      ['branch/delete', { name: '-D', expectSha: fx.wipSha, force: true }],
      ['branch/delete', { name: 'wip', expectSha: fx.wipSha, force: true, remote: 'attacker' }],
      ['push/force', { branch: 'wip', expect: 'not-a-sha' }],
    ];
    for (const [route, body] of cases) {
      const res = await post(request, id, route, body);
      expect(clientErr(res.status()), `${route} ${JSON.stringify(body)}`).toBe(true);
    }
    expect(repoState(fx.repo)).toEqual(before);
    expect(tagNames(fx.repo)).toEqual([]);
    expect(currentBranch(fx.repo)).toBe('main');
  });

  test('while a merge is unresolved every destructive route answers 409 and nothing changes', async ({ request }) => {
    const fx = createMergeInProgress();
    const id = await openRepoApi(request, fx.repo);
    const before = repoState(fx.repo);
    const cases: Array<[string, unknown]> = [
      ['discard', { paths: ['README.md'] }],
      ['reset', { sha: fx.featureSha, mode: 'hard' }],
      ['tag', { name: 'v1', sha: fx.featureSha }],
      ['branch/rename', { name: 'feature/conflict', newName: 'other' }],
      ['branch/delete', { name: 'feature/conflict', expectSha: fx.featureSha, force: true }],
    ];
    for (const [route, body] of cases) {
      const res = await post(request, id, route, body);
      expect(res.status(), route).toBe(409);
    }
    expect(repoState(fx.repo)).toEqual(before);
    expect(subjects(fx.repo).length).toBeGreaterThan(0);
  });
});
