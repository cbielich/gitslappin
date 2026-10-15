import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { createBranchRepo, currentBranch, gitOut, localBranches, refSha } from './helpers/branchFixtures';
import { createMergeInProgress } from './helpers/mergeFixtures';
import { TEST_TOKEN } from './helpers/repo';

/*
 * Phase 5 code-review fixes 1-10 (build-notes). New test ids: none. Existing: repo-view, commit-row[data-sha], ref-pill[data-name],
 * ref-more, context-menu, context-submenu, menu-item, branch-prompt*, branch-input, toast, toast-title, tool-branch, tool-pull,
 * pull-options-toggle, pull-option[data-mode].
 * "Synthetic click" = element.click() from page.evaluate: it fires click without mousedown or focus, so it does not close
 * a menu or blur an input the way a real mouse click would (this is how a background refresh is simulated).
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

async function openGraph(page: Page, repo: string): Promise<void> {
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
async function openRepoApi(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.post('/api/repos/open', { headers, data: { path } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}
const post = (request: APIRequestContext, id: string, route: string, data: unknown) => request.post(`/api/repos/${id}/${route}`, { headers, data: data as object });
const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-name="${name}"]`).first();
const items = (page: Page) => page.getByTestId('context-menu').getByTestId('menu-item');
const menuItem = (page: Page, text: string) => items(page).filter({ hasText: new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) });

/** Simulates a refresh coming from outside the menu or the input: Fetch All through synthetic clicks. */
async function syntheticFetchAll(page: Page): Promise<void> {
  await page.evaluate(() => (document.querySelector('[data-testid="pull-options-toggle"]') as HTMLElement).click());
  await page.evaluate(() => (document.querySelector('[data-testid="pull-option"][data-mode="fetch"]') as HTMLElement).click());
}

test.describe('review 1: a remote checkout that makes a tracking branch says so', () => {
  test('created + createdTracking come back; a plain local switch has neither', async ({ request }) => {
    const fx = createBranchRepo();
    const id = await openRepoApi(request, fx.repo);
    const res = await post(request, id, 'checkout', { kind: 'remote', name: 'origin/remote-only' });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { created?: { name: string; sha: string }; createdTracking?: boolean };
    expect(body.createdTracking).toBe(true);
    expect(body.created).toEqual({ name: 'remote-only', sha: fx.shas[2] });
    expect(currentBranch(fx.repo)).toBe('remote-only');

    const again = await post(request, id, 'checkout', { kind: 'local', name: 'main' });
    const plain = (await again.json()) as { created?: unknown; createdTracking?: unknown };
    expect(plain.created).toBeUndefined();
    expect(plain.createdTracking).toBeUndefined();
    // the existing same-sha local branch is switched to without creating anything
    const same = await post(request, id, 'checkout', { kind: 'remote', name: 'origin/same' });
    expect(same.status()).toBe(200);
    expect(((await same.json()) as { createdTracking?: unknown }).createdTracking).toBeUndefined();
  });
});

test.describe('review 2 and 9: context menu keyboard and submenu flip', () => {
  test('first item focused; arrows, Home, End move; Right opens the submenu, Left closes it; Esc and Tab close', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'feature/one').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    const n = await items(page).count();
    expect(n).toBeGreaterThan(3);
    await expect(items(page).first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items(page).nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items(page).first()).toBeFocused();
    await page.keyboard.press('ArrowUp'); // wraps
    await expect(items(page).nth(n - 1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items(page).first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(items(page).nth(n - 1)).toBeFocused();

    await menuItem(page, 'Checkout').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('context-submenu')).toBeVisible();
    await expect(page.getByTestId('context-submenu').getByTestId('menu-item').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('context-submenu').getByTestId('menu-item').nth(1)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('context-submenu')).toHaveCount(0);
    await expect(menuItem(page, 'Checkout')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);

    await pill(page, 'feature/one').click({ button: 'right' });
    await expect(items(page).first()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
  });

  test('Enter runs the focused item', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'feature/one').click({ button: 'right' });
    await menuItem(page, 'Checkout').focus();
    await page.keyboard.press('Enter'); // opens the submenu (Enter on a submenu item)
    await page.getByTestId('context-submenu').getByTestId('menu-item').first().focus();
    await expect(page.getByTestId('context-submenu').getByTestId('menu-item').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
    await expect.poll(() => currentBranch(fx.repo)).toBe('feature/one');
  });

  test('a submenu that would run past the right edge opens to the left of its parent', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    const width = page.viewportSize()?.width ?? 1280;
    // A real MouseEvent at the far right edge (a pill sits at the left, so the mouse itself cannot get there).
    await pill(page, 'feature/one').evaluate((el, x) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: 200 })), width - 20);
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await menuItem(page, 'Checkout').hover();
    await expect(page.getByTestId('context-submenu')).toBeVisible();
    const main = (await page.getByTestId('context-menu').boundingBox())!;
    const sub = (await page.getByTestId('context-submenu').boundingBox())!;
    expect(sub.x).toBeGreaterThanOrEqual(0);
    expect(sub.x + sub.width).toBeLessThanOrEqual(main.x + 4); // left of the parent menu (a 2px overlap is the design)
    expect(main.x + main.width).toBeLessThanOrEqual(width);
  });
});

test.describe('review 3: the branch prompt closes only when the branch was made', () => {
  test('a failing create keeps the prompt (and shows the failure); a good name closes it', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await page.getByTestId('sidebar-toggle-remote').click();
    await page.locator('[data-testid="sidebar-item"][data-kind="remote"][data-name$="dup"]').dblclick();
    await expect(page.getByTestId('branch-prompt')).toBeVisible();
    await page.getByTestId('branch-prompt-input').fill('same'); // a local branch of that name already exists: git refuses
    await page.getByTestId('branch-prompt-create').click();
    await expect(page.getByTestId('toast-title')).toHaveText('Failed creating ref');
    await expect(page.getByTestId('branch-prompt')).toBeVisible();
    expect(refSha(fx.repo, 'refs/heads/same')).toBe(fx.shas[3]); // untouched
    await page.getByTestId('branch-prompt-input').fill('dup-copy');
    await page.getByTestId('branch-prompt-create').click();
    await expect(page.getByTestId('branch-prompt')).toHaveCount(0);
    expect(localBranches(fx.repo)).toContain('dup-copy');
  });
});

test.describe('review 4 and 5: the inline branch input', () => {
  test('busy: a toast and the typed name stays; a refresh keeps it; Enter works once the server is free', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/api/repos/*/fetch', async (route) => {
      await gate;
      await route.continue();
    });
    await syntheticFetchAll(page); // a request is now in flight
    await expect(page.getByTestId('toolbar-busy')).toBeVisible();

    await page.getByTestId('tool-branch').click();
    const input = page.getByTestId('branch-input');
    await expect(input).toBeVisible();
    await input.fill('typed-name');
    await input.press('Enter');
    await expect(page.getByTestId('toast-title')).toHaveText('Another operation is already in progress.');
    await expect(input).toHaveValue('typed-name');
    expect(localBranches(fx.repo)).not.toContain('typed-name');

    release();
    await expect(page.getByTestId('toolbar-busy')).toHaveCount(0); // the fetch finished and refresh() ran
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('typed-name');
    await input.press('Enter');
    await expect(input).toHaveCount(0);
    await expect.poll(() => currentBranch(fx.repo)).toBe('typed-name');
  });
});

test.describe('review 6: ambiguous remote names', () => {
  test('two remotes that both prefix-match a ref are refused with 400 and nothing is created', async ({ request }) => {
    const fx = createBranchRepo();
    // `git remote add` refuses this name, but a repo config can still hold it (e.g. a hostile one)
    gitOut(fx.repo, ['config', 'remote.origin/x.url', fx.origin]);
    gitOut(fx.repo, ['config', 'remote.origin/x.fetch', '+refs/heads/*:refs/remotes/origin/x/*']);
    expect(gitOut(fx.repo, ['remote']).split(/\r?\n/)).toContain('origin/x');
    gitOut(fx.repo, ['update-ref', 'refs/remotes/origin/x/main', fx.shas[2]!]);
    const id = await openRepoApi(request, fx.repo);
    const before = localBranches(fx.repo);
    const res = await post(request, id, 'checkout', { kind: 'remote', name: 'origin/x/main' });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/ambiguous remote/i);
    expect(localBranches(fx.repo)).toEqual(before);
    expect(currentBranch(fx.repo)).toBe('main');
    // an unambiguous remote branch still works
    const ok = await post(request, id, 'checkout', { kind: 'remote', name: 'origin/remote-only' });
    expect(ok.status()).toBe(200);
  });
});

test.describe('review 7: a refresh closes an open context menu', () => {
  test('menu open, a background refresh finishes, the menu is gone', async ({ page }) => {
    const fx = createBranchRepo();
    await openGraph(page, fx.repo);
    await pill(page, 'feature/one').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await syntheticFetchAll(page);
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
  });
});

test.describe('review 8: the +N pill has a menu', () => {
  test('right-click +N lists the extra branches; each opens its own menu', async ({ page }) => {
    const fx = createBranchRepo(); // the tip commit holds main and origin/main, plus origin/dup: one extra pill
    await openGraph(page, fx.repo);
    const row = page.locator(`[data-testid="commit-row"][data-sha="${fx.shas[4]}"]`);
    await row.getByTestId('ref-more').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await expect(items(page)).toHaveText(['origin/dup']);
    await items(page).first().hover();
    await expect(page.getByTestId('context-submenu')).toBeVisible();
    await expect(page.getByTestId('context-submenu').getByTestId('menu-item').filter({ hasText: 'Checkout origin/dup' })).toBeVisible();
    await expect(page.getByTestId('context-submenu').getByTestId('menu-item').filter({ hasText: 'Copy branch name' })).toBeVisible();
  });
});

test.describe('review 10: checkout and branch answer 409 opInProgress while an operation is stopped', () => {
  test('distinct from the exists conflict, and nothing changes', async ({ request }) => {
    const fx = createMergeInProgress({ conflicts: 1, added: false });
    const id = await openRepoApi(request, fx.repo);
    const before = gitOut(fx.repo, ['rev-parse', 'HEAD']).trim();
    for (const [route, body] of [
      ['checkout', { kind: 'local', name: 'feature/conflict' }],
      ['checkout', { kind: 'commit', sha: before }],
      ['branch', { name: 'new-one', checkout: true }],
      ['branch', { name: 'new-two', checkout: false }],
    ] as const) {
      const res = await post(request, id, route, body);
      expect(res.status(), route).toBe(409);
      const json = (await res.json()) as { opInProgress?: boolean; exists?: unknown };
      expect(json.opInProgress).toBe(true);
      expect(json.exists).toBeUndefined();
    }
    expect(gitOut(fx.repo, ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(localBranches(fx.repo)).not.toContain('new-one');
    expect(localBranches(fx.repo)).not.toContain('new-two');
  });
});
