import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { EVIL_CONTENT, SUBJECTS, UNICODE_PATH, createDiffRepo } from './helpers/diffFixtures';
import { TEST_TOKEN } from './helpers/repo';
import { createConflictRepo, createHighlightRepo } from './helpers/reviewFixtures';

const rowWithSubject = (page: Page, subject: string | RegExp) =>
  page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: subject }) });

async function openGraph(page: Page, path: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, path);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}

async function openCommitFile(page: Page, subject: string, path: string): Promise<void> {
  await rowWithSubject(page, subject).click();
  await page.locator(`[data-testid="file-row"][data-path="${path}"]`).click();
  await expect(page.getByTestId('diff-view')).toBeVisible();
}

async function openWipFile(page: Page, path: string): Promise<void> {
  await page.getByTestId('wip-row').click();
  await page.locator(`[data-testid="wip-file-row"][data-path="${path}"]`).click();
  await expect(page.getByTestId('diff-view')).toBeVisible();
}

const monaco = (page: Page) => page.locator('[data-testid="diff-monaco"] .monaco-editor:visible').first();

test.describe('diff viewer', () => {
  let repo: string;
  test.beforeAll(() => {
    repo = createDiffRepo();
  });

  test('commit file opens the diff: graph hidden, rail with counts, hunk header, gutters, added row', async ({ page }) => {
    await openGraph(page, repo);
    await openCommitFile(page, SUBJECTS.modify, 'a-mod.txt');
    await expect(page.getByTestId('graph-view')).toBeHidden();
    await expect(page.getByTestId('left-panel')).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('rail-count').first()).toBeVisible();
    await expect(page.getByTestId('diff-view')).toHaveAttribute('data-view', 'hunk');
    await expect(page.getByTestId('diff-path')).toContainText('a-mod.txt');
    await expect(page.getByTestId('diff-badge')).toHaveCount(0); // commit diffs get no badge
    await expect(page.getByTestId('hunk-header')).toHaveText(/@@ -1,3 \+1,4 @@/);
    const added = page.locator('[data-testid="diff-line"][data-kind="add"]');
    await expect(added).toHaveCount(1);
    await expect(added.getByTestId('line-text')).toHaveText('new line');
    await expect(added.getByTestId('gutter-old')).toHaveText('');
    await expect(added.getByTestId('gutter-new')).toHaveText('3');
    const ctx = page.locator('[data-testid="diff-line"][data-kind="context"]').first();
    await expect(ctx.getByTestId('gutter-old')).toHaveText('1');
    await expect(ctx.getByTestId('gutter-new')).toHaveText('1');
  });

  test('close button returns to the graph', async ({ page }) => {
    await openGraph(page, repo);
    await openCommitFile(page, SUBJECTS.modify, 'a-mod.txt');
    await page.getByTestId('diff-close').click();
    await expect(page.getByTestId('diff-view')).toHaveCount(0);
    await expect(page.getByTestId('graph-view')).toBeVisible();
    await expect(page.getByTestId('commit-row').first()).toBeVisible();
  });

  test('WIP unstaged and staged files show their badges', async ({ page }) => {
    await openGraph(page, repo);
    await openWipFile(page, 'wip-unstaged.txt');
    await expect(page.getByTestId('diff-badge')).toHaveText('Unstaged');
    await expect(page.locator('[data-testid="diff-line"][data-kind="add"]').getByTestId('line-text')).toHaveText('u2 edited');
    await page.getByTestId('diff-close').click();
    await expect(page.getByTestId('diff-view')).toHaveCount(0);

    await openWipFile(page, 'wip-staged.txt');
    await expect(page.getByTestId('diff-badge')).toHaveText('Staged');
    await expect(page.locator('[data-testid="diff-line"][data-kind="add"]').getByTestId('line-text')).toHaveText('s2 staged edit');
  });

  test('an untracked file shows as all added', async ({ page }) => {
    await openGraph(page, repo);
    await openWipFile(page, 'untracked.txt');
    await expect(page.locator('[data-testid="diff-line"][data-kind="add"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="diff-line"][data-kind="del"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="diff-line"][data-kind="context"]')).toHaveCount(0);
  });

  test('a binary file shows "Binary file"', async ({ page }) => {
    await openGraph(page, repo);
    await openCommitFile(page, SUBJECTS.binary, 'bin/blob.bin');
    await expect(page.getByTestId('diff-binary')).toHaveText('Binary file');
    await expect(page.getByTestId('diff-line')).toHaveCount(0);
  });

  test('a 3000-line change is held back until "Show anyway"', async ({ page }) => {
    await openGraph(page, repo);
    await openCommitFile(page, SUBJECTS.big, 'big.txt');
    await expect(page.getByTestId('diff-too-large')).toBeVisible();
    await expect(page.getByTestId('diff-line')).toHaveCount(0);
    await page.getByTestId('diff-show-anyway').click();
    await expect(page.getByTestId('diff-too-large')).toHaveCount(0);
    await expect(page.getByTestId('hunk-header').first()).toBeVisible();
    await expect(page.getByTestId('diff-line').first()).toBeVisible();
  });

  test('Hunk, Inline and Split views switch; Monaco only in Inline and Split', async ({ page }) => {
    await openGraph(page, repo);
    await openCommitFile(page, SUBJECTS.modify, 'a-mod.txt');
    await expect(page.getByTestId('view-hunk')).toHaveAttribute('title', 'Hunk View');
    await expect(page.getByTestId('view-inline')).toHaveAttribute('title', 'Inline View');
    await expect(page.getByTestId('view-split')).toHaveAttribute('title', 'Split View');
    await expect(page.getByTestId('diff-monaco')).toHaveCount(0);

    await page.getByTestId('view-inline').click();
    await expect(page.getByTestId('diff-view')).toHaveAttribute('data-view', 'inline');
    await expect(monaco(page)).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('view-split').click();
    await expect(page.getByTestId('diff-view')).toHaveAttribute('data-view', 'split');
    await expect(monaco(page)).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('view-hunk').click();
    await expect(page.getByTestId('diff-view')).toHaveAttribute('data-view', 'hunk');
    await expect(page.getByTestId('diff-monaco')).toHaveCount(0);
    await expect(page.getByTestId('hunk-header')).toHaveText(/@@ -1,3 \+1,4 @@/);
  });

  test('Previous Change and Next Change move between changes', async ({ page }) => {
    await openGraph(page, repo);
    await openCommitFile(page, SUBJECTS.modify, 'multi.txt');
    await expect(page.getByTestId('hunk-header')).toHaveCount(2);
    const view = page.getByTestId('diff-view');
    await expect(page.getByTestId('change-next')).toHaveAttribute('title', 'Next Change');
    await expect(page.getByTestId('change-prev')).toHaveAttribute('title', 'Previous Change');
    await expect(view).toHaveAttribute('data-current-change', '-1');
    await page.getByTestId('change-next').click();
    await expect(view).toHaveAttribute('data-current-change', '0');
    await page.getByTestId('change-next').click();
    await expect(view).toHaveAttribute('data-current-change', '1');
    await page.getByTestId('change-prev').click();
    await expect(view).toHaveAttribute('data-current-change', '0');
  });

  test('a staged rename opens', async ({ page }) => {
    await openGraph(page, repo);
    await openWipFile(page, 'rename-new.txt');
    await expect(page.getByTestId('diff-badge')).toHaveText('Staged');
    await expect(page.getByTestId('diff-path')).toContainText('rename-new.txt');
    await expect(page.locator('[data-testid="diff-line"][data-kind="add"]').getByTestId('line-text')).toHaveText('rename body 5 EDITED');
    await expect(page.locator('[data-testid="diff-line"][data-kind="del"]').getByTestId('line-text')).toHaveText('rename body 5');
  });

  test('a unicode path opens', async ({ page }) => {
    await openGraph(page, repo);
    await openCommitFile(page, SUBJECTS.unicode, UNICODE_PATH);
    await expect(page.getByTestId('diff-path')).toContainText('日本語.txt');
    await expect(page.locator('[data-testid="diff-line"][data-kind="add"]').getByTestId('line-text')).toHaveText('héllo');
  });

  test('file content that looks like HTML renders as literal text', async ({ page }) => {
    let dialogs = 0;
    page.on('dialog', async (d) => {
      dialogs++;
      await d.dismiss();
    });
    await openGraph(page, repo);
    await openCommitFile(page, SUBJECTS.evil, 'evil.html');
    await expect(page.locator('[data-testid="diff-line"][data-kind="add"]').getByTestId('line-text')).toHaveText(EVIL_CONTENT);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(dialogs).toBe(0);
  });
});

test.describe('diff API security', () => {
  let repo: string;
  let id: string;
  test.beforeAll(async ({ request }) => {
    repo = createDiffRepo();
    id = await openId(request, repo);
  });

  const headers = { 'X-GitSlappin-Token': TEST_TOKEN };
  const diff = (request: APIRequestContext, query: string, h: Record<string, string> = headers) =>
    request.get(`/api/repos/${id}/diff?${query}`, { headers: h });

  async function openId(request: APIRequestContext, path: string): Promise<string> {
    const res = await request.post('/api/repos/open', { headers, data: { path } });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { id: string }).id;
  }

  test('a valid unstaged request works (proves the route ran)', async ({ request }) => {
    const res = await diff(request, 'source=unstaged&path=wip-unstaged.txt');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('u2 edited');
  });

  for (const [name, query] of [
    ['parent traversal', 'source=unstaged&path=../x'],
    ['drive letter', `source=unstaged&path=${encodeURIComponent('C:\\x')}`],
    ['leading colon', 'source=staged&path=%3Asecret'],
    ['traversal in oldPath', 'source=staged&path=wip-staged.txt&oldPath=../x'],
    ['unknown source', 'source=bogus&path=wip-staged.txt'],
  ] as const) {
    test(`rejects ${name}`, async ({ request }) => {
      const res = await diff(request, query);
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    });
  }

  test('an untracked diff of an ignored file is refused, a listed untracked file is allowed', async ({ request }) => {
    const ok = await diff(request, 'source=unstaged&untracked=1&path=untracked.txt');
    expect(ok.status()).toBe(200);
    expect(await ok.text()).toContain('fresh 1');
    const res = await diff(request, 'source=unstaged&untracked=1&path=ignored.log');
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
    expect(await res.text()).not.toContain('secret log');
  });

  test('no token gives 403', async ({ request }) => {
    const res = await diff(request, 'source=unstaged&path=wip-unstaged.txt', {});
    expect(res.status()).toBe(403);
  });
});

test.describe('phase 3 review fixes', () => {
  const headers = { 'X-GitSlappin-Token': TEST_TOKEN };
  async function openId(request: APIRequestContext, path: string): Promise<string> {
    const res = await request.post('/api/repos/open', { headers, data: { path } });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { id: string }).id;
  }
  const is4xx = (s: number) => {
    expect(s).toBeGreaterThanOrEqual(400);
    expect(s).toBeLessThan(500);
  };

  test('A1: an unstaged diff of a path that is not in the index is a 400, for the diff and its contents', async ({ request }) => {
    const id = await openId(request, createDiffRepo());
    const diff = await request.get(`/api/repos/${id}/diff?source=unstaged&path=untracked.txt`, { headers });
    expect(diff.status()).toBe(400);
    expect(await diff.text()).not.toContain('fresh 1');
    const contents = await request.get(`/api/repos/${id}/diff/contents?source=unstaged&path=untracked.txt`, { headers });
    expect(contents.status()).toBe(400);
    const ok = await request.get(`/api/repos/${id}/diff?source=unstaged&path=wip-unstaged.txt`, { headers });
    expect(ok.status()).toBe(200);
  });

  test('A1: paths inside .git or with a colon are refused', async ({ request }) => {
    const id = await openId(request, createDiffRepo());
    for (const path of ['.git/config', '.GIT/config', 'a:b.txt', 'wip-unstaged.txt:stream']) {
      const res = await request.get(`/api/repos/${id}/diff?source=unstaged&path=${encodeURIComponent(path)}`, { headers });
      is4xx(res.status());
    }
  });

  test('A4: a too-large diff reports the real status (A), not M', async ({ request }) => {
    const id = await openId(request, createDiffRepo());
    const log = await request.get(`/api/repos/${id}/log?skip=0&limit=50`, { headers });
    const commits = ((await log.json()) as { commits: { sha: string; subject: string }[] }).commits;
    const big = commits.find((c) => c.subject === SUBJECTS.big);
    expect(big).toBeDefined();
    const res = await request.get(`/api/repos/${id}/diff?source=commit&sha=${big!.sha}&path=big.txt`, { headers });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { tooLarge: boolean; status: string; additions: number };
    expect(body.tooLarge).toBe(true);
    expect(body.status).toBe('A');
    expect(body.additions).toBe(3000);
  });

  test('A3: a conflicted path answers conflicted:true and the diff view says so', async ({ page, request }) => {
    const repo = createConflictRepo();
    const id = await openId(request, repo);
    const res = await request.get(`/api/repos/${id}/diff?source=unstaged&path=c.txt`, { headers });
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { conflicted?: boolean }).conflicted).toBe(true);

    await openGraph(page, repo);
    // Phase 6: a merge in progress shows the amber banner and the conflict panel instead of the WIP row and its file list.
    await page.getByTestId('op-banner').click();
    await page.locator('[data-testid="conflict-file-row"][data-path="c.txt"]').click();
    // Phase 8: a conflicted row opens the merge tool (the API above still answers conflicted:true for the diff route).
    await expect(page.getByTestId('merge-tool')).toBeVisible();
    await expect(page.getByTestId('merge-title')).toHaveText('c.txt');
    await expect(page.getByTestId('diff-line')).toHaveCount(0);
  });

  test('A5: the page CSP also forbids base-uri, forms, framing and plugins', async ({ request }) => {
    const res = await request.get('/');
    const csp = res.headers()['content-security-policy'] ?? '';
    for (const part of ["base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'"]) {
      expect(csp).toContain(part);
    }
    expect(csp).not.toContain('unsafe-eval');
  });

  test('A6: Hunk View colours a .js keyword, string and comment with token classes', async ({ page }) => {
    await openGraph(page, createHighlightRepo());
    await openWipFile(page, 'code.js');
    const added = page.locator('[data-testid="diff-line"][data-kind="add"]');
    await expect(added.locator('.tok-keyword').first()).toBeVisible({ timeout: 20_000 });
    await expect(added.locator('.tok-string').first()).toBeVisible();
    await expect(added.locator('.tok-comment').first()).toBeVisible();
    await expect(added.locator('.tok-keyword').first()).toHaveCSS('color', 'rgb(86, 156, 214)');
    await expect(added.locator('.tok-string').first()).toHaveCSS('color', 'rgb(206, 145, 120)');
  });
});
