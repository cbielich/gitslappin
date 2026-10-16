import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView } from './helpers/app';
import { CLONE_SUBJECTS, createCloneFx, createExtRemoteRepo, createPickFx, extRan, freshDir, git } from './helpers/cloneFixtures';
import { createRepo } from './helpers/repo';

/*
 * V1 Repo management: the Open | Clone | Create screens (screens 20, 21, 21a, 21b, 22, 22a-e; en-us.json keys in the design's "Wording keys").
 * Test ids the builder must add (new). Existing ones used: tab-add, open-repo-view, repo-tab-name, repo-view, commit-row, commit-message,
 * file-row[data-path], folder-browser, folder-browser-entry, folder-browser-open, folder-browser-path.
 *
 *  Open view      open-view-open / open-view-clone / open-view-create   the three buttons, in this order, texts "Open", "Clone", "Create"
 *  Clone modal    clone-modal, clone-title ("Clone a Repository"), clone-heading ("Clone a Repo"), clone-close (the X),
 *                 clone-nav-item (one per left-nav entry; only "Clone with URL"), clone-parent-input (label "Where to clone to"), clone-browse ("Browse"),
 *                 clone-url-input (label "URL"), clone-fullpath (row labelled "Full path"; only present once a URL is typed; text = parent + separator + repo name),
 *                 clone-shallow-toggle ("Shallow Clone", checkbox), clone-sparse-toggle ("Sparse Checkout", checkbox), clone-submit ("Clone the repo!"),
 *                 clone-progress (while running: "Cloning into <path>" and "Cloning... NN%"), clone-cancel ("Cancel"),
 *                 clone-error (a failure box that starts with "Clone Failed"), clone-error-detail (the server's message / stderr)
 *    shallow form clone-branch-input (placeholder "default branch"), clone-limit-depth ("Commit depth", radio, default), clone-limit-since ("Since date", radio),
 *                 clone-depth-input ("Depth"), clone-since-input ("Since date"), clone-flags-input ("Custom flags")
 *    sparse form  clone-blobless-toggle ("Blobless clone"), clone-sparse-paths ("Paths to include", textarea)
 *  Create modal   init-modal, init-title ("Initialize a Repository"), init-heading ("Initialize a Repo"), init-close, init-nav-item (only "Local Only"),
 *                 init-name-input ("Name"), init-name-error, init-parent-input ("Initialize in"), init-browse ("Browse"),
 *                 init-fullpath ("Full path"; text = parent + separator + name), init-branch-input ("Default branch name", placeholder "main"),
 *                 init-branch-error ("Invalid branch name."), init-gitignore-input / init-license-input (searchable selects, placeholder "Select..."; typing filters),
 *                 init-gitignore-option / init-license-option (rows of the open list; text = id for .gitignore, title for licenses),
 *                 init-gitignore-clear / init-license-clear (the x, only when a value is chosen), init-submit ("Create Repository"), init-error (failure text + stderr)
 *  Folder browser in pick mode (opened from clone-browse / init-browse): same folder-browser-* ids; the footer button folder-browser-open reads "Select Folder"
 *                 (invented) and picks the CURRENT folder; double-click on a row enters it.
 * Behaviour assumed (the design leaves it open): the clone-submit button stays enabled for a URL/flag the server refuses, and the refusal shows in clone-error
 * with "Clone Failed" first; a successful clone or create closes the modal and opens the repo in a new tab (onOpened).
 * The webServer needs git identity env for the Create commit (GIT_AUTHOR_NAME/EMAIL + GIT_COMMITTER_NAME/EMAIL) because the global git config is empty: see the report.
 */

async function openClone(page: Page) {
  await gotoOpenView(page);
  await page.getByTestId('open-view-clone').click();
  await expect(page.getByTestId('clone-modal')).toBeVisible();
}
async function openCreate(page: Page) {
  await gotoOpenView(page);
  await page.getByTestId('open-view-create').click();
  await expect(page.getByTestId('init-modal')).toBeVisible();
}
async function pickOption(page: Page, field: 'gitignore' | 'license', typed: string, option: string) {
  await page.getByTestId(`init-${field}-input`).click();
  await page.getByTestId(`init-${field}-input`).fill(typed);
  await page.getByTestId(`init-${field}-option`).filter({ hasText: new RegExp(`^\\s*${option}\\s*$`) }).click();
}

test('the Open view has Open | Clone | Create in that order', async ({ page }) => {
  await gotoOpenView(page);
  const view = page.getByTestId('open-repo-view');
  await expect(view.getByTestId('open-view-open')).toHaveText('Open');
  await expect(view.getByTestId('open-view-clone')).toHaveText('Clone');
  await expect(view.getByTestId('open-view-create')).toHaveText('Create');
  const xs = await Promise.all(['open-view-open', 'open-view-clone', 'open-view-create'].map(async (id) => (await view.getByTestId(id).boundingBox())!.x));
  expect(xs[0]).toBeLessThan(xs[1]!);
  expect(xs[1]).toBeLessThan(xs[2]!);
});

test('Clone modal wording matches GitKraken, has only "Clone with URL" in the nav, and closes with X and with Esc', async ({ page }) => {
  await openClone(page);
  const m = page.getByTestId('clone-modal');
  await expect(m.getByTestId('clone-title')).toHaveText('Clone a Repository');
  await expect(m.getByTestId('clone-heading')).toHaveText('Clone a Repo');
  await expect(m.getByTestId('clone-nav-item')).toHaveText(['Clone with URL']);
  for (const hosted of ['GitHub.com', 'GitLab.com', 'Bitbucket.org', 'Azure DevOps']) await expect(m).not.toContainText(hosted);
  await expect(m).toContainText('Where to clone to');
  await expect(m.getByTestId('clone-browse')).toHaveText('Browse');
  await expect(m).toContainText('URL');
  await expect(m.getByTestId('clone-shallow-toggle')).toBeVisible();
  await expect(m).toContainText('Shallow Clone');
  await expect(m).toContainText('Sparse Checkout');
  await expect(m.getByTestId('clone-submit')).toHaveText('Clone the repo!');
  await expect(m.getByTestId('clone-fullpath')).toHaveCount(0); // the Full path row appears only once a URL is typed

  await m.getByTestId('clone-close').click();
  await expect(m).toHaveCount(0);
  await page.getByTestId('open-view-clone').click();
  await expect(page.getByTestId('clone-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('clone-modal')).toHaveCount(0);
});

test('typing a URL shows the Full path row = parent + repo name; Shallow and Sparse sections carry the GitKraken labels', async ({ page }) => {
  const fx = createCloneFx();
  await openClone(page);
  const m = page.getByTestId('clone-modal');
  await m.getByTestId('clone-parent-input').fill(fx.parent);
  await m.getByTestId('clone-url-input').fill('https://example.invalid/team/some-project.git');
  await expect(m.getByTestId('clone-fullpath')).toContainText('Full path');
  await expect(m.getByTestId('clone-fullpath')).toContainText('some-project');
  await expect(m.getByTestId('clone-fullpath')).toContainText(basename(fx.parent));

  await m.getByTestId('clone-shallow-toggle').check();
  await expect(m.getByTestId('clone-branch-input')).toHaveAttribute('placeholder', 'default branch');
  for (const t of ['Branch to clone', 'Limit history by', 'Commit depth', 'Since date', 'Depth', 'How many commits to clone from the target branch.', 'Custom flags']) await expect(m).toContainText(t);
  await m.getByTestId('clone-limit-since').check();
  await expect(m).toContainText('Commits older than this date will not be cloned.');
  await m.getByTestId('clone-since-input').fill('2025-02-30');
  await expect(m).toContainText("Enter a valid date in 'YYYY-MM-DD' format");
  const future = `${new Date().getFullYear() + 1}-01-01`;
  await m.getByTestId('clone-since-input').fill(future);
  await expect(m).toContainText('Date cannot be in the future');

  await m.getByTestId('clone-sparse-toggle').check();
  for (const t of ['Blobless clone', 'Paths to include', 'Enter one path per line.']) await expect(m).toContainText(t);
  await expect(m.getByTestId('clone-sparse-paths')).toHaveAttribute('placeholder', /src\//);
});

test('Create modal wording: single "Local Only" nav item, no LFS option, placeholders, button label; X and Esc close it', async ({ page }) => {
  await openCreate(page);
  const m = page.getByTestId('init-modal');
  await expect(m.getByTestId('init-title')).toHaveText('Initialize a Repository');
  await expect(m.getByTestId('init-heading')).toHaveText('Initialize a Repo');
  await expect(m.getByTestId('init-nav-item')).toHaveText(['Local Only']);
  for (const t of ['Name', 'Initialize in', 'Default branch name', '.gitignore Template (optional)', 'License (optional)']) await expect(m).toContainText(t);
  await expect(m).not.toContainText('Initialize with LFS');
  for (const hosted of ['GitHub.com', 'GitLab.com', 'Bitbucket.org', 'Azure DevOps']) await expect(m).not.toContainText(hosted);
  await expect(m.getByTestId('init-branch-input')).toHaveAttribute('placeholder', 'main');
  await expect(m.getByTestId('init-gitignore-input')).toHaveAttribute('placeholder', 'Select...');
  await expect(m.getByTestId('init-license-input')).toHaveAttribute('placeholder', 'Select...');
  await expect(m.getByTestId('init-submit')).toHaveText('Create Repository');
  await expect(m.getByTestId('init-browse')).toHaveText('Browse');

  await m.getByTestId('init-close').click();
  await expect(m).toHaveCount(0);
  await page.getByTestId('open-view-create').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('init-modal')).toHaveCount(0);
});

test('the .gitignore and License selects filter as you type, list GitKraken names, and clear with the x', async ({ page }) => {
  await openCreate(page);
  const m = page.getByTestId('init-modal');
  await m.getByTestId('init-gitignore-input').click();
  await m.getByTestId('init-gitignore-input').fill('nod');
  await expect(page.getByTestId('init-gitignore-option').filter({ hasText: /^\s*Node\s*$/ })).toBeVisible();
  await expect(page.getByTestId('init-gitignore-option').filter({ hasText: /^\s*Python\s*$/ })).toHaveCount(0);
  await page.getByTestId('init-gitignore-option').filter({ hasText: /^\s*Node\s*$/ }).click();
  await expect(m.getByTestId('init-gitignore-input')).toHaveValue('Node');
  await m.getByTestId('init-gitignore-clear').click();
  await expect(m.getByTestId('init-gitignore-input')).toHaveValue('');
  await m.getByTestId('init-license-input').click();
  await expect(page.getByTestId('init-license-option')).toHaveCount(17);
  await m.getByTestId('init-license-input').fill('mit');
  await expect(page.getByTestId('init-license-option').filter({ hasText: /^\s*MIT License\s*$/ })).toBeVisible();
});

test('Browse in the Clone modal is the folder browser in pick mode: double-click enters, "Select Folder" fills the field', async ({ page }) => {
  const { parent, inner } = createPickFx();
  await openClone(page);
  const m = page.getByTestId('clone-modal');
  await m.getByTestId('clone-parent-input').fill(parent);
  await m.getByTestId('clone-browse').click();
  const fb = page.getByTestId('folder-browser');
  await expect(fb).toBeVisible();
  await expect(fb.getByTestId('folder-browser-open')).toHaveText('Select Folder');
  await expect(fb.getByTestId('folder-browser-entry')).toHaveText(['inner']);
  await fb.getByTestId('folder-browser-entry').filter({ hasText: /^\s*inner\s*$/ }).dblclick();
  await expect(fb.getByTestId('folder-browser-path')).toContainText('inner');
  await fb.getByTestId('folder-browser-open').click();
  await expect(fb).toHaveCount(0);
  await expect(m.getByTestId('clone-parent-input')).toHaveValue(inner);
});

test('Browse in the Create modal also picks a folder', async ({ page }) => {
  const { parent, inner } = createPickFx();
  await openCreate(page);
  const m = page.getByTestId('init-modal');
  await m.getByTestId('init-parent-input').fill(parent);
  await m.getByTestId('init-browse').click();
  const fb = page.getByTestId('folder-browser');
  await expect(fb.getByTestId('folder-browser-open')).toHaveText('Select Folder');
  await fb.getByTestId('folder-browser-entry').filter({ hasText: /^\s*inner\s*$/ }).dblclick();
  await fb.getByTestId('folder-browser-open').click();
  await expect(m.getByTestId('init-parent-input')).toHaveValue(inner);
});

test('cloning a file:// repo closes the modal and opens it in a new tab with its history', async ({ page }) => {
  const fx = createCloneFx();
  await openClone(page);
  const m = page.getByTestId('clone-modal');
  await m.getByTestId('clone-parent-input').fill(fx.parent);
  await m.getByTestId('clone-url-input').fill(fx.url);
  await expect(m.getByTestId('clone-fullpath')).toContainText(fx.name);
  await m.getByTestId('clone-submit').click();
  await expect(page.getByTestId('repo-view')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('clone-modal')).toHaveCount(0);
  await expect(page.getByTestId('repo-tab-name').filter({ hasText: fx.name })).toBeVisible();
  await expect(page.getByTestId('commit-message')).toHaveText(CLONE_SUBJECTS);
  expect(existsSync(join(fx.target, '.git'))).toBe(true);
});

test('Shallow Clone with depth 1 shows exactly one commit', async ({ page }) => {
  const fx = createCloneFx();
  await openClone(page);
  const m = page.getByTestId('clone-modal');
  await m.getByTestId('clone-parent-input').fill(fx.parent);
  await m.getByTestId('clone-url-input').fill(fx.url);
  await m.getByTestId('clone-shallow-toggle').check();
  await m.getByTestId('clone-depth-input').fill('1');
  await m.getByTestId('clone-submit').click();
  await expect(page.getByTestId('repo-view')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('commit-row')).toHaveCount(1);
  await expect(page.getByTestId('commit-message')).toHaveText([CLONE_SUBJECTS[0]!]);
  expect(existsSync(join(fx.target, '.git', 'shallow'))).toBe(true);
});

test('an ext:: URL shows "Clone Failed", runs nothing and opens no tab', async ({ page }) => {
  const fx = createCloneFx();
  const { marker, url } = createExtRemoteRepo();
  await openClone(page);
  const m = page.getByTestId('clone-modal');
  await m.getByTestId('clone-parent-input').fill(fx.parent);
  await m.getByTestId('clone-url-input').fill(url);
  await m.getByTestId('clone-submit').click();
  await expect(m.getByTestId('clone-error')).toBeVisible({ timeout: 30_000 });
  await expect(m.getByTestId('clone-error')).toContainText('Clone Failed');
  expect(extRan(marker)).toBe(false);
  await expect(page.getByTestId('repo-tab-name')).toHaveCount(0);
  expect(readdirSync(fx.parent)).toEqual([]);
});

test('a custom flag outside the allow-list is refused and the message lists the allowed flags', async ({ page }) => {
  const fx = createCloneFx();
  await openClone(page);
  const m = page.getByTestId('clone-modal');
  await m.getByTestId('clone-parent-input').fill(fx.parent);
  await m.getByTestId('clone-url-input').fill(fx.url);
  await m.getByTestId('clone-shallow-toggle').check();
  await m.getByTestId('clone-flags-input').fill('--upload-pack=calc');
  await m.getByTestId('clone-submit').click();
  await expect(m.getByTestId('clone-error')).toContainText('Clone Failed');
  await expect(m.getByTestId('clone-error-detail')).toContainText('--no-tags');
  await expect(m.getByTestId('clone-error-detail')).toContainText('--single-branch');
  expect(readdirSync(fx.parent)).toEqual([]);
});

test('cloning into a folder that already has files is refused and the files are untouched', async ({ page }) => {
  const fx = createCloneFx();
  mkdirSync(fx.target);
  writeFileSync(join(fx.target, 'keep.txt'), 'mine\n');
  await openClone(page);
  const m = page.getByTestId('clone-modal');
  await m.getByTestId('clone-parent-input').fill(fx.parent);
  await m.getByTestId('clone-url-input').fill(fx.url);
  await m.getByTestId('clone-submit').click();
  await expect(m.getByTestId('clone-error')).toContainText('Clone Failed');
  expect(readdirSync(fx.target)).toEqual(['keep.txt']);
  expect(readFileSync(join(fx.target, 'keep.txt'), 'utf8')).toBe('mine\n');
  await expect(page.getByTestId('repo-tab-name')).toHaveCount(0);
});

test('Create with Node + MIT opens a tab whose "Initial commit" has 3 files', async ({ page }) => {
  const parent = freshDir('create-e2e');
  const name = 'e2e-created';
  await openCreate(page);
  const m = page.getByTestId('init-modal');
  await m.getByTestId('init-name-input').fill(name);
  await m.getByTestId('init-parent-input').fill(parent);
  await expect(m.getByTestId('init-fullpath')).toContainText(name);
  await pickOption(page, 'gitignore', 'Node', 'Node');
  await pickOption(page, 'license', 'MIT', 'MIT License');
  await m.getByTestId('init-submit').click();
  await expect(page.getByTestId('repo-view')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('init-modal')).toHaveCount(0);
  await expect(page.getByTestId('repo-tab-name').filter({ hasText: name })).toBeVisible();
  await expect(page.getByTestId('commit-message')).toHaveText(['Initial commit']);
  await page.getByTestId('commit-row').first().click();
  const rows = page.getByTestId('file-row');
  await expect(rows).toHaveCount(3);
  const paths = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-path')).sort());
  expect(paths).toEqual(['.gitignore', 'LICENSE.md', 'README.md']);
  expect(readFileSync(join(parent, name, 'README.md'), 'utf8')).toBe(`# ${name}\n`);
  expect(git(join(parent, name), ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('main');
});

test('a bad default branch shows "Invalid branch name." and creates nothing', async ({ page }) => {
  const parent = freshDir('create-badbranch');
  await openCreate(page);
  const m = page.getByTestId('init-modal');
  await m.getByTestId('init-name-input').fill('never-made');
  await m.getByTestId('init-parent-input').fill(parent);
  await m.getByTestId('init-branch-input').fill('bad..name');
  await expect(m.getByTestId('init-branch-error')).toHaveText('Invalid branch name.');
  await m.getByTestId('init-branch-input').fill('trunk');
  await expect(m.getByTestId('init-branch-error')).toHaveCount(0); // the error is tied to the input, not stuck
  await m.getByTestId('init-branch-input').fill('bad..name');
  await expect(m.getByTestId('init-branch-error')).toBeVisible();
  expect(readdirSync(parent)).toEqual([]);
});

test('a name that is not one legal folder name is refused (slash, reserved name) and nothing is created', async ({ page }) => {
  const parent = freshDir('create-badname');
  await openCreate(page);
  const m = page.getByTestId('init-modal');
  await m.getByTestId('init-parent-input').fill(parent);
  for (const bad of ['a/b', 'CON']) {
    await m.getByTestId('init-name-input').fill(bad);
    await expect(m.getByTestId('init-name-error')).toBeVisible();
  }
  await m.getByTestId('init-name-input').fill('fine-name');
  await expect(m.getByTestId('init-name-error')).toHaveCount(0);
  expect(readdirSync(parent)).toEqual([]);
});

test('Create on a folder that is already a repo is refused and the repo is unchanged (audit fix 1)', async ({ page }) => {
  const repo = createRepo('create-existing');
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  await openCreate(page);
  const m = page.getByTestId('init-modal');
  await m.getByTestId('init-name-input').fill(basename(repo));
  await m.getByTestId('init-parent-input').fill(dirname(repo));
  await pickOption(page, 'license', 'MIT', 'MIT License');
  await m.getByTestId('init-submit').click();
  await expect(m.getByTestId('init-error')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('repo-tab-name')).toHaveCount(0);
  expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(head);
  expect(existsSync(join(repo, 'LICENSE.md'))).toBe(false);
  expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# test\n');
});
