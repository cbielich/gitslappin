import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { TEST_TOKEN } from './helpers/repo';
import {
  LAST_BODY,
  LAST_SUBJECT,
  STAGING_FILES,
  cachedDiff,
  cachedNames,
  commitCount,
  createHookRepo,
  createHunkRepo,
  createStagingRepo,
  createUnbornRepo,
  headMessage,
  hookEnv,
  indexText,
} from './helpers/stagingFixtures';

/*
 * Test ids this file expects (new ones marked +):
 *  existing: wip-row, wip-details, wip-unstaged, wip-staged, wip-unstaged-count, wip-staged-count, wip-file-row[data-path],
 *            commit-row, commit-message, diff-view, diff-badge, diff-line[data-kind], line-text, hunk-header
 *  + stage-all, unstage-all                      (buttons in the section heads)
 *  + wip-file-action                             (hover button inside a wip-file-row; title Stage File / Unstage File)
 *  + wip-toggle-path, wip-toggle-tree, wip-file-list[data-mode=path|tree], wip-tree-dir
 *  + wip-message-input                           (the "// WIP" input in the graph WIP row)
 *  + commit-summary, commit-description, commit-countdown[data-negative], commit-button
 *  + hunk-action                                 (one per hunk header; title Stage Hunk / Unstage Hunk)
 *  + line-action                                 (inside add/del diff-line only; title Stage this line / Unstage this line)
 *  + diff-file-action                            (diff header; title Stage File / Unstage File)
 *  + toast, toast-title, toast-detail, toast-dismiss
 */

const wipRow = page0;
function page0(page: Page, section: 'unstaged' | 'staged', path: string) {
  return page.getByTestId(`wip-${section}`).locator(`[data-testid="wip-file-row"][data-path="${path}"]`);
}

async function openWip(page: Page, repo: string, graph = true): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  if (graph) await expect(page.getByTestId('commit-row').first()).toBeVisible();
  await page.getByTestId('wip-row').click();
  await expect(page.getByTestId('wip-details')).toBeVisible();
}

async function openDiff(page: Page, section: 'unstaged' | 'staged', path: string): Promise<void> {
  await wipRow(page, section, path).click();
  await expect(page.getByTestId('diff-view')).toBeVisible();
}

const rowWithSubject = (page: Page, subject: string | RegExp) =>
  page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: subject }) });

const addLine = (page: Page, text: string) =>
  page.locator('[data-testid="diff-line"][data-kind="add"]').filter({ has: page.getByTestId('line-text').filter({ hasText: new RegExp(`^${text}$`) }) });

test.describe('stage and unstage files', () => {
  test('hover button stages a file, then unstages it', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    await expect(page.getByTestId('wip-unstaged')).toContainText('Unstaged Files (2)');
    await expect(page.getByTestId('wip-staged')).toContainText('Staged Files (1)');

    const row = wipRow(page, 'unstaged', STAGING_FILES.header);
    await row.hover();
    await expect(row.getByTestId('wip-file-action')).toHaveAttribute('title', 'Stage File');
    await row.getByTestId('wip-file-action').click();
    await expect(wipRow(page, 'staged', STAGING_FILES.header)).toBeVisible();
    await expect(wipRow(page, 'unstaged', STAGING_FILES.header)).toHaveCount(0);
    await expect(page.getByTestId('wip-unstaged-count')).toHaveText('1');
    await expect(page.getByTestId('wip-staged-count')).toHaveText('2');
    expect(cachedDiff(repo)).toContain('h2 edited');

    const staged = wipRow(page, 'staged', STAGING_FILES.app);
    await staged.hover();
    await expect(staged.getByTestId('wip-file-action')).toHaveAttribute('title', 'Unstage File');
    await staged.getByTestId('wip-file-action').click();
    await expect(wipRow(page, 'unstaged', STAGING_FILES.app)).toBeVisible();
    await expect(wipRow(page, 'staged', STAGING_FILES.app)).toHaveCount(0);
    expect(cachedDiff(repo)).not.toContain('a2 edited');
    expect(indexText(repo, STAGING_FILES.app)).toBe('a1\na2\na3\n');
  });

  test('Stage All Changes and Unstage All Changes', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    await expect(page.getByTestId('stage-all')).toHaveText('Stage All Changes');
    await expect(page.getByTestId('unstage-all')).toHaveText('Unstage All Changes');

    await page.getByTestId('stage-all').click();
    await expect(page.getByTestId('wip-unstaged-count')).toHaveText('0');
    await expect(page.getByTestId('wip-staged-count')).toHaveText('3');
    expect(cachedNames(repo)).toEqual(['README.md', 'TODO.txt', 'src/app.js', 'src/header.js']);

    await page.getByTestId('unstage-all').click();
    await expect(page.getByTestId('wip-staged-count')).toHaveText('0');
    await expect(page.getByTestId('wip-unstaged-count')).toHaveText('3');
    expect(cachedNames(repo)).toEqual(['README.md', 'src/app.js', 'src/header.js']);
    expect(cachedDiff(repo)).toBe('');
  });

  test('Path / Tree toggle', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    await expect(page.getByTestId('wip-toggle-path')).toHaveText('Path');
    await expect(page.getByTestId('wip-toggle-tree')).toHaveText('Tree');
    await expect(page.getByTestId('wip-file-list')).toHaveAttribute('data-mode', 'path');
    await expect(page.getByTestId('wip-tree-dir')).toHaveCount(0);

    await page.getByTestId('wip-toggle-tree').click();
    await expect(page.getByTestId('wip-file-list')).toHaveAttribute('data-mode', 'tree');
    await expect(page.getByTestId('wip-tree-dir').first()).toContainText('src');
    await expect(wipRow(page, 'unstaged', STAGING_FILES.header)).toBeVisible();

    await page.getByTestId('wip-toggle-path').click();
    await expect(page.getByTestId('wip-file-list')).toHaveAttribute('data-mode', 'path');
    await expect(page.getByTestId('wip-tree-dir')).toHaveCount(0);
  });
});

test.describe('hunks, lines and the diff header', () => {
  test('Stage Hunk stages one hunk, the lists refresh, and the last hunk jumps to the staged diff', async ({ page }) => {
    const repo = createHunkRepo();
    await openWip(page, repo);
    await openDiff(page, 'unstaged', 'hunks.txt');
    await expect(page.getByTestId('hunk-header')).toHaveCount(2);
    await expect(page.getByTestId('hunk-action').first()).toHaveAttribute('title', 'Stage Hunk');

    await page.getByTestId('hunk-action').first().click();
    await expect(page.getByTestId('hunk-header')).toHaveCount(1);
    await expect(wipRow(page, 'staged', 'hunks.txt')).toBeVisible();
    await expect(wipRow(page, 'unstaged', 'hunks.txt')).toBeVisible();
    const partial = cachedDiff(repo);
    expect(partial).toContain('line 2 CHANGED');
    expect(partial).not.toContain('line 28 CHANGED');

    await page.getByTestId('hunk-action').first().click();
    await expect(wipRow(page, 'unstaged', 'hunks.txt')).toHaveCount(0);
    await expect(page.getByTestId('diff-badge')).toHaveText('Staged');
    await expect(page.getByTestId('hunk-header')).toHaveCount(2);
    await expect(page.getByTestId('hunk-action').first()).toHaveAttribute('title', 'Unstage Hunk');
    expect(cachedDiff(repo)).toContain('line 28 CHANGED');
  });

  test('the line + stages one line, and the line control unstages it again', async ({ page }) => {
    const repo = createHunkRepo();
    await openWip(page, repo);
    await openDiff(page, 'unstaged', 'lines.txt');
    await expect(page.locator('[data-testid="diff-line"][data-kind="context"] [data-testid="line-action"]')).toHaveCount(0);

    const x1 = addLine(page, 'X1');
    await x1.hover();
    await expect(x1.getByTestId('line-action')).toHaveAttribute('title', 'Stage this line');
    await x1.getByTestId('line-action').click();
    await expect(wipRow(page, 'staged', 'lines.txt')).toBeVisible();
    await expect(wipRow(page, 'unstaged', 'lines.txt')).toBeVisible();
    expect(indexText(repo, 'lines.txt')).toBe('a\nX1\nb\n');
    await expect(page.locator('[data-testid="diff-line"][data-kind="add"]')).toHaveCount(1);
    await expect(addLine(page, 'X2')).toBeVisible();

    await openDiff(page, 'staged', 'lines.txt');
    await expect(page.getByTestId('diff-badge')).toHaveText('Staged');
    const staged = addLine(page, 'X1');
    await staged.hover();
    await expect(staged.getByTestId('line-action')).toHaveAttribute('title', 'Unstage this line');
    await staged.getByTestId('line-action').click();
    await expect.poll(() => indexText(repo, 'lines.txt')).toBe('a\nb\n');
  });

  test('Stage File in the diff header stages the file and closes the diff when nothing else is left', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    await openDiff(page, 'unstaged', STAGING_FILES.header);
    await expect(page.getByTestId('diff-file-action')).toHaveAttribute('title', 'Stage File');
    await page.getByTestId('diff-file-action').click();
    await expect(wipRow(page, 'staged', STAGING_FILES.header)).toBeVisible();
    await expect(page.getByTestId('diff-view')).toHaveCount(0);
    expect(cachedNames(repo)).toContain(STAGING_FILES.header);
  });
});

test.describe('commit box', () => {
  test('typing in the "// WIP" box fills the summary', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    await expect(page.getByTestId('wip-message-input')).toHaveAttribute('placeholder', '// WIP');
    await expect(page.getByTestId('commit-summary')).toHaveAttribute('placeholder', 'Commit summary');
    await expect(page.getByTestId('commit-description')).toHaveAttribute('placeholder', 'Description');
    await page.getByTestId('wip-message-input').fill('typed in the graph row');
    await expect(page.getByTestId('commit-summary')).toHaveValue('typed in the graph row');
  });

  test('the countdown starts at 72, counts down and goes negative (red)', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    const left = page.getByTestId('commit-countdown');
    await expect(left).toHaveText('72');
    await expect(left).toHaveAttribute('data-negative', 'false');
    await page.getByTestId('commit-summary').fill('abcdefghij');
    await expect(left).toHaveText('62');
    await page.getByTestId('commit-summary').fill('x'.repeat(72));
    await expect(left).toHaveText('0');
    await expect(left).toHaveAttribute('data-negative', 'false');
    await page.getByTestId('commit-summary').fill('x'.repeat(75));
    await expect(left).toHaveText('-3');
    await expect(left).toHaveAttribute('data-negative', 'true');
  });

  test('the commit button text in each state', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    const btn = page.getByTestId('commit-button');
    await expect(btn).toHaveText('Type a Message to Commit');

    await page.getByTestId('commit-summary').fill('Some message');
    await expect(btn).toHaveText('Commit Changes to 1 File');

    await page.getByTestId('stage-all').click();
    await expect(btn).toHaveText('Commit Changes to 3 Files');

    await page.getByTestId('unstage-all').click();
    await expect(btn).toHaveText('Stage Changes to Commit');

    await page.getByTestId('commit-summary').fill('');
    await expect(btn).toHaveText('Type a Message to Commit');
  });

  test('commit adds a graph row, joins summary and description, and clears the box', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    const before = commitCount(repo);
    const rows = await page.getByTestId('commit-row').count();
    await page.getByTestId('commit-summary').fill('My new commit');
    await page.getByTestId('commit-description').fill('Details here');
    await page.getByTestId('commit-button').click();
    await expect(rowWithSubject(page, 'My new commit')).toBeVisible();
    await expect(page.getByTestId('commit-row')).toHaveCount(rows + 1);
    expect(commitCount(repo)).toBe(before + 1);
    expect(headMessage(repo)).toBe('My new commit\n\nDetails here');
    await expect(page.getByTestId('commit-summary')).toHaveValue('');
    await expect(page.getByTestId('wip-staged-count')).toHaveText('0');
    await expect(page.getByTestId('toast')).toHaveCount(0); // toasts are failure-only
  });

  test('amend prefills the last message and replaces HEAD', async ({ page }) => {
    const repo = createStagingRepo();
    await openWip(page, repo);
    const before = commitCount(repo);
    await page.getByLabel('Amend previous commit').check();
    await expect(page.getByTestId('commit-summary')).toHaveValue(LAST_SUBJECT);
    await expect(page.getByTestId('commit-description')).toHaveValue(LAST_BODY);

    await page.getByTestId('commit-summary').fill('Amended subject');
    await page.getByTestId('commit-button').click();
    await expect(rowWithSubject(page, 'Amended subject')).toBeVisible();
    await expect(rowWithSubject(page, LAST_SUBJECT)).toHaveCount(0);
    expect(commitCount(repo)).toBe(before);
    expect(headMessage(repo)).toBe(`Amended subject\n\n${LAST_BODY}`);
  });

  test('a failing pre-commit hook shows a failure toast that stays until dismissed', async ({ page }) => {
    const repo = createHookRepo('fail');
    await openWip(page, repo);
    const before = commitCount(repo);
    await page.getByTestId('commit-summary').fill('Blocked by hook');
    await page.getByTestId('commit-button').click();
    await expect(page.getByTestId('toast')).toBeVisible();
    await expect(page.getByTestId('toast-title')).toHaveText('Commit failed');
    await expect(page.getByTestId('toast-detail')).toHaveCount(1); // the stderr/stdout of git (the hook only does exit 1)
    await expect(page.getByTestId('toast-dismiss')).toHaveText('Dismiss');
    expect(commitCount(repo)).toBe(before);
    await expect(page.getByTestId('commit-summary')).toHaveValue('Blocked by hook');
    await page.getByTestId('toast-dismiss').click();
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('a failing hook on amend reads "Amend failed"', async ({ page }) => {
    const repo = createHookRepo('fail');
    await openWip(page, repo);
    await page.getByLabel('Amend previous commit').check();
    await page.getByTestId('commit-button').click();
    await expect(page.getByTestId('toast-title')).toHaveText('Amend failed');
  });

  test('first commit in an unborn repo', async ({ page }) => {
    const repo = createUnbornRepo();
    expect(commitCount(repo)).toBe(0);
    await openWip(page, repo, false);
    await expect(wipRow(page, 'unstaged', 'first.txt')).toBeVisible();
    await page.getByTestId('stage-all').click();
    await expect(page.getByTestId('wip-staged-count')).toHaveText('1');
    expect(cachedNames(repo)).toEqual(['first.txt']);

    await page.getByTestId('commit-summary').fill('First commit');
    await expect(page.getByTestId('commit-button')).toHaveText('Commit Changes to 1 File');
    await page.getByTestId('commit-button').click();
    await expect(rowWithSubject(page, 'First commit')).toBeVisible();
    expect(commitCount(repo)).toBe(1);
    expect(headMessage(repo)).toBe('First commit');
  });

  test('unstaging in an unborn repo works from the UI', async ({ page }) => {
    const repo = createUnbornRepo();
    await openWip(page, repo, false);
    await page.getByTestId('stage-all').click();
    await expect(page.getByTestId('wip-staged-count')).toHaveText('1');
    await page.getByTestId('unstage-all').click();
    await expect(page.getByTestId('wip-staged-count')).toHaveText('0');
    await expect(wipRow(page, 'unstaged', 'first.txt')).toBeVisible();
    expect(cachedNames(repo)).toEqual([]);
  });
});

test.describe('staging API', () => {
  const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

  async function openId(request: APIRequestContext, path: string): Promise<string> {
    const res = await request.post('/api/repos/open', { headers, data: { path } });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { id: string }).id;
  }
  const post = (request: APIRequestContext, id: string, route: string, data: unknown, h: Record<string, string> = headers) =>
    request.post(`/api/repos/${id}/${route}`, { headers: h, data });
  const is4xx = (s: number) => {
    expect(s).toBeGreaterThanOrEqual(400);
    expect(s).toBeLessThan(500);
  };

  test('a valid /stage works (proves the route ran), without a token it is 403', async ({ request }) => {
    const repo = createHunkRepo();
    const id = await openId(request, repo);
    expect((await post(request, id, 'stage', { paths: ['lines.txt'] }, {})).status()).toBe(403);
    expect(cachedDiff(repo)).toBe(''); // lines.txt is in HEAD already, so the names cannot tell
    const ok = await post(request, id, 'stage', { paths: ['lines.txt'] });
    expect(ok.status()).toBe(200);
    expect(cachedDiff(repo)).toContain('X1');
  });

  for (const [name, paths] of [
    ['a parent traversal', ['../outside.txt']],
    ['an absolute path', ['C:\\Windows\\win.ini']],
    ['a backslash path', ['..\\x']],
    ['a leading slash', ['/etc/passwd']],
    ['a NUL byte', ['lines.txt\u0000x']],
  ] as const) {
    test(`/stage rejects ${name} with a 4xx and stages nothing`, async ({ request }) => {
      const repo = createHunkRepo();
      const id = await openId(request, repo);
      const res = await post(request, id, 'stage', { paths: [...paths] });
      is4xx(res.status());
      expect(cachedNames(repo)).toEqual(['hunks.txt', 'lines.txt']); // only what HEAD already had
      expect(cachedDiff(repo)).toBe('');
    });
  }

  test('/stage and /unstage with an empty paths list return 400', async ({ request }) => {
    const repo = createHunkRepo();
    const id = await openId(request, repo);
    expect((await post(request, id, 'stage', { paths: [] })).status()).toBe(400);
    expect((await post(request, id, 'unstage', { paths: [] })).status()).toBe(400);
    expect(cachedDiff(repo)).toBe('');
  });

  // UNVERIFIED body shape: { source, path, hunk, header, lines? } with `lines` = indexes into the hunk's lines.
  const stageLines = (request: APIRequestContext, id: string, over: Record<string, unknown> = {}) =>
    post(request, id, 'stage-lines', { source: 'unstaged', path: 'lines.txt', hunk: 0, header: '@@ -1,2 +1,4 @@', lines: [1], ...over });

  test('/stage-lines with the current header stages the chosen line (proves the route ran)', async ({ request }) => {
    const repo = createHunkRepo();
    const id = await openId(request, repo);
    const res = await stageLines(request, id);
    expect(res.status()).toBe(200);
    expect(indexText(repo, 'lines.txt')).toBe('a\nX1\nb\n');
  });

  test('/stage-lines with a stale hunk header returns 409 and changes nothing', async ({ request }) => {
    const repo = createHunkRepo();
    const id = await openId(request, repo);
    const res = await stageLines(request, id, { header: '@@ -5,2 +5,4 @@' });
    expect(res.status()).toBe(409);
    expect(cachedDiff(repo)).toBe('');
  });

  test('/stage-lines with an out-of-range hunk or line index returns 409 and changes nothing', async ({ request }) => {
    const repo = createHunkRepo();
    const id = await openId(request, repo);
    expect((await stageLines(request, id, { hunk: 7 })).status()).toBe(409);
    expect((await stageLines(request, id, { lines: [99] })).status()).toBe(409);
    expect(cachedDiff(repo)).toBe('');
  });

  test('/stage-lines rejects a path outside the repo with a 4xx', async ({ request }) => {
    const repo = createHunkRepo();
    const id = await openId(request, repo);
    is4xx((await stageLines(request, id, { path: '../outside.txt' })).status());
    expect(cachedDiff(repo)).toBe('');
  });

  test('/commit: amend must be a boolean and message a string (400), nothing is committed', async ({ request }) => {
    const repo = createStagingRepo();
    const id = await openId(request, repo);
    const before = commitCount(repo);
    expect((await post(request, id, 'commit', { message: 'x', amend: 'yes' })).status()).toBe(400);
    expect((await post(request, id, 'commit', { message: 'x' })).status()).toBe(400);
    expect((await post(request, id, 'commit', { message: 123, amend: false })).status()).toBe(400);
    expect(commitCount(repo)).toBe(before);
  });

  test('a git hook cannot see GITSLAPPIN_TOKEN in its environment', async ({ request }) => {
    const repo = createHookRepo('env');
    const id = await openId(request, repo);
    const res = await post(request, id, 'commit', { message: 'Env check', amend: false });
    expect(res.status()).toBe(200);
    const env = hookEnv(repo);
    expect(env, 'the hook ran and recorded its environment').toBeDefined();
    expect(env).toContain('PATH=');
    expect(env).not.toContain('GITSLAPPIN_TOKEN');
    expect(env).not.toContain(TEST_TOKEN);
  });
});
