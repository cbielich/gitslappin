import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { TEST_TOKEN } from './helpers/repo';
import { LANE, createLaneRepo } from './helpers/interactionFixtures';
import { git, originAdvance, createRemoteFx } from './helpers/remoteFixtures';
import { commitCount, createDirtyStashRepo, headMessage, porcelain, stagedNames } from './helpers/stashFixtures';

/*
 * V6 "2 Shortcuts and the Ctrl+/ list" + audit security 6. Fixtures: helpers/interactionFixtures.ts (lane repo), helpers/stashFixtures.ts (dirty repo: modified src/app.js + untracked notes/todo.txt).
 * Existing test ids: repo-view, commit-row[data-selected], commit-message, wip-row, wip-unstaged, wip-staged, wip-file-row[data-path], commit-summary, commit-button, discard-all,
 *   confirm-bar, confirm-cancel, branch-input, context-menu, left-panel, commit-details, repo-tab, repo-tab-name, tab-add, tool-terminal.
 * NEW (+):
 *  + View-KeyBindings   the Ctrl+/ modal (title text "Keyboard Shortcuts"); toggles with Ctrl+/, closes on Esc
 *  + KeyBindingFilter-Placeholder   its filter input, placeholder "Filter shortcuts (Ctrl + F)" (typing filters the rows by label)
 *  + KeyBindingHeader-RepoActions | -Navigation | -FuzzyFinder | -UI   section headers: "Repo Actions", "Navigation", "Command Palette", "UI"
 *  + KeyBinding-<id>    one row per entry of KEYBINDING_ROWS (ids in client/src/lib/shortcuts.v6.test.ts); row text = label + the key caps (e.g. "Create Branch" ... "Ctrl" "B")
 *  + tabs-list, tabs-list-item[data-id]   the Ctrl+Shift+A overlay listing the open tabs (item text = tab name); Enter / click selects
 * Keys use Playwright's page.keyboard. The browser tab reserves Ctrl+T/W/Tab in a normal window; Playwright sends the key straight to the page, so those are testable here.
 * UNVERIFIED: Ctrl+Shift+F is asserted through document.fullscreenElement; "Shift+Down in branch" follows first parents (design); Left/Right move focus INTO left-panel / commit-details.
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };
const row = (page: Page, subject: string) => page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: new RegExp(`^${subject}$`) }) });
const selectedSubject = async (page: Page): Promise<string> => ((await page.locator('[data-testid="commit-row"][data-selected="true"]').first().getByTestId('commit-message').textContent()) ?? '').trim();
const wipFile = (page: Page, section: 'unstaged' | 'staged', path: string) => page.getByTestId(`wip-${section}`).locator(`[data-testid="wip-file-row"][data-path="${path}"]`);

async function openGraph(page: Page, repo: string): Promise<void> {
  const res = await page.request.put('/api/prefs', { headers, data: { autoFetchMinutes: 0 } });
  expect(res.status()).toBe(200);
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
async function openWipWithFile(page: Page, repo: string, path = 'src/app.js'): Promise<void> {
  await openGraph(page, repo);
  await page.getByTestId('wip-row').click();
  await expect(page.getByTestId('wip-details')).toBeVisible();
  await wipFile(page, 'unstaged', path).click();
}
/** A keydown with e.repeat = true, as an auto-repeating held key sends it. */
async function repeated(page: Page, init: { key: string; ctrlKey?: boolean; shiftKey?: boolean }): Promise<void> {
  await page.evaluate((i) => {
    (document.activeElement instanceof HTMLElement ? document.activeElement : document.body).dispatchEvent(new KeyboardEvent('keydown', { ...i, repeat: true, bubbles: true, cancelable: true }));
  }, init);
}

test.describe('Ctrl+/ shortcuts list', () => {
  test('opens with the title, the filter, the four headers and the 38 reference rows; Ctrl+/ again and Esc close it', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await page.keyboard.press('Control+/');
    const modal = page.getByTestId('View-KeyBindings');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Keyboard Shortcuts');
    await expect(page.getByTestId('KeyBindingFilter-Placeholder')).toHaveAttribute('placeholder', 'Filter shortcuts (Ctrl + F)');
    await expect(page.getByTestId('KeyBindingHeader-RepoActions')).toHaveText('Repo Actions');
    await expect(page.getByTestId('KeyBindingHeader-Navigation')).toHaveText('Navigation');
    await expect(page.getByTestId('KeyBindingHeader-FuzzyFinder')).toHaveText('Command Palette');
    await expect(page.getByTestId('KeyBindingHeader-UI')).toHaveText('UI');
    await expect(page.locator('[data-testid^="KeyBinding-"]')).toHaveCount(38);
    await expect(page.getByTestId('KeyBinding-CreateBranch')).toContainText('Create Branch');
    await expect(page.getByTestId('KeyBinding-CreateBranch')).toContainText('Ctrl');
    await expect(page.getByTestId('KeyBinding-CreateBranch')).toContainText('B');
    await expect(page.getByTestId('KeyBinding-OpenInDefaultTerminal')).toContainText('Open in default terminal');
    await expect(page.getByTestId('KeyBinding-OpenInDefaultTerminal')).toContainText('Alt');
    // the cut rows are not there
    await expect(modal).not.toContainText('External Diff/Merge Tool');
    await expect(page.getByTestId('KeyBinding-ToggleTerminalPanel')).toContainText('Toggle Terminal Panel'); // V6b
    await page.keyboard.press('Control+/');
    await expect(modal).toHaveCount(0);
    await page.keyboard.press('Control+/');
    await expect(modal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  test('the filter narrows the rows by label', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await page.keyboard.press('Control+/');
    await page.getByTestId('KeyBindingFilter-Placeholder').fill('stage');
    for (const id of ['Stage', 'Unstage', 'StageAll', 'UnstageAll', 'CommitWithStage']) await expect(page.getByTestId(`KeyBinding-${id}`)).toBeVisible();
    await expect(page.getByTestId('KeyBinding-CreateBranch')).toHaveCount(0);
    await expect(page.getByTestId('KeyBinding-FullScreen')).toHaveCount(0);
    await page.getByTestId('KeyBindingFilter-Placeholder').fill('zzzz-nothing');
    await expect(page.locator('[data-testid^="KeyBinding-"]')).toHaveCount(0);
  });

  test('Ctrl+/ works with no repo tab open', async ({ page }) => {
    await gotoOpenView(page);
    await page.keyboard.press('Control+/');
    await expect(page.getByTestId('View-KeyBindings')).toBeVisible();
  });
});

test.describe('repo actions', () => {
  test('Ctrl+B opens the create-branch input', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await expect(page.getByTestId('branch-input')).toHaveCount(0);
    await page.keyboard.press('Control+b');
    await expect(page.getByTestId('branch-input')).toBeVisible();
  });

  test('Ctrl+L fetches all remotes', async ({ page }) => {
    const fx = createRemoteFx();
    await openGraph(page, fx.a);
    const sha = originAdvance(fx, { 'new-on-origin.txt': 'x\n' }, 'Origin moved');
    await page.keyboard.press('Control+l');
    await expect.poll(() => git(fx.a, ['rev-parse', 'refs/remotes/origin/main']).trim()).toBe(sha);
  });

  test('S / U stage / unstage the selected file; Ctrl+Shift+S / Ctrl+Shift+U stage / unstage all', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openWipWithFile(page, repo);
    expect(stagedNames(repo)).toEqual([]);
    await page.keyboard.press('s');
    await expect.poll(() => stagedNames(repo)).toEqual(['src/app.js']); // only the selected file
    await page.keyboard.press('u');
    await expect.poll(() => stagedNames(repo)).toEqual([]);
    await page.keyboard.press('Control+Shift+S');
    await expect.poll(() => stagedNames(repo)).toEqual(['notes/todo.txt', 'src/app.js']);
    await page.keyboard.press('Control+Shift+U');
    await expect.poll(() => stagedNames(repo)).toEqual([]);
  });

  test('Ctrl+Shift+M focuses the commit message; Ctrl+Shift+Enter in it stages everything and commits', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openWipWithFile(page, repo);
    const before = commitCount(repo);
    await page.keyboard.press('Control+Shift+M');
    await expect(page.getByTestId('commit-summary')).toBeFocused();
    await page.getByTestId('commit-summary').fill('Committed with the shortcut');
    await page.keyboard.press('Control+Shift+Enter');
    await expect.poll(() => commitCount(repo)).toBe(before + 1);
    expect(headMessage(repo)).toBe('Committed with the shortcut');
    expect(porcelain(repo)).toBe('');
  });

  test('Ctrl+Shift+Enter outside the message field does nothing', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openWipWithFile(page, repo);
    const before = commitCount(repo);
    await page.keyboard.press('Control+Shift+Enter');
    await page.waitForTimeout(500);
    expect(commitCount(repo)).toBe(before);
    expect(stagedNames(repo)).toEqual([]);
  });

  test('Alt+T and the palette item Open in default terminal call open-terminal with no path; a 409 shows the error text', async ({ page }) => {
    const calls: string[] = [];
    await page.route('**/api/repos/*/open-terminal', (r) => {
      calls.push(`${r.request().method()} ${r.request().url()} ${r.request().postData() ?? ''}`);
      return r.fulfill({ status: calls.length >= 3 ? 409 : 200, json: calls.length >= 3 ? { error: 'Not available here.' } : { ok: true } });
    });
    await openGraph(page, createLaneRepo());
    await page.keyboard.press('Alt+t');
    await expect.poll(() => calls.length).toBe(1);
    await page.keyboard.press('Control+p'); // V6b: the toolbar Terminal button is now the panel toggle; the palette item stays
    await page.getByTestId('palette-input').fill('default terminal');
    await page.keyboard.press('Enter');
    await expect.poll(() => calls.length).toBe(2);
    for (const c of calls) {
      expect(c).toMatch(/^POST /);
      expect(c).not.toContain('gitslappin-tests');
    }
    await page.keyboard.press('Alt+t');
    await expect(page.getByTestId('toast')).toContainText('Failed to open repo in terminal'); // Error-OpenRepoInTerminalFailed
  });
});

test.describe('graph navigation', () => {
  test('arrows and J / K move through the rows; Ctrl+Home / Ctrl+End jump to the first / last', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await row(page, LANE.main3).click();
    expect(await selectedSubject(page)).toBe(LANE.main3);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => selectedSubject(page)).toBe(LANE.side);
    await page.keyboard.press('j');
    await expect.poll(() => selectedSubject(page)).toBe(LANE.main2);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => selectedSubject(page)).toBe(LANE.side);
    await page.keyboard.press('k');
    await expect.poll(() => selectedSubject(page)).toBe(LANE.main3);
    await page.keyboard.press('Control+End');
    await expect.poll(() => selectedSubject(page)).toBe(LANE.base);
    await page.keyboard.press('Control+Home');
    await expect.poll(() => selectedSubject(page)).toBe(LANE.main3);
  });

  test('Shift+Down / Shift+Up follow the first parent in the same branch (skipping the other lane)', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await row(page, LANE.main3).click();
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(() => selectedSubject(page)).toBe(LANE.main2); // not "Lane side 1"
    await page.keyboard.press('Shift+ArrowUp');
    await expect.poll(() => selectedSubject(page)).toBe(LANE.main3);
    await page.keyboard.press('Shift+J');
    await expect.poll(() => selectedSubject(page)).toBe(LANE.main2);
    await page.keyboard.press('Shift+K');
    await expect.poll(() => selectedSubject(page)).toBe(LANE.main3);
  });

  test('Left / Right (H / L) move focus between the left panel, the graph and the details', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await row(page, LANE.main2).click();
    const focusIn = (testid: string) => page.evaluate((t) => !!document.querySelector(`[data-testid="${t}"]`)?.contains(document.activeElement), testid);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => focusIn('left-panel')).toBe(true);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => focusIn('left-panel')).toBe(false);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => focusIn('commit-details')).toBe(true);
    await page.keyboard.press('h');
    await expect.poll(() => focusIn('commit-details')).toBe(false);
  });

  test('single-letter keys do nothing while typing in a text field', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openWipWithFile(page, repo);
    await page.getByTestId('commit-summary').click();
    await page.keyboard.type('sujklh');
    await expect(page.getByTestId('commit-summary')).toHaveValue('sujklh');
    expect(stagedNames(repo)).toEqual([]);
  });
});

test.describe('UI toggles and tabs', () => {
  test('Ctrl+J toggles the left panel, Ctrl+K the commit details panel', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await row(page, LANE.main2).click();
    await expect(page.getByTestId('left-panel')).toBeVisible();
    await expect(page.getByTestId('commit-details')).toBeVisible();
    await page.keyboard.press('Control+j');
    await expect(page.getByTestId('left-panel')).toBeHidden();
    await page.keyboard.press('Control+j');
    await expect(page.getByTestId('left-panel')).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('commit-details')).toBeHidden();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('commit-details')).toBeVisible();
  });

  test('Ctrl+Shift+F toggles full screen', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
    await page.keyboard.press('Control+Shift+F');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await page.keyboard.press('Control+Shift+F');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  });

  test('Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+1..9 switch tabs; Ctrl+Shift+A lists them', async ({ page }) => {
    const a = createLaneRepo();
    const b = createDirtyStashRepo();
    await openGraph(page, a);
    await page.getByTestId('tab-add').click();
    await openRepoByPath(page, b);
    await expect(page.getByTestId('repo-tab')).toHaveCount(2);
    const active = () => page.locator('[data-testid="repo-tab"][aria-selected="true"]').getByTestId('repo-tab-name').textContent();
    const nameA = (await page.getByTestId('repo-tab-name').nth(0).textContent())!;
    const nameB = (await page.getByTestId('repo-tab-name').nth(1).textContent())!;
    expect(await active()).toBe(nameB);
    await page.keyboard.press('Control+1');
    await expect.poll(active).toBe(nameA);
    await page.keyboard.press('Control+Tab');
    await expect.poll(active).toBe(nameB);
    await page.keyboard.press('Control+Shift+Tab');
    await expect.poll(active).toBe(nameA);
    await page.keyboard.press('Control+2');
    await expect.poll(active).toBe(nameB);
    await page.keyboard.press('Control+9'); // no such tab: nothing changes
    expect(await active()).toBe(nameB);
    await page.keyboard.press('Control+Shift+A');
    await expect(page.getByTestId('tabs-list')).toBeVisible();
    await expect(page.getByTestId('tabs-list-item')).toHaveCount(2);
    await page.getByTestId('tabs-list-item').filter({ hasText: nameA }).click();
    await expect.poll(active).toBe(nameA);
    await expect(page.getByTestId('tabs-list')).toHaveCount(0);
  });

  test('Ctrl+D and Ctrl+` (cut) do nothing', async ({ page }) => {
    await openGraph(page, createLaneRepo());
    await page.keyboard.press('Control+d');
    await page.keyboard.press('Control+`');
    await page.waitForTimeout(300);
    await expect(page.getByTestId('repo-view')).toBeVisible();
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await expect(page.getByTestId('View-KeyBindings')).toHaveCount(0);
  });
});

test.describe('audit security 6: mutating shortcuts', () => {
  test('a repeating Ctrl+Shift+S / Ctrl+B / Ctrl+L does nothing; the same key pressed once does', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openWipWithFile(page, repo);
    await repeated(page, { key: 'S', ctrlKey: true, shiftKey: true });
    await repeated(page, { key: 's' });
    await repeated(page, { key: 'b', ctrlKey: true });
    await page.waitForTimeout(400);
    expect(stagedNames(repo)).toEqual([]);
    await expect(page.getByTestId('branch-input')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+S'); // the code path runs for a normal press
    await expect.poll(() => stagedNames(repo)).toEqual(['notes/todo.txt', 'src/app.js']);
  });

  test('a repeating Ctrl+L does not fetch; a single one does', async ({ page }) => {
    const fx = createRemoteFx();
    await openGraph(page, fx.a);
    const before = git(fx.a, ['rev-parse', 'refs/remotes/origin/main']).trim();
    const sha = originAdvance(fx, { 'n.txt': 'x\n' }, 'Origin moved again');
    await repeated(page, { key: 'l', ctrlKey: true });
    await page.waitForTimeout(800);
    expect(git(fx.a, ['rev-parse', 'refs/remotes/origin/main']).trim()).toBe(before);
    await page.keyboard.press('Control+l');
    await expect.poll(() => git(fx.a, ['rev-parse', 'refs/remotes/origin/main']).trim()).toBe(sha);
  });

  test('a repeating Ctrl+Shift+Enter in the message field does not commit', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openWipWithFile(page, repo);
    const before = commitCount(repo);
    await page.getByTestId('commit-summary').fill('Should not commit on repeat');
    await repeated(page, { key: 'Enter', ctrlKey: true, shiftKey: true });
    await page.waitForTimeout(500);
    expect(commitCount(repo)).toBe(before);
    await page.keyboard.press('Control+Shift+Enter');
    await expect.poll(() => commitCount(repo)).toBe(before + 1);
  });

  test('while the discard confirm bar is open, mutating shortcuts do nothing; after Cancel they work', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openWipWithFile(page, repo);
    await page.getByTestId('discard-all').click();
    await expect(page.getByTestId('confirm-bar')).toBeVisible();
    for (const k of ['Control+Shift+S', 'Control+b', 'Control+l', 's']) await page.keyboard.press(k);
    await page.waitForTimeout(400);
    expect(stagedNames(repo)).toEqual([]);
    await expect(page.getByTestId('branch-input')).toHaveCount(0);
    await expect(page.getByTestId('confirm-bar')).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
    await page.keyboard.press('Control+Shift+S');
    await expect.poll(() => stagedNames(repo)).toEqual(['notes/todo.txt', 'src/app.js']);
  });

  test('review fix: navigation keys and Alt+T are also ignored while a confirm bar (any testid) is open', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openWipWithFile(page, repo);
    await page.getByTestId('discard-all').click();
    await expect(page.locator('.confirm-bar[role="alertdialog"]')).toBeVisible();
    for (const k of ['j', 'k', 'Control+j', 'Control+k', 'Control+Home', 'Alt+t']) await page.keyboard.press(k);
    await page.waitForTimeout(300);
    await expect(page.getByTestId('left-panel')).toBeVisible();
    await expect(page.locator('.confirm-bar[role="alertdialog"]')).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
  });

  test('while the shortcuts modal is open, Ctrl+B and Ctrl+Shift+S do nothing', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openWipWithFile(page, repo);
    await page.keyboard.press('Control+/');
    await expect(page.getByTestId('View-KeyBindings')).toBeVisible();
    await page.keyboard.press('Control+b');
    await page.keyboard.press('Control+Shift+S');
    await page.waitForTimeout(400);
    await expect(page.getByTestId('branch-input')).toHaveCount(0);
    expect(stagedNames(repo)).toEqual([]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+b');
    await expect(page.getByTestId('branch-input')).toBeVisible();
  });

  test('while a context menu is open, Ctrl+L does nothing; after Esc it fetches', async ({ page }) => {
    const fx = createRemoteFx();
    await openGraph(page, fx.a);
    const before = git(fx.a, ['rev-parse', 'refs/remotes/origin/main']).trim();
    const sha = originAdvance(fx, { 'n2.txt': 'x\n' }, 'Origin moved third time');
    await page.getByTestId('commit-row').first().click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.keyboard.press('Control+l');
    await page.waitForTimeout(800);
    expect(git(fx.a, ['rev-parse', 'refs/remotes/origin/main']).trim()).toBe(before);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
    await page.keyboard.press('Control+l');
    await expect.poll(() => git(fx.a, ['rev-parse', 'refs/remotes/origin/main']).trim()).toBe(sha);
  });

  test('while the palette is open, Ctrl+B and Ctrl+Shift+S do nothing', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openWipWithFile(page, repo);
    await page.keyboard.press('Control+p');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.keyboard.press('Control+b');
    await page.keyboard.press('Control+Shift+S');
    await page.waitForTimeout(400);
    await expect(page.getByTestId('branch-input')).toHaveCount(0);
    expect(stagedNames(repo)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
  });

  test('Ctrl+Shift+S / Ctrl+Shift+U do nothing while a text input has focus', async ({ page }) => {
    const repo = createDirtyStashRepo();
    await openWipWithFile(page, repo);
    await page.getByTestId('commit-summary').click();
    await page.keyboard.press('Control+Shift+S');
    await page.waitForTimeout(400);
    expect(stagedNames(repo)).toEqual([]);
  });
});
