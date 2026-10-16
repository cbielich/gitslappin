import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { EOL } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { TEST_TOKEN, createRepo } from './helpers/repo';
import { cachedNames, gitOut } from './helpers/stagingFixtures';

/*
 * V3 Ignore (build notes "V3 design (Ignore)" + "V3 + V4 audit fixes"). Test ids this file expects (new ones marked +).
 * Existing: repo-view, commit-row, wip-row, wip-details, wip-unstaged, wip-staged, wip-file-row[data-path], wip-toggle-tree, wip-tree-dir,
 *   context-menu, context-submenu, menu-item, confirm-bar[data-kind], confirm-message, confirm-cancel, tool-undo, toast, toast-title.
 *  + wip-tree-dir gets data-path="<dir path without trailing slash>" (the row's folder, e.g. "src") and a right-click menu.
 *  + confirm-bar[data-kind="ignore"]: confirm-message, confirm-ignore (button "Ignore"), confirm-ignore-untrack (button "Ignore and Stop Tracking"),
 *    confirm-cancel ("Cancel"). The bar appears only when a target is tracked; untracked-only targets are written with no bar.
 * Menu (right-click an UNSTAGED, not-yet-ignored file row): top item "Ignore" with a submenu (context-submenu) of
 *   "Ignore '<basename>'", "All files with the extension '<ext>'" (only when the file has an extension),
 *   "All files in '<parent folder basename>/'" (only when the parent is not the top level).
 *   With several rows selected (ctrl+click): ONE top item "Ignore N files" (no submenu). Tree-view folder row: "Ignore all files in '<dir>/'".
 *   No Ignore item on staged rows.
 * Route: POST /api/repos/:id/ignore { paths: string[], mode: 'file'|'ext'|'folder', untrack: boolean }.
 * Strings (en-us.json): Ignore, IgnoreFile, IgnoreNFiles, AllFilesWithSameExtension, AllFilesInFolder, IgnoreAllFilesInFolder,
 *   PromptIgnore-Message ("Ignore '{0}'?"), PromptIgnoreMultiple-Message ("Ignore {0} files?"), PromptIgnore-Ignore,
 *   PromptIgnore-IgnoreAndUntrack ("Ignore and Stop Tracking"), CancelButtonLabel, Error-IgnoreFilesFailed.
 * UNVERIFIED (chosen here): the {0} of IgnoreFile / PromptIgnore-Message is the file's basename; the extension {0} may or may not carry the dot
 *   (matched with an optional dot); the confirm-bar buttons' test ids above; undo tooltip "Undo ignore 'name'" / "Undo ignore N files".
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

/** Committed: README.md, src/app.js, src/lib.js. Working tree: README.md edited (tracked), untracked notes.log, LICENSE, src/scratch.tmp, src/other.tmp. */
function createIgnoreRepo(): string {
  const repo = createRepo('ignore', [{ message: 'Initial files', files: { 'README.md': '# t\n', 'src/app.js': 'a1\n', 'src/lib.js': 'l1\n' } }]);
  gitOut(repo, ['config', 'user.name', 'Test Author']);
  gitOut(repo, ['config', 'user.email', 'author@example.com']);
  gitOut(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'README.md'), '# t edited\n');
  writeFileSync(join(repo, 'notes.log'), 'n\n');
  writeFileSync(join(repo, 'LICENSE'), 'l\n');
  writeFileSync(join(repo, 'src/scratch.tmp'), 's\n');
  writeFileSync(join(repo, 'src/other.tmp'), 'o\n');
  return repo;
}

const gitignoreBytes = (repo: string): string => readFileSync(join(repo, '.gitignore'), 'utf8');
const porcelain = (repo: string): string => gitOut(repo, ['status', '--porcelain=v1', '-uall']);

async function openWip(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
  await page.getByTestId('wip-row').click();
  await expect(page.getByTestId('wip-details')).toBeVisible();
}
async function openRepoApi(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.post('/api/repos/open', { headers, data: { path } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}
const wipRow = (page: Page, section: 'unstaged' | 'staged', path: string) =>
  page.getByTestId(`wip-${section}`).locator(`[data-testid="wip-file-row"][data-path="${path}"]`);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const menuItem = (page: Page, text: string | RegExp) =>
  page.getByTestId('context-menu').getByTestId('menu-item').filter({ hasText: typeof text === 'string' ? new RegExp(`^\\s*${esc(text)}\\s*$`) : text });
const subItem = (page: Page, text: string | RegExp) =>
  page.getByTestId('context-submenu').getByTestId('menu-item').filter({ hasText: typeof text === 'string' ? new RegExp(`^\\s*${esc(text)}\\s*$`) : text });
const bar = (page: Page) => page.locator('[data-testid="confirm-bar"][data-kind="ignore"]');

async function rightClickRow(page: Page, path: string): Promise<void> {
  await wipRow(page, 'unstaged', path).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}
/** Right-click a file row, open the Ignore submenu, click the sub item. */
async function ignoreVia(page: Page, path: string, item: string | RegExp): Promise<void> {
  await rightClickRow(page, path);
  await menuItem(page, 'Ignore').hover();
  await expect(page.getByTestId('context-submenu')).toBeVisible();
  await subItem(page, item).click();
}

test.describe('menu', () => {
  test('a nested file with an extension: Ignore submenu holds the file, the extension and the folder items', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await rightClickRow(page, 'src/scratch.tmp');
    await expect(menuItem(page, 'Discard changes')).toBeVisible();
    await menuItem(page, 'Ignore').hover();
    await expect(page.getByTestId('context-submenu')).toBeVisible();
    await expect(subItem(page, "Ignore 'scratch.tmp'")).toBeVisible();
    await expect(subItem(page, /^\s*All files with the extension '\.?tmp'\s*$/)).toBeVisible();
    await expect(subItem(page, "All files in 'src/'")).toBeVisible();
    await expect(page.getByTestId('context-submenu').getByTestId('menu-item')).toHaveCount(3);
  });

  test('a top-level file without an extension: only the file item (no extension item, no folder item)', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await rightClickRow(page, 'LICENSE');
    await menuItem(page, 'Ignore').hover();
    await expect(subItem(page, "Ignore 'LICENSE'")).toBeVisible();
    await expect(page.getByTestId('context-submenu').getByTestId('menu-item')).toHaveCount(1);
  });

  test('a staged file has no Ignore item', async ({ page }) => {
    const repo = createIgnoreRepo();
    gitOut(repo, ['add', 'README.md']);
    await openWip(page, repo);
    await wipRow(page, 'staged', 'README.md').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await expect(menuItem(page, 'Ignore')).toHaveCount(0);
  });

  test('several selected files: one "Ignore N files" item', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await wipRow(page, 'unstaged', 'notes.log').click();
    await wipRow(page, 'unstaged', 'LICENSE').click({ modifiers: ['Control'] });
    await wipRow(page, 'unstaged', 'LICENSE').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await expect(menuItem(page, 'Ignore 2 files')).toBeVisible();
    await expect(menuItem(page, 'Ignore')).toHaveCount(0);
  });
});

test.describe('ignore untracked files (no bar)', () => {
  test('Ignore file: the row leaves the list, .gitignore appears with EOL pattern EOL, the file stays on disk', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    await ignoreVia(page, 'notes.log', "Ignore 'notes.log'");
    await expect(bar(page)).toHaveCount(0);
    await expect(wipRow(page, 'unstaged', 'notes.log')).toHaveCount(0);
    await expect(wipRow(page, 'unstaged', '.gitignore')).toBeVisible();
    expect(gitignoreBytes(repo)).toBe(`${EOL}notes.log${EOL}`);
    expect(readFileSync(join(repo, 'notes.log'), 'utf8')).toBe('n\n');
    expect(porcelain(repo)).not.toContain('notes.log');
  });

  test('All files with the extension: every .tmp file leaves, pattern is *.tmp', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await ignoreVia(page, 'src/scratch.tmp', /^\s*All files with the extension '\.?tmp'\s*$/);
    await expect(wipRow(page, 'unstaged', 'src/scratch.tmp')).toHaveCount(0);
    await expect(wipRow(page, 'unstaged', 'src/other.tmp')).toHaveCount(0);
    await expect(wipRow(page, 'unstaged', 'notes.log')).toBeVisible();
    expect(gitignoreBytes(repo)).toBe(`${EOL}*.tmp${EOL}`);
  });

  test('All files in the folder: pattern is src/ and the untracked files in it leave', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await ignoreVia(page, 'src/scratch.tmp', "All files in 'src/'");
    await expect(wipRow(page, 'unstaged', 'src/scratch.tmp')).toHaveCount(0);
    await expect(wipRow(page, 'unstaged', 'src/other.tmp')).toHaveCount(0);
    expect(gitignoreBytes(repo)).toBe(`${EOL}src/${EOL}`);
    expect(cachedNames(repo)).toContain('src/app.js'); // untrack was not asked for
  });

  test('multi-select: "Ignore 2 files" writes both patterns', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await wipRow(page, 'unstaged', 'notes.log').click();
    await wipRow(page, 'unstaged', 'LICENSE').click({ modifiers: ['Control'] });
    await wipRow(page, 'unstaged', 'LICENSE').click({ button: 'right' });
    await menuItem(page, 'Ignore 2 files').click();
    await expect(wipRow(page, 'unstaged', 'notes.log')).toHaveCount(0);
    await expect(wipRow(page, 'unstaged', 'LICENSE')).toHaveCount(0);
    const text = gitignoreBytes(repo);
    expect(text).toContain(`${EOL}notes.log${EOL}`);
    expect(text).toContain(`${EOL}LICENSE${EOL}`);
  });

  test('tree view: right-clicking a folder row offers "Ignore all files in \'src/\'" and ignores the folder', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await page.getByTestId('wip-toggle-tree').click();
    await expect(page.getByTestId('wip-file-list')).toHaveAttribute('data-mode', 'tree');
    const dir = page.locator('[data-testid="wip-tree-dir"][data-path="src"]');
    await dir.click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await menuItem(page, "Ignore all files in 'src/'").click();
    await expect(bar(page)).toHaveCount(0); // src/scratch.tmp and src/other.tmp are untracked; no tracked file is modified under src
    await expect(page.locator('[data-testid="wip-tree-dir"][data-path="src"]')).toHaveCount(0);
    expect(gitignoreBytes(repo)).toBe(`${EOL}src/${EOL}`);
  });
});

test.describe('tracked files: the bar', () => {
  test('Cancel changes nothing; "Ignore and Stop Tracking" gives a staged deletion and leaves the worktree bytes alone', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await ignoreVia(page, 'README.md', "Ignore 'README.md'");
    await expect(bar(page)).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText("Ignore 'README.md'?");
    await expect(page.getByTestId('confirm-ignore')).toHaveText('Ignore');
    await expect(page.getByTestId('confirm-ignore-untrack')).toHaveText('Ignore and Stop Tracking');
    await expect(page.getByTestId('confirm-cancel')).toHaveText('Cancel');
    await page.getByTestId('confirm-cancel').click();
    await expect(bar(page)).toHaveCount(0);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    expect(cachedNames(repo)).toContain('README.md');

    await ignoreVia(page, 'README.md', "Ignore 'README.md'");
    await page.getByTestId('confirm-ignore-untrack').click();
    await expect(bar(page)).toHaveCount(0);
    await expect(wipRow(page, 'staged', 'README.md')).toBeVisible();
    await expect(wipRow(page, 'unstaged', 'README.md')).toHaveCount(0);
    expect(porcelain(repo)).toContain('D  README.md');
    expect(cachedNames(repo)).not.toContain('README.md');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# t edited\n');
    expect(gitignoreBytes(repo)).toBe(`${EOL}README.md${EOL}`);
  });

  test('plain "Ignore" on a tracked file writes the pattern but keeps it in the index', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await ignoreVia(page, 'README.md', "Ignore 'README.md'");
    await page.getByTestId('confirm-ignore').click();
    await expect(bar(page)).toHaveCount(0);
    expect(cachedNames(repo)).toContain('README.md');
    expect(gitignoreBytes(repo)).toBe(`${EOL}README.md${EOL}`);
  });

  test('a mixed selection (tracked + untracked) shows the bar with "Ignore 2 files?"', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await wipRow(page, 'unstaged', 'README.md').click();
    await wipRow(page, 'unstaged', 'notes.log').click({ modifiers: ['Control'] });
    await wipRow(page, 'unstaged', 'notes.log').click({ button: 'right' });
    await menuItem(page, 'Ignore 2 files').click();
    await expect(bar(page)).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText('Ignore 2 files?');
    expect(existsSync(join(repo, '.gitignore'))).toBe(false); // nothing written before the user chooses
  });
});

test.describe('undo', () => {
  test('Ctrl+Z after ignoring a file: it returns to the list and the created .gitignore is emptied, never deleted', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await ignoreVia(page, 'notes.log', "Ignore 'notes.log'");
    await expect(wipRow(page, 'unstaged', 'notes.log')).toHaveCount(0);
    await expect(page.getByTestId('tool-undo')).toBeEnabled();
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', "Undo ignore 'notes.log'");
    await expect(page.getByTestId('toolbar-busy')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(wipRow(page, 'unstaged', 'notes.log')).toBeVisible();
    expect(existsSync(join(repo, '.gitignore'))).toBe(true);
    expect(statSync(join(repo, '.gitignore')).size).toBe(0);
  });

  test('Ctrl+Z after Ignore and Stop Tracking puts the file back as an unstaged change', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await ignoreVia(page, 'README.md', "Ignore 'README.md'");
    await page.getByTestId('confirm-ignore-untrack').click();
    await expect(wipRow(page, 'staged', 'README.md')).toBeVisible();
    await expect(page.getByTestId('tool-undo')).toBeEnabled();
    await expect(page.getByTestId('toolbar-busy')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(wipRow(page, 'unstaged', 'README.md')).toBeVisible();
    await expect(wipRow(page, 'staged', 'README.md')).toHaveCount(0);
    expect(cachedNames(repo)).toContain('README.md');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# t edited\n');
  });

  test('undo is refused (toast "Undo Failed") after a hand edit of the created .gitignore, and the file is untouched', async ({ page }) => {
    const repo = createIgnoreRepo();
    await openWip(page, repo);
    await ignoreVia(page, 'notes.log', "Ignore 'notes.log'");
    await expect(wipRow(page, 'unstaged', 'notes.log')).toHaveCount(0);
    writeFileSync(join(repo, '.gitignore'), `${EOL}notes.log${EOL}my-own-rule${EOL}`);
    await expect(page.getByTestId('tool-undo')).toBeEnabled();
    await expect(page.getByTestId('toolbar-busy')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('toast-title').filter({ hasText: 'Undo Failed' })).toBeVisible();
    expect(gitignoreBytes(repo)).toBe(`${EOL}notes.log${EOL}my-own-rule${EOL}`);
  });
});

test.describe('route guards (API)', () => {
  test('needs the token (403 without it)', async ({ request }) => {
    const repo = createIgnoreRepo();
    const id = await openRepoApi(request, repo);
    const res = await request.post(`/api/repos/${id}/ignore`, { data: { paths: ['notes.log'], mode: 'file', untrack: false } });
    expect(res.status()).toBe(403);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  test('refuses (4xx, nothing written) a path not in status, a ".." path, a newline name, an empty list and an unknown mode', async ({ request }) => {
    const repo = createIgnoreRepo();
    const id = await openRepoApi(request, repo);
    const bodies: unknown[] = [
      { paths: ['src/app.js'], mode: 'file', untrack: false }, // tracked and clean: not in status
      { paths: ['../outside.txt'], mode: 'file', untrack: false },
      { paths: ['no/such/file.txt'], mode: 'file', untrack: false },
      { paths: ['notes.log\nsecret'], mode: 'file', untrack: false },
      { paths: [], mode: 'file', untrack: false },
      { paths: ['notes.log'], mode: 'bogus', untrack: false },
      { paths: ['notes.log'], mode: 'file' }, // untrack missing
    ];
    for (const data of bodies) {
      const res = await request.post(`/api/repos/${id}/ignore`, { headers, data: data as object });
      expect(res.status(), JSON.stringify(data)).toBeGreaterThanOrEqual(400);
      expect(res.status(), JSON.stringify(data)).toBeLessThan(500);
    }
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  test('the client never chooses the pattern text: an extra "pattern" field is ignored', async ({ request }) => {
    const repo = createIgnoreRepo();
    const id = await openRepoApi(request, repo);
    const res = await request.post(`/api/repos/${id}/ignore`, { headers, data: { paths: ['notes.log'], mode: 'file', untrack: false, pattern: '*' } });
    expect(res.status()).toBe(200);
    expect(gitignoreBytes(repo)).toBe(`${EOL}notes.log${EOL}`);
  });

  test('untrack acts only on tracked paths: an untracked path with untrack=true changes nothing in the index', async ({ request }) => {
    const repo = createIgnoreRepo();
    const id = await openRepoApi(request, repo);
    const before = cachedNames(repo);
    const res = await request.post(`/api/repos/${id}/ignore`, { headers, data: { paths: ['notes.log'], mode: 'file', untrack: true } });
    expect(res.status()).toBe(200);
    expect(cachedNames(repo)).toEqual(before);
    expect(readFileSync(join(repo, 'notes.log'), 'utf8')).toBe('n\n');
  });

  test('untrack of a file named like a glob (only possible off Windows) removes just that file', async ({ request }) => {
    test.skip(process.platform === 'win32', 'Windows cannot create a file named "*.txt"; the int test covers this through the index');
    const repo = createRepo('ignore-glob', [{ message: 'Base', files: { 'a.txt': 'a\n', 'b.txt': 'b\n', '*.txt': 'star\n' } }]);
    writeFileSync(join(repo, '*.txt'), 'star edited\n');
    const id = await openRepoApi(request, repo);
    const res = await request.post(`/api/repos/${id}/ignore`, { headers, data: { paths: ['*.txt'], mode: 'file', untrack: true } });
    expect(res.status()).toBe(200);
    expect(cachedNames(repo)).toEqual(['a.txt', 'b.txt']);
  });
});
