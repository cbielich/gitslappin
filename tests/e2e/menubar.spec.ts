import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { TEST_TOKEN } from './helpers/repo';
import { createLaneRepo } from './helpers/interactionFixtures';
import { createDirtyStashRepo, fileText, porcelain, EDITED_APP, ORIGINAL } from './helpers/stashFixtures';

/*
 * V6 "4 Toolbar, menu bar, terminal": the menu bar gets real menus (wording from en-us.json menuStrings, lines 29-137).
 * Existing: menubar (the bar), statusbar-zoom, activity-log-panel, preferences-view, clone-modal, init-modal, open-repo-view, confirm-*, tool-undo.
 * NEW (+):
 *  + menubar-item[data-id]   one per top menu: File, Edit, View, Help (text = the name); click opens its menu, a second click or Esc or a click outside closes it;
 *                            while one menu is open, hovering another top item switches to it. aria-expanded on the item.
 *  + menubar-menu            the open dropdown;  menubar-entry[data-id]  one per row (data-id = the menuStrings key below);  menubar-entry-label  the label text;
 *                            a row that cannot act now has aria-disabled="true" and clicking it does nothing;  menubar-divider between groups.
 * Rows (data-id: label), in this order:
 *   File: NewTab "New Tab", CloneRepo "Clone Repo...", InitRepo "Init Repo...", OpenRepo "Open Repo...", OpenRepoManagement "Open Repo Management",
 *         OpenTerminal "Open External Terminal", OpenInFileManager "Open in File Manager", Preferences "Preferences..."
 *   Edit: Undo "Undo", Redo "Redo"
 *   View: ToggleFullScreen "Toggle Full Screen", ZoomIn "Increase Zoom", ZoomOut "Decrease Zoom", ZoomReset "Reset Zoom", ShowLeftPanel "Show Left Panel",
 *         ShowDetailPanel "Show Commit Details Panel", ShowTerminalPanel "Show Terminal Panel", ReloadWindow "Reload Window"
 *   Help: KeyboardShortcuts "Keyboard Shortcuts", OpenFuzzyFinder "Open Command Palette", ViewActivityLogs "View Activity Logs"
 * Cut (must be absent): Cut, Copy, Paste, Select All, Sign In, Quit, Developer tools, Relaunch, Favorites, Window items.
 * UNVERIFIED: "Preferences..." label wording (the design names it; menuStrings has no such key); Open Repo... and Open Repo Management both land on the Open view (assumed);
 *   when GET /api/ping answers desktop:false the two terminal / file-manager rows are aria-disabled (design is silent; chosen so the 409 path is never offered).
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };
const top = (page: Page, name: string) => page.locator(`[data-testid="menubar-item"][data-id="${name}"]`);
const entry = (page: Page, id: string) => page.locator(`[data-testid="menubar-entry"][data-id="${id}"]`);
const menu = (page: Page) => page.getByTestId('menubar-menu');
async function openMenu(page: Page, name: string): Promise<void> {
  await top(page, name).click();
  await expect(menu(page)).toBeVisible();
}
const entryIds = (page: Page): Promise<(string | null)[]> => menu(page).getByTestId('menubar-entry').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
const entryLabels = (page: Page): Promise<string[]> => menu(page).getByTestId('menubar-entry-label').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));

async function openGraph(page: Page, repo: string): Promise<void> {
  const res = await page.request.put('/api/prefs', { headers, data: { autoFetchMinutes: 0, zoom: 1 } });
  expect(res.status()).toBe(200);
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}

test.describe('menus and their rows', () => {
  test('the bar has File, Edit, View, Help in that order; no menu is open at first', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    const names = await page.getByTestId('menubar-item').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
    expect(names).toEqual(['File', 'Edit', 'View', 'Help']);
    await expect(menu(page)).toHaveCount(0);
  });

  test('File rows', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await openMenu(page, 'File');
    expect(await entryIds(page)).toEqual(['NewTab', 'CloneRepo', 'InitRepo', 'OpenRepo', 'OpenRepoManagement', 'OpenTerminal', 'OpenInFileManager', 'Preferences']);
    const l = await entryLabels(page);
    expect(l.slice(0, 7)).toEqual(['New Tab', 'Clone Repo...', 'Init Repo...', 'Open Repo...', 'Open Repo Management', 'Open External Terminal', 'Open in File Manager']);
    expect(l[7]).toMatch(/^Preferences/);
  });

  test('Edit rows (Cut / Copy / Paste / Select All are cut)', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await openMenu(page, 'Edit');
    expect(await entryIds(page)).toEqual(['Undo', 'Redo']);
    expect(await entryLabels(page)).toEqual(['Undo', 'Redo']);
  });

  test('View rows', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await openMenu(page, 'View');
    expect(await entryIds(page)).toEqual(['ToggleFullScreen', 'ZoomIn', 'ZoomOut', 'ZoomReset', 'ShowLeftPanel', 'ShowDetailPanel', 'ShowTerminalPanel', 'ReloadWindow']);
    expect(await entryLabels(page)).toEqual(['Toggle Full Screen', 'Increase Zoom', 'Decrease Zoom', 'Reset Zoom', 'Show Left Panel', 'Show Commit Details Panel', 'Show Terminal Panel', 'Reload Window']);
  });

  test('Help rows', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await openMenu(page, 'Help');
    expect(await entryIds(page)).toEqual(['KeyboardShortcuts', 'OpenFuzzyFinder', 'ViewActivityLogs']);
    expect(await entryLabels(page)).toEqual(['Keyboard Shortcuts', 'Open Command Palette', 'View Activity Logs']);
  });

  test('opening, switching by hover, toggling, Esc and an outside click', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await top(page, 'File').click();
    await expect(top(page, 'File')).toHaveAttribute('aria-expanded', 'true');
    await top(page, 'Help').hover();
    expect(await entryIds(page)).toContain('OpenFuzzyFinder');
    await expect(top(page, 'Help')).toHaveAttribute('aria-expanded', 'true');
    await expect(top(page, 'File')).toHaveAttribute('aria-expanded', 'false');
    await top(page, 'Help').click();
    await expect(menu(page)).toHaveCount(0);
    await top(page, 'View').click();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await top(page, 'View').click();
    await page.getByTestId('commit-row').first().click();
    await expect(menu(page)).toHaveCount(0);
  });
});

test.describe('what the rows do', () => {
  test('File: New Tab / Open Repo... / Open Repo Management show the Open view; Clone Repo... and Init Repo... open their modals; Preferences... opens Preferences', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await openMenu(page, 'File');
    await entry(page, 'NewTab').click();
    await expect(page.getByTestId('open-repo-view')).toBeVisible();
    await openMenu(page, 'File');
    await entry(page, 'CloneRepo').click();
    await expect(page.getByTestId('clone-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('clone-modal')).toHaveCount(0);
    await openMenu(page, 'File');
    await entry(page, 'InitRepo').click();
    await expect(page.getByTestId('init-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('init-modal')).toHaveCount(0);
    await openMenu(page, 'File');
    await entry(page, 'Preferences').click();
    await expect(page.getByTestId('preferences-view')).toBeVisible();
  });

  test('File: Open External Terminal and Open in File Manager call their routes (stubbed) with no path', async ({ page }) => {
    const calls: { route: string; body: string | null }[] = [];
    for (const route of ['open-terminal', 'open-folder']) {
      await page.route(`**/api/repos/*/${route}`, (r) => {
        calls.push({ route, body: r.request().postData() });
        return r.fulfill({ status: 200, json: { ok: true } });
      });
    }
    await openGraph(page, createLaneRepo());
    await openMenu(page, 'File');
    await entry(page, 'OpenTerminal').click();
    await expect.poll(() => calls.map((c) => c.route)).toEqual(['open-terminal']);
    await openMenu(page, 'File');
    await entry(page, 'OpenInFileManager').click();
    await expect.poll(() => calls.map((c) => c.route)).toEqual(['open-terminal', 'open-folder']);
    for (const c of calls) expect(c.body ?? '').not.toContain('gitslappin-tests');
  });

  test('when the server says it is not a desktop (ping desktop:false) the terminal and file-manager rows are disabled and send nothing', async ({ page }) => {
    let hits = 0;
    await page.route('**/api/ping', async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await r.fulfill({ response: res, json: { ...body, desktop: false } });
    });
    await page.route(/\/api\/repos\/[^/]+\/open-(terminal|folder)$/, (r) => {
      hits++;
      return r.fulfill({ status: 200, json: { ok: true } });
    });
    await openGraph(page, createLaneRepo());
    await openMenu(page, 'File');
    await expect(entry(page, 'OpenTerminal')).toHaveAttribute('aria-disabled', 'true');
    await expect(entry(page, 'OpenInFileManager')).toHaveAttribute('aria-disabled', 'true');
    await entry(page, 'OpenTerminal').click({ force: true });
    await page.waitForTimeout(400);
    expect(hits).toBe(0);
    await expect(entry(page, 'NewTab')).not.toHaveAttribute('aria-disabled', 'true'); // not everything is disabled
  });

  // Edit menu entries mirror the toolbar. Undo of a discard is never redoable by design (undo.ts: discard is not recorded on the redo side).
  test('Edit: Undo and Redo follow the toolbar state; Undo undoes a discard, Redo stays off after it', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openGraph(page, repo);
    await openMenu(page, 'Edit');
    await expect(entry(page, 'Undo')).toHaveAttribute('aria-disabled', 'true');
    await expect(entry(page, 'Redo')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    const before = porcelain(repo);
    await page.getByTestId('wip-row').click();
    await page.getByTestId('discard-all').click();
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => porcelain(repo)).toBe('');
    await expect(page.getByTestId('tool-undo')).toBeEnabled();
    await openMenu(page, 'Edit');
    await expect(entry(page, 'Undo')).not.toHaveAttribute('aria-disabled', 'true');
    await entry(page, 'Undo').click();
    await expect.poll(() => porcelain(repo)).toBe(before);
    expect(fileText(repo, 'src/app.js')).toBe(EDITED_APP);
    await expect(page.getByTestId('tool-redo')).toBeDisabled();
    await openMenu(page, 'Edit');
    await expect(entry(page, 'Redo')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    expect(porcelain(repo)).toBe(before);
  });

  test('View: zoom rows change the zoom like the keys; Show Left Panel / Show Commit Details Panel toggle the panels', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await expect(page.getByTestId('statusbar-zoom')).toContainText('100%');
    await openMenu(page, 'View');
    await entry(page, 'ZoomIn').click();
    await expect(page.getByTestId('statusbar-zoom')).toContainText('110%');
    await openMenu(page, 'View');
    await entry(page, 'ZoomOut').click();
    await openMenu(page, 'View');
    await entry(page, 'ZoomOut').click();
    await expect(page.getByTestId('statusbar-zoom')).toContainText('90%');
    await openMenu(page, 'View');
    await entry(page, 'ZoomReset').click();
    await expect(page.getByTestId('statusbar-zoom')).toContainText('100%');

    await page.getByTestId('commit-row').first().click();
    await expect(page.getByTestId('left-panel')).toBeVisible();
    await openMenu(page, 'View');
    await entry(page, 'ShowLeftPanel').click();
    await expect(page.getByTestId('left-panel')).toBeHidden();
    await openMenu(page, 'View');
    await entry(page, 'ShowLeftPanel').click();
    await expect(page.getByTestId('left-panel')).toBeVisible();
    await expect(page.getByTestId('commit-details')).toBeVisible();
    await openMenu(page, 'View');
    await entry(page, 'ShowDetailPanel').click();
    await expect(page.getByTestId('commit-details')).toBeHidden();
  });

  test('View: Toggle Full Screen enters full screen; Reload Window reloads the page', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await openMenu(page, 'View');
    await entry(page, 'ToggleFullScreen').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await page.keyboard.press('Control+Shift+F');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    await openMenu(page, 'View');
    await entry(page, 'ReloadWindow').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __marker?: number }).__marker ?? 0)).toBe(0);
    await expect(page.getByTestId('menubar')).toBeVisible();
  });

  test('Help: Keyboard Shortcuts opens the list, Open Command Palette opens the palette, View Activity Logs opens the log', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await openMenu(page, 'Help');
    await entry(page, 'KeyboardShortcuts').click();
    await expect(page.getByTestId('View-KeyBindings')).toBeVisible();
    await page.keyboard.press('Escape');
    await openMenu(page, 'Help');
    await entry(page, 'OpenFuzzyFinder').click();
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await expect(page.getByTestId('palette-input')).toHaveAttribute('placeholder', 'Search for commands and actions (e.g., Open Repo)');
    await page.keyboard.press('Escape');
    await openMenu(page, 'Help');
    await entry(page, 'ViewActivityLogs').click();
    await expect(page.getByTestId('activity-log-panel')).toBeVisible();
  });

  test('with no repo open the menus still work: Help -> Open Command Palette shows the palette without repo-only items', async ({ page }) => {
    await gotoOpenView(page);
    await openMenu(page, 'Help');
    await entry(page, 'OpenFuzzyFinder').click();
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.getByTestId('palette-input').fill('create branch');
    await expect(page.getByTestId('palette-item')).toHaveCount(0);
  });
});
