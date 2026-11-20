import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import {
  APP_V1,
  APP_V2,
  BIDI_NAME,
  GUIDE_V2,
  blobBytes,
  createBidiRepo,
  createFileMenuRepo,
  readBytes,
  trashFiles,
} from './helpers/fileMenuFixtures';
import { gitOut } from './helpers/mergeFixtures';
import { TEST_TOKEN } from './helpers/repo';

/*
 * P2: right-click menu on the files of a COMMIT's details panel (path and tree mode). Spec: Obsidian Notes/gitslappin/Commit File Menu and Editor.md sections 2, 3, 5.
 * Fixture: helpers/fileMenuFixtures.ts (commits "Change files" (HEAD) and "Initial commit"; clean working folder).
 * Existing test ids used: repo-view, commit-row, commit-message, commit-details, file-list, file-row[data-path][data-status], toggle-path, toggle-tree, view-all-files,
 *   context-menu, menu-item[data-id], menu-divider, confirm-bar, confirm-message, confirm-ok, confirm-cancel, toast (title in toast-title), tool-undo[title],
 *   wip-details, file-history-view, file-history-title, file-history-entry, file-history-blame-toggle[aria-pressed].
 * NEW test ids / behaviour the builder must provide (+):
 *  + menu-item data-id values: file-history, file-blame, file-difftool, file-editor, file-default, file-show, file-copy-path, file-edit, file-delete, file-restore
 *  + confirm-checkbox   the "Don't ask again" checkbox inside confirm-bar (an <input type=checkbox>; its label text "Don't ask again" is inside confirm-bar)
 *  + the info toasts "Deleted '<path>'" and "File Restored Successfully" are `toast` elements whose text (title or detail) contains that wording
 *  + tool-undo title after a delete: "Undo delete file '<path>'" (journal label from spec section 4 S6)
 *  + GET/PUT /api/prefs accepts and returns the boolean promptBeforeRestoreFile (default true)
 * Launch items (file-difftool, file-editor, file-default, file-show) are NEVER clicked here: on the desktop build they would start real programs.
 * UNVERIFIED: the exact toast element used for the info toasts; that the copied path uses the server's repo root string (compared here case-insensitively, slash-normalised);
 *   that a D row's Edit / Delete items are shown (spec section 2 only hides History, Blame, Restore for status D).
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

const LABEL: Record<string, string> = {
  'file-history': 'File History',
  'file-blame': 'File Blame',
  'file-difftool': 'Open in external diff tool',
  'file-editor': 'Open in external editor',
  'file-default': 'Open file in default program',
  'file-show': 'Show in folder',
  'file-copy-path': 'Copy file path',
  'file-edit': 'Edit file',
  'file-delete': 'Delete file',
  'file-restore': 'Restore file from this commit',
};

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = (page: Page, subject: string) => page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: new RegExp(`^${esc(subject)}$`) }) });
const fileRow = (page: Page, path: string) => page.locator(`[data-testid="commit-details"] [data-testid="file-row"][data-path="${path}"]`);
const item = (page: Page, id: string) => page.getByTestId('context-menu').locator(`[data-testid="menu-item"][data-id="${id}"]`);
const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/** Resets the "ask before restore" pref (the test server's prefs are shared by every test); the PUT only succeeds once the builder adds the key. */
async function resetPrompt(request: import('@playwright/test').APIRequestContext): Promise<void> {
  await request.put('/api/prefs', { headers, data: { promptBeforeRestoreFile: true } });
}
test.beforeEach(async ({ request }) => resetPrompt(request));
test.afterEach(async ({ request }) => resetPrompt(request));

async function openGraph(page: Page, repo: string, desktop = true): Promise<void> {
  // The menu hides the OS-launch group unless /api/ping says desktop === true; force it either way so the test does not depend on the host.
  await page.route('**/api/ping*', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, desktop } });
  });
  await page.request.put('/api/prefs', { headers, data: { autoFetchMinutes: 0 } });
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
async function selectCommit(page: Page, subject: string): Promise<void> {
  await row(page, subject).click();
  await expect(page.getByTestId('commit-details')).toBeVisible();
  await expect(page.getByTestId('file-list')).toBeVisible();
}
async function menuOn(page: Page, path: string): Promise<void> {
  await fileRow(page, path).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}
/** The menu in DOM order: each item's data-id, "|" for a divider. */
async function menuSequence(page: Page): Promise<string[]> {
  return page
    .getByTestId('context-menu')
    .locator('[data-testid="menu-item"], [data-testid="menu-divider"]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') === 'menu-divider' ? '|' : (e.getAttribute('data-id') ?? ''))));
}

const FULL = ['file-history', 'file-blame', '|', 'file-difftool', 'file-editor', 'file-default', 'file-show', '|', 'file-copy-path', '|', 'file-edit', 'file-delete', '|', 'file-restore'];
const DOCKER = ['file-history', 'file-blame', '|', 'file-copy-path', '|', 'file-edit', 'file-delete', '|', 'file-restore'];
const DELETED_ROW = ['file-difftool', 'file-editor', 'file-default', 'file-show', '|', 'file-copy-path', '|', 'file-edit', 'file-delete'];
const DELETED_ROW_DOCKER = ['file-copy-path', '|', 'file-edit', 'file-delete'];
const UNCHANGED_ROW = ['file-history', 'file-blame', '|', 'file-editor', 'file-default', 'file-show', '|', 'file-copy-path', '|', 'file-edit', 'file-delete', '|', 'file-restore'];

test.describe('menu content and order', () => {
  test('path mode: items in GitKraken order with dividers between the groups, exact labels', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Change files');
    await expect(page.getByTestId('file-list')).toHaveAttribute('data-mode', 'path');
    await menuOn(page, 'src/app.js');
    expect(await menuSequence(page)).toEqual(FULL);
    for (const [id, text] of Object.entries(LABEL)) await expect(item(page, id)).toHaveText(text);
  });

  test('tree mode: the same menu on a file nested in a folder', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Change files');
    await page.getByTestId('toggle-tree').click();
    await expect(page.getByTestId('file-list')).toHaveAttribute('data-mode', 'tree');
    await expect(page.getByTestId('tree-dir').first()).toBeVisible();
    await menuOn(page, 'src/app.js');
    expect(await menuSequence(page)).toEqual(FULL);
  });

  test('not desktop (Docker): the four OS-launch items are hidden and their divider goes with them', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo, false);
    await selectCommit(page, 'Change files');
    await menuOn(page, 'src/app.js');
    expect(await menuSequence(page)).toEqual(DOCKER);
    for (const id of ['file-difftool', 'file-editor', 'file-default', 'file-show']) await expect(item(page, id)).toHaveCount(0);
  });

  test('a deleted (D) row hides File History, File Blame and Restore (desktop and Docker)', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Change files');
    await expect(fileRow(page, 'src/gone.txt')).toHaveAttribute('data-status', 'D');
    await menuOn(page, 'src/gone.txt');
    expect(await menuSequence(page)).toEqual(DELETED_ROW);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
  });

  test('a deleted (D) row in Docker mode', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo, false);
    await selectCommit(page, 'Change files');
    await menuOn(page, 'src/gone.txt');
    expect(await menuSequence(page)).toEqual(DELETED_ROW_DOCKER);
  });

  test('an unchanged row ("View all files") has no external diff tool item', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Change files');
    await page.getByTestId('view-all-files').check();
    await expect(fileRow(page, 'README.md')).toHaveAttribute('data-status', 'unchanged');
    await menuOn(page, 'README.md');
    expect(await menuSequence(page)).toEqual(UNCHANGED_ROW);
  });

  test('right-click on a row opens the menu without opening the diff', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Change files');
    await menuOn(page, 'docs/guide.md');
    await expect(page.getByTestId('diff-view')).toHaveCount(0);
  });
});

test.describe('File History and File Blame', () => {
  test('File History opens the file history view for that file at that commit', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Change files');
    await menuOn(page, 'src/app.js');
    await item(page, 'file-history').click();
    await expect(page.getByTestId('file-history-view')).toBeVisible();
    await expect(page.getByTestId('file-history-title')).toHaveText('File History: src/app.js');
    await expect(page.getByTestId('file-history-entry').first()).toContainText('Change files');
    await expect(page.getByTestId('file-history-blame-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  test('File Blame opens the same view with blame already on', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Change files');
    await menuOn(page, 'src/app.js');
    await item(page, 'file-blame').click();
    await expect(page.getByTestId('file-history-view')).toBeVisible();
    await expect(page.getByTestId('file-history-title')).toHaveText('File History: src/app.js');
    await expect(page.getByTestId('file-history-blame-toggle')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('Copy file path', () => {
  test('puts the absolute path of the file in the working folder on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Change files');
    await menuOn(page, 'src/app.js');
    await item(page, 'file-copy-path').click();
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(isAbsolute(text)).toBe(true); // the test host is Windows (drive letter path)
    expect(norm(text)).toBe(norm(join(fx.repo, 'src', 'app.js')));
  });
});

test.describe('Delete file', () => {
  test('confirm text and buttons; Delete moves the file to the trash folder (bytes intact), shows the toast, and Undo brings it back', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Change files');
    await menuOn(page, 'docs/guide.md');
    await item(page, 'file-delete').click();
    await expect(page.getByTestId('confirm-message')).toHaveText("Are you sure you want to delete 'docs/guide.md'?");
    await expect(page.getByTestId('confirm-ok')).toHaveText('Delete');
    await expect(page.getByTestId('confirm-cancel')).toHaveText('Cancel');
    expect(existsSync(join(fx.repo, 'docs', 'guide.md'))).toBe(true); // nothing happens before the answer
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
    await expect.poll(() => existsSync(join(fx.repo, 'docs', 'guide.md'))).toBe(false);
    const moved = trashFiles(fx.repo).filter((f) => f.rel === 'docs/guide.md');
    expect(moved).toHaveLength(1);
    expect(readFileSync(moved[0]!.abs)).toEqual(Buffer.from(GUIDE_V2));
    await expect(page.getByTestId('toast').filter({ hasText: "Deleted 'docs/guide.md'" })).toBeVisible();
    // the file is still tracked and listed as deleted in the working folder; the commit itself is untouched
    expect(gitOut(fx.repo, ['ls-files', '--', 'docs/guide.md']).trim()).toBe('docs/guide.md');

    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', "Undo delete file 'docs/guide.md'");
    await page.getByTestId('tool-undo').click();
    await expect.poll(() => existsSync(join(fx.repo, 'docs', 'guide.md'))).toBe(true);
    expect(readBytes(fx.repo, 'docs/guide.md')).toEqual(Buffer.from(GUIDE_V2));
  });

  test('Cancel changes nothing: file stays, no trash folder is created', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Change files');
    await menuOn(page, 'docs/guide.md');
    await item(page, 'file-delete').click();
    await expect(page.getByTestId('confirm-message')).toHaveText("Are you sure you want to delete 'docs/guide.md'?"); // the code path ran
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
    expect(readBytes(fx.repo, 'docs/guide.md')).toEqual(Buffer.from(GUIDE_V2));
    expect(trashFiles(fx.repo)).toEqual([]);
    expect(existsSync(join(fx.repo, '.git', 'gitslappin-trash'))).toBe(false);
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('security: a path with a bidi override character is shown as a visible escape in the confirm text, never raw', async ({ page }) => {
    const repo = createBidiRepo();
    await openGraph(page, repo);
    await selectCommit(page, 'Add bidi file');
    await page.locator(`[data-testid="commit-details"] [data-testid="file-row"][data-path="${BIDI_NAME}"]`).click({ button: 'right' });
    await item(page, 'file-delete').click();
    const text = (await page.getByTestId('confirm-message').textContent()) ?? '';
    expect(text).not.toContain('‮');
    expect(text.toLowerCase()).toContain('202e'); // displayPath turns it into a visible escape that names the code point
    expect(text.startsWith("Are you sure you want to delete 'bidi")).toBe(true);
    await page.getByTestId('confirm-cancel').click();
    expect(existsSync(join(repo, BIDI_NAME))).toBe(true);
  });
});

test.describe('Restore file from this commit', () => {
  const APP = 'src/app.js';
  const PROMPT = 'Restoring src/app.js will overwrite your local changes. Are you sure you want to continue?';

  test('with a local change: prompt text, Don\'t ask again, Submit/Cancel; Submit restores working copy AND index to the commit bytes and selects the WIP', async ({ page }) => {
    const fx = createFileMenuRepo();
    writeFileSync(join(fx.repo, APP), 'local edit\n');
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Initial commit');
    await menuOn(page, APP);
    await item(page, 'file-restore').click();
    await expect(page.getByTestId('confirm-message')).toHaveText(PROMPT);
    await expect(page.getByTestId('confirm-bar')).toContainText("Don't ask again");
    await expect(page.getByTestId('confirm-checkbox')).not.toBeChecked();
    await expect(page.getByTestId('confirm-ok')).toHaveText('Submit');
    await expect(page.getByTestId('confirm-cancel')).toHaveText('Cancel');
    expect(readBytes(fx.repo, APP)).toEqual(Buffer.from('local edit\n')); // nothing happens before the answer
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
    await expect.poll(() => readBytes(fx.repo, APP).toString()).toBe(APP_V1);
    expect(readBytes(fx.repo, APP)).toEqual(blobBytes(fx.repo, fx.initial, APP));
    // working copy and index both match the commit: HEAD (APP_V2) differs from the index, the working copy does not differ from the index
    expect(gitOut(fx.repo, ['diff', '--cached', '--name-only']).trim()).toBe(APP);
    expect(gitOut(fx.repo, ['diff', '--name-only']).trim()).toBe('');
    await expect(page.getByTestId('toast').filter({ hasText: 'File Restored Successfully' })).toBeVisible();
    await expect(page.getByTestId('wip-details')).toBeVisible();
  });

  test('a staged-only change also prompts', async ({ page }) => {
    const fx = createFileMenuRepo();
    writeFileSync(join(fx.repo, APP), 'staged edit\n');
    gitOut(fx.repo, ['add', '--', APP]);
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Initial commit');
    await menuOn(page, APP);
    await item(page, 'file-restore').click();
    await expect(page.getByTestId('confirm-message')).toHaveText(PROMPT);
    await page.getByTestId('confirm-cancel').click();
    expect(readBytes(fx.repo, APP)).toEqual(Buffer.from('staged edit\n'));
  });

  test('no local changes: no prompt, the file is restored straight away', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Initial commit');
    expect(readBytes(fx.repo, APP).toString()).toBe(APP_V2); // working copy is HEAD's version
    await menuOn(page, APP);
    await item(page, 'file-restore').click();
    await expect.poll(() => readBytes(fx.repo, APP).toString()).toBe(APP_V1); // the restore ran ...
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0); // ... and never asked
    expect(readBytes(fx.repo, APP)).toEqual(blobBytes(fx.repo, fx.initial, APP));
  });

  test('Cancel changes nothing: working copy and index untouched', async ({ page }) => {
    const fx = createFileMenuRepo();
    writeFileSync(join(fx.repo, APP), 'local edit\n');
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Initial commit');
    await menuOn(page, APP);
    await item(page, 'file-restore').click();
    await expect(page.getByTestId('confirm-message')).toHaveText(PROMPT); // the code path ran
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
    expect(readBytes(fx.repo, APP)).toEqual(Buffer.from('local edit\n'));
    expect(gitOut(fx.repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('"Don\'t ask again" saves the pref and suppresses the next prompt', async ({ page, request }) => {
    const fx = createFileMenuRepo();
    writeFileSync(join(fx.repo, APP), 'local edit\n');
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Initial commit');
    await menuOn(page, APP);
    await item(page, 'file-restore').click();
    await expect(page.getByTestId('confirm-message')).toHaveText(PROMPT);
    await page.getByTestId('confirm-checkbox').check();
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => readBytes(fx.repo, APP).toString()).toBe(APP_V1);
    const prefs = (await (await request.get('/api/prefs', { headers })).json()) as { promptBeforeRestoreFile?: boolean };
    expect(prefs.promptBeforeRestoreFile).toBe(false);
    // a second local change: restore goes straight through
    writeFileSync(join(fx.repo, APP), 'second local edit\n');
    await selectCommit(page, 'Initial commit');
    await menuOn(page, APP);
    await item(page, 'file-restore').click();
    await expect.poll(() => readBytes(fx.repo, APP).toString()).toBe(APP_V1);
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
  });

  test('Submit without ticking the box keeps asking next time (pref stays true)', async ({ page, request }) => {
    const fx = createFileMenuRepo();
    writeFileSync(join(fx.repo, APP), 'local edit\n');
    await openGraph(page, fx.repo);
    await selectCommit(page, 'Initial commit');
    await menuOn(page, APP);
    await item(page, 'file-restore').click();
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => readBytes(fx.repo, APP).toString()).toBe(APP_V1);
    const prefs = (await (await request.get('/api/prefs', { headers })).json()) as { promptBeforeRestoreFile?: boolean };
    expect(prefs.promptBeforeRestoreFile).toBe(true);
    writeFileSync(join(fx.repo, APP), 'again\n');
    await selectCommit(page, 'Initial commit');
    await menuOn(page, APP);
    await item(page, 'file-restore').click();
    await expect(page.getByTestId('confirm-message')).toHaveText(PROMPT);
    await page.getByTestId('confirm-cancel').click();
  });
});
