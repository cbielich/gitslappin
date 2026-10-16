import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { freshDir, TEST_TOKEN } from './helpers/repo';
import {
  assertRemotesSafe,
  commitFile,
  configGet,
  createNoRemoteRepo,
  createRemoteFx,
  divergeClean,
  fetchIn,
  git,
  hasRef,
  localCommit,
  originAdvance,
  originRef,
  originSnapshot,
  originTags,
  refSha,
  tryGit,
  type RemoteFx,
} from './helpers/remoteFixtures';

/*
 * V2 (Remotes & tags). Test ids this file expects (new ones marked +). Existing: repo-view, commit-row, commit-message, ref-pill[data-name], sidebar-item[data-kind][data-name],
 * sidebar-toggle-<id> (aria-expanded), sidebar-section-<id>, sidebar-remote-<name>, context-menu, context-submenu, menu-item, confirm-bar, confirm-message, confirm-ok,
 * confirm-cancel, toast, toast-title, toast-detail, tool-undo, toolbar-busy, gear, preferences-view, preferences-section-ui.
 *  + sidebar-add-remote        the green "+" on the REMOTE section head, visible while the pointer is over that section head (title "Add Remote")
 *  + add-remote-panel          the Add Remote panel (opens over the left of the graph, screen 38)
 *  + add-remote-title ("Add Remote"), add-remote-close (X), add-remote-tab-url ("URL", the only tab)
 *  + add-remote-name-label ("Name"), add-remote-pull-url-label ("Pull URL"), add-remote-push-url-label ("Push URL")
 *  + add-remote-name, add-remote-pull-url, add-remote-push-url   (inputs)
 *  + add-remote-submit         button "Add Remote", disabled until Name and Pull URL are filled
 *  + confirm-bar[data-kind=delete-tag | delete-tag-remote]   (the existing ConfirmBar; confirm-ok text "Delete", confirm-cancel "Cancel")
 *  + sb-track                  ONE group per sidebar branch item that has ahead and/or behind: text "1↑ 1↓" (number then arrow; "2↑" / "1↓" when only one side); absent when 0/0
 *  + preferences-section-general (heading "General", above preferences-section-ui), pref-autofetch-label ("Auto-Fetch Interval"), pref-autofetch-input (number input, saves on change/blur),
 *    pref-autofetch-help, pref-autofetch-warning
 * Server routes under /api/repos/:id: POST remote/add {name,url,pushUrl?}, tag/push {name,sha,remote}, tag/delete {name,sha}, tag/delete-remote {name,sha,remote}, fetch {auto:true}.
 * Prefs key autoFetchMinutes (GET/PUT /api/prefs): integer 0..60, default 1.
 * Strings (en-us.json): RemoteForm-AddRemote/-Url/-RemoteName/-PullURL/-PushURL/-AddRemoteButtonLabel, Error-AddRemoteFailed, ContextMenu-PushXToY / -DeleteTagXLocally /
 *   -DeleteTagXFromRemoteY / -PushTagToRemote / -DeleteTagFromRemote, ConfirmationMessage-DeleteRef / -DeleteTagFromRemote, DeleteButtonLabel, CancelButtonLabel,
 *   Notification-PushedSuccessfully, Error-PushFailedWithName, Error-DeleteFailedWithName(sForRemote), GeneralPreferences-AutoFetchInterval / -Help / -Warning.
 * UNVERIFIED: the warning text asserted is only its first sentence (screen 42 shows the "WithLfs" variant, the design names the plain key); {0}/{1} order of
 *   Error-DeleteFailedWithNamesTagForRemote (only the "Delete Failed: " prefix is asserted); the exact sidebar/graph tag menu for several remotes lists remote names as
 *   plain items in the submenu.
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

const L = {
  addRemote: 'Add Remote',
  addFailed: 'Add Remote Failed',
  pushed: 'Pushed Successfully',
  deleteRef: (n: string) => `This is a destructive operation, are you sure you want to delete "${n}"?`,
  deleteFromRemote: (n: string, r: string) => `This is a destructive operation, are you sure you want to delete "${n}" from "${r}"?`,
  warn: 'If you have many visible remotes, this may impact performance.',
  help: 'In minutes, between 0 and 60 (0 disables auto-fetch). Fetches all visible remotes.',
} as const;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const menuItem = (page: Page, text: string) => page.getByTestId('context-menu').getByTestId('menu-item').filter({ hasText: new RegExp(`^\\s*${esc(text)}\\s*$`) });
const subItem = (page: Page, text: string) => page.getByTestId('context-submenu').getByTestId('menu-item').filter({ hasText: new RegExp(`^\\s*${esc(text)}\\s*$`) });
async function menuLabels(page: Page): Promise<string[]> {
  return page.getByTestId('context-menu').getByTestId('menu-item').evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/[›>]/g, '').trim()));
}
const sbTag = (page: Page, name: string) => page.locator(`[data-testid="sidebar-item"][data-kind="tag"][data-name="${name}"]`);
const sbLocal = (page: Page, name: string) => page.locator(`[data-testid="sidebar-item"][data-kind="local"][data-name="${name}"]`);
const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-name="${name}"]`).first();
const toastTitle = (page: Page) => page.getByTestId('toast-title');
const rowWithSubject = (page: Page, subject: string) => page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: subject }) });

async function putPref(request: APIRequestContext, body: unknown): Promise<number> {
  return (await request.put('/api/prefs', { headers, data: body as object })).status();
}
async function getPrefs(request: APIRequestContext): Promise<Record<string, unknown>> {
  const res = await request.get('/api/prefs', { headers });
  expect(res.status()).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}
async function openRepoApi(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.post('/api/repos/open', { headers, data: { path } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** autoFetchMinutes: 0 for every test that is not about auto-fetch, so a background fetch never changes a fixture under test. */
async function openGraph(page: Page, repo: string, autoFetchMinutes: number | null = 0): Promise<void> {
  if (autoFetchMinutes !== null) expect(await putPref(page.request, { autoFetchMinutes })).toBe(200);
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('repo-view')).toBeVisible();
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
}
async function expandSections(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) {
    const head = page.getByTestId(`sidebar-toggle-${id}`);
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  }
}

/** A bare repo (file:// url inside gitslappin-tests) whose main has one commit. */
function secondRemote(prefix = 'rt-second'): { bare: string; url: string } {
  const base = freshDir(prefix);
  const bare = join(base, 'second.git');
  mkdirSync(bare);
  git(bare, ['init', '--bare', '-b', 'main']);
  const url = pathToFileURL(bare).href;
  const work = join(base, 'work');
  mkdirSync(work);
  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'user.name', 'Test Author']);
  git(work, ['config', 'user.email', 'author@example.com']);
  commitFile(work, { 'second.txt': 'second\n' }, 'Second remote commit');
  git(work, ['-c', 'protocol.file.allow=always', 'push', url, 'main']);
  return { bare, url };
}

/** A has a new local commit carrying the annotated tag v1.0 (and the lightweight tag light). */
function tagFx(): { fx: RemoteFx; sha: string; tagObj: string } {
  const fx = createRemoteFx();
  const sha = localCommit(fx, { 'more.txt': 'm\n' }, 'Tagged commit');
  git(fx.a, ['tag', '-a', 'v1.0', '-m', 'release one']);
  git(fx.a, ['tag', 'light']);
  return { fx, sha, tagObj: git(fx.a, ['rev-parse', 'refs/tags/v1.0']).trim() };
}
async function tagMenuFromSidebar(page: Page, name: string): Promise<void> {
  await expandSections(page, ['tags']);
  await sbTag(page, name).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}
async function tagMenuFromGraph(page: Page, name: string): Promise<void> {
  if (!(await pill(page, name).isVisible())) await page.getByTestId('ref-more').first().hover(); // hovering the ref cell / +N expands every ref pill
  await pill(page, name).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}

// ---------------------------------------------------------------------------------------------------------------------
// Keep this first: it asserts the untouched default.
test.describe('Auto-Fetch preference', () => {
  test('default is 1 minute; the General section sits above UI Customization with the exact wording', async ({ page }) => {
    expect((await getPrefs(page.request)).autoFetchMinutes).toBe(1);
    const fx = createRemoteFx();
    await openGraph(page, fx.a, null); // no PUT: the default must show
    await page.getByTestId('gear').click();
    await expect(page.getByTestId('preferences-view')).toBeVisible();
    await expect(page.getByTestId('preferences-section-general')).toHaveText('General');
    const generalFirst = await page.evaluate(() => {
      const g = document.querySelector('[data-testid="preferences-section-general"]')!;
      const u = document.querySelector('[data-testid="preferences-section-ui"]')!;
      return !!(g.compareDocumentPosition(u) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(generalFirst).toBe(true);
    await expect(page.getByTestId('pref-autofetch-label')).toHaveText('Auto-Fetch Interval');
    await expect(page.getByTestId('pref-autofetch-help')).toHaveText(L.help);
    await expect(page.getByTestId('pref-autofetch-warning')).toContainText(L.warn);
    await expect(page.getByTestId('pref-autofetch-input')).toHaveValue('1');
  });

  test('accepts 0 to 60, saves it, and keeps the old value for anything else (UI and API)', async ({ page }) => {
    const fx = createRemoteFx();
    await openGraph(page, fx.a, 5);
    await page.getByTestId('gear').click();
    const input = page.getByTestId('pref-autofetch-input');
    await expect(input).toHaveValue('5');
    for (const v of [0, 60, 7]) {
      await input.fill(String(v));
      await input.blur();
      await expect.poll(async () => (await getPrefs(page.request)).autoFetchMinutes).toBe(v);
    }
    for (const bad of ['61', '-1', '1.5', '999']) {
      await input.fill(bad);
      await input.blur();
      await page.waitForTimeout(300);
      expect((await getPrefs(page.request)).autoFetchMinutes, bad).toBe(7); // not stored
    }
    await page.reload();
    await page.getByTestId('gear').click();
    await expect(page.getByTestId('pref-autofetch-input')).toHaveValue('7');
    for (const ok of [0, 1, 30, 60]) expect(await putPref(page.request, { autoFetchMinutes: ok }), String(ok)).toBe(200);
    for (const bad of [61, -1, 1.5, '1', null, [1]]) {
      const s = await putPref(page.request, { autoFetchMinutes: bad });
      expect(s, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
      expect(s).toBeLessThan(500);
    }
    expect((await getPrefs(page.request)).autoFetchMinutes).toBe(60);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('Add Remote', () => {
  test('hover + on REMOTE opens the panel; the button stays disabled until Name and Pull URL are filled', async ({ page }) => {
    const fx = createRemoteFx();
    await openGraph(page, fx.a);
    await page.getByTestId('sidebar-section-remote').hover();
    const plus = page.getByTestId('sidebar-add-remote');
    await expect(plus).toBeVisible();
    await expect(plus).toHaveAttribute('title', L.addRemote);
    await plus.click();
    await expect(page.getByTestId('add-remote-panel')).toBeVisible();
    await expect(page.getByTestId('add-remote-title')).toHaveText(L.addRemote);
    await expect(page.getByTestId('add-remote-tab-url')).toHaveText('URL');
    await expect(page.getByTestId('add-remote-name-label')).toHaveText('Name');
    await expect(page.getByTestId('add-remote-pull-url-label')).toHaveText('Pull URL');
    await expect(page.getByTestId('add-remote-push-url-label')).toHaveText('Push URL');
    const submit = page.getByTestId('add-remote-submit');
    await expect(submit).toHaveText(L.addRemote);
    await expect(submit).toBeDisabled();
    await page.getByTestId('add-remote-name').fill('second');
    await expect(submit).toBeDisabled();
    await page.getByTestId('add-remote-pull-url').fill(secondRemote().url);
    await expect(submit).toBeEnabled();
    await page.getByTestId('add-remote-name').fill('');
    await expect(submit).toBeDisabled();
    await page.getByTestId('add-remote-close').click();
    await expect(page.getByTestId('add-remote-panel')).toHaveCount(0);
    expect(tryGit(fx.a, ['remote']).stdout.trim()).toBe('origin');
  });

  test('adding a remote shows it under REMOTE with its branches fetched; the push url is stored', async ({ page }) => {
    const fx = createRemoteFx();
    const second = secondRemote();
    const pushOnly = secondRemote('rt-push-only');
    assertRemotesSafe(fx.a);
    await openGraph(page, fx.a);
    await expandSections(page, ['remote']);
    await page.getByTestId('sidebar-section-remote').hover();
    await page.getByTestId('sidebar-add-remote').click();
    await page.getByTestId('add-remote-name').fill('second');
    await page.getByTestId('add-remote-pull-url').fill(second.url);
    await page.getByTestId('add-remote-push-url').fill(pushOnly.url);
    await page.getByTestId('add-remote-submit').click();
    await expect(page.getByTestId('add-remote-panel')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-remote-second')).toBeVisible();
    await expect(page.locator('[data-testid="sidebar-item"][data-kind="remote"][data-name="second/main"]')).toBeVisible(); // fetched right after adding
    expect(hasRef(fx.a, 'refs/remotes/second/main')).toBe(true);
    expect(configGet(fx.a, 'remote.second.url')).toBe(second.url);
    expect(configGet(fx.a, 'remote.second.pushurl')).toBe(pushOnly.url);
    assertRemotesSafe(fx.a);
  });

  test('a name that already exists shows "Add Remote Failed" with git/server text, keeps the panel open and changes nothing', async ({ page }) => {
    const fx = createRemoteFx();
    const second = secondRemote();
    await openGraph(page, fx.a);
    await page.getByTestId('sidebar-section-remote').hover();
    await page.getByTestId('sidebar-add-remote').click();
    await page.getByTestId('add-remote-name').fill('origin');
    await page.getByTestId('add-remote-pull-url').fill(second.url);
    await page.getByTestId('add-remote-submit').click();
    await expect(toastTitle(page)).toHaveText(L.addFailed);
    await expect(page.getByTestId('toast-detail')).not.toHaveText('');
    await expect(page.getByTestId('add-remote-panel')).toBeVisible();
    expect(configGet(fx.a, 'remote.origin.url')).toBe(fx.originUrl);
    expect(tryGit(fx.a, ['remote']).stdout.trim()).toBe('origin');
  });

  test('hostile input is refused with the same toast and nothing is added (ext:: helper, option-looking url, UNC)', async ({ page }) => {
    const fx = createRemoteFx();
    await openGraph(page, fx.a);
    for (const url of ['ext::sh -c touch% x', '-oProxyCommand=touch x', '\\\\server\\share\\repo.git', 'ftp://example.com/x.git']) {
      await page.getByTestId('sidebar-section-remote').hover();
      if ((await page.getByTestId('add-remote-panel').count()) === 0) await page.getByTestId('sidebar-add-remote').click();
      await page.getByTestId('add-remote-name').fill('evil');
      await page.getByTestId('add-remote-pull-url').fill(url);
      await page.getByTestId('add-remote-submit').click();
      await expect(toastTitle(page).last()).toHaveText(L.addFailed);
      expect(tryGit(fx.a, ['remote']).stdout.trim(), url).toBe('origin');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('Tag menu and push', () => {
  test('sidebar TAGS row: the tag group comes first (push, delete locally, delete from origin), then the commit-row items', async ({ page }) => {
    const { fx } = tagFx();
    await openGraph(page, fx.a);
    await tagMenuFromSidebar(page, 'v1.0');
    const labels = await menuLabels(page);
    expect(labels).toContain('Push v1.0 to origin');
    expect(labels).toContain('Delete v1.0 locally');
    expect(labels).toContain('Delete v1.0 from origin');
    const tagGroupEnd = Math.max(labels.indexOf('Push v1.0 to origin'), labels.indexOf('Delete v1.0 locally'), labels.indexOf('Delete v1.0 from origin'));
    expect(labels.indexOf('Create tag here')).toBeGreaterThan(tagGroupEnd);
    expect(Math.min(labels.indexOf('Push v1.0 to origin'), labels.indexOf('Delete v1.0 locally'))).toBeLessThan(labels.indexOf('Create tag here'));
    expect(labels.some((l) => /all remotes/i.test(l))).toBe(false); // DeleteTagXFromAllRemotes is cut
  });

  test('push a tag from the sidebar: only that tag reaches origin and a success toast shows', async ({ page }) => {
    const { fx, tagObj } = tagFx();
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await tagMenuFromSidebar(page, 'v1.0');
    await menuItem(page, 'Push v1.0 to origin').click();
    await expect(toastTitle(page)).toHaveText(L.pushed);
    expect(originRef(fx, 'refs/tags/v1.0')).toBe(tagObj);
    expect(originTags(fx)).toEqual(['v1.0']);
    expect(originRef(fx, 'refs/heads/main')).toBe(fx.baseSha); // the branch did not move
  });

  test('push a tag from its graph label (same menu, tag group before the commit items)', async ({ page }) => {
    const { fx, sha } = tagFx();
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await tagMenuFromGraph(page, 'light');
    const labels = await menuLabels(page);
    expect(labels.indexOf('Push light to origin')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('Push light to origin')).toBeLessThan(labels.indexOf('Create tag here'));
    await menuItem(page, 'Push light to origin').click();
    await expect(toastTitle(page)).toHaveText(L.pushed);
    expect(originRef(fx, 'refs/tags/light')).toBe(sha);
  });

  test('push refused because the remote has a different tag of that name: Push Failed toast, origin untouched', async ({ page }) => {
    const { fx } = tagFx();
    git(fx.b, ['pull', '--ff-only', 'origin', 'main']);
    commitFile(fx.b, { 'other.txt': 'o\n' }, 'Other side commit', 'Other Author');
    git(fx.b, ['tag', '-a', 'v1.0', '-m', 'their release']);
    git(fx.b, ['push', 'origin', 'v1.0']);
    const before = originSnapshot(fx);
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await tagMenuFromSidebar(page, 'v1.0');
    await menuItem(page, 'Push v1.0 to origin').click();
    await expect(toastTitle(page)).toHaveText(/^Push Failed: /);
    expect(originSnapshot(fx)).toBe(before);
  });

  test('several remotes: the group shows "Push tag to remote" and "Delete tag from remote" submenus listing each remote', async ({ page }) => {
    const { fx, tagObj } = tagFx();
    const second = secondRemote();
    git(fx.a, ['remote', 'add', 'second', second.url]);
    fetchIn(fx.a);
    assertRemotesSafe(fx.a);
    await openGraph(page, fx.a);
    await tagMenuFromSidebar(page, 'v1.0');
    const labels = await menuLabels(page);
    expect(labels).toContain('Push tag to remote');
    expect(labels).toContain('Delete tag from remote');
    expect(labels).toContain('Delete v1.0 locally');
    expect(labels).not.toContain('Push v1.0 to origin');
    await menuItem(page, 'Push tag to remote').click();
    await expect(page.getByTestId('context-submenu')).toBeVisible();
    await expect(subItem(page, 'origin')).toBeVisible();
    await expect(subItem(page, 'second')).toBeVisible();
    await subItem(page, 'second').click();
    await expect(toastTitle(page)).toHaveText(L.pushed);
    expect(tryGit(second.bare, ['rev-parse', '--verify', '--quiet', 'refs/tags/v1.0']).stdout.trim()).toBe(tagObj);
    expect(originTags(fx)).toEqual([]); // the other remote did not get it
  });

  test('no remote: the push and delete-from-remote items are hidden, delete locally stays', async ({ page }) => {
    const repo = createNoRemoteRepo();
    git(repo, ['tag', 'solo']);
    await openGraph(page, repo);
    await tagMenuFromSidebar(page, 'solo');
    const labels = await menuLabels(page);
    expect(labels).toContain('Delete solo locally');
    expect(labels.filter((l) => /^Push solo|from /.test(l))).toEqual([]);
    expect(labels).not.toContain('Push tag to remote');
    expect(labels).not.toContain('Delete tag from remote');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('Tag delete', () => {
  test('delete locally: the confirm bar has the exact text, Cancel changes nothing, Delete removes the tag and Undo restores it', async ({ page }) => {
    const { fx, tagObj } = tagFx();
    await openGraph(page, fx.a);
    await tagMenuFromSidebar(page, 'v1.0');
    await menuItem(page, 'Delete v1.0 locally').click();
    const bar = page.locator('[data-testid="confirm-bar"][data-kind="delete-tag"]');
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText(L.deleteRef('v1.0'));
    await expect(page.getByTestId('confirm-ok')).toHaveText('Delete');
    await expect(page.getByTestId('confirm-cancel')).toHaveText('Cancel');
    await page.getByTestId('confirm-cancel').click();
    await expect(bar).toHaveCount(0);
    expect(refSha(fx.a, 'refs/tags/v1.0')).toBe(tagObj); // Cancel changed nothing

    await tagMenuFromSidebar(page, 'v1.0');
    await menuItem(page, 'Delete v1.0 locally').click();
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => hasRef(fx.a, 'refs/tags/v1.0')).toBe(false);
    await expect(sbTag(page, 'v1.0')).toHaveCount(0);
    await expect(page.locator('[data-testid="ref-pill"][data-name="v1.0"]')).toHaveCount(0);
    expect(hasRef(fx.a, 'refs/tags/light')).toBe(true); // other tags stay
    await expect(page.getByTestId('tool-undo')).toBeEnabled();
    await expect(page.getByTestId('tool-undo')).toHaveAttribute('title', "Undo delete tag 'v1.0'");
    await page.getByTestId('tool-undo').click();
    await expect.poll(() => (hasRef(fx.a, 'refs/tags/v1.0') ? refSha(fx.a, 'refs/tags/v1.0') : '')).toBe(tagObj); // the same annotated tag object is back
    await expect(sbTag(page, 'v1.0')).toBeVisible();
  });

  test('delete from the remote: confirm text names tag and remote, the tag is gone on the bare repo, the local tag stays', async ({ page }) => {
    const { fx, tagObj } = tagFx();
    git(fx.a, ['push', 'origin', 'refs/tags/v1.0:refs/tags/v1.0']);
    assertRemotesSafe(fx.a);
    expect(originTags(fx)).toEqual(['v1.0']);
    const others = originSnapshot(fx).split('\n').filter((l) => !l.includes('refs/tags/v1.0'));
    await openGraph(page, fx.a);
    await tagMenuFromSidebar(page, 'v1.0');
    await menuItem(page, 'Delete v1.0 from origin').click();
    await expect(page.locator('[data-testid="confirm-bar"][data-kind="delete-tag-remote"]')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText(L.deleteFromRemote('v1.0', 'origin'));
    await expect(page.getByTestId('confirm-ok')).toHaveText('Delete');
    await expect(page.getByTestId('confirm-cancel')).toHaveText('Cancel');
    await page.getByTestId('confirm-cancel').click();
    expect(originTags(fx)).toEqual(['v1.0']); // Cancel changed nothing

    await tagMenuFromSidebar(page, 'v1.0');
    await menuItem(page, 'Delete v1.0 from origin').click();
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => originTags(fx)).toEqual([]);
    expect(originSnapshot(fx).split('\n').filter(Boolean)).toEqual(others.filter(Boolean));
    expect(refSha(fx.a, 'refs/tags/v1.0')).toBe(tagObj);
  });

  test('delete from the remote when somebody else moved that tag: a "Delete Failed" toast and the remote tag stays', async ({ page }) => {
    const { fx } = tagFx();
    git(fx.a, ['push', 'origin', 'refs/tags/v1.0:refs/tags/v1.0']);
    git(fx.b, ['pull', '--ff-only', 'origin', 'main']);
    git(fx.b, ['fetch', 'origin', '--tags']);
    commitFile(fx.b, { 'other.txt': 'o\n' }, 'Other side commit', 'Other Author');
    git(fx.b, ['tag', '-f', '-a', 'v1.0', '-m', 'their moved release']);
    git(fx.b, ['push', '--force', 'origin', 'refs/tags/v1.0:refs/tags/v1.0']);
    const before = originSnapshot(fx);
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await tagMenuFromSidebar(page, 'v1.0');
    await menuItem(page, 'Delete v1.0 from origin').click();
    await page.getByTestId('confirm-ok').click();
    await expect(toastTitle(page)).toHaveText(/^Delete Failed: /);
    expect(originSnapshot(fx)).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ahead/behind badge', () => {
  const trackText = async (page: Page, branch: string): Promise<string | null> => {
    const group = sbLocal(page, branch).getByTestId('sb-track');
    if ((await group.count()) === 0) return null;
    expect(await group.count()).toBe(1); // one group, not one badge per side
    return ((await group.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  };

  test('ahead and behind show as one group "1↑ 1↓" (number, then arrow)', async ({ page }) => {
    const fx = createRemoteFx();
    divergeClean(fx);
    fetchIn(fx.a);
    await openGraph(page, fx.a);
    await expandSections(page, ['local']);
    await expect(sbLocal(page, 'main').getByTestId('sb-track')).toHaveCount(1);
    expect(await trackText(page, 'main')).toBe('1↑ 1↓');
  });

  test('only ahead, only behind, and in sync (no badge)', async ({ page }) => {
    const ahead = createRemoteFx();
    localCommit(ahead, { 'l1.txt': '1\n' }, 'Local one');
    localCommit(ahead, { 'l2.txt': '2\n' }, 'Local two');
    await openGraph(page, ahead.a);
    await expandSections(page, ['local']);
    await expect(sbLocal(page, 'main').getByTestId('sb-track')).toHaveCount(1);
    expect(await trackText(page, 'main')).toBe('2↑');

    const behind = createRemoteFx();
    originAdvance(behind, { 'r.txt': 'r\n' }, 'Remote one');
    fetchIn(behind.a);
    await openGraph(page, behind.a);
    await expandSections(page, ['local']);
    await expect(sbLocal(page, 'main').getByTestId('sb-track')).toHaveCount(1);
    expect(await trackText(page, 'main')).toBe('1↓');

    const sync = createRemoteFx();
    await openGraph(page, sync.a);
    await expandSections(page, ['local']);
    await expect(sbLocal(page, 'main')).toBeVisible();
    await expect(sbLocal(page, 'main').getByTestId('sb-track')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('auto-fetch (client timer + POST /fetch {auto:true})', () => {
  test('after the interval the app fetches by itself: the new remote commit shows without a toast or spinner, and the request carries only auto:true', async ({ page }) => {
    const fx = createRemoteFx();
    const bodies: string[] = [];
    await page.route('**/api/repos/*/fetch', async (route) => {
      bodies.push(route.request().postData() ?? '');
      await route.continue();
    });
    await page.clock.install();
    await openGraph(page, fx.a, 1);
    const sha = originAdvance(fx, { 'auto.txt': 'a\n' }, 'Remote commit for auto fetch');
    assertRemotesSafe(fx.a);
    expect(refSha(fx.a, 'origin/main')).toBe(fx.baseSha); // not fetched yet
    await page.clock.fastForward(61_000); // skip the 1 minute interval
    await expect.poll(() => refSha(fx.a, 'origin/main'), { timeout: 20_000 }).toBe(sha);
    await expect(rowWithSubject(page, 'Remote commit for auto fetch').first()).toBeVisible({ timeout: 20_000 }); // refs reloaded and the graph soft-reloaded
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await expect(page.getByTestId('toolbar-busy')).toHaveCount(0);
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(JSON.parse(b)).toEqual({ auto: true });
  });

  test('0 turns it off; setting it to 1 in Preferences turns it on', async ({ page }) => {
    const fx = createRemoteFx();
    let calls = 0;
    await page.route('**/api/repos/*/fetch', async (route) => {
      calls++;
      await route.continue();
    });
    await page.clock.install();
    await openGraph(page, fx.a, 0);
    const sha = originAdvance(fx, { 'auto.txt': 'a\n' }, 'Remote commit for auto fetch');
    assertRemotesSafe(fx.a);
    await page.clock.fastForward(180_000);
    await page.waitForTimeout(1500);
    expect(calls).toBe(0);
    expect(refSha(fx.a, 'origin/main')).toBe(fx.baseSha);

    await page.getByTestId('gear').click();
    const input = page.getByTestId('pref-autofetch-input');
    await input.fill('1');
    await input.blur();
    await expect.poll(async () => (await getPrefs(page.request)).autoFetchMinutes).toBe(1);
    await page.getByTestId('preferences-close').click();
    await page.clock.fastForward(61_000);
    await expect.poll(() => refSha(fx.a, 'origin/main'), { timeout: 20_000 }).toBe(sha);
    expect(calls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('remote and tag routes, hostile input (API)', () => {
  const refused = (s: number): void => {
    expect(s).toBeGreaterThanOrEqual(400);
    expect(s).toBeLessThan(500);
  };
  const post = (request: APIRequestContext, id: string, route: string, data: unknown) => request.post(`/api/repos/${id}/${route}`, { headers, data: data as object });

  test('remote/add refuses a bad name and hostile urls; the repo config is unchanged and a valid add still works', async ({ request }) => {
    const fx = createRemoteFx();
    const second = secondRemote();
    const id = await openRepoApi(request, fx.a);
    const before = git(fx.a, ['config', '--local', '--list']);
    refused((await post(request, id, 'remote/add', { name: '-x', url: second.url })).status());
    refused((await post(request, id, 'remote/add', { name: 'origin', url: second.url })).status());
    for (const url of ['ext::sh -c touch% x', '-oProxyCommand=x', '//server/share/x', 'file://host/x', '']) {
      refused((await post(request, id, 'remote/add', { name: 'bad', url })).status());
    }
    expect(git(fx.a, ['config', '--local', '--list'])).toBe(before);
    expect((await post(request, id, 'remote/add', { name: 'good', url: second.url })).status()).toBe(200);
    expect(configGet(fx.a, 'remote.good.url')).toBe(second.url);
  });

  test('tag routes: a stale sha is 409, bad tag/remote values are refused, origin and local tags never change; the same calls with valid input work', async ({ request }) => {
    const { fx, sha, tagObj } = tagFx();
    const id = await openRepoApi(request, fx.a);
    const before = originSnapshot(fx);
    for (const route of ['tag/push', 'tag/delete-remote']) {
      expect((await post(request, id, route, { name: 'v1.0', sha: fx.baseSha, remote: 'origin' })).status(), route).toBe(409);
      refused((await post(request, id, route, { name: '-x', sha, remote: 'origin' })).status());
      refused((await post(request, id, route, { name: 'v1.0', sha, remote: '--upload-pack=x' })).status());
      refused((await post(request, id, route, { name: 'v1.0', sha, remote: 'nope' })).status());
    }
    expect((await post(request, id, 'tag/delete', { name: 'v1.0', sha: fx.baseSha })).status()).toBe(409);
    refused((await post(request, id, 'tag/delete', { name: '-x', sha })).status());
    expect(originSnapshot(fx)).toBe(before);
    expect(refSha(fx.a, 'refs/tags/v1.0')).toBe(tagObj);
    assertRemotesSafe(fx.a);
    expect((await post(request, id, 'tag/push', { name: 'v1.0', sha, remote: 'origin' })).status()).toBe(200);
    expect((await post(request, id, 'tag/delete-remote', { name: 'v1.0', sha, remote: 'origin' })).status()).toBe(200);
    expect(originTags(fx)).toEqual([]);
  });

  test('fetch with auto:true on a busy-free repo answers {outcome, changed} and never prunes', async ({ request }) => {
    const fx = createRemoteFx();
    git(fx.b, ['switch', '-c', 'old']);
    commitFile(fx.b, { 'old.txt': 'x\n' }, 'Branch old commit', 'Other Author');
    git(fx.b, ['push', 'origin', 'old']);
    git(fx.b, ['switch', 'main']);
    fetchIn(fx.a);
    git(fx.b, ['push', 'origin', '--delete', 'old']);
    const id = await openRepoApi(request, fx.a);
    assertRemotesSafe(fx.a);
    const res = await post(request, id, 'fetch', { auto: true });
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('done');
    expect(hasRef(fx.a, 'refs/remotes/origin/old')).toBe(true); // an auto-fetch does not prune
  });
});
