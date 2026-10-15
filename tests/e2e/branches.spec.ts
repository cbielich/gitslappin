import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import {
  DIRTY_TEXT,
  SUBJECTS,
  createBranchRepo,
  createConflictRepo,
  createSlashRemoteRepo,
  currentBranch,
  headSha,
  isDetached,
  localBranches,
  refSha,
  upstreamOf,
} from './helpers/branchFixtures';
import { TEST_TOKEN } from './helpers/repo';

/*
 * Test ids this file expects (new ones marked +):
 *  existing: repo-view, commit-row[data-sha], commit-message, ref-pill[data-name], toolbar-branch, tool-branch,
 *            sidebar-toggle-<id>, sidebar-item[data-kind][data-name], toast, toast-title, toast-detail
 *  + context-menu                 (the open menu; closes on Esc or outside click)
 *  + menu-item[data-id]           (one per row; visible text = the label)
 *  + menu-divider                 (between non-empty groups only)
 *  + context-submenu              (opens when a row with a submenu is clicked or hovered)
 *  + branch-input                 (inline input, placeholder "enter branch name"), branch-input-error
 *  + branch-picker                (toolbar branch dropdown), branch-picker-filter, branch-picker-item[data-name]
 *  + branch-prompt, branch-prompt-message, branch-prompt-input (placeholder "branch name"),
 *    branch-prompt-create ("Create Branch Here"), branch-prompt-error
 * Strings (en-us.json): Checkout, this commit, Checkout this commit, Create branch here, Copy branch name,
 *   Copy commit sha, enter branch name, Spaces are not allowed in branch name, Must fill in branch name,
 *   Checkout Failed, A local '{0}' already exists., branch name, Create Branch Here, Reset Local to Here,
 *   The given branch name is not valid.
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

async function openGraph(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}

async function expandSections(page: Page, ids: string[] = ['local', 'remote']): Promise<void> {
  for (const id of ids) {
    const head = page.getByTestId(`sidebar-toggle-${id}`);
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  }
}

const rowWithSubject = (page: Page, subject: string) =>
  page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: subject }) });
const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-name="${name}"]`);
const sbLocal = (page: Page, name: string) => page.locator(`[data-testid="sidebar-item"][data-kind="local"][data-name="${name}"]`);
const sbRemote = (page: Page, nameEnd: string) => page.locator(`[data-testid="sidebar-item"][data-kind="remote"][data-name$="${nameEnd}"]`);
const menuItem = (page: Page, text: string) => page.getByTestId('context-menu').getByTestId('menu-item').filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) });

async function menuLayout(page: Page): Promise<string[]> {
  return page
    .getByTestId('context-menu')
    .locator('[data-testid="menu-item"], [data-testid="menu-divider"]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') === 'menu-divider' ? '---' : (e.textContent ?? '').replace(/[›>]/g, '').trim())));
}

async function openRepoApi(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.post('/api/repos/open', { headers, data: { path } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

test.describe('checkout by double-click', () => {
  test('sidebar LOCAL item double-click checks out the branch', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await expandSections(page);
    await sbLocal(page, 'feature/one').dblclick();
    await expect(page.getByTestId('toolbar-branch')).toContainText('feature/one');
    expect(currentBranch(fx.repo)).toBe('feature/one');
    expect(headSha(fx.repo)).toBe(fx.shas[1]);
    await expect(page.getByTestId('toast')).toHaveCount(0); // toasts are failure-only
  });

  test('graph pill double-click checks out a local branch', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'dup').dblclick();
    await expect(page.getByTestId('toolbar-branch')).toContainText('dup');
    expect(currentBranch(fx.repo)).toBe('dup');
    expect(headSha(fx.repo)).toBe(fx.shas[0]);
    await expect(page.locator('.ref-pill.current')).toContainText('dup');
  });

  test('double-click on the current branch pill does nothing', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'main').dblclick();
    await expect(page.getByTestId('toast')).toHaveCount(0);
    expect(currentBranch(fx.repo)).toBe('main');
    // the same gesture on another branch does work, so the handler was live
    await pill(page, 'feature/one').dblclick();
    await expect(page.getByTestId('toolbar-branch')).toContainText('feature/one');
  });

  test('remote branch with no local one: pill double-click creates a tracking branch', async ({ page }) => {
    const fx = createBranchRepo();
    expect(localBranches(fx.repo)).not.toContain('remote-only');
    await openGraph(page, fx.repo);
    await pill(page, 'remote-only').dblclick();
    await expect(page.getByTestId('toolbar-branch')).toContainText('remote-only');
    expect(currentBranch(fx.repo)).toBe('remote-only');
    expect(upstreamOf(fx.repo, 'remote-only')).toBe('origin/remote-only');
    expect(headSha(fx.repo)).toBe(fx.shas[2]);
  });

  test('sidebar REMOTE item double-click creates a tracking branch', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await expandSections(page);
    await sbRemote(page, 'remote-only').dblclick();
    await expect(page.getByTestId('toolbar-branch')).toContainText('remote-only');
    expect(upstreamOf(fx.repo, 'remote-only')).toBe('origin/remote-only');
  });

  test('remote with a local branch at the same sha switches to the local branch', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await expandSections(page);
    await sbRemote(page, 'same').dblclick();
    await expect(page.getByTestId('toolbar-branch')).toContainText('same');
    expect(currentBranch(fx.repo)).toBe('same');
    await expect(page.getByTestId('branch-prompt')).toHaveCount(0);
  });

  test('remote name containing a slash (team/a, feat/x) checks out tracking branch feat/x', async ({ page }) => {
    const fx = createSlashRemoteRepo();
    await openGraph(page, fx.repo);
    await expandSections(page);
    await sbRemote(page, 'feat/x').dblclick();
    await expect(page.getByTestId('toolbar-branch')).toContainText('feat/x');
    expect(currentBranch(fx.repo)).toBe('feat/x');
    expect(upstreamOf(fx.repo, 'feat/x')).toBe('team/a/feat/x');
    expect(localBranches(fx.repo)).not.toContain('a/feat/x');
  });

  test('local exists at a different sha: 409 prompt, git state unchanged, create under another name', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await expandSections(page);
    await sbRemote(page, 'dup').dblclick();
    await expect(page.getByTestId('branch-prompt')).toBeVisible();
    await expect(page.getByTestId('branch-prompt-message')).toHaveText("A local 'dup' already exists.");
    await expect(page.getByTestId('branch-prompt-input')).toHaveAttribute('placeholder', 'branch name');
    await expect(page.getByTestId('branch-prompt-create')).toHaveText('Create Branch Here');
    await expect(page.getByText('Reset Local to Here')).toHaveCount(0); // left out until phase 11
    expect(currentBranch(fx.repo)).toBe('main');
    expect(refSha(fx.repo, 'refs/heads/dup')).toBe(fx.shas[0]);

    await page.getByTestId('branch-prompt-input').fill('a..b');
    await page.getByTestId('branch-prompt-create').click();
    await expect(page.getByTestId('branch-prompt-error')).toHaveText('The given branch name is not valid');
    expect(localBranches(fx.repo)).not.toContain('a..b');

    await page.getByTestId('branch-prompt-input').fill('dup-remote-copy');
    await page.getByTestId('branch-prompt-create').click();
    await expect(page.getByTestId('branch-prompt')).toHaveCount(0);
    expect(refSha(fx.repo, 'refs/heads/dup-remote-copy')).toBe(fx.shas[4]);
    expect(refSha(fx.repo, 'refs/heads/dup')).toBe(fx.shas[0]); // never reset
  });
});

test.describe('context menus', () => {
  test('branch pill menu: group order and dividers (phase 5 items, plus the phase 6 Integrate group and the phase 7 Remote group first)', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'feature/one').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    // Phase 11 registered its handlers: the commit group gains Cherry pick / Reset / Revert, then the Branch group (Rename, Delete) and the Tags group.
    expect(await menuLayout(page)).toEqual([
      'Pull (fast-forward if possible)', 'Push', 'Set Upstream', '---',
      'Merge feature/one into main', 'Rebase main onto feature/one', '---',
      'Checkout', '---',
      'Create branch here', 'Cherry pick commit', 'Reset main to this commit', 'Revert commit', '---',
      'Rename feature/one', 'Delete feature/one', '---',
      'Copy branch name', 'Copy commit sha', '---',
      'Create tag here', 'Create annotated tag here',
    ]);
  });

  test('commit row menu: Checkout this commit, Create branch here, Copy commit sha', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await rowWithSubject(page, SUBJECTS[1]).getByTestId('commit-message').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    expect(await menuLayout(page)).toEqual([
      'Rebase main onto this commit', '---', 'Checkout this commit', '---',
      'Create branch here', 'Cherry pick commit', 'Reset main to this commit', 'Revert commit', '---',
      'Copy commit sha', '---',
      'Create tag here', 'Create annotated tag here',
    ]);
  });

  test('sidebar item has a menu; Esc and an outside click close menus', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await expandSections(page);
    await sbLocal(page, 'feature/one').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await expect(menuItem(page, 'Checkout')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
    await sbLocal(page, 'feature/one').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.mouse.click(700, 400);
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
  });

  test('Checkout > submenu lists the branch and "this commit"; the branch item checks it out', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'feature/one').click({ button: 'right' });
    await menuItem(page, 'Checkout').click();
    const sub = page.getByTestId('context-submenu');
    await expect(sub).toBeVisible();
    await expect(sub.getByTestId('menu-item').filter({ hasText: 'this commit' })).toBeVisible();
    await sub.getByTestId('menu-item').filter({ hasText: 'feature/one' }).click();
    await expect(page.getByTestId('toolbar-branch')).toContainText('feature/one');
    expect(currentBranch(fx.repo)).toBe('feature/one');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
  });

  test('checkout of a commit gives a detached HEAD (row menu)', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await rowWithSubject(page, SUBJECTS[1]).getByTestId('commit-message').click({ button: 'right' });
    await menuItem(page, 'Checkout this commit').click();
    await expect(pill(page, 'HEAD')).toBeVisible();
    expect(isDetached(fx.repo)).toBe(true);
    expect(headSha(fx.repo)).toBe(fx.shas[1]);
    await expect(page.getByTestId('toast')).toHaveCount(0); // no detached-HEAD warning
  });

  test('checkout of a commit via the pill menu Checkout > this commit is detached', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'feature/one').click({ button: 'right' });
    await menuItem(page, 'Checkout').click();
    await page.getByTestId('context-submenu').getByTestId('menu-item').filter({ hasText: 'this commit' }).click();
    await expect(pill(page, 'HEAD')).toBeVisible();
    expect(isDetached(fx.repo)).toBe(true);
    expect(headSha(fx.repo)).toBe(fx.shas[1]);
  });

  test('Create branch here: inline input in that row, Enter creates and checks out', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    const row = rowWithSubject(page, SUBJECTS[1]);
    await row.getByTestId('commit-message').click({ button: 'right' });
    await menuItem(page, 'Create branch here').click();
    const input = row.getByTestId('branch-input');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', 'enter branch name');
    await input.fill('from-c2');
    await input.press('Enter');
    await expect(page.getByTestId('toolbar-branch')).toContainText('from-c2');
    expect(currentBranch(fx.repo)).toBe('from-c2');
    expect(headSha(fx.repo)).toBe(fx.shas[1]);
    await expect(page.getByTestId('branch-input')).toHaveCount(0);
  });

  test('Create branch here on a pill menu starts at that commit', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'dup').click({ button: 'right' });
    await menuItem(page, 'Create branch here').click();
    await page.getByTestId('branch-input').fill('from-dup');
    await page.getByTestId('branch-input').press('Enter');
    await expect(page.getByTestId('toolbar-branch')).toContainText('from-dup');
    expect(headSha(fx.repo)).toBe(fx.shas[0]);
  });

  test('Copy commit sha and Copy branch name write to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await rowWithSubject(page, SUBJECTS[1]).getByTestId('commit-message').click({ button: 'right' });
    await menuItem(page, 'Copy commit sha').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fx.shas[1]);
    await expect(page.getByTestId('context-menu')).toHaveCount(0);

    await pill(page, 'feature/one').click({ button: 'right' });
    await menuItem(page, 'Copy branch name').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('feature/one');
  });
});

test.describe('toolbar Branch button', () => {
  test('Enter creates the branch and checks it out', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await expect(page.getByTestId('tool-branch')).toBeEnabled();
    await page.getByTestId('tool-branch').click();
    const input = page.getByTestId('branch-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill('new-feature');
    await input.press('Enter');
    await expect(page.getByTestId('toolbar-branch')).toContainText('new-feature');
    expect(currentBranch(fx.repo)).toBe('new-feature');
    expect(headSha(fx.repo)).toBe(fx.shas[4]);
    await expect(page.getByTestId('branch-input')).toHaveCount(0);
  });

  test('Esc cancels without creating anything', async ({ page }) => {
    const fx = createBranchRepo();
    const before = localBranches(fx.repo);
    await openGraph(page, fx.repo);
    await page.getByTestId('tool-branch').click();
    await page.getByTestId('branch-input').fill('never-made');
    await page.getByTestId('branch-input').press('Escape');
    await expect(page.getByTestId('branch-input')).toHaveCount(0);
    expect(localBranches(fx.repo)).toEqual(before);
    expect(currentBranch(fx.repo)).toBe('main');
  });

  test('spaces show an error and nothing is created or replaced', async ({ page }) => {
    const fx = createBranchRepo();
    const before = localBranches(fx.repo);
    await openGraph(page, fx.repo);
    await page.getByTestId('tool-branch').click();
    const input = page.getByTestId('branch-input');
    await input.fill('has space');
    await input.press('Enter');
    await expect(page.getByTestId('branch-input-error')).toHaveText('Spaces are not allowed in branch name');
    await expect(input).toHaveValue('has space'); // no auto-replace
    expect(localBranches(fx.repo)).toEqual(before);
    expect(currentBranch(fx.repo)).toBe('main');
  });

  test('an empty name shows the empty-name error', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await page.getByTestId('tool-branch').click();
    await page.getByTestId('branch-input').press('Enter');
    await expect(page.getByTestId('branch-input-error')).toHaveText('Must fill in branch name');
    expect(currentBranch(fx.repo)).toBe('main');
  });

  test('an existing name shows a failure toast titled Failed creating ref', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await page.getByTestId('tool-branch').click();
    await page.getByTestId('branch-input').fill('dup');
    await page.getByTestId('branch-input').press('Enter');
    await expect(page.getByTestId('toast-title')).toHaveText('Failed creating ref');
    await expect(page.getByTestId('toast-detail')).toContainText('already exists');
    expect(refSha(fx.repo, 'refs/heads/dup')).toBe(fx.shas[0]);
    expect(currentBranch(fx.repo)).toBe('main');
  });
});

test.describe('toolbar branch picker', () => {
  test('lists local branches with a filter; clicking one checks it out', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await page.getByTestId('toolbar-branch').click();
    await expect(page.getByTestId('branch-picker')).toBeVisible();
    const names = await page.getByTestId('branch-picker-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
    expect([...names].sort()).toEqual(localBranches(fx.repo));
    await page.getByTestId('branch-picker-filter').fill('feature');
    await expect(page.getByTestId('branch-picker-item')).toHaveCount(1);
    await page.locator('[data-testid="branch-picker-item"][data-name="feature/one"]').click();
    await expect(page.getByTestId('toolbar-branch')).toContainText('feature/one');
    expect(currentBranch(fx.repo)).toBe('feature/one');
    await expect(page.getByTestId('branch-picker')).toHaveCount(0);
  });
});

test.describe('checkout failures', () => {
  test('a dirty-tree conflict shows a toast with git stderr and changes nothing', async ({ page }) => {
    const repo = createConflictRepo();
    await openGraph(page, repo);
    await expandSections(page);
    await sbLocal(page, 'other').dblclick();
    await expect(page.getByTestId('toast')).toBeVisible();
    await expect(page.getByTestId('toast-title')).toHaveText('Checkout Failed');
    await expect(page.getByTestId('toast-detail')).toContainText('would be overwritten');
    expect(currentBranch(repo)).toBe('main');
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe(DIRTY_TEXT);
  });
});

test.describe('branch API (security)', () => {
  let id: string;
  let fx: ReturnType<typeof createBranchRepo>;
  test.beforeEach(async ({ request }) => {
    fx = createBranchRepo();
    id = await openRepoApi(request, fx.repo);
  });

  test('both routes need the token', async ({ request }) => {
    const a = await request.post(`/api/repos/${id}/checkout`, { data: { kind: 'local', name: 'dup' } });
    expect(a.status()).toBe(403);
    const b = await request.post(`/api/repos/${id}/branch`, { data: { name: 'x', checkout: false } });
    expect(b.status()).toBe(403);
    expect(currentBranch(fx.repo)).toBe('main');
  });

  test('checkout local returns BranchActionResult', async ({ request }) => {
    const res = await request.post(`/api/repos/${id}/checkout`, { headers, data: { kind: 'local', name: 'feature/one' } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { prev: { branch: string; sha: string }; head: { branch: string; sha: string } };
    expect(body.prev).toEqual({ branch: 'main', sha: fx.shas[4] });
    expect(body.head).toEqual({ branch: 'feature/one', sha: fx.shas[1] });
  });

  test('POST /branch creates without checkout and reports created', async ({ request }) => {
    const res = await request.post(`/api/repos/${id}/branch`, { headers, data: { name: 'api-new', start: fx.shas[0], checkout: false } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { prev: { branch: string }; head: { branch: string }; created: { name: string; sha: string } };
    expect(body.created).toEqual({ name: 'api-new', sha: fx.shas[0] });
    expect(body.head.branch).toBe('main');
    expect(currentBranch(fx.repo)).toBe('main');
    expect(refSha(fx.repo, 'refs/heads/api-new')).toBe(fx.shas[0]);
  });

  for (const sha of ['zzzz', 'HEAD', '--orphan', 'abc1234', 'g'.repeat(40), '']) {
    test(`checkout commit with sha ${JSON.stringify(sha)} is a 400`, async ({ request }) => {
      const res = await request.post(`/api/repos/${id}/checkout`, { headers, data: { kind: 'commit', sha } });
      expect(res.status()).toBe(400);
      expect(currentBranch(fx.repo)).toBe('main');
    });
  }

  test('checkout commit with a valid full sha detaches HEAD', async ({ request }) => {
    const res = await request.post(`/api/repos/${id}/checkout`, { headers, data: { kind: 'commit', sha: fx.shas[0] } });
    expect(res.status()).toBe(200);
    expect(isDetached(fx.repo)).toBe(true);
    expect(headSha(fx.repo)).toBe(fx.shas[0]);
  });

  for (const [kind, name] of [
    ['local', 'no-such-branch'],
    ['local', 'origin/main'],
    ['local', '-x'],
    ['remote', 'origin/no-such'],
    ['remote', 'main'],
    ['remote', '--orphan'],
  ] as const) {
    test(`checkout ${kind} ${JSON.stringify(name)} (not an existing ${kind === 'local' ? 'branch' : 'remote branch'}) is a 400`, async ({ request }) => {
      const before = localBranches(fx.repo);
      const res = await request.post(`/api/repos/${id}/checkout`, { headers, data: { kind, name } });
      expect(res.status()).toBe(400);
      expect(localBranches(fx.repo)).toEqual(before);
      expect(currentBranch(fx.repo)).toBe('main');
    });
  }

  test('checkout remote where a local exists at a different sha is 409 with exists and changes nothing', async ({ request }) => {
    const res = await request.post(`/api/repos/${id}/checkout`, { headers, data: { kind: 'remote', name: 'origin/dup' } });
    expect(res.status()).toBe(409);
    expect(await res.json()).toHaveProperty('exists');
    expect(refSha(fx.repo, 'refs/heads/dup')).toBe(fx.shas[0]);
    expect(currentBranch(fx.repo)).toBe('main');
  });

  for (const start of ['HEAD@{1}', 'HEAD:file.txt', ':file.txt', 'main:file.txt', '--all', '-x']) {
    test(`POST /branch with start ${JSON.stringify(start)} resolves to a commit sha or is a 400, never passed raw`, async ({ request }) => {
      const before = localBranches(fx.repo);
      const res = await request.post(`/api/repos/${id}/branch`, { headers, data: { name: 'probe', start, checkout: false } });
      expect([200, 400]).toContain(res.status());
      if (res.status() === 200) {
        const body = (await res.json()) as { created: { name: string; sha: string } };
        expect(body.created.sha).toMatch(/^[0-9a-f]{40,64}$/);
        expect(refSha(fx.repo, 'refs/heads/probe')).toBe(body.created.sha);
      } else {
        expect(localBranches(fx.repo)).toEqual(before);
      }
      expect(currentBranch(fx.repo)).toBe('main');
    });
  }

  test('start that names a blob is definitely a 400 (not a commit)', async ({ request }) => {
    const res = await request.post(`/api/repos/${id}/branch`, { headers, data: { name: 'probe', start: 'HEAD:file.txt', checkout: false } });
    expect(res.status()).toBe(400);
    expect(localBranches(fx.repo)).not.toContain('probe');
  });

  for (const name of ['', 'a b', '-x', 'a@{1}', 'a..b', 'x.lock', '@{-1}', 'a'.repeat(256)]) {
    test(`POST /branch with invalid name ${JSON.stringify(name.length > 20 ? 'a*256' : name)} is a 400`, async ({ request }) => {
      const before = localBranches(fx.repo);
      const res = await request.post(`/api/repos/${id}/branch`, { headers, data: { name, checkout: true } });
      expect(res.status()).toBe(400);
      expect(localBranches(fx.repo)).toEqual(before);
      expect(currentBranch(fx.repo)).toBe('main');
    });
  }

  test('POST /branch with an existing name fails with {error, stderr} and does not move the branch', async ({ request }) => {
    const res = await request.post(`/api/repos/${id}/branch`, { headers, data: { name: 'dup', checkout: false } });
    expect(res.ok()).toBe(false);
    const body = (await res.json()) as { error: string; stderr: string };
    expect(body.stderr).toContain('already exists');
    expect(refSha(fx.repo, 'refs/heads/dup')).toBe(fx.shas[0]);
  });

  test('remote with a slash in its name resolves to tracking branch feat/x', async ({ request }) => {
    const sl = createSlashRemoteRepo();
    const sid = await openRepoApi(request, sl.repo);
    const res = await request.post(`/api/repos/${sid}/checkout`, { headers, data: { kind: 'remote', name: 'team/a/feat/x' } });
    expect(res.status()).toBe(200);
    expect(currentBranch(sl.repo)).toBe('feat/x');
    expect(upstreamOf(sl.repo, 'feat/x')).toBe('team/a/feat/x');
  });
});
