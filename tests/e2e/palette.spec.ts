import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { TEST_TOKEN, createRepo } from './helpers/repo';
import { createDndFx, createLaneRepo } from './helpers/interactionFixtures';
import {
  EDITED_APP,
  EDITED_UTIL,
  ORIGINAL,
  createDirtyStashRepo,
  createStashRepo,
  createStashedDirtyRepo,
  createStashedRepo,
  currentBranch,
  fileText,
  keepRefSha,
  porcelain,
  stashShas,
} from './helpers/stashFixtures';

/*
 * V6 "3 Command palette" (screens 34, 34a) + audit data-safety 1 and 2. Fixtures: helpers/stashFixtures.ts, helpers/interactionFixtures.ts.
 * Existing test ids: repo-view, repo-tab-name, commit-row, tool-undo, confirm-bar[data-kind], confirm-message, confirm-ok, confirm-cancel, branch-input, graph-search, preferences-view,
 *   left-panel, file-history-view, file-history-title, file-history-blame-toggle, context-menu.
 * NEW (+) the builder must implement:
 *  + tool-actions   the Actions toolbar button (existing ToolButton id), enabled, title "Command Palette (Ctrl + P)" (FuzzyFinderButtonTooltip, {0}=Ctrl); tool-search and tool-terminal likewise enabled
 *  + command-palette   the overlay root;  palette-input  the text input, autofocused, placeholder per mode (en-us.json FuzzyFinder-*Placeholder)
 *  + palette-item  one row per result (data-id = the item id from lib/paletteItems.ts: discard-all, stash-pop, stash-apply, stash-create, create-branch, checkout, history, blame, open-repo, ...;
 *      in the sub-modes the row is a branch / repo / file and data-id is its name / root / path); aria-selected on the highlighted row;
 *      palette-item-label  its label text (matched characters wrapped in <mark>)
 *  + Keys: ArrowUp/ArrowDown move the highlight, Enter runs it, Esc closes (and, in a sub-mode, closes the palette).
 *  All rows render in the DOM (no virtual scrolling), so the full list can be counted.
 * UNVERIFIED: Stash: Create runs like the toolbar Stash button (default message, no prompt); Blame opens File History with blame on (V5 spec note).
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };
const palette = (page: Page) => page.getByTestId('command-palette');
const input = (page: Page) => page.getByTestId('palette-input');
const rows = (page: Page) => page.getByTestId('palette-item');
const row = (page: Page, id: string) => page.locator(`[data-testid="palette-item"][data-id="${id}"]`);
const labels = (page: Page): Promise<string[]> => page.getByTestId('palette-item-label').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
const DEFAULT_PH = 'Search for commands and actions (e.g., Open Repo)';

async function openGraph(page: Page, repo: string): Promise<void> {
  const res = await page.request.put('/api/prefs', { headers, data: { autoFetchMinutes: 0 } });
  expect(res.status()).toBe(200);
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
async function runItem(page: Page, id: string, typed: string): Promise<void> {
  await page.keyboard.press('Control+p');
  await expect(palette(page)).toBeVisible();
  await input(page).fill(typed);
  await expect(row(page, id)).toBeVisible();
  await row(page, id).click();
}

test.describe('opening and closing', () => {
  test('Ctrl+P opens it with the default placeholder and focus in the input; Esc closes it', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await expect(palette(page)).toHaveCount(0);
    await page.keyboard.press('Control+p');
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveAttribute('placeholder', DEFAULT_PH);
    await page.keyboard.press('Escape');
    await expect(palette(page)).toHaveCount(0);
  });

  test('Ctrl+P again closes it (Toggle Command Palette)', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await page.keyboard.press('Control+p');
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Control+p');
    await expect(palette(page)).toHaveCount(0);
  });

  test('the toolbar Actions button opens it and has the FuzzyFinderButtonTooltip title; Search and Terminal are enabled too', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await expect(page.getByTestId('tool-actions')).toBeEnabled();
    await expect(page.getByTestId('tool-actions')).toHaveAttribute('title', 'Command Palette (Ctrl + P)');
    await expect(page.getByTestId('tool-search')).toBeEnabled();
    await expect(page.getByTestId('tool-terminal')).toBeEnabled();
    await page.getByTestId('tool-actions').click();
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toHaveAttribute('placeholder', DEFAULT_PH);
  });

  test('the toolbar Search button opens the same commit search as Ctrl+F (screen 35)', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await expect(page.getByTestId('graph-search')).toHaveCount(0);
    await page.getByTestId('tool-search').click();
    await expect(page.getByTestId('graph-search')).toBeVisible();
  });
});

test.describe('the list', () => {
  test('a repo tab shows exactly the 33 kept items, alphabetical, none of the cut ones', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await page.keyboard.press('Control+p');
    await expect(rows(page)).toHaveCount(33);
    const l = await labels(page);
    expect(l).toEqual([...l].sort());
    for (const cut of ['Apply patch', 'Manage Account', 'Open Workspaces', 'Switch to Profile', 'Share commit as Cloud Patch', 'Start Pull Request', 'View Release Notes', 'Generate Commit Message', 'Configure LFS', 'Configure Gitflow', 'Configure Commit Signing', 'Create File', 'Delete File', 'Edit File', 'Open File', 'View File', 'Open in VS Code', 'Open in External Diff/Merge Tool', 'Perform Repo Maintenance', 'Toggle Syntax Highlighting', 'Toggle Toolbar Labels', 'View Error Logs', 'View Performance Logs']) {
      expect(l, cut).not.toContain(cut);
    }
    for (const kept of ['Create Branch', 'Fetch All', 'Stash: Pop', 'Discard all changes', 'Open in default terminal', 'Toggle terminal panel', 'Keyboard Shortcuts']) expect(l).toContain(kept);
  });

  test('typing "stash" keeps the three Stash items and none of the cut cloud / release-notes ones (screen 34a minus the cut)', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await page.keyboard.press('Control+p');
    await input(page).fill('stash');
    const l = await labels(page);
    expect(l).toEqual(expect.arrayContaining(['Stash: Pop', 'Stash: Apply', 'Stash: Create']));
    expect(l).not.toContain('Share commit as Cloud Patch');
    expect(l).not.toContain('View Release Notes');
    // matched characters are highlighted
    await expect(row(page, 'stash-pop').locator('mark')).not.toHaveCount(0);
    await expect(row(page, 'stash-pop').locator('mark').first()).toHaveText(/^s/i);
  });

  test('keywords match: "reset hard" finds Discard all changes, "folder" finds Open in file manager, "preferences" finds Settings', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await page.keyboard.press('Control+p');
    await input(page).fill('reset hard');
    await expect(row(page, 'discard-all')).toBeVisible();
    await input(page).fill('folder');
    await expect(row(page, 'open-folder')).toBeVisible();
    await input(page).fill('preferences');
    await expect(row(page, 'settings')).toBeVisible();
  });

  test('a query that matches nothing (a cut item name) shows no rows', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await page.keyboard.press('Control+p');
    await input(page).fill('patch');
    await expect(rows(page)).toHaveCount(0);
  });

  test('with no repo tab open the repo-only items are hidden', async ({ page }) => {
    await gotoOpenView(page);
    await page.keyboard.press('Control+p');
    await expect(palette(page)).toBeVisible();
    const l = await labels(page);
    expect(l.length).toBeGreaterThan(0);
    expect(l.length).toBeLessThan(33);
    for (const g of ['Clone', 'Open Repo', 'Settings']) expect(l).toContain(g);
    for (const r of ['Create Branch', 'Fetch All', 'Stash: Pop', 'Discard all changes']) expect(l).not.toContain(r);
  });
});

test.describe('items that act', () => {
  test('Create Branch opens the inline branch input', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await runItem(page, 'create-branch', 'create branch');
    await expect(palette(page)).toHaveCount(0);
    await expect(page.getByTestId('branch-input')).toBeVisible();
  });

  test('Checkout switches the palette to branches (placeholder FuzzyFinder-CheckoutPlaceholder); Enter checks the branch out', async ({ page }) => {
    const fx = createDndFx();
    await openGraph(page, fx.a);
    await runItem(page, 'checkout', 'checkout');
    await expect(input(page)).toHaveAttribute('placeholder', 'Search for a branch to checkout');
    await expect(rows(page).filter({ hasText: 'feature/x' })).toBeVisible();
    await input(page).fill('feature');
    await expect(rows(page).first()).toContainText('feature/x');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('toolbar-branch')).toContainText('feature/x');
    expect(currentBranch(fx.a)).toBe('feature/x');
  });

  test('Settings opens Preferences; Keyboard Shortcuts opens the shortcuts list; Toggle Left Panel hides the left panel', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await runItem(page, 'settings', 'settings');
    await expect(page.getByTestId('preferences-view')).toBeVisible();
    await page.keyboard.press('Escape');
    await runItem(page, 'keyboard-shortcuts', 'keyboard shortcuts');
    await expect(page.getByTestId('View-KeyBindings')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('left-panel')).toBeVisible();
    await runItem(page, 'toggle-left-panel', 'toggle left panel');
    await expect(page.getByTestId('left-panel')).toBeHidden();
  });

  test('Ctrl+Shift+H lists the files of HEAD (placeholder FuzzyFinder-HistoryPlaceholder); Enter opens that file\'s File History', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await page.keyboard.press('Control+Shift+H');
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toHaveAttribute('placeholder', 'Search for a file to view its history / blame');
    await expect(rows(page).filter({ hasText: 'src/app.js' })).toBeVisible();
    await expect(rows(page).filter({ hasText: 'README.md' })).toBeVisible();
    await input(page).fill('app');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('file-history-view')).toBeVisible();
    await expect(page.getByTestId('file-history-title')).toContainText('src/app.js');
  });

  test('the History item opens the same file finder; the Blame item opens the file finder in blame mode (placeholder FuzzyFinder-BlamePlaceholder)', async ({ page }) => {
    await openGraph(page, createStashRepo());
    await runItem(page, 'history', 'history');
    await expect(input(page)).toHaveAttribute('placeholder', 'Search for a file to view its history / blame');
    await page.keyboard.press('Escape');
    await runItem(page, 'blame', 'blame');
    await expect(input(page)).toHaveAttribute('placeholder', 'Search for a file to view who did what (i.e. its blame)');
    await input(page).fill('util');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('file-history-view')).toBeVisible();
    await expect(page.getByTestId('file-history-title')).toContainText('src/util.js');
    await expect(page.getByTestId('file-history-blame-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Ctrl+Shift+O lists the recent repos (placeholder FuzzyFinder-OpenRepoPlaceholder); Enter opens the chosen one in the tab bar', async ({ page }) => {
    const other = createRepo('palette-recent-target');
    await gotoOpenView(page);
    await openRepoByPath(page, other); // puts it in /api/recent
    await page.getByTestId('tab-add').click();
    await openRepoByPath(page, createLaneRepo()); // the active tab is now a different repo
    await expect(page.getByTestId('repo-view')).toBeVisible();
    await page.keyboard.press('Control+Shift+O');
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toHaveAttribute('placeholder', 'Search for a repository to open');
    await input(page).fill('palette-recent-target');
    await expect(rows(page).first()).toContainText('palette-recent-target');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('repo-view')).toBeVisible();
    await expect(page.getByTestId('repo-tab-name').filter({ hasText: 'palette-recent-target' }).first()).toBeVisible();
  });

  test('Open in default terminal / Open in file manager call the server routes with no path in the request', async ({ page }) => {
    const calls: { url: string; body: string | null }[] = [];
    await page.route('**/api/repos/*/open-terminal', (r) => {
      calls.push({ url: r.request().url(), body: r.request().postData() });
      return r.fulfill({ status: 200, json: { ok: true } });
    });
    await page.route('**/api/repos/*/open-folder', (r) => {
      calls.push({ url: r.request().url(), body: r.request().postData() });
      return r.fulfill({ status: 200, json: { ok: true } });
    });
    const repo = createStashRepo();
    await openGraph(page, repo);
    await runItem(page, 'open-terminal', 'terminal');
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]!.url).toMatch(/\/open-terminal$/);
    await runItem(page, 'open-folder', 'file manager');
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]!.url).toMatch(/\/open-folder$/);
    for (const c of calls) {
      expect(c.url).not.toContain('?');
      expect(c.body ?? '').not.toContain(repo.replace(/\\/g, '\\\\'));
      expect(c.body ?? '').not.toContain('gitslappin-tests');
    }
  });
});

test.describe('audit data-safety 1: Discard all changes goes through the confirm bar and the snapshot', () => {
  test('palette Discard shows the confirm bar first; Cancel changes nothing; OK discards; Undo brings everything back', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openGraph(page, repo);
    const before = porcelain(repo);
    expect(before).not.toBe('');
    await runItem(page, 'discard-all', 'discard');
    await expect(page.locator('[data-testid="confirm-bar"][data-kind="discard-all"]')).toBeVisible();
    await expect(page.getByTestId('confirm-ok')).toHaveText('Reset All');
    expect(porcelain(repo)).toBe(before); // nothing ran yet: the bar is the gate
    expect(fileText(repo, 'src/app.js')).toBe(EDITED_APP);
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
    expect(porcelain(repo)).toBe(before);

    await runItem(page, 'discard-all', 'discard');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
    await expect.poll(() => porcelain(repo)).toBe('');
    expect(fileText(repo, 'src/app.js')).toBe(ORIGINAL.app);
    // the pre-discard snapshot exists: Undo restores the edit
    await expect(page.getByTestId('tool-undo')).toBeEnabled();
    await page.getByTestId('tool-undo').click();
    await expect.poll(() => porcelain(repo)).toBe(before);
    expect(fileText(repo, 'src/app.js')).toBe(EDITED_APP);
  });

  test('Enter on the palette row also stops at the confirm bar (the keyboard path cannot skip it)', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openGraph(page, repo);
    const before = porcelain(repo);
    await page.keyboard.press('Control+p');
    await input(page).fill('discard all');
    await expect(row(page, 'discard-all')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="confirm-bar"][data-kind="discard-all"]')).toBeVisible();
    expect(porcelain(repo)).toBe(before);
    await page.keyboard.press('Escape'); // the bar cancels on Escape
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
    expect(porcelain(repo)).toBe(before);
  });
});

test.describe('audit data-safety 2: Stash Pop / Apply keep the safety nets', () => {
  const DIRTY_PROMPT = 'You have uncommitted changes. Are you sure you want to apply the stash on top of your changes?';

  test('Stash: Pop on a clean tree pops the newest stash and leaves the stash-keep ref', async ({ page }) => {
    const fx = createStashedRepo();
    await openGraph(page, fx.repo);
    await runItem(page, 'stash-pop', 'stash pop');
    await expect.poll(() => stashShas(fx.repo)).toEqual([fx.shas[0]]);
    expect(fileText(fx.repo, 'src/util.js')).toBe(EDITED_UTIL);
    expect(keepRefSha(fx.repo, fx.shas[1])).toBe(fx.shas[1]);
  });

  test('Stash: Pop on a dirty tree stops at the confirm bar; Cancel changes nothing; OK pops, keeps the local edit and the keep ref', async ({ page }) => {
    const fx = createStashedDirtyRepo();
    await openGraph(page, fx.repo);
    const dirtyBefore = porcelain(fx.repo);
    await runItem(page, 'stash-pop', 'stash pop');
    await expect(page.getByTestId('confirm-bar')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText(DIRTY_PROMPT);
    expect(stashShas(fx.repo)).toHaveLength(2);
    expect(porcelain(fx.repo)).toBe(dirtyBefore);
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
    expect(stashShas(fx.repo)).toHaveLength(2);
    expect(keepRefSha(fx.repo, fx.shas[1])).toBeNull(); // nothing was popped, so no keep ref yet

    await runItem(page, 'stash-pop', 'stash pop');
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => stashShas(fx.repo)).toEqual([fx.shas[0]]);
    expect(keepRefSha(fx.repo, fx.shas[1])).toBe(fx.shas[1]);
    expect(fileText(fx.repo, 'README.md')).toContain('local edit'); // the user's own edit is still there
    expect(fileText(fx.repo, 'src/util.js')).toBe(EDITED_UTIL);
  });

  test('Stash: Apply on a dirty tree also stops at the confirm bar; OK applies and the stash stays', async ({ page }) => {
    const fx = createStashedDirtyRepo();
    await openGraph(page, fx.repo);
    await runItem(page, 'stash-apply', 'stash apply');
    await expect(page.getByTestId('confirm-message')).toHaveText(DIRTY_PROMPT);
    expect(fileText(fx.repo, 'src/util.js')).toBe(ORIGINAL.util);
    await page.getByTestId('confirm-cancel').click();
    expect(fileText(fx.repo, 'src/util.js')).toBe(ORIGINAL.util);
    await runItem(page, 'stash-apply', 'stash apply');
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => fileText(fx.repo, 'src/util.js')).toBe(EDITED_UTIL);
    expect(stashShas(fx.repo)).toHaveLength(2); // apply keeps the stash
  });

  test('Stash: Create stashes the working changes', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openGraph(page, repo);
    await runItem(page, 'stash-create', 'stash create');
    await expect.poll(() => stashShas(repo).length).toBe(1);
    expect(porcelain(repo)).toBe('');
  });
});
