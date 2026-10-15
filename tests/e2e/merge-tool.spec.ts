import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { FEATURE, createMergeInProgress, createRebaseInProgress, fileText, gitOut, unmergedPaths } from './helpers/mergeFixtures';

/*
 * Test ids this file expects (new ones, all +). Existing from phase 6: op-banner, conflict-panel, conflict-conflicted,
 * conflict-resolved, conflict-file-row[data-path] (clicking a CONFLICTED row opens the merge tool).
 *  + merge-tool                 root; replaces the centre and right area (conflict-panel is not visible while it is open)
 *  + merge-title                file path ("src/config.js"); merge-count the count text ("(1 conflict)")
 *  + merge-pane-a, merge-pane-b read-only side panes; attribute data-value = the pane's full text
 *  + merge-pane-title-a/-b      "Commit <7-char sha> on <branch>"; merge-badge-a/-b the letter "A"/"B"
 *  + merge-take-a, merge-take-b glyph checkbox per conflict, data-conflict="<index>", aria-checked="true|false" (click toggles)
 *  + merge-take-all-a/-b        pane header toggle, text "Take all" / "Untake all"
 *  + merge-output               editable Monaco wrapper; attribute data-value = the live output text; merge-output-title "Output"
 *  + merge-conflict-pos         "conflict 1 of 1"; merge-prev / merge-next the up/down buttons
 *  + merge-wrap                 word wrap toggle (title "Word Wrap")
 *  + merge-external             "Open in external merge tool" (absent unless merge.tool is set and all three stages exist)
 *  + merge-save, merge-close
 *  + merge-save-confirm         bar shown when Save is pressed with an unresolved conflict; merge-save-confirm-ok / -cancel
 *  + merge-error                inline error text (stale file etc.)
 * Strings (en-us.json): Merge-A, Merge-B, Merge-Commit, Merge-Output, Merge-ConflictXofY, Merge-OneConflict, Merge-TakeAll,
 *   Merge-UntakeAll, OpenIn + ExternalMergeTool, Save, Close, FileViewPanel-WordWrap, PromptForMerge-SaveMergeWithUnresolvedConflicts.
 * UNVERIFIED: the confirm bar button labels (no key was chosen), and that a click on a conflicted row opens the tool.
 */

const PROMPT = 'You have unresolved conflicts. How would you like to proceed?'; // PromptForMerge-SaveMergeWithUnresolvedConflicts
const CFG = 'src/config.js';

async function openTool(page: Page, repo: string, path = CFG): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('op-banner')).toBeVisible();
  await page.getByTestId('op-banner').click();
  await expect(page.getByTestId('conflict-panel')).toBeVisible();
  await page.getByTestId('conflict-conflicted').locator(`[data-testid="conflict-file-row"][data-path="${path}"]`).click();
  await expect(page.getByTestId('merge-tool')).toBeVisible({ timeout: 20_000 });
}

const output = (page: Page) => page.getByTestId('merge-output');
const tickA = (page: Page) => page.getByTestId('merge-take-a').first();
const tickB = (page: Page) => page.getByTestId('merge-take-b').first();

test.describe('3-pane merge tool', () => {
  test('opens from the conflict panel and shows the header, both panes and an empty output', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openTool(page, fx.repo);
    await expect(page.getByTestId('conflict-panel')).not.toBeVisible();
    await expect(page.getByTestId('merge-title')).toHaveText(CFG);
    await expect(page.getByTestId('merge-count')).toHaveText('(1 conflict)'); // Merge-OneConflict
    await expect(page.getByTestId('merge-badge-a')).toHaveText('A');
    await expect(page.getByTestId('merge-badge-b')).toHaveText('B');
    await expect(page.getByTestId('merge-pane-title-a')).toHaveText(`Commit ${fx.mainSha.slice(0, 7)} on main`);
    await expect(page.getByTestId('merge-pane-title-b')).toHaveText(`Commit ${fx.featureSha.slice(0, 7)} on ${FEATURE}`);
    await expect(page.getByTestId('merge-output-title')).toHaveText('Output');
    await expect(page.getByTestId('merge-conflict-pos')).toHaveText('conflict 1 of 1');
    await expect(page.getByTestId('merge-pane-a')).toHaveAttribute('data-value', 'title=main\n');
    await expect(page.getByTestId('merge-pane-b')).toHaveAttribute('data-value', 'title=feature\n');
    await expect(output(page)).toHaveAttribute('data-value', ''); // conflicts start empty
    await expect(page.getByTestId('merge-save')).toHaveText('Save');
    await expect(page.getByTestId('merge-wrap')).toHaveAttribute('title', 'Word Wrap');
  });

  test('on a rebase the A and B headers are swapped (A is the branch rebased onto)', async ({ page }) => {
    const fx = createRebaseInProgress();
    await openTool(page, fx.repo);
    await expect(page.getByTestId('merge-pane-title-a')).toHaveText(`Commit ${fx.onto.slice(0, 7)} on ${FEATURE}`);
    await expect(page.getByTestId('merge-pane-title-b')).toContainText(' on main');
    await expect(page.getByTestId('merge-pane-a')).toHaveAttribute('data-value', 'title=feature\n');
    await expect(page.getByTestId('merge-pane-b')).toHaveAttribute('data-value', 'title=main\n');
  });

  test('ticking A, B, then both (A then B) fills the output; unticking empties it', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openTool(page, fx.repo);
    await tickA(page).click();
    await expect(tickA(page)).toHaveAttribute('aria-checked', 'true');
    await expect(output(page)).toHaveAttribute('data-value', 'title=main\n');
    await tickB(page).click();
    await expect(output(page)).toHaveAttribute('data-value', 'title=main\ntitle=feature\n'); // A then B
    await tickA(page).click();
    await expect(output(page)).toHaveAttribute('data-value', 'title=feature\n');
    await tickB(page).click();
    await expect(output(page)).toHaveAttribute('data-value', '');
    await expect(tickA(page)).toHaveAttribute('aria-checked', 'false');
    await expect(tickB(page)).toHaveAttribute('aria-checked', 'false');
  });

  test('Take all / Untake all on a pane toggles every conflict for that side', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openTool(page, fx.repo);
    await expect(page.getByTestId('merge-take-all-a')).toHaveAttribute('aria-label', 'Take all');
    await expect(page.getByTestId('merge-take-all-a')).toHaveText('');
    await page.getByTestId('merge-take-all-a').click();
    await expect(output(page)).toHaveAttribute('data-value', 'title=main\n');
    await expect(page.getByTestId('merge-take-all-a')).toHaveAttribute('aria-label', 'Untake all');
    await page.getByTestId('merge-take-all-a').click();
    await expect(output(page)).toHaveAttribute('data-value', '');
    await page.getByTestId('merge-take-all-b').click();
    await expect(output(page)).toHaveAttribute('data-value', 'title=feature\n');
  });

  test('the output can be edited by typing', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openTool(page, fx.repo);
    await tickA(page).click();
    await output(page).locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('title=custom\n');
    await expect(output(page)).toHaveAttribute('data-value', 'title=custom\n');
  });

  test('Save with an unresolved conflict shows the confirm bar; Cancel changes nothing', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    const before = fileText(fx.repo, CFG);
    await openTool(page, fx.repo);
    await page.getByTestId('merge-save').click();
    await expect(page.getByTestId('merge-save-confirm')).toContainText(PROMPT);
    await page.getByTestId('merge-save-confirm-cancel').click();
    await expect(page.getByTestId('merge-save-confirm')).toHaveCount(0);
    await expect(page.getByTestId('merge-tool')).toBeVisible();
    expect(fileText(fx.repo, CFG)).toBe(before);
    expect(unmergedPaths(fx.repo)).toContain(CFG);
  });

  test('Save writes the output to the file, stages it, closes the tool and moves the row to Resolved', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openTool(page, fx.repo);
    await tickA(page).click();
    await tickB(page).click();
    await page.getByTestId('merge-save').click();
    await expect(page.getByTestId('merge-save-confirm')).toHaveCount(0); // resolved, so no confirm
    await expect(page.getByTestId('merge-tool')).toHaveCount(0);
    expect(fileText(fx.repo, CFG)).toBe('title=main\ntitle=feature\n');
    expect(unmergedPaths(fx.repo)).not.toContain(CFG);
    expect(gitOut(fx.repo, ['diff', '--cached', '--name-only']).split('\n')).toContain(CFG);
    await expect(page.getByTestId('conflict-panel')).toBeVisible();
    await expect(page.getByTestId('conflict-resolved').locator(`[data-testid="conflict-file-row"][data-path="${CFG}"]`)).toBeVisible();
    await expect(page.getByTestId('conflict-conflicted').locator(`[data-testid="conflict-file-row"][data-path="${CFG}"]`)).toHaveCount(0);
  });

  test('an edited output counts as resolved: Save needs no confirm', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openTool(page, fx.repo);
    await output(page).locator('.monaco-editor .view-lines').click();
    await page.keyboard.type('title=typed\n');
    await page.getByTestId('merge-save').click();
    await expect(page.getByTestId('merge-tool')).toHaveCount(0);
    expect(fileText(fx.repo, CFG)).toBe('title=typed\n');
    expect(unmergedPaths(fx.repo)).not.toContain(CFG);
  });

  test('a file changed on disk after opening is not overwritten (error shown, tool stays open)', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openTool(page, fx.repo);
    await tickA(page).click();
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(fx.repo, CFG), 'changed behind the tool\n');
    await page.getByTestId('merge-save').click();
    await expect(page.getByTestId('merge-error')).toBeVisible();
    await expect(page.getByTestId('merge-tool')).toBeVisible();
    expect(fileText(fx.repo, CFG)).toBe('changed behind the tool\n');
  });

  test('the external tool button is hidden when merge.tool is not set', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    await openTool(page, fx.repo);
    await expect(page.getByTestId('merge-save')).toBeVisible();
    await expect(page.getByTestId('merge-external')).toHaveCount(0); // UNVERIFIED: assumes no merge.tool in the global git config
  });

  test('the external tool button shows "Open in external merge tool" when merge.tool is set', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    gitOut(fx.repo, ['config', 'merge.tool', 'gitslappintest']);
    gitOut(fx.repo, ['config', 'mergetool.gitslappintest.cmd', 'true']);
    await openTool(page, fx.repo);
    await expect(page.getByTestId('merge-external')).toHaveText('Open in external merge tool'); // OpenIn + ExternalMergeTool
  });

  test('the X button closes the tool without touching the file, back to the conflict panel', async ({ page }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    const before = fileText(fx.repo, CFG);
    await openTool(page, fx.repo);
    await tickA(page).click();
    await page.getByTestId('merge-close').click();
    await expect(page.getByTestId('merge-tool')).toHaveCount(0);
    await expect(page.getByTestId('conflict-panel')).toBeVisible();
    expect(fileText(fx.repo, CFG)).toBe(before);
    expect(unmergedPaths(fx.repo)).toContain(CFG);
  });
});
