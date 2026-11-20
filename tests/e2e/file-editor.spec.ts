import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { APP_V2, BIN_V2, BOM, CRLF_V2, createFileMenuRepo, readBytes } from './helpers/fileMenuFixtures';
import { gitOut } from './helpers/mergeFixtures';
import { TEST_TOKEN } from './helpers/repo';

/*
 * P3: "Edit in Working Directory" button on commit diffs and the in-app file editor (Save / Cancel). Spec: Obsidian Notes/gitslappin/Commit File Menu and Editor.md sections 3, 5 (C7), 6.
 * Fixture: helpers/fileMenuFixtures.ts (HEAD "Change files": src/app.js, docs/guide.md, crlf.txt (BOM + CRLF), bin.dat (binary), src/gone.txt (deleted in that commit)).
 * Existing test ids used: repo-view, commit-row, commit-message, commit-details, file-row[data-path], diff-view, diff-path, wip-row, wip-file-row[data-path], context-menu, menu-item[data-id].
 * NEW test ids the builder must provide (+):
 *  + diff-edit-workdir   button "Edit in Working Directory" in DiffView's left toolbar; present on a commit diff, absent on a WIP diff
 *  + file-editor         root of the editor (takes the diff slot); attribute data-value = the live editor text (LF model, no BOM), like merge-output; contains a Monaco editor
 *  + file-editor-title   header text "File Editor"
 *  + editor-save         button "Save";  editor-cancel  button "Cancel"
 *  + editor-error        inline error text inside file-editor (stale save, missing file, any refusal); the editor stays open
 *  + editor-binary       text "Binary File" shown instead of Monaco for a binary file (no Monaco, no Save needed)
 * Strings: header "File Editor", "Save", "Cancel", "Binary File", "Edit in Working Directory" (spec section 3); the stale text "The file changed on disk since it was opened. Open it again." (from the conductor's brief).
 * UNVERIFIED: Cancel closes the editor even when it has unsaved typing (spec C7 only says it "stays open while dirty" against refreshes); the editor shows nothing but editor-error for
 *   a file that is not in the working folder (D row); Save with no typing is not tested.
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };
const STALE = 'The file changed on disk since it was opened. Open it again.';

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = (page: Page, subject: string) => page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: new RegExp(`^${esc(subject)}$`) }) });
const fileRow = (page: Page, path: string) => page.locator(`[data-testid="commit-details"] [data-testid="file-row"][data-path="${path}"]`);
const editor = (page: Page) => page.getByTestId('file-editor');

async function openGraph(page: Page, repo: string): Promise<void> {
  await page.request.put('/api/prefs', { headers, data: { autoFetchMinutes: 0 } });
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
async function selectHead(page: Page): Promise<void> {
  await row(page, 'Change files').click();
  await expect(page.getByTestId('commit-details')).toBeVisible();
  await expect(page.getByTestId('file-list')).toBeVisible();
}
/** Opens the commit diff of a file and the editor from the "Edit in Working Directory" button. */
async function openFromButton(page: Page, path: string): Promise<void> {
  await selectHead(page);
  await fileRow(page, path).click();
  await expect(page.getByTestId('diff-view')).toBeVisible();
  await page.getByTestId('diff-edit-workdir').click();
  await expect(editor(page)).toBeVisible({ timeout: 20_000 });
}
async function openFromMenu(page: Page, path: string): Promise<void> {
  await selectHead(page);
  await fileRow(page, path).click({ button: 'right' });
  await page.getByTestId('context-menu').locator('[data-testid="menu-item"][data-id="file-edit"]').click();
  await expect(editor(page)).toBeVisible({ timeout: 20_000 });
}
/** Types at the very end of the file (Monaco: click, Ctrl+End, type) once the editor shows the file text. */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  await expect(editor(page)).not.toHaveAttribute('data-value', '');
  await editor(page).locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

test.describe('Edit in Working Directory button', () => {
  test('shows on a commit diff and opens the editor with the header "File Editor" and the WORKING copy text', async ({ page }) => {
    const fx = createFileMenuRepo();
    writeFileSync(join(fx.repo, 'src/app.js'), 'working copy text\n');
    await openGraph(page, fx.repo);
    await selectHead(page);
    await fileRow(page, 'src/app.js').click();
    await expect(page.getByTestId('diff-view')).toBeVisible();
    await expect(page.getByTestId('diff-edit-workdir')).toHaveText('Edit in Working Directory');
    await page.getByTestId('diff-edit-workdir').click();
    await expect(editor(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('file-editor-title')).toHaveText('File Editor');
    await expect(page.getByTestId('editor-save')).toHaveText('Save');
    await expect(page.getByTestId('editor-cancel')).toHaveText('Cancel');
    await expect(editor(page)).toHaveAttribute('data-value', 'working copy text\n'); // not the commit's APP_V2
  });

  test('is not on a WIP diff', async ({ page }) => {
    const fx = createFileMenuRepo();
    writeFileSync(join(fx.repo, 'docs/guide.md'), 'wip edit\n');
    await openGraph(page, fx.repo);
    await page.getByTestId('wip-row').click();
    await page.locator('[data-testid="wip-file-row"][data-path="docs/guide.md"]').click();
    await expect(page.getByTestId('diff-view')).toBeVisible();
    await expect(page.getByTestId('diff-path')).toContainText('docs/guide.md');
    await expect(page.getByTestId('diff-edit-workdir')).toHaveCount(0);
  });
});

test.describe('Save and Cancel', () => {
  test('Save writes the typed text to the working file (LF), closes the editor, and never stages it', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await openFromButton(page, 'src/app.js');
    await typeAtEnd(page, 'three\n');
    await expect(editor(page)).toHaveAttribute('data-value', APP_V2 + 'three\n');
    expect(readBytes(fx.repo, 'src/app.js')).toEqual(Buffer.from(APP_V2)); // nothing is written while typing
    await page.getByTestId('editor-save').click();
    await expect(editor(page)).toHaveCount(0);
    expect(readBytes(fx.repo, 'src/app.js')).toEqual(Buffer.from(APP_V2 + 'three\n'));
    expect(gitOut(fx.repo, ['diff', '--cached', '--name-only']).trim()).toBe(''); // never stages
  });

  test('CRLF and the BOM are preserved: unchanged lines keep CRLF, the new line uses the file\'s CRLF, the BOM stays', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await openFromButton(page, 'crlf.txt');
    await typeAtEnd(page, 'added line\n');
    await page.getByTestId('editor-save').click();
    await expect(editor(page)).toHaveCount(0);
    const bytes = readBytes(fx.repo, 'crlf.txt');
    expect(bytes).toEqual(Buffer.concat([BOM, Buffer.from('a\r\nb changed\r\nc\r\nadded line\r\n')]));
    expect(bytes.subarray(0, 3)).toEqual(BOM);
    expect(bytes.toString('latin1')).not.toMatch(/[^\r]\n/); // no bare LF anywhere
  });

  test('Cancel changes nothing: the editor closes and the file bytes stay', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await openFromButton(page, 'crlf.txt');
    await typeAtEnd(page, 'will not be saved\n');
    await expect(editor(page)).toHaveAttribute('data-value', /will not be saved/); // the code path ran
    await page.getByTestId('editor-cancel').click();
    await expect(editor(page)).toHaveCount(0);
    expect(readBytes(fx.repo, 'crlf.txt')).toEqual(CRLF_V2);
    expect(gitOut(fx.repo, ['status', '--porcelain']).trim()).toBe('');
  });
});

test.describe('stale file on disk', () => {
  test('a change on disk after the editor opened is not overwritten: Save shows the stale message and the editor stays open', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await openFromButton(page, 'src/app.js');
    await expect(editor(page)).toHaveAttribute('data-value', APP_V2);
    await typeAtEnd(page, 'mine\n'); // dirty first: the spec says a dirty editor stays open through live refreshes
    await expect(editor(page)).toHaveAttribute('data-value', APP_V2 + 'mine\n');
    writeFileSync(join(fx.repo, 'src/app.js'), 'changed behind the editor\n');
    await page.getByTestId('editor-save').click();
    await expect(page.getByTestId('editor-error')).toHaveText(STALE);
    await expect(editor(page)).toBeVisible();
    expect(readBytes(fx.repo, 'src/app.js')).toEqual(Buffer.from('changed behind the editor\n')); // the external bytes win
  });
});

test.describe('binary and missing files', () => {
  test('a binary file shows "Binary File" instead of an editor', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await openFromMenu(page, 'bin.dat');
    await expect(page.getByTestId('editor-binary')).toHaveText('Binary File');
    await expect(editor(page).locator('.monaco-editor')).toHaveCount(0);
    expect(readBytes(fx.repo, 'bin.dat')).toEqual(BIN_V2);
  });

  test('a file that is not in the working folder (deleted in the commit) shows an error and is never created', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await selectHead(page);
    await expect(fileRow(page, 'src/gone.txt')).toHaveAttribute('data-status', 'D');
    await fileRow(page, 'src/gone.txt').click({ button: 'right' });
    await page.getByTestId('context-menu').locator('[data-testid="menu-item"][data-id="file-edit"]').click();
    await expect(page.getByTestId('editor-error')).toBeVisible();
    expect(existsSync(join(fx.repo, 'src/gone.txt'))).toBe(false);
    expect(gitOut(fx.repo, ['status', '--porcelain']).trim()).toBe('');
  });
});

test.describe('Edit file (menu)', () => {
  test('"Edit file" opens the editor with the file text, and Save from there writes it', async ({ page }) => {
    const fx = createFileMenuRepo();
    await openGraph(page, fx.repo);
    await openFromMenu(page, 'src/app.js');
    await expect(page.getByTestId('file-editor-title')).toHaveText('File Editor');
    await expect(editor(page)).toHaveAttribute('data-value', APP_V2);
    await typeAtEnd(page, 'from menu\n');
    await page.getByTestId('editor-save').click();
    await expect(editor(page)).toHaveCount(0);
    expect(readBytes(fx.repo, 'src/app.js')).toEqual(Buffer.from(APP_V2 + 'from menu\n'));
  });
});
